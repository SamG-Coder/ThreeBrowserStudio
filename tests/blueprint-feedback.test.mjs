import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGraphDigest } from '../src/graphs/digest.mjs';
import { describeSocketLiveness } from '../src/graphs/live-sockets.mjs';
import { validateGraph } from '../src/graphs/validator.mjs';
import { blueprintReachability } from '../src/graphs/blueprint-runtime-support.mjs';
import { forecastPixelImpact } from '../src/core/pixel-forecast.mjs';

const edge = (from, fromPort, to, toPort) => ({ from: { nodeId: from, port: fromPort }, to: { nodeId: to, port: toPort } });
function controllerGraph() {
  return {
    formatVersion: 1, id: 'graph/controller-feedback', domain: 'blueprint', outputs: {},
    nodes: [
      { id: 'tick', type: 'event.onFixedUpdate', params: {} },
      { id: 'held', type: 'input.keyHeld', params: { key: 'KeyW' } },
      { id: 'speed', type: 'value.math', params: { operation: 'multiply' }, inputs: { b: 12 } },
      { id: 'move', type: 'motion.setSpeed', params: {} },
      { id: 'self', type: 'entity.self', params: {} },
      { id: 'orphan', type: 'value.constant', params: { valueType: 'float', value: 3 } },
    ],
    edges: [edge('tick', 'out', 'move', 'in'), edge('held', 'value', 'speed', 'a'), edge('speed', 'value', 'move', 'speed'), edge('self', 'entity', 'move', 'entity')],
  };
}
function forecast(beforeGraph, operation) {
  return forecastPixelImpact({ before: { resources: { graphs: { [beforeGraph.id]: { id: beforeGraph.id, kind: 'graph', graph: beforeGraph } } } }, operations: [operation] });
}
const patchGraph = graph => ({ op: 'resource.patch', resourceType: 'graphs', resourceId: graph.id, patch: { graph } });

test('controller digest follows event execution and recursive data dependencies without requiring shader outputs', () => {
  const digest = buildGraphDigest(controllerGraph());
  assert.equal(digest.validation.valid, true, JSON.stringify(digest.validation.errors));
  assert.equal(digest.contribution.basis, 'event-flow-and-data-dependencies');
  assert.equal(digest.contribution.contributingNodeCount, 5);
  assert.deepEqual(digest.contribution.unusedNodeIds, ['orphan']);
  assert.equal(digest.contribution.events.tick.executionNodeCount, 2);
  assert.equal(digest.contribution.events.tick.dataDependencyCount, 3);
  for (const id of ['tick', 'held', 'speed', 'move', 'self']) {
    const node = digest.nodes.find(item => item.id === id);
    assert.deepEqual(node.contribution, ['event:tick']);
    assert.equal(node.runtimeSupport.live, true);
    assert.ok((node.sockets ?? []).every(socket => socket.live && socket.compiled && socket.liveReason === 'live-controller-runtime'));
  }
});

test('reachability never pulls disconnected execution predecessors into the active event path', () => {
  const graph = controllerGraph();
  graph.nodes.push({ id: 'disconnected', type: 'motion.setSpeed', params: {}, inputs: { speed: 8 } });
  graph.edges.push(edge('disconnected', 'out', 'move', 'in'));
  const { reachable } = blueprintReachability(graph.nodes, graph.edges);
  assert.equal(reachable.has('disconnected'), false);
  assert.equal(reachable.has('held'), true);
  // Validation may additionally reject the duplicate exec input; the unreachable
  // node must still never become a contributing runtime predecessor.
  assert.ok(validateGraph(graph).warnings.some(item => item.nodeId === 'disconnected' && item.code === 'unreachable_node'));
});

test('catalog-only blueprint operations remain explicitly unavailable', () => {
  for (const type of ['time.delay', 'flow.boundedLoop', 'entity.spawn', 'script.callExposed']) {
    assert.deepEqual(describeSocketLiveness({ type }, 'blueprint', 'in', new Set()), { compiled: false, live: false, reason: 'catalog-only-controller-node' });
  }
  assert.deepEqual(describeSocketLiveness({ type: 'value.math' }, 'blueprint', 'a', new Set()), { compiled: true, live: true, reason: 'live-controller-runtime' });
  for (const port of ['a', 'b']) {
    assert.deepEqual(describeSocketLiveness({ type: 'compare.values' }, 'blueprint', port, new Set()), { compiled: true, live: true, reason: 'live-controller-runtime' });
  }
});

test('controller input changes, parameter-only edits and same-count edge rewires forecast runtime-dependent unknown', () => {
  const before = controllerGraph();
  const inputs = forecast(before, { op: 'resource.patch', resourceType: 'graphs', resourceId: before.id, patch: { nodeInputs: { speed: { b: 18 } } } });
  assert.equal(inputs.verdict, 'unknown');
  assert.equal(inputs.sockets[0].live, true);
  assert.equal(inputs.sockets[0].reason, 'controller-runtime-dependent');
  const params = structuredClone(before); params.nodes.find(node => node.id === 'held').params.key = 'KeyS';
  const changedParams = forecast(before, patchGraph(params));
  assert.equal(changedParams.verdict, 'unknown');
  assert.ok(changedParams.sockets.some(item => item.reason.endsWith('node-params')));
  const rewire = structuredClone(before); rewire.edges.find(item => item.to.nodeId === 'move' && item.to.port === 'speed').from = { nodeId: 'orphan', port: 'value' };
  const changedWire = forecast(before, patchGraph(rewire));
  assert.equal(changedWire.verdict, 'unknown');
  assert.ok(changedWire.sockets.some(item => item.reason.endsWith('graph-topology')));
  assert.notEqual(changedWire.reasons[0]?.code, 'graph-unchanged');
  assert.equal(forecast(before, patchGraph(structuredClone(before))).verdict, 'will-not-move');
});

test('controller graph creation/deletion, activation configuration and physics components are not immediate pixel promises', () => {
  const graph = controllerGraph();
  for (const operation of [
    { op: 'resource.create', resourceType: 'graphs', resource: { id: graph.id, kind: 'graph', graph } },
    { op: 'resource.createMany', items: [{ resourceType: 'graphs', resource: { id: graph.id, kind: 'graph', graph } }] },
    { op: 'resource.delete', resourceType: 'graphs', resourceId: graph.id },
    { op: 'scene.settings.patch', sceneId: 'scene/main', patch: { controller: { enabled: true } } },
    { op: 'entity.patch', entityId: 'entity/car', patch: { components: { logic: { enabled: true } } } },
    { op: 'entity.patchMany', entityIds: ['entity/car'], patch: { components: { rigidBody: { mass: 1400 } } } },
    { op: 'entity.component.attach', entityId: 'entity/car', component: 'rigidBody', value: { bodyType: 'dynamic' } },
    { op: 'entity.component.remove', entityId: 'entity/car', component: 'collider' },
  ]) assert.equal(forecast(graph, operation).verdict, 'unknown', operation.op);
});

test('shader parameter edits and same-count edge rewires are detected, while layout edits stay unchanged', () => {
  const graph = { formatVersion: 1, id: 'graph/shader-feedback', domain: 'shader', nodes: [
    { id: 'a', type: 'constant.float', params: { value: 0.2 } },
    { id: 'b', type: 'constant.float', params: { value: 0.7 } },
    { id: 'mix', type: 'math.multiply', params: { valueType: 'float' }, inputs: { b: 0.5 } },
  ], edges: [edge('a', 'value', 'mix', 'a')], outputs: { roughness: { nodeId: 'mix', port: 'value' } } };
  const params = structuredClone(graph); params.nodes[0].params.value = 0.3;
  assert.equal(forecast(graph, patchGraph(params)).verdict, 'will-move');
  const rewired = structuredClone(graph); rewired.edges[0].from.nodeId = 'b';
  const changed = forecast(graph, patchGraph(rewired));
  assert.equal(changed.verdict, 'will-move');
  assert.ok(changed.sockets.some(item => item.nodeId === 'mix' && item.port === 'a' && item.reason === 'live-delta'));
  const layout = structuredClone(graph); layout.nodes[0].layout = { position: [40, 60] };
  assert.equal(forecast(graph, patchGraph(layout)).verdict, 'will-not-move');
});

test('blueprint digest keeps event summaries bounded and reports shared data to every dependent event', () => {
  const graph = controllerGraph();
  graph.nodes.push({ id: 'release', type: 'event.onKeyUp', params: { key: 'KeyW' } });
  graph.nodes.push({ id: 'stop', type: 'motion.setSpeed', params: {}, inputs: { speed: 0 } });
  graph.edges.push(edge('release', 'out', 'stop', 'in'), edge('self', 'entity', 'stop', 'entity'));
  for (let index = 0; index < 24; index += 1) graph.nodes.push({ id: `extra-${index}`, type: 'event.onStart', params: {} });
  const digest = buildGraphDigest(graph, { nodeLimit: 64 });
  assert.equal(digest.validation.valid, true);
  assert.equal(digest.contribution.eventCount, 26);
  assert.equal(digest.contribution.eventsTruncated, true);
  assert.equal(Object.keys(digest.contribution.events).length, 16);
  assert.deepEqual(digest.nodes.find(node => node.id === 'self').contribution, ['event:release', 'event:tick']);
  assert.ok(digest.estimatedResponseBytes <= digest.responseByteBudget);
});

test('graph edge ordering alone stays unchanged and same-size node replacement is detected', () => {
  const graph = controllerGraph();
  const reordered = structuredClone(graph); reordered.edges.reverse();
  assert.equal(forecast(graph, patchGraph(reordered)).verdict, 'will-not-move');
  const replaced = structuredClone(graph); replaced.nodes.find(node => node.id === 'orphan').id = 'new-orphan';
  const result = forecast(graph, patchGraph(replaced));
  assert.equal(result.verdict, 'unknown');
  assert.ok(result.sockets.some(item => item.reason.endsWith('graph-topology')));
});
