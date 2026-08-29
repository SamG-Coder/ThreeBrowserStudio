import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyOperations,
  createProjectDocument,
  validateProjectDocument,
} from '../src/core/index.mjs';

function principledResource(id = 'graph/velvet') {
  return {
    id,
    kind: 'graph',
    name: 'Velvet',
    metadata: { preserved: true },
    graph: {
      formatVersion: 1,
      id,
      domain: 'shader',
      nodes: [
        { id: 'color', type: 'constant.color', params: { value: [0.2, 0.05, 0.08] } },
        {
          id: 'bsdf',
          type: 'blender.principledBSDF',
          params: {},
          inputs: {
            roughness: 0.72,
            sheenWeight: 0.4,
            metallic: 0.1,
            specularIorLevel: 0.35,
          },
        },
      ],
      edges: [{
        from: { nodeId: 'color', port: 'value' },
        to: { nodeId: 'bsdf', port: 'baseColor' },
      }],
      outputs: { baseColor: { nodeId: 'color', port: 'value' } },
    },
  };
}
import { queryGraphCatalog } from '../src/graphs/index.mjs';
import { translateToolOperation } from '../src/runtime/studio-application.mjs';

function shaderGraph(id = 'graph/painterly-water', color = [0.08, 0.24, 0.32]) {
  return {
    formatVersion: 1,
    id,
    domain: 'shader',
    nodes: [{ id: 'water-color', type: 'constant.color', params: { value: color } }],
    edges: [],
    outputs: { baseColor: { nodeId: 'water-color', port: 'value' } },
  };
}

function flatGraphResource(id = 'graph/painterly-water') {
  return {
    id,
    kind: 'graph',
    name: 'Painterly Water',
    metadata: { source: 'live-mcp-regression' },
    ...shaderGraph(id),
  };
}

test('singular flat MCP graph creates normalize to the canonical nested envelope', () => {
  const project = createProjectDocument({ projectId: 'project/graph-flat-create' });
  const translated = translateToolOperation({
    op: 'resource.create',
    resourceType: 'graph',
    resource: flatGraphResource(),
  }, project);

  assert.equal(translated.resourceType, 'graphs');
  assert.deepEqual({
    id: translated.resource.id,
    kind: translated.resource.kind,
    name: translated.resource.name,
    metadata: translated.resource.metadata,
  }, {
    id: 'graph/painterly-water',
    kind: 'graph',
    name: 'Painterly Water',
    metadata: { source: 'live-mcp-regression' },
  });
  assert.deepEqual(translated.resource.graph, shaderGraph());
  for (const key of ['formatVersion', 'domain', 'nodes', 'edges', 'outputs']) {
    assert.equal(Object.hasOwn(translated.resource, key), false, `${key} leaked outside resource.graph`);
  }

  const document = applyOperations(project, [translated]).document;
  assert.deepEqual(document.resources.graphs['graph/painterly-water'], translated.resource);
});

test('nested graph creates and flat singular patches remain canonical and validate immediately', () => {
  const id = 'graph/painterly-water';
  const project = createProjectDocument({
    projectId: 'project/graph-flat-patch',
    resources: {
      graphs: {
        [id]: {
          id,
          kind: 'graph',
          name: 'Nested Water',
          metadata: { preserved: true },
          graph: shaderGraph(id),
        },
      },
    },
  });
  const nextGraph = shaderGraph(id, [0.18, 0.42, 0.5]);
  const translated = translateToolOperation({
    op: 'resource.patch',
    resourceType: 'graph',
    resourceId: id,
    patch: { name: 'Patched Water', ...nextGraph },
  }, project);

  assert.equal(translated.resourceType, 'graphs');
  assert.equal(translated.patch.name, 'Patched Water');
  assert.deepEqual(translated.patch.graph, nextGraph);
  assert.equal(Object.hasOwn(translated.patch, 'nodes'), false);

  const document = applyOperations(project, [translated]).document;
  const resource = document.resources.graphs[id];
  assert.equal(resource.name, 'Patched Water');
  assert.deepEqual(resource.metadata, { preserved: true });
  assert.deepEqual(resource.graph, nextGraph);

  const invalidPatch = {
    nodes: [{ id: 'unsafe', type: 'rawWgsl', params: {} }],
    outputs: { baseColor: { nodeId: 'unsafe', port: 'value' } },
  };
  assert.throws(
    () => translateToolOperation({
      op: 'resource.patch', resourceType: 'graph', resourceId: id, patch: invalidPatch,
    }, project),
    error => error.code === 'graph_validation_failed',
  );
  assert.throws(
    () => applyOperations(project, [{
      op: 'resource.patch', resourceType: 'graph', resourceId: id, patch: invalidPatch,
    }]),
    error => error.code === 'graph_validation_failed',
  );
});

test('unused malformed graphs fail create and whole-project validation', () => {
  const project = createProjectDocument({ projectId: 'project/unused-invalid-graph' });
  const invalidFlat = {
    ...flatGraphResource('graph/unused-invalid'),
    nodes: [{ id: 'unsafe', type: 'rawWgsl', params: {} }],
    outputs: { baseColor: { nodeId: 'unsafe', port: 'value' } },
  };
  assert.throws(
    () => translateToolOperation({
      op: 'resource.create', resourceType: 'graph', resource: invalidFlat,
    }, project),
    error => error.code === 'graph_validation_failed',
  );
  assert.throws(
    () => applyOperations(project, [{
      op: 'resource.create', resourceType: 'graph', resource: invalidFlat,
    }]),
    error => error.code === 'graph_validation_failed',
  );

  project.resources.graphs['graph/unused-invalid'] = {
    id: 'graph/unused-invalid',
    kind: 'graph',
    name: 'Unused Invalid Graph',
    metadata: {},
    graph: {
      ...shaderGraph('graph/unused-invalid'),
      nodes: [{ id: 'unsafe', type: 'rawWgsl', params: {} }],
      outputs: { baseColor: { nodeId: 'unsafe', port: 'value' } },
    },
  };
  const invalidNested = validateProjectDocument(project);
  assert.equal(invalidNested.valid, false);
  assert.ok(invalidNested.diagnostics.some(item => item.code === 'unknown_node_type'
    && item.path.startsWith('$.resources.graphs.graph/unused-invalid.graph')));

  project.resources.graphs['graph/unused-invalid'] = flatGraphResource('graph/unused-invalid');
  const nonCanonicalFlat = validateProjectDocument(project);
  assert.equal(nonCanonicalFlat.valid, false);
  assert.ok(nonCanonicalFlat.diagnostics.some(item => item.code === 'invalid_graph_resource'));
});

test('graph catalog exposes the canonical resource envelope and edge port shape', () => {
  const authoring = queryGraphCatalog('shader', { limit: 1 }).authoring;
  assert.equal(authoring.resourceType, 'graphs');
  assert.equal(authoring.canonicalEnvelope.graph.domain, 'shader');
  assert.deepEqual(authoring.edgePortShape, {
    from: { nodeId: 'source-node', port: 'outputPort' },
    to: { nodeId: 'target-node', port: 'inputPort' },
  });
  assert.match(authoring.guidance, /resource\.graph/);
  assert.match(authoring.guidance, /nodeId and port/);
});

test('nodeInputs merges one socket without wiping the rest of a Principled node', () => {
  const id = 'graph/velvet';
  const project = createProjectDocument({
    projectId: 'project/socket-merge',
    resources: { graphs: { [id]: principledResource(id) } },
  });
  const translated = translateToolOperation({
    op: 'resource.patch',
    resourceType: 'graph',
    resourceId: id,
    patch: { nodeInputs: { bsdf: { roughness: 0.96 } } },
  }, project);
  assert.equal(Object.hasOwn(translated.patch, 'nodeInputs'), false);
  const bsdf = translated.patch.graph.nodes.find(node => node.id === 'bsdf');
  assert.equal(bsdf.inputs.roughness, 0.96);
  assert.equal(bsdf.inputs.sheenWeight, 0.4);
  assert.equal(bsdf.inputs.metallic, 0.1);
  assert.equal(bsdf.inputs.specularIorLevel, 0.35);

  const document = applyOperations(project, [translated]).document;
  const live = document.resources.graphs[id].graph.nodes.find(node => node.id === 'bsdf');
  assert.equal(live.inputs.roughness, 0.96);
  assert.equal(live.inputs.sheenWeight, 0.4);
  assert.equal(live.inputs.ior, 1.5);
});
