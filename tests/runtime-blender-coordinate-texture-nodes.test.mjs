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
  get x() { return wrap(component(this.value, 0)); }
  get y() { return wrap(component(this.value, 1)); }
  get z() { return wrap(component(this.value, 2)); }
  get w() { return wrap(component(this.value, 3)); }
  get a() { return this.w; }
  get xy() { return wrap(vectorValue(this.value, 2)); }
  get xyz() { return wrap(vectorValue(this.value, 3)); }
  get rgb() { return this.xyz; }
}

class ScaleMatrix {
  constructor(scale) { this.scale = scale; }
  mul(value) {
    const entries = raw(value);
    return wrap([
      entries[0] * this.scale[0],
      entries[1] * this.scale[1],
      entries[2] * this.scale[2],
      entries[3],
    ]);
  }
}

function raw(value) { return value instanceof EvalNode ? value.value : value; }
function wrap(value) { return value instanceof EvalNode ? value : new EvalNode(value); }
function component(value, index) { return Array.isArray(value) ? value[index] : value; }
function vectorValue(value, length) {
  if (Array.isArray(value)) return value.slice(0, length);
  return Array(length).fill(value);
}
function binary(left, right, operation) {
  if (!Array.isArray(left) && !Array.isArray(right)) return operation(left, right);
  const length = Math.max(Array.isArray(left) ? left.length : 1, Array.isArray(right) ? right.length : 1);
  return Array.from({ length }, (_, index) => operation(component(left, index), component(right, index)));
}
function flatten(values) { return values.flatMap(value => Array.isArray(raw(value)) ? raw(value) : [raw(value)]); }
function vector(length, values) { return wrap(flatten(values).slice(0, length)); }
function unary(value, operation) {
  const source = raw(value);
  return wrap(Array.isArray(source) ? source.map(operation) : operation(source));
}
function clampValue(value, low, high) { return Math.min(Math.max(value, low), high); }
function srgbToLinear(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

const EVAL_TSL = Object.freeze({
  int: value => wrap(Math.trunc(raw(value))),
  float: value => wrap(raw(value)),
  vec2: (...values) => vector(2, values),
  vec3: (...values) => vector(3, values),
  vec4: (...values) => vector(4, values),
  abs: value => unary(value, Math.abs),
  atan: (y, x) => wrap(Math.atan2(raw(y), raw(x))),
  clamp: (value, low, high) => wrap(binary(binary(raw(value), raw(low), Math.max), raw(high), Math.min)),
  cos: value => unary(value, Math.cos),
  exp: value => unary(value, Math.exp),
  floor: value => unary(value, Math.floor),
  greaterThanEqual: (left, right) => wrap(raw(left) >= raw(right)),
  length: value => wrap(Math.hypot(...vectorValue(raw(value), raw(value).length))),
  lessThan: (left, right) => wrap(raw(left) < raw(right)),
  lessThanEqual: (left, right) => wrap(raw(left) <= raw(right)),
  log: value => unary(value, Math.log),
  max: (left, right) => wrap(binary(raw(left), raw(right), Math.max)),
  pow: (left, right) => wrap(binary(raw(left), raw(right), (a, b) => a ** b)),
  select: (condition, whenTrue, whenFalse) => raw(condition) ? wrap(whenTrue) : wrap(whenFalse),
  sin: value => unary(value, Math.sin),
  sRGBTransferEOTF: value => unary(value, srgbToLinear),
  texture: () => wrap([0.12, 0.34, 0.56, 0.78]),
  uv: () => wrap([0.25, 0.75]),
  tangentWorld: wrap([1, 0, 0]),
  modelWorldMatrix: new ScaleMatrix([2, 3, 4]),
  modelWorldMatrixInverse: new ScaleMatrix([0.5, 1 / 3, 0.25]),
});

const LIVE_TYPES = Object.freeze([
  'ShaderNodeUVMap',
  'ShaderNodeTexImage',
  'ShaderNodeTangent',
  'ShaderNodeVectorTransform',
  'ShaderNodeBlackbody',
  'ShaderNodeWavelength',
  'ShaderNodeRadialTiling',
]);

function graph(id, node, outputs) {
  return {
    formatVersion: 1,
    id: `shader/${id}`,
    domain: 'shader',
    nodes: [{ id: 'node', ...node }],
    edges: [],
    outputs,
  };
}

function compile(source, options = {}) {
  const validation = validateGraph(source);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  return compileShaderGraph({ TSL: EVAL_TSL, graph: source, ...options });
}

function samplerTexture(overrides = {}) {
  return {
    userData: {
      studioColorSpace: 'srgb',
      studioMinFilter: 'linearMipmapLinear',
      studioMagFilter: 'linear',
      studioWrapS: 'repeat',
      studioWrapT: 'repeat',
      ...overrides,
    },
  };
}

test('seven bounded Blender nodes are catalogued and reported as genuinely live TSL', () => {
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

  const image = GRAPH_CATALOGS.shader.nodes.ShaderNodeTexImage;
  assert.deepEqual(Object.keys(image.inputs), ['vector']);
  assert.deepEqual(Object.keys(image.outputs), ['color', 'alpha']);
  assert.deepEqual(image.params.projection.values, ['FLAT', 'BOX', 'SPHERE', 'TUBE']);
  assert.deepEqual(image.params.interpolation.values, ['LINEAR', 'CLOSEST', 'CUBIC', 'SMART']);
  assert.deepEqual(image.params.extension.values, ['REPEAT', 'EXTEND', 'CLIP', 'MIRROR']);
  assert.deepEqual(GRAPH_CATALOGS.shader.nodes.ShaderNodeTangent.stages, ['fragment']);
});

test('UV Map and Tangent expose only the active render UV live subset', () => {
  const uv = compile(graph(
    'active-uv',
    { type: 'ShaderNodeUVMap', params: { uvMap: '', fromInstancer: false } },
    { emissive: { nodeId: 'node', port: 'UV' } },
  ));
  assert.deepEqual(raw(uv.outputs.emissive), [0.25, 0.75, 0]);
  assert.equal(uv.requiresGeometryUv, true);

  const tangent = compile(graph(
    'active-tangent',
    { type: 'ShaderNodeTangent', params: { directionType: 'UV_MAP', axis: 'Z', uvMap: '' } },
    { normal: { nodeId: 'node', port: 'Tangent' } },
  ));
  assert.deepEqual(raw(tangent.outputs.normal), [1, 0, 0]);
  assert.equal(tangent.requiresGeometryUv, true);

  const named = graph(
    'named-uv',
    { type: 'ShaderNodeUVMap', params: { uvMap: 'DetailUV', fromInstancer: false } },
    { emissive: { nodeId: 'node', port: 'UV' } },
  );
  assert.throws(() => compileShaderGraph({ TSL: EVAL_TSL, graph: named }), error => (
    error.code === 'shader_named_uv_map_unsupported'
  ));

  const radial = graph(
    'radial-tangent',
    { type: 'ShaderNodeTangent', params: { directionType: 'RADIAL', axis: 'X', uvMap: '' } },
    { normal: { nodeId: 'node', port: 'Tangent' } },
  );
  assert.throws(() => compileShaderGraph({ TSL: EVAL_TSL, graph: radial }), error => (
    error.code === 'shader_node_mode_unsupported'
  ));

  const namedTangent = graph(
    'named-tangent',
    { type: 'ShaderNodeTangent', params: { directionType: 'UV_MAP', axis: 'Z', uvMap: 'DetailUV' } },
    { normal: { nodeId: 'node', port: 'Tangent' } },
  );
  assert.throws(() => compileShaderGraph({ TSL: EVAL_TSL, graph: namedTangent }), error => (
    error.code === 'shader_named_uv_map_unsupported'
  ));
});

test('Image Texture samples dataTexture resources with explicit sampler parity', () => {
  const source = graph(
    'image-texture',
    {
      type: 'ShaderNodeTexImage',
      params: {
        textureId: 'texture/albedo', colorSpace: 'srgb', projection: 'FLAT',
        interpolation: 'LINEAR', extension: 'REPEAT',
      },
    },
    {
      baseColor: { nodeId: 'node', port: 'Color' },
      opacity: { nodeId: 'node', port: 'Alpha' },
    },
  );
  const compiled = compile(source, { textureResolver: id => id === 'texture/albedo' ? samplerTexture() : null });
  assert.deepEqual(raw(compiled.outputs.baseColor), [0.12, 0.34, 0.56]);
  assert.equal(raw(compiled.outputs.opacity), 0.78);
  assert.deepEqual(compiled.textureIds, ['texture/albedo']);
  assert.equal(compiled.requiresGeometryUv, true);

  const closestMirror = structuredClone(source);
  closestMirror.id = 'shader/image-closest-mirror';
  closestMirror.nodes[0].params.interpolation = 'CLOSEST';
  closestMirror.nodes[0].params.extension = 'MIRROR';
  const closestTexture = samplerTexture({
    studioMinFilter: 'nearestMipmapNearest',
    studioMagFilter: 'nearest',
    studioWrapS: 'mirror',
    studioWrapT: 'mirror',
  });
  assert.deepEqual(
    raw(compile(closestMirror, { textureResolver: () => closestTexture }).outputs.baseColor),
    [0.12, 0.34, 0.56],
  );

  for (const [field, value, code] of [
    ['projection', 'BOX', 'shader_node_mode_unsupported'],
    ['interpolation', 'CUBIC', 'shader_node_mode_unsupported'],
    ['extension', 'CLIP', 'shader_node_mode_unsupported'],
  ]) {
    const unsupported = structuredClone(source);
    unsupported.id = `shader/image-${field.toLowerCase()}`;
    unsupported.nodes[0].params[field] = value;
    assert.throws(
      () => compileShaderGraph({ TSL: EVAL_TSL, graph: unsupported, textureResolver: () => samplerTexture() }),
      error => error.code === code,
    );
  }

  const mismatch = structuredClone(source);
  mismatch.id = 'shader/image-filter-mismatch';
  mismatch.nodes[0].params.interpolation = 'CLOSEST';
  assert.throws(
    () => compileShaderGraph({ TSL: EVAL_TSL, graph: mismatch, textureResolver: () => samplerTexture() }),
    error => error.code === 'graph_texture_filter_mismatch',
  );

  const extensionMismatch = structuredClone(source);
  extensionMismatch.id = 'shader/image-extension-mismatch';
  extensionMismatch.nodes[0].params.extension = 'EXTEND';
  assert.throws(
    () => compileShaderGraph({ TSL: EVAL_TSL, graph: extensionMismatch, textureResolver: () => samplerTexture() }),
    error => error.code === 'graph_texture_extension_mismatch',
  );
});

test('Vector Transform preserves vector magnitude across the OBJECT/WORLD subset', () => {
  const objectToWorld = compile(graph(
    'object-to-world',
    {
      type: 'ShaderNodeVectorTransform',
      params: { vectorType: 'VECTOR', convertFrom: 'OBJECT', convertTo: 'WORLD' },
      inputs: { Vector: [1, 2, 3] },
    },
    { positionOffset: { nodeId: 'node', port: 'Vector' } },
  ));
  assert.deepEqual(raw(objectToWorld.outputs.positionOffset), [2, 6, 12]);

  const worldToObject = compile(graph(
    'world-to-object',
    {
      type: 'ShaderNodeVectorTransform',
      params: { vectorType: 'VECTOR', convertFrom: 'WORLD', convertTo: 'OBJECT' },
      inputs: { Vector: [2, 6, 12] },
    },
    { positionOffset: { nodeId: 'node', port: 'Vector' } },
  ));
  assert.deepEqual(raw(worldToObject.outputs.positionOffset), [1, 2, 3]);

  for (const params of [
    { vectorType: 'POINT', convertFrom: 'OBJECT', convertTo: 'WORLD' },
    { vectorType: 'VECTOR', convertFrom: 'CAMERA', convertTo: 'WORLD' },
  ]) {
    const unsupported = graph(
      `transform-${params.vectorType.toLowerCase()}-${params.convertFrom.toLowerCase()}`,
      { type: 'ShaderNodeVectorTransform', params },
      { positionOffset: { nodeId: 'node', port: 'Vector' } },
    );
    assert.throws(() => compileShaderGraph({ TSL: EVAL_TSL, graph: unsupported }), error => (
      error.code === 'shader_node_mode_unsupported'
    ));
  }
});

test('Blackbody and Wavelength produce finite, physically ordered linear colours', () => {
  const evaluateBlackbody = temperature => raw(compile(graph(
    `blackbody-${temperature}`,
    { type: 'ShaderNodeBlackbody', params: {}, inputs: { Temperature: temperature } },
    { emissive: { nodeId: 'node', port: 'Color' } },
  )).outputs.emissive);
  const warm = evaluateBlackbody(1200);
  const cool = evaluateBlackbody(12000);
  assert.ok(warm[0] > warm[2]);
  assert.ok(cool[2] > cool[0]);
  assert.ok([...warm, ...cool].every(Number.isFinite));

  const evaluateWavelength = wavelength => raw(compile(graph(
    `wavelength-${wavelength}`,
    { type: 'ShaderNodeWavelength', params: {}, inputs: { Wavelength: wavelength } },
    { emissive: { nodeId: 'node', port: 'Color' } },
  )).outputs.emissive);
  const blue = evaluateWavelength(450);
  const green = evaluateWavelength(550);
  const red = evaluateWavelength(650);
  assert.ok(blue[2] > blue[0] && blue[2] > blue[1]);
  assert.ok(green[1] > green[0] && green[1] > green[2]);
  assert.ok(red[0] > red[1] && red[0] > red[2]);
});

test('Radial Tiling matches Blender sharp regular-segment coordinates and rejects dynamic modes', () => {
  const source = graph(
    'radial-sharp',
    {
      type: 'ShaderNodeRadialTiling',
      params: { normalize: false },
      inputs: { Vector: [1, 0, 0], Sides: 4, Roundness: 0 },
    },
    {
      positionOffset: { nodeId: 'node', port: 'Segment Coordinates' },
      roughness: { nodeId: 'node', port: 'Segment ID' },
      metalness: { nodeId: 'node', port: 'Segment Width' },
      opacity: { nodeId: 'node', port: 'Segment Rotation' },
    },
  );
  const outputs = compile(source).outputs;
  const coordinates = raw(outputs.positionOffset);
  assert.ok(Math.abs(coordinates[0] + Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(coordinates[1] - (Math.SQRT1_2 - 1)) < 1e-12);
  assert.equal(coordinates[2], 0);
  assert.equal(raw(outputs.roughness), 0);
  assert.ok(Math.abs(raw(outputs.metalness) - 1) < 1e-12);
  assert.ok(Math.abs(raw(outputs.opacity) - Math.PI / 4) < 1e-12);

  const normalized = structuredClone(source);
  normalized.id = 'shader/radial-normalized';
  normalized.nodes[0].params.normalize = true;
  const normalizedCoordinate = raw(compile(normalized).outputs.positionOffset);
  assert.ok(Math.abs(normalizedCoordinate[0]) < 1e-12);
  assert.ok(Math.abs(normalizedCoordinate[1] - Math.SQRT1_2) < 1e-12);

  const rounded = structuredClone(source);
  rounded.id = 'shader/radial-rounded';
  rounded.nodes[0].inputs.Roundness = 0.2;
  assert.throws(() => compileShaderGraph({ TSL: EVAL_TSL, graph: rounded }), error => (
    error.code === 'shader_node_mode_unsupported'
  ));

  const dynamic = structuredClone(source);
  dynamic.id = 'shader/radial-dynamic';
  dynamic.nodes.unshift({ id: 'sides', type: 'ShaderNodeValue', params: { value: 4 } });
  delete dynamic.nodes[1].inputs.Sides;
  dynamic.edges.push({
    from: { nodeId: 'sides', port: 'Value' },
    to: { nodeId: 'node', port: 'Sides' },
  });
  assert.equal(validateGraph(dynamic).valid, true);
  assert.throws(() => compileShaderGraph({ TSL: EVAL_TSL, graph: dynamic }), error => (
    error.code === 'shader_dynamic_setting_unsupported'
  ));
});
