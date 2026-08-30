import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FLOAT_CURVE_CHANNELS,
  RGB_CURVE_CHANNELS,
  VECTOR_CURVE_CHANNELS,
  compileCurveMapping,
  createFloatCurveMapping,
  createRgbCurveMapping,
  createVectorCurveMapping,
  evaluateFloatCurveMapping,
  evaluateRgbCurveMapping,
  evaluateVectorCurveMapping,
} from '../src/runtime/blender-curve-mapping.mjs';
import { compileProceduralTextureGraph } from '../src/runtime/procedural-texture-compiler.mjs';
import { compileShaderGraph } from '../src/runtime/shader-graph-compiler.mjs';

function raw(value) { return value instanceof EvalNode ? value.value : value; }
function unary(value, operation) {
  const source = raw(value);
  return new EvalNode(Array.isArray(source) ? source.map(operation) : operation(source));
}
function binary(leftValue, rightValue, operation) {
  const left = raw(leftValue);
  const right = raw(rightValue);
  if (!Array.isArray(left) && !Array.isArray(right)) return new EvalNode(operation(left, right));
  const length = Array.isArray(left) ? left.length : right.length;
  return new EvalNode(Array.from({ length }, (_, index) => operation(
    Array.isArray(left) ? left[index] : left,
    Array.isArray(right) ? right[index] : right,
  )));
}

class EvalNode {
  constructor(value) { this.value = value; }
  add(value) { return binary(this, value, (left, right) => left + right); }
  sub(value) { return binary(this, value, (left, right) => left - right); }
  mul(value) { return binary(this, value, (left, right) => left * right); }
  div(value) { return binary(this, value, (left, right) => left / right); }
  get x() { return new EvalNode(Array.isArray(this.value) ? this.value[0] : this.value); }
  get y() { return new EvalNode(Array.isArray(this.value) ? this.value[1] : this.value); }
  get z() { return new EvalNode(Array.isArray(this.value) ? this.value[2] : this.value); }
  get w() { return new EvalNode(Array.isArray(this.value) ? this.value[3] : this.value); }
  get xyz() { return new EvalNode(Array.isArray(this.value) ? this.value.slice(0, 3) : [this.value, this.value, this.value]); }
}

function vector(length, values) {
  const flattened = values.flatMap(value => Array.isArray(raw(value)) ? raw(value) : [raw(value)]);
  return new EvalNode(flattened.length === 1 ? Array(length).fill(flattened[0]) : flattened.slice(0, length));
}

const EVAL_TSL = Object.freeze({
  float: value => new EvalNode(raw(value)),
  int: value => new EvalNode(Math.trunc(raw(value))),
  vec3: (...values) => vector(3, values),
  vec4: (...values) => vector(4, values),
  floor: value => unary(value, Math.floor),
  min: (left, right) => binary(left, right, Math.min),
  clamp: (value, low, high) => binary(binary(value, low, Math.max), high, Math.min),
  mix: (left, right, factor) => binary(left, binary(binary(right, left, (a, b) => a - b), factor, (a, b) => a * b), (a, b) => a + b),
  lessThan: (left, right) => binary(left, right, (a, b) => a < b),
  greaterThan: (left, right) => binary(left, right, (a, b) => a > b),
  select: (condition, whenTrue, whenFalse) => raw(condition) ? whenTrue : whenFalse,
  buffer(data, type, count) {
    assert.equal(type, 'vec4');
    assert.equal(data.length, count * 4);
    return Object.freeze({
      element(index) {
        const offset = Math.trunc(raw(index)) * 4;
        return new EvalNode(Array.from(data.slice(offset, offset + 4)));
      },
    });
  },
});

function point(x, y, handleType = 'VECTOR') {
  return { location: [x, y], handleType };
}

function close(actual, expected, epsilon = 3e-5) {
  const received = raw(actual);
  if (Array.isArray(expected)) {
    assert.equal(received.length, expected.length);
    expected.forEach((value, index) => assert.ok(
      Math.abs(received[index] - value) <= epsilon,
      `${received[index]} != ${value} at ${index}`,
    ));
    return;
  }
  assert.ok(Math.abs(received - expected) <= epsilon, `${received} != ${expected}`);
}

function curveGraph() {
  const floatMapping = createFloatCurveMapping();
  floatMapping.curves.value = [point(0, 0), point(0.5, 1), point(1, 0)];

  const rgbMapping = createRgbCurveMapping();
  rgbMapping.clip.enabled = false;
  rgbMapping.curves.combined = [point(0, 0), point(1, 0.5)];
  rgbMapping.curves.red = [point(0, 0), point(1, 2)];
  rgbMapping.curves.green = [point(0, 0), point(1, 1)];
  rgbMapping.curves.blue = [point(0, 1), point(1, 0)];

  const vectorMapping = createVectorCurveMapping();
  vectorMapping.curves.y = [point(-1, 1), point(1, -1)];
  vectorMapping.curves.z = [point(-1, 0), point(1, 1)];

  return {
    formatVersion: 1,
    id: 'shader/curve-node-parity',
    domain: 'shader',
    nodes: [
      { id: 'float', type: 'ShaderNodeFloatCurve', params: { mapping: floatMapping }, inputs: { factor: 2, value: 0.25 } },
      { id: 'rgb', type: 'blender.rgbCurve', params: { mapping: rgbMapping }, inputs: { factor: 1, color: [0.8, 0.4, 0.2, 0.37] } },
      { id: 'vector', type: 'ShaderNodeVectorCurve', params: { mapping: vectorMapping }, inputs: { factor: 0.5, vector: [0.2, 0.25, -0.5] } },
    ],
    edges: [],
    outputs: {
      baseColor: { nodeId: 'rgb', port: 'color' },
      roughness: { nodeId: 'float', port: 'value' },
      normal: { nodeId: 'vector', port: 'vector' },
    },
  };
}

test('Float, RGB, and Vector Curve nodes share exact CPU/live LUT evaluation and one pooled buffer', () => {
  const graph = curveGraph();
  const live = compileShaderGraph({ TSL: EVAL_TSL, graph });
  const cpu = compileProceduralTextureGraph(graph).sample([0.5, 0.5]);

  const floatCompiled = compileCurveMapping(graph.nodes[0].params.mapping, FLOAT_CURVE_CHANNELS);
  const rgbCompiled = compileCurveMapping(graph.nodes[1].params.mapping, RGB_CURVE_CHANNELS);
  const vectorCompiled = compileCurveMapping(graph.nodes[2].params.mapping, VECTOR_CURVE_CHANNELS);
  const expectedFloat = evaluateFloatCurveMapping(floatCompiled, 0.25, 2);
  const expectedRgb = evaluateRgbCurveMapping(rgbCompiled, [0.8, 0.4, 0.2, 0.37], 1);
  const expectedVector = evaluateVectorCurveMapping(vectorCompiled, [0.2, 0.25, -0.5], 0.5);

  close(live.outputs.roughness, expectedFloat);
  close(live.outputs.baseColor, expectedRgb);
  close(live.outputs.normal, expectedVector);
  close(cpu.roughness, expectedFloat);
  close(cpu.albedo, expectedRgb);
  close(cpu.normal, expectedVector);
  assert.equal(raw(live.outputs.baseColor)[3], 0.37);
  assert.equal(cpu.albedo[3], 0.37);
  assert.equal(live.curveTableCount, 3);
  assert.equal(live.curveTableBytes, 3 * 257 * 4 * Float32Array.BYTES_PER_ELEMENT);
});

