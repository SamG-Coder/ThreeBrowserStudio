const edgeKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;
const sub = (a, b) => a.map((v, i) => v - b[i]);
const add = (a, b) => a.map((v, i) => v + b[i]);
const scale = (a, s) => a.map(v => v * s);
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = value => Math.hypot(...value);
const normalize = value => length(value) > 1e-12 ? scale(value, 1 / length(value)) : [0, 0, 0];
const midpoint = (a, b) => a.map((v, i) => (v + b[i]) * 0.5);

function fail(code, message, details) { const error = new Error(message); error.code = code; error.details = details; throw error; }
function validateInput(mesh) {
  if (!Array.isArray(mesh?.worldPositions) || !Array.isArray(mesh.indices) || mesh.indices.length % 3 !== 0) fail('plainform_remesh_input_invalid', 'Conforming remeshing requires indexed triangles.');
  if (mesh.indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= mesh.worldPositions.length)) fail('plainform_remesh_input_invalid', 'Conforming remesh indices must reference existing vertices.');
}

function splitFace(a, b, c, ab, bc, ca) {
  const count = [ab, bc, ca].filter(value => value !== null).length;
  if (count === 0) return [[a, b, c]];
  if (count === 3) return [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]];
  if (count === 1) {
    if (ab !== null) return [[a, ab, c], [ab, b, c]];
    if (bc !== null) return [[b, bc, a], [bc, c, a]];
    return [[c, ca, b], [ca, a, b]];
  }
  if (ab !== null && bc !== null) return [[b, bc, ab], [a, ab, c], [ab, bc, c]];
  if (bc !== null && ca !== null) return [[c, ca, bc], [b, bc, a], [bc, ca, a]];
  return [[a, ab, ca], [c, ca, b], [ca, ab, b]];
}

function boundaryEdges(indices, selection) {
  const states = new Map();
  for (let face = 0; face < indices.length / 3; face += 1) {
    const [a, b, c] = indices.slice(face * 3, face * 3 + 3);
    for (const pair of [[a, b], [b, c], [c, a]]) {
      const key = edgeKey(...pair); const state = states.get(key) ?? { vertices: pair, selected: 0, other: 0 };
      if (selection.has(face)) state.selected += 1; else state.other += 1; states.set(key, state);
    }
  }
  return [...states.values()].filter(edge => edge.selected && (edge.other || edge.selected === 1));
}

function orderedLoops(edges) {
  const links = new Map(); const unused = new Set();
  for (const { vertices: [a, b] } of edges) {
    if (!links.has(a)) links.set(a, new Set()); if (!links.has(b)) links.set(b, new Set());
    links.get(a).add(b); links.get(b).add(a); unused.add(edgeKey(a, b));
  }
  const loops = [];
  while (unused.size) {
    const key = [...unused].sort()[0]; let [start, current] = key.split(':').map(Number); let previous = start;
    const loop = [start]; unused.delete(key);
    while (true) {
      loop.push(current);
      const next = [...links.get(current)].filter(value => value !== previous && unused.has(edgeKey(current, value))).sort((a, b) => a - b)[0];
      if (next === undefined) break;
      unused.delete(edgeKey(current, next)); previous = current; current = next;
      if (current === start) { loop.push(start); break; }
    }
    loops.push(loop);
  }
  return loops;
}

/** Refines selected triangles and stitches adjacent faces with deterministic transition triangles. */
export function conformingSubdivideTriangles(mesh, selectedFaces) {
  validateInput(mesh); const selection = new Set([...selectedFaces].sort((a, b) => a - b)); const splitEdges = new Set();
  for (const face of selection) {
    if (!Number.isSafeInteger(face) || face < 0 || face >= mesh.indices.length / 3) fail('plainform_remesh_selection_invalid', `Selected face ${face} is outside the triangle mesh.`);
    const [a, b, c] = mesh.indices.slice(face * 3, face * 3 + 3); splitEdges.add(edgeKey(a, b)); splitEdges.add(edgeKey(b, c)); splitEdges.add(edgeKey(c, a));
  }
  const sourceBoundaryEdges = boundaryEdges(mesh.indices, selection);
  const worldPositions = mesh.worldPositions.map(point => [...point]); const uvs = mesh.uvs?.map(value => [...value]);
  const attributes = Object.fromEntries(Object.entries(mesh.vertexAttributes ?? {}).map(([name, values]) => [name, values.map(value => Array.isArray(value) ? [...value] : value)]));
  const midpointIndices = new Map();
  const middle = (a, b) => {
    const key = edgeKey(a, b); if (!splitEdges.has(key)) return null; if (midpointIndices.has(key)) return midpointIndices.get(key);
    const index = worldPositions.length; worldPositions.push(midpoint(worldPositions[a], worldPositions[b])); if (uvs) uvs.push(midpoint(uvs[a], uvs[b]));
    for (const values of Object.values(attributes)) values.push(Array.isArray(values[a]) ? midpoint(values[a], values[b]) : (values[a] + values[b]) * 0.5);
    midpointIndices.set(key, index); return index;
  };
  const indices = []; const refinedFaces = new Set(); const transitionFaces = new Set(); const refinedVertices = new Set(); const parentFaces = [];
  const faceMaterialIndices = mesh.faceMaterialIndices ? [] : null;
  for (let face = 0; face < mesh.indices.length / 3; face += 1) {
    const [a, b, c] = mesh.indices.slice(face * 3, face * 3 + 3); const children = splitFace(a, b, c, middle(a, b), middle(b, c), middle(c, a));
    for (const triangle of children) {
      const child = indices.length / 3; indices.push(...triangle); parentFaces.push(face);
      if (selection.has(face)) { refinedFaces.add(child); triangle.forEach(index => refinedVertices.add(index)); }
      else if (children.length > 1) transitionFaces.add(child);
      if (faceMaterialIndices) faceMaterialIndices.push(mesh.faceMaterialIndices[face]);
    }
  }
  const boundaryVertices = new Set();
  for (const { vertices: [a, b] } of sourceBoundaryEdges) { boundaryVertices.add(a); boundaryVertices.add(b); boundaryVertices.add(midpointIndices.get(edgeKey(a, b))); }
  boundaryVertices.delete(undefined);
  return { worldPositions, indices, ...(uvs ? { uvs } : {}), ...(Object.keys(attributes).length ? { vertexAttributes: attributes } : {}), ...(faceMaterialIndices ? { faceMaterialIndices } : {}), refinedFaces, transitionFaces, refinedVertices, boundaryVertices, parentFaces, boundaryLoops: orderedLoops(sourceBoundaryEdges) };
}

function closestPoint(point, a, b, c) {
  const ab = sub(b, a); const ac = sub(c, a); const ap = sub(point, a); const d1 = dot(ab, ap); const d2 = dot(ac, ap); if (d1 <= 0 && d2 <= 0) return [...a];
  const bp = sub(point, b); const d3 = dot(ab, bp); const d4 = dot(ac, bp); if (d3 >= 0 && d4 <= d3) return [...b];
  const vc = d1 * d4 - d3 * d2; if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
  const cp = sub(point, c); const d5 = dot(ab, cp); const d6 = dot(ac, cp); if (d6 >= 0 && d5 <= d6) return [...c];
  const vb = d5 * d2 - d1 * d6; if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4; if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, scale(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
  const denominator = 1 / (va + vb + vc); return add(a, add(scale(ab, vb * denominator), scale(ac, vc * denominator)));
}
function projectionIndex(source) {
  const triangles = [];
  for (let offset = 0; offset < source.indices.length; offset += 3) {
    const points = source.indices.slice(offset, offset + 3).map(index => source.worldPositions[index]);
    triangles.push({ points, minimum: [0, 1, 2].map(axis => Math.min(...points.map(point => point[axis]))), maximum: [0, 1, 2].map(axis => Math.max(...points.map(point => point[axis]))) });
  }
  return point => {
    let best;
    for (const triangle of triangles) {
      const boxDistanceSquared = point.reduce((sum, value, axis) => {
        const delta = value < triangle.minimum[axis] ? triangle.minimum[axis] - value : value > triangle.maximum[axis] ? value - triangle.maximum[axis] : 0;
        return sum + delta * delta;
      }, 0);
      if (best && boxDistanceSquared >= best.distanceSquared) continue;
      const value = closestPoint(point, ...triangle.points); const delta = sub(point, value); const distanceSquared = dot(delta, delta);
      if (!best || distanceSquared < best.distanceSquared) best = { point: value, distanceSquared };
    }
    return best;
  };
}
function normals(mesh) {
  const values = mesh.worldPositions.map(() => [0, 0, 0]);
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const triangle = mesh.indices.slice(offset, offset + 3); const normal = cross(sub(mesh.worldPositions[triangle[1]], mesh.worldPositions[triangle[0]]), sub(mesh.worldPositions[triangle[2]], mesh.worldPositions[triangle[0]]));
    for (const index of triangle) values[index] = add(values[index], normal);
  }
  return values.map(normalize);
}

/** Performs boundary-constrained tangential relaxation and reprojects every moved point to the source surface. */
export function relaxConformingRegion(mesh, selectedVertices, constrainedVertices, sourceMesh, iterations, strength) {
  const neighbors = mesh.worldPositions.map(() => new Set());
  for (let offset = 0; offset < mesh.indices.length; offset += 3) { const [a, b, c] = mesh.indices.slice(offset, offset + 3); for (const [x, y] of [[a, b], [b, c], [c, a]]) { neighbors[x].add(y); neighbors[y].add(x); } }
  let positions = mesh.worldPositions.map(point => [...point]); let maximumProjectionDistance = 0; const project = projectionIndex(sourceMesh);
  for (let pass = 0; pass < iterations; pass += 1) {
    const vertexNormals = normals({ ...mesh, worldPositions: positions }); const next = positions.map(point => [...point]);
    for (const index of selectedVertices) {
      if (constrainedVertices.has(index) || neighbors[index].size === 0) continue;
      const average = [...neighbors[index]].reduce((sum, neighbor) => add(sum, scale(positions[neighbor], 1 / neighbors[index].size)), [0, 0, 0]); const delta = sub(average, positions[index]);
      const tangent = sub(delta, scale(vertexNormals[index], dot(delta, vertexNormals[index]))); const projected = project(add(positions[index], scale(tangent, strength)), sourceMesh);
      next[index] = projected.point; maximumProjectionDistance = Math.max(maximumProjectionDistance, Math.sqrt(projected.distanceSquared));
    }
    positions = next;
  }
  return { ...mesh, worldPositions: positions, maximumProjectionDistance };
}

export function validateConformingTriangleMesh(mesh, { minimumArea = 1e-14, maximumAspectRatio = 1e6 } = {}) {
  validateInput(mesh); const edges = new Map(); let minimumTriangleArea = Infinity; let maximumTriangleAspectRatio = 0;
  for (let face = 0; face < mesh.indices.length / 3; face += 1) {
    const triangle = mesh.indices.slice(face * 3, face * 3 + 3); const points = triangle.map(index => mesh.worldPositions[index]); const lengths = [length(sub(points[1], points[0])), length(sub(points[2], points[1])), length(sub(points[0], points[2]))];
    const area = length(cross(sub(points[1], points[0]), sub(points[2], points[0]))) * 0.5; minimumTriangleArea = Math.min(minimumTriangleArea, area); maximumTriangleAspectRatio = Math.max(maximumTriangleAspectRatio, Math.max(...lengths) ** 2 / Math.max(2 * area, Number.EPSILON));
    for (const [a, b] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) { const key = edgeKey(a, b); const uses = edges.get(key) ?? []; uses.push({ face, direction: a < b ? 1 : -1 }); edges.set(key, uses); }
  }
  const nonManifoldEdges = [...edges].filter(([, uses]) => uses.length > 2).map(([key]) => key); const inconsistentWindingEdges = [...edges].filter(([, uses]) => uses.length === 2 && uses[0].direction === uses[1].direction).map(([key]) => key);
  if (minimumTriangleArea < minimumArea || maximumTriangleAspectRatio > maximumAspectRatio || nonManifoldEdges.length || inconsistentWindingEdges.length) fail('plainform_remesh_quality_invalid', 'Conforming remesh candidate failed topology or triangle-quality validation.', { minimumTriangleArea, maximumTriangleAspectRatio, nonManifoldEdges: nonManifoldEdges.slice(0, 32), inconsistentWindingEdges: inconsistentWindingEdges.slice(0, 32) });
  return { manifold: true, windingConsistent: true, minimumTriangleArea, maximumTriangleAspectRatio, edgeCount: edges.size };
}

export function splitTriangleEdge(mesh, first, second) {
  validateInput(mesh); const incident = [];
  for (let face = 0; face < mesh.indices.length / 3; face += 1) { const triangle = mesh.indices.slice(face * 3, face * 3 + 3); if (triangle.includes(first) && triangle.includes(second)) incident.push(face); }
  if (!incident.length) fail('plainform_remesh_edge_missing', `Edge ${first}:${second} does not exist.`);
  const worldPositions = mesh.worldPositions.map(point => [...point]); const middleIndex = worldPositions.length; worldPositions.push(midpoint(worldPositions[first], worldPositions[second]));
  const uvs = mesh.uvs?.map(value => [...value]); if (uvs) uvs.push(midpoint(uvs[first], uvs[second]));
  const vertexAttributes = Object.fromEntries(Object.entries(mesh.vertexAttributes ?? {}).map(([name, values]) => {
    const next = values.map(value => Array.isArray(value) ? [...value] : value); next.push(Array.isArray(values[first]) ? midpoint(values[first], values[second]) : (values[first] + values[second]) * 0.5); return [name, next];
  }));
  const indices = []; const faceMaterialIndices = mesh.faceMaterialIndices ? [] : null;
  for (let face = 0; face < mesh.indices.length / 3; face += 1) {
    const [a, b, c] = mesh.indices.slice(face * 3, face * 3 + 3); const key = edgeKey(first, second);
    const children = splitFace(a, b, c, edgeKey(a, b) === key ? middleIndex : null, edgeKey(b, c) === key ? middleIndex : null, edgeKey(c, a) === key ? middleIndex : null);
    for (const triangle of children) { indices.push(...triangle); if (faceMaterialIndices) faceMaterialIndices.push(mesh.faceMaterialIndices[face]); }
  }
  const result = { worldPositions, indices, ...(uvs ? { uvs } : {}), ...(Object.keys(vertexAttributes).length ? { vertexAttributes } : {}), ...(faceMaterialIndices ? { faceMaterialIndices } : {}) };
  validateConformingTriangleMesh(result); return result;
}
export function collapseTriangleEdge(mesh, first, second) {
  validateInput(mesh); const keep = Math.min(first, second); const remove = Math.max(first, second); const positions = mesh.worldPositions.map(point => [...point]); positions[keep] = midpoint(positions[first], positions[second]); const triangles = []; const keptFaces = [];
  for (let face = 0; face < mesh.indices.length / 3; face += 1) { const triangle = mesh.indices.slice(face * 3, face * 3 + 3).map(index => index === remove ? keep : index); if (new Set(triangle).size === 3) { triangles.push(triangle); keptFaces.push(face); } }
  const used = [...new Set(triangles.flat())].sort((a, b) => a - b); const remap = new Map(used.map((value, index) => [value, index]));
  const mergedValues = values => { const next = values.map(value => Array.isArray(value) ? [...value] : value); next[keep] = Array.isArray(values[first]) ? midpoint(values[first], values[second]) : (values[first] + values[second]) * 0.5; return used.map(index => next[index]); };
  const vertexAttributes = Object.fromEntries(Object.entries(mesh.vertexAttributes ?? {}).map(([name, values]) => [name, mergedValues(values)]));
  const result = { worldPositions: used.map(index => positions[index]), indices: triangles.flatMap(triangle => triangle.map(index => remap.get(index))), ...(mesh.uvs ? { uvs: mergedValues(mesh.uvs) } : {}), ...(Object.keys(vertexAttributes).length ? { vertexAttributes } : {}), ...(mesh.faceMaterialIndices ? { faceMaterialIndices: keptFaces.map(face => mesh.faceMaterialIndices[face]) } : {}) };
  validateConformingTriangleMesh(result); return result;
}
export function flipTriangleEdge(mesh, first, second) {
  validateInput(mesh); const incident = []; for (let face = 0; face < mesh.indices.length / 3; face += 1) { const triangle = mesh.indices.slice(face * 3, face * 3 + 3); if (triangle.includes(first) && triangle.includes(second)) incident.push({ face, triangle }); }
  if (incident.length !== 2) fail('plainform_remesh_edge_flip_invalid', 'An edge flip requires exactly two incident triangles.'); const opposite = incident.map(({ triangle }) => triangle.find(index => index !== first && index !== second)); const indices = [...mesh.indices];
  indices.splice(incident[0].face * 3, 3, opposite[0], opposite[1], second); indices.splice(incident[1].face * 3, 3, opposite[1], opposite[0], first); const result = { ...mesh, indices }; validateConformingTriangleMesh(result); return result;
}
