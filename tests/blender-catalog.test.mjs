import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BLENDER_CATALOG,
  BLENDER_CATALOG_SUMMARY,
  BLENDER_COMPATIBILITY_STATUSES,
  queryBlenderCatalog,
  summarizeBlenderCatalog,
} from '../src/blender/index.mjs';

const REQUIRED_DOMAINS = [
  'dataBlocks', 'scenes', 'collections', 'viewLayers', 'objects', 'objectData',
  'transforms', 'meshEditing', 'modifiers', 'constraints', 'materials',
  'shaderNodes', 'textures', 'lights', 'cameras', 'world', 'actions',
  'keyframes', 'drivers', 'nla', 'geometryNodes', 'compositor', 'rendering',
  'assets', 'linkAppend', 'scripting', 'operators', 'physics', 'persistence',
];

test('Blender catalog covers the core authoring domains with immutable, official references', () => {
  assert.equal(BLENDER_CATALOG.version, 1);
  assert.deepEqual(BLENDER_CATALOG.statuses, [
    'implemented', 'partial', 'planned', 'bake-required', 'not-applicable',
  ]);
  for (const domain of REQUIRED_DOMAINS) {
    const entry = BLENDER_CATALOG.entries[domain];
    assert.ok(entry, `missing Blender catalog domain ${domain}`);
    assert.equal(entry.domain, domain);
    assert.match(entry.id, /^blender\//);
    assert.ok(BLENDER_COMPATIBILITY_STATUSES.includes(entry.status));
    assert.equal(typeof entry.canonicalRepresentation, 'string');
    assert.ok(entry.canonicalRepresentation.length > 0);
    assert.ok(Array.isArray(entry.mcpWorkflow) && entry.mcpWorkflow.length > 0);
    assert.equal(typeof entry.runtimeNotes, 'string');
    assert.ok(Array.isArray(entry.supportedSubset));
    assert.ok(Array.isArray(entry.unsupportedSubset));
    assert.ok(entry.officialUrls.length > 0);
    for (const url of entry.officialUrls) assert.equal(new URL(url).hostname, 'docs.blender.org');
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.supportedSubset));
  }
  assert.ok(BLENDER_CATALOG_SUMMARY.total >= REQUIRED_DOMAINS.length);
  assert.ok(Object.isFrozen(BLENDER_CATALOG));
  assert.ok(Object.isFrozen(BLENDER_CATALOG.entries));
});

test('Blender catalog queries filter, search, sort, and enforce result bounds', () => {
  const geometry = queryBlenderCatalog({ search: 'baked', limit: 2 });
  assert.equal(geometry.returned, 2);
  assert.ok(geometry.matched > geometry.returned);
  assert.deepEqual(
    geometry.entries.map((entry) => entry.domain),
    [...geometry.entries.map((entry) => entry.domain)].sort(),
  );

  const shader = queryBlenderCatalog({ domain: 'shaderNodes' });
  assert.equal(shader.matched, 1);
  assert.equal(shader.entries[0].id, 'blender/shader-nodes');
  assert.equal(shader.entries[0].status, 'partial');

  const planned = queryBlenderCatalog({ status: 'planned', limit: 999 });
  assert.ok(planned.returned > 0);
  assert.ok(planned.returned <= 64);
  assert.ok(planned.entries.every((entry) => entry.status === 'planned'));

  const minimum = queryBlenderCatalog({ limit: 0 });
  assert.equal(minimum.returned, 1);
  assert.throws(() => queryBlenderCatalog({ status: 'unknown' }), /Unknown Blender compatibility status/);
});

test('Blender modifiers domain exposes the pinned modifier inventory through inspect catalog queries', () => {
  const all = queryBlenderCatalog({ domain: 'modifiers', limit: 200 });
  assert.equal(all.matched, 1);
  assert.equal(all.entries[0].id, 'blender/modifiers');
  assert.equal(all.modifierInventorySummary.total, 83);
  assert.equal(all.modifierInventory.returned, 83);

  const bevel = queryBlenderCatalog({ domain: 'modifiers', search: 'BevelModifier' });
  assert.equal(bevel.matched, 1);
  assert.equal(bevel.modifierInventory.matched, 1);
  assert.equal(bevel.modifierInventory.entries[0].operatorType, 'BEVEL');

  const live = queryBlenderCatalog({ domain: 'modifiers', status: 'live-runtime' });
  assert.deepEqual(
    live.modifierInventory.entries.map((entry) => entry.operatorType),
    ['ARRAY', 'MIRROR'],
  );
});

test('Blender catalog summary is complete, stable, and internally consistent', () => {
  assert.equal(summarizeBlenderCatalog(), BLENDER_CATALOG_SUMMARY);
  assert.equal(
    Object.values(BLENDER_CATALOG_SUMMARY.byStatus).reduce((sum, count) => sum + count, 0),
    BLENDER_CATALOG_SUMMARY.total,
  );
  assert.deepEqual(
    BLENDER_CATALOG_SUMMARY.domains,
    Object.keys(BLENDER_CATALOG.entries).sort(),
  );
  assert.ok(BLENDER_CATALOG_SUMMARY.byStatus.implemented >= 1);
  assert.ok(BLENDER_CATALOG_SUMMARY.byStatus['not-applicable'] >= 1);
  assert.ok(Object.isFrozen(BLENDER_CATALOG_SUMMARY));
  assert.ok(Object.isFrozen(BLENDER_CATALOG_SUMMARY.byStatus));
});

test('physics catalog claims only the bounded live Ocean and controller rigid-body subsets', () => {
  const physics = BLENDER_CATALOG.entries.physics;
  assert.equal(physics.status, 'partial');
  assert.ok(physics.supportedSubset.includes('bounded deterministic seeded Ocean displacement over existing local-XY geometry'));
  assert.ok(physics.supportedSubset.some(item => item.includes('dynamic, kinematic, and static rigid-body')));
  assert.ok(physics.supportedSubset.some(item => item.includes('box and sphere colliders')));
  assert.match(physics.runtimeNotes, /bounded deterministic box\/sphere rigid-body world/);
  assert.ok(physics.unsupportedSubset.includes('continuous collision detection'));
  assert.ok(physics.unsupportedSubset.includes('particles'));
  assert.ok(physics.unsupportedSubset.includes('simulation cache and bake'));
});
