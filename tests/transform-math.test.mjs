import assert from 'node:assert/strict';
import test from 'node:test';
import { StudioError } from '../src/core/errors.mjs';
import {
  composeEntityTransforms,
  composeTransformMatrix,
  decomposeTransformMatrix,
  invertTransformMatrix,
  multiplyTransformMatrices,
  relativeEntityTransform,
} from '../src/core/transform-math.mjs';

function assertClose(actual, expected, tolerance = 1e-10) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    assert.ok(
      Math.abs(value - expected[index]) <= tolerance,
      `value[${index}] ${value} differs from ${expected[index]}`,
    );
  });
}

test('composeTransformMatrix matches Three.js XYZ Euler TRS conventions', () => {
  assertClose(composeTransformMatrix({
    position: [3, 4, 5],
    rotation: [0, 0, Math.PI / 2],
    scale: [2, 3, 4],
  }), [
    0, 2, 0, 0,
    -3, 0, 0, 0,
    0, 0, 4, 0,
    3, 4, 5, 1,
  ]);
});

test('decomposeTransformMatrix round-trips general decomposable XYZ transforms', () => {
  const source = {
    position: [-2.5, 8.25, 0.125],
    rotation: [0.37, -0.62, 1.14],
    scale: [1.75, 0.8, 3.2],
  };
  const matrix = composeTransformMatrix(source);
  const decomposed = decomposeTransformMatrix(matrix);
  assertClose(composeTransformMatrix(decomposed), matrix);
});

test('decomposition preserves a valid equivalent representation for negative scale', () => {
  const matrix = composeTransformMatrix({
    position: [1, 2, 3],
    rotation: [-0.3, 0.7, 2.1],
    scale: [-2, 3, 4],
  });
  const decomposed = decomposeTransformMatrix(matrix);
  assert.ok(decomposed.scale.every(component => component !== 0));
  assertClose(composeTransformMatrix(decomposed), matrix);
});

test('composeEntityTransforms returns the exact representable parent-child product', () => {
  const parent = {
    position: [10, -2, 4],
    rotation: [0.2, 0.4, -0.35],
    scale: [2, 2, 2],
  };
  const child = {
    position: [1, 3, -2],
    rotation: [-0.1, 0.5, 0.7],
    scale: [0.5, 1.25, 3],
  };
  const expected = multiplyTransformMatrices(
    composeTransformMatrix(parent),
    composeTransformMatrix(child),
  );
  const composed = composeEntityTransforms(parent, child);
  assertClose(composeTransformMatrix(composed), expected);
});

test('composeEntityTransforms refuses a sheared product instead of drifting world placement', () => {
  assert.throws(
    () => composeEntityTransforms(
      { position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 1, 1] },
      { position: [0, 0, 0], rotation: [0, 0, Math.PI / 4], scale: [1, 1, 1] },
    ),
    error => error instanceof StudioError
      && error.code === 'non_decomposable_transform'
      && /shear/.test(error.message),
  );
});

test('invertTransformMatrix is a two-sided inverse for affine TRS matrices', () => {
  const matrix = composeTransformMatrix({
    position: [7, -3, 11],
    rotation: [0.45, -1.1, 0.2],
    scale: [-2, 0.75, 4],
  });
  const inverse = invertTransformMatrix(matrix);
  const identity = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
  assertClose(multiplyTransformMatrices(matrix, inverse), identity);
  assertClose(multiplyTransformMatrices(inverse, matrix), identity);
});

test('relativeEntityTransform recovers local TRS before decomposing a sheared world matrix', () => {
  const parentWorld = composeTransformMatrix({
    position: [4, -8, 2],
    rotation: [0.3, 0.7, -0.4],
    scale: [2, 0.75, 3],
  });
  const originalLocal = composeTransformMatrix({
    position: [1, 5, -2],
    rotation: [-0.25, 0.6, 1.2],
    scale: [0.5, 1.4, 2.25],
  });
  const childWorld = multiplyTransformMatrices(parentWorld, originalLocal);
  const recovered = relativeEntityTransform(parentWorld, childWorld);
  const recoveredLocal = composeTransformMatrix(recovered);
  assertClose(recoveredLocal, originalLocal);
  assertClose(multiplyTransformMatrices(parentWorld, recoveredLocal), childWorld);
});

test('invertTransformMatrix rejects singular and projective matrices', () => {
  const singular = composeTransformMatrix({});
  singular[0] = 0;
  assert.throws(
    () => invertTransformMatrix(singular),
    error => error instanceof StudioError
      && error.code === 'non_invertible_transform'
      && /singular/.test(error.message),
  );

  const projective = composeTransformMatrix({});
  projective[7] = 0.25;
  assert.throws(
    () => invertTransformMatrix(projective),
    error => error instanceof StudioError && error.code === 'non_invertible_transform',
  );
});

test('transform math rejects malformed, projective, and zero-scale inputs', () => {
  assert.throws(
    () => composeTransformMatrix({ scale: [1, 0, 1] }),
    error => error instanceof StudioError && error.code === 'invalid_transform',
  );
  assert.throws(
    () => multiplyTransformMatrices(Array(15).fill(0), Array(16).fill(0)),
    error => error instanceof StudioError && error.code === 'invalid_transform_matrix',
  );
  const projective = composeTransformMatrix({});
  projective[3] = 0.5;
  assert.throws(
    () => decomposeTransformMatrix(projective),
    error => error instanceof StudioError && error.code === 'non_decomposable_transform',
  );
});
