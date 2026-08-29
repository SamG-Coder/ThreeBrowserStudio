import assert from 'node:assert/strict';
import test from 'node:test';

import { compileShaderGraph } from '../src/runtime/shader-graph-compiler.mjs';

function raw(value) { return value instanceof EvalNode ? value.value : value; }
function arrayValue(value) { return Array.isArray(raw(value)) ? raw(value) : null; }
function unary(value, operation) {
  const source = raw(value);
  return new EvalNode(Array.isArray(source) ? source.map(operation) : operation(source));
}
function binary(a, b, operation) {
  const left = raw(a); const right = raw(b);
  const leftArray = Array.isArray(left); const rightArray = Array.isArray(right);
  if (!leftArray && !rightArray) return new EvalNode(operation(left, right));
  const length = leftArray ? left.length : right.length;
  return new EvalNode(Array.from({ length }, (_, index) => operation(
    leftArray ? left[index] : left,
    rightArray ? right[index] : right,
  )));
}

class EvalNode {
  constructor(value) { this.value = value; }
  add(value) { return binary(this, value, (a, b) => a + b); }
  sub(value) { return binary(this, value, (a, b) => a - b); }
  mul(value) { return binary(this, value, (a, b) => a * b); }
  div(value) { return binary(this, value, (a, b) => a / b); }
  saturate() { return unary(this, value => Math.min(1, Math.max(0, value))); }
  get x() { return new EvalNode(arrayValue(this)?.[0] ?? raw(this)); }
  get y() { return new EvalNode(arrayValue(this)?.[1] ?? raw(this)); }
  get z() { return new EvalNode(arrayValue(this)?.[2] ?? raw(this)); }
  get w() { return new EvalNode(arrayValue(this)?.[3] ?? raw(this)); }
  get xyz() {
    const source = arrayValue(this);
    return new EvalNode(source ? source.slice(0, 3) : [raw(this), raw(this), raw(this)]);
  }
}

function vector(length, values) {
  const flattened = values.flatMap(value => {
    const source = raw(value);
    return Array.isArray(source) ? source : [source];
  });
  if (flattened.length === 1) return new EvalNode(Array(length).fill(flattened[0]));
  return new EvalNode(flattened.slice(0, length));
}

const EVAL_TSL = Object.freeze({
  float: value => new EvalNode(raw(value)),
  vec2: (...values) => vector(2, values),
  vec3: (...values) => vector(3, values),
  vec4: (...values) => vector(4, values),
  abs: value => unary(value, Math.abs),
  fract: value => unary(value, entry => entry - Math.floor(entry)),
  min: (a, b) => binary(a, b, Math.min),
  max: (a, b) => binary(a, b, Math.max),
  clamp: (value, low, high) => binary(binary(value, low, Math.max), high, Math.min),
  mix: (a, b, factor) => binary(a, binary(binary(b, a, (right, left) => right - left), factor, (delta, amount) => delta * amount), (left, scaled) => left + scaled),
  step: (edge, value) => binary(edge, value, (threshold, entry) => entry < threshold ? 0 : 1),
  smoothstep: (edge0, edge1, value) => {
    const amount = binary(binary(value, edge0, (entry, low) => entry - low), binary(edge1, edge0, (high, low) => high - low), (entry, width) => Math.min(1, Math.max(0, entry / width)));
    return binary(binary(amount, amount, (a, b) => a * b), binary(new EvalNode(3), binary(amount, 2, (a, b) => a * b), (three, twice) => three - twice), (squared, curve) => squared * curve);
  },
});

function close(actual, expected, epsilon = 1e-6) {
  if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length);
    expected.forEach((value, index) => assert.ok(Math.abs(actual[index] - value) <= epsilon, `${actual[index]} != ${value} at ${index}`));
  } else assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

let graphIndex = 0;
function compileNode({ type, params = {}, inputs = {}, port, output = 'baseColor' }) {
  const graph = {
    formatVersion: 1,
    id: `shader/color-node-${graphIndex += 1}`,
    domain: 'shader',
    nodes: [{ id: 'node', type, params, inputs }],
    edges: [],
    outputs: { [output]: { nodeId: 'node', port } },
  };
  return raw(compileShaderGraph({ TSL: EVAL_TSL, graph }).outputs[output]);
}

test('Separate and Combine Color evaluate RGB, HSV, and HSL live', () => {
  close(compileNode({
    type: 'ShaderNodeSeparateColor', params: { mode: 'HSV' }, inputs: { color: [0, 1, 1, 1] }, port: 'red', output: 'roughness',
  }), 0.5);
  close(compileNode({
    type: 'ShaderNodeSeparateColor', params: { mode: 'HSL' }, inputs: { color: [0.5, 0.5, 0.5, 1] }, port: 'green', output: 'roughness',
  }), 0);

  close(compileNode({
    type: 'ShaderNodeCombineColor', params: { mode: 'HSV' }, inputs: { red: 1 / 3, green: 1, blue: 1, alpha: 0.4 }, port: 'color',
  }), [0, 1, 0, 0.4]);
  close(compileNode({
    type: 'ShaderNodeCombineColor', params: { mode: 'HSL' }, inputs: { red: 2 / 3, green: 1, blue: 0.5, alpha: 0.7 }, port: 'color',
  }), [0, 0, 1, 0.7]);
});

test('Mix evaluates all catalogued component-transfer blend modes', () => {
  const evaluate = (blendMode, a, b) => compileNode({
    type: 'ShaderNodeMix',
    params: { valueType: 'color', blendMode, clampFactor: true, clampResult: false },
    inputs: { factor: 1, a: [...a, 1], b: [...b, 1] },
    port: 'result',
  });

  close(evaluate('HUE', [1, 0, 0], [0, 1, 0]), [0, 1, 0]);
  close(evaluate('HUE', [1, 0, 0], [0.5, 0.5, 0.5]), [1, 0, 0]);
  close(evaluate('SATURATION', [1, 0, 0], [0.5, 0.5, 0.5]), [1, 1, 1]);
  close(evaluate('COLOR', [0.25, 0.25, 0.25], [0, 0, 1]), [0, 0, 0.25]);
  close(evaluate('VALUE', [1, 0, 0], [0, 0, 0]), [0, 0, 0]);
});

const hueStops = [
  { position: 0, color: [1, 0, 0.3, 0.2] },
  { position: 1, color: [1, 0.3, 0, 0.8] },
];

test('Color Ramp evaluates every hue direction and forces non-RGB interpolation to linear', () => {
  const ramp = (hueInterpolation, interpolation = 'LINEAR', stops = hueStops) => compileNode({
    type: 'ShaderNodeValToRGB',
    params: { colorMode: 'HSV', hueInterpolation, interpolation, stops },
    inputs: { factor: 0.5 },
    port: 'color',
  });

  close(ramp('NEAR'), [1, 0, 0]);
  close(ramp('FAR'), [0, 1, 1]);
  close(ramp('CW'), [1, 0, 0]);
  close(ramp('CCW'), [0, 1, 1]);
  close(ramp('NEAR', 'B_SPLINE'), ramp('NEAR', 'LINEAR'));
  close(ramp('FAR', 'CARDINAL'), ramp('FAR', 'LINEAR'));

  const equalHue = [
    { position: 0, color: [1, 0, 0, 1] },
    { position: 1, color: [1, 0, 0, 1] },
  ];
  close(ramp('FAR', 'LINEAR', equalHue), [0, 1, 1]);
});

test('RGB Color Ramp compiles exact Cardinal/B-spline neighborhoods and duplicate stops', () => {
  const stops = [
    { position: 0, color: [1, 0, 0, 1] },
    { position: 0.33, color: [0, 1, 0, 0.8] },
    { position: 0.66, color: [0, 0, 1, 0.4] },
    { position: 1, color: [1, 1, 1, 0] },
  ];
  const evaluate = (interpolation, factor, customStops = stops, port = 'color', output = 'baseColor') => compileNode({
    type: 'ShaderNodeValToRGB',
    params: { colorMode: 'RGB', hueInterpolation: 'NEAR', interpolation, stops: customStops },
    inputs: { factor }, port, output,
  });

  const splineStart = evaluate('B_SPLINE', 0);
  assert.ok(splineStart[0] < 1 && splineStart[1] > 0, 'B-spline endpoint uses its four-stop basis');
  close(evaluate('CARDINAL', 0.33), [0, 1, 0]);
  const splineAlpha = evaluate('B_SPLINE', 0.5, stops, 'alpha', 'opacity');
  assert.ok(splineAlpha > 0.4 && splineAlpha < 0.8);

  const duplicate = [
    { position: 0, color: [1, 0, 0, 1] },
    { position: 0.5, color: [0, 1, 0, 1] },
    { position: 0.5, color: [0, 0, 1, 1] },
    { position: 1, color: [1, 1, 1, 1] },
  ];
  close(evaluate('LINEAR', 0.5, duplicate), [0, 0, 1]);
});
