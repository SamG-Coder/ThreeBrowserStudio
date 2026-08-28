function finiteArray(value, length) {
  if (value?.toArray) {
    const result = value.toArray();
    if (Array.isArray(result) && result.length >= length && result.slice(0, length).every(Number.isFinite)) {
      return result.slice(0, length);
    }
  }
  const keys = length === 4 ? ['x', 'y', 'z', 'w'] : ['x', 'y', 'z'];
  const result = keys.map(key => Number(value?.[key]));
  return result.every(Number.isFinite) ? result : undefined;
}

function finiteField(value) {
  return Number.isFinite(value) ? value : undefined;
}

/** Compact, project-safe metadata describing the camera that produced evidence. */
export function describeEffectiveCamera(camera, {
  sourceCameraId,
  framingMode = 'authored',
  targetIds,
  targetBounds,
} = {}) {
  camera?.updateWorldMatrix?.(true, false);
  const positionTarget = camera?.position?.clone?.() ?? camera?.position;
  const quaternionTarget = camera?.quaternion?.clone?.() ?? camera?.quaternion;
  const scaleTarget = camera?.scale?.clone?.() ?? camera?.scale;
  if (camera?.parent) {
    camera.getWorldPosition?.(positionTarget);
    camera.getWorldQuaternion?.(quaternionTarget);
    camera.getWorldScale?.(scaleTarget);
  }
  const perspective = camera?.isPerspectiveCamera === true;
  const orthographic = camera?.isOrthographicCamera === true;
  return {
    sourceCameraId: sourceCameraId ?? camera?.userData?.studioEntityId ?? 'review-camera',
    framingMode,
    transform: {
      position: finiteArray(positionTarget, 3),
      quaternion: finiteArray(quaternionTarget, 4),
      scale: finiteArray(scaleTarget, 3),
    },
    projection: {
      type: perspective ? 'perspective' : (orthographic ? 'orthographic' : 'camera'),
      aspect: finiteField(camera?.aspect),
      presentationAspect: finiteField(camera?.userData?.studioPresentationAspect),
      fov: finiteField(camera?.fov),
      zoom: finiteField(camera?.zoom),
      near: finiteField(camera?.near),
      far: finiteField(camera?.far),
      left: finiteField(camera?.left),
      right: finiteField(camera?.right),
      top: finiteField(camera?.top),
      bottom: finiteField(camera?.bottom),
    },
    ...(Array.isArray(targetIds) && targetIds.length ? { targetIds: [...targetIds] } : {}),
    ...(targetBounds ? { targetBounds: structuredClone(targetBounds) } : {}),
  };
}
