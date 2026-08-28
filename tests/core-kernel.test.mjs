import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthoringKernel,
  StudioError,
  createProjectDocument,
  hashEntitySubtree,
} from '../src/core/index.mjs';

function createKernel(options = {}) {
  let sequence = 0;
  return new AuthoringKernel(createProjectDocument({
    projectId: 'project/kernel-test',
    timestamp: '2026-08-28T00:00:00.000Z',
  }), {
    clock: () => Date.UTC(2026, 7, 28, 1, 0, sequence),
    transactionIdFactory: (prefix) => `${prefix}/test-${++sequence}`,
    ...options,
  });
}

function request(overrides = {}) {
  return {
    protocolVersion: 'three-studio/1',
    projectId: 'project/kernel-test',
    label: 'Test transaction',
    baseRevision: 0,
    idempotencyKey: 'idempotency-test-0001',
    operations: [],
    ...overrides,
  };
}

test('applies an alias-aware changeset atomically with one revision', async () => {
  const kernel = createKernel();
  const result = await kernel.apply(request({
    operations: [
      {
        type: 'resource.create',
        resourceType: 'geometry',
        alias: '$box',
        resource: { id: 'geometry/courtyard-box', kind: 'box', size: [2, 1, 2] },
      },
      {
        type: 'resource.create',
        resourceType: 'material',
        alias: '$stone',
        resource: { id: 'material/wet-stone', kind: 'standard', roughness: 0.7 },
      },
      {
        type: 'entity.create',
        sceneId: 'scene/main',
        alias: '$fountain',
        entity: {
          id: 'courtyard/fountain',
          kind: 'mesh',
          components: { mesh: { geometryId: '$box', materialIds: ['$stone'] } },
        },
      },
    ],
  }));
  assert.equal(result.revision, 1);
  assert.deepEqual(result.resolvedIds, {
    $box: 'geometry/courtyard-box',
    $stone: 'material/wet-stone',
    $fountain: 'courtyard/fountain',
  });
  assert.equal(kernel.document.scenes['scene/main'].entities['courtyard/fountain'].components.mesh.geometryId, 'geometry/courtyard-box');
  assert.equal(result.invalidations.includes('rtxTopology'), true);
  assert.equal(kernel.status().undoAvailable, true);
});

test('a failed operation leaves the entire batch and revision untouched', async () => {
  const kernel = createKernel();
  await assert.rejects(kernel.apply(request({
    operations: [
      { type: 'resource.create', resourceType: 'geometry', resource: { id: 'geometry/temporary', kind: 'box' } },
      { type: 'entity.create', sceneId: 'scene/missing', entity: { id: 'world/fail', kind: 'mesh' } },
    ],
  })), (error) => error instanceof StudioError && error.code === 'not_found');
  assert.equal(kernel.revision, 0);
  assert.equal(kernel.document.resources.geometries['geometry/temporary'], undefined);
});

test('dry-run returns exact impact without mutating document or history', async () => {
  const kernel = createKernel();
  const result = await kernel.apply(request({
    dryRun: true,
    operations: [{ type: 'scene.create', scene: { id: 'scene/interior', name: 'Interior' } }],
  }));
  assert.equal(result.dryRun, true);
  assert.equal(result.revision, 0);
  assert.equal(result.expectedRevision, 1);
  assert.equal(kernel.document.scenes['scene/interior'], undefined);
  assert.deepEqual(kernel.history(), []);
});

test('dry-run prepares the candidate without committing or notifying', async () => {
  const prepared = [];
  const events = [];
  const kernel = new AuthoringKernel(createProjectDocument({ projectId: 'project/dry-prepare' }), {
    prepare: async (document, context) => prepared.push({ document, context }),
  });
  kernel.subscribe(event => events.push(event));
  const result = await kernel.apply({
    label: 'Compile candidate only',
    baseRevision: 0,
    idempotencyKey: 'dry-prepare-1',
    dryRun: true,
    operations: [{ type: 'scene.create', scene: { id: 'scene/candidate' } }],
  });
  assert.equal(result.dryRun, true);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].document.revision, 1);
  assert.equal(prepared[0].document.scenes['scene/candidate'].id, 'scene/candidate');
  assert.equal(prepared[0].context.dryRun, true);
  assert.equal(kernel.revision, 0);
  assert.equal(events.length, 0);
});

test('idempotency returns the completed response and rejects key reuse', async () => {
  const kernel = createKernel();
  const firstRequest = request({
    operations: [{ type: 'scene.create', scene: { id: 'scene/interior' } }],
  });
  const first = await kernel.apply(firstRequest);
  const repeated = await kernel.apply(firstRequest);
  assert.deepEqual(repeated, first);
  assert.equal(kernel.revision, 1);
  await assert.rejects(kernel.apply({
    ...firstRequest,
    label: 'Different request',
    operations: [{ type: 'scene.create', scene: { id: 'scene/garden' } }],
  }), (error) => error.code === 'idempotency_conflict');
});

test('revision conflicts include compact IDs changed since the stale base', async () => {
  const kernel = createKernel();
  await kernel.apply(request({
    operations: [{ type: 'scene.create', scene: { id: 'scene/interior' } }],
  }));
  await assert.rejects(kernel.apply(request({
    label: 'Stale transaction',
    idempotencyKey: 'idempotency-test-stale',
    operations: [{ type: 'scene.create', scene: { id: 'scene/garden' } }],
  })), (error) => {
    assert.equal(error.code, 'revision_conflict');
    assert.equal(error.details.currentRevision, 1);
    assert.equal(error.details.changedIds.includes('scene/interior'), true);
    return true;
  });
});

test('undo and redo are compensating transactions with increasing revisions', async () => {
  const kernel = createKernel();
  const created = await kernel.apply(request({
    operations: [{ type: 'entity.create', sceneId: 'scene/main', entity: { id: 'world/door', kind: 'gameObject' } }],
  }));
  const undone = await kernel.undo({
    label: 'Undo door',
    baseRevision: 1,
    idempotencyKey: 'idempotency-undo-door',
  });
  assert.equal(undone.revision, 2);
  assert.equal(undone.compensatedTransactionId, created.transactionId);
  assert.equal(kernel.document.scenes['scene/main'].entities['world/door'], undefined);
  const redone = await kernel.redo({
    label: 'Redo door',
    baseRevision: 2,
    idempotencyKey: 'idempotency-redo-door',
  });
  assert.equal(redone.revision, 3);
  assert.equal(redone.replayedTransactionId, created.transactionId);
  assert.equal(kernel.document.scenes['scene/main'].entities['world/door'].kind, 'gameObject');
});

test('selective undo does not lose later camera state', async () => {
  const kernel = createKernel();
  const material = await kernel.apply(request({
    label: 'Create wet stone',
    operations: [{ type: 'resource.create', resourceType: 'material', resource: { id: 'material/wet-stone', kind: 'nodePhysical' } }],
  }));
  await kernel.apply(request({
    baseRevision: 1,
    label: 'Create review camera',
    idempotencyKey: 'idempotency-camera-0002',
    operations: [
      { type: 'entity.create', sceneId: 'scene/main', entity: { id: 'camera/review', kind: 'perspectiveCamera' } },
      { type: 'scene.setActiveCamera', sceneId: 'scene/main', cameraId: 'camera/review' },
    ],
  }));
  await kernel.undo({
    label: 'Undo only material',
    baseRevision: 2,
    idempotencyKey: 'idempotency-undo-material',
    transactionId: material.transactionId,
  });
  assert.equal(kernel.document.resources.materials['material/wet-stone'], undefined);
  assert.equal(kernel.document.scenes['scene/main'].settings.activeCameraId, 'camera/review');
  assert.equal(kernel.document.scenes['scene/main'].entities['camera/review'].kind, 'perspectiveCamera');
});

test('recursive deletion is guarded by the exact inspected subtree hash', async () => {
  const kernel = createKernel();
  await kernel.apply(request({
    operations: [
      { type: 'entity.create', sceneId: 'scene/main', entity: { id: 'world/group', kind: 'group' } },
      { type: 'entity.create', sceneId: 'scene/main', entity: { id: 'world/group/child', kind: 'empty', parentId: 'world/group' } },
    ],
  }));
  await assert.rejects(kernel.apply(request({
    baseRevision: 1,
    idempotencyKey: 'idempotency-delete-bad',
    operations: [{ type: 'entity.delete', entityId: 'world/group', recursive: true, expectedSubtreeHash: 'bad' }],
  })), (error) => error.code === 'guard_failed');
  const expectedSubtreeHash = hashEntitySubtree(kernel.document, 'world/group');
  await kernel.apply(request({
    baseRevision: 1,
    idempotencyKey: 'idempotency-delete-good',
    operations: [{ type: 'entity.delete', entityId: 'world/group', recursive: true, expectedSubtreeHash }],
  }));
  assert.equal(kernel.document.scenes['scene/main'].entities['world/group'], undefined);
});

test('candidate preparation failure rolls back before acknowledgement', async () => {
  const kernel = createKernel({
    prepare: async () => { throw new Error('shader compile failed'); },
  });
  await assert.rejects(kernel.apply(request({
    operations: [{ type: 'scene.create', scene: { id: 'scene/rejected' } }],
  })), /shader compile failed/);
  assert.equal(kernel.revision, 0);
  assert.equal(kernel.document.scenes['scene/rejected'], undefined);
});
