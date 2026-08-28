import assert from 'node:assert/strict';
import test from 'node:test';

import { GRAPH_CATALOGS, GraphValidationError, validateGraph } from '../src/graphs/index.mjs';
import {
  BLENDER_SHADER_NODE_ALIASES,
  ShaderGraphCompileError,
  compileShaderGraph,
} from '../src/runtime/shader-graph-compiler.mjs';

class TraceNode {
  constructor(operation, arguments_ = []) {
    this.operation = operation;
    this.arguments = arguments_;
  }

  add(value) { return new TraceNode('add', [this, value]); }
  sub(value) { return new TraceNode('sub', [this, value]); }
  mul(value) { return new TraceNode('mul', [this, value]); }
  div(value) { return new TraceNode('div', [this, value]); }
  saturate() { return new TraceNode('saturate', [this]); }
  negate() { return new TraceNode('negate', [this]); }
  get x() { return new TraceNode('x', [this]); }
  get y() { return new TraceNode('y', [this]); }
  get z() { return new TraceNode('z', [this]); }
}

const trace = operation => (...arguments_) => new TraceNode(operation, arguments_);
const TRACE_TSL = Object.freeze({
  float: trace('float'),
  vec2: trace('vec2'),
  vec3: trace('vec3'),
  vec4: trace('vec4'),
  floor: trace('floor'),
  fract: trace('fract'),
  mod: trace('mod'),
  abs: trace('abs'),
  min: trace('min'),
  max: trace('max'),
  mix: trace('mix'),
  smoothstep: trace('smoothstep'),
  step: trace('step'),
  length: trace('length'),
  atan: trace('atan'),
  sin: trace('sin'),
  cos: trace('cos'),
  select: trace('select'),
  lessThan: trace('lessThan'),
  mx_cell_noise_float: trace('mx_cell_noise_float'),
  mx_noise_vec3: trace('mx_noise_vec3'),
  mx_fractal_noise_float: trace('mx_fractal_noise_float'),
});

function countOperations(value, operation, visited = new Set()) {
  if (!(value instanceof TraceNode) || visited.has(value)) return 0;
  visited.add(value);
  return (value.operation === operation ? 1 : 0)
    + value.arguments.reduce((total, entry) => total + countOperations(entry, operation, visited), 0);
}

function singleNodeGraph(type, params, outputPort = 'factor') {
  return {
    formatVersion: 1,
    id: `shader/test-${type.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`,
    domain: 'shader',
    nodes: [{ id: 'texture', type, params }],
    edges: [],
    outputs: { roughness: { nodeId: 'texture', port: outputPort } },
  };
}

test('catalogues the five live Blender procedural texture contracts and RNA aliases', () => {
  const expected = {
    ShaderNodeTexChecker: 'blender.checkerTexture',
    ShaderNodeTexGradient: 'blender.gradientTexture',
    ShaderNodeTexWhiteNoise: 'blender.whiteNoiseTexture',
    ShaderNodeTexMagic: 'blender.magicTexture',
    ShaderNodeTexBrick: 'blender.brickTexture',
  };

  for (const [rnaId, canonicalType] of Object.entries(expected)) {
    const node = GRAPH_CATALOGS.shader.nodes[rnaId];
    assert.ok(node, `missing ${rnaId}`);
    assert.equal(node.canonicalType, canonicalType);
    assert.equal(node.blenderId, rnaId);
    assert.equal(BLENDER_SHADER_NODE_ALIASES[rnaId], canonicalType);
    assert.ok(node.outputs.color);
  }
  assert.equal(GRAPH_CATALOGS.shader.nodes.ShaderNodeTexChecker.inputs.scale.default, 5);
  assert.deepEqual(GRAPH_CATALOGS.shader.nodes.ShaderNodeTexGradient.params.gradientType.values, [
    'LINEAR', 'QUADRATIC', 'EASING', 'DIAGONAL', 'SPHERICAL', 'QUADRATIC_SPHERE', 'RADIAL',
  ]);
  assert.equal(GRAPH_CATALOGS.shader.nodes.ShaderNodeTexMagic.params.depth.max, 10);
  assert.equal(GRAPH_CATALOGS.shader.nodes.ShaderNodeTexBrick.inputs.mortarSize.default, 0.02);
  assert.equal(GRAPH_CATALOGS.shader.nodes.ShaderNodeTexBrick.inputs.mortarSmooth.default, 0.1);
  assert.deepEqual(GRAPH_CATALOGS.shader.nodes.ShaderNodeTexChecker.outputs.factor.aliases, ['Factor']);
});

test('compiles Checker, Gradient, White Noise, Magic, and Brick into one live TSL graph', () => {
  const graph = {
    formatVersion: 1,
    id: 'shader/live-procedural-textures',
    domain: 'shader',
    nodes: [
      { id: 'checker', type: 'ShaderNodeTexChecker', params: {}, inputs: { scale: 7 } },
      { id: 'gradient', type: 'ShaderNodeTexGradient', params: { gradientType: 'RADIAL' } },
      { id: 'white-noise', type: 'ShaderNodeTexWhiteNoise', params: { dimensions: '3D' } },
      { id: 'magic', type: 'ShaderNodeTexMagic', params: { depth: 4 }, inputs: { distortion: 1.7 } },
      {
        id: 'brick',
        type: 'ShaderNodeTexBrick',
        params: { offset: 0.5, offsetFrequency: 2, squash: 0.72, squashFrequency: 3 },
        inputs: { mortarSize: 0.035, mortarSmooth: 0.01 },
      },
    ],
    edges: [],
    outputs: {
      baseColor: { nodeId: 'checker', port: 'color' },
      roughness: { nodeId: 'gradient', port: 'factor' },
      metalness: { nodeId: 'white-noise', port: 'value' },
      emissive: { nodeId: 'magic', port: 'color' },
      opacity: { nodeId: 'brick', port: 'factor' },
    },
  };

  const validation = validateGraph(graph);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(validation.graph.nodes.find(node => node.id === 'checker').inputs.scale, 7);
  assert.equal(validation.graph.nodes.find(node => node.id === 'brick').inputs.brickWidth, 0.5);

  const compilation = compileShaderGraph({ TSL: TRACE_TSL, graph });
  assert.equal(compilation.mode, 'tsl-webgpu');
  assert.equal(compilation.nodesCompiled, 5);
  assert.equal(compilation.outputs.baseColor.operation, 'mix');
  assert.ok(countOperations(compilation.outputs.roughness, 'atan') > 0);
  assert.ok(countOperations(compilation.outputs.metalness, 'mx_cell_noise_float') > 0);
  assert.ok(countOperations(compilation.outputs.emissive, 'sin') >= 2);
  assert.ok(countOperations(compilation.outputs.opacity, 'smoothstep') > 0);
});

test('all declared Gradient modes lower live while unsupported White Noise 4D fails the candidate', () => {
  for (const gradientType of [
    'LINEAR', 'QUADRATIC', 'EASING', 'DIAGONAL', 'SPHERICAL', 'QUADRATIC_SPHERE', 'RADIAL',
  ]) {
    const compilation = compileShaderGraph({
      TSL: TRACE_TSL,
      graph: singleNodeGraph('ShaderNodeTexGradient', { gradientType }),
    });
    assert.equal(compilation.nodesCompiled, 1, gradientType);
  }

  assert.throws(
    () => compileShaderGraph({
      TSL: TRACE_TSL,
      graph: singleNodeGraph('ShaderNodeTexWhiteNoise', { dimensions: '4D' }, 'value'),
    }),
    error => error instanceof ShaderGraphCompileError
      && error.code === 'shader_node_mode_unsupported'
      && error.details.nodeId === 'texture'
      && /4D coordinates/.test(error.message),
  );
});

test('Noise Texture distortion perturbs coordinates without replacing the fractal noise', () => {
  const graph = singleNodeGraph('ShaderNodeTexNoise', {
    dimensions: '3D',
    noiseType: 'FBM',
    normalize: true,
    seed: 0,
  });
  graph.nodes[0].inputs = { distortion: 0 };

  const compilation = compileShaderGraph({ TSL: TRACE_TSL, graph });
  assert.ok(countOperations(compilation.outputs.roughness, 'mx_noise_vec3') > 0);
  assert.ok(countOperations(compilation.outputs.roughness, 'mx_fractal_noise_float') > 0);
  assert.equal(countOperations(compilation.outputs.roughness, 'mx_noise_float'), 0);
});

test('numeric NodeReroute lowers as a live pass-through and closure-like types remain rejected', () => {
  const graph = {
    formatVersion: 1,
    id: 'shader/live-reroute',
    domain: 'shader',
    nodes: [
      { id: 'value', type: 'ShaderNodeValue', params: { value: 0.37 } },
      { id: 'reroute', type: 'NodeReroute', params: { valueType: 'float' } },
    ],
    edges: [{
      from: { nodeId: 'value', port: 'value' },
      to: { nodeId: 'reroute', port: 'input' },
    }],
    outputs: { roughness: { nodeId: 'reroute', port: 'output' } },
  };
  const compilation = compileShaderGraph({ TSL: TRACE_TSL, graph });
  assert.equal(compilation.nodesCompiled, 2);
  assert.deepEqual(compilation.outputs.roughness.arguments, [0.37]);

  const invalid = structuredClone(graph);
  invalid.nodes[1].params.valueType = 'surface';
  assert.throws(
    () => compileShaderGraph({ TSL: TRACE_TSL, graph: invalid }),
    error => error instanceof GraphValidationError
      && error.diagnostics.some(entry => /valueType/.test(entry.path)),
  );
});
