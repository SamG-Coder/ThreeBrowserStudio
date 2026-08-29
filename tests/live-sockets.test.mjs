import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GRAPH_SOCKET_CONTRACT,
  PIXEL_QUANTUM,
  bumpEffectiveScale,
  describeSocketLiveness,
  isBelowPixelQuantum,
  isCompiledShaderNodeType,
  principledFeatureFlags,
} from '../src/graphs/index.mjs';

test('Principled catalog-only sockets stay unbound while live lobes follow authored values', () => {
  assert.equal(GRAPH_SOCKET_CONTRACT, 'full-vs-default+live');
  assert.equal(isCompiledShaderNodeType('shader', 'blender.principledBSDF'), true);
  assert.equal(isCompiledShaderNodeType('shader', 'ShaderNodeScript'), false);

  const node = {
    id: 'bsdf',
    type: 'blender.principledBSDF',
    inputs: { sheenWeight: 0.38, specularIorLevel: 0.35 },
  };
  const incoming = new Set();
  assert.equal(describeSocketLiveness(node, 'shader', 'weight', incoming).live, false);
  assert.equal(describeSocketLiveness(node, 'shader', 'sheenWeight', incoming).live, true);
  assert.equal(describeSocketLiveness(node, 'shader', 'specularIorLevel', incoming).live, true);
  assert.equal(describeSocketLiveness(node, 'shader', 'anisotropic', incoming).live, false);
  assert.equal(describeSocketLiveness({ ...node, inputs: {} }, 'shader', 'sheenWeight', incoming).live, false);
  assert.equal(principledFeatureFlags(node, incoming).sheen, true);
});

test('bump strength times distance below 8-bit is a no-op forecast', () => {
  assert.ok(Math.abs(bumpEffectiveScale(0.22, 0.0008) - 0.000176) < 1e-12);
  assert.equal(isBelowPixelQuantum(0.000176), true);
  assert.equal(isBelowPixelQuantum(PIXEL_QUANTUM), false);
});
