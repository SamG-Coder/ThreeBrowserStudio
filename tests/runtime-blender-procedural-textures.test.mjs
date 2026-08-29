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
  bitXor(value) { return new TraceNode('bitXor', [this, value]); }
  shiftRight(value) { return new TraceNode('shiftRight', [this, value]); }
  saturate() { return new TraceNode('saturate', [this]); }
  negate() { return new TraceNode('negate', [this]); }
  get x() { return new TraceNode('x', [this]); }
  get y() { return new TraceNode('y', [this]); }
  get z() { return new TraceNode('z', [this]); }
  get w() { return new TraceNode('w', [this]); }
  get xyz() { return new TraceNode('xyz', [this]); }
}

const trace = operation => (...arguments_) => new TraceNode(operation, arguments_);
const TRACE_TSL = Object.freeze({
  float: trace('float'),
  uint: trace('uint'),
  vec2: trace('vec2'),
  vec3: trace('vec3'),
  vec4: trace('vec4'),
  floor: trace('floor'),
  fract: trace('fract'),
  mod: trace('mod'),
  abs: trace('abs'),
  min: trace('min'),
  max: trace('max'),
  pow: trace('pow'),
  clamp: trace('clamp'),
  dot: trace('dot'),
  mix: trace('mix'),
  smoothstep: trace('smoothstep'),
  step: trace('step'),
  length: trace('length'),
  atan: trace('atan'),
  sin: trace('sin'),
  cos: trace('cos'),
  select: trace('select'),
  lessThan: trace('lessThan'),
  floatBitsToUint: trace('floatBitsToUint'),
  mx_cell_noise_float: trace('mx_cell_noise_float'),
  mx_noise_float: trace('mx_noise_float'),
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

test('all declared Gradient modes and White Noise dimensions lower live', () => {
  for (const gradientType of [
    'LINEAR', 'QUADRATIC', 'EASING', 'DIAGONAL', 'SPHERICAL', 'QUADRATIC_SPHERE', 'RADIAL',
  ]) {
    const compilation = compileShaderGraph({
      TSL: TRACE_TSL,
      graph: singleNodeGraph('ShaderNodeTexGradient', { gradientType }),
    });
    assert.equal(compilation.nodesCompiled, 1, gradientType);
  }

  for (const dimensions of ['1D', '2D', '3D', '4D']) {
    const compilation = compileShaderGraph({
      TSL: TRACE_TSL,
      graph: singleNodeGraph('ShaderNodeTexWhiteNoise', { dimensions }, 'value'),
    });
    assert.equal(compilation.nodesCompiled, 1, dimensions);
    if (dimensions === '4D') {
      assert.ok(countOperations(compilation.outputs.roughness, 'floatBitsToUint') >= 4);
      assert.ok(countOperations(compilation.outputs.roughness, 'bitXor') > 0);
    }
  }
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

test('Noise Texture compiles deterministic ridged and hetero terrain channels for castle weathering', () => {
  for (const noiseType of ['RIDGED_MULTIFRACTAL', 'HETERO_TERRAIN']) {
    const graph = singleNodeGraph('ShaderNodeTexNoise', {
      dimensions: '3D',
      noiseType,
      normalize: true,
      seed: 1729,
    });
    graph.nodes[0].inputs = {
      scale: 2.4,
      detail: 4,
      roughness: 0.62,
      lacunarity: 2.15,
      offset: 0.18,
      gain: 0.9,
      distortion: 0.12,
    };

    const validation = validateGraph(graph);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
    const first = compileShaderGraph({ TSL: TRACE_TSL, graph });
    const repeated = compileShaderGraph({ TSL: TRACE_TSL, graph });
    assert.deepEqual(first.outputs.roughness, repeated.outputs.roughness, noiseType);
    assert.ok(countOperations(first.outputs.roughness, 'mx_noise_float') >= 4, noiseType);
    assert.equal(countOperations(first.outputs.roughness, 'mx_fractal_noise_float'), 0, noiseType);

    const otherSeed = structuredClone(graph);
    otherSeed.nodes[0].params.seed = 1730;
    const changed = compileShaderGraph({ TSL: TRACE_TSL, graph: otherSeed });
    assert.notDeepEqual(first.outputs.roughness, changed.outputs.roughness, `${noiseType} seed`);
  }
});

test('Noise Texture compiles multifractal modes and every mode in true 4D', () => {
  for (const noiseType of ['FBM', 'MULTIFRACTAL', 'HYBRID_MULTIFRACTAL', 'RIDGED_MULTIFRACTAL', 'HETERO_TERRAIN']) {
    for (const dimensions of ['3D', '4D']) {
      const graph = singleNodeGraph('ShaderNodeTexNoise', {
        dimensions,
        noiseType,
        normalize: true,
        seed: 9,
      });
      graph.nodes[0].inputs = { detail: 2, distortion: 0, w: 0.37 };
      const compilation = compileShaderGraph({ TSL: TRACE_TSL, graph });
      assert.equal(compilation.nodesCompiled, 1, `${noiseType} ${dimensions}`);
      if (dimensions === '4D') {
        assert.ok(countOperations(compilation.outputs.roughness, 'floatBitsToUint') > 0, noiseType);
        assert.ok(countOperations(compilation.outputs.roughness, 'w') > 0, noiseType);
      }
    }
  }
});

test('Voronoi compiles every dimension, distance metric, and feature live', () => {
  for (const dimensions of ['1D', '2D', '3D', '4D']) {
    for (const distanceMetric of ['EUCLIDEAN', 'MANHATTAN', 'CHEBYCHEV', 'MINKOWSKI']) {
      const graph = singleNodeGraph('ShaderNodeTexVoronoi', {
        dimensions,
        feature: 'F1',
        distanceMetric,
        normalize: false,
        seed: 31,
      }, 'distance');
      graph.nodes[0].inputs = { detail: 0, exponent: 3, randomness: 0.8, w: 0.37 };
      const compilation = compileShaderGraph({ TSL: TRACE_TSL, graph });
      assert.equal(compilation.nodesCompiled, 1, `${dimensions} ${distanceMetric}`);
      if (distanceMetric === 'MINKOWSKI') assert.ok(countOperations(compilation.outputs.roughness, 'pow') > 0);
    }
  }

  for (const feature of ['F1', 'F2', 'SMOOTH_F1', 'DISTANCE_TO_EDGE', 'N_SPHERE_RADIUS']) {
    const graph = singleNodeGraph('ShaderNodeTexVoronoi', {
      dimensions: '4D',
      feature,
      distanceMetric: 'EUCLIDEAN',
      normalize: true,
      seed: 47,
    }, feature === 'N_SPHERE_RADIUS' ? 'radius' : 'distance');
    graph.nodes[0].inputs = { detail: 0, smoothness: 0.65, randomness: 1, w: 0.19 };
    const compilation = compileShaderGraph({ TSL: TRACE_TSL, graph });
    assert.equal(compilation.nodesCompiled, 1, feature);
    assert.ok(countOperations(compilation.outputs.roughness, 'floatBitsToUint') > 0, feature);
  }
});

test('Voronoi consumes fractal controls and rejects only candidates beyond its explicit live budget', () => {
  const dynamic = {
    formatVersion: 1,
    id: 'shader/voronoi-dynamic-detail',
    domain: 'shader',
    nodes: [
      { id: 'detail', type: 'ShaderNodeValue', params: { value: 2 } },
      { id: 'voronoi', type: 'ShaderNodeTexVoronoi', params: { dimensions: '3D', feature: 'F1' } },
    ],
    edges: [{ from: { nodeId: 'detail', port: 'value' }, to: { nodeId: 'voronoi', port: 'detail' } }],
    outputs: { roughness: { nodeId: 'voronoi', port: 'distance' } },
  };
  assert.throws(
    () => compileShaderGraph({ TSL: TRACE_TSL, graph: dynamic }),
    error => error instanceof ShaderGraphCompileError
      && error.code === 'shader_dynamic_setting_unsupported'
      && error.details.nodeId === 'voronoi',
  );

  const expensive = singleNodeGraph('ShaderNodeTexVoronoi', {
    dimensions: '4D', feature: 'SMOOTH_F1', distanceMetric: 'EUCLIDEAN', seed: 3,
  }, 'distance');
  expensive.nodes[0].inputs = { detail: 7, smoothness: 1 };
  assert.throws(
    () => compileShaderGraph({ TSL: TRACE_TSL, graph: expensive }),
    error => error instanceof ShaderGraphCompileError
      && error.code === 'shader_node_budget_exceeded'
      && error.details.nodeId === 'texture'
      && error.details.candidateVisits === 5000,
  );
});

test('Voronoi edge and N-sphere features intentionally ignore the distance metric', () => {
  for (const feature of ['DISTANCE_TO_EDGE', 'N_SPHERE_RADIUS']) {
    const make = distanceMetric => {
      const graph = singleNodeGraph('ShaderNodeTexVoronoi', {
        dimensions: '2D', feature, distanceMetric, normalize: false, seed: 19,
      }, feature === 'N_SPHERE_RADIUS' ? 'radius' : 'distance');
      graph.nodes[0].inputs = { detail: 0, exponent: 4, randomness: 0.7 };
      return compileShaderGraph({ TSL: TRACE_TSL, graph }).outputs.roughness;
    };
    const euclidean = make('EUCLIDEAN');
    const minkowski = make('MINKOWSKI');
    assert.equal(countOperations(euclidean, 'pow'), 0, feature);
    assert.equal(countOperations(minkowski, 'pow'), 0, feature);
    assert.equal(countOperations(euclidean, 'length'), countOperations(minkowski, 'length'), feature);
  }
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
