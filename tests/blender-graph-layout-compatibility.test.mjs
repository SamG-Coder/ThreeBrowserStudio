import assert from 'node:assert/strict';
import test from 'node:test';

import { GRAPH_CATALOGS, queryGraphCatalog, validateGraph } from '../src/graphs/index.mjs';

function textureSettings() {
  return {
    seed: 90210,
    resolution: [512, 512],
    wrapS: 'repeat',
    wrapT: 'repeat',
    minFilter: 'linearMipmapLinear',
    magFilter: 'linear',
    mode: 'interactive',
  };
}

function complexBlenderTextureGraph() {
  return {
    formatVersion: 1,
    id: 'texture/blender-layout-and-sockets',
    domain: 'texture',
    nodes: [
      {
        id: 'weathering-frame',
        type: 'NodeFrame',
        params: { labelSize: 18, shrink: true, text: 'Weathered pigment breakup' },
      },
      { id: 'coordinates', type: 'ShaderNodeTexCoord', params: {} },
      {
        id: 'mapping',
        type: 'ShaderNodeMapping',
        params: { vectorType: 'POINT' },
        inputs: {
          Location: [0.13, -0.08, 0],
          scale: [2.5, 3.25, 1],
        },
      },
      {
        id: 'noise',
        type: 'ShaderNodeTexNoise',
        params: { dimensions: '3D', noiseType: 'FBM', normalize: true, seed: 29 },
        inputs: {
          Scale: 7.5,
          detail: 4,
          Roughness: 0.62,
          Distortion: 0.18,
        },
      },
      { id: 'noise-reroute', type: 'NodeReroute', params: { valueType: 'float' } },
      {
        id: 'pigment-ramp',
        type: 'ShaderNodeValToRGB',
        params: {
          stops: [
            { position: 0, color: [0.018, 0.035, 0.02, 1] },
            { position: 0.43, color: [0.09, 0.24, 0.11, 1] },
            { position: 1, color: [0.58, 0.68, 0.31, 1] },
          ],
          interpolation: 'EASE',
        },
      },
      {
        id: 'dust-mix',
        type: 'ShaderNodeMix',
        params: { valueType: 'color', blendMode: 'MULTIPLY' },
        inputs: {
          Factor_Float: 0.68,
          B_Color: [0.72, 0.61, 0.38, 1],
        },
      },
    ],
    edges: [
      { from: { nodeId: 'coordinates', port: 'Generated' }, to: { nodeId: 'mapping', port: 'Vector' } },
      { from: { nodeId: 'mapping', port: 'Vector' }, to: { nodeId: 'noise', port: 'Vector' } },
      { from: { nodeId: 'noise', port: 'Fac' }, to: { nodeId: 'noise-reroute', port: 'Input' } },
      { from: { nodeId: 'noise-reroute', port: 'Output' }, to: { nodeId: 'pigment-ramp', port: 'Fac' } },
      { from: { nodeId: 'pigment-ramp', port: 'Color' }, to: { nodeId: 'dust-mix', port: 'A_Color' } },
    ],
    outputs: {
      albedo: { nodeId: 'dust-mix', port: 'Result_Color', colorSpace: 'srgb' },
    },
    settings: textureSettings(),
  };
}

test('Blender 5.2 layout nodes are available by RNA ID in shader and texture catalogs', () => {
  for (const domain of ['shader', 'texture']) {
    const frame = GRAPH_CATALOGS[domain].nodes.NodeFrame;
    const reroute = GRAPH_CATALOGS[domain].nodes.NodeReroute;

    assert.ok(frame, `${domain} catalog is missing NodeFrame`);
    assert.ok(reroute, `${domain} catalog is missing NodeReroute`);
    assert.equal(frame.canonicalType, 'blender.frame');
    assert.equal(reroute.canonicalType, 'blender.reroute');
    assert.equal(frame.params.labelSize.default, 0);
    assert.equal(frame.params.shrink.default, false);
    assert.equal(reroute.inputs.input.type, 'sameNumeric');
    assert.equal(reroute.outputs.output.type, 'sameNumeric');
    assert.ok(frame.tags.includes('layout'));
    assert.ok(reroute.tags.includes('layout'));
  }

  const result = queryGraphCatalog('texture', { types: ['NodeFrame', 'NodeReroute'] });
  assert.deepEqual(result.nodes.map((entry) => entry.type).sort(), ['NodeFrame', 'NodeReroute']);
  assert.equal(result.nodes.find((entry) => entry.type === 'NodeReroute').blender.canonicalType, 'blender.reroute');
});

test('complex Blender texture flow canonicalizes mixed socket IDs, labels, defaults, and reroutes', () => {
  const validation = validateGraph(complexBlenderTextureGraph());
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.deepEqual(validation.warnings, [], JSON.stringify(validation.warnings));

  const nodes = Object.fromEntries(validation.graph.nodes.map((node) => [node.id, node]));
  assert.deepEqual(nodes.mapping.inputs.location, [0.13, -0.08, 0]);
  assert.deepEqual(nodes.mapping.inputs.scale, [2.5, 3.25, 1]);
  assert.equal(nodes.noise.inputs.scale, 7.5);
  assert.equal(nodes.noise.inputs.detail, 4);
  assert.equal(nodes.noise.inputs.roughness, 0.62);
  assert.equal(nodes.noise.inputs.distortion, 0.18);
  assert.equal(nodes['dust-mix'].inputs.factor, 0.68);
  assert.deepEqual(nodes['dust-mix'].inputs.b, [0.72, 0.61, 0.38, 1]);

  assert.deepEqual(validation.graph.edges, [
    { from: { nodeId: 'coordinates', port: 'generated' }, to: { nodeId: 'mapping', port: 'vector' } },
    { from: { nodeId: 'mapping', port: 'vector' }, to: { nodeId: 'noise', port: 'vector' } },
    { from: { nodeId: 'noise', port: 'factor' }, to: { nodeId: 'noise-reroute', port: 'input' } },
    { from: { nodeId: 'noise-reroute', port: 'output' }, to: { nodeId: 'pigment-ramp', port: 'factor' } },
    { from: { nodeId: 'pigment-ramp', port: 'color' }, to: { nodeId: 'dust-mix', port: 'a' } },
  ]);
  assert.deepEqual(validation.graph.outputs.albedo, {
    nodeId: 'dust-mix',
    port: 'result',
    colorSpace: 'srgb',
  });
});

test('socket aliases cannot silently specify the same Blender socket twice', () => {
  const graph = complexBlenderTextureGraph();
  graph.nodes.find((node) => node.id === 'dust-mix').inputs.factor = 0.25;
  const validation = validateGraph(graph);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((entry) => entry.code === 'duplicate_socket_default' && entry.nodeId === 'dust-mix'));
});
