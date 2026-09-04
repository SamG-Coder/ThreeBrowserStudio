import assert from 'node:assert/strict';
import test from 'node:test';
import { validateGraph } from '../src/graphs/validator.mjs';
import { createLogicControllerRuntime } from '../src/runtime/logic-controller-runtime.mjs';

const edge = (from, port, to, input) => ({ from: { nodeId: from, port }, to: { nodeId: to, port: input } });
const node = (id, type, inputs = {}, params = {}) => ({ id, type, inputs, params });
const math = (id, operation, inputs = {}) => node(id, 'value.math', inputs, { operation });
function object() {
  const vector = () => ({ x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } });
  return { position: vector(), rotation: vector(), scale: { ...vector(), x: 1, y: 1, z: 1 }, updateMatrix() {}, updateMatrixWorld() {} };
}
function fixture(nodes, edges, objects = new Map([['entity/body', object()]])) {
  const graph = { formatVersion: 1, id: 'graph/math', domain: 'blueprint', nodes, edges, outputs: {} };
  const validation = validateGraph(graph);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const runtime = createLogicControllerRuntime({
    project: { resources: { graphs: { [graph.id]: { graph } } } },
    scene: {
      settings: { controller: { entityId: 'entity/body' } },
      entities: Object.fromEntries([...objects.keys()].map(id => [id, { id, components: id === 'entity/body' ? { logic: { graphIds: [graph.id] } } : {} }])),
    },
    objects,
  });
  return { runtime, objects };
}

test('typed scalar arithmetic stays finite, clamps bounds, and constructs vector components', () => {
  const examples = [
    ['add', 3, 4, 0, 7], ['subtract', 3, 4, 0, -1], ['multiply', 3, 4, 0, 12],
    ['divide', 12, 4, 0, 3], ['divide', 1, 0, 0, 0],
    ['min', 3, 4, 0, 3], ['max', 3, 4, 0, 4],
    ['clamp', 12, -2, 5, 5], ['clamp', -12, 5, -2, -2],
    ['abs', -3, 0, 0, 3], ['negate', 3, 0, 0, -3], ['sign', -3, 0, 0, -1],
    ['sqrt', 9, 0, 0, 3], ['sqrt', -9, 0, 0, 0],
    ['sin', Math.PI / 2, 0, 0, 1], ['cos', Math.PI, 0, 0, -1],
    ['tan', Math.PI / 4, 0, 0, 1], ['atan', 1, 0, 0, Math.PI / 4],
    ['multiply', 1e308, 1e308, 0, 1e12], ['multiply', -1e308, 1e308, 0, -1e12],
  ];
  for (const [operation, a, b, c, expected] of examples) {
    const { runtime, objects } = fixture([
      node('start', 'event.onStart'), math('math', operation, { a, b, c }),
      node('vector', 'vector.compose', { y: 7, z: 9 }),
      node('component', 'vector.component', {}, { component: 'x' }),
      node('result', 'vector.compose'), node('set', 'transform.set', { entity: 'entity/body' }),
    ], [
      edge('start', 'out', 'set', 'in'), edge('math', 'value', 'vector', 'x'),
      edge('vector', 'vector', 'component', 'vector'), edge('component', 'value', 'result', 'x'),
      edge('result', 'vector', 'set', 'position'),
    ]);
    runtime.activate();
    const actual = objects.get('entity/body').position;
    assert.ok(Math.abs(actual.x - expected) < 1e-9, `${operation}: ${actual.x} != ${expected}`);
    assert.equal(actual.y, 0);
    assert.equal(actual.z, 0);
    assert.deepEqual(runtime.status.diagnostics, []);
  }
});

test('keyHeld and typed selection reflect press, release, reset, and simultaneous input', () => {
  const { runtime, objects } = fixture([
    node('fixed', 'event.onFixedUpdate'), node('key', 'input.keyHeld', {}, { key: 'KeyW' }),
    node('select', 'value.select', { whenTrue: 5, whenFalse: -2 }, { valueType: 'float' }),
    node('vector', 'vector.compose'), node('set', 'transform.set', { entity: 'entity/body' }),
  ], [
    edge('fixed', 'out', 'set', 'in'), edge('key', 'held', 'select', 'condition'),
    edge('select', 'value', 'vector', 'x'), edge('key', 'value', 'vector', 'z'), edge('vector', 'vector', 'set', 'position'),
  ]);
  runtime.activate(); runtime.update(1 / 60);
  assert.equal(objects.get('entity/body').position.x, -2);
  runtime.keyDown('KeyW'); runtime.keyDown('KeyA'); runtime.update(1 / 60);
  assert.equal(objects.get('entity/body').position.x, 5);
  assert.equal(objects.get('entity/body').position.z, 1);
  runtime.keyUp('KeyA'); runtime.update(1 / 60);
  assert.equal(objects.get('entity/body').position.x, 5);
  runtime.releaseKeys(); runtime.update(1 / 60);
  assert.equal(objects.get('entity/body').position.z, 0);
  runtime.stop(); runtime.activate(); runtime.update(1 / 60);
  assert.equal(objects.get('entity/body').position.x, -2);
});

test('a fixed-step controller accelerates, coasts, reverses and links turning and rolling to speed', () => {
  const run = partition => {
    const nodes = [
      node('fixed', 'event.onFixedUpdate'), node('forward', 'input.keyHeld', {}, { key: 'KeyW' }),
      node('reverse', 'input.keyHeld', {}, { key: 'KeyS' }), node('left', 'input.keyHeld', {}, { key: 'KeyA' }),
      node('right', 'input.keyHeld', {}, { key: 'KeyD' }), node('speed', 'motion.getSpeed', { entity: 'entity/body' }),
      math('forwardSpeed', 'negate'), math('throttle', 'multiply', { b: 6 }), math('brake', 'multiply', { b: -9 }),
      math('pedals', 'add'), math('drag', 'multiply', { b: 0.5 }), math('acceleration', 'subtract'),
      math('increment', 'multiply'), math('next', 'add'), math('clamp', 'clamp', { b: -6, c: 30 }),
      math('command', 'negate'), node('setSpeed', 'motion.setSpeed', { entity: 'entity/body' }),
      math('steerAxis', 'subtract'), math('steerAngle', 'multiply', { b: 0.35 }), math('steerTan', 'tan'),
      math('curve', 'divide', { b: 2.7 }), math('yaw', 'multiply'), node('yawVector', 'vector.compose'),
      node('setYaw', 'motion.setAngularSpeed', { entity: 'entity/body' }), math('spin', 'divide', { b: 0.35 }), node('spinVector', 'vector.compose'),
      node('setSpin', 'motion.setAngularSpeed', { entity: 'entity/wheel' }),
      node('knuckleVector', 'vector.compose'), node('setKnuckle', 'transform.set', { entity: 'entity/knuckle' }),
    ];
    const edges = [
      edge('fixed', 'out', 'setSpeed', 'in'), edge('setSpeed', 'out', 'setYaw', 'in'),
      edge('setYaw', 'out', 'setSpin', 'in'), edge('setSpin', 'out', 'setKnuckle', 'in'),
      edge('speed', 'speed', 'forwardSpeed', 'a'), edge('forward', 'value', 'throttle', 'a'), edge('reverse', 'value', 'brake', 'a'),
      edge('throttle', 'value', 'pedals', 'a'), edge('brake', 'value', 'pedals', 'b'), edge('forwardSpeed', 'value', 'drag', 'a'),
      edge('pedals', 'value', 'acceleration', 'a'), edge('drag', 'value', 'acceleration', 'b'),
      edge('acceleration', 'value', 'increment', 'a'), edge('fixed', 'delta', 'increment', 'b'),
      edge('forwardSpeed', 'value', 'next', 'a'), edge('increment', 'value', 'next', 'b'),
      edge('next', 'value', 'clamp', 'a'), edge('clamp', 'value', 'command', 'a'), edge('command', 'value', 'setSpeed', 'speed'),
      edge('right', 'value', 'steerAxis', 'a'), edge('left', 'value', 'steerAxis', 'b'), edge('steerAxis', 'value', 'steerAngle', 'a'),
      edge('steerAngle', 'value', 'steerTan', 'a'), edge('steerTan', 'value', 'curve', 'a'),
      edge('curve', 'value', 'yaw', 'a'), edge('forwardSpeed', 'value', 'yaw', 'b'), edge('yaw', 'value', 'yawVector', 'y'),
      edge('yawVector', 'vector', 'setYaw', 'radiansPerSecond'), edge('forwardSpeed', 'value', 'spin', 'a'),
      edge('spin', 'value', 'spinVector', 'x'), edge('spinVector', 'vector', 'setSpin', 'radiansPerSecond'),
      edge('steerAngle', 'value', 'knuckleVector', 'y'), edge('knuckleVector', 'vector', 'setKnuckle', 'rotation'),
    ];
    const objects = new Map([['entity/body', object()], ['entity/wheel', object()], ['entity/knuckle', object()]]);
    const { runtime } = fixture(nodes, edges, objects);
    const advance = seconds => { for (let i = 0; i < Math.round(seconds / partition); i += 1) runtime.update(partition); };
    runtime.activate(); runtime.keyDown('KeyD'); advance(0.5);
    assert.equal(objects.get('entity/body').rotation.y, 0, 'stationary body cannot yaw');
    assert.equal(objects.get('entity/wheel').rotation.x, 0, 'stationary wheel cannot roll');
    runtime.keyDown('KeyW'); advance(2);
    const travelled = objects.get('entity/wheel').rotation.x;
    const turning = objects.get('entity/body').rotation.y;
    assert.ok(travelled > 10 && turning > 0, 'forward travel rolls and turns');
    assert.equal(objects.get('entity/knuckle').rotation.y, 0.35);
    runtime.keyUp('KeyW'); runtime.keyUp('KeyD'); advance(1);
    assert.ok(objects.get('entity/wheel').rotation.x > travelled, 'release coasts');
    assert.equal(objects.get('entity/body').rotation.y, turning, 'steering returns to centre');
    assert.equal(objects.get('entity/knuckle').rotation.y, 0);
    runtime.keyDown('KeyS'); advance(3);
    const beforeReverse = objects.get('entity/wheel').rotation.x;
    advance(0.5);
    assert.ok(objects.get('entity/wheel').rotation.x < beforeReverse, 'reverse rolls backwards');
    assert.deepEqual(runtime.status.diagnostics, []);
    return [...objects.values()].map(value => [value.position.x, value.position.z, value.rotation.x, value.rotation.y]);
  };
  const sixty = run(1 / 60); const thirty = run(1 / 30);
  for (let item = 0; item < sixty.length; item += 1) for (let axis = 0; axis < 4; axis += 1) {
    assert.ok(Math.abs(sixty[item][axis] - thirty[item][axis]) < 1e-9, 'fixed-step result is independent of presentation frame rate');
  }
});
