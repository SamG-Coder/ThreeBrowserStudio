import assert from 'node:assert/strict';
import test from 'node:test';

import { createRigidBodyRuntime } from '../src/runtime/rigid-body-runtime.mjs';

function vector(x = 0, y = 0, z = 0) {
  return { x, y, z, set(nx, ny, nz) { Object.assign(this, { x: nx, y: ny, z: nz }); } };
}

function object(position = [0, 0, 0]) {
  return { position: vector(...position), rotation: vector(), updateMatrix() {}, updateMatrixWorld() {} };
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
