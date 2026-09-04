import { StudioError } from './errors.mjs';
import { normalizeEditableMeshRecipe, triangulateEditableMesh, EDITABLE_MESH_LIMITS } from './editable-mesh.mjs';
import { evaluateGeometryModifierStack, GEOMETRY_MODIFIER_LIMITS } from './geometry-modifier-evaluator.mjs';
import { normalizeModifierDocument } from './modifier-stack.mjs';

// Evaluate connectivity changes on geometric vertices, before corner attributes
// become separate render vertices. A UV seam must never become a shell opening.
export const EDITABLE_POLYGON_MODIFIERS = new Set([
  'triangulate', 'smooth', 'simpleDeform', 'displace', 'solidify', 'subdivision',
]);
const key = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;
const point = (mesh, v) => mesh.positions.slice(v * 3, v * 3 + 3);
const mix = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);
const sum = (a, b) => a.map((v, i) => v + b[i]);
const scale = (a, t) => a.map(v => v * t);
const MAX_CORNER_ATTRIBUTE_VALUES = 8_000_000;

function fail(code, message, modifier, details = {}) {
  throw new StudioError(code, message, { modifierId: modifier?.id, modifierType: modifier?.type, ...details });
}

function counts(mesh) {
  return {
    vertices: mesh.positions.length / 3,
    faces: mesh.faceOffsets.length - 1,
    corners: mesh.cornerVertexIndices.length,
    triangles: mesh.cornerVertexIndices.length - 2 * (mesh.faceOffsets.length - 1),
  };
}

function assertBudget(value, options, modifier) {
  const maximumVertices = options.maxOutputVertices ?? GEOMETRY_MODIFIER_LIMITS.maxOutputVertices;
  const maximumTriangles = options.maxOutputTriangles ?? GEOMETRY_MODIFIER_LIMITS.maxOutputTriangles;
  if (!Number.isInteger(maximumVertices) || maximumVertices < 3 || maximumVertices > GEOMETRY_MODIFIER_LIMITS.maxOutputVertices
    || !Number.isInteger(maximumTriangles) || maximumTriangles < 1 || maximumTriangles > GEOMETRY_MODIFIER_LIMITS.maxOutputTriangles) {
    fail('invalid_geometry_modifier_budget', 'Editable modifier output budgets must be positive bounded integers.', modifier);
  }
  if (value.vertices > maximumVertices || value.faces > EDITABLE_MESH_LIMITS.maxFaces
    || value.corners > EDITABLE_MESH_LIMITS.maxCorners || value.triangles > maximumTriangles
    || value.triangles * 3 > EDITABLE_MESH_LIMITS.maxCompiledVertices) {
    fail('geometry_modifier_budget_exceeded', 'Editable modifier would exceed its geometric or seam-expanded render budget.', modifier,
      { requested: value, maximumVertices, maximumTriangles, maximumCompiledVertices: EDITABLE_MESH_LIMITS.maxCompiledVertices });
  }
}

function facesOf(mesh) {
  return mesh.faceOffsets.slice(0, -1).map((start, face) => {
    const end = mesh.faceOffsets[face + 1];
    return {
      vertices: mesh.cornerVertexIndices.slice(start, end),
      uv: Object.fromEntries(Object.entries(mesh.uvLayers).map(([name, values]) =>
        [name, Array.from({ length: end - start }, (_, i) => values.slice((start + i) * 2, (start + i + 1) * 2))])),
      color: Object.fromEntries(Object.entries(mesh.colorLayers).map(([name, values]) =>
        [name, Array.from({ length: end - start }, (_, i) => values.slice((start + i) * 4, (start + i + 1) * 4))])),
      materialIndex: mesh.faceMaterialIndices[face],
    };
  });
}

function pack(source, positions, faces, sharpEdges, edgeCreases) {
  const output = { ...source, positions, faceOffsets: [0], cornerVertexIndices: [],
    faceMaterialIndices: [], sharpEdges, edgeCreases,
    uvLayers: Object.fromEntries(Object.keys(source.uvLayers).map(name => [name, []])),
    colorLayers: Object.fromEntries(Object.keys(source.colorLayers).map(name => [name, []])) };
  for (const face of faces) {
    for (const v of face.vertices) output.cornerVertexIndices.push(v);
    output.faceOffsets.push(output.cornerVertexIndices.length);
    output.faceMaterialIndices.push(face.materialIndex);
    for (const [name, values] of Object.entries(face.uv)) for (const value of values) output.uvLayers[name].push(...value);
    for (const [name, values] of Object.entries(face.color)) for (const value of values) output.colorLayers[name].push(...value);
  }
  return normalizeEditableMeshRecipe(output);
}

function assertLayerBudget(mesh, corners, modifier) {
  const values = corners * (Object.keys(mesh.uvLayers).length * 2 + Object.keys(mesh.colorLayers).length * 4);
  if (values > MAX_CORNER_ATTRIBUTE_VALUES) fail('geometry_modifier_budget_exceeded', 'Editable modifier corner layers exceed the attribute-value budget.', modifier,
    { requested: values, maximum: MAX_CORNER_ATTRIBUTE_VALUES });
}

function selectFace(face, corners, vertices = corners.map(i => face.vertices[i])) {
  return { vertices, materialIndex: face.materialIndex,
    uv: Object.fromEntries(Object.entries(face.uv).map(([name, values]) => [name, corners.map(i => [...values[i]])])),
    color: Object.fromEntries(Object.entries(face.color).map(([name, values]) => [name, corners.map(i => [...values[i]])])) };
}

function logicalTriangles(mesh) {
  const compiled = triangulateEditableMesh(mesh);
  const faces = facesOf(mesh);
  const triangles = compiled.triangleFaceIndices.map((faceId, i) => {
    const localCorners = compiled.sourceCornerIndices.slice(i * 3, i * 3 + 3).map(c => c - mesh.faceOffsets[faceId]);
    return selectFace(faces[faceId], localCorners);
  });
  return { triangles, indexed: { kind: 'indexedMesh', positions: [...mesh.positions],
    indices: compiled.sourceCornerIndices.map(c => mesh.cornerVertexIndices[c]) } };
}

function topology(mesh, faces, modifier) {
  const edges = new Map();
  const vertexEdges = Array.from({ length: mesh.positions.length / 3 }, () => []);
  const vertexFaces = Array.from({ length: vertexEdges.length }, () => []);
  faces.forEach((face, faceIndex) => {
    face.vertices.forEach((a, corner) => {
      const b = face.vertices[(corner + 1) % face.vertices.length];
      const edgeKey = key(a, b);
      if (!edges.has(edgeKey)) {
        const edge = { a, b, uses: [], weight: 0 };
        edges.set(edgeKey, edge);
        vertexEdges[a].push(edge);
        vertexEdges[b].push(edge);
      }
      edges.get(edgeKey).uses.push({ faceIndex, corner, a, b });
      vertexFaces[a].push(faceIndex);
    });
  });
  const sharp = new Set(mesh.sharpEdges.map(([a, b]) => key(a, b)));
  const creases = new Map(mesh.edgeCreases.map(([a, b, weight]) => [key(a, b), weight]));
  for (const [edgeKey, edge] of edges) {
    if (edge.uses.length > 2 || (edge.uses.length === 2 && edge.uses[0].a === edge.uses[1].a)) {
      fail('editable_modifier_non_manifold', 'Editable shell and subdivision require manifold edges with consistent face winding.', modifier,
        { edge: [edge.a, edge.b], incidentFaces: edge.uses.map(use => use.faceIndex) });
    }
    edge.weight = edge.uses.length === 1 || sharp.has(edgeKey) ? 1 : creases.get(edgeKey) ?? 0;
  }
  // An edge-manifold mesh can still have a bow-tie vertex. Require one connected
  // fan at every used vertex; otherwise a shell would meet only at a point.
  vertexFaces.forEach((incident, vertex) => {
    if (incident.length === 0) fail('editable_modifier_loose_vertex', 'Editable shell and subdivision require every vertex to belong to a face.', modifier, { vertex });
    const boundaryCount = vertexEdges[vertex].filter(edge => edge.uses.length === 1).length;
    if (boundaryCount !== 0 && boundaryCount !== 2) fail('editable_modifier_non_manifold', 'Vertex boundary must form a single open fan.', modifier, { vertex });
    const links = new Map(incident.map(face => [face, []]));
    for (const edge of vertexEdges[vertex]) if (edge.uses.length === 2) {
      const [a, b] = edge.uses.map(use => use.faceIndex);
      links.get(a).push(b); links.get(b).push(a);
    }
    const seen = new Set();
    const pending = [incident[0]];
    while (pending.length) { const face = pending.pop(); if (seen.has(face)) continue; seen.add(face); pending.push(...links.get(face)); }
    if (seen.size !== incident.length) fail('editable_modifier_non_manifold', 'Vertex has disconnected face fans.', modifier, { vertex });
  });
  return { edges, vertexEdges };
}

function solidify(mesh, modifier, options) {
  const thickness = modifier.thickness ?? 0.1;
  const offset = modifier.offset ?? 0;
  const faces = facesOf(mesh);
  const { edges } = topology(mesh, faces, modifier);
  const boundaries = [...edges.values()].filter(edge => edge.uses.length === 1);
  const original = counts(mesh);
  assertBudget({ vertices: original.vertices * 2, faces: original.faces * 2 + boundaries.length,
    corners: original.corners * 2 + boundaries.length * 4, triangles: original.triangles * 2 + boundaries.length * 2 }, options, modifier);
  assertLayerBudget(mesh, original.corners * 2 + boundaries.length * 4, modifier);
  const { indexed } = logicalTriangles(mesh);
  const normals = Array.from({ length: original.vertices }, () => [0, 0, 0]);
  for (let i = 0; i < indexed.indices.length; i += 3) {
    const ids = indexed.indices.slice(i, i + 3);
    const [a, b, c] = ids.map(v => point(mesh, v));
    const u = b.map((v, axis) => v - a[axis]); const v = c.map((value, axis) => value - a[axis]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    for (const id of ids) normals[id] = sum(normals[id], n);
  }
  const positions = [];
  const unitNormals = normals.map((n, vertex) => {
    const length = Math.hypot(...n);
    if (length < 1e-12) fail('editable_modifier_degenerate_normal', 'Cannot offset a vertex with a degenerate surface normal.', modifier, { vertex });
    return scale(n, 1 / length);
  });
  for (const distance of [thickness * (1 + offset) / 2, -thickness * (1 - offset) / 2]) {
    for (let vertex = 0; vertex < original.vertices; vertex += 1) positions.push(...sum(point(mesh, vertex), scale(unitNormals[vertex], distance)));
  }
  const output = faces.flatMap(face => {
    const reverse = face.vertices.map((_, i) => face.vertices.length - 1 - i);
    return [face, selectFace(face, reverse, reverse.map(i => face.vertices[i] + original.vertices))];
  });
  const sharp = new Map();
  const addSharp = (a, b) => sharp.set(key(a, b), [a, b]);
  for (const [a, b] of mesh.sharpEdges) { addSharp(a, b); addSharp(a + original.vertices, b + original.vertices); }
  for (const edge of boundaries) {
    const { a, b, corner, faceIndex } = edge.uses[0];
    const face = faces[faceIndex];
    const next = (corner + 1) % face.vertices.length;
    const wall = selectFace(face, [next, corner, corner, next], [b, a, a + original.vertices, b + original.vertices]);
    const length = Math.hypot(...point(mesh, a).map((v, axis) => v - point(mesh, b)[axis]));
    for (const name of Object.keys(wall.uv)) wall.uv[name] = [[0, 0], [length, 0], [length, Math.abs(thickness)], [0, Math.abs(thickness)]];
    output.push(wall);
    addSharp(a, b); addSharp(a + original.vertices, b + original.vertices);
  }
  const creases = mesh.edgeCreases.flatMap(([a, b, weight]) => [[a, b, weight], [a + original.vertices, b + original.vertices, weight]]);
  const oriented = thickness < 0 ? output.map(face => selectFace(face, face.vertices.map((_, i) => face.vertices.length - 1 - i))) : output;
  return pack(mesh, positions, oriented, [...sharp.values()], creases);
}

function subdivideOnce(mesh, modifier, options) {
  const predictedTriangles = counts(mesh).triangles * 4;
  assertBudget({ vertices: mesh.positions.length / 3, faces: predictedTriangles, corners: predictedTriangles * 3, triangles: predictedTriangles }, options, modifier);
  assertLayerBudget(mesh, predictedTriangles * 3, modifier);
  const { triangles } = logicalTriangles(mesh);
  const { edges, vertexEdges } = topology(mesh, triangles, modifier);
  const vertexCount = mesh.positions.length / 3;
  const faceCount = triangles.length * 4;
  assertBudget({ vertices: vertexCount + edges.size, faces: faceCount, corners: faceCount * 3, triangles: faceCount }, options, modifier);
  const scheme = modifier.scheme ?? 'loop';
  const positions = [];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const original = point(mesh, vertex);
    if (scheme === 'simple') { positions.push(...original); continue; }
    const incident = vertexEdges[vertex];
    const neighbours = incident.map(edge => edge.a === vertex ? edge.b : edge.a);
    const n = neighbours.length;
    // Exact Loop beta, including extraordinary vertices.
    const beta = (5 / 8 - (3 / 8 + Math.cos(2 * Math.PI / n) / 4) ** 2) / n;
    let next = sum(scale(original, 1 - n * beta), scale(neighbours.reduce((acc, v) => sum(acc, point(mesh, v)), [0, 0, 0]), beta));
    const creased = incident.filter(edge => edge.weight > 0).sort((a, b) => b.weight - a.weight);
    if (creased.length >= 2) {
      const creaseNeighbours = creased.slice(0, 2).map(edge => point(mesh, edge.a === vertex ? edge.b : edge.a));
      const creasePoint = sum(scale(original, 0.75), scale(sum(...creaseNeighbours), 0.125));
      next = mix(next, creasePoint, creased[1].weight);
    }
    if (creased.length >= 3) next = mix(next, original, creased[2].weight);
    positions.push(...next);
  }
  for (const edge of edges.values()) {
    const midpoint = mix(point(mesh, edge.a), point(mesh, edge.b), 0.5);
    let next = midpoint;
    if (scheme === 'loop' && edge.uses.length === 2) {
      const opposites = edge.uses.map(use => triangles[use.faceIndex].vertices.find(v => v !== edge.a && v !== edge.b));
      const smooth = sum(scale(sum(point(mesh, edge.a), point(mesh, edge.b)), 3 / 8), scale(sum(point(mesh, opposites[0]), point(mesh, opposites[1])), 1 / 8));
      next = mix(smooth, midpoint, edge.weight);
    }
    edge.midpoint = positions.length / 3; positions.push(...next);
  }
  const faces = [];
  for (const face of triangles) {
    const [a, b, c] = face.vertices;
    const [ab, bc, ca] = [[a, b], [b, c], [c, a]].map(([x, y]) => edges.get(key(x, y)).midpoint);
    const expanded = { ...face, vertices: [a, b, c, ab, bc, ca] };
    for (const domain of ['uv', 'color']) expanded[domain] = Object.fromEntries(Object.entries(face[domain]).map(([name, values]) =>
      [name, [...values, mix(values[0], values[1], 0.5), mix(values[1], values[2], 0.5), mix(values[2], values[0], 0.5)]]));
    for (const corners of [[0, 3, 5], [3, 1, 4], [5, 4, 2], [3, 4, 5]]) faces.push(selectFace(expanded, corners));
  }
  const sharp = mesh.sharpEdges.flatMap(([a, b]) => { const m = edges.get(key(a, b)).midpoint; return [[a, m], [m, b]]; });
  // Crease weights persist through levels, matching the authored normalized
  // [0,1] contract; they are not Blender's unbounded semi-sharpness units.
  const creases = mesh.edgeCreases.flatMap(([a, b, w]) => { const m = edges.get(key(a, b)).midpoint; return [[a, m, w], [m, b, w]]; });
  return pack(mesh, positions, faces, sharp, creases);
}

/** Evaluate a complete pre-seam prefix, retaining all authored corner layers. */
export function evaluateEditableMeshModifierStack(recipe, modifiers, options = {}) {
  let mesh = normalizeEditableMeshRecipe(recipe);
  if (!Array.isArray(modifiers) || modifiers.length > GEOMETRY_MODIFIER_LIMITS.maxModifiers) fail('invalid_geometry_modifier_stack', 'Editable modifier stack must contain at most 64 entries.');
  const applied = []; const skipped = []; const ids = new Set();
  const target = options.target ?? 'viewport';
  if (!['viewport', 'render'].includes(target)) fail('invalid_geometry_modifier_target', 'Editable modifier target must be viewport or render.');
  const normalized = modifiers.map(modifier => normalizeModifierDocument(modifier));
  for (const modifier of normalized) {
    if (ids.has(modifier.id)) fail('duplicate_geometry_modifier_id', 'Editable modifier IDs must be unique.', modifier);
    ids.add(modifier.id);
    if (modifier.enabled === false || modifier[target === 'viewport' ? 'enabledViewport' : 'enabledRender'] === false) {
      skipped.push({ id: modifier.id, type: modifier.type, reason: 'disabled' }); continue;
    }
    if (!EDITABLE_POLYGON_MODIFIERS.has(modifier.type)) fail('unsupported_editable_geometry_modifier', 'Modifier requires the indexed render stage.', modifier);
    const before = counts(mesh); assertBudget(before, options, modifier);
    if (modifier.type === 'solidify') mesh = solidify(mesh, modifier, options);
    else if (modifier.type === 'subdivision') {
      for (let level = 0; level < (modifier.levels ?? 1); level += 1) mesh = subdivideOnce(mesh, modifier, options);
    } else if (modifier.type === 'triangulate') {
      mesh = pack(mesh, [...mesh.positions], logicalTriangles(mesh).triangles, mesh.sharpEdges, mesh.edgeCreases);
    } else {
      const { indexed } = logicalTriangles(mesh);
      const result = evaluateGeometryModifierStack(indexed, [modifier], options);
      mesh = normalizeEditableMeshRecipe({ ...mesh, positions: result.recipe.positions });
    }
    const after = counts(mesh); assertBudget(after, options, modifier);
    applied.push({ id: modifier.id, type: modifier.type, authoredType: modifier.type, before, after });
  }
  return { recipe: mesh, target, applied, skipped, blocked: [], diagnostics: [], counts: counts(mesh) };
}
