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

test('entity component aliases resolve singular materials and typed targets', async () => {
  const kernel = createKernel();
  await kernel.apply(request({
    idempotencyKey: 'idempotency-component-aliases',
    operations: [
      {
        type: 'resource.create', resourceType: 'geometry', alias: '$geometry',
        resource: { id: 'geometry/source', kind: 'box' },
      },
      {
        type: 'resource.create', resourceType: 'material', alias: '$material',
        resource: { id: 'material/source', kind: 'standard' },
      },
      {
        type: 'resource.create', resourceType: 'animation', alias: '$animation',
        resource: { id: 'animation/source' },
      },
      {
        type: 'resource.create', resourceType: 'prefab', alias: '$prefab',
        resource: { id: 'prefab/source' },
      },
      {
        type: 'resource.create', resourceType: 'audio', alias: '$audio',
        resource: { id: 'audio/source' },
      },
      {
        type: 'entity.create', sceneId: 'scene/main', alias: '$target',
        entity: { id: 'entity/target', kind: 'empty' },
      },
      {
        type: 'entity.create', sceneId: 'scene/main', alias: '$subject',
        entity: {
          id: 'entity/subject',
          kind: 'mesh',
          components: {
            mesh: { geometryId: '$geometry', materialId: '$material' },
            light: { targetId: '$target' },
            constraints: [{ id: 'constraint/target', type: 'lookAt', targetId: '$target' }],
            animation: { actionId: '$animation' },
            prefab: { prefabId: '$prefab' },
            audio: { audioId: '$audio' },
          },
        },
      },
    ],
  }));

  const components = kernel.document.scenes['scene/main'].entities['entity/subject'].components;
  assert.equal(components.mesh.geometryId, 'geometry/source');
  assert.equal(components.mesh.materialId, 'material/source');
  assert.equal(components.light.targetId, 'entity/target');
  assert.equal(components.constraints[0].targetId, 'entity/target');
  assert.equal(components.animation.actionId, 'animation/source');
  assert.equal(components.prefab.prefabId, 'prefab/source');
  assert.equal(components.audio.audioId, 'audio/source');
});

test('layout.pattern upserts by stable modifier ID, dry-runs, rejects collisions, and undoes', async () => {
  const kernel = createKernel();
  await kernel.apply(request({
    idempotencyKey: 'idempotency-layout-create',
    operations: [
      {
        type: 'resource.create', resourceType: 'geometry', alias: '$geometry',
        resource: { id: 'geometry/pattern-source', kind: 'box' },
      },
      {
        type: 'entity.create', sceneId: 'scene/main', alias: '$source',
        entity: {
          id: 'entity/pattern-source',
          kind: 'mesh',
          components: {
            mesh: { geometryId: '$geometry' },
            modifiers: [{ id: 'modifier/mirror', type: 'mirror', axis: 'x' }],
          },
        },
      },
      {
        type: 'layout.pattern',
        entityId: '$source',
        pattern: { id: 'modifier/pattern', mode: 'linear', count: 4, offset: [2, 0, 0] },
      },
    ],
  }));

  const modifiers = () => kernel.document.scenes['scene/main']
    .entities['entity/pattern-source'].components.modifiers;
  assert.deepEqual(modifiers().map(item => item.id), ['modifier/mirror', 'modifier/pattern']);
  assert.deepEqual(modifiers()[1], {
    id: 'modifier/pattern', type: 'pattern', mode: 'linear', count: 4, offset: [2, 0, 0],
  });

  const gridOperation = {
    type: 'layout.pattern',
    entityId: 'entity/pattern-source',
    pattern: { id: 'modifier/pattern', mode: 'grid', counts: [2, 3, 1], spacing: [5, 1, 2] },
  };
  const dryRun = await kernel.apply(request({
    baseRevision: 1,
    dryRun: true,
    idempotencyKey: 'idempotency-layout-dry-run',
    operations: [gridOperation],
  }));
  assert.equal(dryRun.dryRun, true);
  assert.equal(kernel.revision, 1);
  assert.equal(modifiers()[1].mode, 'linear');

  await kernel.apply(request({
    baseRevision: 1,
    idempotencyKey: 'idempotency-layout-update',
    operations: [gridOperation],
  }));
  assert.deepEqual(modifiers().map(item => item.id), ['modifier/mirror', 'modifier/pattern']);
  assert.deepEqual(modifiers()[1], {
    id: 'modifier/pattern', type: 'pattern', mode: 'grid', counts: [2, 3, 1], spacing: [5, 1, 2],
  });

  await assert.rejects(kernel.apply(request({
    baseRevision: 2,
    idempotencyKey: 'idempotency-layout-collision',
    operations: [{
      type: 'layout.pattern',
      entityId: 'entity/pattern-source',
      pattern: { id: 'modifier/mirror', mode: 'linear', count: 2, offset: [1, 0, 0] },
    }],
  })), error => error.code === 'layout_pattern_id_collision');
  assert.equal(kernel.revision, 2);

  await assert.rejects(kernel.apply(request({
    baseRevision: 2,
    idempotencyKey: 'idempotency-layout-too-large',
    operations: [{
      type: 'layout.pattern',
      entityId: 'entity/pattern-source',
      pattern: {
        id: 'modifier/pattern', mode: 'grid', counts: [64, 64, 3], spacing: [1, 1, 1],
      },
    }],
  })), error => error.code === 'invalid_layout_pattern');
  assert.equal(kernel.revision, 2);

  await kernel.undo({
    label: 'Undo pattern update',
    baseRevision: 2,
    idempotencyKey: 'idempotency-layout-undo',
  });
  assert.deepEqual(modifiers().map(item => item.id), ['modifier/mirror', 'modifier/pattern']);
  assert.deepEqual(modifiers()[1], {
    id: 'modifier/pattern', type: 'pattern', mode: 'linear', count: 4, offset: [2, 0, 0],
  });
});

test('layout.pattern normalizes seeded scatter ranges into canonical modifier data', async () => {
  const kernel = createKernel();
  await kernel.apply(request({
    idempotencyKey: 'idempotency-scatter-create',
    operations: [
      {
        type: 'resource.create', resourceType: 'geometry', alias: '$geometry',
        resource: { id: 'geometry/scatter-source', kind: 'box' },
      },
      {
        type: 'entity.create', sceneId: 'scene/main', alias: '$source',
        entity: {
          id: 'entity/scatter-source', kind: 'mesh',
          components: { mesh: { geometryId: '$geometry' } },
        },
      },
      {
        type: 'layout.pattern', entityId: '$source',
        pattern: {
          id: 'modifier/scatter', mode: 'scatter', count: 12, seed: -17,
          bounds: { min: [-5, 0, -3], max: [5, 2, 3] },
          rotationMax: [0.1, 0.2, 0.3],
          scaleMin: [0.8, 0.9, 1], scaleMax: [1.2, 1.3, 1.4],
        },
      },
    ],
  }));

  const [modifier] = kernel.document.scenes['scene/main']
    .entities['entity/scatter-source'].components.modifiers;
  assert.deepEqual(modifier, {
    id: 'modifier/scatter', type: 'pattern', mode: 'scatter', count: 12, seed: -17,
    bounds: { min: [-5, 0, -3], max: [5, 2, 3] },
    rotationMin: [0.1, 0.2, 0.3], rotationMax: [0.1, 0.2, 0.3],
    scaleMin: [0.8, 0.9, 1], scaleMax: [1.2, 1.3, 1.4],
  });

  await assert.rejects(kernel.apply(request({
    baseRevision: 1,
    idempotencyKey: 'idempotency-scatter-inverted',
    operations: [{
      type: 'layout.pattern', entityId: 'entity/scatter-source',
      pattern: {
        id: 'modifier/scatter', mode: 'scatter', count: 12, seed: -17,
        bounds: { min: [2, 0, 0], max: [1, 1, 1] },
      },
    }],
  })), error => error.code === 'invalid_layout_pattern');
  assert.equal(kernel.revision, 1);

  await assert.rejects(kernel.apply(request({
    baseRevision: 1,
    idempotencyKey: 'idempotency-scatter-zero-scale',
    operations: [{
      type: 'layout.pattern', entityId: 'entity/scatter-source',
      pattern: {
        id: 'modifier/scatter', mode: 'scatter', count: 12, seed: -17,
        bounds: { min: [-1, 0, -1], max: [1, 1, 1] },
        scaleMin: [0, 1, 1], scaleMax: [1, 2, 2],
      },
    }],
  })), error => error.code === 'invalid_layout_pattern');
  assert.equal(kernel.revision, 1);
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
