export const LOOK_SPEED = 0.0024;
export const MOVE_SPEED = 3.4;
export const FAST_MULTIPLIER = 2.6;
export const PITCH_LIMIT = Math.PI * 0.5 - 0.04;

export function clampPitch(pitch) {
  return Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, pitch));
}

export function applyLookDelta(yaw, pitch, dx, dy) {
  return {
    yaw: yaw - dx * LOOK_SPEED,
    pitch: clampPitch(pitch - dy * LOOK_SPEED),
  };
}

/** Look basis matching Three.js YXZ applied to (0, 0, -1). */
export function flyBasis(yaw, pitch) {
  const cosPitch = Math.cos(pitch);
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  return {
    forward: {
      x: -sinYaw * cosPitch,
      y: Math.sin(pitch),
      z: -cosYaw * cosPitch,
    },
    right: {
      x: cosYaw,
      y: 0,
      z: -sinYaw,
    },
  };
}

export function flyStep(keys, delta, { yaw, pitch, fast = false } = {}) {
  const step = MOVE_SPEED * (fast ? FAST_MULTIPLIER : 1) * Math.max(0, delta);
  const { forward, right } = flyBasis(yaw, pitch);
  const move = { x: 0, y: 0, z: 0 };
  if (keys.has('KeyW')) { move.x += forward.x * step; move.y += forward.y * step; move.z += forward.z * step; }
  if (keys.has('KeyS')) { move.x -= forward.x * step; move.y -= forward.y * step; move.z -= forward.z * step; }
  if (keys.has('KeyD')) { move.x += right.x * step; move.z += right.z * step; }
  if (keys.has('KeyA')) { move.x -= right.x * step; move.z -= right.z * step; }
  if (keys.has('Space')) move.y += step;
  if (keys.has('Down')) move.y -= step;
  return move;
}
