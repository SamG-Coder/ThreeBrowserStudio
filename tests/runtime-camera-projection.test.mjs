import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cameraPresentationAspect,
  cloneCameraForCapture,
  fitPresentationViewport,
  frameCameraToBounds,
} from '../src/viewport/camera-projection.mjs';

class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.set(x, y, z);
  }

  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  copy(other) {
    return this.set(other.x, other.y, other.z);
  }

  clone() {
    return new Vector3(this.x, this.y, this.z);
  }

  addScaledVector(other, scale) {
    this.x += other.x * scale;
    this.y += other.y * scale;
    this.z += other.z * scale;
    return this;
  }

  lengthSq() {
    return this.x ** 2 + this.y ** 2 + this.z ** 2;
  }

  length() {
    return Math.sqrt(this.lengthSq());
  }

  normalize() {
    const length = this.length();
    if (length > 0) {
      this.x /= length;
      this.y /= length;
      this.z /= length;
    }
    return this;
  }

  toArray() {
    return [this.x, this.y, this.z];
  }
}

class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }

  copy(other) {
    this.x = other.x;
    this.y = other.y;
    this.z = other.z;
    this.w = other.w;
    return this;
  }

  clone() {
    return new Quaternion(this.x, this.y, this.z, this.w);
  }

  toArray() {
    return [this.x, this.y, this.z, this.w];
  }
}

class Camera {
  constructor({ perspective = true } = {}) {
    this.isPerspectiveCamera = perspective;
    this.isOrthographicCamera = !perspective;
    this.position = new Vector3(1, 2, 3);
    this.quaternion = new Quaternion(0.1, 0.2, 0.3, 0.9);
    this.scale = new Vector3(1, 1, 1);
    this.aspect = 1;
    this.fov = 50;
    this.near = 0.1;
    this.far = 500;
    this.left = -2;
    this.right = 2;
    this.top = 2;
    this.bottom = -2;
    this.parent = null;
    this.projectionUpdates = 0;
    this.matrixWorldUpdates = 0;
    this.worldMatrixUpdates = 0;
    this.worldPosition = new Vector3(11, 12, 13);
    this.worldQuaternion = new Quaternion(0, 0.5, 0, 0.866);
    this.worldScale = new Vector3(2, 2, 2);
    this.worldDirection = new Vector3(0, -0.2, -1).normalize();
    this.lookAtTarget = null;
  }

  clone() {
    const clone = new Camera({ perspective: this.isPerspectiveCamera });
    for (const key of ['aspect', 'fov', 'near', 'far', 'left', 'right', 'top', 'bottom']) clone[key] = this[key];
    clone.position.copy(this.position);
    clone.quaternion.copy(this.quaternion);
    clone.scale.copy(this.scale);
    clone.worldPosition.copy(this.worldPosition);
    clone.worldQuaternion.copy(this.worldQuaternion);
    clone.worldScale.copy(this.worldScale);
    clone.worldDirection.copy(this.worldDirection);
    return clone;
  }

  updateWorldMatrix() {
    this.worldMatrixUpdates += 1;
  }

  getWorldPosition(target) {
    return target.copy(this.worldPosition);
  }

  getWorldQuaternion(target) {
    return target.copy(this.worldQuaternion);
  }

  getWorldScale(target) {
    return target.copy(this.worldScale);
  }

  getWorldDirection(target) {
    return target.copy(this.worldDirection);
  }

  updateProjectionMatrix() {
    this.projectionUpdates += 1;
  }

  updateMatrixWorld() {
    this.matrixWorldUpdates += 1;
  }

  lookAt(target) {
    this.lookAtTarget = target.clone();
  }
}

class Bounds {
  constructor(centre, size) {
    this.centre = centre;
    this.size = size;
  }

  isEmpty() {
    return false;
  }

  getCenter(target) {
    return target.copy(this.centre);
  }

  getSize(target) {
    return target.copy(this.size);
  }
}

const THREE = {
  Vector3,
  MathUtils: { degToRad: degrees => degrees * Math.PI / 180 },
};

function cameraState(camera) {
  return {
    position: camera.position.toArray(),
    quaternion: camera.quaternion.toArray(),
    scale: camera.scale.toArray(),
    aspect: camera.aspect,
    fov: camera.fov,
    near: camera.near,
    far: camera.far,
    left: camera.left,
    right: camera.right,
    top: camera.top,
    bottom: camera.bottom,
    parent: camera.parent,
  };
}

test('capture cloning applies aspect and world transform only to the clone', () => {
  const camera = new Camera();
  camera.parent = { id: 'camera-rig' };
  const before = cameraState(camera);

  const capture = cloneCameraForCapture(camera, 21 / 9);

  assert.notEqual(capture, camera);
  assert.equal(capture.parent, null);
  assert.equal(capture.aspect, 21 / 9);
  assert.deepEqual(capture.position.toArray(), camera.worldPosition.toArray());
  assert.deepEqual(capture.quaternion.toArray(), camera.worldQuaternion.toArray());
  assert.deepEqual(capture.scale.toArray(), camera.worldScale.toArray());
  assert.equal(capture.projectionUpdates, 1);
  assert.equal(capture.matrixWorldUpdates, 1);
  assert.deepEqual(cameraState(camera), before);
});

test('authored presentation aspect locks capture projection and fits exact bars', () => {
  const camera = new Camera();
  camera.userData = { studioPresentationAspect: 4 / 3 };

  const capture = cloneCameraForCapture(camera, 16 / 9);
  const viewport = fitPresentationViewport(1920, 1080, cameraPresentationAspect(camera, 16 / 9));

  assert.equal(capture.aspect, 4 / 3);
  assert.deepEqual(viewport, {
    x: 240,
    y: 0,
    width: 1440,
    height: 1080,
    aspect: 4 / 3,
    outerWidth: 1920,
    outerHeight: 1080,
  });
});

test('presentation viewport pillarboxes and letterboxes without fractional output sizes', () => {
  assert.deepEqual(fitPresentationViewport(1000, 1000, 2), {
    x: 0, y: 250, width: 1000, height: 500, aspect: 2, outerWidth: 1000, outerHeight: 1000,
  });
  assert.deepEqual(fitPresentationViewport(1000, 500, 1), {
    x: 250, y: 0, width: 500, height: 500, aspect: 1, outerWidth: 1000, outerHeight: 500,
  });
});

test('orthographic capture aspect changes do not mutate the live frustum', () => {
  const camera = new Camera({ perspective: false });
  camera.left = -3;
  camera.right = 5;
  camera.top = 4;
  camera.bottom = -4;
  const before = cameraState(camera);

  const capture = cloneCameraForCapture(camera, 2);

  assert.equal(capture.left, -7);
  assert.equal(capture.right, 9);
  assert.equal(capture.top, 4);
  assert.equal(capture.bottom, -4);
  assert.deepEqual(cameraState(camera), before);
});

test('framing bounds changes only the capture camera', () => {
  const camera = new Camera();
  camera.parent = { id: 'camera-rig' };
  const before = cameraState(camera);
  const bounds = new Bounds(new Vector3(4, 3, -2), new Vector3(8, 4, 2));

  const framed = frameCameraToBounds(THREE, camera, bounds, {
    aspect: 16 / 9,
    padding: 1.4,
  });

  assert.notEqual(framed, camera);
  assert.equal(framed.aspect, 16 / 9);
  assert.deepEqual(framed.lookAtTarget.toArray(), [4, 3, -2]);
  assert.ok(framed.near >= 0.005);
  assert.ok(framed.far > framed.near);
  assert.notDeepEqual(framed.position.toArray(), before.position);
  assert.deepEqual(cameraState(camera), before);
});
