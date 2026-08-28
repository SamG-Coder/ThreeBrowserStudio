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
