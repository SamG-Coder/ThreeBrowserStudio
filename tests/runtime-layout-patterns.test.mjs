import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateInstanceStack } from '../src/runtime/object-evaluation.mjs';

const identity = () => [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

class Matrix4 {
  constructor() {
    this.elements = identity();
  }

  clone() {
    const clone = new Matrix4();
    clone.elements = [...this.elements];
    return clone;
  }

  multiply(other) {
    const left = this.elements;
    const right = other.elements;
    const result = Array(16).fill(0);
    for (let column = 0; column < 4; column += 1) {
      for (let row = 0; row < 4; row += 1) {
        for (let index = 0; index < 4; index += 1) {
          result[column * 4 + row] += left[index * 4 + row] * right[column * 4 + index];
        }
      }
    }
    this.elements = result;
    return this;
  }

  makeTranslation(x, y, z) {
    this.elements = identity();
    this.elements[12] = x;
    this.elements[13] = y;
    this.elements[14] = z;
    return this;
  }

  makeScale(x, y, z) {
    this.elements = identity();
    this.elements[0] = x;
    this.elements[5] = y;
    this.elements[10] = z;
    return this;
  }

  makeRotationX(angle) {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    this.elements = [
      1, 0, 0, 0,
      0, cosine, sine, 0,
      0, -sine, cosine, 0,
      0, 0, 0, 1,
    ];
    return this;
  }

  makeRotationY(angle) {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    this.elements = [
      cosine, 0, -sine, 0,
      0, 1, 0, 0,
      sine, 0, cosine, 0,
      0, 0, 0, 1,
    ];
    return this;
  }

  makeRotationZ(angle) {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    this.elements = [
      cosine, sine, 0, 0,
      -sine, cosine, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ];
    return this;
  }
}

const THREE = { Matrix4 };

function subject(pattern) {
  return {
    id: 'entity/source',
    components: {
      mesh: {},
      modifiers: [{ type: 'pattern', ...pattern }],
    },
  };
}

function matrixTranslation(matrix) {
  return matrix.elements.slice(12, 15);
}

function assertMatrixClose(actual, expected, epsilon = 1e-12) {
  assert.equal(actual.length, 16);
  assert.equal(expected.length, 16);
  actual.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) <= epsilon, `matrix[${index}] ${value} != ${expected[index]}`);
  });
}

test('linear pattern emits exact source-relative translations', () => {
  const matrices = evaluateInstanceStack(THREE, subject({
    id: 'modifier/linear', mode: 'linear', count: 3, offset: [2, -1, 0.5],
  }));
  assert.deepEqual(matrices.map(matrixTranslation), [
    [0, 0, 0],
    [2, -1, 0.5],
    [4, -2, 1],
  ]);
});

test('grid pattern orders x fastest, then y, then z', () => {
  const matrices = evaluateInstanceStack(THREE, subject({
    id: 'modifier/grid', mode: 'grid', counts: [2, 2, 2], spacing: [3, 5, 7],
  }));
  assert.deepEqual(matrices.map(matrixTranslation), [
    [0, 0, 0], [3, 0, 0],
    [0, 5, 0], [3, 5, 0],
    [0, 0, 7], [3, 0, 7],
    [0, 5, 7], [3, 5, 7],
  ]);
});

test('closed radial pattern emits exact y-axis positions and radial orientations', () => {
  const matrices = evaluateInstanceStack(THREE, subject({
    id: 'modifier/radial',
    mode: 'radial',
    count: 4,
    axis: 'y',
    center: [1, 2, 3],
    radius: 2,
    startAngle: 0,
    arc: Math.PI * 2,
    closed: true,
    orientation: 'radial',
  }));

  const expected = [
    { angle: 0, position: [3, 2, 3] },
    { angle: Math.PI / 2, position: [1, 2, 1] },
    { angle: Math.PI, position: [-1, 2, 3] },
    { angle: Math.PI * 1.5, position: [1, 2, 5] },
  ];
  matrices.forEach((matrix, index) => {
    const rotation = new Matrix4().makeRotationY(expected[index].angle);
    const composed = new Matrix4().makeTranslation(...expected[index].position).multiply(rotation);
    assertMatrixClose(matrix.elements, composed.elements);
  });
});

test('open radial tangent patterns include both arc endpoints', () => {
  const matrices = evaluateInstanceStack(THREE, subject({
    id: 'modifier/open-radial',
    mode: 'radial',
    count: 3,
    axis: 'z',
    center: [0, 0, 0],
    radius: 4,
    startAngle: 0,
    arc: Math.PI,
    closed: false,
    orientation: 'tangent',
  }));
  assert.deepEqual(matrices.map(matrixTranslation).map(values => values.map(value => Math.round(value * 1e12) / 1e12)), [
    [4, 0, 0],
    [0, 4, 0],
    [-4, 0, 0],
  ]);
  const expectedLast = new Matrix4()
    .makeTranslation(-4, 0, 0)
    .multiply(new Matrix4().makeRotationZ(Math.PI * 1.5));
  assertMatrixClose(matrices[2].elements, expectedLast.elements);
});
