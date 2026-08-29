import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyIndexedMeshEdit,
  laplacianSmooth,
  moveVertices,
  recalculateVertexNormals,
  rotateVertices,
  scaleVertices,
  triangulateIndexedMesh,
  validateIndexedMeshRecipe,
  weldVertices,
} from '../src/core/indexed-mesh-editing.mjs';

function quadRecipe() {
  return {
    kind: 'indexedMesh',
    positions: [
      0, 0, 0,
      2, 0, 0,
      2, 2, 0,
      0, 2, 0,
    ],
    indices: [0, 1, 2, 0, 2, 3],
    normals: [
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
    ],
    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
    colors: [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1],
    computeNormals: true,
  };
}

function assertNumbersClose(actual, expected, epsilon = 1e-12) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) <= epsilon, `${value} != ${expected[index]} at ${index}`);
  });
}

test('moveVertices edits only selected vertices, preserves UVs, and never mutates input', () => {
  const recipe = quadRecipe();
  const snapshot = structuredClone(recipe);
  const result = moveVertices(recipe, { vertexIndices: [0, 2], offset: [1, -2, 3] });

  assert.deepEqual(recipe, snapshot);
  assert.notEqual(result, recipe);
  assert.notEqual(result.positions, recipe.positions);
  assert.deepEqual(result.positions, [
    1, -2, 3,
    2, 0, 0,
    3, 0, 3,
    0, 2, 0,
  ]);
  assert.deepEqual(result.uvs, recipe.uvs);
  assert.notEqual(result.uvs, recipe.uvs);
  assert.equal('normals' in result, false);
});

test("selection 'all' edits a dense mesh without enumerating vertex indices", () => {
  const moved = moveVertices(quadRecipe(), { selection: 'all', offset: [0, 0, 2] });
  assert.deepEqual(moved.positions, [
    0, 0, 2,
    2, 0, 2,
    2, 2, 2,
    0, 2, 2,
  ]);
  assert.throws(
    () => moveVertices(quadRecipe(), { selection: 'visible', offset: [0, 0, 2] }),
    /selection must be 'all'/,
  );
});

test('scaleVertices defaults to the selection centroid and accepts scalar factors', () => {
  const result = scaleVertices(quadRecipe(), { vertexIndices: [0, 1], scale: 2 });
  assert.deepEqual(result.positions, [
    -1, 0, 0,
    3, 0, 0,
    2, 2, 0,
    0, 2, 0,
  ]);

  const anisotropic = scaleVertices(quadRecipe(), {
    vertexIndices: [2],
    scale: [0.5, 2, -1],
    pivot: [0, 0, 0],
  });
  assert.deepEqual(anisotropic.positions.slice(6, 9), [1, 4, 0]);
});

test('rotateVertices supports XYZ Euler and axis-angle rotations around a pivot', () => {
  const euler = rotateVertices(quadRecipe(), {
    vertexIndices: [1],
    rotation: [0, 0, Math.PI / 2],
    pivot: [0, 0, 0],
  });
  assertNumbersClose(euler.positions.slice(3, 6), [0, 2, 0]);

  const axisAngle = rotateVertices(quadRecipe(), {
    vertexIndices: [3],
    axis: [0, 0, 1],
    angle: -Math.PI / 2,
    pivot: [0, 0, 0],
  });
  assertNumbersClose(axisAngle.positions.slice(9, 12), [2, 0, 0]);
});

test('laplacianSmooth is simultaneous, iterative, selection-aware, and boundary preserving', () => {
  const recipe = {
    kind: 'indexedMesh',
    positions: [
      -1, -1, 0,
      1, -1, 0,
      1, 1, 0,
      -1, 1, 0,
      0.5, 0, 0,
    ],
    indices: [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4],
    normals: new Array(15).fill(0),
    uvs: [0, 0, 1, 0, 1, 1, 0, 1, 0.5, 0.5],
  };
  const result = laplacianSmooth(recipe, {
    vertexIndices: [0, 1, 2, 3, 4],
    iterations: 2,
    factor: 0.5,
    preserveBoundary: true,
  });

  assert.deepEqual(result.positions.slice(0, 12), recipe.positions.slice(0, 12));
  assertNumbersClose(result.positions.slice(12, 15), [0.125, 0, 0]);
  assert.deepEqual(result.uvs, recipe.uvs);
  assert.equal('normals' in result, false);
  assert.deepEqual(recipe.positions.slice(12, 15), [0.5, 0, 0]);
});

test('laplacianSmooth can smooth every vertex including boundaries', () => {
  const recipe = {
    kind: 'indexedMesh',
    positions: [0, 0, 0, 2, 0, 0, 0, 2, 0],
    indices: [0, 1, 2],
  };
  const result = laplacianSmooth(recipe, { factor: 1, preserveBoundary: false });
  assert.deepEqual(result.positions, [1, 1, 0, 0, 1, 0, 1, 0, 0]);
});

test('recalculateVertexNormals creates normalized area-weighted indexed normals', () => {
  const recipe = quadRecipe();
  recipe.normals.fill(0);
  const snapshot = structuredClone(recipe);
  const result = recalculateVertexNormals(recipe);

  assert.deepEqual(result.normals, [
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]);
  assert.deepEqual(recipe, snapshot);
});

test('weldVertices remaps triangles, drops collapsed faces, and retains compatible UVs and colors', () => {
  const recipe = {
    kind: 'indexedMesh',
    positions: [
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0.0000001, 0, 0,
      1, 1, 0,
    ],
    indices: [0, 1, 2, 3, 4, 2, 0, 3, 1],
    normals: new Array(15).fill(1),
    uvs: [0, 0, 1, 0, 0, 1, 0, 0, 1, 1],
    colors: [
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
      1, 0, 0,
      1, 1, 1,
    ],
  };
  const snapshot = structuredClone(recipe);
  const result = weldVertices(recipe, { tolerance: 1e-5 });

  assert.deepEqual(result.positions, [
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    1, 1, 0,
  ]);
  assert.deepEqual(result.indices, [0, 1, 2, 0, 3, 2]);
  assert.deepEqual(result.uvs, [0, 0, 1, 0, 0, 1, 1, 1]);
  assert.deepEqual(result.colors, [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]);
  assert.equal('normals' in result, false);
  assert.deepEqual(recipe, snapshot);
});

test('weldVertices keeps coincident vertices split across UV seams', () => {
  const recipe = {
    kind: 'indexedMesh',
    positions: [
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 0,
      1, 1, 0,
    ],
    indices: [0, 1, 2, 3, 4, 2],
    uvs: [0, 0, 1, 0, 0, 1, 0.5, 0.5, 1, 1],
  };
  const result = weldVertices(recipe, { tolerance: 0.01 });
  assert.deepEqual(result, recipe);
  assert.notEqual(result, recipe);
  assert.notEqual(result.positions, recipe.positions);
});

test('triangulateIndexedMesh is a validating clone-only no-op for indexed triangles', () => {
  const recipe = quadRecipe();
  const result = triangulateIndexedMesh(recipe);
  assert.deepEqual(result, recipe);
  assert.notEqual(result, recipe);
  assert.notEqual(result.indices, recipe.indices);

  assert.throws(
    () => triangulateIndexedMesh({ ...recipe, indices: [0, 1, 2, 3] }),
    /divisible by three/,
  );
  assert.throws(
    () => triangulateIndexedMesh({ ...recipe, indices: [0, 1, 9] }),
    /integer from 0 to 3/,
  );
});

test('recipe and command validation reject non-finite, out-of-budget, and ambiguous data', () => {
  const recipe = quadRecipe();
  assert.throws(
    () => validateIndexedMeshRecipe({ ...recipe, positions: [Number.NaN, ...recipe.positions.slice(1)] }),
    /finite/,
  );
  assert.throws(
    () => validateIndexedMeshRecipe({ ...recipe, positions: [1_000_001, ...recipe.positions.slice(1)] }),
    /-1000000 to 1000000/,
  );
  assert.throws(
    () => moveVertices(recipe, { vertexIndices: [0, 0], offset: [1, 0, 0] }),
    /duplicate/,
  );
  assert.throws(
    () => laplacianSmooth(recipe, { factor: 1.01 }),
    /0 to 1/,
  );
  assert.throws(
    () => rotateVertices(recipe, { vertexIndices: [0], axis: [0, 0, 0], angle: 1 }),
    /must not be zero/,
  );
});

test('applyIndexedMeshEdit dispatches serializable commands and rejects unknown ones', () => {
  const recipe = quadRecipe();
  const result = applyIndexedMeshEdit(recipe, {
    type: 'moveVertices',
    vertexIndices: [1],
    offset: [0, 0, 2],
  });
  assert.deepEqual(result.positions.slice(3, 6), [2, 0, 2]);
  assert.throws(
    () => applyIndexedMeshEdit(recipe, { type: 'subdivide' }),
    /Unsupported indexed mesh edit command/,
  );
});
