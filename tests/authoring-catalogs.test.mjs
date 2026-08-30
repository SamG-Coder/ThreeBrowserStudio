import assert from 'node:assert/strict';
import test from 'node:test';

import { OPERATION_CATALOG, queryOperationCatalog } from '../src/mcp/operation-catalog.mjs';
import {
  GEOMETRY_RECIPE_KINDS,
  queryGeometryCatalog,
} from '../src/runtime/resource-factories.mjs';

test('operation catalog provides bounded family and text discovery', () => {
  const entity = queryOperationCatalog({ family: 'entity', limit: 3 });
  assert.equal(entity.returned, 3);
  assert.ok(entity.matched > entity.returned);
  assert.ok(entity.entries.every(entry => entry.family === 'entity'));

  const duplicate = queryOperationCatalog({ search: 'duplicate' });
  assert.deepEqual(duplicate.entries.map(entry => entry.operation), [
    'entity.duplicate',
    'entity.duplicateMany',
  ]);
  assert.equal(OPERATION_CATALOG.length, duplicate.total);
});

test('geometry catalog describes recipes, editability, defaults, and limits', () => {
  const loft = queryGeometryCatalog({ search: 'loft' });
  assert.equal(loft.returned, 1);
  assert.equal(loft.entries[0].kind, 'loft');
  assert.ok(loft.entries[0].controlLimits.totalPoints >= 65_536);
  assert.ok(loft.entries[0].fields.includes('sections'));

  const authored = queryGeometryCatalog({ kind: 'authored-data' });
  assert.deepEqual(authored.entries.map(entry => entry.kind), ['explicit', 'indexedMesh', 'editableMesh']);
  assert.equal(authored.entries.find(entry => entry.kind === 'editableMesh').editable, true);
  assert.equal(GEOMETRY_RECIPE_KINDS.length, authored.total);
});
