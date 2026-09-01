import assert from 'node:assert/strict';
import test from 'node:test';
import {
  conformingSubdivideTriangles,
  flipTriangleEdge,
  relaxConformingRegion,
  splitTriangleEdge,
  validateConformingTriangleMesh,
} from '../src/plainform/index.mjs';

function square() {
  return {
    worldPositions: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
    indices: [0, 1, 2, 0, 2, 3],
    uvs: [[0, 0], [1, 0], [1, 1], [0, 1]],
    vertexAttributes: { weights: [[1, 0], [0.8, 0.2], [0.4, 0.6], [0, 1]] },
    faceMaterialIndices: [3, 7],
  };
}

test('local triangle subdivision creates a conforming deterministic transition and remaps attributes', () => {
  const first = conformingSubdivideTriangles(square(), new Set([0]));
  const second = conformingSubdivideTriangles(square(), new Set([0]));
  assert.deepEqual(first, second);
  assert.equal(first.refinedFaces.size, 4);
  assert.equal(first.transitionFaces.size, 2);
  assert.equal(first.indices.length / 3, 6);
  assert.equal(first.worldPositions.length, 7);
  assert.equal(first.uvs.length, first.worldPositions.length);
  assert.equal(first.vertexAttributes.weights.length, first.worldPositions.length);
  assert.deepEqual(first.faceMaterialIndices, [3, 3, 3, 3, 7, 7]);
  assert.equal(first.boundaryLoops.length, 1);
  const quality = validateConformingTriangleMesh(first);
  assert.equal(quality.manifold, true);
  assert.equal(quality.windingConsistent, true);
});

test('tangential relaxation preserves constrained boundaries and reprojects onto the source surface', () => {
  const source = square();
  const refined = conformingSubdivideTriangles(source, new Set([0, 1]));
  const before = refined.worldPositions.map(point => [...point]);
  const relaxed = relaxConformingRegion(
    refined,
    refined.refinedVertices,
    refined.boundaryVertices,
    source,
    4,
    0.5,
  );
  for (const index of refined.boundaryVertices) assert.deepEqual(relaxed.worldPositions[index], before[index]);
  assert.ok(relaxed.worldPositions.every(point => Math.abs(point[2]) <= Number.EPSILON));
  assert.ok(relaxed.maximumProjectionDistance <= Number.EPSILON);
  assert.equal(validateConformingTriangleMesh(relaxed).manifold, true);
});

test('edge split and flip primitives are deterministic, conforming, and fail closed', () => {
  const split = splitTriangleEdge(square(), 0, 2);
  assert.equal(split.worldPositions.length, 5);
  assert.equal(split.uvs.length, 5);
  assert.equal(split.vertexAttributes.weights.length, 5);
  assert.deepEqual(split.faceMaterialIndices, [3, 3, 7, 7]);
  assert.equal(validateConformingTriangleMesh(split).manifold, true);
  const flipped = flipTriangleEdge(square(), 0, 2);
  assert.deepEqual(flipped.indices, [1, 3, 2, 3, 1, 0]);
  assert.equal(validateConformingTriangleMesh(flipped).windingConsistent, true);
  assert.throws(() => flipTriangleEdge(square(), 0, 1), error => error.code === 'plainform_remesh_edge_flip_invalid');
});
