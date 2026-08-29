import { assertJsonValue, cloneJson, contentHash, isPlainRecord } from './util.mjs';
import { StudioError } from './errors.mjs';
import { MAX_MATERIAL_SLOTS_PER_MESH } from './constants.mjs';

const MAX_COORDINATE = 1_000_000;
const MAX_VERTICES = 1_000_000;
const MAX_FACES = 1_000_000;
const MAX_CORNERS = 4_000_000;
const MAX_FACE_CORNERS = 4_096;
const MAX_TRIANGULATION_WORK = 8_000_000;
const MAX_COMPILED_VERTICES = 1_000_000;
const MAX_COMPILED_TRIANGLES = 2_000_000;
const MAX_LAYERS = 32;
const MAX_LAYER_NAME_LENGTH = 128;
const MAX_EDIT_COMMANDS = 256;
const MAX_SMOOTH_ITERATIONS = 100;
const EPSILON = 1e-12;

const RECIPE_KEYS = new Set([
  'kind',
  'positions',
  'faceOffsets',
  'cornerVertexIndices',
  'uvLayers',
  'colorLayers',
  'activeUvLayer',
  'activeColorLayer',
  'faceMaterialIndices',
  'sharpEdges',
  'edgeCreases',
]);
const EDIT_COMMAND_KEYS = new Map([
  ['move', new Set(['type', 'expectedTopologyHash', 'vertexIndices', 'selection', 'offset', 'delta'])],
  ['moveVertices', new Set(['type', 'expectedTopologyHash', 'vertexIndices', 'selection', 'offset', 'delta'])],
  ['scale', new Set(['type', 'expectedTopologyHash', 'vertexIndices', 'selection', 'scale', 'factor', 'pivot'])],
  ['scaleVertices', new Set(['type', 'expectedTopologyHash', 'vertexIndices', 'selection', 'scale', 'factor', 'pivot'])],
  ['rotate', new Set(['type', 'expectedTopologyHash', 'vertexIndices', 'selection', 'rotation', 'euler', 'axis', 'angle', 'pivot'])],
  ['rotateVertices', new Set(['type', 'expectedTopologyHash', 'vertexIndices', 'selection', 'rotation', 'euler', 'axis', 'angle', 'pivot'])],
  ['smooth', new Set(['type', 'expectedTopologyHash', 'vertexIndices', 'selection', 'iterations', 'factor', 'preserveBoundary'])],
  ['smoothVertices', new Set(['type', 'expectedTopologyHash', 'vertexIndices', 'selection', 'iterations', 'factor', 'preserveBoundary'])],
  ['subdivideFaces', new Set(['type', 'expectedTopologyHash', 'faceIndices', 'selection'])],
  ['insetFaces', new Set(['type', 'expectedTopologyHash', 'faceIndices', 'selection', 'factor', 'thickness'])],
  ['extrudeFaces', new Set(['type', 'expectedTopologyHash', 'faceIndices', 'selection', 'mode', 'offset', 'distance', 'sideMaterialIndex'])],
  ['bevelEdges', new Set(['type', 'expectedTopologyHash', 'edges', 'edgeVertexIndices', 'factor', 'width', 'materialIndex'])],
  ['deleteFaces', new Set(['type', 'expectedTopologyHash', 'faceIndices', 'selection'])],
  ['mergeVertices', new Set(['type', 'expectedTopologyHash', 'vertexIndices', 'selection', 'targetVertexIndex', 'position', 'tolerance'])],
]);

export const EDITABLE_MESH_LIMITS = Object.freeze({
  maxCoordinate: MAX_COORDINATE,
  maxVertices: MAX_VERTICES,
  maxFaces: MAX_FACES,
  maxCorners: MAX_CORNERS,
  maxFaceCorners: MAX_FACE_CORNERS,
  maxTriangulationWork: MAX_TRIANGULATION_WORK,
  maxCompiledVertices: MAX_COMPILED_VERTICES,
  maxCompiledTriangles: MAX_COMPILED_TRIANGLES,
  maxLayers: MAX_LAYERS,
  maxLayerNameLength: MAX_LAYER_NAME_LENGTH,
  maxEditCommands: MAX_EDIT_COMMANDS,
  maxSmoothIterations: MAX_SMOOTH_ITERATIONS,
});

function finiteNumber(value, label, minimum = -MAX_COORDINATE, maximum = MAX_COORDINATE) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be a finite number.`);
  if (value < minimum || value > maximum) {
    throw new RangeError(`${label} must be from ${minimum} to ${maximum}.`);
  }
  return value;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isInteger(value)) throw new TypeError(`${label} must be an integer.`);
  if (value < minimum || value > maximum) {
    throw new RangeError(`${label} must be from ${minimum} to ${maximum}.`);
  }
  return value;
}

function vector3(value, label) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError(`${label} must contain exactly three finite numbers.`);
  }
  return value.map((component, axis) => finiteNumber(component, `${label}[${axis}]`));
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label}.${key} is not supported.`);
  }
}

function validateLayerName(name, label) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_LAYER_NAME_LENGTH) {
    throw new TypeError(`${label} must be a non-empty string no longer than ${MAX_LAYER_NAME_LENGTH} characters.`);
  }
  if (name.trim() !== name || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new TypeError(`${label} cannot have surrounding whitespace or control characters.`);
  }
  return name;
}

function normalizedNumberArray(value, label, expectedLength, minimum, maximum) {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw new RangeError(`${label} must contain exactly ${expectedLength} numbers.`);
  }
  return value.map((entry, index) => finiteNumber(entry, `${label}[${index}]`, minimum, maximum));
}

function normalizedLayers(value, label, itemSize, cornerCount, minimum, maximum) {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be a plain object of named layers.`);
  const names = Object.keys(value).sort();
  if (names.length > MAX_LAYERS) throw new RangeError(`${label} cannot contain more than ${MAX_LAYERS} layers.`);
  const result = {};
  for (const name of names) {
    validateLayerName(name, `${label} layer name`);
    result[name] = normalizedNumberArray(
      value[name],
      `${label}.${name}`,
      cornerCount * itemSize,
      minimum,
      maximum,
    );
  }
  return result;
}

function normalizedActiveLayer(value, layers, label) {
  const names = Object.keys(layers);
  if (value === null) return null;
  if (value === undefined) {
    if (names.length <= 1) return names[0] ?? null;
    throw new TypeError(`${label} is required when more than one layer is authored.`);
  }
  validateLayerName(value, label);
  if (!Object.hasOwn(layers, value)) throw new RangeError(`${label} references unknown layer ${value}.`);
  return value;
}

function edgeKey(first, second) {
  return first < second ? `${first}:${second}` : `${second}:${first}`;
}

function edgeTuple(first, second) {
  return first < second ? [first, second] : [second, first];
}

function topologyEdgeSet(faceOffsets, cornerVertexIndices) {
  const edges = new Set();
  for (let faceIndex = 0; faceIndex < faceOffsets.length - 1; faceIndex += 1) {
    const start = faceOffsets[faceIndex];
    const end = faceOffsets[faceIndex + 1];
    for (let corner = start; corner < end; corner += 1) {
      const next = corner + 1 === end ? start : corner + 1;
      edges.add(edgeKey(cornerVertexIndices[corner], cornerVertexIndices[next]));
    }
  }
  return edges;
}

function normalizedSharpEdges(value, vertexCount, topologyEdges) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('sharpEdges must be an array of vertex-index pairs.');
  const unique = new Map();
  for (let index = 0; index < value.length; index += 1) {
    const pair = value[index];
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new TypeError(`sharpEdges[${index}] must contain exactly two vertex indices.`);
    }
    const first = integer(pair[0], `sharpEdges[${index}][0]`, 0, Math.max(0, vertexCount - 1));
    const second = integer(pair[1], `sharpEdges[${index}][1]`, 0, Math.max(0, vertexCount - 1));
    if (first === second) throw new RangeError(`sharpEdges[${index}] cannot reference the same vertex twice.`);
    const key = edgeKey(first, second);
    if (!topologyEdges.has(key)) throw new RangeError(`sharpEdges[${index}] does not reference a mesh edge.`);
    if (unique.has(key)) throw new RangeError(`sharpEdges contains duplicate edge ${key}.`);
    unique.set(key, edgeTuple(first, second));
  }
  return [...unique.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function normalizedEdgeCreases(value, vertexCount, topologyEdges) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('edgeCreases must be an array of [vertexA, vertexB, weight] tuples.');
  const unique = new Map();
  for (let index = 0; index < value.length; index += 1) {
    const tuple = value[index];
    if (!Array.isArray(tuple) || tuple.length !== 3) {
      throw new TypeError(`edgeCreases[${index}] must contain two vertex indices and one weight.`);
    }
    const first = integer(tuple[0], `edgeCreases[${index}][0]`, 0, Math.max(0, vertexCount - 1));
    const second = integer(tuple[1], `edgeCreases[${index}][1]`, 0, Math.max(0, vertexCount - 1));
    if (first === second) throw new RangeError(`edgeCreases[${index}] cannot reference the same vertex twice.`);
    const weight = finiteNumber(tuple[2], `edgeCreases[${index}][2]`, 0, 1);
    const key = edgeKey(first, second);
    if (!topologyEdges.has(key)) throw new RangeError(`edgeCreases[${index}] does not reference a mesh edge.`);
    if (unique.has(key)) throw new RangeError(`edgeCreases contains duplicate edge ${key}.`);
    const [minimum, maximum] = edgeTuple(first, second);
    unique.set(key, [minimum, maximum, weight]);
  }
  return [...unique.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * Validates and canonicalizes an editable polygon mesh. UV layers contain two
 * numbers per face corner and color layers contain linear RGBA per face corner.
 */
export function normalizeEditableMeshRecipe(recipe) {
  if (!isPlainRecord(recipe)) throw new TypeError('Editable mesh recipe must be a plain object.');
  assertJsonValue(recipe, 'editableMesh');
  assertKnownKeys(recipe, RECIPE_KEYS, 'editableMesh');
  if (recipe.kind !== 'editableMesh') throw new TypeError("Editable mesh recipe kind must be 'editableMesh'.");

  if (!Array.isArray(recipe.positions) || recipe.positions.length % 3 !== 0) {
    throw new RangeError('positions must be an array divisible by three.');
  }
  const vertexCount = recipe.positions.length / 3;
  if (vertexCount > MAX_VERTICES) throw new RangeError(`positions exceeds the ${MAX_VERTICES}-vertex budget.`);
  const positions = recipe.positions.map((entry, index) => finiteNumber(entry, `positions[${index}]`));

  if (!Array.isArray(recipe.faceOffsets) || recipe.faceOffsets.length === 0) {
    throw new TypeError('faceOffsets must be a non-empty CSR offset array beginning with zero.');
  }
  const faceCount = recipe.faceOffsets.length - 1;
  if (faceCount > MAX_FACES) throw new RangeError(`faceOffsets exceeds the ${MAX_FACES}-face budget.`);
  const faceOffsets = recipe.faceOffsets.map((entry, index) => integer(
    entry,
    `faceOffsets[${index}]`,
    0,
    MAX_CORNERS,
  ));
  if (faceOffsets[0] !== 0) throw new RangeError('faceOffsets[0] must be zero.');

  if (!Array.isArray(recipe.cornerVertexIndices)) throw new TypeError('cornerVertexIndices must be an array.');
  const cornerCount = recipe.cornerVertexIndices.length;
  if (cornerCount > MAX_CORNERS) throw new RangeError(`cornerVertexIndices exceeds the ${MAX_CORNERS}-corner budget.`);
  if (faceOffsets.at(-1) !== cornerCount) {
    throw new RangeError('The final faceOffsets entry must equal cornerVertexIndices.length.');
  }
  const cornerVertexIndices = recipe.cornerVertexIndices.map((entry, index) => integer(
    entry,
    `cornerVertexIndices[${index}]`,
    0,
    Math.max(0, vertexCount - 1),
  ));
  if (cornerCount > 0 && vertexCount === 0) throw new RangeError('Faces cannot reference an empty positions array.');

  for (let faceIndex = 0; faceIndex < faceCount; faceIndex += 1) {
    const start = faceOffsets[faceIndex];
    const end = faceOffsets[faceIndex + 1];
    const faceCornerCount = end - start;
    if (faceCornerCount < 3) throw new RangeError(`Face ${faceIndex} must contain at least three corners.`);
    if (faceCornerCount > MAX_FACE_CORNERS) {
      throw new RangeError(`Face ${faceIndex} exceeds the ${MAX_FACE_CORNERS}-corner per-face budget.`);
    }
    const seen = new Set();
    for (let corner = start; corner < end; corner += 1) {
      const vertexIndex = cornerVertexIndices[corner];
      if (seen.has(vertexIndex)) throw new RangeError(`Face ${faceIndex} repeats vertex ${vertexIndex}.`);
      seen.add(vertexIndex);
    }
  }

  const uvLayers = normalizedLayers(recipe.uvLayers, 'uvLayers', 2, cornerCount, -MAX_COORDINATE, MAX_COORDINATE);
  const colorLayers = normalizedLayers(recipe.colorLayers, 'colorLayers', 4, cornerCount, 0, 1);
  const activeUvLayer = normalizedActiveLayer(recipe.activeUvLayer, uvLayers, 'activeUvLayer');
  const activeColorLayer = normalizedActiveLayer(recipe.activeColorLayer, colorLayers, 'activeColorLayer');
  if (recipe.faceMaterialIndices !== undefined && !Array.isArray(recipe.faceMaterialIndices)) {
    throw new TypeError('faceMaterialIndices must be an array.');
  }
  const faceMaterialIndices = recipe.faceMaterialIndices === undefined
    ? new Array(faceCount).fill(0)
    : recipe.faceMaterialIndices.map((entry, index) => integer(
      entry,
      `faceMaterialIndices[${index}]`,
      0,
      MAX_MATERIAL_SLOTS_PER_MESH - 1,
    ));
  if (faceMaterialIndices.length !== faceCount) {
    throw new RangeError(`faceMaterialIndices must contain exactly ${faceCount} entries.`);
  }

  const topologyEdges = topologyEdgeSet(faceOffsets, cornerVertexIndices);
  const sharpEdges = normalizedSharpEdges(recipe.sharpEdges, vertexCount, topologyEdges);
  const edgeCreases = normalizedEdgeCreases(recipe.edgeCreases, vertexCount, topologyEdges);

  return {
    kind: 'editableMesh',
    positions,
    faceOffsets,
    cornerVertexIndices,
    uvLayers,
    colorLayers,
    activeUvLayer,
    activeColorLayer,
    faceMaterialIndices,
    sharpEdges,
    edgeCreases,
  };
}

/** Validates an editable mesh and returns a detached canonical clone. */
export function validateEditableMeshRecipe(recipe) {
  return normalizeEditableMeshRecipe(recipe);
}

/** Hashes connectivity only; position or attribute edits do not change this guard. */
export function editableMeshTopologyHash(recipe) {
  const mesh = normalizeEditableMeshRecipe(recipe);
  return contentHash({
    vertexCount: mesh.positions.length / 3,
    faceOffsets: mesh.faceOffsets,
    cornerVertexIndices: mesh.cornerVertexIndices,
  });
}

function faceRecords(mesh) {
  const faces = [];
  for (let faceIndex = 0; faceIndex < mesh.faceOffsets.length - 1; faceIndex += 1) {
    const start = mesh.faceOffsets[faceIndex];
    const end = mesh.faceOffsets[faceIndex + 1];
    const uv = {};
    const color = {};
    for (const [name, values] of Object.entries(mesh.uvLayers)) {
      uv[name] = Array.from({ length: end - start }, (_, localCorner) => (
        values.slice((start + localCorner) * 2, (start + localCorner) * 2 + 2)
      ));
    }
    for (const [name, values] of Object.entries(mesh.colorLayers)) {
      color[name] = Array.from({ length: end - start }, (_, localCorner) => (
        values.slice((start + localCorner) * 4, (start + localCorner) * 4 + 4)
      ));
    }
    faces.push({
      vertices: mesh.cornerVertexIndices.slice(start, end),
      uv,
      color,
      materialIndex: mesh.faceMaterialIndices[faceIndex],
      sourceFaceIndex: faceIndex,
    });
  }
  return faces;
}

function flattenFaces(positions, faces, sharpEdges = [], edgeCreases = [], layerSource = null) {
  const faceOffsets = [0];
  const cornerVertexIndices = [];
  const uvNames = Object.keys(faces[0]?.uv ?? layerSource?.uvLayers ?? {}).sort();
  const colorNames = Object.keys(faces[0]?.color ?? layerSource?.colorLayers ?? {}).sort();
  const uvLayers = Object.fromEntries(uvNames.map(name => [name, []]));
  const colorLayers = Object.fromEntries(colorNames.map(name => [name, []]));
  const faceMaterialIndices = [];
  for (const face of faces) {
    cornerVertexIndices.push(...face.vertices);
    faceOffsets.push(cornerVertexIndices.length);
    faceMaterialIndices.push(face.materialIndex ?? 0);
    for (const name of uvNames) {
      if (!Array.isArray(face.uv[name]) || face.uv[name].length !== face.vertices.length) {
        throw new Error(`Topology edit did not preserve UV layer ${name}.`);
      }
      for (const value of face.uv[name]) uvLayers[name].push(...value);
    }
    for (const name of colorNames) {
      if (!Array.isArray(face.color[name]) || face.color[name].length !== face.vertices.length) {
        throw new Error(`Topology edit did not preserve color layer ${name}.`);
      }
      for (const value of face.color[name]) colorLayers[name].push(...value);
    }
  }
  return normalizeEditableMeshRecipe({
    kind: 'editableMesh',
    positions,
    faceOffsets,
    cornerVertexIndices,
    uvLayers,
    colorLayers,
    activeUvLayer: layerSource?.activeUvLayer,
    activeColorLayer: layerSource?.activeColorLayer,
    faceMaterialIndices,
    sharpEdges,
    edgeCreases,
  });
}

function selectedIndices(value, count, label, { defaultAll = false, minimum = 1 } = {}) {
  if (value === 'all' || (value === undefined && defaultAll)) {
    const all = Array.from({ length: count }, (_, index) => index);
    if (all.length < minimum) throw new RangeError(`${label} has no selectable elements.`);
    return all;
  }
  if (!Array.isArray(value) || value.length < minimum) {
    throw new TypeError(`${label} must be an array with at least ${minimum} unique indices, or 'all'.`);
  }
  const seen = new Set();
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = integer(value[index], `${label}[${index}]`, 0, Math.max(0, count - 1));
    if (seen.has(entry)) throw new RangeError(`${label} contains duplicate index ${entry}.`);
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

function assertOutputBudget(vertexCount, faceCount, cornerCount, label) {
  if (vertexCount > MAX_VERTICES) throw new RangeError(`${label} would exceed the ${MAX_VERTICES}-vertex budget.`);
  if (faceCount > MAX_FACES) throw new RangeError(`${label} would exceed the ${MAX_FACES}-face budget.`);
  if (cornerCount > MAX_CORNERS) throw new RangeError(`${label} would exceed the ${MAX_CORNERS}-corner budget.`);
}

function vertex(mesh, vertexIndex) {
  return mesh.positions.slice(vertexIndex * 3, vertexIndex * 3 + 3);
}

function averageVectors(values, itemSize) {
  const result = new Array(itemSize).fill(0);
  for (const value of values) {
    for (let component = 0; component < itemSize; component += 1) result[component] += value[component];
  }
  return result.map(value => value / values.length);
}

function lerpVector(first, second, factor) {
  return first.map((value, index) => value + (second[index] - value) * factor);
}

function faceCentroid(mesh, face) {
  return averageVectors(face.vertices.map(vertexIndex => vertex(mesh, vertexIndex)), 3);
}

function faceNormal(mesh, face) {
  const normal = [0, 0, 0];
  for (let index = 0; index < face.vertices.length; index += 1) {
    const current = vertex(mesh, face.vertices[index]);
    const next = vertex(mesh, face.vertices[(index + 1) % face.vertices.length]);
    normal[0] += (current[1] - next[1]) * (current[2] + next[2]);
    normal[1] += (current[2] - next[2]) * (current[0] + next[0]);
    normal[2] += (current[0] - next[0]) * (current[1] + next[1]);
  }
  const length = Math.hypot(...normal);
  if (length <= EPSILON) throw new RangeError(`Face ${face.sourceFaceIndex} has no stable normal.`);
  return normal.map(value => value / length);
}

function selectionCentroid(mesh, selection) {
  return averageVectors(selection.map(vertexIndex => vertex(mesh, vertexIndex)), 3);
}

function withEditedVertices(recipe, command, edit) {
  const mesh = normalizeEditableMeshRecipe(recipe);
  const selection = selectedIndices(
    command.vertexIndices ?? command.selection,
    mesh.positions.length / 3,
    'vertexIndices',
  );
  const positions = [...mesh.positions];
  for (const vertexIndex of selection) {
    const result = vector3(edit(vertex(mesh, vertexIndex), vertexIndex, mesh, selection), `positions[${vertexIndex}]`);
    positions.splice(vertexIndex * 3, 3, ...result);
  }
  return { ...mesh, positions };
}

/** Moves an exact vertex selection by an XYZ delta. */
export function moveEditableMeshVertices(recipe, command = {}) {
  const offset = vector3(command.offset ?? command.delta, 'offset');
  return withEditedVertices(recipe, command, position => position.map((value, axis) => value + offset[axis]));
}

/** Scales an exact vertex selection around an explicit pivot or its centroid. */
export function scaleEditableMeshVertices(recipe, command = {}) {
  const mesh = normalizeEditableMeshRecipe(recipe);
  const selection = selectedIndices(command.vertexIndices ?? command.selection, mesh.positions.length / 3, 'vertexIndices');
  const rawScale = command.scale ?? command.factor;
  const scale = Number.isFinite(rawScale)
    ? [rawScale, rawScale, rawScale].map((value, axis) => finiteNumber(value, `scale[${axis}]`))
    : vector3(rawScale, 'scale');
  const pivot = command.pivot === undefined ? selectionCentroid(mesh, selection) : vector3(command.pivot, 'pivot');
  return withEditedVertices(mesh, { vertexIndices: selection }, position => position.map(
    (value, axis) => pivot[axis] + (value - pivot[axis]) * scale[axis],
  ));
}

function eulerRotate([x, y, z], [rx, ry, rz]) {
  const [sx, cx] = [Math.sin(rx), Math.cos(rx)];
  const [sy, cy] = [Math.sin(ry), Math.cos(ry)];
  const [sz, cz] = [Math.sin(rz), Math.cos(rz)];
  const x1 = x;
  const y1 = y * cx - z * sx;
  const z1 = y * sx + z * cx;
  const x2 = x1 * cy + z1 * sy;
  const y2 = y1;
  const z2 = -x1 * sy + z1 * cy;
  return [x2 * cz - y2 * sz, x2 * sz + y2 * cz, z2];
}

function axisAngleRotate([x, y, z], axis, angle) {
  const [rawX, rawY, rawZ] = vector3(axis, 'axis');
  const length = Math.hypot(rawX, rawY, rawZ);
  if (length <= EPSILON) throw new RangeError('axis must have non-zero length.');
  const [ux, uy, uz] = [rawX / length, rawY / length, rawZ / length];
  const cosine = Math.cos(finiteNumber(angle, 'angle'));
  const sine = Math.sin(angle);
  const dot = ux * x + uy * y + uz * z;
  return [
    x * cosine + (uy * z - uz * y) * sine + ux * dot * (1 - cosine),
    y * cosine + (uz * x - ux * z) * sine + uy * dot * (1 - cosine),
    z * cosine + (ux * y - uy * x) * sine + uz * dot * (1 - cosine),
  ];
}

/** Rotates an exact vertex selection in XYZ Euler radians. */
export function rotateEditableMeshVertices(recipe, command = {}) {
  const mesh = normalizeEditableMeshRecipe(recipe);
  const selection = selectedIndices(command.vertexIndices ?? command.selection, mesh.positions.length / 3, 'vertexIndices');
  const hasEuler = command.rotation !== undefined || command.euler !== undefined;
  const hasAxisAngle = command.axis !== undefined || command.angle !== undefined;
  if (hasEuler === hasAxisAngle) {
    throw new TypeError('rotateVertices requires either rotation/euler or both axis and angle.');
  }
  if (hasAxisAngle && (command.axis === undefined || command.angle === undefined)) {
    throw new TypeError('rotateVertices axis and angle must be supplied together.');
  }
  const rotation = hasEuler ? vector3(command.rotation ?? command.euler, 'rotation') : null;
  const pivot = command.pivot === undefined ? selectionCentroid(mesh, selection) : vector3(command.pivot, 'pivot');
  return withEditedVertices(mesh, { vertexIndices: selection }, (position) => {
    const relative = position.map((value, axis) => value - pivot[axis]);
    const rotated = rotation === null
      ? axisAngleRotate(relative, command.axis, command.angle)
      : eulerRotate(relative, rotation);
    return rotated.map((value, axis) => value + pivot[axis]);
  });
}

function edgeIncidence(mesh) {
  const result = new Map();
  const faces = faceRecords(mesh);
  for (let faceIndex = 0; faceIndex < faces.length; faceIndex += 1) {
    const face = faces[faceIndex];
    for (let cornerIndex = 0; cornerIndex < face.vertices.length; cornerIndex += 1) {
      const first = face.vertices[cornerIndex];
      const second = face.vertices[(cornerIndex + 1) % face.vertices.length];
      const key = edgeKey(first, second);
      const values = result.get(key) ?? [];
      values.push({ faceIndex, cornerIndex, first, second });
      result.set(key, values);
    }
  }
  return result;
}

/** Simultaneous Laplacian smoothing with optional boundary preservation. */
export function smoothEditableMeshVertices(recipe, command = {}) {
  const mesh = normalizeEditableMeshRecipe(recipe);
  const vertexCount = mesh.positions.length / 3;
  const selection = selectedIndices(
    command.vertexIndices ?? command.selection,
    vertexCount,
    'vertexIndices',
    { defaultAll: true, minimum: 0 },
  );
  const iterations = integer(command.iterations ?? 1, 'iterations', 1, MAX_SMOOTH_ITERATIONS);
  const factor = finiteNumber(command.factor ?? 0.5, 'factor', 0, 1);
  const preserveBoundary = command.preserveBoundary ?? true;
  if (typeof preserveBoundary !== 'boolean') throw new TypeError('preserveBoundary must be a boolean.');
  const adjacency = Array.from({ length: vertexCount }, () => new Set());
  const incidence = edgeIncidence(mesh);
  const boundary = new Set();
  for (const [key, values] of incidence) {
    const [first, second] = key.split(':').map(Number);
    adjacency[first].add(second);
    adjacency[second].add(first);
    if (values.length === 1) {
      boundary.add(first);
      boundary.add(second);
    }
  }
  let positions = [...mesh.positions];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const previous = positions;
    positions = [...previous];
    for (const vertexIndex of selection) {
      if ((preserveBoundary && boundary.has(vertexIndex)) || adjacency[vertexIndex].size === 0) continue;
      const neighbours = [...adjacency[vertexIndex]].map(index => previous.slice(index * 3, index * 3 + 3));
      const average = averageVectors(neighbours, 3);
      const offset = vertexIndex * 3;
      for (let axis = 0; axis < 3; axis += 1) {
        positions[offset + axis] = finiteNumber(
          previous[offset + axis] + (average[axis] - previous[offset + axis]) * factor,
          `positions[${vertexIndex * 3 + axis}]`,
        );
      }
    }
  }
  return { ...mesh, positions };
}

function faceAttributeAverages(face) {
  return {
    uv: Object.fromEntries(Object.entries(face.uv).map(([name, values]) => [name, averageVectors(values, 2)])),
    color: Object.fromEntries(Object.entries(face.color).map(([name, values]) => [name, averageVectors(values, 4)])),
  };
}

function repeatedAttributeFace(face, indices) {
  return {
    uv: Object.fromEntries(Object.entries(face.uv).map(([name, values]) => [
      name,
      indices.map(index => cloneJson(values[index])),
    ])),
    color: Object.fromEntries(Object.entries(face.color).map(([name, values]) => [
      name,
      indices.map(index => cloneJson(values[index])),
    ])),
  };
}

function filterEdgeAnnotations(mesh, faces, additions = { sharp: [], creases: [] }) {
  const offsets = [0];
  const indices = [];
  for (const face of faces) {
    indices.push(...face.vertices);
    offsets.push(indices.length);
  }
  const existing = topologyEdgeSet(offsets, indices);
  const sharp = new Map();
  for (const pair of [...mesh.sharpEdges, ...(additions.sharp ?? [])]) {
    const key = edgeKey(pair[0], pair[1]);
    if (existing.has(key)) sharp.set(key, edgeTuple(pair[0], pair[1]));
  }
  const creases = new Map();
  for (const tuple of [...mesh.edgeCreases, ...(additions.creases ?? [])]) {
    const key = edgeKey(tuple[0], tuple[1]);
    if (!existing.has(key)) continue;
    const [first, second] = edgeTuple(tuple[0], tuple[1]);
    creases.set(key, [first, second, Math.max(creases.get(key)?.[2] ?? 0, tuple[2])]);
  }
  return {
    sharpEdges: [...sharp.values()],
    edgeCreases: [...creases.values()],
  };
}

/** Splits selected polygons into deterministic center-fan triangles. */
export function subdivideEditableMeshFaces(recipe, command = {}) {
  const mesh = normalizeEditableMeshRecipe(recipe);
  const faces = faceRecords(mesh);
  const selection = new Set(selectedIndices(command.faceIndices ?? command.selection, faces.length, 'faceIndices'));
  const selectedCornerCount = [...selection].reduce((sum, index) => sum + faces[index].vertices.length, 0);
  assertOutputBudget(
    mesh.positions.length / 3 + selection.size,
    faces.length + selectedCornerCount - selection.size,
    mesh.cornerVertexIndices.length + selectedCornerCount * 2,
    'subdivideFaces',
  );
  const positions = [...mesh.positions];
  const output = [];
  for (let faceIndex = 0; faceIndex < faces.length; faceIndex += 1) {
    const face = faces[faceIndex];
    if (!selection.has(faceIndex)) {
      output.push(face);
      continue;
    }
    const centerIndex = positions.length / 3;
    positions.push(...faceCentroid(mesh, face));
    const average = faceAttributeAverages(face);
    for (let corner = 0; corner < face.vertices.length; corner += 1) {
      const next = (corner + 1) % face.vertices.length;
      const attrs = repeatedAttributeFace(face, [corner, next]);
      for (const name of Object.keys(attrs.uv)) attrs.uv[name].push(cloneJson(average.uv[name]));
      for (const name of Object.keys(attrs.color)) attrs.color[name].push(cloneJson(average.color[name]));
      output.push({
        vertices: [face.vertices[corner], face.vertices[next], centerIndex],
        ...attrs,
        materialIndex: face.materialIndex,
        sourceFaceIndex: face.sourceFaceIndex,
      });
    }
  }
  const annotations = filterEdgeAnnotations(mesh, output);
  return flattenFaces(positions, output, annotations.sharpEdges, annotations.edgeCreases, mesh);
}

/** Insets selected faces by a relative factor while preserving every corner layer. */
export function insetEditableMeshFaces(recipe, command = {}) {
  const mesh = normalizeEditableMeshRecipe(recipe);
  const faces = faceRecords(mesh);
  const selection = new Set(selectedIndices(command.faceIndices ?? command.selection, faces.length, 'faceIndices'));
  if (command.thickness !== undefined) {
    throw new TypeError('insetFaces uses a dimensionless factor; absolute thickness requires evaluated surface distances.');
  }
  const factor = finiteNumber(command.factor ?? 0.2, 'factor', EPSILON, 1 - EPSILON);
  const selectedCornerCount = [...selection].reduce((sum, index) => sum + faces[index].vertices.length, 0);
  assertOutputBudget(
    mesh.positions.length / 3 + selectedCornerCount,
    faces.length + selectedCornerCount,
    mesh.cornerVertexIndices.length + selectedCornerCount * 4,
    'insetFaces',
  );
  const positions = [...mesh.positions];
  const output = [];
  for (let faceIndex = 0; faceIndex < faces.length; faceIndex += 1) {
    const face = faces[faceIndex];
    if (!selection.has(faceIndex)) {
      output.push(face);
      continue;
    }
    const centroid = faceCentroid(mesh, face);
    const average = faceAttributeAverages(face);
    const insetVertices = face.vertices.map((vertexIndex) => {
      const created = positions.length / 3;
      positions.push(...lerpVector(vertex(mesh, vertexIndex), centroid, factor));
      return created;
    });
    const insetUv = {};
    const insetColor = {};
    for (const [name, values] of Object.entries(face.uv)) {
      insetUv[name] = values.map(value => lerpVector(value, average.uv[name], factor));
    }
    for (const [name, values] of Object.entries(face.color)) {
      insetColor[name] = values.map(value => lerpVector(value, average.color[name], factor));
    }
    output.push({
      vertices: insetVertices,
      uv: insetUv,
      color: insetColor,
      materialIndex: face.materialIndex,
      sourceFaceIndex: face.sourceFaceIndex,
    });
    for (let corner = 0; corner < face.vertices.length; corner += 1) {
      const next = (corner + 1) % face.vertices.length;
      const uv = {};
      const color = {};
      for (const [name, values] of Object.entries(face.uv)) {
        uv[name] = [values[corner], values[next], insetUv[name][next], insetUv[name][corner]].map(cloneJson);
      }
      for (const [name, values] of Object.entries(face.color)) {
        color[name] = [values[corner], values[next], insetColor[name][next], insetColor[name][corner]].map(cloneJson);
      }
      output.push({
        vertices: [face.vertices[corner], face.vertices[next], insetVertices[next], insetVertices[corner]],
        uv,
        color,
        materialIndex: face.materialIndex,
        sourceFaceIndex: face.sourceFaceIndex,
      });
    }
  }
  const annotations = filterEdgeAnnotations(mesh, output);
  return flattenFaces(positions, output, annotations.sharpEdges, annotations.edgeCreases, mesh);
}

/**
 * Extrudes each selected polygon independently. Region extrusion is rejected
 * because resolving shared boundaries needs a separate region selection model.
 */
export function extrudeEditableMeshFaces(recipe, command = {}) {
  const mesh = normalizeEditableMeshRecipe(recipe);
  const faces = faceRecords(mesh);
  const selection = new Set(selectedIndices(command.faceIndices ?? command.selection, faces.length, 'faceIndices'));
  const mode = command.mode ?? 'individual';
  if (mode !== 'individual') throw new TypeError("extrudeFaces currently supports only mode 'individual'.");
  if (command.offset !== undefined && command.distance !== undefined) {
    throw new TypeError('extrudeFaces accepts offset or distance, not both.');
  }
  const sharedOffset = command.offset === undefined ? null : vector3(command.offset, 'offset');
  const distance = sharedOffset === null ? finiteNumber(command.distance ?? 0.1, 'distance') : null;
  const sideMaterialIndex = command.sideMaterialIndex === undefined
    ? null
    : integer(command.sideMaterialIndex, 'sideMaterialIndex', 0, MAX_MATERIAL_SLOTS_PER_MESH - 1);
  const selectedCornerCount = [...selection].reduce((sum, index) => sum + faces[index].vertices.length, 0);
  assertOutputBudget(
    mesh.positions.length / 3 + selectedCornerCount,
    faces.length + selectedCornerCount,
    mesh.cornerVertexIndices.length + selectedCornerCount * 4,
    'extrudeFaces',
  );
  const positions = [...mesh.positions];
  const output = [];
  const annotationsToAdd = { sharp: [], creases: [] };
  const sharpSet = new Set(mesh.sharpEdges.map(pair => edgeKey(...pair)));
  const creaseMap = new Map(mesh.edgeCreases.map(tuple => [edgeKey(tuple[0], tuple[1]), tuple[2]]));
  for (let faceIndex = 0; faceIndex < faces.length; faceIndex += 1) {
    const face = faces[faceIndex];
    if (!selection.has(faceIndex)) {
      output.push(face);
      continue;
    }
    const offset = sharedOffset ?? faceNormal(mesh, face).map(value => value * distance);
    const topVertices = face.vertices.map((vertexIndex) => {
      const created = positions.length / 3;
      positions.push(...vertex(mesh, vertexIndex).map((value, axis) => value + offset[axis]));
      return created;
    });
    output.push({ ...cloneJson(face), vertices: topVertices });
    for (let corner = 0; corner < face.vertices.length; corner += 1) {
      const next = (corner + 1) % face.vertices.length;
      const attrs = repeatedAttributeFace(face, [corner, next, next, corner]);
      output.push({
        vertices: [face.vertices[corner], face.vertices[next], topVertices[next], topVertices[corner]],
        ...attrs,
        materialIndex: sideMaterialIndex ?? face.materialIndex,
        sourceFaceIndex: face.sourceFaceIndex,
      });
      const originalKey = edgeKey(face.vertices[corner], face.vertices[next]);
      if (sharpSet.has(originalKey)) annotationsToAdd.sharp.push([topVertices[corner], topVertices[next]]);
      if (creaseMap.has(originalKey)) {
        annotationsToAdd.creases.push([topVertices[corner], topVertices[next], creaseMap.get(originalKey)]);
      }
    }
  }
  const annotations = filterEdgeAnnotations(mesh, output, annotationsToAdd);
  return flattenFaces(positions, output, annotations.sharpEdges, annotations.edgeCreases, mesh);
}

/** Deletes exact face indices and removes annotations for edges that disappear. */
export function deleteEditableMeshFaces(recipe, command = {}) {
  const mesh = normalizeEditableMeshRecipe(recipe);
  const faces = faceRecords(mesh);
  const selection = new Set(selectedIndices(command.faceIndices ?? command.selection, faces.length, 'faceIndices'));
  const output = faces.filter((_, faceIndex) => !selection.has(faceIndex));
  const annotations = filterEdgeAnnotations(mesh, output);
  return flattenFaces(mesh.positions, output, annotations.sharpEdges, annotations.edgeCreases, mesh);
}

function canonicalSelectedEdges(value, mesh) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('edges must be a non-empty array of exact vertex-index pairs.');
  }
  const incidence = edgeIncidence(mesh);
  const seen = new Set();
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const pair = value[index];
    if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError(`edges[${index}] must contain two indices.`);
    const first = integer(pair[0], `edges[${index}][0]`, 0, mesh.positions.length / 3 - 1);
    const second = integer(pair[1], `edges[${index}][1]`, 0, mesh.positions.length / 3 - 1);
    const key = edgeKey(first, second);
    if (seen.has(key)) throw new RangeError(`edges contains duplicate edge ${key}.`);
    if (!incidence.has(key)) throw new RangeError(`edges[${index}] does not reference a mesh edge.`);
    seen.add(key);
    result.push(edgeTuple(first, second));
  }
  return { edges: result, incidence };
}

function bevelEndpointPatch(sourceFaces, incidence, endpoint, sideFaceIndices, edgeLabel) {
  const incidentFaces = sourceFaces
    .map((face, faceIndex) => face.vertices.includes(endpoint) ? faceIndex : null)
    .filter(faceIndex => faceIndex !== null);
  if (incidentFaces.length !== 3) {
    throw new StudioError(
      'bevel_endpoint_fan_unsupported',
      `bevelEdges edge ${edgeLabel} endpoint ${endpoint} requires a closed three-face manifold fan; received ${incidentFaces.length} incident faces.`,
      { edge: edgeLabel, endpoint, incidentFaceCount: incidentFaces.length },
    );
  }
  const patchFaces = incidentFaces.filter(faceIndex => !sideFaceIndices.has(faceIndex));
  if (patchFaces.length !== 1) {
    throw new StudioError(
      'bevel_endpoint_fan_unsupported',
      `bevelEdges edge ${edgeLabel} endpoint ${endpoint} does not have one exact endpoint patch face.`,
      { edge: edgeLabel, endpoint, incidentFaces },
    );
  }
  const faceIndex = patchFaces[0];
  const face = sourceFaces[faceIndex];
  const cornerIndex = face.vertices.indexOf(endpoint);
  const previousNeighbor = face.vertices[(cornerIndex - 1 + face.vertices.length) % face.vertices.length];
  const nextNeighbor = face.vertices[(cornerIndex + 1) % face.vertices.length];
  const sideByNeighbor = new Map();
  for (const neighbor of [previousNeighbor, nextNeighbor]) {
    const uses = incidence.get(edgeKey(endpoint, neighbor)) ?? [];
    const sideUses = uses.filter(use => sideFaceIndices.has(use.faceIndex));
    if (uses.length !== 2 || sideUses.length !== 1 || !uses.some(use => use.faceIndex === faceIndex)) {
      throw new StudioError(
        'bevel_endpoint_fan_unsupported',
        `bevelEdges endpoint edge ${edgeKey(endpoint, neighbor)} is not a closed two-manifold connection between a side and patch face.`,
        { edge: edgeLabel, endpoint, endpointEdge: edgeKey(endpoint, neighbor) },
      );
    }
    sideByNeighbor.set(neighbor, sideUses[0].faceIndex);
  }
  if (new Set(sideByNeighbor.values()).size !== 2) {
    throw new StudioError(
      'bevel_endpoint_fan_unsupported',
      `bevelEdges edge ${edgeLabel} endpoint ${endpoint} cannot map both patch edges to distinct side faces.`,
      { edge: edgeLabel, endpoint },
    );
  }
  return { endpoint, faceIndex, cornerIndex, previousNeighbor, nextNeighbor, sideByNeighbor };
}

function patchedBevelEndpointFace(face, patch, sideRecords, factor) {
  const previousSide = sideRecords.get(patch.sideByNeighbor.get(patch.previousNeighbor));
  const nextSide = sideRecords.get(patch.sideByNeighbor.get(patch.nextNeighbor));
  const previousVertex = previousSide?.byOriginal.get(patch.endpoint);
  const nextVertex = nextSide?.byOriginal.get(patch.endpoint);
  if (
    !previousVertex
    || !nextVertex
    || previousVertex.otherNeighbor !== patch.previousNeighbor
    || nextVertex.otherNeighbor !== patch.nextNeighbor
  ) {
    throw new StudioError(
      'bevel_endpoint_fan_unsupported',
      `bevelEdges endpoint ${patch.endpoint} side records do not match its patch-face boundary.`,
      { endpoint: patch.endpoint, faceIndex: patch.faceIndex },
    );
  }
  const before = Array.from({ length: patch.cornerIndex }, (_, index) => index);
  const after = Array.from(
    { length: face.vertices.length - patch.cornerIndex - 1 },
    (_, index) => patch.cornerIndex + index + 1,
  );
  const uv = {};
  const color = {};
  for (const [name, values] of Object.entries(face.uv)) {
    const current = values[patch.cornerIndex];
    uv[name] = [
      ...before.map(index => cloneJson(values[index])),
      lerpVector(current, values[(patch.cornerIndex - 1 + values.length) % values.length], factor),
      lerpVector(current, values[(patch.cornerIndex + 1) % values.length], factor),
      ...after.map(index => cloneJson(values[index])),
    ];
  }
  for (const [name, values] of Object.entries(face.color)) {
    const current = values[patch.cornerIndex];
    color[name] = [
      ...before.map(index => cloneJson(values[index])),
      lerpVector(current, values[(patch.cornerIndex - 1 + values.length) % values.length], factor),
      lerpVector(current, values[(patch.cornerIndex + 1) % values.length], factor),
      ...after.map(index => cloneJson(values[index])),
    ];
  }
  return {
    vertices: [
      ...before.map(index => face.vertices[index]),
      previousVertex.vertex,
      nextVertex.vertex,
      ...after.map(index => face.vertices[index]),
    ],
    uv,
    color,
    materialIndex: face.materialIndex,
    sourceFaceIndex: face.sourceFaceIndex,
  };
}

function compactBevelResult(positions, faces, annotations, layerSource) {
  const used = [...new Set(faces.flatMap(face => face.vertices))].sort((a, b) => a - b);
  const remap = new Map(used.map((oldIndex, newIndex) => [oldIndex, newIndex]));
  const compactPositions = used.flatMap(index => positions.slice(index * 3, index * 3 + 3));
  const compactFaces = faces.map(face => ({
    ...face,
    vertices: face.vertices.map(index => remap.get(index)),
  }));
  const sharpEdges = annotations.sharpEdges.map(([first, second]) => [remap.get(first), remap.get(second)]);
  const edgeCreases = annotations.edgeCreases.map(([first, second, weight]) => [
    remap.get(first), remap.get(second), weight,
  ]);
  return flattenFaces(compactPositions, compactFaces, sharpEdges, edgeCreases, layerSource);
}

/**
 * Chamfers pairwise-disjoint edges whose endpoints have closed, three-face
 * manifold fans. Endpoint patch faces receive two new corners, so the result
 * remains watertight instead of leaving cracks around the removed endpoints.
 */
export function bevelEditableMeshEdges(recipe, command = {}) {
  const mesh = normalizeEditableMeshRecipe(recipe);
  if (command.width !== undefined) {
    throw new TypeError('bevelEdges uses a relative factor; absolute width requires evaluated offset intersections.');
  }
  const factor = finiteNumber(command.factor ?? 0.1, 'factor', EPSILON, 0.49);
  const { edges, incidence } = canonicalSelectedEdges(command.edges ?? command.edgeVertexIndices, mesh);
  assertOutputBudget(
    mesh.positions.length / 3 + edges.length * 4,
    mesh.faceOffsets.length - 1 + edges.length,
    mesh.cornerVertexIndices.length + edges.length * 6,
    'bevelEdges',
  );
  const occupiedVertices = new Set();
  const touchedFaces = new Set();
  const sourceFaces = faceRecords(mesh);
  const endpointPatches = new Map();
  for (const [first, second] of edges) {
    if (occupiedVertices.has(first) || occupiedVertices.has(second)) {
      throw new RangeError('bevelEdges requires pairwise-disjoint selected edges.');
    }
    occupiedVertices.add(first);
    occupiedVertices.add(second);
    const key = edgeKey(first, second);
    const uses = incidence.get(key);
    if (uses.length !== 2) throw new RangeError(`bevelEdges edge ${key} must have exactly two incident faces.`);
    const sideFaceIndices = new Set(uses.map(use => use.faceIndex));
    for (const use of uses) {
      if (touchedFaces.has(use.faceIndex)) throw new RangeError('bevelEdges currently supports at most one selected edge per face.');
      touchedFaces.add(use.faceIndex);
    }
    for (const endpoint of [first, second]) {
      const patch = bevelEndpointPatch(sourceFaces, incidence, endpoint, sideFaceIndices, key);
      if (touchedFaces.has(patch.faceIndex)) {
        throw new StudioError(
          'bevel_endpoint_fan_unsupported',
          `bevelEdges patch face ${patch.faceIndex} is shared by multiple selected edge regions.`,
          { edge: key, endpoint, faceIndex: patch.faceIndex },
        );
      }
      touchedFaces.add(patch.faceIndex);
      endpointPatches.set(endpoint, patch);
    }
  }

  const positions = [...mesh.positions];
  const replacements = new Map();
  const bevelFaces = [];
  const additions = { sharp: [], creases: [] };
  const sharpSet = new Set(mesh.sharpEdges.map(pair => edgeKey(...pair)));
  const creaseMap = new Map(mesh.edgeCreases.map(tuple => [edgeKey(tuple[0], tuple[1]), tuple[2]]));

  for (const [edgeFirst, edgeSecond] of edges) {
    const key = edgeKey(edgeFirst, edgeSecond);
    const sides = [];
    const sideRecords = new Map();
    for (const use of incidence.get(key)) {
      const face = sourceFaces[use.faceIndex];
      const orderedCornerIndices = Array.from(
        { length: face.vertices.length },
        (_, offset) => (use.cornerIndex + offset) % face.vertices.length,
      );
      const startOriginal = face.vertices[orderedCornerIndices[0]];
      const endOriginal = face.vertices[orderedCornerIndices[1]];
      const startOtherCorner = orderedCornerIndices.at(-1);
      const endOtherCorner = orderedCornerIndices[2];
      const startOther = face.vertices[startOtherCorner];
      const endOther = face.vertices[endOtherCorner];
      const startNew = positions.length / 3;
      positions.push(...lerpVector(vertex(mesh, startOriginal), vertex(mesh, startOther), factor));
      const endNew = positions.length / 3;
      positions.push(...lerpVector(vertex(mesh, endOriginal), vertex(mesh, endOther), factor));
      const startUv = {};
      const endUv = {};
      const startColor = {};
      const endColor = {};
      for (const [name, values] of Object.entries(face.uv)) {
        startUv[name] = lerpVector(values[orderedCornerIndices[0]], values[startOtherCorner], factor);
        endUv[name] = lerpVector(values[orderedCornerIndices[1]], values[endOtherCorner], factor);
      }
      for (const [name, values] of Object.entries(face.color)) {
        startColor[name] = lerpVector(values[orderedCornerIndices[0]], values[startOtherCorner], factor);
        endColor[name] = lerpVector(values[orderedCornerIndices[1]], values[endOtherCorner], factor);
      }
      const uv = {};
      const color = {};
      for (const name of Object.keys(face.uv)) {
        uv[name] = [startUv[name], endUv[name], ...orderedCornerIndices.slice(2).map(index => face.uv[name][index])].map(cloneJson);
      }
      for (const name of Object.keys(face.color)) {
        color[name] = [startColor[name], endColor[name], ...orderedCornerIndices.slice(2).map(index => face.color[name][index])].map(cloneJson);
      }
      replacements.set(use.faceIndex, {
        vertices: [startNew, endNew, ...orderedCornerIndices.slice(2).map(index => face.vertices[index])],
        uv,
        color,
        materialIndex: face.materialIndex,
        sourceFaceIndex: face.sourceFaceIndex,
      });
      const byOriginal = new Map([
        [startOriginal, { vertex: startNew, uv: startUv, color: startColor, otherNeighbor: startOther }],
        [endOriginal, { vertex: endNew, uv: endUv, color: endColor, otherNeighbor: endOther }],
      ]);
      const sideRecord = { face, faceIndex: use.faceIndex, byOriginal };
      sides.push(sideRecord);
      sideRecords.set(use.faceIndex, sideRecord);
      if (sharpSet.has(key)) additions.sharp.push([startNew, endNew]);
      if (creaseMap.has(key)) additions.creases.push([startNew, endNew, creaseMap.get(key)]);
      for (const [original, created, other] of [
        [startOriginal, startNew, startOther],
        [endOriginal, endNew, endOther],
      ]) {
        const originalEdge = edgeKey(original, other);
        if (sharpSet.has(originalEdge)) additions.sharp.push([created, other]);
        if (creaseMap.has(originalEdge)) additions.creases.push([created, other, creaseMap.get(originalEdge)]);
      }
    }
    const firstSide = sides[0];
    const secondSide = sides[1];
    const a1 = firstSide.byOriginal.get(edgeFirst);
    const b1 = firstSide.byOriginal.get(edgeSecond);
    const a2 = secondSide.byOriginal.get(edgeFirst);
    const b2 = secondSide.byOriginal.get(edgeSecond);
    const uv = {};
    const color = {};
    for (const name of Object.keys(firstSide.face.uv)) {
      uv[name] = [a1.uv[name], b1.uv[name], b2.uv[name], a2.uv[name]].map(cloneJson);
    }
    for (const name of Object.keys(firstSide.face.color)) {
      color[name] = [a1.color[name], b1.color[name], b2.color[name], a2.color[name]].map(cloneJson);
    }
    bevelFaces.push({
      vertices: [a1.vertex, b1.vertex, b2.vertex, a2.vertex],
      uv,
      color,
      materialIndex: command.materialIndex === undefined
        ? firstSide.face.materialIndex
        : integer(command.materialIndex, 'materialIndex', 0, MAX_MATERIAL_SLOTS_PER_MESH - 1),
      sourceFaceIndex: firstSide.face.sourceFaceIndex,
    });
    for (const endpoint of [edgeFirst, edgeSecond]) {
      const patch = endpointPatches.get(endpoint);
      replacements.set(
        patch.faceIndex,
        patchedBevelEndpointFace(sourceFaces[patch.faceIndex], patch, sideRecords, factor),
      );
    }
  }
  const output = sourceFaces.map((face, index) => replacements.get(index) ?? face).concat(bevelFaces);
  const annotations = filterEdgeAnnotations(mesh, output, additions);
  return compactBevelResult(positions, output, annotations, mesh);
}

function remappedAnnotations(mesh, vertexRemap, compactRemap, faces) {
  const remapEdge = (first, second) => {
    const mergedFirst = vertexRemap[first];
    const mergedSecond = vertexRemap[second];
    if (mergedFirst === mergedSecond || !compactRemap.has(mergedFirst) || !compactRemap.has(mergedSecond)) return null;
    return edgeTuple(compactRemap.get(mergedFirst), compactRemap.get(mergedSecond));
  };
  const sharp = [];
  for (const [first, second] of mesh.sharpEdges) {
    const pair = remapEdge(first, second);
    if (pair) sharp.push(pair);
  }
  const creases = [];
  for (const [first, second, weight] of mesh.edgeCreases) {
    const pair = remapEdge(first, second);
    if (pair) creases.push([...pair, weight]);
  }
  return filterEdgeAnnotations(
    { sharpEdges: sharp, edgeCreases: creases },
    faces,
  );
}

function collapsedMergedFace(face, vertexRemap, targetVertexIndex) {
  const corners = face.vertices.map((originalVertexIndex, cornerIndex) => ({
    originalVertexIndex,
    vertexIndex: vertexRemap[originalVertexIndex],
    uv: Object.fromEntries(Object.entries(face.uv).map(([name, values]) => [name, cloneJson(values[cornerIndex])])),
    color: Object.fromEntries(Object.entries(face.color).map(([name, values]) => [name, cloneJson(values[cornerIndex])])),
  }));
  const preferTargetCorner = (first, second) => (
    second.originalVertexIndex === targetVertexIndex && first.originalVertexIndex !== targetVertexIndex
      ? second
      : first
  );
  const collapsed = [];
  for (const corner of corners) {
    const previous = collapsed.at(-1);
    if (previous?.vertexIndex === corner.vertexIndex) {
      collapsed[collapsed.length - 1] = preferTargetCorner(previous, corner);
    } else {
      collapsed.push(corner);
    }
  }
  while (collapsed.length > 1 && collapsed[0].vertexIndex === collapsed.at(-1).vertexIndex) {
    collapsed[0] = preferTargetCorner(collapsed[0], collapsed.at(-1));
    collapsed.pop();
  }
  if (collapsed.length < 3) return null;
  const vertices = collapsed.map(corner => corner.vertexIndex);
  if (new Set(vertices).size !== vertices.length) return null;
  return {
    ...face,
    vertices,
    uv: Object.fromEntries(Object.keys(face.uv).map(name => [
      name,
      collapsed.map(corner => corner.uv[name]),
    ])),
    color: Object.fromEntries(Object.keys(face.color).map(name => [
      name,
      collapsed.map(corner => corner.color[name]),
    ])),
  };
}

/** Merges an exact vertex set while preserving per-corner seam attributes. */
export function mergeEditableMeshVertices(recipe, command = {}) {
  const mesh = normalizeEditableMeshRecipe(recipe);
  if (command.tolerance !== undefined) {
    throw new TypeError('mergeVertices requires an exact vertexIndices set; tolerance welding is a separate spatial operation.');
  }
  const vertexCount = mesh.positions.length / 3;
  const selection = selectedIndices(command.vertexIndices ?? command.selection, vertexCount, 'vertexIndices', { minimum: 2 });
  const selectionSet = new Set(selection);
  const target = command.targetVertexIndex === undefined
    ? selection.reduce((minimum, value) => Math.min(minimum, value), Number.POSITIVE_INFINITY)
    : integer(command.targetVertexIndex, 'targetVertexIndex', 0, vertexCount - 1);
  if (!selectionSet.has(target)) throw new RangeError('targetVertexIndex must be included in vertexIndices.');
  const positionMode = command.position ?? 'average';
  if (!['average', 'target'].includes(positionMode)) throw new TypeError("position must be 'average' or 'target'.");
  const mergedPosition = positionMode === 'average'
    ? averageVectors(selection.map(index => vertex(mesh, index)), 3)
    : vertex(mesh, target);
  const vertexRemap = Array.from({ length: vertexCount }, (_, index) => selectionSet.has(index) ? target : index);
  const faces = [];
  for (const face of faceRecords(mesh)) {
    const collapsed = collapsedMergedFace(face, vertexRemap, target);
    if (collapsed) faces.push(collapsed);
  }
  const used = [...new Set(faces.flatMap(face => face.vertices))].sort((a, b) => a - b);
  const compactRemap = new Map(used.map((oldIndex, newIndex) => [oldIndex, newIndex]));
  const positions = [];
  for (const oldIndex of used) positions.push(...(oldIndex === target ? mergedPosition : vertex(mesh, oldIndex)));
  const compactFaces = faces.map(face => ({
    ...face,
    vertices: face.vertices.map(index => compactRemap.get(index)),
  }));
  const annotations = remappedAnnotations(mesh, vertexRemap, compactRemap, compactFaces);
  return flattenFaces(positions, compactFaces, annotations.sharpEdges, annotations.edgeCreases, mesh);
}

/** Applies one serializable editable-mesh command. */
export function applyEditableMeshEdit(recipe, command) {
  if (!isPlainRecord(command)) throw new TypeError('Editable mesh edit command must be a plain object.');
  assertJsonValue(command, 'command');
  const allowed = EDIT_COMMAND_KEYS.get(command.type);
  if (!allowed) throw new TypeError(`Unsupported editable mesh edit command: ${String(command.type)}.`);
  assertKnownKeys(command, allowed, `command ${command.type}`);
  if (command.expectedTopologyHash !== undefined) {
    if (typeof command.expectedTopologyHash !== 'string' || !/^[a-f0-9]{64}$/u.test(command.expectedTopologyHash)) {
      throw new TypeError('expectedTopologyHash must be a lowercase SHA-256 hash.');
    }
    const actualTopologyHash = editableMeshTopologyHash(recipe);
    if (actualTopologyHash !== command.expectedTopologyHash) {
      throw new RangeError(`Editable mesh topology changed: expected ${command.expectedTopologyHash}, received ${actualTopologyHash}.`);
    }
  }
  switch (command.type) {
    case 'move':
    case 'moveVertices': return moveEditableMeshVertices(recipe, command);
    case 'scale':
    case 'scaleVertices': return scaleEditableMeshVertices(recipe, command);
    case 'rotate':
    case 'rotateVertices': return rotateEditableMeshVertices(recipe, command);
    case 'smooth':
    case 'smoothVertices': return smoothEditableMeshVertices(recipe, command);
    case 'subdivideFaces': return subdivideEditableMeshFaces(recipe, command);
    case 'insetFaces': return insetEditableMeshFaces(recipe, command);
    case 'extrudeFaces': return extrudeEditableMeshFaces(recipe, command);
    case 'bevelEdges': return bevelEditableMeshEdges(recipe, command);
    case 'deleteFaces': return deleteEditableMeshFaces(recipe, command);
    case 'mergeVertices': return mergeEditableMeshVertices(recipe, command);
    default: throw new TypeError(`Unsupported editable mesh edit command: ${String(command.type)}.`);
  }
}

/** Applies a bounded command sequence without mutating the source recipe. */
export function applyEditableMeshEdits(recipe, commands) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new TypeError('commands must be a non-empty array.');
  }
  if (commands.length > MAX_EDIT_COMMANDS) {
    throw new RangeError(`commands cannot contain more than ${MAX_EDIT_COMMANDS} entries.`);
  }
  return commands.reduce((mesh, command) => applyEditableMeshEdit(mesh, command), recipe);
}

function projectedFace(mesh, face) {
  const normal = faceNormal(mesh, face);
  const dropAxis = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
  return face.vertices.map((vertexIndex, cornerIndex) => {
    const point = vertex(mesh, vertexIndex);
    const projected = dropAxis === 0 ? [point[1], point[2]] : dropAxis === 1 ? [point[0], point[2]] : [point[0], point[1]];
    return { projected, sourceCornerIndex: cornerIndex };
  });
}

function signedArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index].projected;
    const next = points[(index + 1) % points.length].projected;
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

function cross2d(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointInTriangle(point, a, b, c, orientation) {
  const first = cross2d(a, b, point) * orientation;
  const second = cross2d(b, c, point) * orientation;
  const third = cross2d(c, a, point) * orientation;
  return first >= -EPSILON && second >= -EPSILON && third >= -EPSILON;
}

function spendTriangulationWork(work, amount, faceIndex) {
  work.used += amount;
  if (work.used > work.limit) {
    throw new RangeError(
      `Triangulating face ${faceIndex} exceeded the explicit ${work.limit}-step work budget.`,
    );
  }
}

function triangulateFace(mesh, face, work) {
  if (face.vertices.length === 3) {
    spendTriangulationWork(work, 1, face.sourceFaceIndex);
    return [[0, 1, 2]];
  }
  spendTriangulationWork(work, face.vertices.length, face.sourceFaceIndex);
  const projected = projectedFace(mesh, face);
  const area = signedArea(projected);
  if (Math.abs(area) <= EPSILON) throw new RangeError(`Face ${face.sourceFaceIndex} has a degenerate projection.`);
  const orientation = Math.sign(area);
  const remaining = [...projected];
  const triangles = [];
  while (remaining.length > 3) {
    let clipped = false;
    for (let cursor = 0; cursor < remaining.length; cursor += 1) {
      spendTriangulationWork(work, 1, face.sourceFaceIndex);
      const previous = remaining[(cursor - 1 + remaining.length) % remaining.length];
      const current = remaining[cursor];
      const next = remaining[(cursor + 1) % remaining.length];
      if (cross2d(previous.projected, current.projected, next.projected) * orientation <= EPSILON) continue;
      let containsPoint = false;
      for (let index = 0; index < remaining.length; index += 1) {
        if (
          index === cursor
          || index === (cursor - 1 + remaining.length) % remaining.length
          || index === (cursor + 1) % remaining.length
        ) continue;
        spendTriangulationWork(work, 1, face.sourceFaceIndex);
        if (pointInTriangle(
          remaining[index].projected,
          previous.projected,
          current.projected,
          next.projected,
          orientation,
        )) {
          containsPoint = true;
          break;
        }
      }
      if (containsPoint) continue;
      triangles.push([previous.sourceCornerIndex, current.sourceCornerIndex, next.sourceCornerIndex]);
      remaining.splice(cursor, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      throw new RangeError(`Face ${face.sourceFaceIndex} cannot be deterministically triangulated; it may self-intersect.`);
    }
  }
  triangles.push(remaining.map(entry => entry.sourceCornerIndex));
  return triangles;
}

function normalizedDirection(from, to) {
  const direction = to.map((value, axis) => value - from[axis]);
  const length = Math.hypot(...direction);
  if (length <= EPSILON) throw new RangeError('A polygon corner has a zero-length incident edge.');
  return direction.map(value => value / length);
}

function smoothCornerNormals(mesh, faces) {
  const cornerCount = mesh.cornerVertexIndices.length;
  const parent = Array.from({ length: cornerCount }, (_, index) => index);
  const find = (value) => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== value) {
      const next = parent[value];
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const union = (first, second) => {
    const firstRoot = find(first);
    const secondRoot = find(second);
    if (firstRoot !== secondRoot) parent[Math.max(firstRoot, secondRoot)] = Math.min(firstRoot, secondRoot);
  };
  const sharp = new Set(mesh.sharpEdges.map(pair => edgeKey(pair[0], pair[1])));
  for (const [key, uses] of edgeIncidence(mesh)) {
    if (sharp.has(key) || uses.length < 2) continue;
    const endpoints = key.split(':').map(Number);
    for (const endpoint of endpoints) {
      const corners = uses.map((use) => {
        const face = faces[use.faceIndex];
        const localCorner = use.first === endpoint
          ? use.cornerIndex
          : (use.cornerIndex + 1) % face.vertices.length;
        return mesh.faceOffsets[use.faceIndex] + localCorner;
      });
      for (let index = 1; index < corners.length; index += 1) union(corners[0], corners[index]);
    }
  }

  const weighted = Array.from({ length: cornerCount }, () => [0, 0, 0]);
  const faceNormals = faces.map(face => faceNormal(mesh, face));
  for (let faceIndex = 0; faceIndex < faces.length; faceIndex += 1) {
    const face = faces[faceIndex];
    for (let localCorner = 0; localCorner < face.vertices.length; localCorner += 1) {
      const previous = vertex(mesh, face.vertices[(localCorner - 1 + face.vertices.length) % face.vertices.length]);
      const current = vertex(mesh, face.vertices[localCorner]);
      const next = vertex(mesh, face.vertices[(localCorner + 1) % face.vertices.length]);
      const first = normalizedDirection(current, previous);
      const second = normalizedDirection(current, next);
      const angle = Math.acos(Math.max(-1, Math.min(1, first.reduce(
        (sum, value, axis) => sum + value * second[axis],
        0,
      ))));
      const root = find(mesh.faceOffsets[faceIndex] + localCorner);
      for (let axis = 0; axis < 3; axis += 1) weighted[root][axis] += faceNormals[faceIndex][axis] * angle;
    }
  }

  const result = [];
  for (let cornerIndex = 0; cornerIndex < cornerCount; cornerIndex += 1) {
    const value = weighted[find(cornerIndex)];
    const length = Math.hypot(...value);
    if (length <= EPSILON) {
      let faceIndex = 0;
      while (mesh.faceOffsets[faceIndex + 1] <= cornerIndex) faceIndex += 1;
      result.push(...faceNormals[faceIndex]);
    } else {
      result.push(...value.map(component => component / length));
    }
  }
  return result;
}

/**
 * Produces an indexedMesh runtime recipe with triangle-corner vertices so UV
 * and color seams remain exact. The parallel arrays retain face/material
 * provenance for compilers that assign material groups.
 */
export function triangulateEditableMesh(recipe, options = {}) {
  if (!isPlainRecord(options)) throw new TypeError('Triangulation options must be a plain object.');
  assertKnownKeys(options, new Set(['uvLayer', 'colorLayer', 'triangulationWorkBudget']), 'triangulation options');
  const mesh = normalizeEditableMeshRecipe(recipe);
  const faces = faceRecords(mesh);
  if (faces.length === 0) throw new RangeError('An empty editable mesh cannot be compiled to indexed triangles.');
  const triangleCount = faces.reduce((sum, face) => sum + face.vertices.length - 2, 0);
  const compiledVertexCount = triangleCount * 3;
  if (triangleCount > MAX_COMPILED_TRIANGLES || compiledVertexCount > MAX_COMPILED_VERTICES) {
    throw new RangeError(
      `Editable mesh compiles to ${triangleCount} triangles and ${compiledVertexCount} seam-preserving vertices; `
      + `the limits are ${MAX_COMPILED_TRIANGLES} triangles and ${MAX_COMPILED_VERTICES} vertices.`,
    );
  }
  const uvLayer = options.uvLayer === undefined ? mesh.activeUvLayer : options.uvLayer;
  const colorLayer = options.colorLayer === undefined ? mesh.activeColorLayer : options.colorLayer;
  if (uvLayer !== null && !Object.hasOwn(mesh.uvLayers, uvLayer)) throw new RangeError(`Unknown UV layer: ${uvLayer}.`);
  if (colorLayer !== null && !Object.hasOwn(mesh.colorLayers, colorLayer)) throw new RangeError(`Unknown color layer: ${colorLayer}.`);
  const work = {
    limit: integer(
      options.triangulationWorkBudget ?? MAX_TRIANGULATION_WORK,
      'triangulationWorkBudget',
      1,
      MAX_TRIANGULATION_WORK,
    ),
    used: 0,
  };
  const cornerNormals = smoothCornerNormals(mesh, faces);
  const positions = [];
  const indices = [];
  const normals = [];
  const uvs = uvLayer === null ? null : [];
  const colors = colorLayer === null ? null : [];
  const sourceCornerIndices = [];
  const triangleFaceIndices = [];
  const triangleMaterialIndices = [];
  for (let faceIndex = 0; faceIndex < faces.length; faceIndex += 1) {
    const face = faces[faceIndex];
    const faceStart = mesh.faceOffsets[faceIndex];
    for (const triangle of triangulateFace(mesh, face, work)) {
      triangleFaceIndices.push(faceIndex);
      triangleMaterialIndices.push(face.materialIndex);
      for (const localCorner of triangle) {
        const runtimeVertex = positions.length / 3;
        positions.push(...vertex(mesh, face.vertices[localCorner]));
        normals.push(...cornerNormals.slice((faceStart + localCorner) * 3, (faceStart + localCorner) * 3 + 3));
        indices.push(runtimeVertex);
        sourceCornerIndices.push(faceStart + localCorner);
        if (uvs !== null) uvs.push(...face.uv[uvLayer][localCorner]);
        if (colors !== null) colors.push(...face.color[colorLayer][localCorner]);
      }
    }
  }
  const runtimeRecipe = { kind: 'indexedMesh', positions, indices, normals };
  if (uvs !== null) runtimeRecipe.uvs = uvs;
  if (colors !== null) runtimeRecipe.colors = colors;
  return {
    recipe: runtimeRecipe,
    sourceCornerIndices,
    triangleFaceIndices,
    triangleMaterialIndices,
    topologyHash: editableMeshTopologyHash(mesh),
    activeUvLayer: uvLayer,
    activeColorLayer: colorLayer,
    triangulationWork: work.used,
  };
}

export const computeEditableMeshTopologyHash = editableMeshTopologyHash;
export const compileEditableMeshToIndexedMesh = triangulateEditableMesh;
