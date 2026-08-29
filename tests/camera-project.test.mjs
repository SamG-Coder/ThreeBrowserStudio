import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProjectVisibility, createSceneDocument } from '../src/core/index.mjs';

function sceneWithCamera(cameraTransform = { position: [0, 0, 2], rotation: [0, 0, 0], scale: [1, 1, 1] }) {
  return createSceneDocument({
    id: 'scene/main',
    settings: { activeCameraId: 'entity/camera' },
    entities: [
      {
        id: 'entity/camera',
        kind: 'perspectiveCamera',
        transform: cameraTransform,
        components: { camera: { fov: 46, near: 0.05, far: 2000 } },
      },
      {
        id: 'entity/front',
        kind: 'mesh',
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      {
        id: 'entity/behind',
        kind: 'mesh',
        transform: { position: [0, 0, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      {
        id: 'entity/parent',
        kind: 'group',
        transform: { position: [3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        children: ['entity/child'],
      },
      {
        id: 'entity/child',
        kind: 'mesh',
        parentId: 'entity/parent',
        transform: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
    ],
  });
}

test('projectVisibility puts a camera-forward origin on screen and a rear point behind the camera', () => {
  const visibility = buildProjectVisibility(sceneWithCamera(), {
    entityIds: ['entity/front', 'entity/behind'],
    points: [{ name: 'wide', world: [20, 0, 0] }],
    width: 1280,
    height: 720,
  });
  assert.equal(visibility.cameraId, 'entity/camera');
  const front = visibility.points.find(point => point.entityId === 'entity/front');
  const behind = visibility.points.find(point => point.entityId === 'entity/behind');
  const wide = visibility.points.find(point => point.name === 'wide');
  assert.equal(front.visibility, 'on-screen');
  assert.deepEqual(front.screen, [640, 360]);
  assert.equal(behind.visibility, 'behind-camera');
  assert.equal(behind.onScreen, false);
  assert.equal(wide.visibility, 'off-screen');
  assert.equal(front.occlusion, 'unknown');
});

test('projectVisibility uses authored parent world positions', () => {
  const visibility = buildProjectVisibility(sceneWithCamera(), {
    entityIds: ['entity/child'],
    width: 1280,
    height: 720,
  });
  assert.deepEqual(visibility.points[0].world, [4, 0, 0]);
});

test('projectVisibility rejects a missing camera or empty request', () => {
  const scene = createSceneDocument({ id: 'scene/empty' });
  assert.throws(
    () => buildProjectVisibility(scene, { entityIds: ['entity/front'] }),
    error => error.code === 'camera_not_found',
  );
  assert.throws(
    () => buildProjectVisibility(sceneWithCamera(), {}),
    error => error.code === 'invalid_projection',
  );
});
