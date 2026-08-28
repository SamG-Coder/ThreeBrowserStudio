import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cameraEulerForDirection,
  solveCameraFrame,
} from '../src/core/camera-framing.mjs';

const bounds = Object.freeze({ min: [-4, 0, -2], max: [4, 6, 2] });

test('camera direction lowers to the authored Three.js -Z Euler convention', () => {
  assert.deepEqual(cameraEulerForDirection([0, 0, -1]), [0, -0, 0]);
  const upward = cameraEulerForDirection([0, 1, -1]);
  assert.ok(Math.abs(upward[0] - Math.PI / 4) < 1e-12);
  assert.equal(upward[1], -0);
  assert.throws(() => cameraEulerForDirection([0, 0, 0]), /must not be zero/);
});

test('perspective camera framing is deterministic and persists the shot aspect', () => {
  const first = solveCameraFrame({
    kind: 'perspectiveCamera',
    bounds,
    camera: { fov: 50, near: 0.1, far: 100 },
    transform: { scale: [1, 1, 1] },
    aspect: 4 / 3,
    padding: 1.1,
    direction: [0, 0, -1],
  });
  const repeated = solveCameraFrame({
    kind: 'perspectiveCamera',
    bounds,
    camera: { fov: 50, near: 0.1, far: 100 },
    transform: { scale: [1, 1, 1] },
    aspect: 4 / 3,
    padding: 1.1,
    direction: [0, 0, -1],
  });

  assert.deepEqual(first, repeated);
  assert.deepEqual(first.target.centre, [0, 3, 0]);
  assert.equal(first.camera.aspect, 4 / 3);
  assert.equal(first.camera.presentationAspect, 4 / 3);
  assert.ok(first.transform.position[2] > 0);
  assert.ok(first.camera.near >= 0.005);
  assert.ok(first.camera.far > first.camera.near);
});

test('orthographic framing fits both axes and can leave preview aspect unlocked', () => {
  const framed = solveCameraFrame({
    kind: 'orthographicCamera',
    bounds,
    camera: { near: 0.1, far: 100 },
    aspect: 2,
    padding: 1,
    direction: [1, 0, -1],
    lockPreviewAspect: false,
  });

  assert.equal(framed.camera.height, 6);
  assert.equal(framed.camera.left, -6);
  assert.equal(framed.camera.right, 6);
  assert.equal(Object.hasOwn(framed.camera, 'presentationAspect'), false);
  assert.ok(Math.abs(framed.transform.rotation[1] + Math.PI / 4) < 1e-12);
});

test('camera framing rejects inverted bounds and unsafe shot parameters', () => {
  assert.throws(() => solveCameraFrame({ kind: 'mesh', bounds, aspect: 1 }), /requires a perspectiveCamera/);
  assert.throws(() => solveCameraFrame({ kind: 'perspectiveCamera', bounds: { min: [1, 0, 0], max: [0, 1, 1] }, aspect: 1 }), /must be at least/);
  assert.throws(() => solveCameraFrame({ kind: 'perspectiveCamera', bounds, aspect: 0 }), /aspect must be from/);
  assert.throws(() => solveCameraFrame({ kind: 'perspectiveCamera', bounds, aspect: 1, padding: 0.5 }), /padding must be from/);
});
