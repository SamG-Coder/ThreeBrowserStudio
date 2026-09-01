import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthoringKernel,
  createProjectDocument,
  queryEntityComponentCatalog,
} from '../src/core/index.mjs';

function project() {
  return createProjectDocument({
    projectId: 'project/component-composer',
    scenes: [{
      id: 'scene/main',
      rootEntityIds: ['entity/player'],
      entities: [{ id: 'entity/player', kind: 'gameObject', name: 'Player' }],
    }],
  });
}

function request(kernel, operations, suffix) {
  return kernel.apply({
    projectId: kernel.projectId,
    baseRevision: kernel.revision,
    label: `Component ${suffix}`,
    idempotencyKey: `component-${suffix}-0001`,
    operations,
  });
}

test('typed component operations attach, remove, and undo atomically', async () => {
  const kernel = new AuthoringKernel(project());
  await request(kernel, [{
    op: 'entity.component.attach',
    entityId: 'entity/player',
    component: 'rigidBody',
    value: { enabled: true, bodyType: 'dynamic', mass: 1 },
  }], 'attach');
  assert.equal(kernel.document.scenes['scene/main'].entities['entity/player'].components.rigidBody.mass, 1);

  await request(kernel, [{
    op: 'entity.patch',
    entityId: 'entity/player',
    patch: { components: { rigidBody: { mass: 4 } } },
  }], 'patch');
  assert.equal(kernel.document.scenes['scene/main'].entities['entity/player'].components.rigidBody.mass, 4);

  const removed = await request(kernel, [{
    op: 'entity.component.remove',
    entityId: 'entity/player',
    component: 'rigidBody',
  }], 'remove');
  assert.equal(kernel.document.scenes['scene/main'].entities['entity/player'].components.rigidBody, undefined);

  await kernel.undo({
    projectId: kernel.projectId,
    baseRevision: kernel.revision,
    label: 'Undo component removal',
    idempotencyKey: 'component-undo-0001',
    transactionId: removed.transactionId,
  });
  assert.equal(kernel.document.scenes['scene/main'].entities['entity/player'].components.rigidBody.mass, 4);
});

test('component catalog reports compatibility and installed state', () => {
  const catalog = queryEntityComponentCatalog({ entityKind: 'gameObject', installed: ['collider'] });
  assert.equal(catalog.find(item => item.id === 'collider').installed, true);
  assert.equal(catalog.find(item => item.id === 'camera').compatible, false);
});

test('component attach rejects incompatible entity kinds', async () => {
  const kernel = new AuthoringKernel(project());
  await assert.rejects(
    request(kernel, [{
      op: 'entity.component.attach',
      entityId: 'entity/player',
      component: 'camera',
      value: { fov: 46 },
    }], 'bad-kind'),
    error => error.code === 'component_incompatible',
  );
});
