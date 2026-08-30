const EPSILON = 1e-12;

function unit(seed, index, channel) {
  let value = (seed >>> 0)
    ^ Math.imul((index + 1) >>> 0, 0x9e3779b1)
    ^ Math.imul((channel + 1) >>> 0, 0x85ebca77);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x1_0000_0000;
}

const add = (a, b) => a.map((value, index) => value + b[index]);
const subtract = (a, b) => a.map((value, index) => value - b[index]);
const scale = (value, amount) => value.map(component => component * amount);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = value => Math.hypot(...value);
const normalize = (value, fallback = [0, 0, 1]) => {
  const magnitude = length(value);
  return magnitude > EPSILON ? scale(value, 1 / magnitude) : [...fallback];
};

function vertex(values, index) {
  return values.slice(index * 3, index * 3 + 3);
}

function triangleRecords(recipe) {
  if (!Array.isArray(recipe?.positions) || recipe.positions.length < 9 || recipe.positions.length % 3 !== 0) {
    throw new TypeError('Surface sampling requires indexed mesh positions.');
  }
  const indices = Array.isArray(recipe.indices)
    ? recipe.indices
    : Array.from({ length: recipe.positions.length / 3 }, (_, index) => index);
  if (indices.length < 3 || indices.length % 3 !== 0) {
    throw new TypeError('Surface sampling requires complete triangle indices.');
  }
  const records = [];
  let cumulativeArea = 0;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const triangle = indices.slice(offset, offset + 3);
    const points = triangle.map(index => vertex(recipe.positions, index));
    if (points.some(point => point.length !== 3 || point.some(value => !Number.isFinite(value)))) continue;
    const faceNormal = cross(subtract(points[1], points[0]), subtract(points[2], points[0]));
    const area = length(faceNormal) * 0.5;
    if (!(area > EPSILON)) continue;
    cumulativeArea += area;
    records.push({ triangle, points, faceNormal: normalize(faceNormal), cumulativeArea });
  }
  if (records.length === 0) throw new RangeError('Surface sampling target has no non-degenerate triangles.');
  return { records, totalArea: cumulativeArea };
}

function findTriangle(records, area) {
  let low = 0;
  let high = records.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) * 0.5);
    if (area <= records[middle].cumulativeArea) high = middle;
    else low = middle + 1;
  }
  return records[low];
}

function interpolate(values, indices, barycentric) {
  return [0, 1, 2].map(axis => indices.reduce(
    (sum, vertexIndex, corner) => sum + values[vertexIndex * 3 + axis] * barycentric[corner],
    0,
  ));
}

/** Deterministic area-weighted triangle sampling with bounded Poisson-style rejection. */
export function sampleIndexedMeshSurface(recipe, options = {}) {
  const count = options.count ?? 1;
  const seed = options.seed ?? 0;
  const minimumDistance = options.minDistance ?? 0;
  const maxAttempts = options.maxAttempts ?? Math.max(count * 48, count);
  if (!Number.isInteger(count) || count < 1 || count > 8192) throw new RangeError('count must be an integer from 1 to 8192.');
  if (!Number.isInteger(seed)) throw new TypeError('seed must be an integer.');
  if (!Number.isFinite(minimumDistance) || minimumDistance < 0) throw new RangeError('minDistance must be non-negative.');
  const { records, totalArea } = triangleRecords(recipe);
  const hasNormals = Array.isArray(recipe.normals) && recipe.normals.length === recipe.positions.length;
  const accepted = [];
  for (let attempt = 0; attempt < maxAttempts && accepted.length < count; attempt += 1) {
    const triangle = findTriangle(records, unit(seed, attempt, 0) * totalArea);
    const squareRoot = Math.sqrt(unit(seed, attempt, 1));
    const barycentric = [
      1 - squareRoot,
      squareRoot * (1 - unit(seed, attempt, 2)),
      squareRoot * unit(seed, attempt, 2),
    ];
    const point = [0, 1, 2].map(axis => triangle.points.reduce(
      (sum, value, corner) => sum + value[axis] * barycentric[corner],
      0,
    ));
    if (minimumDistance > 0 && accepted.some(sample => length(subtract(sample.point, point)) < minimumDistance)) continue;
    const normal = hasNormals
      ? normalize(interpolate(recipe.normals, triangle.triangle, barycentric), triangle.faceNormal)
      : triangle.faceNormal;
    accepted.push({
      point,
      normal,
      triangleIndex: Math.floor(triangle.triangle[0] === undefined ? 0 : records.indexOf(triangle)),
      barycentric,
    });
  }
  return accepted;
}

export const surfaceVectorMath = Object.freeze({ add, subtract, scale, cross, normalize, length });
