import { CAMERA_KINDS } from './constants.mjs';
import { StudioError } from './errors.mjs';
import {
  entityWorldMatrix,
  entityWorldPosition,
  invertTransformMatrix,
  transformPointByMatrix,
} from './transform-math.mjs';

export const PROJECT_VISIBILITY_LIMITS = Object.freeze({
  maxPoints: 32,
  maxEntities: 32,
});

function finiteNumber(value, fallback, label, { min, max } = {}) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value)) {
    throw new StudioError('invalid_projection', `${label} must be a finite number.`);
  }
  if (min !== undefined && value < min) {
    throw new StudioError('invalid_projection', `${label} must be >= ${min}.`);
  }
  if (max !== undefined && value > max) {
    throw new StudioError('invalid_projection', `${label} must be <= ${max}.`);
  }
  return value;
}

function cameraProjectionFromEntity(entity, width, height) {
  const values = entity.components?.camera ?? {};
  const aspect = finiteNumber(values.aspect, width / height, 'camera.aspect', { min: 0.1, max: 10 });
  const near = finiteNumber(values.near, 0.05, 'camera.near', { min: 1e-6 });
  const far = finiteNumber(values.far, 2000, 'camera.far', { min: near });
  if (entity.kind === 'orthographicCamera') {
    const cameraHeight = finiteNumber(values.height, 10, 'camera.height', { min: 1e-6 });
    const halfHeight = cameraHeight * 0.5;
    const halfWidth = halfHeight * aspect;
    return {
      type: 'orthographic',
      aspect,
      near,
      far,
      zoom: finiteNumber(values.zoom, 1, 'camera.zoom', { min: 1e-6 }),
      left: finiteNumber(values.left, -halfWidth, 'camera.left'),
      right: finiteNumber(values.right, halfWidth, 'camera.right'),
      top: finiteNumber(values.top, halfHeight, 'camera.top'),
      bottom: finiteNumber(values.bottom, -halfHeight, 'camera.bottom'),
    };
  }
  return {
    type: 'perspective',
    aspect,
    near,
    far,
    fov: finiteNumber(values.fov, 46, 'camera.fov', { min: 1, max: 179 }),
    zoom: finiteNumber(values.zoom, 1, 'camera.zoom', { min: 1e-6 }),
  };
}

function projectViewPoint(view, projection) {
  const viewX = view[0];
  const viewY = view[1];
  const viewZ = -view[2];
  if (viewZ <= 0) {
    return { ndc: null, depth: viewZ, behindCamera: true };
  }
  let ndcX;
  let ndcY;
  if (projection.type === 'orthographic') {
    const zoom = projection.zoom ?? 1;
    const width = (projection.right - projection.left) / zoom;
    const height = (projection.top - projection.bottom) / zoom;
    ndcX = ((viewX - projection.left / zoom) / width) * 2 - 1;
    ndcY = ((viewY - projection.bottom / zoom) / height) * 2 - 1;
  } else {
    const tan = Math.tan((projection.fov * Math.PI / 180) / 2) / (projection.zoom ?? 1);
    ndcX = viewX / (viewZ * tan * projection.aspect);
    ndcY = viewY / (viewZ * tan);
  }
  return {
    ndc: [ndcX, ndcY],
    depth: viewZ,
    behindCamera: false,
  };
}

function visibilityOf(projected, projection) {
  if (projected.behindCamera) return 'behind-camera';
  if (projected.depth < projection.near || projected.depth > projection.far) return 'outside-clip';
  const [ndcX, ndcY] = projected.ndc;
  if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) return 'off-screen';
  return 'on-screen';
}

export function projectWorldPoint(world, cameraWorldMatrix, projection, width, height) {
  const view = transformPointByMatrix(invertTransformMatrix(cameraWorldMatrix), world);
  const projected = projectViewPoint(view, projection);
  const visibility = visibilityOf(projected, projection);
  const screen = projected.ndc
    ? [
      (projected.ndc[0] * 0.5 + 0.5) * width,
      (1 - (projected.ndc[1] * 0.5 + 0.5)) * height,
    ]
    : null;
  return {
    world: [...world],
    screen: screen ? [Math.round(screen[0]), Math.round(screen[1])] : null,
    ndc: projected.ndc,
    depth: projected.depth,
    onScreen: visibility === 'on-screen',
    behindCamera: projected.behindCamera,
    visibility,
    occlusion: 'unknown',
  };
}

function resolveCamera(scene, cameraId) {
  const resolvedId = cameraId ?? scene.settings?.activeCameraId ?? null;
  if (!resolvedId) {
    throw new StudioError('camera_not_found', 'projectVisibility requires an active camera or projection.cameraId.');
  }
  const entity = scene.entities?.[resolvedId];
  if (!entity || !CAMERA_KINDS.includes(entity.kind)) {
    throw new StudioError('camera_not_found', `${resolvedId} is not a camera entity.`, { cameraId: resolvedId });
  }
  return entity;
}

/**
 * Project authored world points and entity origins through the authored camera.
 * Occlusion is unknown without a GPU depth sample; frustum visibility is exact.
 */
export function buildProjectVisibility(scene, options = {}) {
  const width = Math.trunc(finiteNumber(options.width, 1280, 'projection.width', { min: 1, max: 4096 }));
  const height = Math.trunc(finiteNumber(options.height, 720, 'projection.height', { min: 1, max: 4096 }));
  const points = options.points ?? [];
  const entityIds = options.entityIds ?? [];
  if (points.length > PROJECT_VISIBILITY_LIMITS.maxPoints) {
    throw new StudioError('invalid_projection', `projection.points cannot exceed ${PROJECT_VISIBILITY_LIMITS.maxPoints}.`);
  }
  if (entityIds.length > PROJECT_VISIBILITY_LIMITS.maxEntities) {
    throw new StudioError('invalid_projection', `projection.entityIds cannot exceed ${PROJECT_VISIBILITY_LIMITS.maxEntities}.`);
  }
  if (points.length === 0 && entityIds.length === 0) {
    throw new StudioError('invalid_projection', 'projectVisibility requires projection.points or projection.entityIds.');
  }
  const camera = resolveCamera(scene, options.cameraId);
  const worldMemo = new Map();
  const cameraWorld = entityWorldMatrix(scene, camera.id, worldMemo);
  const projection = cameraProjectionFromEntity(camera, width, height);
  const records = [];
  for (const point of points) {
    if (!Array.isArray(point.world) || point.world.length !== 3 || !point.world.every(Number.isFinite)) {
      throw new StudioError('invalid_projection', `Projection point ${point.name ?? '<unnamed>'} needs a finite world XYZ.`);
    }
    records.push({
      name: point.name,
      ...projectWorldPoint(point.world, cameraWorld, projection, width, height),
    });
  }
  for (const entityId of entityIds) {
    const world = entityWorldPosition(scene, entityId, worldMemo);
    records.push({
      name: entityId,
      entityId,
      ...projectWorldPoint(world, cameraWorld, projection, width, height),
    });
  }
  return {
    cameraId: camera.id,
    width,
    height,
    camera: {
      kind: camera.kind,
      worldPosition: entityWorldPosition(scene, camera.id, worldMemo),
      ...projection,
    },
    points: records,
  };
}
