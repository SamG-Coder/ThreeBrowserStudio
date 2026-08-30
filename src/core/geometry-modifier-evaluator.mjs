import { StudioError } from './errors.mjs';
import { MAX_MATERIAL_SLOTS_PER_MESH } from './constants.mjs';
import { assertStableId } from './ids.mjs';
import {
  laplacianSmooth,
  recalculateVertexNormals,
  validateIndexedMeshRecipe,
  weldVertices,
} from './indexed-mesh-editing.mjs';
import { assertJsonValue, isPlainRecord } from './util.mjs';

const MAX_MODIFIERS = 64;
const MAX_OUTPUT_VERTICES = 1_000_000;
const MAX_OUTPUT_TRIANGLES = 2_000_000;
const MAX_SUBDIVISION_LEVELS = 6;
const MAX_DECIMATE_TRIANGLES = 250_000;
const MAX_NOISE_OCTAVES = 8;
const MAX_DISPLACEMENT_STRENGTH = 10_000;
const MAX_FREQUENCY = 10_000;
const MAX_OCEAN_WAVE_COUNT = 32;
const MAX_OCEAN_SAMPLES = 8_000_000;
const MAX_OCEAN_TIMELINE_SAMPLES = 131_072;
const MAX_OCEAN_TIME = 1_000_000;
const MAX_TIMELINE_TIME = 1_000_000_000;

export const GEOMETRY_MODIFIER_LIMITS = Object.freeze({
  maxModifiers: MAX_MODIFIERS,
  maxOutputVertices: MAX_OUTPUT_VERTICES,
  maxOutputTriangles: MAX_OUTPUT_TRIANGLES,
  maxSubdivisionLevels: MAX_SUBDIVISION_LEVELS,
  maxDecimateTriangles: MAX_DECIMATE_TRIANGLES,
  maxNoiseOctaves: MAX_NOISE_OCTAVES,
  maxDisplacementStrength: MAX_DISPLACEMENT_STRENGTH,
  maxFrequency: MAX_FREQUENCY,
  maxOceanWaveCount: MAX_OCEAN_WAVE_COUNT,
  maxOceanSamples: MAX_OCEAN_SAMPLES,
  maxOceanTimelineSamples: MAX_OCEAN_TIMELINE_SAMPLES,
});

export const GEOMETRY_MODIFIER_TYPES = Object.freeze([
  'triangulate',
  'weld',
  'smooth',
  'weightedNormal',
  'edgeSplit',
  'solidify',
  'subdivision',
  'decimate',
  'displace',
  'simpleDeform',
  'ocean',
]);

const TYPE_ALIASES = Object.freeze({
  triangulate: 'triangulate',
  weld: 'weld',
  smooth: 'smooth',
  laplacianSmooth: 'smooth',
  laplacian_smooth: 'smooth',
  weightedNormal: 'weightedNormal',
  weighted_normal: 'weightedNormal',
  edgeSplit: 'edgeSplit',
  edge_split: 'edgeSplit',
  solidify: 'solidify',
  subdivision: 'subdivision',
  subsurf: 'subdivision',
  decimate: 'decimate',
  displace: 'displace',
  simpleDeform: 'simpleDeform',
  simple_deform: 'simpleDeform',
  ocean: 'ocean',
});

export function canonicalGeometryModifierType(type) {
  return typeof type === 'string' && Object.hasOwn(TYPE_ALIASES, type)
    ? TYPE_ALIASES[type]
    : null;
}

export function isGeometryModifierType(type) {
  return canonicalGeometryModifierType(type) !== null;
}

function modifierError(code, message, modifier, details = {}) {
  return new StudioError(code, message, {
    modifierId: modifier?.id,
    modifierType: modifier?.type,
    ...details,
  });
}

function finiteNumber(value, label, minimum, maximum, modifier) {
  if (!Number.isFinite(value)) {
    throw modifierError('invalid_geometry_modifier', `${label} must be a finite number.`, modifier);
  }
  if (value < minimum || value > maximum) {
    throw modifierError(
      'invalid_geometry_modifier',
      `${label} must be from ${minimum} to ${maximum}.`,
      modifier,
      { label, minimum, maximum, value },
    );
  }
  return value;
}

function boundedInteger(value, label, fallback, minimum, maximum, modifier) {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw modifierError(
      'invalid_geometry_modifier',
      `${label} must be an integer from ${minimum} to ${maximum}.`,
      modifier,
      { label, minimum, maximum, value: candidate },
    );
  }
  return candidate;
}

function booleanValue(value, label, fallback, modifier) {
  const candidate = value ?? fallback;
  if (typeof candidate !== 'boolean') {
    throw modifierError('invalid_geometry_modifier', `${label} must be a boolean.`, modifier);
  }
  return candidate;
}

function vector3(value, label, modifier, { normalize = false } = {}) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw modifierError(
      'invalid_geometry_modifier',
      `${label} must contain three finite numbers.`,
      modifier,
    );
  }
  const result = value.map((component, index) => finiteNumber(
    component,
    `${label}[${index}]`,
    -1_000_000,
    1_000_000,
    modifier,
  ));
  if (!normalize) return result;
  const length = Math.hypot(...result);
  if (length === 0) {
    throw modifierError('invalid_geometry_modifier', `${label} must not be zero.`, modifier);
  }
  return result.map(component => component / length);
}

function meshCounts(recipe) {
  return {
    vertices: recipe.positions.length / 3,
    triangles: recipe.indices.length / 3,
  };
}

function normalizeBudget(options = {}) {
  const maxOutputVertices = options.maxOutputVertices ?? MAX_OUTPUT_VERTICES;
  const maxOutputTriangles = options.maxOutputTriangles ?? MAX_OUTPUT_TRIANGLES;
  if (!Number.isInteger(maxOutputVertices) || maxOutputVertices < 3
      || maxOutputVertices > MAX_OUTPUT_VERTICES) {
    throw new StudioError(
      'invalid_geometry_modifier_budget',
      `maxOutputVertices must be an integer from 3 to ${MAX_OUTPUT_VERTICES}.`,
      { maxOutputVertices },
    );
  }
  if (!Number.isInteger(maxOutputTriangles) || maxOutputTriangles < 1
      || maxOutputTriangles > MAX_OUTPUT_TRIANGLES) {
    throw new StudioError(
      'invalid_geometry_modifier_budget',
      `maxOutputTriangles must be an integer from 1 to ${MAX_OUTPUT_TRIANGLES}.`,
      { maxOutputTriangles },
    );
  }
  return { maxOutputVertices, maxOutputTriangles };
}

function assertBudget(counts, budget, modifier) {
  if (counts.vertices > budget.maxOutputVertices
      || counts.triangles > budget.maxOutputTriangles) {
    throw modifierError(
      'geometry_modifier_budget_exceeded',
      `Modifier ${modifier.id} would produce ${counts.vertices} vertices and ${counts.triangles} triangles; `
        + `the active budget permits ${budget.maxOutputVertices} vertices and ${budget.maxOutputTriangles} triangles.`,
      modifier,
      { requested: counts, budget },
    );
  }
}

function validateModifier(modifier) {
  if (!isPlainRecord(modifier)) {
    throw new StudioError('invalid_geometry_modifier', 'Geometry modifier must be a plain object.');
  }
  assertJsonValue(modifier, 'modifier');
  try {
    assertStableId(modifier.id, 'modifier.id');
  } catch (error) {
    throw modifierError('invalid_geometry_modifier', error.message, modifier, { cause: error });
  }
  if (typeof modifier.type !== 'string' || modifier.type.length === 0) {
    throw modifierError('invalid_geometry_modifier', 'modifier.type must be a non-empty string.', modifier);
  }
  for (const flag of ['enabled', 'enabledViewport', 'enabledRender', 'showViewport', 'showRender']) {
    if (modifier[flag] !== undefined && typeof modifier[flag] !== 'boolean') {
      throw modifierError('invalid_geometry_modifier', `${flag} must be a boolean.`, modifier);
    }
  }
  return canonicalGeometryModifierType(modifier.type) ?? undefined;
}

function modifierEnabled(modifier, target) {
  if (modifier.enabled === false) return { enabled: false, reason: 'disabled' };
  if (target === 'viewport'
      && (modifier.enabledViewport === false || modifier.showViewport === false)) {
    return { enabled: false, reason: 'viewport-disabled' };
  }
  if (target === 'render'
      && (modifier.enabledRender === false || modifier.showRender === false)) {
    return { enabled: false, reason: 'render-disabled' };
  }
  return { enabled: true };
}

function targetValue(value) {
  if (value !== 'viewport' && value !== 'render') {
    throw new StudioError(
      'invalid_geometry_modifier_target',
      "Geometry modifier target must be 'viewport' or 'render'.",
      { target: value },
    );
  }
  return value;
}

function edgeKey(first, second) {
  return first < second ? `${first}:${second}` : `${second}:${first}`;
}

function positionAt(positions, vertexIndex) {
  return positions.slice(vertexIndex * 3, vertexIndex * 3 + 3);
}

function add(left, right) {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function subtract(left, right) {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function multiply(value, scalar) {
  return [value[0] * scalar, value[1] * scalar, value[2] * scalar];
}

function dot(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function normalized(value) {
  const length = Math.hypot(...value);
  return length === 0 ? [0, 0, 0] : value.map(component => component / length);
}

function midpointAttribute(values, itemSize, first, second) {
  const result = [];
  for (let component = 0; component < itemSize; component += 1) {
    result.push((values[first * itemSize + component] + values[second * itemSize + component]) * 0.5);
  }
  return result;
}

function triangleTopology(mesh) {
  const edges = new Map();
  const adjacency = Array.from({ length: mesh.positions.length / 3 }, () => new Set());
  const boundaryNeighbours = Array.from({ length: mesh.positions.length / 3 }, () => new Set());
  const addEdge = (first, second, opposite, faceIndex) => {
    const key = edgeKey(first, second);
    const edge = edges.get(key) ?? {
      key,
      a: Math.min(first, second),
      b: Math.max(first, second),
      directed: [first, second],
      opposites: [],
      faces: [],
    };
    edge.opposites.push(opposite);
    edge.faces.push(faceIndex);
    edges.set(key, edge);
    adjacency[first].add(second);
    adjacency[second].add(first);
  };
  for (let offset = 0, faceIndex = 0; offset < mesh.indices.length; offset += 3, faceIndex += 1) {
    const [a, b, c] = mesh.indices.slice(offset, offset + 3);
    addEdge(a, b, c, faceIndex);
    addEdge(b, c, a, faceIndex);
    addEdge(c, a, b, faceIndex);
  }
  for (const edge of edges.values()) {
    if (edge.faces.length !== 1) continue;
    boundaryNeighbours[edge.a].add(edge.b);
    boundaryNeighbours[edge.b].add(edge.a);
  }
  return { edges, adjacency, boundaryNeighbours };
}

function appendVertexAttributes(target, source, sourceIndex) {
  target.positions.push(...source.positions.slice(sourceIndex * 3, sourceIndex * 3 + 3));
  if (target.uvs) target.uvs.push(...source.uvs.slice(sourceIndex * 2, sourceIndex * 2 + 2));
  if (target.colors) {
    const colorSize = source.colors.length / (source.positions.length / 3);
    target.colors.push(...source.colors.slice(
      sourceIndex * colorSize,
      sourceIndex * colorSize + colorSize,
    ));
  }
}

function resultShell(mesh) {
  return {
    ...mesh,
    positions: [],
    indices: [],
    ...(mesh.uvs === undefined ? {} : { uvs: [] }),
    ...(mesh.colors === undefined ? {} : { colors: [] }),
  };
}

function recalculateIfRequested(mesh, modifier, fallback = true) {
  const recalculate = booleanValue(
    modifier.recalculateNormals,
    'recalculateNormals',
    fallback,
    modifier,
  );
  // Topology evaluators attach exact per-face material provenance only after
  // their geometry result has been produced. Do not let stale source-length
  // slots make the normal-only validation path reject that intermediate mesh.
  if (Array.isArray(mesh.triangleMaterialIndices)
      && mesh.triangleMaterialIndices.length !== mesh.indices.length / 3) {
    delete mesh.triangleMaterialIndices;
  }
  if (!recalculate) {
    if (!Array.isArray(mesh.normals) || mesh.normals.length !== mesh.positions.length) {
      delete mesh.normals;
    }
    // Keep the no-recalculation choice intact when the derived indexed recipe
    // is lowered back to BufferGeometry. Otherwise the runtime would silently
    // compute normals and make false behave exactly like true.
    mesh.computeNormals = false;
    return mesh;
  }
  delete mesh.normals;
  return recalculateVertexNormals(mesh);
}

function applyTriangulate(mesh) {
  // Canonical indexedMesh resources are triangles by contract. Keeping this
  // modifier as a validated clone is useful when importing a Blender stack.
  return validateIndexedMeshRecipe(mesh);
}

function applyWeld(mesh, modifier) {
  try {
    return weldVertices(mesh, { tolerance: modifier.tolerance });
  } catch (error) {
    throw modifierError(
      'geometry_modifier_evaluation_failed',
      `Weld modifier ${modifier.id} failed: ${error.message}`,
      modifier,
      { cause: error },
    );
  }
}

function applySmooth(mesh, modifier) {
  if (modifier.vertexGroupId !== undefined || modifier.vertexIndices !== undefined) {
    throw modifierError(
      'geometry_modifier_attribute_unsupported',
      `Smooth modifier ${modifier.id} cannot use vertex groups or selections until indexed meshes expose named vertex weights.`,
      modifier,
    );
  }
  try {
    const smoothed = laplacianSmooth(mesh, {
      selection: 'all',
      iterations: boundedInteger(modifier.iterations, 'iterations', 1, 1, 100, modifier),
      factor: finiteNumber(modifier.factor ?? 0.5, 'factor', 0, 1, modifier),
      preserveBoundary: booleanValue(
        modifier.preserveBoundary,
        'preserveBoundary',
        true,
        modifier,
      ),
    });
    return recalculateIfRequested(smoothed, modifier);
  } catch (error) {
    if (error instanceof StudioError) throw error;
    throw modifierError(
      'geometry_modifier_evaluation_failed',
      `Smooth modifier ${modifier.id} failed: ${error.message}`,
      modifier,
      { cause: error },
    );
  }
}

function faceData(mesh) {
  const result = [];
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const indices = mesh.indices.slice(offset, offset + 3);
    const [a, b, c] = indices.map(index => positionAt(mesh.positions, index));
    const crossValue = cross(subtract(b, a), subtract(c, a));
    const doubleArea = Math.hypot(...crossValue);
    result.push({
      indices,
      unitNormal: doubleArea === 0 ? [0, 0, 0] : multiply(crossValue, 1 / doubleArea),
      area: doubleArea * 0.5,
    });
  }
  return result;
}

function cornerAngle(center, first, second) {
  const firstVector = normalized(subtract(first, center));
  const secondVector = normalized(subtract(second, center));
  if (Math.hypot(...firstVector) === 0 || Math.hypot(...secondVector) === 0) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot(firstVector, secondVector))));
}

function applyWeightedNormal(mesh, modifier) {
  if (modifier.keepSharp === true || modifier.faceStrength !== undefined) {
    throw modifierError(
      'geometry_modifier_attribute_unsupported',
      `Weighted Normal modifier ${modifier.id} cannot preserve sharp-edge or face-strength data because canonical indexedMesh currently stores normals per vertex.`,
      modifier,
    );
  }
  const weighting = modifier.weighting ?? 'areaAngle';
  if (!['area', 'cornerAngle', 'areaAngle'].includes(weighting)) {
    throw modifierError(
      'invalid_geometry_modifier',
      "weighting must be 'area', 'cornerAngle', or 'areaAngle'.",
      modifier,
    );
  }
  const influence = finiteNumber(modifier.influence ?? 1, 'influence', 0, 1, modifier);
  const normals = new Array(mesh.positions.length).fill(0);
  for (const face of faceData(mesh)) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertexIndex = face.indices[corner];
      const center = positionAt(mesh.positions, vertexIndex);
      const first = positionAt(mesh.positions, face.indices[(corner + 1) % 3]);
      const second = positionAt(mesh.positions, face.indices[(corner + 2) % 3]);
      const angle = cornerAngle(center, first, second);
      const weight = weighting === 'area'
        ? face.area
        : weighting === 'cornerAngle'
          ? angle
          : face.area * angle;
      const normalOffset = vertexIndex * 3;
      for (let axis = 0; axis < 3; axis += 1) {
        normals[normalOffset + axis] += face.unitNormal[axis] * weight;
      }
    }
  }
  for (let offset = 0; offset < normals.length; offset += 3) {
    const weighted = normalized(normals.slice(offset, offset + 3));
    const original = mesh.normals
      ? normalized(mesh.normals.slice(offset, offset + 3))
      : weighted;
    const blended = normalized(original.map(
      (value, axis) => value + (weighted[axis] - value) * influence,
    ));
    for (let axis = 0; axis < 3; axis += 1) normals[offset + axis] = blended[axis];
  }
  return { ...mesh, normals };
}

function applyEdgeSplit(mesh, modifier, budget) {
  const splitAngle = finiteNumber(
    modifier.splitAngle ?? Math.PI / 6,
    'splitAngle',
    0,
    Math.PI,
    modifier,
  );
  const faces = faceData(mesh);
  const { edges } = triangleTopology(mesh);
  const incidentFaces = Array.from({ length: mesh.positions.length / 3 }, () => []);
  faces.forEach((face, faceIndex) => {
    for (const vertexIndex of face.indices) incidentFaces[vertexIndex].push(faceIndex);
  });
  const links = Array.from({ length: mesh.positions.length / 3 }, () => new Map());
  const link = (vertexIndex, first, second) => {
    const firstLinks = links[vertexIndex].get(first) ?? [];
    firstLinks.push(second);
    links[vertexIndex].set(first, firstLinks);
    const secondLinks = links[vertexIndex].get(second) ?? [];
    secondLinks.push(first);
    links[vertexIndex].set(second, secondLinks);
  };
  for (const edge of edges.values()) {
    if (edge.faces.length !== 2) continue;
    const [firstFace, secondFace] = edge.faces;
    const angle = Math.acos(Math.max(-1, Math.min(1, dot(
      faces[firstFace].unitNormal,
      faces[secondFace].unitNormal,
    ))));
    if (angle <= splitAngle) {
      link(edge.a, firstFace, secondFace);
      link(edge.b, firstFace, secondFace);
    }
  }

  const output = resultShell(mesh);
  const remap = new Map();
  for (let vertexIndex = 0; vertexIndex < incidentFaces.length; vertexIndex += 1) {
    if (incidentFaces[vertexIndex].length === 0) {
      appendVertexAttributes(output, mesh, vertexIndex);
      continue;
    }
    const pending = new Set(incidentFaces[vertexIndex]);
    while (pending.size > 0) {
      const seed = pending.values().next().value;
      const queue = [seed];
      pending.delete(seed);
      const component = [];
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const faceIndex = queue[cursor];
        component.push(faceIndex);
        for (const neighbour of links[vertexIndex].get(faceIndex) ?? []) {
          if (!pending.has(neighbour)) continue;
          pending.delete(neighbour);
          queue.push(neighbour);
        }
      }
      const outputIndex = output.positions.length / 3;
      appendVertexAttributes(output, mesh, vertexIndex);
      for (const faceIndex of component) remap.set(`${vertexIndex}:${faceIndex}`, outputIndex);
    }
  }
  assertBudget(
    { vertices: output.positions.length / 3, triangles: faces.length },
    budget,
    modifier,
  );
  faces.forEach((face, faceIndex) => {
    for (const vertexIndex of face.indices) output.indices.push(remap.get(`${vertexIndex}:${faceIndex}`));
  });
  return recalculateIfRequested(output, modifier);
}

function applySolidify(mesh, modifier, budget) {
  if (modifier.vertexGroupId !== undefined) {
    throw modifierError(
      'geometry_modifier_attribute_unsupported',
      `Solidify modifier ${modifier.id} cannot use vertex groups until indexed meshes expose named vertex weights.`,
      modifier,
    );
  }
  const thickness = finiteNumber(
    modifier.thickness ?? 0.01,
    'thickness',
    -MAX_DISPLACEMENT_STRENGTH,
    MAX_DISPLACEMENT_STRENGTH,
    modifier,
  );
  if (thickness === 0) {
    throw modifierError('invalid_geometry_modifier', 'thickness must not be zero.', modifier);
  }
  const offset = finiteNumber(modifier.offset ?? 0, 'offset', -1, 1, modifier);
  const source = recalculateVertexNormals(mesh);
  const vertexCount = source.positions.length / 3;
  const topology = triangleTopology(source);
  const boundaryEdges = [...topology.edges.values()].filter(edge => edge.faces.length === 1);
  const predicted = {
    vertices: vertexCount * 2,
    triangles: source.indices.length * 2 / 3 + boundaryEdges.length * 2,
  };
  assertBudget(predicted, budget, modifier);

  const positions = [];
  const outerDistance = thickness * (1 + offset) * 0.5;
  const innerDistance = thickness * (1 - offset) * 0.5;
  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    const position = positionAt(source.positions, vertexIndex);
    const normal = positionAt(source.normals, vertexIndex);
    positions.push(...add(position, multiply(normal, outerDistance)));
  }
  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    const position = positionAt(source.positions, vertexIndex);
    const normal = positionAt(source.normals, vertexIndex);
    positions.push(...subtract(position, multiply(normal, innerDistance)));
  }

  const indices = [];
  for (let index = 0; index < source.indices.length; index += 3) {
    const [a, b, c] = source.indices.slice(index, index + 3);
    indices.push(a, b, c);
    indices.push(c + vertexCount, b + vertexCount, a + vertexCount);
  }
  for (const edge of boundaryEdges) {
    const [a, b] = edge.directed;
    indices.push(a, b + vertexCount, b);
    indices.push(a, a + vertexCount, b + vertexCount);
  }
  const output = {
    ...source,
    positions,
    indices,
    ...(source.uvs === undefined ? {} : { uvs: [...source.uvs, ...source.uvs] }),
    ...(source.colors === undefined ? {} : { colors: [...source.colors, ...source.colors] }),
  };
  delete output.normals;
  return recalculateIfRequested(output, modifier);
}

function subdivideOnce(mesh, modifier, budget, scheme) {
  const vertexCount = mesh.positions.length / 3;
  const triangleCount = mesh.indices.length / 3;
  const topology = triangleTopology(mesh);
  const predicted = {
    vertices: vertexCount + topology.edges.size,
    triangles: triangleCount * 4,
  };
  assertBudget(predicted, budget, modifier);

  let originalPositions = [...mesh.positions];
  if (scheme === 'loop') {
    const smoothed = [...mesh.positions];
    for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
      const position = positionAt(mesh.positions, vertexIndex);
      const boundary = [...topology.boundaryNeighbours[vertexIndex]].sort((a, b) => a - b);
      let next;
      if (boundary.length === 2) {
        next = add(
          multiply(position, 0.75),
          multiply(add(
            positionAt(mesh.positions, boundary[0]),
            positionAt(mesh.positions, boundary[1]),
          ), 0.125),
        );
      } else {
        const neighbours = [...topology.adjacency[vertexIndex]].sort((a, b) => a - b);
        const count = neighbours.length;
        if (count < 3) continue;
        const beta = count === 3 ? 3 / 16 : 3 / (8 * count);
        const neighbourSum = neighbours.reduce(
          (sum, neighbour) => add(sum, positionAt(mesh.positions, neighbour)),
          [0, 0, 0],
        );
        next = add(multiply(position, 1 - count * beta), multiply(neighbourSum, beta));
      }
      for (let axis = 0; axis < 3; axis += 1) {
        smoothed[vertexIndex * 3 + axis] = next[axis];
      }
    }
    originalPositions = smoothed;
  }

  const output = {
    ...mesh,
    positions: originalPositions,
    indices: [],
    ...(mesh.uvs === undefined ? {} : { uvs: [...mesh.uvs] }),
    ...(mesh.colors === undefined ? {} : { colors: [...mesh.colors] }),
  };
  delete output.normals;
  const midpointByEdge = new Map();
  const colorSize = mesh.colors === undefined ? 0 : mesh.colors.length / vertexCount;
  const midpointIndex = (first, second) => {
    const key = edgeKey(first, second);
    if (midpointByEdge.has(key)) return midpointByEdge.get(key);
    const edge = topology.edges.get(key);
    let position;
    if (scheme === 'loop' && edge.faces.length === 2 && edge.opposites.length === 2) {
      position = add(
        multiply(add(
          positionAt(mesh.positions, first),
          positionAt(mesh.positions, second),
        ), 3 / 8),
        multiply(add(
          positionAt(mesh.positions, edge.opposites[0]),
          positionAt(mesh.positions, edge.opposites[1]),
        ), 1 / 8),
      );
    } else {
      position = multiply(add(
        positionAt(mesh.positions, first),
        positionAt(mesh.positions, second),
      ), 0.5);
    }
    const index = output.positions.length / 3;
    output.positions.push(...position);
    if (output.uvs) output.uvs.push(...midpointAttribute(mesh.uvs, 2, first, second));
    if (output.colors) output.colors.push(...midpointAttribute(mesh.colors, colorSize, first, second));
    midpointByEdge.set(key, index);
    return index;
  };
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const [a, b, c] = mesh.indices.slice(index, index + 3);
    const ab = midpointIndex(a, b);
    const bc = midpointIndex(b, c);
    const ca = midpointIndex(c, a);
    output.indices.push(
      a, ab, ca,
      ab, b, bc,
      ca, bc, c,
      ab, bc, ca,
    );
  }
  return output;
}

function applySubdivision(mesh, modifier, budget) {
  const levels = boundedInteger(
    modifier.levels ?? modifier.level,
    'levels',
    1,
    1,
    MAX_SUBDIVISION_LEVELS,
    modifier,
  );
  const scheme = modifier.scheme ?? 'loop';
  if (!['simple', 'loop'].includes(scheme)) {
    throw modifierError(
      'invalid_geometry_modifier',
      "scheme must be 'simple' or 'loop'.",
      modifier,
    );
  }
  let output = mesh;
  for (let level = 0; level < levels; level += 1) {
    output = subdivideOnce(output, modifier, budget, scheme);
  }
  return recalculateIfRequested(output, modifier);
}

function triangleIsLive(indices, faceOffset, find) {
  const a = find(indices[faceOffset]);
  const b = find(indices[faceOffset + 1]);
  const c = find(indices[faceOffset + 2]);
  return a !== b && b !== c && c !== a;
}

function applyDecimate(mesh, modifier, budget) {
  const triangleCount = mesh.indices.length / 3;
  if (triangleCount > MAX_DECIMATE_TRIANGLES) {
    throw modifierError(
      'geometry_modifier_complexity_limit',
      `Decimate modifier ${modifier.id} accepts at most ${MAX_DECIMATE_TRIANGLES} input triangles.`,
      modifier,
      { triangles: triangleCount, limit: MAX_DECIMATE_TRIANGLES },
    );
  }
  const hasRatio = modifier.ratio !== undefined;
  const hasTarget = modifier.targetTriangles !== undefined;
  if (hasRatio && hasTarget) {
    throw modifierError(
      'invalid_geometry_modifier',
      'Decimate accepts ratio or targetTriangles, not both.',
      modifier,
    );
  }
  const targetTriangles = hasTarget
    ? boundedInteger(modifier.targetTriangles, 'targetTriangles', 1, 1, triangleCount, modifier)
    : Math.max(1, Math.floor(
      triangleCount * finiteNumber(modifier.ratio ?? 0.5, 'ratio', 0.001, 1, modifier),
    ));
  if (targetTriangles >= triangleCount) return validateIndexedMeshRecipe(mesh);

  const vertexCount = mesh.positions.length / 3;
  const parent = Array.from({ length: vertexCount }, (_, index) => index);
  const size = new Array(vertexCount).fill(1);
  const positionSums = Array.from({ length: vertexCount }, (_, index) => positionAt(mesh.positions, index));
  const uvSums = mesh.uvs
    ? Array.from({ length: vertexCount }, (_, index) => mesh.uvs.slice(index * 2, index * 2 + 2))
    : null;
  const colorSize = mesh.colors ? mesh.colors.length / vertexCount : 0;
  const colorSums = mesh.colors
    ? Array.from({ length: vertexCount }, (_, index) => (
      mesh.colors.slice(index * colorSize, index * colorSize + colorSize)
    ))
    : null;
  const incident = Array.from({ length: vertexCount }, () => new Set());
  for (let face = 0; face < triangleCount; face += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      incident[mesh.indices[face * 3 + corner]].add(face);
    }
  }
  const find = (value) => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    let current = value;
    while (parent[current] !== current) {
      const next = parent[current];
      parent[current] = root;
      current = next;
    }
    return root;
  };
  const edges = [...triangleTopology(mesh).edges.values()].map((edge) => {
    const difference = subtract(
      positionAt(mesh.positions, edge.a),
      positionAt(mesh.positions, edge.b),
    );
    return { ...edge, lengthSquared: dot(difference, difference) };
  }).sort((left, right) => (
    left.lengthSquared - right.lengthSquared || left.a - right.a || left.b - right.b
  ));
  const liveFaces = new Array(triangleCount).fill(true);
  let remainingFaces = triangleCount;

  for (const edge of edges) {
    if (remainingFaces <= targetTriangles) break;
    let first = find(edge.a);
    let second = find(edge.b);
    if (first === second) continue;
    const affected = new Set([...incident[first], ...incident[second]]);
    let root;
    let merged;
    if (size[first] > size[second] || (size[first] === size[second] && first < second)) {
      root = first;
      merged = second;
    } else {
      root = second;
      merged = first;
    }
    parent[merged] = root;
    size[root] += size[merged];
    for (let axis = 0; axis < 3; axis += 1) positionSums[root][axis] += positionSums[merged][axis];
    if (uvSums) for (let axis = 0; axis < 2; axis += 1) uvSums[root][axis] += uvSums[merged][axis];
    if (colorSums) {
      for (let axis = 0; axis < colorSize; axis += 1) colorSums[root][axis] += colorSums[merged][axis];
    }
    for (const face of incident[merged]) incident[root].add(face);
    incident[merged].clear();
    for (const face of affected) {
      if (!liveFaces[face]) continue;
      if (!triangleIsLive(mesh.indices, face * 3, find)) {
        liveFaces[face] = false;
        remainingFaces -= 1;
      }
    }
  }
  if (remainingFaces === triangleCount) {
    throw modifierError(
      'geometry_modifier_evaluation_failed',
      `Decimate modifier ${modifier.id} could not collapse a valid mesh edge.`,
      modifier,
    );
  }

  const rootToOutput = new Map();
  const output = resultShell(mesh);
  const outputIndex = (original) => {
    const root = find(original);
    if (rootToOutput.has(root)) return rootToOutput.get(root);
    const index = output.positions.length / 3;
    const divisor = size[root];
    output.positions.push(...positionSums[root].map(value => value / divisor));
    if (output.uvs) output.uvs.push(...uvSums[root].map(value => value / divisor));
    if (output.colors) output.colors.push(...colorSums[root].map(value => value / divisor));
    rootToOutput.set(root, index);
    return index;
  };
  const faceKeys = new Set();
  for (let face = 0; face < triangleCount; face += 1) {
    if (!liveFaces[face]) continue;
    const triangle = mesh.indices.slice(face * 3, face * 3 + 3).map(outputIndex);
    const key = [...triangle].sort((a, b) => a - b).join(':');
    if (faceKeys.has(key)) continue;
    faceKeys.add(key);
    output.indices.push(...triangle);
  }
  if (output.indices.length === 0) {
    throw modifierError(
      'geometry_modifier_evaluation_failed',
      `Decimate modifier ${modifier.id} would remove every triangle.`,
      modifier,
    );
  }
  assertBudget(meshCounts(output), budget, modifier);
  return recalculateIfRequested(output, modifier);
}

function hashLattice(x, y, z, seed) {
  let value = (seed | 0)
    ^ Math.imul(x | 0, 0x1f123bb5)
    ^ Math.imul(y | 0, 0x5f356495)
    ^ Math.imul(z | 0, 0x6c8e9cf5);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0xffffffff;
}

function smoothStep(value) {
  return value * value * (3 - 2 * value);
}

function valueNoise(position, seed) {
  const base = position.map(Math.floor);
  const blend = position.map(value => smoothStep(value - Math.floor(value)));
  const sample = (dx, dy, dz) => hashLattice(base[0] + dx, base[1] + dy, base[2] + dz, seed);
  const lerp = (first, second, factor) => first + (second - first) * factor;
  const x00 = lerp(sample(0, 0, 0), sample(1, 0, 0), blend[0]);
  const x10 = lerp(sample(0, 1, 0), sample(1, 1, 0), blend[0]);
  const x01 = lerp(sample(0, 0, 1), sample(1, 0, 1), blend[0]);
  const x11 = lerp(sample(0, 1, 1), sample(1, 1, 1), blend[0]);
  return lerp(
    lerp(x00, x10, blend[1]),
    lerp(x01, x11, blend[1]),
    blend[2],
  );
}

const OCEAN_GRAVITY = 9.80665;
const OCEAN_TAU = Math.PI * 2;

function oceanWaveComponents(modifier) {
  if (modifier.mode !== 'displace') {
    throw modifierError(
      'geometry_modifier_mode_unsupported',
      `Ocean modifier ${modifier.id} supports only mode 'displace'; generated grids, caches, foam, and spray are not live.`,
      modifier,
      { supportedModes: ['displace'] },
    );
  }
  const seed = boundedInteger(modifier.seed, 'seed', 0, 0, 0x7fffffff, modifier);
  const spatialSize = finiteNumber(
    modifier.spatialSize ?? 50,
    'spatialSize',
    0.01,
    1_000_000,
    modifier,
  );
  const waveScaleMin = finiteNumber(
    modifier.waveScaleMin ?? 0.01,
    'waveScaleMin',
    0.001,
    1_000_000,
    modifier,
  );
  if (waveScaleMin > spatialSize) {
    throw modifierError(
      'invalid_geometry_modifier',
      'waveScaleMin must not exceed spatialSize.',
      modifier,
      { waveScaleMin, spatialSize },
    );
  }
  const waveScale = finiteNumber(modifier.waveScale ?? 1, 'waveScale', 0, 10_000, modifier);
  const windVelocity = finiteNumber(modifier.windVelocity ?? 30, 'windVelocity', 0, 1_000, modifier);
  const waveDirection = finiteNumber(
    modifier.waveDirection ?? 0,
    'waveDirection',
    -1_000_000,
    1_000_000,
    modifier,
  );
  const waveAlignment = finiteNumber(modifier.waveAlignment ?? 0, 'waveAlignment', 0, 1, modifier);
  const choppiness = finiteNumber(modifier.choppiness ?? 1, 'choppiness', 0, 10, modifier);
  const damping = finiteNumber(modifier.damping ?? 0.5, 'damping', 0, 1, modifier);
  const depth = finiteNumber(modifier.depth ?? 200, 'depth', 0.01, 1_000_000, modifier);
  const waveCount = boundedInteger(
    modifier.waveCount,
    'waveCount',
    16,
    1,
    MAX_OCEAN_WAVE_COUNT,
    modifier,
  );
  const windLength = Math.max(1e-6, (windVelocity * windVelocity) / OCEAN_GRAVITY);
  const wavelengthRatio = spatialSize / waveScaleMin;
  const raw = [];
  let energySum = 0;
  for (let index = 0; index < waveCount; index += 1) {
    const wavelengthJitter = hashLattice(index, 17, 31, seed);
    const directionJitter = hashLattice(index, 47, 73, seed);
    const phaseJitter = hashLattice(index, 101, 151, seed);
    const stratum = (index + wavelengthJitter) / waveCount;
    const wavelength = waveScaleMin * (wavelengthRatio ** stratum);
    const waveNumber = OCEAN_TAU / wavelength;
    const direction = waveDirection
      + (directionJitter * 2 - 1) * Math.PI * (1 - waveAlignment);
    const directionVector = [Math.cos(direction), Math.sin(direction)];
    const counterWind = Math.cos(direction - waveDirection) < 0 ? 1 - damping : 1;
    const largeWaveCutoff = Math.exp(-1 / Math.max(1e-12, (waveNumber * windLength) ** 2));
    const smallWaveCutoff = Math.exp(-((waveNumber * waveScaleMin) ** 2));
    const phillips = largeWaveCutoff * smallWaveCutoff * counterWind
      / Math.max(1e-12, waveNumber ** 4);
    const energy = Math.sqrt(Math.max(0, phillips));
    const angularFrequency = Math.sqrt(
      OCEAN_GRAVITY * waveNumber * Math.tanh(waveNumber * depth),
    );
    raw.push({
      direction: directionVector,
      waveNumber,
      angularFrequency,
      phase: phaseJitter * OCEAN_TAU,
      energy,
    });
    energySum += energy;
  }
  const windAmplitude = Math.min(4, windVelocity / 30);
  const amplitudeScale = energySum > 1e-12
    ? waveScale * windAmplitude / energySum
    : 0;
  return raw.map(component => ({
    ...component,
    amplitude: component.energy * amplitudeScale,
  }));
}

function applyOcean(mesh, modifier, options = {}) {
  const waveCount = boundedInteger(
    modifier.waveCount,
    'waveCount',
    16,
    1,
    MAX_OCEAN_WAVE_COUNT,
    modifier,
  );
  const vertexCount = mesh.positions.length / 3;
  const sampleCount = vertexCount * waveCount;
  const timelineDriven = (modifier.timelineScale ?? 1) !== 0;
  const sampleLimit = timelineDriven ? MAX_OCEAN_TIMELINE_SAMPLES : MAX_OCEAN_SAMPLES;
  if (!Number.isSafeInteger(sampleCount) || sampleCount > sampleLimit) {
    throw modifierError(
      'geometry_modifier_complexity_limit',
      `Ocean modifier ${modifier.id} requests ${sampleCount} vertex-wave samples; the ${timelineDriven ? 'timeline' : 'static'} live limit is ${sampleLimit}.`,
      modifier,
      { vertexCount, waveCount, sampleCount, limit: sampleLimit, timelineDriven },
    );
  }
  const authoredTime = finiteNumber(modifier.time ?? 1, 'time', 0, MAX_OCEAN_TIME, modifier);
  const timelineScale = finiteNumber(modifier.timelineScale ?? 1, 'timelineScale', -64, 64, modifier);
  const timelineSeconds = finiteNumber(
    options.timeSeconds ?? 0,
    'timeSeconds',
    -MAX_TIMELINE_TIME,
    MAX_TIMELINE_TIME,
    modifier,
  );
  const time = authoredTime + timelineSeconds * timelineScale;
  const choppiness = finiteNumber(modifier.choppiness ?? 1, 'choppiness', 0, 10, modifier);
  const components = oceanWaveComponents(modifier);
  const positions = [...mesh.positions];
  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    const offset = vertexIndex * 3;
    const x = mesh.positions[offset];
    const y = mesh.positions[offset + 1];
    let horizontalX = 0;
    let horizontalY = 0;
    let vertical = 0;
    for (const component of components) {
      if (component.amplitude === 0) continue;
      const travelled = (component.angularFrequency * time) % OCEAN_TAU;
      const phase = component.waveNumber
        * (component.direction[0] * x + component.direction[1] * y)
        - travelled
        + component.phase;
      const sine = Math.sin(phase);
      const cosine = Math.cos(phase);
      vertical += component.amplitude * sine;
      const foldSafeChoppiness = Math.min(
        choppiness,
        0.85 / Math.max(
          1e-12,
          component.waveNumber * component.amplitude * components.length,
        ),
      );
      const horizontal = foldSafeChoppiness * component.amplitude * cosine;
      horizontalX += component.direction[0] * horizontal;
      horizontalY += component.direction[1] * horizontal;
    }
    positions[offset] = x + horizontalX;
    positions[offset + 1] = y + horizontalY;
    positions[offset + 2] = mesh.positions[offset + 2] + vertical;
  }
  return recalculateIfRequested({ ...mesh, positions }, modifier, true);
}

function scalarSource(modifier) {
  const source = modifier.source ?? { type: 'constant', value: 1 };
  if (!isPlainRecord(source)) {
    throw modifierError('invalid_geometry_modifier', 'source must be a plain object.', modifier);
  }
  if (source.type === 'constant') {
    const value = finiteNumber(source.value ?? 1, 'source.value', 0, 1, modifier);
    return () => value;
  }
  if (source.type === 'wave') {
    const axis = vector3(source.axis ?? [1, 0, 0], 'source.axis', modifier, { normalize: true });
    const frequency = finiteNumber(source.frequency ?? 1, 'source.frequency', 0, MAX_FREQUENCY, modifier);
    const phase = finiteNumber(source.phase ?? 0, 'source.phase', -1_000_000, 1_000_000, modifier);
    return position => 0.5 + Math.sin(dot(position, axis) * frequency + phase) * 0.5;
  }
  if (source.type === 'noise') {
    const seed = boundedInteger(
      source.seed,
      'source.seed',
      0,
      -0x80000000,
      0x7fffffff,
      modifier,
    );
    const frequency = finiteNumber(source.frequency ?? 1, 'source.frequency', 1e-6, MAX_FREQUENCY, modifier);
    const octaves = boundedInteger(
      source.octaves,
      'source.octaves',
      4,
      1,
      MAX_NOISE_OCTAVES,
      modifier,
    );
    const persistence = finiteNumber(source.persistence ?? 0.5, 'source.persistence', 0, 1, modifier);
    const lacunarity = finiteNumber(source.lacunarity ?? 2, 'source.lacunarity', 1, 8, modifier);
    return (position) => {
      let amplitude = 1;
      let amplitudeSum = 0;
      let scale = frequency;
      let sum = 0;
      for (let octave = 0; octave < octaves; octave += 1) {
        sum += valueNoise(position.map(value => value * scale), seed + octave * 1013) * amplitude;
        amplitudeSum += amplitude;
        amplitude *= persistence;
        scale *= lacunarity;
      }
      return amplitudeSum === 0 ? 0.5 : sum / amplitudeSum;
    };
  }
  throw modifierError(
    'invalid_geometry_modifier',
    `Unsupported displacement source ${String(source.type)}; expected constant, wave, or noise.`,
    modifier,
  );
}

function displacementDirections(mesh, modifier) {
  const direction = modifier.direction ?? 'normal';
  if (direction === 'normal') {
    const source = recalculateVertexNormals(mesh);
    return Array.from({ length: source.positions.length / 3 }, (_, index) => (
      positionAt(source.normals, index)
    ));
  }
  if (direction === 'x') return new Array(mesh.positions.length / 3).fill(null).map(() => [1, 0, 0]);
  if (direction === 'y') return new Array(mesh.positions.length / 3).fill(null).map(() => [0, 1, 0]);
  if (direction === 'z') return new Array(mesh.positions.length / 3).fill(null).map(() => [0, 0, 1]);
  const axis = vector3(direction, 'direction', modifier, { normalize: true });
  return new Array(mesh.positions.length / 3).fill(null).map(() => [...axis]);
}

function applyDisplace(mesh, modifier) {
  if (modifier.textureId !== undefined || modifier.vertexGroupId !== undefined) {
    throw modifierError(
      'geometry_modifier_reference_unsupported',
      `Displace modifier ${modifier.id} accepts deterministic inline scalar sources only; texture and vertex-group references require resolver integration.`,
      modifier,
    );
  }
  if (modifier.coordinateSpace !== undefined && modifier.coordinateSpace !== 'local') {
    throw modifierError(
      'geometry_modifier_context_unsupported',
      `Displace modifier ${modifier.id} is context-free and supports local coordinates only.`,
      modifier,
    );
  }
  const strength = finiteNumber(
    modifier.strength ?? 1,
    'strength',
    -MAX_DISPLACEMENT_STRENGTH,
    MAX_DISPLACEMENT_STRENGTH,
    modifier,
  );
  const midlevel = finiteNumber(modifier.midlevel ?? 0.5, 'midlevel', 0, 1, modifier);
  const sample = scalarSource(modifier);
  const directions = displacementDirections(mesh, modifier);
  const positions = [...mesh.positions];
  for (let vertexIndex = 0; vertexIndex < positions.length / 3; vertexIndex += 1) {
    const position = positionAt(mesh.positions, vertexIndex);
    const amount = (sample(position, vertexIndex) - midlevel) * strength;
    const displaced = add(position, multiply(directions[vertexIndex], amount));
    displaced.forEach((value, axis) => finiteNumber(
      value,
      `result.positions[${vertexIndex}][${axis}]`,
      -1_000_000,
      1_000_000,
      modifier,
    ));
    for (let axis = 0; axis < 3; axis += 1) {
      positions[vertexIndex * 3 + axis] = displaced[axis];
    }
  }
  const output = { ...mesh, positions };
  return recalculateIfRequested(output, modifier);
}

function applySimpleDeform(mesh, modifier) {
  const mode = modifier.mode ?? 'taper';
  if (!['bend', 'twist', 'taper', 'stretch'].includes(mode)) {
    throw modifierError('invalid_geometry_modifier', 'simpleDeform mode must be bend, twist, taper, or stretch.', modifier);
  }
  const axisName = modifier.axis ?? 'x';
  const axis = { x: 0, y: 1, z: 2 }[axisName];
  if (axis === undefined) throw modifierError('invalid_geometry_modifier', 'simpleDeform axis must be x, y, or z.', modifier);
  const factor = finiteNumber(modifier.factor ?? 0, 'factor', -1000, 1000, modifier);
  const origin = vector3(modifier.origin ?? [0, 0, 0], 'origin', modifier);
  const values = [];
  for (let index = axis; index < mesh.positions.length; index += 3) values.push(mesh.positions[index] - origin[axis]);
  const minimum = Math.min(...values); const maximum = Math.max(...values);
  const span = maximum - minimum || 1;
  const center = (minimum + maximum) * 0.5;
  const perpendicular = [0, 1, 2].filter(value => value !== axis);
  const positions = [...mesh.positions];
  for (let vertexIndex = 0; vertexIndex < positions.length / 3; vertexIndex += 1) {
    const point = positionAt(mesh.positions, vertexIndex).map((value, index) => value - origin[index]);
    const along = point[axis];
    const t = (along - center) / span;
    if (mode === 'taper') {
      const scale = Math.max(0.001, 1 + factor * t);
      for (const component of perpendicular) point[component] *= scale;
    } else if (mode === 'stretch') {
      point[axis] = center + (along - center) * Math.max(0.001, 1 + factor);
    } else if (mode === 'twist') {
      const angle = factor * t;
      const [a, b] = perpendicular; const cosine = Math.cos(angle); const sine = Math.sin(angle);
      const first = point[a]; const second = point[b];
      point[a] = first * cosine - second * sine;
      point[b] = first * sine + second * cosine;
    } else if (Math.abs(factor) > 1e-9) {
      const [radial, depth] = perpendicular;
      const radius = span / factor;
      const angle = (along - center) / radius;
      const offset = point[radial] + radius;
      point[axis] = center + Math.sin(angle) * offset;
      point[radial] = Math.cos(angle) * offset - radius;
    }
    for (let component = 0; component < 3; component += 1) {
      positions[vertexIndex * 3 + component] = finiteNumber(
        point[component] + origin[component], `result.positions[${vertexIndex}][${component}]`, -1_000_000, 1_000_000, modifier,
      );
    }
  }
  return recalculateIfRequested({ ...mesh, positions }, { ...modifier, recalculateNormals: modifier.recalculateNormals ?? true });
}

const EVALUATORS = Object.freeze({
  triangulate: (mesh, modifier, budget) => applyTriangulate(mesh, modifier, budget),
  weld: (mesh, modifier, budget) => applyWeld(mesh, modifier, budget),
  smooth: (mesh, modifier, budget) => applySmooth(mesh, modifier, budget),
  weightedNormal: (mesh, modifier, budget) => applyWeightedNormal(mesh, modifier, budget),
  edgeSplit: applyEdgeSplit,
  solidify: applySolidify,
  subdivision: applySubdivision,
  decimate: applyDecimate,
  displace: (mesh, modifier, budget) => applyDisplace(mesh, modifier, budget),
  simpleDeform: (mesh, modifier, budget) => applySimpleDeform(mesh, modifier, budget),
  ocean: (mesh, modifier, budget, options) => applyOcean(mesh, modifier, options),
});

function sourceTriangleMaterials(mesh, modifier) {
  if (mesh.triangleMaterialIndices === undefined) return null;
  const expected = mesh.indices.length / 3;
  if (!Array.isArray(mesh.triangleMaterialIndices)
      || mesh.triangleMaterialIndices.length !== expected) {
    throw modifierError(
      'invalid_geometry_modifier_input',
      `triangleMaterialIndices must contain exactly ${expected} entries.`,
      modifier,
    );
  }
  return mesh.triangleMaterialIndices.map((value, index) => {
    if (!Number.isInteger(value) || value < 0 || value >= MAX_MATERIAL_SLOTS_PER_MESH) {
      throw modifierError(
        'invalid_geometry_modifier_input',
        `triangleMaterialIndices[${index}] must be an integer from 0 to ${MAX_MATERIAL_SLOTS_PER_MESH - 1}.`,
        modifier,
      );
    }
    return value;
  });
}

function preserveTriangleMaterials(source, result, type, modifier) {
  const materials = sourceTriangleMaterials(source, modifier);
  if (materials === null) {
    delete result.triangleMaterialIndices;
    return result;
  }
  const outputTriangles = result.indices.length / 3;
  const distinct = new Set(materials);
  if (distinct.size <= 1) {
    result.triangleMaterialIndices = new Array(outputTriangles).fill(materials[0] ?? 0);
    return result;
  }
  if (['triangulate', 'smooth', 'weightedNormal', 'edgeSplit', 'displace', 'ocean'].includes(type)) {
    if (outputTriangles !== materials.length) {
      throw modifierError(
        'geometry_modifier_material_groups_unsupported',
        `Modifier ${modifier.id} changed triangle count without material provenance.`,
        modifier,
      );
    }
    result.triangleMaterialIndices = [...materials];
    return result;
  }
  if (type === 'subdivision') {
    const levels = modifier.levels ?? modifier.level ?? 1;
    const descendants = 4 ** levels;
    result.triangleMaterialIndices = materials.flatMap(value => new Array(descendants).fill(value));
    return result;
  }
  if (type === 'solidify') {
    const pairedFaces = materials.flatMap(value => [value, value]);
    const boundaryFaces = [...triangleTopology(source).edges.values()]
      .filter(edge => edge.faces.length === 1)
      .flatMap(edge => {
        const value = materials[edge.faces[0]];
        return [value, value];
      });
    result.triangleMaterialIndices = [...pairedFaces, ...boundaryFaces];
    return result;
  }
  if (outputTriangles === materials.length) {
    result.triangleMaterialIndices = [...materials];
    return result;
  }
  throw modifierError(
    'geometry_modifier_material_groups_unsupported',
    `Modifier ${modifier.id} (${modifier.type}) changes multi-material topology without exact face provenance.`,
    modifier,
  );
}

/**
 * Applies one enabled, geometry-changing modifier to a canonical indexed mesh.
 * Flags are intentionally handled by evaluateGeometryModifierStack; this
 * function always evaluates the supplied modifier.
 */
export function applyGeometryModifier(recipe, modifier, options = {}) {
  const budget = normalizeBudget(options);
  let mesh;
  try {
    mesh = validateIndexedMeshRecipe(recipe);
  } catch (error) {
    throw new StudioError(
      'invalid_geometry_modifier_input',
      `Geometry modifier input is not a canonical indexed mesh: ${error.message}`,
      { cause: error },
    );
  }
  const type = validateModifier(modifier);
  if (!type) {
    throw modifierError(
      'unsupported_geometry_modifier',
      `Modifier ${modifier.id} (${modifier.type}) has no deterministic indexed-mesh evaluator.`,
      modifier,
      { supportedTypes: GEOMETRY_MODIFIER_TYPES },
    );
  }
  const result = EVALUATORS[type](mesh, modifier, budget, options);
  assertBudget(meshCounts(result), budget, modifier);
  preserveTriangleMaterials(mesh, result, type, modifier);
  try {
    return validateIndexedMeshRecipe(result);
  } catch (error) {
    throw modifierError(
      'geometry_modifier_evaluation_failed',
      `Modifier ${modifier.id} produced an invalid indexed mesh: ${error.message}`,
      modifier,
      { cause: error },
    );
  }
}

/**
 * Evaluates an ordered, stable-ID modifier stack without mutating its input.
 * Unsupported modifiers fail closed by default. Callers may request `skip` to
 * inspect an explicit bake boundary, but evaluation stops at that boundary;
 * downstream modifiers are never applied to a semantically incomplete mesh.
 */
export function evaluateGeometryModifierStack(recipe, modifiers, options = {}) {
  const target = targetValue(options.target ?? 'viewport');
  const unsupported = options.unsupported ?? 'error';
  if (!['error', 'skip'].includes(unsupported)) {
    throw new StudioError(
      'invalid_geometry_modifier_policy',
      "unsupported must be 'error' or 'skip'.",
      { unsupported },
    );
  }
  if (!Array.isArray(modifiers) || modifiers.length > MAX_MODIFIERS) {
    throw new StudioError(
      'invalid_geometry_modifier_stack',
      `modifiers must be an array with at most ${MAX_MODIFIERS} entries.`,
      { count: Array.isArray(modifiers) ? modifiers.length : undefined },
    );
  }
  const budget = normalizeBudget(options);
  let output;
  try {
    output = validateIndexedMeshRecipe(recipe);
  } catch (error) {
    throw new StudioError(
      'invalid_geometry_modifier_input',
      `Geometry modifier input is not a canonical indexed mesh: ${error.message}`,
      { cause: error },
    );
  }
  const ids = new Set();
  const applied = [];
  const skipped = [];
  const blocked = [];
  const diagnostics = [];
  const validatedTypes = modifiers.map(validateModifier);
  for (const modifier of modifiers) {
    if (ids.has(modifier.id)) {
      throw modifierError(
        'duplicate_geometry_modifier_id',
        `Modifier stack contains duplicate stable ID ${modifier.id}.`,
        modifier,
      );
    }
    ids.add(modifier.id);
  }
  for (let index = 0; index < modifiers.length; index += 1) {
    const modifier = modifiers[index];
    const type = validatedTypes[index];
    const state = modifierEnabled(modifier, target);
    if (!state.enabled) {
      skipped.push({ id: modifier.id, type: modifier.type, reason: state.reason });
      continue;
    }
    if (!type) {
      const diagnostic = {
        severity: 'warning',
        code: unsupported === 'error'
          ? 'unsupported_geometry_modifier'
          : 'geometry_modifier_bake_boundary',
        modifierId: modifier.id,
        modifierType: modifier.type,
        message: unsupported === 'error'
          ? `Modifier ${modifier.id} (${modifier.type}) requires baking or a future evaluator.`
          : `Modifier ${modifier.id} (${modifier.type}) requires baking; geometry evaluation stopped before all downstream modifiers.`,
      };
      if (unsupported === 'error') {
        throw modifierError(
          diagnostic.code,
          diagnostic.message,
          modifier,
          { supportedTypes: GEOMETRY_MODIFIER_TYPES },
        );
      }
      diagnostics.push(diagnostic);
      skipped.push({ id: modifier.id, type: modifier.type, reason: 'unsupported' });
      for (const remainder of modifiers.slice(index + 1)) {
        blocked.push({
          id: remainder.id,
          type: remainder.type,
          reason: 'after-bake-boundary',
          boundaryModifierId: modifier.id,
        });
      }
      break;
    }
    const before = meshCounts(output);
    output = applyGeometryModifier(output, modifier, {
      ...budget,
      ...(options.timeSeconds === undefined ? {} : { timeSeconds: options.timeSeconds }),
    });
    const after = meshCounts(output);
    applied.push({ id: modifier.id, type, authoredType: modifier.type, before, after });
  }
  return {
    recipe: output,
    target,
    applied,
    skipped,
    blocked,
    diagnostics,
    counts: meshCounts(output),
    budget,
  };
}

export const evaluateIndexedMeshModifierStack = evaluateGeometryModifierStack;
