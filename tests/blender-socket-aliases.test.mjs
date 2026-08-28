import assert from 'node:assert/strict';
import test from 'node:test';

import { validateGraph } from '../src/graphs/index.mjs';

test('Blender display names and RNA socket identifiers normalize to stable Studio ports', () => {
  const validation = validateGraph({
    formatVersion: 1,
    id: 'shader/blender-socket-identifiers',
    domain: 'shader',
    nodes: [
      { id: 'coords', type: 'ShaderNodeTexCoord', params: {} },
      { id: 'noise', type: 'ShaderNodeTexNoise', params: {}, inputs: { Scale: 7 } },
      { id: 'principled', type: 'ShaderNodeBsdfPrincipled', params: {}, inputs: { 'Base Color': [0.2, 0.5, 0.3, 1] } },
      { id: 'output', type: 'ShaderNodeOutputMaterial', params: {} },
    ],
    edges: [
      { from: { nodeId: 'coords', port: 'Generated' }, to: { nodeId: 'noise', port: 'Vector' } },
      { from: { nodeId: 'noise', port: 'Factor' }, to: { nodeId: 'principled', port: 'Roughness' } },
      { from: { nodeId: 'principled', port: 'BSDF' }, to: { nodeId: 'output', port: 'Surface' } },
    ],
    outputs: { surface: { nodeId: 'output', port: 'Surface' } },
  });

  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.deepEqual(validation.graph.edges.map(edge => [edge.from.port, edge.to.port]), [
    ['generated', 'vector'], ['factor', 'roughness'], ['surface', 'surface'],
  ]);
  assert.equal(validation.graph.nodes.find(node => node.id === 'noise').inputs.scale, 7);
  assert.deepEqual(validation.graph.nodes.find(node => node.id === 'principled').inputs.baseColor, [0.2, 0.5, 0.3, 1]);
  assert.deepEqual(validation.graph.outputs.surface, { nodeId: 'output', port: 'surface' });
});
