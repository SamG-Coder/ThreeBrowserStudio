import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AuthoringKernel,
  buildProjectIndex,
  composeTransformMatrix,
  contentHash,
  createProjectDocument,
  hashEntitySubtree,
  hashExactEntitySet,
  multiplyTransformMatrices,
} from '../src/core/index.mjs';

function request(baseRevision, idempotencyKey, operations) {
  return {
    protocolVersion: 'three-studio/1',
    projectId: 'project/editing-controls',
    label: idempotencyKey,
    baseRevision,
    idempotencyKey,
    operations,
  };
}

function kernelWithEntities(entities, rootEntityIds) {
  return new AuthoringKernel(createProjectDocument({
    projectId: 'project/editing-controls',
    timestamp: '2026-08-29T00:00:00.000Z',
    scenes: [{ id: 'scene/main', entities, ...(rootEntityIds ? { rootEntityIds } : {}) }],
  }));
}

function worldMatrix(document, entityId) {
  const { scene, entity } = buildProjectIndex(document).getEntity(entityId);
  const local = composeTransformMatrix(entity.transform);
  return entity.parentId
    ? multiplyTransformMatrices(worldMatrix(document, entity.parentId), local)
    : local;
}

function assertMatrixClose(actual, expected, tolerance = 1e-8) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) <= tolerance, `matrix[${index}] ${value} differs from ${expected[index]}`);
  });
}

test('guarded bulk patch and transform mutate an exact entity set with one revision and selective undo', async () => {
  const kernel = kernelWithEntities([
    { id: 'entity/a', name: 'A', transform: { position: [1, 0, 0] } },
    { id: 'entity/b', name: 'B', transform: { position: [-1, 0, 0], scale: [2, 2, 2] } },
  ]);
  const ids = ['entity/b', 'entity/a'];
  const initialHash = hashExactEntitySet(kernel.document, ids);

  const patched = await kernel.apply(request(0, 'bulk-patch-0001', [{
    type: 'entity.patchMany',
    entityIds: ids,
    patch: { visible: false, tags: ['selected'] },
    expectedEntitySetHash: initialHash,
  }]));
  assert.equal(patched.revision, 1);
  assert.deepEqual(patched.changedIds, ['entity/a', 'entity/b']);
  assert.equal(kernel.document.scenes['scene/main'].entities['entity/a'].visible, false);
  assert.deepEqual(kernel.document.scenes['scene/main'].entities['entity/b'].tags, ['selected']);

  await kernel.undo({
    label: 'Undo exact bulk patch', baseRevision: 1, idempotencyKey: 'bulk-patch-undo-0001',
  });
  assert.equal(kernel.document.scenes['scene/main'].entities['entity/a'].visible, true);

  const transformHash = hashExactEntitySet(kernel.document, ids);
  await kernel.apply(request(2, 'bulk-transform-0001', [{
    type: 'entity.transformMany',
    entityIds: ids,
    mode: 'delta',
    transform: { position: [3, 2, -1], rotation: [0, 0.5, 0], scale: [0.5, 1, 2] },
    expectedEntitySetHash: transformHash,
  }]));
  assert.deepEqual(kernel.document.scenes['scene/main'].entities['entity/a'].transform, {
    position: [4, 2, -1], rotation: [0, 0.5, 0], scale: [0.5, 1, 2],
  });
  assert.deepEqual(kernel.document.scenes['scene/main'].entities['entity/b'].transform, {
    position: [2, 2, -1], rotation: [0, 0.5, 0], scale: [1, 2, 4],
  });

  await assert.rejects(
    kernel.apply(request(3, 'bulk-stale-guard-0001', [{
      type: 'entity.patchMany', entityIds: ids, patch: { visible: false },
      expectedEntitySetHash: transformHash,
    }])),
    error => error.code === 'entity_set_conflict',
  );
  assert.equal(kernel.revision, 3);
});

test('entity.group and entity.ungroup preserve world transforms across different original parents', async () => {
  const kernel = kernelWithEntities([
    {
      id: 'entity/parent-a', kind: 'group', children: ['entity/a'],
      transform: { position: [8, 1, -2], rotation: [0, 0.25, 0], scale: [1.5, 1.5, 1.5] },
    },
    {
      id: 'entity/a', parentId: 'entity/parent-a',
      transform: { position: [2, 0, 1], rotation: [0.1, 0.2, 0.3], scale: [1, 2, 1] },
    },
    {
      id: 'entity/parent-b', kind: 'group', children: ['entity/b'],
      transform: { position: [-4, 3, 5], rotation: [0, -0.5, 0], scale: [0.75, 0.75, 0.75] },
    },
    {
      id: 'entity/b', parentId: 'entity/parent-b',
      transform: { position: [-1, 2, 0], rotation: [-0.2, 0.1, 0.4], scale: [2, 1, 1] },
    },
  ], ['entity/parent-a', 'entity/parent-b']);
  const beforeA = worldMatrix(kernel.document, 'entity/a');
  const beforeB = worldMatrix(kernel.document, 'entity/b');
  const entityIds = ['entity/b', 'entity/a'];

  await kernel.apply(request(0, 'entity-group-0001', [{
    type: 'entity.group',
    sceneId: 'scene/main',
    entityIds,
    group: {
      id: 'entity/selection-group', kind: 'group', name: 'Selection Group',
      transform: { position: [3, -1, 2], rotation: [0.1, -0.2, 0.3], scale: [2, 2, 2] },
    },
    expectedEntitySetHash: hashExactEntitySet(kernel.document, entityIds),
  }]));
  const groupedScene = kernel.document.scenes['scene/main'];
  assert.deepEqual(groupedScene.entities['entity/selection-group'].children, entityIds);
  assert.equal(groupedScene.entities['entity/a'].parentId, 'entity/selection-group');
  assertMatrixClose(worldMatrix(kernel.document, 'entity/a'), beforeA);
  assertMatrixClose(worldMatrix(kernel.document, 'entity/b'), beforeB);

  await kernel.apply(request(1, 'entity-ungroup-0001', [{
    type: 'entity.ungroup',
    entityId: 'entity/selection-group',
    expectedSubtreeHash: hashEntitySubtree(kernel.document, 'entity/selection-group'),
  }]));
  assert.equal(kernel.document.scenes['scene/main'].entities['entity/selection-group'], undefined);
  assert.equal(kernel.document.scenes['scene/main'].entities['entity/a'].parentId, null);
  assertMatrixClose(worldMatrix(kernel.document, 'entity/a'), beforeA);
  assertMatrixClose(worldMatrix(kernel.document, 'entity/b'), beforeB);
});

test('collections provide nested many-to-many organization, guarded membership, safe deletion, and history', async () => {
  const kernel = kernelWithEntities([{ id: 'entity/a' }, { id: 'entity/b' }]);
  await kernel.apply(request(0, 'collections-create-0001', [
    {
      type: 'collection.create', sceneId: 'scene/main',
      collection: { id: 'collection/environment', name: 'Environment', entityIds: ['entity/a'] },
    },
    {
      type: 'collection.create', sceneId: 'scene/main',
      collection: { id: 'collection/foliage', name: 'Foliage', parentId: 'collection/environment', entityIds: ['entity/a'] },
    },
    {
      type: 'collection.membership.patch', collectionId: 'collection/environment',
      addEntityIds: ['entity/b'], expectedMembershipHash: contentHash(['entity/a']),
    },
  ]));
  let scene = kernel.document.scenes['scene/main'];
  assert.deepEqual(scene.rootCollectionIds, ['collection/environment']);
  assert.deepEqual(scene.collections['collection/environment'].children, ['collection/foliage']);
  assert.deepEqual(scene.collections['collection/environment'].entityIds, ['entity/a', 'entity/b']);
  assert.deepEqual(scene.collections['collection/foliage'].entityIds, ['entity/a']);

  await kernel.apply(request(1, 'collections-edit-0001', [
    { type: 'collection.patch', collectionId: 'collection/foliage', patch: { name: 'Hero Foliage' } },
    { type: 'collection.reparent', collectionId: 'collection/foliage', parentId: null, index: 0 },
  ]));
  scene = kernel.document.scenes['scene/main'];
  assert.equal(scene.collections['collection/foliage'].name, 'Hero Foliage');
  assert.deepEqual(scene.rootCollectionIds, ['collection/foliage', 'collection/environment']);

  await kernel.undo({ label: 'Undo collection edit', baseRevision: 2, idempotencyKey: 'collections-edit-undo-0001' });
  scene = kernel.document.scenes['scene/main'];
  assert.equal(scene.collections['collection/foliage'].name, 'Foliage');
  assert.deepEqual(scene.rootCollectionIds, ['collection/environment']);

  await kernel.apply(request(3, 'duplicate-member-0001', [{
    type: 'entity.duplicate', entityId: 'entity/a', newId: 'entity/a-copy', deep: false,
  }]));
  scene = kernel.document.scenes['scene/main'];
  assert.equal(scene.collections['collection/environment'].entityIds.includes('entity/a-copy'), true);
  assert.equal(scene.collections['collection/foliage'].entityIds.includes('entity/a-copy'), true);

  await kernel.apply(request(4, 'delete-member-0001', [{
    type: 'entity.delete', entityId: 'entity/a-copy', recursive: false,
  }]));
  scene = kernel.document.scenes['scene/main'];
  assert.equal(scene.collections['collection/environment'].entityIds.includes('entity/a-copy'), false);

  const subtreeHash = buildProjectIndex(kernel.document).collectionSubtreeHash('collection/environment');
  await kernel.apply(request(5, 'delete-collections-0001', [{
    type: 'collection.delete', collectionId: 'collection/environment', recursive: true,
    expectedSubtreeHash: subtreeHash,
  }]));
  scene = kernel.document.scenes['scene/main'];
  assert.deepEqual(scene.collections, {});
  assert.ok(scene.entities['entity/a']);
  assert.ok(scene.entities['entity/b']);

  await kernel.undo({ label: 'Restore collections', baseRevision: 6, idempotencyKey: 'delete-collections-undo-0001' });
  scene = kernel.document.scenes['scene/main'];
  assert.ok(scene.collections['collection/environment']);
  assert.ok(scene.collections['collection/foliage']);
});
