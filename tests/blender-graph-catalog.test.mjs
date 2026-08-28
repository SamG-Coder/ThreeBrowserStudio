import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GRAPH_CATALOGS,
  queryGraphCatalog,
  validateGraph,
} from '../src/graphs/index.mjs';

function textureSettings() {
  return {
    seed: 42,
    resolution: [256, 256],
    wrapS: 'repeat',
    wrapT: 'repeat',
    minFilter: 'linearMipmapLinear',
    magFilter: 'linear',
    mode: 'interactive',
  };
}

test('Blender RNA identifiers are executable aliases with socket/default metadata', () => {
  const pairs = [
    ['blender.textureCoordinate', 'ShaderNodeTexCoord'],
    ['blender.separateXYZ', 'ShaderNodeSeparateXYZ'],
    ['blender.mapping', 'ShaderNodeMapping'],
    ['blender.vectorMath', 'ShaderNodeVectorMath'],
    ['blender.noiseTexture', 'ShaderNodeTexNoise'],
    ['blender.voronoiTexture', 'ShaderNodeTexVoronoi'],
    ['blender.waveTexture', 'ShaderNodeTexWave'],
    ['blender.colorRamp', 'ShaderNodeValToRGB'],
    ['blender.mapRange', 'ShaderNodeMapRange'],
    ['blender.mix', 'ShaderNodeMix'],
    ['blender.attribute', 'ShaderNodeAttribute'],
    ['blender.colorAttribute', 'ShaderNodeVertexColor'],
    ['blender.bump', 'ShaderNodeBump'],
  ];

  for (const domain of ['shader', 'texture']) {
    for (const [canonicalType, blenderId] of pairs) {
      const canonical = GRAPH_CATALOGS[domain].nodes[canonicalType];
      const alias = GRAPH_CATALOGS[domain].nodes[blenderId];
      assert.ok(canonical, `missing ${domain} node ${canonicalType}`);
      assert.ok(alias, `missing ${domain} Blender alias ${blenderId}`);
      assert.equal(canonical.blenderId, blenderId);
      assert.equal(alias.canonicalType, canonicalType);
      assert.ok(Object.isFrozen(alias));
    }
  }

  const noise = GRAPH_CATALOGS.shader.nodes.ShaderNodeTexNoise;
  assert.equal(noise.inputs.scale.blenderName, 'Scale');
  assert.equal(noise.inputs.scale.default, 5);
  assert.equal(noise.inputs.detail.max, 15);
  assert.equal(noise.params.dimensions.default, '3D');
  assert.deepEqual(noise.outputs.factor, {
    type: 'float',
    blenderName: 'Fac',
    blenderIdentifier: 'Fac',
    aliases: ['Factor'],
  });

  const queried = queryGraphCatalog('shader', { types: ['ShaderNodeTexNoise'] });
  assert.equal(queried.returned, 1);
  assert.equal(queried.nodes[0].blender.canonicalType, 'blender.noiseTexture');
  assert.equal(queried.nodes[0].sockets.inputs.scale.default, 5);
  assert.deepEqual(queried.nodes[0].parameterMetadata.dimensions.values, ['1D', '2D', '3D', '4D']);
});

test('catalog covers Blender utility, colour, normal, and surface-flow nodes', () => {
  for (const type of [
    'ShaderNodeValue', 'ShaderNodeRGB', 'ShaderNodeMath', 'ShaderNodeCombineXYZ',
    'ShaderNodeSeparateColor', 'ShaderNodeCombineColor', 'ShaderNodeHueSaturation',
    'ShaderNodeBrightContrast', 'ShaderNodeGamma', 'ShaderNodeInvert',
    'ShaderNodeClamp', 'ShaderNodeNormalMap',
  ]) {
    assert.ok(GRAPH_CATALOGS.shader.nodes[type], `missing shader node ${type}`);
    assert.ok(GRAPH_CATALOGS.texture.nodes[type], `missing texture node ${type}`);
  }
  for (const type of [
    'ShaderNodeFresnel', 'ShaderNodeLayerWeight', 'ShaderNodeBsdfPrincipled',
    'ShaderNodeOutputMaterial',
  ]) assert.ok(GRAPH_CATALOGS.shader.nodes[type], `missing shader-only node ${type}`);

  const principled = GRAPH_CATALOGS.shader.nodes.ShaderNodeBsdfPrincipled;
  assert.equal(principled.outputs.surface.type, 'surface');
  assert.equal(principled.inputs.baseColor.default[0], 0.8);
  assert.equal(principled.inputs.metallic.default, 0);
  assert.equal(principled.inputs.roughness.default, 0.5);
  assert.equal(principled.inputs.ior.default, 1.5);
  assert.equal(principled.inputs.alpha.default, 1);
  assert.equal(principled.inputs.normal.default[2], 1);

  const output = GRAPH_CATALOGS.shader.nodes.ShaderNodeOutputMaterial;
  assert.equal(output.inputs.surface.type, 'surface');
  assert.equal(output.inputs.surface.required, true);
  assert.equal(output.outputs.surface.type, 'surface');
  assert.ok(output.tags.includes('graph-output'));

  const mix = GRAPH_CATALOGS.shader.nodes.ShaderNodeMixRGB;
  assert.equal(mix.canonicalType, 'blender.mix');
  assert.ok(mix.params.blendMode.values.includes('LINEAR_LIGHT'));
});

test('validates a Blender-ID watering-can paint and surface flow', () => {
  const graph = {
    formatVersion: 1,
    id: 'shader/watering-can-paint',
    domain: 'shader',
    nodes: [
      { id: 'coordinate', type: 'ShaderNodeTexCoord', params: {} },
      { id: 'mapping', type: 'ShaderNodeMapping', params: {} },
      { id: 'chips', type: 'ShaderNodeTexVoronoi', params: { feature: 'DISTANCE_TO_EDGE', distanceMetric: 'EUCLIDEAN' } },
      { id: 'streaks', type: 'ShaderNodeTexWave', params: { waveType: 'BANDS', bandsDirection: 'Z' } },
      { id: 'paint-ramp', type: 'ShaderNodeValToRGB', params: { stops: [
        { position: 0, color: [0.015, 0.035, 0.02, 1] },
        { position: 0.46, color: [0.08, 0.24, 0.11, 1] },
        { position: 1, color: [0.42, 0.62, 0.24, 1] },
      ], interpolation: 'EASE' } },
      { id: 'paint-mask', type: 'ShaderNodeVertexColor', params: { layerName: 'paint_mask' } },
      { id: 'paint-mix', type: 'ShaderNodeMix', params: { valueType: 'color', blendMode: 'LINEAR_LIGHT' } },
      { id: 'paint-bump', type: 'ShaderNodeBump', params: {} },
      { id: 'principled', type: 'ShaderNodeBsdfPrincipled', params: {} },
      { id: 'material-output', type: 'ShaderNodeOutputMaterial', params: {} },
    ],
    edges: [
      { from: { nodeId: 'coordinate', port: 'generated' }, to: { nodeId: 'mapping', port: 'vector' } },
      { from: { nodeId: 'mapping', port: 'vector' }, to: { nodeId: 'chips', port: 'vector' } },
      { from: { nodeId: 'mapping', port: 'vector' }, to: { nodeId: 'streaks', port: 'vector' } },
      { from: { nodeId: 'chips', port: 'distance' }, to: { nodeId: 'paint-ramp', port: 'factor' } },
      { from: { nodeId: 'streaks', port: 'factor' }, to: { nodeId: 'paint-mix', port: 'factor' } },
      { from: { nodeId: 'paint-ramp', port: 'color' }, to: { nodeId: 'paint-mix', port: 'a' } },
      { from: { nodeId: 'paint-mask', port: 'color' }, to: { nodeId: 'paint-mix', port: 'b' } },
      { from: { nodeId: 'chips', port: 'distance' }, to: { nodeId: 'paint-bump', port: 'height' } },
      { from: { nodeId: 'paint-mix', port: 'result' }, to: { nodeId: 'principled', port: 'baseColor' } },
      { from: { nodeId: 'paint-bump', port: 'normal' }, to: { nodeId: 'principled', port: 'normal' } },
      { from: { nodeId: 'principled', port: 'surface' }, to: { nodeId: 'material-output', port: 'surface' } },
    ],
    outputs: { baseColor: { nodeId: 'paint-mix', port: 'result' } },
  };

  const validation = validateGraph(graph);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(validation.graph.nodes.find((node) => node.id === 'chips').params.dimensions, '3D');
  assert.equal(validation.graph.nodes.find((node) => node.id === 'paint-mix').params.clampFactor, true);
  assert.equal(validation.graph.nodes.find((node) => node.id === 'principled').params.distribution, 'MULTI_GGX');
  assert.equal(validation.graph.nodes.find((node) => node.id === 'material-output').params.target, 'ALL');
});

test('Blender aliases retain typed validation and reject unsupported modes', () => {
  const graph = {
    formatVersion: 1,
    id: 'texture/blender-coordinates',
    domain: 'texture',
    nodes: [
      { id: 'coordinate', type: 'ShaderNodeTexCoord', params: {} },
      { id: 'separate', type: 'ShaderNodeSeparateXYZ', params: {} },
      { id: 'range', type: 'ShaderNodeMapRange', params: { interpolationType: 'SMOOTHERSTEP' } },
    ],
    edges: [
      { from: { nodeId: 'coordinate', port: 'generated' }, to: { nodeId: 'separate', port: 'vector' } },
      { from: { nodeId: 'separate', port: 'z' }, to: { nodeId: 'range', port: 'value' } },
    ],
    outputs: { height: { nodeId: 'range', port: 'result', colorSpace: 'none' } },
    settings: textureSettings(),
  };

  assert.equal(validateGraph(graph).valid, true);
  graph.nodes[2].params.interpolationType = 'MAGIC';
  assert.ok(validateGraph(graph).errors.some((entry) => entry.code === 'invalid_parameter'));
});
