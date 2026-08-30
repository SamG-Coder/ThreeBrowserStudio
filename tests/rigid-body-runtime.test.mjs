import assert from 'node:assert/strict';
import test from 'node:test';

import { createRigidBodyRuntime } from '../src/runtime/rigid-body-runtime.mjs';

function vector(x = 0, y = 0, z = 0) {
  return { x, y, z, set(nx, ny, nz) { Object.assign(this, { x: nx, y: ny, z: nz }); } };
}

function object(position = [0, 0, 0], scale = [1, 1, 1]) {
  return { position: vector(...position), rotation: vector(), scale: vector(...scale), userData: {}, parent: null, updateMatrix() {}, updateMatrixWorld() {} };
}

test('dynamic rigid bodies apply mass, gravity, impulses, and resolve box collisions', () => {
  const ball = object([0, 2, 0]);
  const ground = object([0, -0.5, 0]);
  const scene = {
    settings: { physics: { enabled: true, gravity: [0, -9.81, 0] } },
    entities: {
      ball: { id: 'ball', components: { rigidBody: { bodyType: 'dynamic', mass: 2, linearDamping: 0 }, collider: { shape: 'sphere', radius: 0.5, restitution: 0, friction: 0 } } },
      ground: { id: 'ground', components: { rigidBody: { bodyType: 'static', mass: 1 }, collider: { shape: 'box', size: [20, 1, 20], friction: 0 } } },
    },
  };
  const runtime = createRigidBodyRuntime({ scene, objects: new Map([['ball', ball], ['ground', ground]]) });
  assert.equal(runtime.available, true);
  runtime.addImpulse('ball', [2, 0, 0]);
  assert.deepEqual(runtime.getVelocity('ball'), [1, 0, 0]);
  const events = [];
  for (let i = 0; i < 120; i += 1) events.push(...runtime.step(1 / 60));

  assert.ok(ball.position.x > 1.5);
  assert.ok(ball.position.y >= 0.49);
  assert.ok(events.some(event => event.type === 'enter' && event.selfId === 'ball' && event.otherId === 'ground'));
});

test('trigger colliders emit enter and exit without blocking motion', () => {
  const mover = object([-2, 0, 0]);
  const trigger = object([0, 0, 0]);
  const scene = {
    settings: { physics: { enabled: true, gravity: [0, 0, 0] } },
    entities: {
      mover: { id: 'mover', components: { rigidBody: { bodyType: 'kinematic', velocity: [2, 0, 0], linearDamping: 0 }, collider: { shape: 'sphere', radius: 0.5 } } },
      trigger: { id: 'trigger', components: { collider: { shape: 'box', size: [1, 2, 2], isTrigger: true } } },
    },
  };
  const runtime = createRigidBodyRuntime({ scene, objects: new Map([['mover', mover], ['trigger', trigger]]) });
  const events = [];
  for (let i = 0; i < 150; i += 1) events.push(...runtime.step(1 / 60));

  assert.ok(mover.position.x > 2.5);
  assert.ok(events.some(event => event.type === 'enter' && event.selfId === 'mover'));
  assert.ok(events.some(event => event.type === 'exit' && event.selfId === 'mover'));
});

test('scaled terrain and child tyre colliders form one compound rigid body', () => {
  const car = object([4, 0.35, 0]);
  car.userData.studioEntityId = 'car';
  const tyre = object([0, 0, 0]);
  tyre.userData.studioEntityId = 'tyre';
  tyre.parent = car;
  const grass = object([0, -0.5, 0], [10, 1, 10]);
  grass.userData.studioEntityId = 'grass';
  const scene = {
    settings: { physics: { enabled: true, gravity: [0, 0, 0] } },
    entities: {
      car: { id: 'car', components: { rigidBody: { bodyType: 'dynamic', mass: 1, linearDamping: 0 } } },
      tyre: { id: 'tyre', parentId: 'car', components: { collider: { shape: 'sphere', radius: 0.5, friction: 1 } } },
      grass: { id: 'grass', components: { collider: { shape: 'box', size: [1, 1, 1], friction: 1 } } },
    },
  };
  const runtime = createRigidBodyRuntime({ scene, objects: new Map([['car', car], ['tyre', tyre], ['grass', grass]]) });
  const events = runtime.step(1 / 60);

  assert.equal(runtime.status.bodyCount, 1);
  assert.equal(runtime.status.colliderCount, 2);
  assert.ok(car.position.y > 0.35, 'the tyre should resolve by moving its ancestor rigid body');
  assert.ok(events.some(event => event.selfId === 'tyre' && event.otherId === 'grass'));
});

test('dynamic bodies cap acceleration and brake progressively', () => {
  const car = object();
  const scene = {
    settings: { physics: { enabled: true, gravity: [0, 0, 0] } },
    entities: {
      car: { id: 'car', components: { rigidBody: { bodyType: 'dynamic', mass: 1, linearDamping: 0, maxLinearSpeed: 10 } } },
    },
  };
  const runtime = createRigidBodyRuntime({ scene, objects: new Map([['car', car]]) });
  runtime.addForce('car', [0, 0, -100]);
  runtime.step(1);
  assert.equal(runtime.getBodyState('car').speed, 10);

  runtime.applyBrake('car', 4);
  runtime.step(1);
  assert.equal(runtime.getBodyState('car').speed, 6);
  runtime.applyBrake('car', 20);
  runtime.step(1);
  assert.equal(runtime.getBodyState('car').speed, 0);
});

test('compound tyres retain longitudinal drive force while gripping scaled ground', () => {
  const car = object([0, 0.18, 0]);
  car.userData.studioEntityId = 'car';
  const objects = new Map([['car', car]]);
  const entities = {
    car: { id: 'car', components: { rigidBody: { bodyType: 'dynamic', mass: 1350, linearDamping: 0, maxLinearSpeed: 28 } } },
    ground: { id: 'ground', components: { collider: { shape: 'box', size: [9, 0.12, 110], friction: 1, layer: 0, mask: 2 } } },
  };
  const ground = object([0, -0.13, -55], [20, 1, 3]);
  ground.userData.studioEntityId = 'ground';
  objects.set('ground', ground);
  for (const [id, position] of [['fl', [-1.42, 0.5, -1.85]], ['fr', [1.42, 0.5, -1.85]], ['rl', [-1.42, 0.5, 1.85]], ['rr', [1.42, 0.5, 1.85]]]) {
    const tyre = object(position);
    tyre.parent = car;
    tyre.userData.studioEntityId = id;
    objects.set(id, tyre);
    entities[id] = { id, parentId: 'car', components: { collider: { shape: 'sphere', radius: 0.58, friction: 0.55, layer: 1, mask: 1 } } };
  }
  const runtime = createRigidBodyRuntime({ scene: { settings: { physics: { gravity: [0, -9.81, 0] } }, entities }, objects });
  for (let index = 0; index < 90; index += 1) {
    runtime.addForce('car', [0, 0, -60_000]);
    runtime.step(1 / 60);
  }

  assert.ok(runtime.getBodyState('car').velocity[2] < -10);
  assert.ok(runtime.status.activeContactCount > 0);
});

test('compound tyres settle without resting-contact camera jitter', () => {
  const car = object([0, 0.18, 0]);
  car.userData.studioEntityId = 'car';
  const ground = object([0, -0.13, 0], [20, 1, 20]);
  ground.userData.studioEntityId = 'ground';
  const objects = new Map([['car', car], ['ground', ground]]);
  const entities = {
    car: { id: 'car', components: { rigidBody: { bodyType: 'dynamic', mass: 1350, linearDamping: 0.18 } } },
    ground: { id: 'ground', components: { collider: { shape: 'box', size: [9, 0.12, 110], friction: 1, restitution: 0 } } },
  };
  for (const [id, position] of [['fl', [-1.42, 0.5, -1.85]], ['fr', [1.42, 0.5, -1.85]], ['rl', [-1.42, 0.5, 1.85]], ['rr', [1.42, 0.5, 1.85]]]) {
    const tyre = object(position);
    tyre.parent = car;
    tyre.userData.studioEntityId = id;
    objects.set(id, tyre);
    entities[id] = { id, parentId: 'car', components: { collider: { shape: 'sphere', radius: 0.58, friction: 0.55, restitution: 0 } } };
  }
  const runtime = createRigidBodyRuntime({ scene: { settings: { physics: { gravity: [0, -9.81, 0] } }, entities }, objects });
  const settledHeights = [];
  for (let index = 0; index < 360; index += 1) {
    runtime.step(1 / 60);
    if (index >= 300) settledHeights.push(car.position.y);
  }

  assert.ok(Math.max(...settledHeights) - Math.min(...settledHeights) < 0.002);
  assert.ok(Math.abs(runtime.getBodyState('car').velocity[1]) < 0.01);
});

test('vehicle steering turns front wheels and derives yaw from longitudinal speed', () => {
  const car = object();
  car.userData.studioEntityId = 'car';
  const left = object([-1, 0, -2]); left.parent = car; left.userData.studioEntityId = 'front-left';
  const right = object([1, 0, -2]); right.parent = car; right.userData.studioEntityId = 'front-right';
  const scene = {
    settings: { physics: { gravity: [0, 0, 0] } },
    entities: {
      car: { id: 'car', components: { rigidBody: { bodyType: 'dynamic', mass: 1, linearDamping: 0, angularDamping: 0, velocity: [0, 0, -10], wheelBase: 4, trackWidth: 2, wheelRadius: 0.5, steeringWheelIds: ['front-left', 'front-right'], rollingWheelIds: ['front-left', 'front-right'] } } },
      'front-left': { id: 'front-left', parentId: 'car', components: {} },
      'front-right': { id: 'front-right', parentId: 'car', components: {} },
    },
  };
  const runtime = createRigidBodyRuntime({ scene, objects: new Map([['car', car], ['front-left', left], ['front-right', right]]) });
  runtime.setSteering('car', 0.4);
  runtime.step(0.1);
  assert.ok(left.rotation.y > 0 && left.rotation.y < 0.4, 'steering should build progressively');
  assert.ok(left.rotation.y > right.rotation.y, 'inside wheel should use the sharper Ackermann angle');
  assert.ok(Math.abs(left.rotation.x) > 0, 'wheel pivots should roll with longitudinal travel');
  assert.ok(Math.abs(left.rotation.x) < Math.abs(right.rotation.x), 'inside wheel should roll more slowly around a turn');
  assert.ok(runtime.getBodyState('car').angularVelocity[1] > 0);
  const forwardSpeed = Math.abs(runtime.getBodyState('car').forwardSpeed);
  const lateralSpeed = Math.abs(runtime.getBodyState('car').lateralSpeed);
  assert.ok(lateralSpeed < forwardSpeed * 0.01, 'tyre grip should keep velocity aligned with the car');

  runtime.setVelocity('car', [0, 0, 10]);
  runtime.step(0.1);
  assert.ok(runtime.getBodyState('car').angularVelocity[1] < 0, 'reverse should invert the yaw response');

  runtime.addForce('car', [0, 0, -1]);
  runtime.reset();
  assert.equal(left.rotation.y, 0);
  assert.equal(right.rotation.y, 0);
  assert.equal(left.rotation.x, 0);
  assert.equal(right.rotation.x, 0);
  assert.equal(runtime.getBodyState('car').steeringAngle, 0);
  assert.equal(runtime.getBodyState('car').forceApplicationCount, 0);
});
