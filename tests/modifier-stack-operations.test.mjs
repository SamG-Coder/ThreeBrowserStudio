import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AuthoringKernel,
  buildModifierDigest,
  createProjectDocument,
  hashExactEntitySet,
  modifierStackHash,
} from '../src/core/index.mjs';

function fixture() {
  return new AuthoringKernel(createProjectDocument({
    projectId: 'project/modifier-stack',
    timestamp: '2026-08-29T00:00:00.000Z',
    resources: {
      geometries: [{ id: 'geometry/wall', kind: 'box', size: [2, 2, 0.2] }],
      materials: [{ id: 'material/stone', kind: 'standard', color: '#777777' }],
    },
    scenes: [{
      id: 'scene/main',
      entities: [{
        id: 'entity/wall',
        kind: 'mesh',
        components: { mesh: { geometryId: 'geometry/wall', materialIds: ['material/stone'] } },
      }],
    }],
  }));
}

function legacyFixture() {
  return new AuthoringKernel(createProjectDocument({
    projectId: 'project/modifier-stack',
    timestamp: '2026-08-29T00:00:00.000Z',
    resources: {
      geometries: [{ id: 'geometry/wall', kind: 'box', size: [2, 2, 0.2] }],
      materials: [{ id: 'material/stone', kind: 'standard', color: '#777777' }],
    },
    scenes: [{
      id: 'scene/main',
      entities: [
        {
          id: 'entity/legacy', kind: 'mesh',
          components: {
            mesh: { geometryId: 'geometry/wall', materialIds: ['material/stone'] },
            modifiers: [{ id: 'modifier/legacy-bevel', type: 'bevel', width: 0.12, segments: 3 }],
          },
        },
        {
          id: 'entity/clean', kind: 'mesh',
          components: { mesh: { geometryId: 'geometry/wall', materialIds: ['material/stone'] } },
        },
      ],
    }],
  }));
}

function request(baseRevision, idempotencyKey, operations) {
  return {
    protocolVersion: 'three-studio/1',
    projectId: 'project/modifier-stack',
    baseRevision,
    idempotencyKey,
    label: idempotencyKey,
    operations,
  };
}

function wall(kernel) {
  return kernel.document.scenes['scene/main'].entities['entity/wall'];
}

test('modifier.stack.edit applies ordered create, move, and patch changes in one guarded revision', async () => {
  const kernel = fixture();
  const emptyHash = modifierStackHash(wall(kernel));
  const applied = await kernel.apply(request(0, 'modifier-stack-edit-0001', [{
    type: 'modifier.stack.edit',
    entityId: 'entity/wall',
    expectedStackHash: emptyHash,
    changes: [
      {
        type: 'create',
        modifier: { id: 'modifier/subdivision', type: 'subdivision', levels: 2, scheme: 'loop' },
      },
      {
        type: 'create',
        modifier: {
          id: 'modifier/bevel-bake', type: 'bakeBoundary', operatorType: 'BEVEL',
          parameters: { width: 0.04, segments: 3 },
        },
      },
      { type: 'move', modifierId: 'modifier/bevel-bake', index: 0 },
      { type: 'patch', modifierId: 'modifier/subdivision', patch: { levels: 3 } },
    ],
  }]));

  assert.equal(applied.revision, 1);
  assert.deepEqual(applied.changedIds, ['entity/wall']);
  assert.deepEqual(wall(kernel).components.modifiers.map(modifier => modifier.id), [
    'modifier/bevel-bake', 'modifier/subdivision',
  ]);
  assert.equal(wall(kernel).components.modifiers[1].levels, 3);
  const digest = buildModifierDigest(wall(kernel));
  assert.deepEqual(digest.modifiers.map(modifier => modifier.execution), ['bake-required', 'live-geometry']);
  assert.match(digest.stackHash, /^[a-f0-9]{64}$/u);

  await kernel.undo({
    label: 'Undo modifier stack edit', baseRevision: 1, idempotencyKey: 'modifier-stack-undo-0001',
  });
  assert.deepEqual(wall(kernel).components.modifiers ?? [], []);
});

test('modifier stack batches reject stale hashes and roll back every earlier change on failure', async () => {
  const kernel = fixture();
  const initialHash = modifierStackHash(wall(kernel));
  await assert.rejects(kernel.apply(request(0, 'modifier-stack-bad-0001', [{
    type: 'modifier.stack.edit',
    entityId: 'entity/wall',
    expectedStackHash: initialHash,
    changes: [
      { type: 'create', modifier: { id: 'modifier/smooth', type: 'smooth', iterations: 2 } },
      { type: 'delete', modifierId: 'modifier/missing' },
    ],
  }])), error => error.code === 'not_found');
  assert.equal(kernel.revision, 0);
  assert.deepEqual(wall(kernel).components.modifiers ?? [], []);

  await assert.rejects(kernel.apply(request(0, 'modifier-stack-stale-0001', [{
    type: 'modifier.create',
    entityId: 'entity/wall',
    expectedStackHash: '0'.repeat(64),
    modifier: { id: 'modifier/smooth', type: 'smooth' },
  }])), error => error.code === 'modifier_stack_conflict');
  assert.equal(kernel.revision, 0);
});

test('individual modifier operations share exact index, patch, move, and delete semantics', async () => {
  const kernel = fixture();
  const applyOne = (revision, key, operation) => kernel.apply(request(revision, key, [operation]));
  const target = operation => ({
    entityId: 'entity/wall',
    expectedStackHash: modifierStackHash(wall(kernel)),
    ...operation,
  });

  await assert.rejects(applyOne(0, 'modifier-create-index-bad-0001', target({
    type: 'modifier.create', index: 1,
    modifier: { id: 'modifier/smooth', type: 'smooth', factor: 0.25 },
  })), error => error.code === 'invalid_modifier_index');
  await applyOne(0, 'modifier-create-good-0001', target({
    type: 'modifier.create', index: 0,
    modifier: { id: 'modifier/smooth', type: 'smooth', factor: 0.25 },
  }));

  await assert.rejects(applyOne(1, 'modifier-patch-bad-0001', target({
    type: 'modifier.patch', modifierId: 'modifier/smooth', patch: { fctor: 0.5 },
  })), error => error.code === 'unknown_modifier_property');
  await applyOne(1, 'modifier-patch-good-0001', target({
    type: 'modifier.patch', modifierId: 'modifier/smooth', patch: { factor: 0.5 },
  }));
  assert.equal(wall(kernel).components.modifiers[0].factor, 0.5);

  await applyOne(2, 'modifier-create-second-0001', target({
    type: 'modifier.create', index: 1,
    modifier: { id: 'modifier/weld', type: 'weld', tolerance: 0.001 },
  }));
  await assert.rejects(applyOne(3, 'modifier-move-bad-0001', target({
    type: 'modifier.move', modifierId: 'modifier/weld', index: 2,
  })), error => error.code === 'invalid_modifier_index');
  await applyOne(3, 'modifier-move-good-0001', target({
    type: 'modifier.move', modifierId: 'modifier/weld', index: 0,
  }));
  assert.deepEqual(wall(kernel).components.modifiers.map(item => item.id), [
    'modifier/weld', 'modifier/smooth',
  ]);

  await assert.rejects(applyOne(4, 'modifier-delete-bad-0001', target({
    type: 'modifier.delete', modifierId: 'modifier/missing',
  })), error => error.code === 'not_found');
  await applyOne(4, 'modifier-delete-good-0001', target({
    type: 'modifier.delete', modifierId: 'modifier/smooth',
  }));
  assert.deepEqual(wall(kernel).components.modifiers.map(item => item.id), ['modifier/weld']);
});

test('guarded modifier operations create and patch the live Ocean displacement subset', async () => {
  const kernel = fixture();
  await kernel.apply(request(0, 'ocean-create-0001', [{
    type: 'modifier.create',
    entityId: 'entity/wall',
    expectedStackHash: modifierStackHash(wall(kernel)),
    modifier: {
      id: 'modifier/ocean', type: 'ocean', mode: 'displace',
      seed: 12, waveScale: 0.8, waveCount: 16, timelineScale: 1,
    },
  }]));
  assert.equal(buildModifierDigest(wall(kernel)).modifiers[0].blender.operatorType, 'OCEAN');

  await kernel.apply(request(1, 'ocean-patch-0001', [{
    type: 'modifier.patch',
    entityId: 'entity/wall',
    modifierId: 'modifier/ocean',
    expectedStackHash: modifierStackHash(wall(kernel)),
    patch: { waveScale: 1.4, windVelocity: 35, timelineScale: 0.5 },
  }]));
  assert.deepEqual(wall(kernel).components.modifiers[0], {
    id: 'modifier/ocean', type: 'ocean', mode: 'displace',
    seed: 12, waveScale: 1.4, waveCount: 16, timelineScale: 0.5, windVelocity: 35,
  });

  await assert.rejects(kernel.apply(request(2, 'ocean-patch-invalid-0001', [{
    type: 'modifier.patch',
    entityId: 'entity/wall',
    modifierId: 'modifier/ocean',
    expectedStackHash: modifierStackHash(wall(kernel)),
    patch: { waveScaleMin: 80, spatialSize: 40 },
  }])), error => error.code === 'invalid_geometry_modifier');
  assert.equal(kernel.revision, 2);
});

test('generic scene and entity operations cannot author legacy-unknown modifier types', async () => {
  const kernel = legacyFixture();
  const legacyModifiers = [{ id: 'modifier/new-bevel', type: 'bevel', width: 0.1 }];
  const rejectsUnknown = (promise) => assert.rejects(
    promise,
    error => error.code === 'unsupported_modifier_type',
  );

  await rejectsUnknown(kernel.apply(request(0, 'legacy-scene-create-0001', [{
    type: 'scene.create',
    scene: {
      id: 'scene/unknown-modifier',
      entities: [{ id: 'entity/new-in-scene', components: { modifiers: legacyModifiers } }],
    },
  }])));
  await rejectsUnknown(kernel.apply(request(0, 'legacy-entity-create-0001', [{
    type: 'entity.create', sceneId: 'scene/main',
    entity: { id: 'entity/new', components: { modifiers: legacyModifiers } },
  }])));
  await rejectsUnknown(kernel.apply(request(0, 'legacy-entity-patch-0001', [{
    type: 'entity.patch', entityId: 'entity/clean',
    patch: { components: { modifiers: legacyModifiers } },
  }])));
  await rejectsUnknown(kernel.apply(request(0, 'legacy-entity-patch-many-0001', [{
    type: 'entity.patchMany', entityIds: ['entity/clean', 'entity/legacy'],
    expectedEntitySetHash: hashExactEntitySet(kernel.document, ['entity/clean', 'entity/legacy']),
    patch: { components: { modifiers: legacyModifiers } },
  }])));
  await rejectsUnknown(kernel.apply(request(0, 'legacy-entity-group-0001', [{
    type: 'entity.group', sceneId: 'scene/main', entityIds: ['entity/clean'],
    expectedEntitySetHash: hashExactEntitySet(kernel.document, ['entity/clean']),
    group: { id: 'entity/new-group', kind: 'group', components: { modifiers: legacyModifiers } },
  }])));
  assert.equal(kernel.revision, 0);
});

test('unrelated edits and duplication remain available for already-loaded legacy modifier entities', async () => {
  const kernel = legacyFixture();
  const edited = await kernel.apply(request(0, 'legacy-unrelated-patch-0001', [{
    type: 'entity.patch', entityId: 'entity/legacy', patch: { visible: false },
  }]));
  assert.equal(edited.revision, 1);
  assert.equal(kernel.document.scenes['scene/main'].entities['entity/legacy'].visible, false);

  const duplicated = await kernel.apply(request(1, 'legacy-duplicate-0001', [{
    type: 'entity.duplicate', entityId: 'entity/legacy', newId: 'entity/legacy-copy',
  }]));
  assert.equal(duplicated.revision, 2);
  const copy = kernel.document.scenes['scene/main'].entities['entity/legacy-copy'];
  assert.equal(buildModifierDigest(copy).modifiers[0].legacyUnknown, true);
  assert.equal(copy.components.modifiers[0].type, 'bevel');
});
