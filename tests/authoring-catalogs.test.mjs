import assert from 'node:assert/strict';
import test from 'node:test';

import { OPERATION_CATALOG, queryOperationCatalog } from '../src/mcp/operation-catalog.mjs';
import {
  GEOMETRY_RECIPE_KINDS,
  queryGeometryCatalog,
} from '../src/runtime/resource-factories.mjs';
import { queryLookCatalog } from '../src/runtime/material-looks.mjs';

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
  const look = queryOperationCatalog({ search: 'material.look' });
  assert.deepEqual(look.entries.map(entry => entry.operation), [
    'material.look.create',
    'material.look.patch',
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

test('look catalog exposes default recipes and raster notes', () => {
  const glass = queryLookCatalog({ look: 'glass' });
  assert.equal(glass.returned, 1);
  assert.equal(glass.entries[0].recipe.transmission, 1);
  assert.match(glass.entries[0].rasterNotes, /transmission 0/);

  const lens = queryLookCatalog({ search: 'emissive' });
  assert.equal(lens.entries[0].look, 'emissiveLens');
  assert.equal(lens.entries[0].recipe.emissive, '#ff3b08');
  assert.ok(lens.entries[0].overrideKeys.includes('emissiveIntensity'));
});
