import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BLENDER_MODIFIER_CATEGORIES,
  BLENDER_MODIFIER_EXECUTION_STATUSES,
  BLENDER_MODIFIER_INVENTORY,
  BLENDER_MODIFIER_INVENTORY_SUMMARY,
  BLENDER_MODIFIER_SOURCES,
  queryBlenderModifierInventory,
  summarizeBlenderModifierInventory,
} from '../src/blender/index.mjs';

const EXPECTED_TYPES = [
  'ARMATURE', 'ARRAY', 'BEVEL', 'BOOLEAN', 'BUILD', 'CAST', 'CLOTH', 'COLLISION',
  'CORRECTIVE_SMOOTH', 'CURVE', 'DATA_TRANSFER', 'DECIMATE', 'DISPLACE', 'DYNAMIC_PAINT',
  'EDGE_SPLIT', 'EXPLODE', 'FLUID', 'GREASE_PENCIL_ARMATURE', 'GREASE_PENCIL_ARRAY',
  'GREASE_PENCIL_BUILD', 'GREASE_PENCIL_COLOR', 'GREASE_PENCIL_DASH',
  'GREASE_PENCIL_ENVELOPE', 'GREASE_PENCIL_HOOK', 'GREASE_PENCIL_LATTICE',
  'GREASE_PENCIL_LENGTH', 'GREASE_PENCIL_MIRROR', 'GREASE_PENCIL_MULTIPLY',
  'GREASE_PENCIL_NOISE', 'GREASE_PENCIL_OFFSET', 'GREASE_PENCIL_OPACITY',
  'GREASE_PENCIL_OUTLINE', 'GREASE_PENCIL_SHRINKWRAP', 'GREASE_PENCIL_SIMPLIFY',
  'GREASE_PENCIL_SMOOTH', 'GREASE_PENCIL_SUBDIV', 'GREASE_PENCIL_TEXTURE',
  'GREASE_PENCIL_THICKNESS', 'GREASE_PENCIL_TIME', 'GREASE_PENCIL_TINT',
  'GREASE_PENCIL_VERTEX_WEIGHT_ANGLE', 'GREASE_PENCIL_VERTEX_WEIGHT_PROXIMITY', 'HOOK',
  'LAPLACIANDEFORM', 'LAPLACIANSMOOTH', 'LATTICE', 'LINEART', 'MASK', 'MESH_CACHE',
  'MESH_DEFORM', 'MESH_SEQUENCE_CACHE', 'MESH_TO_VOLUME', 'MIRROR', 'MULTIRES', 'NODES',
  'NORMAL_EDIT', 'OCEAN', 'PARTICLE_INSTANCE', 'PARTICLE_SYSTEM', 'REMESH', 'SCREW',
  'SHRINKWRAP', 'SIMPLE_DEFORM', 'SKIN', 'SMOOTH', 'SOFT_BODY', 'SOLIDIFY', 'SUBSURF',
  'SURFACE', 'SURFACE_DEFORM', 'TRIANGULATE', 'UV_PROJECT', 'UV_WARP',
  'VERTEX_WEIGHT_EDIT', 'VERTEX_WEIGHT_MIX', 'VERTEX_WEIGHT_PROXIMITY', 'VOLUME_DISPLACE',
  'VOLUME_TO_MESH', 'WARP', 'WAVE', 'WEIGHTED_NORMAL', 'WELD', 'WIREFRAME',
].sort();

test('Blender 5.2 modifier inventory pins every Object Modifier Type Items entry', () => {
  assert.equal(BLENDER_MODIFIER_INVENTORY.blenderVersion, '5.2 LTS');
  assert.equal(BLENDER_MODIFIER_INVENTORY.entries.length, 83);
  assert.deepEqual(
    BLENDER_MODIFIER_INVENTORY.entries.map((entry) => entry.operatorType).sort(),
    EXPECTED_TYPES,
  );
  assert.deepEqual(BLENDER_MODIFIER_EXECUTION_STATUSES, [
    'live-runtime', 'live-geometry', 'bake-required', 'planned', 'not-applicable',
  ]);
  assert.deepEqual(BLENDER_MODIFIER_CATEGORIES, ['modify', 'generate', 'deform', 'simulate']);
  assert.equal(
    BLENDER_MODIFIER_SOURCES.modifierTypeEnum,
    'https://docs.blender.org/api/5.2/bpy_types_enum_items/object_modifier_type_items.html',
  );

  const ids = new Set();
  const operatorTypes = new Set();
  for (const entry of BLENDER_MODIFIER_INVENTORY.entries) {
    assert.match(entry.id, /^blender\/modifier\/[a-z0-9-]+$/);
    assert.ok(!ids.has(entry.id), `duplicate ID ${entry.id}`);
    assert.ok(!operatorTypes.has(entry.operatorType), `duplicate operator type ${entry.operatorType}`);
    ids.add(entry.id);
    operatorTypes.add(entry.operatorType);
    assert.ok(BLENDER_MODIFIER_EXECUTION_STATUSES.includes(entry.status));
    assert.ok(BLENDER_MODIFIER_CATEGORIES.includes(entry.category));
    assert.equal(entry.operatorIdentifier, 'bpy.ops.object.modifier_add');
    assert.equal(entry.rnaIdentifier, `bpy.types.${entry.rnaType}`);
    assert.equal(
      entry.officialUrls[1],
      `https://docs.blender.org/api/5.2/bpy.types.${entry.rnaType}.html`,
    );
    assert.ok(entry.purpose.length > 0);
    assert.ok(entry.studioNotes.length > 0);
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.officialUrls));
    assert.equal(BLENDER_MODIFIER_INVENTORY.byType[entry.operatorType], entry);
  }
  assert.ok(Object.isFrozen(BLENDER_MODIFIER_INVENTORY));
  assert.ok(Object.isFrozen(BLENDER_MODIFIER_INVENTORY.entries));
  assert.ok(Object.isFrozen(BLENDER_MODIFIER_INVENTORY.byType));
});

test('modifier execution classifications are conservative and internally consistent', () => {
  assert.deepEqual(BLENDER_MODIFIER_INVENTORY_SUMMARY.byCategory, {
    modify: 17,
    generate: 30,
    deform: 26,
    simulate: 10,
  });
  assert.deepEqual(BLENDER_MODIFIER_INVENTORY_SUMMARY.byStatus, {
    'live-runtime': 2,
    'live-geometry': 0,
    'bake-required': 44,
    planned: 11,
    'not-applicable': 26,
  });
  assert.deepEqual(
    BLENDER_MODIFIER_INVENTORY.entries
      .filter((entry) => entry.status === 'live-runtime')
      .map((entry) => entry.operatorType)
      .sort(),
    ['ARRAY', 'MIRROR'],
  );
  assert.equal(BLENDER_MODIFIER_INVENTORY.byType.NODES.status, 'planned');
  assert.equal(BLENDER_MODIFIER_INVENTORY.byType.BEVEL.status, 'bake-required');
  assert.equal(BLENDER_MODIFIER_INVENTORY.byType.CLOTH.status, 'planned');
  assert.equal(BLENDER_MODIFIER_INVENTORY.byType.LINEART.status, 'not-applicable');
  assert.equal(summarizeBlenderModifierInventory(), BLENDER_MODIFIER_INVENTORY_SUMMARY);
  assert.ok(Object.isFrozen(BLENDER_MODIFIER_INVENTORY_SUMMARY));
  assert.ok(Object.isFrozen(BLENDER_MODIFIER_INVENTORY_SUMMARY.byCategory));
  assert.ok(Object.isFrozen(BLENDER_MODIFIER_INVENTORY_SUMMARY.byStatus));
});

test('modifier inventory query filters by category, execution status, and RNA/operator text', () => {
  const all = queryBlenderModifierInventory({ limit: 200 });
  assert.equal(all.total, 83);
  assert.equal(all.matched, 83);
  assert.equal(all.returned, 83);
  assert.deepEqual(
    all.entries.map((entry) => entry.operatorType),
    [...all.entries.map((entry) => entry.operatorType)].sort(),
  );

  const live = queryBlenderModifierInventory({ status: 'live-runtime', limit: 200 });
  assert.deepEqual(live.entries.map((entry) => entry.operatorType), ['ARRAY', 'MIRROR']);

  const simulation = queryBlenderModifierInventory({ category: 'simulate', limit: 200 });
  assert.equal(simulation.matched, 10);
  assert.ok(simulation.entries.every((entry) => entry.category === 'simulate'));

  const rnaSearch = queryBlenderModifierInventory({ search: 'bpy.types.BevelModifier' });
  assert.equal(rnaSearch.matched, 1);
  assert.equal(rnaSearch.entries[0].operatorType, 'BEVEL');

  const minimum = queryBlenderModifierInventory({ limit: 0 });
  assert.equal(minimum.returned, 1);
  assert.throws(
    () => queryBlenderModifierInventory({ status: 'implemented' }),
    /Unknown Blender modifier execution status/,
  );
  assert.throws(
    () => queryBlenderModifierInventory({ category: 'physics' }),
    /Unknown Blender modifier category/,
  );
});
