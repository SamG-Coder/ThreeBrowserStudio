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
      settings: { controller: { enabled: true, entityId: 'car/root', activationKey: 'Enter', capture: { keyboard: true } } },
      entities: [{ id: 'car/root', kind: 'group', components: { logic: { graphIds: ['blueprint/drive'] } } }],
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
