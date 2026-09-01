import { invertTransformMatrix, transformPointByMatrix } from '../core/transform-math.mjs';
import { realizeSurfaceTriangles } from './constrained-surface.mjs';
import { surfaceRegionWeight } from './semantic-surface-deformation.mjs';

const midpoint = (a, b) => a.map((value, axis) => (value + b[axis]) * 0.5);
const edgeKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;

function selectedFaces(mesh, region, resolveReference) {
  const selected = new Set();
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const indices = mesh.indices.slice(offset, offset + 3);
    const center = indices.reduce(
      (sum, index) => sum.map((value, axis) => value + mesh.worldPositions[index][axis] / 3), [0, 0, 0],
    );
    if (surfaceRegionWeight(center, region, resolveReference, Number.EPSILON) >= 0.5) selected.add(offset / 3);
  }
  return selected;
}

function subdivide(mesh, selection) {
  const positions = mesh.worldPositions.map(point => [...point]);
  const uvs = mesh.uvs?.map(uv => [...uv]);
  const midpointIndices = new Map();
  const refinedIndices = [];
  const refinedFaces = new Set();
  const refinedVertices = new Set();
  const midpointIndex = (a, b) => {
    const key = edgeKey(a, b);
    if (midpointIndices.has(key)) return midpointIndices.get(key);
    const index = positions.length;
    positions.push(midpoint(positions[a], positions[b]));
    if (uvs) uvs.push(midpoint(uvs[a], uvs[b]));
    midpointIndices.set(key, index); refinedVertices.add(index);
    return index;
  };
  for (let face = 0; face < mesh.indices.length / 3; face += 1) {
    const [a, b, c] = mesh.indices.slice(face * 3, face * 3 + 3);
    if (!selection.has(face)) {
      refinedIndices.push(a, b, c); continue;
    }
    const ab = midpointIndex(a, b); const bc = midpointIndex(b, c); const ca = midpointIndex(c, a);
    for (const triangle of [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]]) {
      refinedFaces.add(refinedIndices.length / 3); refinedIndices.push(...triangle);
      triangle.forEach(index => refinedVertices.add(index));
    }
  }
  return { worldPositions: positions, indices: refinedIndices, ...(uvs ? { uvs } : {}), refinedFaces, refinedVertices };
}

function relaxationBoundary(mesh, selectedVertices) {
  const edgeFaces = new Map();
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const triangle = mesh.indices.slice(offset, offset + 3);
    for (const [a, b] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) {
      const key = edgeKey(a, b); const list = edgeFaces.get(key) ?? [];
      list.push(selectedVertices.has(a) && selectedVertices.has(b)); edgeFaces.set(key, list);
    }
  }
  const boundary = new Set();
  for (const [key, states] of edgeFaces) {
    if (states.length < 2 || states.some(value => value !== states[0])) key.split(':').forEach(value => boundary.add(Number(value)));
  }
  return boundary;
}

function relax(mesh, selectedVertices, iterations, strength) {
  const neighbors = Array.from({ length: mesh.worldPositions.length }, () => new Set());
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const triangle = mesh.indices.slice(offset, offset + 3);
    for (const [a, b] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) {
      neighbors[a].add(b); neighbors[b].add(a);
    }
  }
  const boundary = relaxationBoundary(mesh, selectedVertices);
  let positions = mesh.worldPositions.map(point => [...point]);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const previous = positions; positions = previous.map(point => [...point]);
    for (const index of selectedVertices) {
      if (boundary.has(index) || neighbors[index].size === 0) continue;
      const average = [...neighbors[index]].reduce(
        (sum, neighbor) => sum.map((value, axis) => value + previous[neighbor][axis] / neighbors[index].size), [0, 0, 0],
      );
      positions[index] = previous[index].map((value, axis) => value + (average[axis] - value) * strength);
    }
  }
  return { ...mesh, worldPositions: positions };
}

export function refineSurfaceRegion({ owner, region, resolveReference, levels = 1, relaxIterations = 0, relaxStrength = 0.5 }) {
  if (!Number.isSafeInteger(levels) || levels < 1 || levels > 4) throw new RangeError('Surface refinement supports 1 to 4 subdivision levels.');
  if (!Number.isSafeInteger(relaxIterations) || relaxIterations < 0 || relaxIterations > 16) throw new RangeError('Surface relaxation supports 0 to 16 iterations.');
  if (!(relaxStrength > 0 && relaxStrength <= 1)) throw new RangeError('Surface relaxation strength must be greater than 0 and at most 1.');
  let mesh = realizeSurfaceTriangles({ recipe: owner.recipe, matrix: owner.matrix, entityId: owner.entityId });
  let selected = selectedFaces(mesh, region, resolveReference);
  if (selected.size === 0) {
    const error = new Error(`Surface refinement region “${region.name}” selects no triangles on ${owner.entityId}.`);
    error.code = 'plainform_surface_refinement_empty'; throw error;
  }
  let selectedVertices = new Set();
  for (let level = 0; level < levels; level += 1) {
    mesh = subdivide(mesh, selected);
    selected = mesh.refinedFaces; selectedVertices = mesh.refinedVertices;
    if (mesh.worldPositions.length > 250_000 || mesh.indices.length > 1_500_000) {
      const error = new Error('Surface refinement exceeds the bounded 250,000-vertex or 500,000-triangle limit.');
      error.code = 'plainform_surface_refinement_limit'; throw error;
    }
  }
  if (relaxIterations > 0) mesh = relax(mesh, selectedVertices, relaxIterations, relaxStrength);
  const inverse = invertTransformMatrix(owner.matrix);
  return {
    recipe: {
      kind: 'indexedMesh',
      positions: mesh.worldPositions.flatMap(point => transformPointByMatrix(inverse, point)),
      indices: [...mesh.indices],
      ...(mesh.uvs ? { uvs: mesh.uvs.flat() } : {}),
    },
    refinedFaceCount: selected.size,
    refinedVertexCount: selectedVertices.size,
  };
}
