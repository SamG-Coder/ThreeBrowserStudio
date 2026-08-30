import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BLENDER_SHADER_NODE_INVENTORY_SUMMARY,
  GRAPH_CATALOGS,
  isCompiledShaderNodeType,
  queryBlenderShaderNodeInventory,
  validateGraph,
} from '../src/graphs/index.mjs';
import {
  BLENDER_SHADER_NODE_ALIASES,
  compileShaderGraph,
} from '../src/runtime/shader-graph-compiler.mjs';

class EvalNode {
  constructor(value) { this.value = value; }
  add(value) { return wrap(binary(this.value, raw(value), (a, b) => a + b)); }
  sub(value) { return wrap(binary(this.value, raw(value), (a, b) => a - b)); }
  mul(value) { return wrap(binary(this.value, raw(value), (a, b) => a * b)); }
  div(value) { return wrap(binary(this.value, raw(value), (a, b) => a / b)); }
  normalize() { return normalize(this); }
  get x() { return wrap(component(this.value, 0)); }
  get y() { return wrap(component(this.value, 1)); }
  get z() { return wrap(component(this.value, 2)); }
  get xyz() { return wrap(Array.isArray(this.value) ? this.value.slice(0, 3) : [this.value, this.value, this.value]); }
}

function raw(value) { return value instanceof EvalNode ? value.value : value; }
function wrap(value) { return new EvalNode(value); }
function component(value, index) { return Array.isArray(value) ? value[index] : value; }
function binary(left, right, operation) {
  if (!Array.isArray(left) && !Array.isArray(right)) return operation(left, right);
  const length = Math.max(Array.isArray(left) ? left.length : 1, Array.isArray(right) ? right.length : 1);
  return Array.from({ length }, (_, index) => operation(component(left, index), component(right, index)));
}
function flatten(values) { return values.flatMap(value => Array.isArray(raw(value)) ? raw(value) : [raw(value)]); }
function vector(length, values) { return wrap(flatten(values).slice(0, length)); }
function magnitude(value) { return Math.hypot(...raw(value)); }
function normalize(value) {
  const length = magnitude(value);
  return wrap(raw(value).map(entry => entry / length));
}

const EVAL_TSL = Object.freeze({
  int: value => wrap(Math.trunc(raw(value))),
  float: value => wrap(raw(value)),
  vec2: (...values) => vector(2, values),
  vec3: (...values) => vector(3, values),
  vec4: (...values) => vector(4, values),
  abs: value => wrap(Array.isArray(raw(value)) ? raw(value).map(Math.abs) : Math.abs(raw(value))),
  max: (left, right) => wrap(binary(raw(left), raw(right), Math.max)),
  lessThan: (left, right) => wrap(raw(left) < raw(right)),
  select: (condition, whenTrue, whenFalse) => raw(condition) ? whenTrue : whenFalse,
  length: value => wrap(magnitude(value)),
  normalize,
  sin: value => wrap(Math.sin(raw(value))),
  cos: value => wrap(Math.cos(raw(value))),
  dot: (left, right) => wrap(raw(left).reduce((sum, entry, index) => sum + entry * raw(right)[index], 0)),
  cross: (left, right) => {
    const a = raw(left); const b = raw(right);
    return wrap([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
  },
  positionView: wrap([0, 0, -5]),
  normalWorld: wrap([0, 0, 1]),
  normalLocal: wrap([0, 0, 1]),
});

const LIVE_TYPES = Object.freeze([
  'FunctionNodeInputInt',
  'ShaderNodeCameraData',
  'ShaderNodeNormal',
  'ShaderNodeVectorRotate',
  'ShaderNodeDisplacement',
  'ShaderNodeVectorDisplacement',
]);

function shaderGraph(id, node, outputName, port) {
  return {
    formatVersion: 1,
    id: `shader/${id}`,
    domain: 'shader',
    nodes: [{ id: 'node', ...node }],
    edges: [],
    outputs: { [outputName]: { nodeId: 'node', port } },
  };
}

function compile(graph) {
  const validation = validateGraph(graph);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  return compileShaderGraph({ TSL: EVAL_TSL, graph }).outputs;
}

test('six bounded Blender numeric and vector utilities are discoverable as live TSL', () => {
  for (const type of LIVE_TYPES) {
    assert.ok(GRAPH_CATALOGS.shader.nodes[type], type);
    assert.equal(isCompiledShaderNodeType('shader', type), true, type);
    assert.ok(BLENDER_SHADER_NODE_ALIASES[type]?.startsWith('blender.'), type);
  }
  assert.equal(BLENDER_SHADER_NODE_INVENTORY_SUMMARY.liveTsl, 51);
  assert.equal(BLENDER_SHADER_NODE_INVENTORY_SUMMARY.catalogued, 64);
  assert.deepEqual(
    queryBlenderShaderNodeInventory({ status: 'live-tsl' }).nodes
      .filter(node => LIVE_TYPES.includes(node.id))
      .map(node => node.id),
    [...LIVE_TYPES].sort(),
  );
  assert.deepEqual(
    Object.keys(GRAPH_CATALOGS.shader.nodes.ShaderNodeDisplacement.inputs),
    ['height', 'midlevel', 'scale', 'normal'],
  );
  assert.deepEqual(
    GRAPH_CATALOGS.shader.nodes.ShaderNodeDisplacement.params.space.values,
    ['OBJECT'],
  );
  assert.deepEqual(
    GRAPH_CATALOGS.shader.nodes.ShaderNodeVectorDisplacement.params.space.values,
    ['OBJECT'],
  );
});

test('Integer and Camera Data compile exact bounded values', () => {
  const integer = compile({
    formatVersion: 1,
    id: 'shader/integer',
    domain: 'shader',
    nodes: [
      { id: 'integer', type: 'FunctionNodeInputInt', params: { value: -17 } },
      { id: 'math', type: 'ShaderNodeMath', params: { operation: 'ADD', clamp: false }, inputs: { valueB: 0 } },
    ],
    edges: [{
      from: { nodeId: 'integer', port: 'Integer' },
      to: { nodeId: 'math', port: 'Value' },
    }],
    outputs: { roughness: { nodeId: 'math', port: 'Value' } },
  });
  assert.equal(raw(integer.roughness), -17);

  const distance = compile(shaderGraph(
    'camera-distance',
    { type: 'ShaderNodeCameraData', params: {} },
    'roughness',
    'View Distance',
  ));
  const depth = compile(shaderGraph(
    'camera-depth',
    { type: 'ShaderNodeCameraData', params: {} },
    'roughness',
    'View Z Depth',
  ));
  const viewVector = compile(shaderGraph(
    'camera-view-vector',
    { type: 'ShaderNodeCameraData', params: {} },
    'emissive',
    'View Vector',
  ));
  assert.equal(raw(distance.roughness), 5);
  assert.equal(raw(depth.roughness), 5);
  assert.deepEqual(raw(viewVector.emissive), [0, 0, -1]);
});

test('Normal and Vector Rotate execute their vector math live', () => {
  const normalDot = compile(shaderGraph(
    'normal-dot',
    { type: 'ShaderNodeNormal', params: {}, inputs: { Normal: [0, 1, 0] } },
    'roughness',
    'Dot',
  ));
  assert.equal(raw(normalDot.roughness), 0);

  const evaluateRotation = ({ rotationType, vector, axis, angle, rotation, invert = false }) => raw(compile(shaderGraph(
    `vector-rotate-${rotationType.toLowerCase()}`,
    {
      type: 'ShaderNodeVectorRotate',
      params: { rotationType, invert },
      inputs: {
        Vector: vector,
        Center: [0, 0, 0],
        ...(axis ? { Axis: axis } : {}),
        ...(angle !== undefined ? { Angle: angle } : {}),
        ...(rotation ? { Rotation: rotation } : {}),
      },
    },
    'positionOffset',
    'Vector',
  )).positionOffset);

  const result = evaluateRotation({
    rotationType: 'Z_AXIS', vector: [1, 0, 0], angle: Math.PI / 2,
  });
  assert.ok(Math.abs(result[0]) < 1e-12);
  assert.ok(Math.abs(result[1] - 1) < 1e-12);
  assert.ok(Math.abs(result[2]) < 1e-12);

  assert.deepEqual(evaluateRotation({
    rotationType: 'AXIS_ANGLE', vector: [1, 2, 3], axis: [0, 0, 0], angle: 1,
  }), [1, 2, 3]);

  const original = [0.2, 0.4, -0.1];
  const euler = [0.3, -0.5, 0.7];
  const forward = evaluateRotation({ rotationType: 'EULER_XYZ', vector: original, rotation: euler });
  const restored = evaluateRotation({ rotationType: 'EULER_XYZ', vector: forward, rotation: euler, invert: true });
  restored.forEach((value, index) => assert.ok(Math.abs(value - original[index]) < 1e-12));
});

test('scalar and vector displacement compile only the honest local-space subset', () => {
  const scalar = compile(shaderGraph(
    'scalar-displacement',
    {
      type: 'ShaderNodeDisplacement',
      params: { space: 'OBJECT' },
      inputs: { Height: 0.75, Midlevel: 0.5, Scale: 2, Normal: [0, 1, 0] },
    },
    'positionOffset',
    'Displacement',
  ));
  assert.deepEqual(raw(scalar.positionOffset), [0, 0.5, 0]);

  const vectorResult = compile(shaderGraph(
    'vector-displacement',
    {
      type: 'ShaderNodeVectorDisplacement',
      params: { space: 'OBJECT' },
      inputs: { Vector: [1, 0.25, 0.5], Midlevel: 0.5, Scale: 2 },
    },
    'positionOffset',
    'Displacement',
  ));
  assert.deepEqual(raw(vectorResult.positionOffset), [1, -0.5, 0]);

  const unsupportedWorld = shaderGraph(
    'world-displacement',
    { type: 'ShaderNodeDisplacement', params: { space: 'WORLD' } },
    'positionOffset',
    'Displacement',
  );
  assert.ok(validateGraph(unsupportedWorld).errors.some(error => (
    error.code === 'invalid_parameter' && error.path === '/nodes/0/params/space'
  )));
});
