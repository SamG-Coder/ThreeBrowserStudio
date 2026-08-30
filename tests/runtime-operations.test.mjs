import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectDocument } from '../src/core/index.mjs';
import { translateToolOperation } from '../src/runtime/studio-application.mjs';

test('runtime forwards strict core-shaped MCP operations without weakening them', () => {
  const project = createProjectDocument({ projectId: 'project/test' });
  const operation = {
    op: 'entity.create',
    sceneId: 'scene/main',
    entity: { id: 'entity/hero', kind: 'empty' },
  };
  const translated = translateToolOperation(operation, project);
  assert.deepEqual(translated, operation);
  assert.notEqual(translated, operation);
});

test('runtime lowers bounded create and linked-duplicate batches into one atomic core transaction', () => {
  const project = createProjectDocument({ projectId: 'project/test' });
  assert.deepEqual(translateToolOperation({
    op: 'entity.createMany', sceneId: 'scene/main', items: [
      { entity: { id: 'entity/a', kind: 'empty' }, alias: '$a' },
      { entity: { id: 'entity/b', kind: 'empty' }, index: 2 },
    ],
  }, project), [
    { type: 'entity.create', sceneId: 'scene/main', entity: { id: 'entity/a', kind: 'empty' }, alias: '$a' },
    { type: 'entity.create', sceneId: 'scene/main', entity: { id: 'entity/b', kind: 'empty' }, index: 2 },
  ]);
  assert.deepEqual(translateToolOperation({
    op: 'entity.duplicateMany', entityId: 'entity/source', items: [
      { newId: 'entity/copy-a', name: 'Copy A' },
      { newId: 'entity/copy-b', parentId: null, transform: { position: [2, 0, 0] } },
    ],
  }, project), [
    { type: 'entity.duplicate', entityId: 'entity/source', newId: 'entity/copy-a', deep: false, name: 'Copy A' },
    { type: 'entity.duplicate', entityId: 'entity/source', newId: 'entity/copy-b', deep: false, parentId: null },
    { type: 'entity.patch', entityId: 'entity/copy-b', patch: { transform: { position: [2, 0, 0] } } },
  ]);
});

test('runtime preserves resource.createMany as one normalized core batch', () => {
  const project = createProjectDocument({ projectId: 'project/resource-batch-lowering' });
  const operation = translateToolOperation({
    op: 'resource.createMany',
    items: [
      { resourceType: 'geometry', resource: { id: 'geometry/a', recipe: { kind: 'box' } }, alias: '$a' },
      { resourceType: 'material', resource: { id: 'material/a', recipe: { kind: 'physical', color: '#ff0000' } } },
    ],
  }, project);
  assert.equal(operation.type, 'resource.createMany');
  assert.deepEqual(operation.items.map(item => item.resourceType), ['geometries', 'materials']);
  assert.equal(operation.items[0].alias, '$a');
});

test('runtime forwards layout.pattern as a direct canonical core operation', () => {
  const project = createProjectDocument({ projectId: 'project/test' });
  const operation = {
    op: 'layout.pattern',
    entityId: 'entity/source',
    pattern: {
      id: 'modifier/radial',
      mode: 'radial',
      count: 8,
      axis: 'y',
      center: [0, 0, 0],
      radius: 4,
      startAngle: 0,
      arc: Math.PI * 2,
      closed: true,
      orientation: 'radial',
    },
  };
  const translated = translateToolOperation(operation, project);
  assert.deepEqual(translated, operation);
  assert.notEqual(translated, operation);
});

test('runtime forwards geometry.edit with its ordered typed commands unchanged', () => {
  const project = createProjectDocument({ projectId: 'project/test' });
  const operation = {
    op: 'geometry.edit',
    resourceId: 'geometry/editable',
    edits: [
      { type: 'move', vertexIndices: [0, 2], offset: [1, 0, 0] },
      { type: 'recalculateNormals' },
    ],
  };
  const translated = translateToolOperation(operation, project);
  assert.deepEqual(translated, operation);
  assert.notEqual(translated, operation);
  assert.notEqual(translated.edits, operation.edits);
});

test('runtime forwards guarded modifier stack batches unchanged', () => {
  const project = createProjectDocument({ projectId: 'project/test' });
  const operation = {
    op: 'modifier.stack.edit',
    entityId: 'entity/wall',
    expectedStackHash: 'a'.repeat(64),
    changes: [{
      type: 'create',
      modifier: { id: 'modifier/subdivision', type: 'subdivision', levels: 2 },
    }],
  };
  const translated = translateToolOperation(operation, project);
  assert.deepEqual(translated, operation);
  assert.notEqual(translated, operation);
  assert.notEqual(translated.changes, operation.changes);
});

test('runtime rejects reserved pipelines instead of silently accepting them', () => {
  const project = createProjectDocument({ projectId: 'project/test' });
  assert.throws(
    () => translateToolOperation({ op: 'layout.grid', ids: [], parameters: {} }, project),
    error => error.code === 'operation_not_implemented',
  );
});

test('runtime validates typed graph resources before they reach the kernel', () => {
  const project = createProjectDocument({ projectId: 'project/test' });
  assert.throws(
    () => translateToolOperation({
      op: 'resource.create',
      resourceType: 'graphs',
      resource: {
        id: 'graph/raw-code',
        graph: { formatVersion: 1, id: 'graph/raw-code', domain: 'shader', nodes: [{ id: 'n', type: 'rawWgsl' }], edges: [], outputs: {} },
      },
    }, project),
    error => error.code === 'graph_validation_failed',
  );
});

test('material variants inherit a canonical base and apply one typed merge patch', () => {
  const project = createProjectDocument({
    projectId: 'project/material-variant',
    resources: { materials: [{
      id: 'material/base', recipe: { kind: 'physical', color: '#445566', roughness: 0.5, metalness: 0.1 },
    }] },
  });
  assert.deepEqual(translateToolOperation({
    op: 'material.variant.create', baseMaterialId: 'material/base', materialId: 'material/polished',
    patch: { recipe: { roughness: 0.12, metalness: 0.8 } }, alias: '$polished',
  }, project), {
    type: 'resource.create', resourceType: 'materials', alias: '$polished',
    resource: {
      id: 'material/polished', kind: 'material', name: 'base', metadata: {},
      recipe: { kind: 'physical', color: '#445566', roughness: 0.12, metalness: 0.8 },
    },
  });
});

test('semantic material looks lower to editable physical material resources', () => {
  const project = createProjectDocument({ projectId: 'project/material-look' });
  assert.deepEqual(translateToolOperation({
    op: 'material.look.create', materialId: 'material/paint', look: 'automotivePaint',
    color: '#cc1122',
  }, project), {
    type: 'resource.create', resourceType: 'materials',
    resource: {
      id: 'material/paint', name: 'Automotive Paint', metadata: { studioLook: 'automotivePaint' },
      recipe: { kind: 'physical', color: '#cc1122', roughness: 0.22, metalness: 0.16, clearcoat: 1, clearcoatRoughness: 0.055 },
    },
  });
});

test('typed lighting rigs lower to raster-safe lights with explicit optional RTX policy', () => {
  const project = createProjectDocument({ projectId: 'project/lighting-rig' });
  const automatic = translateToolOperation({
    op: 'lighting.rig.create', sceneId: 'scene/main', rigId: 'entity/rig/product',
    preset: 'product', center: [0, 1, 0], scale: 2, intensity: 0.5, rtx: 'auto',
  }, project);
  assert.equal(automatic.length, 5);
  assert.deepEqual(automatic.map(entry => entry.type), new Array(5).fill('entity.create'));
  assert.equal(automatic[2].entity.components.light.intensity, 32.5);
  const explicit = translateToolOperation({
    op: 'lighting.rig.create', sceneId: 'scene/main', rigId: 'entity/rig/outdoor',
    preset: 'outdoor', center: [0, 0, 0], scale: 1, intensity: 1, rtx: 'on',
  }, project);
  assert.deepEqual(explicit.at(-1), {
    type: 'scene.rtx.patch', sceneId: 'scene/main',
    patch: { enabled: true, lighting: true, shadows: true, ambientOcclusion: true },
  });
});
