import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthoringKernel,
  StudioError,
  contentHash,
  createProjectDocument,
} from '../src/core/index.mjs';

function createKernel() {
  let sequence = 0;
  return new AuthoringKernel(createProjectDocument({
    projectId: 'project/scene-clear',
    timestamp: '2026-08-31T00:00:00.000Z',
  }), {
    clock: () => Date.UTC(2026, 7, 31, 1, 0, sequence),
    transactionIdFactory: (prefix) => `${prefix}/clear-${++sequence}`,
  });
}

function request(overrides = {}) {
  return {
    protocolVersion: 'three-studio/1',
    projectId: 'project/scene-clear',
    label: 'Test scene clear',
    baseRevision: 0,
    idempotencyKey: 'scene-clear-0001',
    operations: [],
    ...overrides,
  };
}

test('scene.clear wipes entities and collections while keeping the scene id', async () => {
  const kernel = createKernel();
  await kernel.apply(request({
    operations: [
      { type: 'entity.create', sceneId: 'scene/main', entity: { id: 'entity/hero', kind: 'mesh', name: 'Hero' } },
      { type: 'collection.create', sceneId: 'scene/main', collection: { id: 'collection/set', name: 'Set', entityIds: ['entity/hero'] } },
    ],
  }));
  const scene = kernel.document.scenes['scene/main'];
  const cleared = await kernel.apply(request({
    baseRevision: 1,
    idempotencyKey: 'scene-clear-0002',
    label: 'Clear the stage',
    operations: [{ type: 'scene.clear', sceneId: 'scene/main', expectedSceneHash: contentHash(scene) }],
  }));
  assert.equal(cleared.success, true);
  assert.equal(cleared.revision, 2);
  const empty = kernel.document.scenes['scene/main'];
  assert.equal(empty.id, 'scene/main');
  assert.equal(empty.name, 'Main Scene');
  assert.deepEqual(empty.entities, {});
  assert.deepEqual(empty.collections, {});
  assert.deepEqual(empty.rootEntityIds, []);
  assert.equal(empty.settings.activeCameraId, null);

  const undone = await kernel.undo({
    label: 'Restore cleared scene',
    baseRevision: 2,
    idempotencyKey: 'scene-clear-undo-0001',
    transactionId: cleared.transactionId,
  });
  assert.equal(undone.success, true);
  assert.ok(kernel.document.scenes['scene/main'].entities['entity/hero']);
  assert.ok(kernel.document.scenes['scene/main'].collections['collection/set']);
});

test('clearing a populated scene without the exact scene hash fails', async () => {
  const kernel = createKernel();
  await kernel.apply(request({
    operations: [{ type: 'entity.create', sceneId: 'scene/main', entity: { id: 'entity/keep', kind: 'empty' } }],
  }));
  await assert.rejects(kernel.apply(request({
    baseRevision: 1,
    idempotencyKey: 'scene-clear-guard-0001',
    operations: [{ type: 'scene.clear', sceneId: 'scene/main' }],
  })), error => error instanceof StudioError && error.code === 'guard_failed');
  assert.ok(kernel.document.scenes['scene/main'].entities['entity/keep']);
});

test('clearing an already empty scene does not require a hash', async () => {
  const kernel = createKernel();
  const result = await kernel.apply(request({
    operations: [{ type: 'scene.clear', sceneId: 'scene/main' }],
  }));
  assert.equal(result.success, true);
  assert.equal(Object.keys(kernel.document.scenes['scene/main'].entities).length, 0);
});
