import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_INSPECT_RESPONSE_BYTES, contentHash } from '../src/core/index.mjs';
import { buildGraphDigest } from '../src/graphs/index.mjs';

function principledGraph() {
  return {
    formatVersion: 1,
    id: 'graph/principled-velvet',
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
  };
}

function graphResource() {
  return {
    id: 'graph/digest-example',
    kind: 'graph',
    name: 'Digest Example',
    metadata: { authoredBy: 'test' },
    graph: {
      formatVersion: 1,
      id: 'graph/digest-example',
      domain: 'shader',
      nodes: [
        { id: 'z-unused', type: 'constant.color', params: { value: [0.1, 0.2, 0.3] } },
        { id: 'math', type: 'math.add', params: { valueType: 'float' } },
        { id: 'b', type: 'constant.float', params: { value: 0.65 } },
        { id: 'a', type: 'constant.float', params: { value: 0.2 }, layout: { position: [20, 30], label: 'A' } },
      ],
      edges: [
        { from: { nodeId: 'b', port: 'value' }, to: { nodeId: 'math', port: 'b' } },
        { from: { nodeId: 'a', port: 'value' }, to: { nodeId: 'math', port: 'a' } },
      ],
      outputs: { roughness: { nodeId: 'math', port: 'value' } },
    },
  };
}

test('graph digest returns canonical hashes, validation data, and deterministic sorted pages', () => {
  const resource = graphResource();
  const first = buildGraphDigest(resource, { nodeLimit: 2, edgeLimit: 1 });

  assert.equal(first.resourceHash, contentHash(resource));
  assert.equal(first.domain, 'shader');
  assert.equal(first.validation.valid, true);
  assert.equal(first.validation.metrics.nodeCount, 4);
  assert.equal(first.validation.warningCount, 1);
  assert.equal(first.validation.warnings[0].code, 'unused_node');
  assert.deepEqual(first.nodes.map(node => node.id), ['a', 'b']);
  assert.deepEqual(first.edges, [{
    from: { nodeId: 'a', port: 'value' },
    to: { nodeId: 'math', port: 'a' },
  }]);
  assert.equal(typeof first.nextCursor, 'string');
  assert.ok(first.estimatedResponseBytes <= MAX_INSPECT_RESPONSE_BYTES);

  const repeated = buildGraphDigest(resource, { nodeLimit: 2, edgeLimit: 1 });
  assert.deepEqual(repeated, first);

  const second = buildGraphDigest(resource, {
    cursor: first.nextCursor,
    nodeLimit: 2,
    edgeLimit: 1,
  });
  assert.equal(second.graphHash, first.graphHash);
  assert.deepEqual(second.nodes.map(node => node.id), ['math', 'z-unused']);
  assert.deepEqual(second.edges, [{
    from: { nodeId: 'b', port: 'value' },
    to: { nodeId: 'math', port: 'b' },
  }]);
  assert.equal(second.nextCursor, null);
});

test('graph digest cursor is rejected after the graph changes', () => {
  const resource = graphResource();
  const first = buildGraphDigest(resource, { nodeLimit: 1, edgeLimit: 0 });
  resource.graph.nodes[2].params.value = 0.75;

  assert.throws(
    () => buildGraphDigest(resource, { cursor: first.nextCursor, nodeLimit: 1, edgeLimit: 0 }),
    error => error.code === 'graph_digest_cursor_stale',
  );
});

test('graph digest never echoes pathological parameter arrays and respects a smaller byte budget', () => {
  const payload = Array.from({ length: 4096 }, (_, index) => ({
    index,
    label: `large-authored-value-${index}-${'x'.repeat(80)}`,
  }));
  const graph = {
    formatVersion: 1,
    id: 'graph/pathological-inspection',
    domain: 'shader',
    nodes: [{ id: 'oversize', type: 'unknown.node', params: { payload } }],
    edges: [],
    outputs: {},
  };
  const digest = buildGraphDigest(graph, { maxResponseBytes: 4096, nodeLimit: 1, edgeLimit: 0 });
  const serialized = JSON.stringify(digest);

  assert.equal(digest.validation.valid, false);
  assert.ok(digest.validation.errors.length > 0);
  assert.equal(digest.nodes.length, 1);
  assert.deepEqual({
    kind: digest.nodes[0].params.payload.kind,
    length: digest.nodes[0].params.payload.length,
    sampleLength: digest.nodes[0].params.payload.sample.length,
  }, { kind: 'array', length: 4096, sampleLength: 3 });
  assert.equal(serialized.includes('large-authored-value-4000'), false);
  assert.ok(Buffer.byteLength(serialized) <= 4096);
  assert.equal(digest.estimatedResponseBytes, Buffer.byteLength(serialized));
});

test('graph digest preserves normal authored parameter arrays exactly', () => {
  const stops = Array.from({ length: 16 }, (_, index) => ({
    position: index / 15,
    color: [index / 15, 0.25, 1 - index / 15],
  }));
  const graph = {
    formatVersion: 1,
    id: 'graph/rich-ramp',
    domain: 'shader',
    nodes: [
      { id: 'input', type: 'constant.float', params: { value: 0.5 } },
      { id: 'ramp', type: 'ramp.color', params: { stops, interpolation: 'smoothstep' } },
    ],
    edges: [{
      from: { nodeId: 'input', port: 'value' },
      to: { nodeId: 'ramp', port: 'value' },
    }],
    outputs: { baseColor: { nodeId: 'ramp', port: 'color' } },
  };
  const digest = buildGraphDigest(graph);
  const ramp = digest.nodes.find(node => node.id === 'ramp');

  assert.equal(digest.validation.valid, true);
  assert.deepEqual(ramp.params.stops, stops);
});

test('graph digest rejects a cursor configuration that cannot advance', () => {
  assert.throws(
    () => buildGraphDigest(graphResource(), { nodeLimit: 0, edgeLimit: 0 }),
    error => error.code === 'graph_digest_invalid_options',
  );
});

test('zero limit cleanly excludes one paging slice', () => {
  const resource = graphResource();
  const nodePageOne = buildGraphDigest(resource, { nodeLimit: 2, edgeLimit: 0 });
  const nodePageTwo = buildGraphDigest(resource, {
    cursor: nodePageOne.nextCursor,
    nodeLimit: 2,
    edgeLimit: 0,
  });

  assert.deepEqual(nodePageOne.nodes.map(node => node.id), ['a', 'b']);
  assert.deepEqual(nodePageOne.edges, []);
  assert.deepEqual(nodePageTwo.nodes.map(node => node.id), ['math', 'z-unused']);
  assert.equal(nodePageTwo.nextCursor, null);

  const edgesOnly = buildGraphDigest(resource, { nodeLimit: 0, edgeLimit: 2 });
  assert.deepEqual(edgesOnly.nodes, []);
  assert.equal(edgesOnly.edges.length, 2);
  assert.equal(edgesOnly.nextCursor, null);
});

test('bare graph and resource envelopes both expose resourceHash and graphHash', () => {
  const resource = graphResource();
  const envelopeDigest = buildGraphDigest(resource);
  const graphDigest = buildGraphDigest(resource.graph);

  assert.notEqual(envelopeDigest.resourceHash, envelopeDigest.graphHash);
  assert.equal(graphDigest.resourceHash, contentHash(resource.graph));
  assert.equal(graphDigest.graphHash, envelopeDigest.graphHash);
});

test('graph digest lists authored-versus-default sockets even when compact inputs truncate', () => {
  const digest = buildGraphDigest(principledGraph());
  const bsdf = digest.nodes.find(node => node.id === 'bsdf');
  assert.equal(digest.socketContract, 'full-vs-default');
  assert.ok(bsdf.sockets.length > 16);
  assert.ok(bsdf.inputs.$summary.omittedKeyCount > 0);
  const roughness = bsdf.sockets.find(socket => socket.port === 'roughness');
  const ior = bsdf.sockets.find(socket => socket.port === 'ior');
  const baseColor = bsdf.sockets.find(socket => socket.port === 'baseColor');
  const sheen = bsdf.sockets.find(socket => socket.port === 'sheenWeight');
  assert.equal(roughness.source, 'authored');
  assert.equal(roughness.value, 0.72);
  assert.equal(ior.source, 'default');
  assert.equal(ior.default, 1.5);
  assert.equal(baseColor.source, 'edge');
  assert.deepEqual(baseColor.from, { nodeId: 'color', port: 'value' });
  assert.equal(sheen.source, 'authored');
  assert.ok(bsdf.authoredCount >= 3);
  assert.ok(bsdf.defaultCount >= 16);
  assert.equal(bsdf.connectedCount, 1);
});
