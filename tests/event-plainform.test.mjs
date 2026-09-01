import assert from 'node:assert/strict';
import test from 'node:test';

import { AuthoringKernel, createProjectDocument } from '../src/core/index.mjs';
import { operationSchema } from '../src/mcp/tool-schemas.mjs';
import { PlainformCompiler } from '../src/plainform/index.mjs';
import { createLogicControllerRuntime } from '../src/runtime/logic-controller-runtime.mjs';

function project() {
  return createProjectDocument({
    projectId: 'project/event-plainform',
    scenes: [{
      id: 'scene/main',
      settings: { controller: { enabled: true, entityId: 'entity/player', activationKey: 'Enter', capture: { keyboard: true } } },
      entities: [
        { id: 'entity/player', kind: 'gameObject', name: 'Player' },
        { id: 'entity/pine-trunk', kind: 'gameObject', name: 'Pine Trunk' },
      ],
    }],
  });
}

function object() {
  const vector = (x = 0, y = 0, z = 0) => ({ x, y, z, set(a, b, c) { Object.assign(this, { x: a, y: b, z: c }); } });
  return { position: vector(), rotation: vector(), scale: vector(1, 1, 1), visible: true, updateMatrix() {}, updateMatrixWorld() {} };
}

test('Event Plainform compiles keyboard, collision, payload conditions, ordered actions, and one-shot messages to one canonical sheet', async () => {
  const source = [
    'For Player, when Left is held, move left at 5 metres per second.',
    'When Player collides with Pine Trunk, stop horizontal movement.',
    'When Player receives Chop with strength at least 3, add 1 to Damage and play the bark-hit animation. If Damage reaches 10, send Tree Fell once.',
  ].join('\n');
  const initial = project(); const compiled = new PlainformCompiler().compile(source, { project: initial });
  assert.equal(compiled.dialect, 'event');
  assert.equal(compiled.eventSheet.rowCount, 3);
  assert.ok(compiled.operations.every(operation => operationSchema.safeParse(operation).success));
  const graph = compiled.operations[0].resource.graph;
  assert.ok(graph.nodes.some(node => node.type === 'event.payloadNumber'));
  assert.ok(graph.nodes.some(node => node.type === 'value.add'));
  assert.ok(graph.nodes.some(node => node.type === 'event.emitOnce'));
  assert.deepEqual(compiled.operations[0].resource.metadata.plainform.capabilities.unavailable, ['draw-event', 'destroy-event', 'pointer-event', 'scene-change']);

  const kernel = new AuthoringKernel(initial);
  await kernel.apply({ baseRevision: kernel.document.revision, idempotencyKey: 'event-plainform-create', label: 'Create event sheet', operations: compiled.operations });
  const regenerated = new PlainformCompiler().compile(source, { project: kernel.document });
  assert.equal(regenerated.operations[0].op, 'resource.patch');
  assert.deepEqual(regenerated.operations[0].patch.graph, graph);
});

test('Event Plainform message conditions execute deterministically in the shared controller runtime', () => {
  const source = 'When Player receives Chop with strength at least 3, add 1 to Damage and play the bark-hit animation. If Damage reaches 2, send Tree Fell once.';
  const initial = project(); const compiled = new PlainformCompiler().compile(source, { project: initial }); const graph = compiled.operations[0].resource.graph;
  const player = object(); const animations = [];
  const scene = { ...initial.scenes['scene/main'], entities: { ...initial.scenes['scene/main'].entities, 'entity/player': { ...initial.scenes['scene/main'].entities['entity/player'], components: { logic: { enabled: true, graphIds: [graph.id] } } } } };
  const runtime = createLogicControllerRuntime({
    project: { resources: { graphs: { [graph.id]: { graph } } } }, scene,
    objects: new Map([['entity/player', player], ['entity/pine-trunk', object()]]),
    animationRuntime: { play(id) { animations.push(id); } },
  });
  assert.equal(runtime.activate(), true);
  runtime.emit('event/chop', { strength: 2 });
  runtime.emit('event/chop', { strength: 3 });
  runtime.emit('event/chop', { strength: 4 });
  assert.deepEqual(animations, ['animation/bark-hit', 'animation/bark-hit']);
  assert.deepEqual(runtime.status.diagnostics, []);
});

test('Event Plainform fails closed on unsupported events and mixed subjects', () => {
  const initial = project();
  assert.throws(() => new PlainformCompiler().compile('When Player is destroyed, play sparks.', { project: initial }), error => error.code === 'plainform_event_unsupported');
  assert.throws(() => new PlainformCompiler().compile('For Player, when Left is held, move left at 5 metres per second.\nWhen Pine Trunk collides with Player, stop horizontal movement.', { project: initial }), error => error.code === 'plainform_event_subject_mismatch');
});
