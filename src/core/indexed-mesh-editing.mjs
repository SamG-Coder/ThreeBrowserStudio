import { assertJsonValue, cloneJson, isPlainRecord } from './util.mjs';

const MAX_COORDINATE = 1_000_000;
const MAX_VERTICES = 1_000_000;
const MAX_TRIANGLES = 2_000_000;
const MAX_SMOOTH_ITERATIONS = 100;
const MIN_WELD_TOLERANCE = 1e-9;
const DEFAULT_WELD_TOLERANCE = 1e-6;

export const INDEXED_MESH_LIMITS = Object.freeze({
  maxCoordinate: MAX_COORDINATE,
  maxVertices: MAX_VERTICES,
  maxTriangles: MAX_TRIANGLES,
  maxSmoothIterations: MAX_SMOOTH_ITERATIONS,
  minWeldTolerance: MIN_WELD_TOLERANCE,
});

function finiteBoundedNumber(value, label, minimum = -MAX_COORDINATE, maximum = MAX_COORDINATE) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be a finite number.`);
  if (value < minimum || value > maximum) {
    throw new RangeError(`${label} must be from ${minimum} to ${maximum}.`);
  }
  return value;
}

function finiteVector3(value, label) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError(`${label} must contain three finite numbers.`);
  }
  return value.map((component, index) => finiteBoundedNumber(component, `${label}[${index}]`));
}

function validateNumberArray(value, label, { exactLength, maximumLength } = {}) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  if (exactLength !== undefined && value.length !== exactLength) {
    throw new RangeError(`${label} must contain exactly ${exactLength} numbers.`);
  }
  if (maximumLength !== undefined && value.length > maximumLength) {
    throw new RangeError(`${label} exceeds its array budget of ${maximumLength}.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    finiteBoundedNumber(value[index], `${label}[${index}]`);
  }
}

function validateCanonicalRecipe(recipe) {
  if (!isPlainRecord(recipe)) throw new TypeError('Indexed mesh recipe must be a plain object.');
  assertJsonValue(recipe, 'recipe');
  if (recipe.kind !== 'indexedMesh') {
    throw new TypeError("Indexed mesh recipe kind must be 'indexedMesh'.");
  }

  validateNumberArray(recipe.positions, 'positions', { maximumLength: MAX_VERTICES * 3 });
  if (recipe.positions.length < 9 || recipe.positions.length % 3 !== 0) {
    throw new RangeError('positions must contain at least three vertices and be divisible by three.');
  }
  const vertexCount = recipe.positions.length / 3;

  if (!Array.isArray(recipe.indices)) throw new TypeError('indices must be an array.');
  if (recipe.indices.length < 3 || recipe.indices.length % 3 !== 0) {
    throw new RangeError('indices must contain indexed triangles and be divisible by three.');
  }
  if (recipe.indices.length > MAX_TRIANGLES * 3) {
    throw new RangeError(`indices exceeds its array budget of ${MAX_TRIANGLES * 3}.`);
  }
  for (let index = 0; index < recipe.indices.length; index += 1) {
    const vertexIndex = recipe.indices[index];
    if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= vertexCount) {
      throw new RangeError(`indices[${index}] must be an integer from 0 to ${vertexCount - 1}.`);
    }
  }

  if (recipe.normals !== undefined) {
    validateNumberArray(recipe.normals, 'normals', { exactLength: recipe.positions.length });
  }
  if (recipe.uvs !== undefined) {
    validateNumberArray(recipe.uvs, 'uvs', { exactLength: vertexCount * 2 });
  }
  if (recipe.colors !== undefined) {
    const validColorLength = recipe.colors.length === vertexCount * 3
      || recipe.colors.length === vertexCount * 4;
    if (!validColorLength) {
      throw new RangeError('colors must contain three or four numbers per vertex.');
    }
    validateNumberArray(recipe.colors, 'colors');
  }
  if (recipe.computeNormals !== undefined && typeof recipe.computeNormals !== 'boolean') {
    throw new TypeError('computeNormals must be a boolean when provided.');
  }

  return vertexCount;
}

/** Validates and clones a canonical indexedMesh geometry recipe. */
export function validateIndexedMeshRecipe(recipe) {
  validateCanonicalRecipe(recipe);
  return cloneJson(recipe);
}

function vertexSelection(options, vertexCount, { optional = false } = {}) {
  const source = options?.vertexIndices ?? options?.selection ?? options?.indices;
  if (source === 'all') {
    return Array.from({ length: vertexCount }, (_, index) => index);
  }
  if (source === undefined && optional) {
    return Array.from({ length: vertexCount }, (_, index) => index);
  }
  if (!Array.isArray(source) || source.length === 0) {
    throw new TypeError("vertexIndices must be a non-empty array, or selection must be 'all'.");
  }
  if (source.length > vertexCount) {
    throw new RangeError(`vertexIndices cannot contain more than ${vertexCount} entries.`);
  }
  const selected = [];
  const seen = new Set();
  for (let index = 0; index < source.length; index += 1) {
    const vertexIndex = source[index];
    if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= vertexCount) {
      throw new RangeError(`vertexIndices[${index}] must be an integer from 0 to ${vertexCount - 1}.`);
    }
    if (seen.has(vertexIndex)) throw new RangeError(`vertexIndices contains duplicate index ${vertexIndex}.`);
    seen.add(vertexIndex);
    selected.push(vertexIndex);
  }
  return selected;
}

function vertexCentroid(positions, selection) {
  const centroid = [0, 0, 0];
  for (const vertexIndex of selection) {
    const offset = vertexIndex * 3;
    centroid[0] += positions[offset];
    centroid[1] += positions[offset + 1];
    centroid[2] += positions[offset + 2];
  }
  return centroid.map(component => component / selection.length);
}

function editedPositions(mesh, selection, edit) {
  const positions = [...mesh.positions];
  let changed = false;
  for (const vertexIndex of selection) {
    const offset = vertexIndex * 3;
    const before = positions.slice(offset, offset + 3);
    const after = edit(before, vertexIndex);
    const validated = finiteVector3(after, `result.positions[${vertexIndex}]`);
    for (let axis = 0; axis < 3; axis += 1) {
      if (!Object.is(validated[axis], before[axis])) changed = true;
      positions[offset + axis] = validated[axis];
    }
  }
  mesh.positions = positions;
  if (changed) delete mesh.normals;
  return mesh;
}

/** Moves selected vertices by an XYZ offset. */
export function moveVertices(recipe, options = {}) {
  const mesh = validateIndexedMeshRecipe(recipe);
  const selection = vertexSelection(options, mesh.positions.length / 3);
  const offset = finiteVector3(options.offset ?? options.delta, 'offset');
  return editedPositions(mesh, selection, position => position.map((value, axis) => value + offset[axis]));
}

function scaleVector(value) {
  if (Number.isFinite(value)) {
    const factor = finiteBoundedNumber(value, 'scale');
    return [factor, factor, factor];
  }
  return finiteVector3(value, 'scale');
}

/** Scales selected vertices around an explicit pivot or their centroid by default. */
export function scaleVertices(recipe, options = {}) {
  const mesh = validateIndexedMeshRecipe(recipe);
  const selection = vertexSelection(options, mesh.positions.length / 3);
  const scale = scaleVector(options.scale ?? options.factor ?? options.factors);
  const pivot = options.pivot === undefined
    ? vertexCentroid(mesh.positions, selection)
    : finiteVector3(options.pivot, 'pivot');
  return editedPositions(mesh, selection, position => position.map(
    (value, axis) => pivot[axis] + (value - pivot[axis]) * scale[axis],
  ));
}

function eulerRotation(rotation) {
  const [xRotation, yRotation, zRotation] = finiteVector3(rotation, 'rotation');
  const [sinX, cosX] = [Math.sin(xRotation), Math.cos(xRotation)];
  const [sinY, cosY] = [Math.sin(yRotation), Math.cos(yRotation)];
  const [sinZ, cosZ] = [Math.sin(zRotation), Math.cos(zRotation)];
  return ([x, y, z]) => {
    const afterX = [x, y * cosX - z * sinX, y * sinX + z * cosX];
    const afterY = [
      afterX[0] * cosY + afterX[2] * sinY,
      afterX[1],
      -afterX[0] * sinY + afterX[2] * cosY,
    ];
    return [
      afterY[0] * cosZ - afterY[1] * sinZ,
      afterY[0] * sinZ + afterY[1] * cosZ,
      afterY[2],
    ];
  };
}

function axisAngleRotation(axisValue, angleValue) {
  const axis = finiteVector3(axisValue, 'axis');
  const length = Math.hypot(...axis);
  if (length === 0) throw new RangeError('axis must not be zero.');
  const [x, y, z] = axis.map(component => component / length);
  const angle = finiteBoundedNumber(angleValue, 'angle');
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const complement = 1 - cosine;
  return ([px, py, pz]) => [
    px * (cosine + x * x * complement)
      + py * (x * y * complement - z * sine)
      + pz * (x * z * complement + y * sine),
    px * (y * x * complement + z * sine)
      + py * (cosine + y * y * complement)
      + pz * (y * z * complement - x * sine),
    px * (z * x * complement - y * sine)
      + py * (z * y * complement + x * sine)
      + pz * (cosine + z * z * complement),
  ];
}

/** Rotates selected vertices in radians around an explicit pivot or their centroid. */
export function rotateVertices(recipe, options = {}) {
  const mesh = validateIndexedMeshRecipe(recipe);
  const selection = vertexSelection(options, mesh.positions.length / 3);
  const pivot = options.pivot === undefined
    ? vertexCentroid(mesh.positions, selection)
    : finiteVector3(options.pivot, 'pivot');
  const rotate = options.axis !== undefined || options.angle !== undefined
    ? axisAngleRotation(options.axis, options.angle)
    : eulerRotation(options.rotation ?? options.euler);
  return editedPositions(mesh, selection, (position) => {
    const relative = position.map((value, axis) => value - pivot[axis]);
    return rotate(relative).map((value, axis) => value + pivot[axis]);
  });
}

function meshAdjacency(vertexCount, indices) {
  const adjacency = Array.from({ length: vertexCount }, () => new Set());
  const edgeCounts = new Map();
  const addEdge = (first, second) => {
    if (first === second) return;
    adjacency[first].add(second);
    adjacency[second].add(first);
    const minimum = Math.min(first, second);
    const maximum = Math.max(first, second);
    const key = `${minimum}:${maximum}`;
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  };
  for (let index = 0; index < indices.length; index += 3) {
    const [a, b, c] = indices.slice(index, index + 3);
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }
  const boundaryVertices = new Set();
  for (const [key, count] of edgeCounts) {
    if (count !== 1) continue;
    const [first, second] = key.split(':').map(Number);
    boundaryVertices.add(first);
    boundaryVertices.add(second);
  }
  return { adjacency, boundaryVertices };
}

function boundedInteger(value, label, fallback, minimum, maximum) {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate)) throw new TypeError(`${label} must be an integer.`);
  if (candidate < minimum || candidate > maximum) {
    throw new RangeError(`${label} must be from ${minimum} to ${maximum}.`);
  }
  return candidate;
}

/** Applies simultaneous Laplacian smoothing to selected vertices, or all vertices when omitted. */
export function laplacianSmooth(recipe, options = {}) {
  const mesh = validateIndexedMeshRecipe(recipe);
  const vertexCount = mesh.positions.length / 3;
  const selection = vertexSelection(options, vertexCount, { optional: true });
  const iterations = boundedInteger(
    options.iterations,
    'iterations',
    1,
    1,
    MAX_SMOOTH_ITERATIONS,
  );
  const factor = finiteBoundedNumber(options.factor ?? 0.5, 'factor', 0, 1);
  const preserveBoundary = options.preserveBoundary === undefined ? true : options.preserveBoundary;
  if (typeof preserveBoundary !== 'boolean') throw new TypeError('preserveBoundary must be a boolean.');
  const { adjacency, boundaryVertices } = meshAdjacency(vertexCount, mesh.indices);
  let positions = [...mesh.positions];
  let changed = false;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const previous = positions;
    positions = [...previous];
    for (const vertexIndex of selection) {
      if (preserveBoundary && boundaryVertices.has(vertexIndex)) continue;
      const neighbours = adjacency[vertexIndex];
      if (neighbours.size === 0) continue;
      const average = [0, 0, 0];
      for (const neighbour of neighbours) {
        const offset = neighbour * 3;
        average[0] += previous[offset];
        average[1] += previous[offset + 1];
        average[2] += previous[offset + 2];
      }
      const offset = vertexIndex * 3;
      for (let axis = 0; axis < 3; axis += 1) {
        average[axis] /= neighbours.size;
        const value = previous[offset + axis] + (average[axis] - previous[offset + axis]) * factor;
        finiteBoundedNumber(value, `result.positions[${vertexIndex}][${axis}]`);
        if (!Object.is(value, previous[offset + axis])) changed = true;
        positions[offset + axis] = value;
      }
    }
  }

  mesh.positions = positions;
  if (changed) delete mesh.normals;
  return mesh;
}

/** Replaces normals with area-weighted vertex normals from the indexed triangles. */
export function recalculateVertexNormals(recipe) {
  const mesh = validateIndexedMeshRecipe(recipe);
  const normals = new Array(mesh.positions.length).fill(0);
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const a = mesh.indices[index] * 3;
    const b = mesh.indices[index + 1] * 3;
    const c = mesh.indices[index + 2] * 3;
    const ab = [
      mesh.positions[b] - mesh.positions[a],
      mesh.positions[b + 1] - mesh.positions[a + 1],
      mesh.positions[b + 2] - mesh.positions[a + 2],
    ];
    const ac = [
      mesh.positions[c] - mesh.positions[a],
      mesh.positions[c + 1] - mesh.positions[a + 1],
      mesh.positions[c + 2] - mesh.positions[a + 2],
    ];
    const normal = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    for (const vertexOffset of [a, b, c]) {
      normals[vertexOffset] += normal[0];
      normals[vertexOffset + 1] += normal[1];
      normals[vertexOffset + 2] += normal[2];
    }
  }
  for (let offset = 0; offset < normals.length; offset += 3) {
    const lengthSquared = normals[offset] ** 2 + normals[offset + 1] ** 2 + normals[offset + 2] ** 2;
    if (lengthSquared === 0) {
      normals[offset] = 0;
      normals[offset + 1] = 0;
      normals[offset + 2] = 0;
      continue;
    }
    const inverseLength = 1 / Math.sqrt(lengthSquared);
    normals[offset] *= inverseLength;
    normals[offset + 1] *= inverseLength;
    normals[offset + 2] *= inverseLength;
  }
  mesh.normals = normals;
  return mesh;
}

function attributesMatch(mesh, first, second) {
  if (mesh.uvs !== undefined) {
    const firstOffset = first * 2;
    const secondOffset = second * 2;
    if (mesh.uvs[firstOffset] !== mesh.uvs[secondOffset]
        || mesh.uvs[firstOffset + 1] !== mesh.uvs[secondOffset + 1]) return false;
  }
  if (mesh.colors !== undefined) {
    const itemSize = mesh.colors.length / (mesh.positions.length / 3);
    const firstOffset = first * itemSize;
    const secondOffset = second * itemSize;
    for (let component = 0; component < itemSize; component += 1) {
      if (mesh.colors[firstOffset + component] !== mesh.colors[secondOffset + component]) return false;
    }
  }
  return true;
}

function spatialCell(positions, vertexIndex, tolerance) {
  const offset = vertexIndex * 3;
  return [
    Math.floor(positions[offset] / tolerance),
    Math.floor(positions[offset + 1] / tolerance),
    Math.floor(positions[offset + 2] / tolerance),
  ];
}

function cellKey(x, y, z) {
  return `${x}:${y}:${z}`;
}

/**
 * Welds positional duplicates within tolerance. Vertices on UV or color seams
 * remain split, because merging them cannot preserve those vertex attributes.
 */
export function weldVertices(recipe, options = {}) {
  const mesh = validateIndexedMeshRecipe(recipe);
  const tolerance = finiteBoundedNumber(
    options.tolerance ?? DEFAULT_WELD_TOLERANCE,
    'tolerance',
    MIN_WELD_TOLERANCE,
    MAX_COORDINATE,
  );
  const vertexCount = mesh.positions.length / 3;
  const remap = new Array(vertexCount);
  const representativeOriginalIndices = [];
  const buckets = new Map();
  const toleranceSquared = tolerance * tolerance;

  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    const [cellX, cellY, cellZ] = spatialCell(mesh.positions, vertexIndex, tolerance);
    let representative = -1;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const candidates = buckets.get(cellKey(cellX + dx, cellY + dy, cellZ + dz)) ?? [];
          for (const candidate of candidates) {
            const originalIndex = representativeOriginalIndices[candidate];
            if (!attributesMatch(mesh, originalIndex, vertexIndex)) continue;
            const originalOffset = originalIndex * 3;
            const vertexOffset = vertexIndex * 3;
            const x = mesh.positions[originalOffset] - mesh.positions[vertexOffset];
            const y = mesh.positions[originalOffset + 1] - mesh.positions[vertexOffset + 1];
            const z = mesh.positions[originalOffset + 2] - mesh.positions[vertexOffset + 2];
            if (x * x + y * y + z * z <= toleranceSquared
                && (representative === -1 || candidate < representative)) {
              representative = candidate;
            }
          }
        }
      }
    }
    if (representative === -1) {
      representative = representativeOriginalIndices.length;
      representativeOriginalIndices.push(vertexIndex);
      const key = cellKey(cellX, cellY, cellZ);
      const bucket = buckets.get(key) ?? [];
      bucket.push(representative);
      buckets.set(key, bucket);
    }
    remap[vertexIndex] = representative;
  }

  if (representativeOriginalIndices.length === vertexCount) return mesh;

  const positions = [];
  const uvs = mesh.uvs === undefined ? undefined : [];
  const colors = mesh.colors === undefined ? undefined : [];
  const colorItemSize = colors === undefined ? 0 : mesh.colors.length / vertexCount;
  for (const originalIndex of representativeOriginalIndices) {
    positions.push(...mesh.positions.slice(originalIndex * 3, originalIndex * 3 + 3));
    if (uvs !== undefined) uvs.push(...mesh.uvs.slice(originalIndex * 2, originalIndex * 2 + 2));
    if (colors !== undefined) {
      colors.push(...mesh.colors.slice(
        originalIndex * colorItemSize,
        originalIndex * colorItemSize + colorItemSize,
      ));
    }
  }
  const indices = [];
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const triangle = [
      remap[mesh.indices[index]],
      remap[mesh.indices[index + 1]],
      remap[mesh.indices[index + 2]],
    ];
    if (triangle[0] === triangle[1] || triangle[1] === triangle[2] || triangle[2] === triangle[0]) continue;
    indices.push(...triangle);
  }
  if (indices.length === 0) throw new RangeError('Welding would remove every indexed triangle.');

  mesh.positions = positions;
  mesh.indices = indices;
  if (uvs !== undefined) mesh.uvs = uvs;
  if (colors !== undefined) mesh.colors = colors;
  delete mesh.normals;
  validateCanonicalRecipe(mesh);
  return mesh;
}

/** Indexed meshes are already triangulated; this validates and returns a clone. */
export function triangulateIndexedMesh(recipe) {
  return validateIndexedMeshRecipe(recipe);
}

/** Dispatches one serializable indexed-mesh editing command. */
export function applyIndexedMeshEdit(recipe, command) {
  if (!isPlainRecord(command)) throw new TypeError('Indexed mesh edit command must be a plain object.');
  switch (command.type) {
    case 'move':
    case 'moveVertices':
      return moveVertices(recipe, command);
    case 'scale':
    case 'scaleVertices':
      return scaleVertices(recipe, command);
    case 'rotate':
    case 'rotateVertices':
      return rotateVertices(recipe, command);
    case 'smooth':
    case 'laplacianSmooth':
      return laplacianSmooth(recipe, command);
    case 'recalculateNormals':
    case 'recalculateVertexNormals':
      return recalculateVertexNormals(recipe);
    case 'weld':
    case 'weldVertices':
      return weldVertices(recipe, command);
    case 'triangulate':
      return triangulateIndexedMesh(recipe);
    default:
      throw new TypeError(`Unsupported indexed mesh edit command: ${String(command.type)}.`);
  }
}

export const moveIndexedMeshVertices = moveVertices;
export const scaleIndexedMeshVertices = scaleVertices;
export const rotateIndexedMeshVertices = rotateVertices;
export const smoothIndexedMesh = laplacianSmooth;
export const recalculateIndexedMeshNormals = recalculateVertexNormals;
export const weldIndexedMeshVertices = weldVertices;
