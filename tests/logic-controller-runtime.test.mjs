import assert from 'node:assert/strict';
import test from 'node:test';

import { validateProjectDocument, createProjectDocument } from '../src/core/documents.mjs';
import { validateGraph } from '../src/graphs/validator.mjs';
import { createLogicControllerRuntime } from '../src/runtime/logic-controller-runtime.mjs';

function vector(x = 0, y = 0, z = 0) {
  return { x, y, z, set(nx, ny, nz) { Object.assign(this, { x: nx, y: ny, z: nz }); }, toArray() { return [this.x, this.y, this.z]; } };
}

function object() {
  return {
    position: vector(), rotation: vector(), scale: vector(1, 1, 1), visible: true,
    updateMatrix() {}, updateMatrixWorld() {},
    rotateX(value) { this.rotation.x += value; }, rotateY(value) { this.rotation.y += value; }, rotateZ(value) { this.rotation.z += value; },
    translateX(value) { this.position.x += value; }, translateY(value) { this.position.y += value; }, translateZ(value) { this.position.z += value; },
    lookAt(...value) { this.lastLookAt = value; },
  };
}

function driveGraph() {
  const constant = (id, value) => ({ id, type: 'value.constant', params: { valueType: 'float', value } });
  return {
    formatVersion: 1,
    id: 'blueprint/drive',
    domain: 'blueprint',
    nodes: [
      { id: 'self', type: 'entity.self', params: {} },
      constant('forward', 12), constant('stop', 0), constant('left', 1.5), constant('no-turn', 0),
      { id: 'w-down', type: 'event.onKeyPressed', params: { key: 'KeyW' } },
      { id: 'w-up', type: 'event.onKeyUp', params: { key: 'KeyW' } },
      { id: 'a-down', type: 'event.onKeyPressed', params: { key: 'KeyA' } },
      { id: 'a-up', type: 'event.onKeyUp', params: { key: 'KeyA' } },
      { id: 'go', type: 'motion.setSpeed', params: {} },
      { id: 'halt', type: 'motion.setSpeed', params: {} },
      { id: 'turn', type: 'motion.setAngularSpeed', params: {}, inputs: { radiansPerSecond: [0, 1.5, 0] } },
      { id: 'straight', type: 'motion.setAngularSpeed', params: {}, inputs: { radiansPerSecond: [0, 0, 0] } },
    ],
    edges: [
      ['w-down', 'out', 'go', 'in'], ['self', 'entity', 'go', 'entity'], ['forward', 'value', 'go', 'speed'],
      ['w-up', 'out', 'halt', 'in'], ['self', 'entity', 'halt', 'entity'], ['stop', 'value', 'halt', 'speed'],
      ['a-down', 'out', 'turn', 'in'], ['self', 'entity', 'turn', 'entity'],
      ['a-up', 'out', 'straight', 'in'], ['self', 'entity', 'straight', 'entity'],
    ].map(([fromNode, fromPort, toNode, toPort]) => ({ from: { nodeId: fromNode, port: fromPort }, to: { nodeId: toNode, port: toPort } })),
    outputs: {},
  };
}

test('controller settings and attached blueprint graphs validate as canonical scene data', () => {
  const graph = driveGraph();
  assert.equal(validateGraph(graph).valid, true, JSON.stringify(validateGraph(graph).errors));
  const project = createProjectDocument({
    projectId: 'project/controller',
    scenes: [{
      id: 'scene/main',
      settings: {
        controller: { enabled: true, entityId: 'car/root', activationKey: 'Enter', capture: { keyboard: true } },
        physics: { enabled: true, gravity: [0, -9.81, 0] },
      },
      entities: [{
        id: 'car/root', kind: 'group', components: {
          logic: { graphIds: ['blueprint/drive'] },
          rigidBody: { bodyType: 'dynamic', mass: 1200, gravityScale: 1, linearDamping: 0.1, angularDamping: 0.2 },
          collider: { shape: 'box', size: [3, 1.2, 6], friction: 0.8, restitution: 0.1 },
        },
      }],
    }],
    resources: { graphs: [{ id: 'blueprint/drive', kind: 'graph', graph }] },
  });
  const validation = validateProjectDocument(project);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  assert.deepEqual(validation.diagnostics, []);
});

test('GameMaker-style key events drive a runtime-only object and Escape restoration is exact', () => {
  const car = object();
  const graph = driveGraph();
  const scene = {
    settings: { controller: { enabled: true, entityId: 'car/root', activationKey: 'Enter', restoreOnExit: true, capture: { keyboard: true, hideHud: true, hideCursor: true } } },
    entities: { 'car/root': { id: 'car/root', components: { logic: { graphIds: ['blueprint/drive'] } } } },
  };
  const runtime = createLogicControllerRuntime({
    project: { resources: { graphs: { 'blueprint/drive': { graph } } } },
    scene,
    objects: new Map([['car/root', car]]),
  });
  assert.equal(runtime.available, true);
  assert.equal(runtime.activate(), true);
  runtime.keyDown('KeyW');
  runtime.update(1 / 60);
  assert.ok(car.position.z < 0);
  runtime.keyDown('KeyA');
  runtime.update(1 / 60);
  assert.ok(car.rotation.y > 0);
  runtime.keyUp('KeyW');
  const stoppedAt = car.position.z;
  runtime.update(1 / 60);
  assert.equal(car.position.z, stoppedAt);
  assert.equal(runtime.stop(), true);
  assert.deepEqual(car.position.toArray(), [0, 0, 0]);
  assert.deepEqual(car.rotation.toArray(), [0, 0, 0]);
  assert.equal(runtime.status.active, false);
});

test('restoration preserves nested Three.js Euler rotations with an order component', () => {
  const car = object();
  const wheel = object();
  wheel.rotation.set(0, Math.PI / 2, Math.PI / 2);
  wheel.rotation.toArray = function toArray() { return [this.x, this.y, this.z, 'XYZ']; };
  const originalRotation = [wheel.rotation.x, wheel.rotation.y, wheel.rotation.z];
  const graph = driveGraph();
  const scene = {
    settings: { controller: { enabled: true, entityId: 'car/root', restoreOnExit: true } },
    entities: { 'car/root': { id: 'car/root', components: { logic: { graphIds: ['blueprint/drive'] } } } },
  };
  const runtime = createLogicControllerRuntime({
    project: { resources: { graphs: { 'blueprint/drive': { graph } } } },
    scene,
    objects: new Map([['car/root', car], ['car/wheel', wheel]]),
  });

  runtime.activate();
  wheel.rotation.set(0, 0, 0);
  runtime.stop();

  assert.deepEqual([wheel.rotation.x, wheel.rotation.y, wheel.rotation.z], originalRotation);
});

test('controller graphs can activate and smoothly follow with an authored camera component', () => {
  const graph = {
    formatVersion: 1, id: 'blueprint/camera-follow', domain: 'blueprint', outputs: {},
    nodes: [
      { id: 'activate', type: 'event.onActivate', params: {} },
      { id: 'camera', type: 'entity.reference', params: { entityId: 'camera/player' } },
      { id: 'self', type: 'entity.self', params: {} },
      { id: 'follow', type: 'camera.followEntity', params: { space: 'local' }, inputs: { offset: [0, 3, 6], smoothing: 0 } },
      { id: 'active', type: 'camera.setActive', params: {} },
    ],
    edges: [
      ['activate', 'out', 'follow', 'in'], ['camera', 'entity', 'follow', 'camera'], ['self', 'entity', 'follow', 'target'],
      ['follow', 'out', 'active', 'in'], ['camera', 'entity', 'active', 'camera'],
    ].map(([fromNode, fromPort, toNode, toPort]) => ({ from: { nodeId: fromNode, port: fromPort }, to: { nodeId: toNode, port: toPort } })),
  };
  assert.equal(validateGraph(graph).valid, true, JSON.stringify(validateGraph(graph).errors));
  const player = object();
  player.position.set(4, 1, -2);
  player.rotation.y = Math.PI / 2;
  const camera = object();
  camera.isPerspectiveCamera = true;
  let activeCamera = null;
  const runtime = createLogicControllerRuntime({
    project: { resources: { graphs: { 'blueprint/camera-follow': { graph } } } },
    scene: {
      settings: { controller: { enabled: true, entityId: 'player/root' } },
      entities: {
        'player/root': { id: 'player/root', components: { logic: { graphIds: ['blueprint/camera-follow'] } } },
        'camera/player': { id: 'camera/player', components: { camera: { fov: 55 } } },
      },
    },
    objects: new Map([['player/root', player], ['camera/player', camera]]),
    setActiveCamera(id) { activeCamera = id; return true; },
  });

  runtime.activate();
  runtime.update(1 / 60);

  assert.equal(activeCamera, 'camera/player');
  assert.ok(Math.abs(camera.position.x - 10) < 1e-9);
  assert.ok(Math.abs(camera.position.y - 4) < 1e-9);
  assert.ok(Math.abs(camera.position.z + 2) < 1e-9);
  assert.deepEqual(camera.lastLookAt, [4, 1, -2]);
});

test('local rigid-body force follows Self yaw for vehicle controls', () => {
  const graph = {
    formatVersion: 1, id: 'blueprint/local-force', domain: 'blueprint', outputs: {},
    nodes: [
      { id: 'step', type: 'event.onFixedUpdate', params: {} },
      { id: 'self', type: 'entity.self', params: {} },
      { id: 'force', type: 'physics.addForce', params: { space: 'local' }, inputs: { force: [0, 0, -60] } },
    ],
    edges: [
      ['step', 'out', 'force', 'in'], ['self', 'entity', 'force', 'entity'],
    ].map(([fromNode, fromPort, toNode, toPort]) => ({ from: { nodeId: fromNode, port: fromPort }, to: { nodeId: toNode, port: toPort } })),
  };
  assert.equal(validateGraph(graph).valid, true, JSON.stringify(validateGraph(graph).errors));
  const car = object(); car.rotation.y = Math.PI / 2;
  const runtime = createLogicControllerRuntime({
    project: { resources: { graphs: { 'blueprint/local-force': { graph } } } },
    scene: {
      settings: { controller: { enabled: true, entityId: 'car' }, physics: { gravity: [0, 0, 0] } },
      entities: { car: { id: 'car', components: { logic: { graphIds: ['blueprint/local-force'] }, rigidBody: { bodyType: 'dynamic', mass: 1, linearDamping: 0 } } } },
    },
    objects: new Map([['car', car]]),
  });
  runtime.activate(); runtime.update(1 / 60);
  assert.ok(car.position.x < 0);
  assert.ok(Math.abs(car.position.z) < 1e-9);
});

test('Self can reference its rigidBody and react to collision events', () => {
  const graph = {
    formatVersion: 1, id: 'blueprint/collision-response', domain: 'blueprint', outputs: {},
    nodes: [
      { id: 'collision', type: 'event.onCollisionEnter', params: {} },
      { id: 'self', type: 'entity.self', params: {} },
      { id: 'impulse', type: 'physics.addImpulse', params: {}, inputs: { impulse: [2, 0, 0] } },
    ],
    edges: [
      ['collision', 'out', 'impulse', 'in'], ['self', 'entity', 'impulse', 'entity'],
    ].map(([fromNode, fromPort, toNode, toPort]) => ({ from: { nodeId: fromNode, port: fromPort }, to: { nodeId: toNode, port: toPort } })),
  };
  assert.equal(validateGraph(graph).valid, true, JSON.stringify(validateGraph(graph).errors));
  const ball = object(); ball.position.y = 1;
  const ground = object(); ground.position.y = -0.5;
  const runtime = createLogicControllerRuntime({
    project: { resources: { graphs: { 'blueprint/collision-response': { graph } } } },
    scene: {
      settings: { controller: { enabled: true, entityId: 'ball' }, physics: { gravity: [0, -9.81, 0] } },
      entities: {
        ball: { id: 'ball', components: { logic: { graphIds: ['blueprint/collision-response'] }, rigidBody: { bodyType: 'dynamic', mass: 1, linearDamping: 0 }, collider: { shape: 'sphere', radius: 0.5, friction: 0 } } },
        ground: { id: 'ground', components: { collider: { shape: 'box', size: [10, 1, 10], friction: 0 } } },
      },
    },
    objects: new Map([['ball', ball], ['ground', ground]]),
  });
  runtime.activate();
  for (let i = 0; i < 90; i += 1) runtime.update(1 / 60);
  assert.ok(ball.position.x > 1);
});
