import { invertTransformMatrix, transformPointByMatrix } from '../core/transform-math.mjs';
import { realizeSurfaceTriangles } from './constrained-surface.mjs';

const subtract = (left, right) => left.map((value, axis) => value - right[axis]);
const add = (left, right) => left.map((value, axis) => value + right[axis]);
const scale = (vector, amount) => vector.map(value => value * amount);
const cross = (left, right) => [
  left[1] * right[2] - left[2] * right[1],
  left[2] * right[0] - left[0] * right[2],
  left[0] * right[1] - left[1] * right[0],
];
const normalize = (vector) => {
  const magnitude = Math.hypot(...vector);
  return magnitude > 1e-12 ? vector.map(value => value / magnitude) : [0, 0, 0];
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

function boundaryEdges(indices) {
  const counts = new Map();
  for (let offset = 0; offset < indices.length; offset += 3) {
    const triangle = indices.slice(offset, offset + 3);
    for (const [from, to] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) {
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      const record = counts.get(key) ?? { count: 0, from, to };
      record.count += 1;
      counts.set(key, record);
    }
  }
  return [...counts.values()].filter(edge => edge.count === 1);
}

function boundsSpan(positions) {
  const min = [...positions[0]]; const max = [...positions[0]];
  for (const point of positions.slice(1)) for (let axis = 0; axis < 3; axis += 1) {
    min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]);
  }
  return Math.min(...max.map((value, axis) => value - min[axis]).filter(value => value > 1e-9));
}

export function shellSurface({ owner, thickness, direction }) {
  const mesh = realizeSurfaceTriangles({ recipe: owner.recipe, matrix: owner.matrix, entityId: owner.entityId });
  const span = boundsSpan(mesh.worldPositions);
  if (!(span > 0) || thickness >= span * 0.5) {
    const error = new Error(`Shell thickness ${thickness} metres is too large for ${owner.entityId}; it must be less than half the smallest non-zero surface span (${span} metres).`);
    error.code = 'plainform_shell_self_intersection_risk'; throw error;
  }
  const sign = direction === 'inward' ? -1 : 1;
  const normals = vertexNormals(mesh.worldPositions, mesh.indices);
  if (normals.some(normal => Math.hypot(...normal) <= 1e-12)) {
    const error = new Error(`Shelling ${owner.entityId} found a degenerate surface normal.`);
    error.code = 'plainform_shell_degenerate_surface'; throw error;
  }
  const offsetWorld = mesh.worldPositions.map((point, index) => add(point, scale(normals[index], thickness * sign)));
  const inverse = invertTransformMatrix(owner.matrix);
  const outer = mesh.worldPositions.map(point => transformPointByMatrix(inverse, point));
  const inner = offsetWorld.map(point => transformPointByMatrix(inverse, point));
  const vertexCount = outer.length;
  const indices = [...mesh.indices];
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const [a, b, c] = mesh.indices.slice(offset, offset + 3);
    indices.push(c + vertexCount, b + vertexCount, a + vertexCount);
  }
  const edges = boundaryEdges(mesh.indices);
  for (const { from, to } of edges) {
    indices.push(from, to, from + vertexCount, to, to + vertexCount, from + vertexCount);
  }
  if (indices.length / 3 > 1_000_000) {
    const error = new Error(`Shelling ${owner.entityId} exceeds the bounded 1,000,000-triangle result limit.`);
    error.code = 'plainform_shell_limit'; throw error;
  }
  return {
    recipe: { kind: 'indexedMesh', positions: [...outer, ...inner].flat(), indices },
    sourceVertexCount: vertexCount,
    boundaryEdgeCount: edges.length,
  };
}
