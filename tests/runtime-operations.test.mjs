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
