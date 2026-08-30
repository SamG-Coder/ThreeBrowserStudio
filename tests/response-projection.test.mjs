import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeToolResponse } from '../src/core/response-projection.mjs';

const response = {
  success: true,
  revision: 7,
  projectId: 'project/test',
  scene: { id: 'scene/main', name: 'Main', entityCount: 2 },
  entities: [
    { id: 'entity/a', name: 'A', transform: { position: [1, 2, 3], rotation: [0, 0, 0] }, components: { mesh: { geometryId: 'geometry/a' } } },
    { id: 'entity/b', name: 'B', transform: { position: [4, 5, 6], rotation: [0, 0, 0] }, components: { light: { intensity: 3 } } },
  ],
  nextCursor: '2',
};

test('field projections preserve arrays and return only selected nested fields', () => {
  const result = shapeToolResponse(response, { select: ['scene.id', 'entities.id', 'entities.transform.position'] });
  assert.deepEqual(result.scene, { id: 'scene/main' });
  assert.deepEqual(result.entities, [
    { id: 'entity/a', transform: { position: [1, 2, 3] } },
    { id: 'entity/b', transform: { position: [4, 5, 6] } },
  ]);
  assert.equal(result.entities[0].name, undefined);
  assert.equal(result.responseMeta.selectedFields, 3);
  assert.equal(result.responseMeta.estimatedBytes > 0, true);
});

test('row format returns page metadata and conditional hashes avoid repeated payloads', () => {
  const first = shapeToolResponse(response, { select: ['entities.id', 'entities.name'], format: 'rows' });
  assert.equal(first.rowPath, 'entities');
  assert.deepEqual(first.rows, [{ id: 'entity/a', name: 'A' }, { id: 'entity/b', name: 'B' }]);
  assert.deepEqual(first.pageInfo, { returned: 2, nextCursor: '2', truncated: true });
  const unchanged = shapeToolResponse(response, {
    select: ['entities.id', 'entities.name'], format: 'rows', ifHash: first.responseMeta.responseHash,
  });
  assert.equal(unchanged.notModified, true);
  assert.equal(unchanged.rows, undefined);
});

test('projection paths are allowlisted against the actual response and sensitive bulk fields are denied', () => {
  assert.throws(() => shapeToolResponse(response, { select: ['entities.missing'] }), /unavailable/);
  assert.throws(() => shapeToolResponse({ ...response, token: 'secret' }, { select: ['token'] }), /not selectable/);
  assert.throws(() => shapeToolResponse({ ...response, pixels: [1, 2] }, { select: ['pixels'] }), /not selectable/);
});
