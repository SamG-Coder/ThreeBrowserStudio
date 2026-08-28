export function updateCameraAspect(camera, aspect) {
  const safeAspect = Math.max(1e-6, Number(aspect) || 1);
  if (camera?.isPerspectiveCamera) {
    camera.aspect = safeAspect;
  } else if (camera?.isOrthographicCamera) {
    const centreX = (camera.left + camera.right) * 0.5;
    const halfHeight = Math.max(1e-6, (camera.top - camera.bottom) * 0.5);
    const halfWidth = halfHeight * safeAspect;
    camera.left = centreX - halfWidth;
    camera.right = centreX + halfWidth;
  }
  camera?.updateProjectionMatrix?.();
  return camera;
}

export function cloneCameraForCapture(camera, aspect) {
  if (!camera?.clone) throw new TypeError('Capture camera must be cloneable.');
  camera.updateWorldMatrix?.(true, false);
  const clone = camera.clone();
  if (camera.parent && camera.getWorldPosition && camera.getWorldQuaternion) {
    camera.getWorldPosition(clone.position);
    camera.getWorldQuaternion(clone.quaternion);
    camera.getWorldScale?.(clone.scale);
  }
  clone.parent = null;
  updateCameraAspect(clone, aspect);
  clone.updateMatrixWorld?.(true);
  return clone;
}

export function frameCameraToBounds(THREE, camera, bounds, { aspect = 16 / 9, padding = 1.25 } = {}) {
  if (!bounds || bounds.isEmpty()) throw new Error('Cannot frame empty bounds.');
  const framed = cloneCameraForCapture(camera, aspect);
  const centre = new THREE.Vector3();
  const size = new THREE.Vector3();
  const direction = new THREE.Vector3();
  bounds.getCenter(centre);
  bounds.getSize(size);
  camera.getWorldDirection(direction);
  if (!Number.isFinite(direction.lengthSq()) || direction.lengthSq() < 1e-8) direction.set(0, -0.2, -1);
  direction.normalize();
  const radius = Math.max(0.01, size.length() * 0.5) * Math.max(1, padding);

  if (framed.isOrthographicCamera) {
    const halfHeight = Math.max(0.01, size.y * 0.5 * padding, size.x * 0.5 * padding / aspect);
    framed.left = -halfHeight * aspect;
    framed.right = halfHeight * aspect;
    framed.top = halfHeight;
    framed.bottom = -halfHeight;
  }
  const halfVerticalFov = framed.isPerspectiveCamera
    ? Math.max(0.01, THREE.MathUtils.degToRad(framed.fov) * 0.5)
    : Math.PI / 6;
  const halfHorizontalFov = Math.atan(Math.tan(halfVerticalFov) * aspect);
  const distance = radius / Math.max(0.01, Math.sin(Math.min(halfVerticalFov, halfHorizontalFov)));
  framed.position.copy(centre).addScaledVector(direction, -distance);
  framed.near = Math.max(0.005, distance - radius * 2);
  framed.far = Math.max(framed.near + 10, distance + radius * 4);
  framed.lookAt(centre);
  framed.updateProjectionMatrix?.();
  framed.updateMatrixWorld?.(true);
  return framed;
}
