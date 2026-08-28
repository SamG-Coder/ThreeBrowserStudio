import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BLENDER_SHADER_NODE_INVENTORY,
  BLENDER_SHADER_NODE_INVENTORY_SUMMARY,
  queryBlenderShaderNodeInventory,
} from '../src/graphs/index.mjs';

test('official Blender 5.2 shader menu inventory is complete and status-separated', () => {
  assert.ok(BLENDER_SHADER_NODE_INVENTORY_SUMMARY.currentMenu >= 110);
  assert.ok(BLENDER_SHADER_NODE_INVENTORY_SUMMARY.liveTsl >= 29);
  assert.equal(BLENDER_SHADER_NODE_INVENTORY_SUMMARY.total, BLENDER_SHADER_NODE_INVENTORY.length);
  for (const id of [
    'ShaderNodeTexNoise', 'ShaderNodeTexGabor', 'ShaderNodeBsdfPrincipled',
    'ShaderNodeVolumeCoefficients', 'NodeClosureInput', 'NodeFrame',
  ]) assert.ok(BLENDER_SHADER_NODE_INVENTORY.some(node => node.id === id), `missing ${id}`);
});

test('inventory distinguishes current nodes, live TSL, and legacy migrations', () => {
  const noise = queryBlenderShaderNodeInventory({ search: 'Noise' });
  assert.ok(noise.nodes.some(node => node.id === 'ShaderNodeTexNoise' && node.status === 'live-tsl'));
  assert.ok(noise.nodes.some(node => node.id === 'ShaderNodeTexWhiteNoise' && node.status === 'live-tsl'));
  assert.ok(noise.nodes.some(node => node.id === 'ShaderNodeTexMusgrave' && node.replacement === 'ShaderNodeTexNoise'));
  const liveTextures = queryBlenderShaderNodeInventory({ status: 'live-tsl', category: 'texture' });
  assert.ok(liveTextures.nodes.every(node => node.status === 'live-tsl' && node.categories.includes('texture')));
});

test('inventory accounts for all 100 Blender 5.2 ShaderNode API subclasses without inflating the Add menu', () => {
  assert.equal(BLENDER_SHADER_NODE_INVENTORY_SUMMARY.apiDirectSubclasses, 100);
  assert.equal(BLENDER_SHADER_NODE_INVENTORY_SUMMARY.apiOnly, 2);
  assert.equal(BLENDER_SHADER_NODE_INVENTORY_SUMMARY.currentMenu, 115);

  const apiOnly = queryBlenderShaderNodeInventory({ category: 'apiOnly' });
  assert.deepEqual(apiOnly.nodes.map((entry) => entry.id), [
    'ShaderNodeCustomGroup',
    'ShaderNodeSqueeze',
  ]);
  assert.ok(apiOnly.nodes.every((entry) => entry.status === 'api-only'));
  assert.ok(apiOnly.nodes.every((entry) => entry.officialSource === BLENDER_SHADER_NODE_INVENTORY_SUMMARY.officialApiSource));
});
