import { projectSurfaceAnchors, realizeSurfaceTriangles } from './constrained-surface.mjs';

const subtract = (left, right) => left.map((value, axis) => value - right[axis]);
const dot = (left, right) => left.reduce((sum, value, axis) => sum + value * right[axis], 0);
const normalize = (vector) => {
  const magnitude = Math.hypot(...vector);
  return magnitude > 1e-12 ? vector.map(value => value / magnitude) : [0, 0, 0];
};

export function surfaceBounds(owner) {
  const mesh = realizeSurfaceTriangles({ recipe: owner.recipe, matrix: owner.matrix, entityId: owner.entityId });
  const min = [...mesh.worldPositions[0]]; const max = [...mesh.worldPositions[0]];
  for (const point of mesh.worldPositions.slice(1)) for (let axis = 0; axis < 3; axis += 1) {
    min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]);
  }
  return { min, max, dimensions: max.map((value, axis) => value - min[axis]) };
}

export function surfaceWidthAtHeight(owner, height) {
  const mesh = realizeSurfaceTriangles({ recipe: owner.recipe, matrix: owner.matrix, entityId: owner.entityId });
  const xs = [];
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const triangle = mesh.indices.slice(offset, offset + 3).map(index => mesh.worldPositions[index]);
    for (const [first, second] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) {
      const firstDelta = first[1] - height; const secondDelta = second[1] - height;
      if (Math.abs(firstDelta) <= 1e-10) xs.push(first[0]);
      if (firstDelta * secondDelta >= 0 || Math.abs(first[1] - second[1]) <= 1e-12) continue;
      const factor = (height - first[1]) / (second[1] - first[1]);
      xs.push(first[0] + (second[0] - first[0]) * factor);
    }
  }
  if (xs.length < 2) {
    const error = new Error(`The surface of ${owner.entityId} does not cross height ${height} metres in enough places to measure width.`);
    error.code = 'plainform_surface_measurement_empty'; throw error;
  }
  return Math.max(...xs) - Math.min(...xs);
}

export function minimumSurfaceDistance(first, second) {
  const firstMesh = realizeSurfaceTriangles({ recipe: first.recipe, matrix: first.matrix, entityId: first.entityId });
  const secondMesh = realizeSurfaceTriangles({ recipe: second.recipe, matrix: second.matrix, entityId: second.entityId });
  const firstToSecond = projectSurfaceAnchors({
    recipe: second.recipe, matrix: second.matrix, seedPoints: firstMesh.worldPositions, entityId: second.entityId,
  });
  const secondToFirst = projectSurfaceAnchors({
    recipe: first.recipe, matrix: first.matrix, seedPoints: secondMesh.worldPositions, entityId: first.entityId,
  });
  return Math.sqrt(Math.min(
    ...firstToSecond.map(anchor => anchor.distanceSquared),
    ...secondToFirst.map(anchor => anchor.distanceSquared),
  ));
}

export function angleBetweenSurfaceReferences(first, second) {
  const firstDirection = normalize(subtract(first.points.at(-1), first.points[0]));
  const secondDirection = normalize(subtract(second.points.at(-1), second.points[0]));
  if (Math.hypot(...firstDirection) <= 1e-12 || Math.hypot(...secondDirection) <= 1e-12) {
    const error = new Error('Angle measurement requires two non-degenerate surface references.');
    error.code = 'plainform_surface_measurement_empty'; throw error;
  }
  return Math.acos(Math.max(-1, Math.min(1, dot(firstDirection, secondDirection))));
}

export function assertSurfaceSymmetry(owner, axis) {
  const coordinate = { x: 0, y: 1, z: 2 }[axis];
  const mesh = realizeSurfaceTriangles({ recipe: owner.recipe, matrix: owner.matrix, entityId: owner.entityId });
  const bounds = surfaceBounds(owner);
  const center = (bounds.min[coordinate] + bounds.max[coordinate]) * 0.5;
  const span = Math.max(...bounds.dimensions, 1);
  const tolerance = span * 1e-6;
  const quantize = point => point.map(value => Math.round(value / tolerance)).join(':');
  const points = new Set(mesh.worldPositions.map(quantize));
  const missing = mesh.worldPositions.find((point) => {
    const mirrored = [...point]; mirrored[coordinate] = center - (point[coordinate] - center);
    return !points.has(quantize(mirrored));
  });
  if (missing) {
    const error = new Error(`${owner.entityId} is not symmetric across its ${axis} centre plane within ${tolerance} metres.`);
    error.code = 'plainform_constraint_unsatisfied';
    error.details = { constraint: 'symmetry', entityId: owner.entityId, axis, tolerance, unmatchedPoint: missing };
    throw error;
  }
  return { center, tolerance };
}
