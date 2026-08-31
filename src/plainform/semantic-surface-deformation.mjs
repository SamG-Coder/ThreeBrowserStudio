import { invertTransformMatrix, transformPointByMatrix } from '../core/transform-math.mjs';
import { realizeSurfaceTriangles } from './constrained-surface.mjs';

const subtract = (left, right) => left.map((value, axis) => value - right[axis]);
const add = (left, right) => left.map((value, axis) => value + right[axis]);
const scale = (vector, amount) => vector.map(value => value * amount);
const dot = (left, right) => left.reduce((sum, value, axis) => sum + value * right[axis], 0);
const cross = (left, right) => [
  left[1] * right[2] - left[2] * right[1],
  left[2] * right[0] - left[0] * right[2],
  left[0] * right[1] - left[1] * right[0],
];
const normalize = (vector) => {
  const magnitude = Math.hypot(...vector);
  return magnitude > 1e-12 ? vector.map(value => value / magnitude) : [0, 0, 0];
};
const smoothstep = value => {
  const bounded = Math.max(0, Math.min(1, value));
  return bounded * bounded * (3 - 2 * bounded);
};

function vertexNormals(positions, indices) {
  const sums = positions.map(() => [0, 0, 0]);
  for (let offset = 0; offset < indices.length; offset += 3) {
    const [a, b, c] = indices.slice(offset, offset + 3);
    const normal = cross(subtract(positions[b], positions[a]), subtract(positions[c], positions[a]));
    for (const index of [a, b, c]) sums[index] = add(sums[index], normal);
  }
  return sums.map(normalize);
}

function closestCurveSample(point, curve) {
  let best = null;
  const segmentCount = curve.closed ? curve.points.length : curve.points.length - 1;
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const next = (segment + 1) % curve.points.length;
    const start = curve.points[segment]; const end = curve.points[next];
    const span = subtract(end, start);
    const denominator = Math.max(Number.EPSILON, dot(span, span));
    const factor = Math.max(0, Math.min(1, dot(subtract(point, start), span) / denominator));
    const projected = add(start, scale(span, factor));
    const distance = Math.hypot(...subtract(point, projected));
    if (best && distance >= best.distance) continue;
    const startNormal = curve.normals[segment]; const endNormal = curve.normals[next];
    best = { distance, normal: normalize(add(scale(startNormal, 1 - factor), scale(endNormal, factor))) };
  }
  return best;
}

function regionWeight(point, region, resolveReference, falloff) {
  if (region.definition.kind === 'surfaceRadius') {
    const distance = Math.hypot(...subtract(point, region.definition.center));
    if (distance <= region.definition.radius) return 1;
    return 1 - smoothstep((distance - region.definition.radius) / falloff);
  }
  if (region.definition.kind === 'curveDistance') {
    const reference = resolveReference(region.definition.reference.name);
    const distance = closestCurveSample(point, reference).distance;
    if (distance <= region.definition.distance) return 1;
    return 1 - smoothstep((distance - region.definition.distance) / falloff);
  }
  const error = new Error(
    `Semantic deformation of region “${region.name}” is not implemented for ${region.definition.kind}. `
    + 'Use a curve-distance or surface-radius region for deformation; between/enclosed regions remain valid intent for later split and projection operations.',
  );
  error.code = 'plainform_surface_region_deformation_unsupported';
  throw error;
}

function deform({ owner, amount, influence }) {
  const mesh = realizeSurfaceTriangles({ recipe: owner.recipe, matrix: owner.matrix, entityId: owner.entityId });
  const normals = vertexNormals(mesh.worldPositions, mesh.indices);
  let affectedVertexCount = 0;
  const worldPositions = mesh.worldPositions.map((point, index) => {
    const { weight, normal = normals[index] } = influence(point);
    if (!(weight > 1e-9)) return [...point];
    affectedVertexCount += 1;
    return add(point, scale(normalize(normal), amount * weight));
  });
  if (affectedVertexCount === 0) {
    const error = new Error(`Semantic surface deformation on ${owner.entityId} affected no evaluated vertices. Increase the explicit falloff or use a denser source surface.`);
    error.code = 'plainform_surface_deformation_empty';
    throw error;
  }
  const inverse = invertTransformMatrix(owner.matrix);
  return {
    recipe: {
      kind: 'indexedMesh',
      positions: worldPositions.flatMap(point => transformPointByMatrix(inverse, point)),
      indices: [...mesh.indices],
    },
    affectedVertexCount,
  };
}

export function deformAlongSurfaceCurve({ owner, curve, amount, falloff }) {
  return deform({
    owner, amount,
    influence(point) {
      const sample = closestCurveSample(point, curve);
      return { weight: 1 - smoothstep(sample.distance / falloff), normal: sample.normal };
    },
  });
}

export function deformSurfaceRegion({ owner, region, resolveReference, amount, falloff }) {
  return deform({
    owner, amount,
    influence(point) { return { weight: regionWeight(point, region, resolveReference, falloff) }; },
  });
}
