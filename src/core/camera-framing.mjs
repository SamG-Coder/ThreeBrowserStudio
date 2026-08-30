const EPSILON = 1e-8;

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite.`);
  return number;
}

function finiteVec3(value, label) {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${label} must contain three numbers.`);
  return value.map((component, index) => finiteNumber(component, `${label}[${index}]`));
}

function normalizeDirection(value) {
  const direction = finiteVec3(value, 'direction');
  const length = Math.hypot(...direction);
  if (length < EPSILON) throw new TypeError('direction must not be zero.');
  return direction.map(component => component / length);
}

function normalizedBounds(bounds) {
  const minimum = finiteVec3(bounds?.min, 'bounds.min');
  const maximum = finiteVec3(bounds?.max, 'bounds.max');
  for (let index = 0; index < 3; index += 1) {
    if (maximum[index] < minimum[index]) throw new TypeError(`bounds.max[${index}] must be at least bounds.min[${index}].`);
  }
  return { min: minimum, max: maximum };
}

function cross(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function normalizedCross(left, right) {
  const value = cross(left, right);
  const length = Math.hypot(...value);
  return length < EPSILON ? null : value.map(component => component / length);
}

/**
 * Euler XYZ rotation for a Three.js camera whose authored forward axis is -Z.
 *
 * A yaw/pitch shortcut only works while the camera faces the -Z hemisphere:
 * Three.js XYZ Euler rotations invert the apparent pitch after yaw crosses 90
 * degrees. Build a world-up look basis and extract XYZ Euler angles instead so
 * every authored direction, including a camera placed behind the subject,
 * lowers to the exact forward vector without rolling the shot upside down.
 */
export function cameraEulerForDirection(value) {
  const forward = normalizeDirection(value);
  const backward = forward.map(component => -component);
  const preferredUp = Math.abs(backward[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];
  const right = normalizedCross(preferredUp, backward) ?? [1, 0, 0];
  const up = cross(backward, right);

  // Matrix columns are the camera's world-space right, up, and backward axes.
  const m11 = right[0];
  const m12 = up[0];
  const m13 = backward[0];
  const m22 = up[1];
  const m23 = backward[1];
  const m32 = up[2];
  const m33 = backward[2];

  const y = Math.asin(Math.max(-1, Math.min(1, m13)));
  if (Math.abs(m13) < 0.9999999) {
    const roll = Math.atan2(-m12, m11);
    return [Math.atan2(-m23, m33), y, Object.is(roll, -0) ? 0 : roll];
  }
  return [Math.atan2(m32, m22), y, 0];
}

/**
 * Solves a deterministic authored camera pose from exact document-space bounds.
 * The result is plain JSON so it can be committed, diffed, undone, and rebuilt
 * without retaining Three.js runtime objects.
 */
export function solveCameraFrame({
  kind,
  bounds,
  transform = {},
  camera = {},
  aspect,
  padding = 1.25,
  distanceScale = 1,
  direction = [0, -0.2, -1],
  minHeight,
  lockPreviewAspect = true,
} = {}) {
  if (!['perspectiveCamera', 'orthographicCamera'].includes(kind)) {
    throw new TypeError('camera.frame requires a perspectiveCamera or orthographicCamera.');
  }
  const normalized = normalizedBounds(bounds);
  const safeAspect = finiteNumber(aspect, 'aspect');
  if (safeAspect < 0.1 || safeAspect > 10) throw new RangeError('aspect must be from 0.1 to 10.');
  const safePadding = finiteNumber(padding, 'padding');
  if (safePadding < 1 || safePadding > 10) throw new RangeError('padding must be from 1 to 10.');
  const safeDistanceScale = finiteNumber(distanceScale ?? 1, 'distanceScale');
  if (safeDistanceScale < 0.1 || safeDistanceScale > 10) throw new RangeError('distanceScale must be from 0.1 to 10.');
  const viewDirection = normalizeDirection(direction);
  const centre = normalized.min.map((value, index) => (value + normalized.max[index]) * 0.5);
  const size = normalized.min.map((value, index) => normalized.max[index] - value);
  const radius = Math.max(0.01, Math.hypot(...size) * 0.5) * safePadding;

  let distance;
  const framedCamera = { ...camera };
  if (kind === 'perspectiveCamera') {
    const fov = Number.isFinite(camera.fov) ? camera.fov : 46;
    if (fov <= 0 || fov >= 180) throw new RangeError('Perspective camera fov must be greater than 0 and less than 180 degrees.');
    const halfVerticalFov = Math.max(0.01, fov * Math.PI / 360);
    const halfHorizontalFov = Math.atan(Math.tan(halfVerticalFov) * safeAspect);
    distance = radius / Math.max(0.01, Math.sin(Math.min(halfVerticalFov, halfHorizontalFov)));
    framedCamera.aspect = safeAspect;
  } else {
    const halfHeight = Math.max(0.01, size[1] * 0.5 * safePadding, size[0] * 0.5 * safePadding / safeAspect);
    distance = Math.max(1, radius * 2);
    framedCamera.height = halfHeight * 2;
    framedCamera.left = -halfHeight * safeAspect;
    framedCamera.right = halfHeight * safeAspect;
    framedCamera.top = halfHeight;
    framedCamera.bottom = -halfHeight;
  }
  distance *= safeDistanceScale;

  const position = centre.map((value, index) => value - viewDirection[index] * distance);
  if (minHeight !== undefined) position[1] = Math.max(position[1], finiteNumber(minHeight, 'minHeight'));
  const actualDistance = Math.hypot(...centre.map((value, index) => value - position[index]));
  const actualDirection = normalizeDirection(centre.map((value, index) => value - position[index]));
  framedCamera.near = Math.max(0.005, actualDistance - radius * 2);
  framedCamera.far = Math.max(framedCamera.near + 10, actualDistance + radius * 4);
  if (lockPreviewAspect) framedCamera.presentationAspect = safeAspect;
  else delete framedCamera.presentationAspect;

  return {
    transform: {
      position,
      rotation: cameraEulerForDirection(actualDirection),
      scale: Array.isArray(transform.scale) ? [...transform.scale] : [1, 1, 1],
    },
    camera: framedCamera,
    target: { bounds: normalized, centre },
    framing: {
      fit: 'contain',
      aspect: safeAspect,
      padding: safePadding,
      direction: actualDirection,
      distance: actualDistance,
      radius,
      lockPreviewAspect: Boolean(lockPreviewAspect),
    },
  };
}
