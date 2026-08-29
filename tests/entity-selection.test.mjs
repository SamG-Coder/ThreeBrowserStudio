import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectDocument } from '../src/core/documents.mjs';
import { buildProjectIndex } from '../src/core/indexes.mjs';
import {
  MAX_EXACT_ENTITY_SELECTION,
  assertExpectedEntitySetHash,
  hashExactEntitySet,
  resolveExactEntitySelection,
} from '../src/core/entity-selection.mjs';

function projectFixture() {
  return createProjectDocument({
    projectId: 'project/entity-selection',
    timestamp: '2026-08-29T00:00:00.000Z',
    scenes: [
      {
        id: 'scene/alpha',
        entities: [
          { id: 'entity/alpha-b', name: 'B', tags: ['stone'] },
          { id: 'entity/alpha-a', name: 'A', tags: ['road'] },
        ],
      },
      {
        id: 'scene/beta',
        entities: [{ id: 'entity/beta-a', name: 'Beta A' }],
      },
    ],
  });
}

test('resolves exact stable IDs while preserving requested edit order', () => {
  const project = projectFixture();
  const selection = resolveExactEntitySelection(project, ['entity/alpha-b', 'entity/alpha-a'], {
    requireSameScene: true,
    sceneId: 'scene/alpha',
  });

  assert.deepEqual(selection.entityIds, ['entity/alpha-b', 'entity/alpha-a']);
  assert.deepEqual(selection.sortedEntityIds, ['entity/alpha-a', 'entity/alpha-b']);
  assert.deepEqual(selection.sceneIds, ['scene/alpha']);
  assert.equal(selection.sceneId, 'scene/alpha');
  assert.equal(selection.entries[0].entity.name, 'B');

  const fromIndex = resolveExactEntitySelection(
    buildProjectIndex(project),
    ['entity/alpha-a'],
  );
  assert.equal(fromIndex.entitySetHash, hashExactEntitySet(project, ['entity/alpha-a']));
});

test('entity-set hashes are canonical, order-independent, and content-sensitive', () => {
  const project = projectFixture();
  const forward = hashExactEntitySet(project, ['entity/alpha-a', 'entity/alpha-b']);
  const reverse = hashExactEntitySet(project, ['entity/alpha-b', 'entity/alpha-a']);
  assert.equal(forward, reverse);
  assert.match(forward, /^[a-f0-9]{64}$/);

  const edited = structuredClone(project);
  edited.scenes['scene/alpha'].entities['entity/alpha-a'].visible = false;
  assert.notEqual(hashExactEntitySet(edited, ['entity/alpha-a', 'entity/alpha-b']), forward);
});

test('rejects duplicate, non-exact, empty, missing, and oversized selections', () => {
  const project = projectFixture();
  assert.throws(
    () => resolveExactEntitySelection(project, ['entity/alpha-a', 'entity/alpha-a']),
    error => error.code === 'duplicate_entity_selection',
  );
  assert.throws(
    () => resolveExactEntitySelection(project, ['$selected']),
    error => error.code === 'invalid_id',
  );
  assert.throws(
    () => resolveExactEntitySelection(project, []),
    error => error.code === 'empty_entity_selection',
  );
  assert.throws(
    () => resolveExactEntitySelection(project, ['entity/missing']),
    error => error.code === 'not_found',
  );

  const repeatedButUnique = Array.from(
    { length: MAX_EXACT_ENTITY_SELECTION + 1 },
    (_, index) => `entity/generated-${index}`,
  );
  assert.throws(
    () => resolveExactEntitySelection(project, repeatedButUnique),
    error => error.code === 'entity_selection_too_large'
      && error.details.maximum === MAX_EXACT_ENTITY_SELECTION,
  );
  assert.throws(
    () => resolveExactEntitySelection(project, ['entity/alpha-a'], { maxEntities: 201 }),
    error => error.code === 'invalid_selection_limit',
  );
});

test('supports explicit same-scene guards without silently filtering IDs', () => {
  const project = projectFixture();
  assert.throws(
    () => resolveExactEntitySelection(project, ['entity/alpha-a', 'entity/beta-a'], {
      requireSameScene: true,
    }),
    error => error.code === 'mixed_scene_entity_selection'
      && error.details.sceneIds.join(',') === 'scene/alpha,scene/beta',
  );
  assert.throws(
    () => resolveExactEntitySelection(project, ['entity/beta-a'], { sceneId: 'scene/alpha' }),
    error => error.code === 'entity_scene_mismatch',
  );

  const mixed = resolveExactEntitySelection(project, ['entity/alpha-a', 'entity/beta-a']);
  assert.equal(mixed.sceneId, null);
  assert.deepEqual(mixed.sceneIds, ['scene/alpha', 'scene/beta']);
});

test('expected hash guard distinguishes malformed hashes from stale selections', () => {
  const project = projectFixture();
  const actual = hashExactEntitySet(project, ['entity/alpha-a']);
  assert.equal(assertExpectedEntitySetHash(actual, actual), actual);
  assert.throws(
    () => assertExpectedEntitySetHash(actual, 'not-a-hash'),
    error => error.code === 'invalid_entity_set_hash',
  );
  assert.throws(
    () => assertExpectedEntitySetHash(actual, '0'.repeat(64)),
    error => error.code === 'entity_set_conflict'
      && error.details.actualEntitySetHash === actual,
  );
});
