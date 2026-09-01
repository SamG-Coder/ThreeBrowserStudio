import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectDocument } from '../src/core/index.mjs';
import { applyComponentWorkspace, readComponentWorkspace } from '../src/viewport/component-workspace.mjs';

function document() {
  return createProjectDocument({
    projectId: 'project/component-workspace',
    scenes: [{
      id: 'scene/main',
      rootEntityIds: ['entity/player'],
      entities: [{
        id: 'entity/player', kind: 'gameObject', name: 'Player',
        components: {
          rigidBody: { enabled: true, bodyType: 'dynamic', mass: 1 },
          collider: { enabled: true, shape: 'box', size: [1, 1, 1] },
        },
      }],
    }],
  });
}

test('retained component workspace exposes every predefined component and complete physics defaults', () => {
  const workspace = readComponentWorkspace(document(), 'entity/player');
  assert.equal(workspace.entity.name, 'Player');
  assert.equal(workspace.catalog.length, 6);
  assert.equal(workspace.catalog.find(item => item.id === 'rigidBody').suggestedValue.alignToSurface, false);
  assert.equal(workspace.catalog.find(item => item.id === 'collider').suggestedValue.slopeAxis, 'x');
  assert.equal(workspace.catalog.find(item => item.id === 'camera').compatible, false);
});

test('component workspace lowers add, edit, and remove through one canonical MCP batch', async () => {
  const calls = [];
  const application = {
    document: document(),
    async dispatch(name, params) { calls.push({ name, params }); return { success: true }; },
  };
  await applyComponentWorkspace(application, 'entity/player', {
    rigidBody: { enabled: true, bodyType: 'dynamic', mass: 4 },
    animation: { enabled: true },
  });
  assert.equal(calls[0].name, 'three_studio_apply');
  assert.deepEqual(calls[0].params.operations.map(operation => operation.op), [
    'entity.patch', 'entity.component.remove', 'entity.component.attach',
  ]);
  assert.equal(calls[0].params.operations[0].patch.components.rigidBody.mass, 4);
  assert.equal(calls[0].params.operations[1].component, 'collider');
  assert.equal(calls[0].params.operations[2].component, 'animation');
});
