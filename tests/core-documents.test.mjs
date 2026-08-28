import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProjectIndex,
  createEntityDocument,
  createProjectDocument,
  hashEntitySubtree,
  isStableId,
  normalizeStableId,
  validateProjectDocument,
} from '../src/core/index.mjs';

test('creates a complete normalized v1 project and scene', () => {
  const project = createProjectDocument({
    projectId: 'project/courtyard',
    name: 'Courtyard',
    timestamp: '2026-08-28T00:00:00.000Z',
  });
  assert.equal(project.protocolVersion, 'three-studio/1');
  assert.equal(project.formatVersion, 1);
  assert.equal(project.activeSceneId, 'scene/main');
  assert.deepEqual(project.sceneOrder, ['scene/main']);
  assert.deepEqual(project.resources.geometries, {});
  assert.deepEqual(project.scenes['scene/main'].rootEntityIds, []);
  assert.equal(validateProjectDocument(project).valid, true);
});

test('stable IDs are semantic, bounded, and aliases are not document IDs', () => {
  assert.equal(isStableId('courtyard/fountain-01'), true);
  assert.equal(isStableId('$fountain'), false);
  assert.equal(isStableId('../outside'), false);
  assert.equal(isStableId('Bad ID'), false);
  assert.equal(normalizeStableId('Wet Stone Basin', { prefix: 'material' }), 'material/wet-stone-basin');
});

test('normalizes entity transforms, tags, and components', () => {
  const entity = createEntityDocument({
    id: 'courtyard/fountain',
    kind: 'mesh',
    tags: ['water', 'environment', 'water'],
  });
  assert.deepEqual(entity.transform, {
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  });
  assert.deepEqual(entity.tags, ['environment', 'water']);
  assert.deepEqual(entity.components, {});
});

test('validation catches hierarchy cycles, zero scales, and missing resources', () => {
  const project = createProjectDocument({ projectId: 'project/invalid' });
  const scene = project.scenes['scene/main'];
  scene.entities['world/a'] = createEntityDocument({
    id: 'world/a',
    kind: 'mesh',
    parentId: 'world/b',
    children: ['world/b'],
    transform: { scale: [1, 0, 1] },
    components: { mesh: { geometryId: 'geometry/missing', materialIds: ['material/missing'] } },
  });
  scene.entities['world/b'] = createEntityDocument({
    id: 'world/b',
    parentId: 'world/a',
    children: ['world/a'],
  });
  const result = validateProjectDocument(project);
  assert.equal(result.valid, false);
  const codes = new Set(result.diagnostics.map((item) => item.code));
  assert.equal(codes.has('zero_scale'), true);
  assert.equal(codes.has('hierarchy_cycle'), true);
  assert.equal(codes.has('missing_resource'), true);
});

test('project index gives exact stable lookup, references, and subtree hashes', () => {
  const project = createProjectDocument({
    projectId: 'project/indexed',
    resources: {
      geometries: [{ id: 'geometry/box', kind: 'box' }],
      materials: [{ id: 'material/stone', kind: 'standard' }],
    },
    scenes: [{
      id: 'scene/main',
      entities: [
        { id: 'world', kind: 'group', children: ['world/box'] },
        {
          id: 'world/box',
          kind: 'mesh',
          parentId: 'world',
          components: { mesh: { geometryId: 'geometry/box', materialIds: ['material/stone'] } },
        },
      ],
      rootEntityIds: ['world'],
    }],
  });
  const index = buildProjectIndex(project);
  assert.equal(index.getEntity('world/box').sceneId, 'scene/main');
  assert.equal(index.getResource('material/stone').type, 'materials');
  assert.deepEqual(index.collectSubtree('world'), ['world', 'world/box']);
  assert.equal(index.getReferencesTo('material/stone')[0].sourceId, 'world/box');
  assert.match(hashEntitySubtree(project, 'world'), /^[a-f0-9]{64}$/);
});

test('validation enforces globally unique stable IDs', () => {
  const project = createProjectDocument({
    projectId: 'project/duplicates',
    resources: { materials: [{ id: 'shared/id', kind: 'standard' }] },
    scenes: [{ id: 'scene/main', entities: [{ id: 'shared/id', kind: 'empty' }] }],
  });
  const result = validateProjectDocument(project);
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics.some((item) => item.code === 'duplicate_id'), true);
});

test('validation rejects malformed persisted layout pattern modifiers', () => {
  const project = createProjectDocument({
    projectId: 'project/invalid-pattern',
    resources: { geometries: [{ id: 'geometry/source', kind: 'box' }] },
    scenes: [{
      id: 'scene/main',
      entities: [{
        id: 'entity/source',
        kind: 'mesh',
        components: {
          mesh: { geometryId: 'geometry/source' },
          modifiers: [{
            id: 'modifier/grid', type: 'pattern', mode: 'grid',
            counts: [64, 64, 3], spacing: [1, 1, 1],
          }],
        },
      }],
    }],
  });
  const result = validateProjectDocument(project);
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics.some(item => item.code === 'invalid_layout_pattern'), true);
});
