import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeViewportModifierStack,
  assertExpectedModifierStackHash,
  buildModifierDigest,
  modifierStackHash,
  normalizeModifierDocument,
  normalizedModifierStack,
} from '../src/core/modifier-stack.mjs';
import { createProjectDocument, validateProjectDocument } from '../src/core/index.mjs';

const entity = {
  id: 'entity/wall',
  components: {
    modifiers: [
      {
        id: 'modifier/bevel', type: 'bakeBoundary', operatorType: 'BEVEL',
        parameters: { width: 0.04, segments: 3 },
      },
      { id: 'modifier/array', type: 'array', count: 5, offset: [2, 0, 0], enabledRender: false },
    ],
  },
};

test('modifier stack hashes and digests preserve exact ordered authored controls', () => {
  const hash = modifierStackHash(entity);
  const digest = buildModifierDigest(entity);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(digest.stackHash, hash);
  assert.deepEqual(digest.modifiers.map(item => [item.index, item.id, item.execution]), [
    [0, 'modifier/bevel', 'bake-required'],
    [1, 'modifier/array', 'live-runtime'],
  ]);
  assert.deepEqual(digest.modifiers[0].parameters, {
    operatorType: 'BEVEL', parameters: { width: 0.04, segments: 3 },
  });
  assert.equal(digest.modifiers[0].blender.compatibilityStatus, 'bake-required');
  assert.equal(digest.modifiers[1].authoredFlags.render, false);
  assert.equal(assertExpectedModifierStackHash(entity, hash), hash);
});

test('modifier stack validation rejects malformed IDs, types, flags, duplicates, and stale guards', () => {
  assert.throws(() => normalizeModifierDocument({ id: '$bad', type: 'smooth' }), error => error.code === 'invalid_id');
  assert.throws(() => normalizeModifierDocument({ id: 'modifier/a' }), error => error.code === 'invalid_modifier_type');
  assert.throws(() => normalizeModifierDocument({ id: 'modifier/a', type: 'subdivison' }), error => error.code === 'unsupported_modifier_type');
  assert.throws(() => normalizeModifierDocument({ id: 'modifier/a', type: 'smooth', enabled: 1 }), error => error.code === 'invalid_modifier_enabled');
  assert.throws(() => normalizeModifierDocument({
    id: 'modifier/a', type: 'bakeBoundary', operatorType: 'BEVELL', parameters: {},
  }), error => error.code === 'unknown_blender_modifier_type');
  assert.throws(() => normalizeModifierDocument({
    id: 'modifier/a', type: 'subdivision', levels: 2, levles: 3,
  }), error => error.code === 'unknown_modifier_property');
  assert.throws(() => normalizedModifierStack({ components: { modifiers: [
    { id: 'modifier/a', type: 'smooth' }, { id: 'modifier/a', type: 'smooth' },
  ] } }), error => error.code === 'duplicate_modifier_id');
  assert.throws(() => assertExpectedModifierStackHash(entity, '0'.repeat(64)), error => error.code === 'modifier_stack_conflict');
  assert.throws(() => assertExpectedModifierStackHash(entity, 'bad'), error => error.code === 'invalid_modifier_stack_hash');
});

test('ocean modifier normalization exposes only the strict live displacement subset', () => {
  const ocean = normalizeModifierDocument({
    id: 'modifier/ocean',
    type: 'ocean',
    mode: 'displace',
    seed: 7,
    timelineScale: 0.5,
    spatialSize: 60,
    waveScaleMin: 0.2,
    waveScale: 1.5,
    waveCount: 24,
  });
  assert.equal(ocean.type, 'ocean');
  const digest = buildModifierDigest({ id: 'entity/ocean', components: { modifiers: [ocean] } });
  assert.equal(digest.modifiers[0].execution, 'live-geometry');
  assert.equal(digest.modifiers[0].blender.operatorType, 'OCEAN');
  assert.equal(digest.modifiers[0].blender.compatibilityStatus, 'live-geometry');

  assert.throws(
    () => normalizeModifierDocument({ id: 'modifier/generate', type: 'ocean', mode: 'generate' }),
    error => error.code === 'invalid_geometry_modifier',
  );
  assert.throws(
    () => normalizeModifierDocument({
      id: 'modifier/foam', type: 'ocean', mode: 'displace', useFoam: true,
    }),
    error => error.code === 'unknown_modifier_property',
  );
  assert.throws(
    () => normalizeModifierDocument({
      id: 'modifier/range', type: 'ocean', mode: 'displace', spatialSize: 1, waveScaleMin: 2,
    }),
    error => error.code === 'invalid_geometry_modifier',
  );
});

test('legacy unknown modifier documents remain inspectable as explicit bake boundaries', () => {
  const legacy = {
    id: 'entity/legacy',
    components: {
      modifiers: [{ id: 'modifier/legacy-bevel', type: 'bevel', width: 0.12, segments: 3 }],
    },
  };
  assert.throws(
    () => normalizeModifierDocument(legacy.components.modifiers[0]),
    error => error.code === 'unsupported_modifier_type',
  );
  assert.deepEqual(normalizedModifierStack(legacy), legacy.components.modifiers);
  const digest = buildModifierDigest(legacy);
  assert.equal(digest.modifiers[0].execution, 'bake-required');
  assert.equal(digest.modifiers[0].legacyUnknown, true);
  assert.equal(digest.modifiers[0].blender, undefined);

  const project = createProjectDocument({
    projectId: 'project/legacy-modifiers',
    scenes: [{ id: 'scene/main', entities: [legacy] }],
  });
  assert.equal(project.formatVersion, 1);
  assert.equal(validateProjectDocument(project).valid, true);
  const loaded = project.scenes['scene/main'].entities['entity/legacy'];
  assert.equal(buildModifierDigest(loaded).modifiers[0].legacyUnknown, true);
});

test('viewport stack analysis exposes exact source and ordering boundaries', () => {
  const ordered = analyzeViewportModifierStack({
    id: 'entity/ordered',
    components: { modifiers: [
      { id: 'modifier/array', type: 'array', count: 2 },
      { id: 'modifier/subdivision', type: 'subdivision', levels: 1 },
      { id: 'modifier/after', type: 'smooth', factor: 0.25 },
    ] },
  }, { sourceKind: 'indexedMesh' });
  assert.equal(ordered.status, 'partial-preview');
  assert.equal(ordered.blocked.reasonCode, 'runtime_modifier_order_unsupported');
  assert.deepEqual(ordered.entries.map(entry => [entry.status, entry.reasonCode ?? null]), [
    ['live', null],
    ['blocked', 'runtime_modifier_order_unsupported'],
    ['blocked', 'runtime_modifier_after_boundary'],
  ]);
  assert.deepEqual(ordered.previewModifiers.map(modifier => modifier.id), ['modifier/array']);

  const editableLive = analyzeViewportModifierStack({
    id: 'entity/editable',
    components: { modifiers: [{ id: 'modifier/smooth', type: 'smooth' }] },
  }, { sourceKind: 'editableMesh' });
  assert.equal(editableLive.status, 'live');
  assert.equal(editableLive.blocked, null);
  assert.deepEqual(editableLive.geometryModifiers.map(modifier => modifier.id), ['modifier/smooth']);

  const editableBlocked = analyzeViewportModifierStack({
    id: 'entity/editable-weld',
    components: { modifiers: [{ id: 'modifier/weld', type: 'weld' }] },
  }, { sourceKind: 'editableMesh' });
  assert.equal(editableBlocked.blocked.reasonCode, 'runtime_editable_modifier_bake_required');
  assert.deepEqual(editableBlocked.geometryModifiers, []);

  const editableOcean = analyzeViewportModifierStack({
    id: 'entity/editable-ocean',
    components: { modifiers: [{ id: 'modifier/ocean', type: 'ocean', mode: 'displace' }] },
  }, { sourceKind: 'editableMesh' });
  assert.equal(editableOcean.status, 'live');
  assert.deepEqual(editableOcean.geometryModifiers.map(modifier => modifier.id), ['modifier/ocean']);

  const dynamicOrder = analyzeViewportModifierStack({
    id: 'entity/ocean-then-smooth',
    components: { modifiers: [
      { id: 'modifier/ocean', type: 'ocean', mode: 'displace' },
      { id: 'modifier/smooth', type: 'smooth' },
    ] },
  }, { sourceKind: 'indexedMesh' });
  assert.equal(dynamicOrder.status, 'partial-preview');
  assert.equal(dynamicOrder.blocked.reasonCode, 'runtime_dynamic_modifier_order_unsupported');
  assert.deepEqual(dynamicOrder.geometryModifiers.map(modifier => modifier.id), ['modifier/ocean']);
});
