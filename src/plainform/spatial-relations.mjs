import { cameraEulerForDirection } from '../core/camera-framing.mjs';
import {
  composeTransformMatrix,
  decomposeTransformMatrix,
  entityWorldMatrix,
  entityWorldPosition,
  invertTransformMatrix,
  multiplyTransformMatrices,
  transformPointByMatrix,
} from '../core/transform-math.mjs';

const AXES = Object.freeze({
  right: [1, 0, 0], left: [-1, 0, 0],
  up: [0, 1, 0], down: [0, -1, 0],
  forward: [0, 0, -1], backward: [0, 0, 1],
});

function normalized(value, fail, label) {
  const length = Math.hypot(...value);
  if (length < 1e-9) fail('plainform_zero_direction', `${label} does not define a direction.`);
  return value.map(component => component / length);
}

/** Deterministic spatial calculations over canonical entity transforms. */
export class PlainformSpatialResolver {
  constructor({ fail }) {
    this.fail = fail;
    this.worldMatrices = new Map();
  }

  worldMatrix(record, transform = record.entity.transform) {
    const isCanonical = record.scene.entities[record.entity.id]
      && transform === record.entity.transform;
    if (isCanonical) return entityWorldMatrix(record.scene, record.entity.id, this.worldMatrices);
    const local = composeTransformMatrix(transform);
    return record.entity.parentId
      ? multiplyTransformMatrices(entityWorldMatrix(record.scene, record.entity.parentId, this.worldMatrices), local)
      : local;
  }

  position(record) {
    if (record.scene.entities[record.entity.id]) return entityWorldPosition(record.scene, record.entity.id, this.worldMatrices);
    return this.worldMatrix(record).slice(12, 15);
  }

  distance(left, right) {
    const a = this.position(left);
    const b = this.position(right);
    return Math.hypot(...a.map((value, axis) => value - b[axis]));
  }

  referenceInParentSpace(record, reference) {
    const world = this.position(reference);
    if (!record.entity.parentId) return world;
    const parentWorld = entityWorldMatrix(record.scene, record.entity.parentId, this.worldMatrices);
    return transformPointByMatrix(invertTransformMatrix(parentWorld), world);
  }

  relationDirection(record, reference, relation, transform = record.entity.transform) {
    const target = this.referenceInParentSpace(record, reference);
    const origin = transform.position;
    const toward = target.map((value, axis) => value - origin[axis]);
    const direction = relation === 'away' ? toward.map(value => -value) : toward;
    return normalized(direction, this.fail, `${relation} ${reference.entity.id}`);
  }

  facingRotation(record, reference, relation, transform = record.entity.transform) {
    return cameraEulerForDirection(this.relationDirection(record, reference, relation, transform));
  }

  rotationAligningAxis(axis, direction) {
    const from = normalized(axis, this.fail, 'growth axis');
    const to = normalized(direction, this.fail, 'target direction');
    const cross = [
      from[1] * to[2] - from[2] * to[1],
      from[2] * to[0] - from[0] * to[2],
      from[0] * to[1] - from[1] * to[0],
    ];
    let quaternion = [...cross, 1 + from.reduce((sum, value, index) => sum + value * to[index], 0)];
    if (Math.hypot(...quaternion) < 1e-8) {
      const perpendicular = Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      quaternion = [
        from[1] * perpendicular[2] - from[2] * perpendicular[1],
        from[2] * perpendicular[0] - from[0] * perpendicular[2],
        from[0] * perpendicular[1] - from[1] * perpendicular[0],
        0,
      ];
    }
    const length = Math.hypot(...quaternion);
    const [x, y, z, w] = quaternion.map(value => value / length);
    const matrix = [
      1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
      2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
      2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
      0, 0, 0, 1,
    ];
    return decomposeTransformMatrix(matrix).rotation;
  }

  localOffset(transform, directionName, distance) {
    const basis = AXES[directionName];
    if (!basis) this.fail('plainform_unknown_direction', `“${directionName}” is not a supported local direction.`);
    const matrix = composeTransformMatrix({ ...transform, position: [0, 0, 0], scale: [1, 1, 1] });
    const vector = [
      (matrix[0] * basis[0]) + (matrix[4] * basis[1]) + (matrix[8] * basis[2]),
      (matrix[1] * basis[0]) + (matrix[5] * basis[1]) + (matrix[9] * basis[2]),
      (matrix[2] * basis[0]) + (matrix[6] * basis[1]) + (matrix[10] * basis[2]),
    ];
    return normalized(vector, this.fail, directionName).map(component => component * distance);
  }
}
