import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GRAPH_CATALOGS,
  GRAPH_SOCKET_CONTRACT,
  PIXEL_QUANTUM,
  bumpEffectiveScale,
  describeSocketLiveness,
  isBelowPixelQuantum,
  isCompiledShaderNodeType,
  principledFeatureFlags,
} from '../src/graphs/index.mjs';

test('every staged executable shader catalog node is registered as live-compiled', () => {
  const missing = [];
  const seen = new Set();

  for (const definition of Object.values(GRAPH_CATALOGS.shader.nodes)) {
    const canonicalType = definition.canonicalType ?? definition.type;
    if (seen.has(canonicalType)) continue;
    seen.add(canonicalType);
    if (definition.stages.length === 0 || definition.tags.includes('non-executable')) continue;
    if (!isCompiledShaderNodeType('shader', canonicalType)) missing.push(canonicalType);
  }

  assert.deepEqual(missing.sort(), []);
});

test('binary math sockets report the same live support as their TSL compiler branch', () => {
  for (const operation of ['add', 'subtract', 'multiply', 'divide', 'min', 'max', 'power']) {
    const node = { id: operation, type: `math.${operation}`, params: { valueType: 'float' } };
    assert.equal(isCompiledShaderNodeType('shader', node.type), true, node.type);
    assert.deepEqual(describeSocketLiveness(node, 'shader', 'a', new Set()), {
      compiled: true,
      live: true,
      reason: 'live-tsl',
    });
  }
});

test('CPU-bake-only texture nodes are never advertised as live WebGPU nodes', () => {
  for (const type of ['image', 'blur']) {
    assert.equal(isCompiledShaderNodeType('texture', type), false, type);
    assert.deepEqual(describeSocketLiveness({ id: type, type }, 'texture', 'value', new Set()), {
      compiled: false,
      live: false,
      reason: 'catalog-only-node',
    });
  }
});

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
