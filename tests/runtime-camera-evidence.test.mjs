import assert from 'node:assert/strict';
import test from 'node:test';

import { describeEffectiveCamera } from '../src/viewport/camera-evidence.mjs';

const vector = (...values) => ({
  x: values[0], y: values[1], z: values[2], ...(values.length === 4 ? { w: values[3] } : {}),
  clone() { return vector(...values); },
  toArray() { return [...values]; },
});

test('effective camera evidence preserves shot projection and framing provenance', () => {
  const camera = {
    isPerspectiveCamera: true,
    position: vector(1, 2, 3),
    quaternion: vector(0, 0.1, 0, 0.995),
    scale: vector(1, 1, 1),
    aspect: 4 / 3,
    fov: 43,
    zoom: 1,
    near: 0.1,
    far: 240,
    userData: { studioEntityId: 'entity/camera', studioPresentationAspect: 4 / 3 },
  };

  assert.deepEqual(describeEffectiveCamera(camera, {
    framingMode: 'bounds',
    targetIds: ['entity/subject'],
    targetBounds: { min: [-1, 0, -1], max: [1, 2, 1] },
  }), {
    sourceCameraId: 'entity/camera',
    framingMode: 'bounds',
    transform: {
      position: [1, 2, 3],
      quaternion: [0, 0.1, 0, 0.995],
      scale: [1, 1, 1],
    },
    projection: {
      type: 'perspective',
      aspect: 4 / 3,
      presentationAspect: 4 / 3,
      fov: 43,
      zoom: 1,
      near: 0.1,
      far: 240,
      left: undefined,
      right: undefined,
      top: undefined,
      bottom: undefined,
    },
    targetIds: ['entity/subject'],
    targetBounds: { min: [-1, 0, -1], max: [1, 2, 1] },
  });
});

test('parented cameras report effective world transforms', () => {
  const camera = {
    isOrthographicCamera: true,
    parent: {},
    position: vector(0, 0, 0),
    quaternion: vector(0, 0, 0, 1),
    scale: vector(1, 1, 1),
    left: -2,
    right: 2,
    top: 1,
    bottom: -1,
    near: 0.1,
    far: 10,
    getWorldPosition(target) { target.toArray = () => [4, 5, 6]; },
    getWorldQuaternion(target) { target.toArray = () => [0, 0, 0, 1]; },
    getWorldScale(target) { target.toArray = () => [2, 2, 2]; },
  };
  const result = describeEffectiveCamera(camera);
  assert.deepEqual(result.transform.position, [4, 5, 6]);
  assert.deepEqual(result.transform.scale, [2, 2, 2]);
  assert.equal(result.projection.type, 'orthographic');
});
