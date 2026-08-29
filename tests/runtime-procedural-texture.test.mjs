import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROCEDURAL_TEXTURE_LIMITS,
  ProceduralTextureCompileError,
  bakeProceduralTextureGraph,
  compileProceduralTextureGraph,
  validateProceduralTextureGraph,
} from '../src/runtime/procedural-texture-compiler.mjs';

function textureSettings(overrides = {}) {
  return {
    seed: 42,
    resolution: [12, 8],
    wrapS: 'repeat',
    wrapT: 'repeat',
    minFilter: 'linear',
    magFilter: 'linear',
    mode: 'interactive',
    ...overrides,
  };
}

let singleNodeIndex = 0;
function singleNodeTextureGraph({ type, params = {}, inputs, port, output = 'roughness' }) {
  const node = { id: 'node', type, params, ...(inputs === undefined ? {} : { inputs }) };
  return {
    formatVersion: 1,
    id: `texture/cpu-mode-${singleNodeIndex += 1}`,
    domain: 'texture',
    nodes: [node],
    edges: [],
    outputs: {
      [output]: {
        nodeId: node.id,
        port,
        colorSpace: output === 'albedo' ? 'srgb' : 'none',
      },
    },
    settings: textureSettings({ resolution: [2, 2] }),
  };
}

function canonicalTextureGraph() {
  return {
    formatVersion: 1,
    id: 'texture/cpu-terrain',
    domain: 'texture',
    nodes: [
      { id: 'uv', type: 'uv', params: {} },
      { id: 'noise', type: 'fbm', params: { seed: 9, octaves: 4, lacunarity: 2, gain: 0.55 } },
      { id: 'ramp', type: 'colorRamp', params: { interpolation: 'smoothstep', stops: [
        { position: 0, color: [0.02, 0.08, 0.015, 1] },
        { position: 0.55, color: [0.16, 0.42, 0.06, 1] },
        { position: 1, color: [0.75, 0.68, 0.3, 1] },
      ] } },
      { id: 'normal', type: 'normalFromHeight', params: { strength: 0.6 } },
    ],
    edges: [
      { from: { nodeId: 'uv', port: 'uv' }, to: { nodeId: 'noise', port: 'coordinate' } },
      { from: { nodeId: 'noise', port: 'value' }, to: { nodeId: 'ramp', port: 'value' } },
      { from: { nodeId: 'noise', port: 'value' }, to: { nodeId: 'normal', port: 'height' } },
    ],
    outputs: {
      albedo: { nodeId: 'ramp', port: 'color', colorSpace: 'srgb' },
      roughness: { nodeId: 'noise', port: 'value', colorSpace: 'none' },
      normal: { nodeId: 'normal', port: 'normal', colorSpace: 'none' },
      height: { nodeId: 'noise', port: 'value', colorSpace: 'none' },
    },
    settings: textureSettings(),
  };
}

test('compiles canonical texture graphs to deterministic typed CPU maps', () => {
  const graph = canonicalTextureGraph();
  const compiled = compileProceduralTextureGraph(graph);

  assert.equal(compiled.kind, 'CompiledProceduralTextureGraph');
  assert.equal(compiled.execution, 'explicit-cpu-bake');
  assert.deepEqual(compiled.outputNames, ['albedo', 'height', 'normal', 'roughness']);
  const sample = compiled.sample([0.37, 0.61]);
  assert.equal(sample.albedo.length, 3);
  assert.equal(sample.normal.length, 3);
  assert.ok(Number.isFinite(sample.height));

  const first = compiled.bake();
  const second = compiled.bake();
  assert.equal(first.generatedAtRuntime, false);
  assert.deepEqual(Array.from(first.maps.albedo.data), Array.from(second.maps.albedo.data));
  assert.deepEqual(Array.from(first.maps.height.data), Array.from(second.maps.height.data));
  assert.ok(first.maps.albedo.data instanceof Uint8Array);
  assert.ok(first.maps.roughness.data instanceof Uint8Array);
  assert.ok(first.maps.normal.data instanceof Uint8Array);
  assert.ok(first.maps.height.data instanceof Float32Array);
  assert.deepEqual(
    [first.maps.albedo.format, first.maps.roughness.format, first.maps.normal.format, first.maps.height.format],
    ['rgba8unorm', 'r8unorm', 'rgba8unorm', 'r32float'],
  );
  assert.equal(first.maps.albedo.colorSpace, 'srgb');
  assert.equal(first.maps.normal.colorSpace, 'none');
  assert.ok(first.maps.normal.data.some((value, index) => index % 4 < 2 && value !== 128));

  const otherSeed = compileProceduralTextureGraph(graph, { seed: 1 }).bake({ outputs: ['height'] });
  assert.notDeepEqual(Array.from(first.maps.height.data), Array.from(otherSeed.maps.height.data));
});

test('CPU bakes canonical shader graphs and maps baseColor to albedo', () => {
  const graph = {
    formatVersion: 1,
    id: 'shader/cpu-moss',
    domain: 'shader',
    nodes: [
      { id: 'uv', type: 'input.uv', params: {} },
      { id: 'noise', type: 'noise.value', params: { seed: 31 } },
      { id: 'ramp', type: 'ramp.color', params: { stops: [
        { position: 0, color: [0.01, 0.025, 0.005, 1] },
        { position: 1, color: [0.35, 0.7, 0.12, 1] },
      ] } },
      { id: 'normal', type: 'normal.fromHeight', params: { strength: 0.25 } },
    ],
    edges: [
      { from: { nodeId: 'uv', port: 'uv' }, to: { nodeId: 'noise', port: 'coordinate' } },
      { from: { nodeId: 'noise', port: 'value' }, to: { nodeId: 'ramp', port: 'value' } },
      { from: { nodeId: 'noise', port: 'value' }, to: { nodeId: 'normal', port: 'height' } },
    ],
    outputs: {
      baseColor: { nodeId: 'ramp', port: 'color' },
      roughness: { nodeId: 'noise', port: 'value' },
      normal: { nodeId: 'normal', port: 'normal' },
    },
  };

  const bake = bakeProceduralTextureGraph(graph, { resolution: [9, 7] });
  assert.deepEqual(Object.keys(bake.maps).sort(), ['albedo', 'normal', 'roughness']);
  assert.equal(bake.width, 9);
  assert.equal(bake.height, 7);
  assert.equal(bake.maps.albedo.data.length, 9 * 7 * 4);
});

test('evaluates canonical Blender procedural aliases and socket defaults in a 2D bake', () => {
  const graph = {
    formatVersion: 1,
    id: 'texture/blender-stone',
    domain: 'texture',
    nodes: [
      { id: 'coords', type: 'blender.textureCoordinate', params: {} },
      { id: 'mapping', type: 'blender.mapping', params: { vectorType: 'POINT' } },
      { id: 'noise', type: 'blender.noiseTexture', params: { dimensions: '2D', noiseType: 'FBM', normalize: true, seed: 17 } },
      { id: 'ramp', type: 'blender.colorRamp', params: { interpolation: 'EASE', colorMode: 'RGB', hueInterpolation: 'NEAR', stops: [
        { position: 0, color: [0.025, 0.03, 0.04, 1] },
        { position: 1, color: [0.62, 0.52, 0.35, 1] },
      ] } },
      { id: 'cells', type: 'blender.voronoiTexture', params: { dimensions: '2D', feature: 'F2', distanceMetric: 'CHEBYCHEV', normalize: false, seed: 23 } },
      { id: 'range', type: 'blender.mapRange', params: { interpolationType: 'SMOOTHSTEP', clamp: true } },
      { id: 'math', type: 'blender.math', params: { operation: 'MULTIPLY', clamp: true } },
      { id: 'accent', type: 'blender.rgb', params: { value: [0.14, 0.22, 0.055, 1] } },
      { id: 'mix', type: 'blender.mix', params: { valueType: 'color', blendMode: 'MIX', clampFactor: true, clampResult: false } },
      { id: 'bands', type: 'blender.waveTexture', params: { waveType: 'BANDS', bandsDirection: 'Y', ringsDirection: 'X', profile: 'TRI', seed: 5 } },
      { id: 'bump', type: 'blender.bump', params: { invert: false } },
      { id: 'separate', type: 'blender.separateXYZ', params: {} },
    ],
    edges: [
      { from: { nodeId: 'coords', port: 'generated' }, to: { nodeId: 'mapping', port: 'vector' } },
      { from: { nodeId: 'mapping', port: 'vector' }, to: { nodeId: 'noise', port: 'vector' } },
      { from: { nodeId: 'noise', port: 'factor' }, to: { nodeId: 'ramp', port: 'factor' } },
      { from: { nodeId: 'mapping', port: 'vector' }, to: { nodeId: 'cells', port: 'vector' } },
      { from: { nodeId: 'cells', port: 'distance' }, to: { nodeId: 'range', port: 'value' } },
      { from: { nodeId: 'range', port: 'result' }, to: { nodeId: 'math', port: 'value' } },
      { from: { nodeId: 'ramp', port: 'color' }, to: { nodeId: 'mix', port: 'a' } },
      { from: { nodeId: 'accent', port: 'color' }, to: { nodeId: 'mix', port: 'b' } },
      { from: { nodeId: 'math', port: 'value' }, to: { nodeId: 'mix', port: 'factor' } },
      { from: { nodeId: 'mapping', port: 'vector' }, to: { nodeId: 'bands', port: 'vector' } },
      { from: { nodeId: 'bands', port: 'factor' }, to: { nodeId: 'bump', port: 'height' } },
      { from: { nodeId: 'mapping', port: 'vector' }, to: { nodeId: 'separate', port: 'vector' } },
    ],
    outputs: {
      albedo: { nodeId: 'mix', port: 'result', colorSpace: 'srgb' },
      roughness: { nodeId: 'range', port: 'result', colorSpace: 'none' },
      normal: { nodeId: 'bump', port: 'normal', colorSpace: 'none' },
      height: { nodeId: 'separate', port: 'x', colorSpace: 'none' },
    },
    settings: textureSettings({ seed: 101, resolution: [10, 6] }),
  };

  const validation = validateProceduralTextureGraph(graph);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const compiled = compileProceduralTextureGraph(graph);
  const sample = compiled.sample([0.25, 0.75]);
  assert.deepEqual(Object.keys(sample).sort(), ['albedo', 'height', 'normal', 'roughness']);
  assert.ok(sample.roughness >= 0 && sample.roughness <= 1);
  assert.ok(Math.abs(sample.height - 0.25) < 1e-10);
  assert.equal(sample.normal.length, 3);

  const bake = compiled.bake();
  assert.ok(Math.abs(bake.maps.height.range[0] - 0.05) < 1e-6);
  assert.ok(Math.abs(bake.maps.height.range[1] - 0.95) < 1e-6);
  assert.ok(bake.maps.normal.data.some((value, index) => index % 4 < 2 && value !== 128));
});

test('CPU bake rejects invalid Blender property types instead of coercing them', () => {
  for (const graph of [
    singleNodeTextureGraph({
      type: 'blender.noiseTexture',
      params: { dimensions: '2D', noiseType: 'FBM', normalize: 'yes' },
      port: 'factor',
    }),
    singleNodeTextureGraph({
      type: 'blender.voronoiTexture',
      params: { dimensions: '2D', feature: 'F1', distanceMetric: 'EUCLIDEAN', normalize: 1 },
      port: 'distance',
    }),
  ]) {
    const validation = validateProceduralTextureGraph(graph);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some(error => error.path?.endsWith('/params/normalize')));
  }
});

test('CPU bake keeps its implemented Blender modes usable and rejects invalid alias modes', () => {
  const supported = [
    ...['1D', '2D', '3D', '4D'].flatMap(dimensions => [
      ...['FBM', 'MULTIFRACTAL', 'HYBRID_MULTIFRACTAL', 'RIDGED_MULTIFRACTAL', 'HETERO_TERRAIN'].map(noiseType => singleNodeTextureGraph({
        type: 'blender.noiseTexture',
        params: { dimensions, noiseType, normalize: true },
        inputs: { detail: PROCEDURAL_TEXTURE_LIMITS.maxBlenderNoiseDetail, w: 0.37 },
        port: 'factor',
      })),
    ]),
    singleNodeTextureGraph({
      type: 'blender.noiseTexture',
      params: { dimensions: '4D', noiseType: 'RIDGED_MULTIFRACTAL', normalize: false },
      inputs: { detail: 3, w: 0.37 },
      port: 'factor',
    }),
    ...['1D', '2D', '3D', '4D'].map(dimensions => singleNodeTextureGraph({
      type: 'blender.voronoiTexture',
      params: { dimensions, feature: 'F1', distanceMetric: 'EUCLIDEAN', normalize: true },
      inputs: { detail: 0, w: 0.43 },
      port: 'distance',
    })),
    ...['EUCLIDEAN', 'MANHATTAN', 'CHEBYCHEV', 'MINKOWSKI'].map(distanceMetric => singleNodeTextureGraph({
      type: 'blender.voronoiTexture',
      params: { dimensions: '2D', feature: 'F1', distanceMetric, normalize: false },
      inputs: { detail: 0 },
      port: 'distance',
    })),
    ...['F1', 'F2', 'SMOOTH_F1', 'DISTANCE_TO_EDGE', 'N_SPHERE_RADIUS'].map(feature => singleNodeTextureGraph({
      type: 'blender.voronoiTexture',
      params: { dimensions: '2D', feature, distanceMetric: 'EUCLIDEAN', normalize: false },
      inputs: { detail: 0 },
      port: feature === 'N_SPHERE_RADIUS' ? 'radius' : 'distance',
    })),
    ...['CONSTANT', 'LINEAR', 'EASE', 'CARDINAL', 'B_SPLINE'].map(interpolation => singleNodeTextureGraph({
      type: 'blender.colorRamp',
      params: { interpolation, colorMode: 'RGB', hueInterpolation: 'NEAR' },
      port: 'color',
      output: 'albedo',
    })),
    ...['HSV', 'HSL'].map(colorMode => singleNodeTextureGraph({
      type: 'blender.colorRamp',
      params: { interpolation: 'LINEAR', colorMode, hueInterpolation: 'FAR' },
      port: 'color',
      output: 'albedo',
    })),
    ...[
      'MIX', 'DARKEN', 'MULTIPLY', 'BURN', 'LIGHTEN', 'SCREEN', 'DODGE', 'ADD',
      'OVERLAY', 'SOFT_LIGHT', 'LINEAR_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'SUBTRACT',
      'DIVIDE', 'HUE', 'SATURATION', 'COLOR', 'VALUE',
    ].map(blendMode => singleNodeTextureGraph({
      type: 'blender.mix',
      params: { valueType: 'color', blendMode, clampFactor: true, clampResult: false },
      port: 'result',
      output: 'albedo',
    })),
    ...['RGB', 'HSV', 'HSL'].flatMap(mode => [
      singleNodeTextureGraph({
        type: 'blender.separateColor', params: { mode }, port: 'red',
      }),
      singleNodeTextureGraph({
        type: 'blender.combineColor', params: { mode }, port: 'color', output: 'albedo',
      }),
    ]),
  ];
  for (const graph of supported) {
    const validation = validateProceduralTextureGraph(graph);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
    assert.doesNotThrow(() => compileProceduralTextureGraph(graph).sample([0.25, 0.75]));
  }

  const invalidAlias = singleNodeTextureGraph({
    type: 'NoiseTexture',
    params: { dimensions: '7D', noiseType: 'ALIEN', normalize: true },
    port: 'Factor',
  });
  const validation = validateProceduralTextureGraph(invalidAlias);
  assert.equal(validation.valid, false);
  assert.deepEqual(
    validation.errors.filter(error => error.code === 'procedural_invalid_node_mode').map(error => error.property).sort(),
    ['dimensions', 'noiseType'],
  );
});

test('CPU bake evaluates Blender colour nodes with live-compatible semantics', () => {
  const combined = compileProceduralTextureGraph(singleNodeTextureGraph({
    type: 'blender.combineColor',
    params: { mode: 'HSV' },
    inputs: { red: 1 / 3, green: 1, blue: 1, alpha: 0.4 },
    port: 'color',
    output: 'albedo',
  })).sample([0.5, 0.5]).albedo;
  assert.ok(Math.abs(combined[0]) < 1e-8);
  assert.ok(Math.abs(combined[1] - 1) < 1e-8);
  assert.ok(Math.abs(combined[2]) < 1e-8);
  assert.ok(Math.abs(combined[3] - 0.4) < 1e-8);

  const separated = compileProceduralTextureGraph(singleNodeTextureGraph({
    type: 'blender.separateColor',
    params: { mode: 'HSV' },
    inputs: { color: [0, 1, 1, 0.25] },
    port: 'red',
  })).sample([0.5, 0.5]).roughness;
  assert.ok(Math.abs(separated - 0.5) < 1e-8);

  const hueStops = [
    { position: 0, color: [1, 0, 0.3, 0.2] },
    { position: 1, color: [1, 0.3, 0, 0.8] },
  ];
  const farRamp = compileProceduralTextureGraph(singleNodeTextureGraph({
    type: 'blender.colorRamp',
    params: { interpolation: 'B_SPLINE', colorMode: 'HSV', hueInterpolation: 'FAR', stops: hueStops },
    inputs: { factor: 0.5 },
    port: 'color',
    output: 'albedo',
  })).sample([0.5, 0.5]).albedo;
  assert.ok(Math.abs(farRamp[0]) < 1e-8);
  assert.ok(Math.abs(farRamp[1] - 1) < 1e-8);
  assert.ok(Math.abs(farRamp[2] - 1) < 1e-8);

  const colorMix = compileProceduralTextureGraph(singleNodeTextureGraph({
    type: 'blender.mix',
    params: { valueType: 'color', blendMode: 'COLOR', clampFactor: true, clampResult: false },
    inputs: { factor: 1, a: [0.25, 0.25, 0.25, 1], b: [0, 0, 1, 1] },
    port: 'result',
    output: 'albedo',
  })).sample([0.5, 0.5]).albedo;
  assert.ok(Math.abs(colorMix[0]) < 1e-8);
  assert.ok(Math.abs(colorMix[1]) < 1e-8);
  assert.ok(Math.abs(colorMix[2] - 0.25) < 1e-8);
});

test('CPU bake evaluates every Normal Map space with explicit bake-frame semantics', () => {
  const sample = (space, strength = 1) => compileProceduralTextureGraph(singleNodeTextureGraph({
    type: 'blender.normalMap',
    params: { space, uvMap: '' },
    inputs: { strength, color: [0.75, 0.25, 0.9, 1] },
    port: 'normal',
    output: 'normal',
  })).sample([0.5, 0.5]).normal;

  const tangent = sample('TANGENT');
  const object = sample('OBJECT');
  const world = sample('WORLD');
  const blenderObject = sample('BLENDER_OBJECT');
  const blenderWorld = sample('BLENDER_WORLD');
  assert.ok(tangent.every(Number.isFinite));
  assert.deepEqual(object, world);
  assert.deepEqual(blenderObject, blenderWorld);
  assert.ok(object[1] < 0 && object[2] > 0);
  assert.ok(blenderObject[1] > 0 && blenderObject[2] < 0);
  assert.deepEqual(sample('TANGENT', 0), [0, 0, 1]);
  assert.deepEqual(sample('OBJECT', 0), [0, 0, 1]);

  const namedUv = singleNodeTextureGraph({
    type: 'blender.normalMap',
    params: { space: 'TANGENT', uvMap: 'UVMap.001' },
    port: 'normal',
    output: 'normal',
  });
  const validation = validateProceduralTextureGraph(namedUv);
  assert.ok(validation.errors.some(error => error.code === 'procedural_node_property_unsupported'
    && error.property === 'uvMap'));
});

test('CPU bake executes dynamic/fractal Detail within limits and rejects exact over-budget Voronoi work', () => {
  const noiseAtLimit = singleNodeTextureGraph({
    type: 'blender.noiseTexture',
    params: { dimensions: '2D', noiseType: 'FBM', normalize: true },
    inputs: { detail: PROCEDURAL_TEXTURE_LIMITS.maxBlenderNoiseDetail },
    port: 'factor',
  });
  assert.equal(validateProceduralTextureGraph(noiseAtLimit).valid, true);

  const noiseOverLimit = structuredClone(noiseAtLimit);
  noiseOverLimit.id = 'texture/cpu-noise-detail-over-limit';
  noiseOverLimit.nodes[0].inputs.detail = PROCEDURAL_TEXTURE_LIMITS.maxBlenderNoiseDetail + 1;
  const noiseValidation = validateProceduralTextureGraph(noiseOverLimit);
  assert.ok(noiseValidation.errors.some(error => error.code === 'procedural_detail_limit_exceeded'
    && error.limit === PROCEDURAL_TEXTURE_LIMITS.maxBlenderNoiseDetail));

  const dynamicNoise = structuredClone(noiseAtLimit);
  dynamicNoise.id = 'texture/cpu-noise-dynamic-detail';
  delete dynamicNoise.nodes[0].inputs;
  dynamicNoise.nodes.unshift({ id: 'detail', type: 'constant', params: { valueType: 'float', value: 4 } });
  dynamicNoise.edges.push({
    from: { nodeId: 'detail', port: 'value' },
    to: { nodeId: 'node', port: 'detail' },
  });
  const dynamicValidation = validateProceduralTextureGraph(dynamicNoise);
  assert.equal(dynamicValidation.valid, true, JSON.stringify(dynamicValidation.errors));
  assert.doesNotThrow(() => compileProceduralTextureGraph(dynamicNoise).sample([0.2, 0.3]));

  const voronoiOverLimit = singleNodeTextureGraph({
    type: 'blender.voronoiTexture',
    params: { dimensions: '2D', feature: 'F1', distanceMetric: 'EUCLIDEAN', normalize: false },
    inputs: { detail: PROCEDURAL_TEXTURE_LIMITS.maxBlenderVoronoiDetail + 1 },
    port: 'distance',
  });
  const detailValidation = validateProceduralTextureGraph(voronoiOverLimit);
  assert.ok(detailValidation.errors.some(error => error.code === 'procedural_detail_limit_exceeded'
    && error.limit === PROCEDURAL_TEXTURE_LIMITS.maxBlenderVoronoiDetail));

  const fractal = structuredClone(voronoiOverLimit);
  fractal.id = 'texture/cpu-voronoi-fractal-detail';
  fractal.nodes[0].inputs.detail = 1;
  const fractalValidation = validateProceduralTextureGraph(fractal);
  assert.equal(fractalValidation.valid, true, JSON.stringify(fractalValidation.errors));
  assert.doesNotThrow(() => compileProceduralTextureGraph(fractal).sample([0.2, 0.3]));

  const expensive = singleNodeTextureGraph({
    type: 'blender.voronoiTexture',
    params: { dimensions: '4D', feature: 'SMOOTH_F1', distanceMetric: 'EUCLIDEAN', normalize: false },
    inputs: { detail: PROCEDURAL_TEXTURE_LIMITS.maxBlenderVoronoiDetail },
    port: 'distance',
  });
  const expensiveValidation = validateProceduralTextureGraph(expensive);
  const budget = expensiveValidation.errors.find(error => error.code === 'procedural_node_budget_exceeded');
  assert.ok(budget, JSON.stringify(expensiveValidation.errors));
  assert.equal(budget.candidateVisits, 5000);
  assert.equal(budget.limit, PROCEDURAL_TEXTURE_LIMITS.maxVoronoiCandidateVisits);
  assert.equal(budget.dimensions, 4);
  assert.equal(budget.radius, 2);
  assert.equal(budget.octaves, 8);
});

test('requires explicit bounded CPU image sources', () => {
  const graph = {
    formatVersion: 1,
    id: 'texture/cpu-image',
    domain: 'texture',
    nodes: [
      { id: 'uv', type: 'uv', params: {} },
      { id: 'image', type: 'image', params: { assetId: 'image/checker', colorSpace: 'srgb' } },
    ],
    edges: [
      { from: { nodeId: 'uv', port: 'uv' }, to: { nodeId: 'image', port: 'uv' } },
    ],
    outputs: { albedo: { nodeId: 'image', port: 'color', colorSpace: 'srgb' } },
    settings: textureSettings({ resolution: [2, 1] }),
  };

  const unresolved = validateProceduralTextureGraph(graph);
  assert.equal(unresolved.valid, false);
  assert.ok(unresolved.errors.some(entry => entry.code === 'procedural_image_unresolved'));

  const source = {
    width: 2,
    height: 1,
    channels: 4,
    colorSpace: 'srgb',
    data: new Uint8Array([255, 0, 0, 255, 0, 64, 255, 255]),
  };
  const bake = compileProceduralTextureGraph(graph, {
    images: new Map([['image/checker', source]]),
  }).bake();
  assert.deepEqual(Array.from(bake.maps.albedo.data), Array.from(source.data));
});

test('rejects unsupported nodes, cycles, and out-of-budget resolutions with explicit diagnostics', () => {
  const unsupported = {
    formatVersion: 1,
    id: 'texture/unsafe-code',
    domain: 'texture',
    nodes: [{ id: 'script', type: 'ShaderNodeScript', params: {} }],
    edges: [],
    outputs: { albedo: { nodeId: 'script', port: 'color', colorSpace: 'srgb' } },
    settings: textureSettings(),
  };
  const unsupportedResult = validateProceduralTextureGraph(unsupported);
  assert.ok(unsupportedResult.errors.some(entry => entry.code === 'procedural_unsupported_node'));
  assert.ok(!unsupportedResult.errors.some(entry => entry.code === 'procedural_graph_cycle'));
  assert.throws(
    () => compileProceduralTextureGraph(unsupported),
    error => error instanceof ProceduralTextureCompileError
      && error.diagnostics.some(entry => entry.code === 'procedural_unsupported_node'),
  );

  const cyclic = {
    formatVersion: 1,
    id: 'texture/cyclic-mapping',
    domain: 'texture',
    nodes: [
      { id: 'mapping-a', type: 'ShaderNodeMapping', params: {} },
      { id: 'mapping-b', type: 'ShaderNodeMapping', params: {} },
    ],
    edges: [
      { from: { nodeId: 'mapping-a', port: 'vector' }, to: { nodeId: 'mapping-b', port: 'vector' } },
      { from: { nodeId: 'mapping-b', port: 'vector' }, to: { nodeId: 'mapping-a', port: 'vector' } },
    ],
    outputs: { height: { nodeId: 'mapping-a', port: 'vector', colorSpace: 'none' } },
    settings: textureSettings(),
  };
  assert.ok(validateProceduralTextureGraph(cyclic).errors.some(entry => entry.code === 'procedural_graph_cycle'));

  const tooLarge = {
    formatVersion: 1,
    id: 'texture/too-large',
    domain: 'texture',
    nodes: [{ id: 'value', type: 'ShaderNodeValue', params: { value: 0.5 } }],
    edges: [],
    outputs: { roughness: { nodeId: 'value', port: 'value', colorSpace: 'none' } },
    settings: textureSettings({ resolution: [4096, 1] }),
  };
  assert.ok(validateProceduralTextureGraph(tooLarge).errors.some(entry => entry.code === 'procedural_resolution_exceeded'));
});

test('CPU evaluator mirrors the five live Blender textures and numeric reroutes', () => {
  const graph = {
    formatVersion: 1,
    id: 'texture/blender-procedural-parity',
    domain: 'texture',
    nodes: [
      { id: 'coords', type: 'ShaderNodeTexCoord', params: {} },
      { id: 'checker', type: 'ShaderNodeTexChecker', params: {} },
      { id: 'gradient', type: 'ShaderNodeTexGradient', params: { gradientType: 'RADIAL' } },
      { id: 'white', type: 'ShaderNodeTexWhiteNoise', params: { dimensions: '3D' } },
      { id: 'magic', type: 'ShaderNodeTexMagic', params: { depth: 4 } },
      { id: 'brick', type: 'ShaderNodeTexBrick', params: { offset: 0.5, offsetFrequency: 2, squash: 0.8, squashFrequency: 3 } },
      { id: 'mix-a', type: 'ShaderNodeMix', params: { valueType: 'color', blendMode: 'MIX', clampFactor: true, clampResult: false } },
      { id: 'mix-b', type: 'ShaderNodeMix', params: { valueType: 'color', blendMode: 'MIX', clampFactor: true, clampResult: false } },
      { id: 'reroute', type: 'NodeReroute', params: { valueType: 'float' } },
    ],
    edges: [
      ...['checker', 'gradient', 'white', 'magic', 'brick'].map(nodeId => ({
        from: { nodeId: 'coords', port: 'Generated' },
        to: { nodeId, port: 'Vector' },
      })),
      { from: { nodeId: 'checker', port: 'Color' }, to: { nodeId: 'mix-a', port: 'A_Color' } },
      { from: { nodeId: 'magic', port: 'Color' }, to: { nodeId: 'mix-a', port: 'B_Color' } },
      { from: { nodeId: 'brick', port: 'Factor' }, to: { nodeId: 'mix-a', port: 'Factor' } },
      { from: { nodeId: 'mix-a', port: 'Result_Color' }, to: { nodeId: 'mix-b', port: 'A_Color' } },
      { from: { nodeId: 'brick', port: 'Color' }, to: { nodeId: 'mix-b', port: 'B_Color' } },
      { from: { nodeId: 'gradient', port: 'Factor' }, to: { nodeId: 'mix-b', port: 'Factor' } },
      { from: { nodeId: 'white', port: 'Value' }, to: { nodeId: 'reroute', port: 'Input' } },
    ],
    outputs: {
      albedo: { nodeId: 'mix-b', port: 'Result_Color', colorSpace: 'srgb' },
      roughness: { nodeId: 'gradient', port: 'Factor', colorSpace: 'none' },
      height: { nodeId: 'reroute', port: 'Output', colorSpace: 'none' },
    },
    settings: textureSettings({ seed: 77, resolution: [7, 5] }),
  };

  const validation = validateProceduralTextureGraph(graph);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const compiled = compileProceduralTextureGraph(graph);
  const sample = compiled.sample([0.31, 0.73]);
  assert.ok([3, 4].includes(sample.albedo.length));
  assert.ok(sample.roughness >= 0 && sample.roughness <= 1);
  assert.ok(sample.height >= 0 && sample.height <= 1);
  const first = compiled.bake();
  const second = compiled.bake();
  assert.deepEqual(Array.from(first.maps.albedo.data), Array.from(second.maps.albedo.data));
  assert.deepEqual(Array.from(first.maps.height.data), Array.from(second.maps.height.data));
});
