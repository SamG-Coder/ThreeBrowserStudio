import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AtomicProjectStore,
  AuthoringKernel,
  buildBeautyDigest,
  buildMeshElements,
  buildMeshSelection,
  buildMeshQuality,
  buildProjectVisibility,
  cameraEulerForDirection,
  MAX_INSPECT_RESPONSE_BYTES,
  ProjectIndex,
  PROTOCOL_VERSION,
  StudioError,
  atomicWriteJson,
  analyzeViewportModifierStack,
  AUTHORABLE_MODIFIER_TYPES,
  buildModifierDigest,
  contentHash,
  createEntityDocument,
  createBlankProjectDocument,
  createProjectDocument,
  createResourceDocument,
  exportSceneInterchange,
  DATA_TEXTURE_LIMITS,
  dataTextureGpuByteLength,
  hashExactEntitySet,
  LIVE_EDITABLE_MESH_GEOMETRY_MODIFIERS,
  LIVE_INSTANCE_MODIFIER_TYPES,
  encodeObjectIdRgb01,
  forecastPixelImpact,
  loadObjectIdEvidence,
  MATERIAL_TEXTURE_BINDINGS,
  MATERIAL_TEXTURE_CONTROL_CONTRACT,
  MAX_MODIFIERS_PER_ENTITY,
  mergePatch,
  normalizeDataTextureResource,
  normalizeGraphResourcePatch,
  normalizeResourceType,
  normalizeStroke,
  prepareStroke,
  paintDataTextureStroke,
  STROKE_LIMITS,
  strokeInstanceTransforms,
  shapeToolResponse,
  entityWorldMatrix,
  invertTransformMatrix,
  transformPointByMatrix,
  validateProjectDocument,
} from '../core/index.mjs';
import {
  createProjectPack,
  parseProjectPack,
  projectImportFolderName,
} from '../core/project-pack.mjs';
import {
  GEOMETRY_MODIFIER_LIMITS,
  GEOMETRY_MODIFIER_TYPES,
} from '../core/geometry-modifier-evaluator.mjs';
import {
  MAX_REQUEST_TIMEOUT_MS,
  createLiveBridgeServer,
  createSessionCredentials,
  createSessionMarker,
  defaultSessionMarkerPath,
  readSessionMarker,
  secureSessionMarkerDirectory,
  writeSessionMarker,
} from '../bridge/index.mjs';
import {
  BLENDER_SHADER_NODE_INVENTORY_SUMMARY,
  buildGraphDigest,
  queryBlenderShaderNodeInventory,
  queryGraphCatalog,
  validateGraph,
} from '../graphs/index.mjs';
import { BLENDER_CATALOG_SUMMARY, queryBlenderCatalog } from '../blender/index.mjs';
import {
  GEOMETRY_EDIT_COMMAND_TYPES,
  OPERATION_TYPES,
  operationSchema,
  TOOL_CONTRACT,
  TOOL_CONTRACT_SUMMARY,
  TOOL_SCHEMAS,
} from '../mcp/tool-schemas.mjs';
import { PlainformCompiler } from '../plainform/index.mjs';
import { queryOperationCatalog } from '../mcp/operation-catalog.mjs';
import { emptyStudioCommandMetrics } from './mcp-live-feed-telemetry.mjs';
import { compileSceneDocument } from './scene-compiler.mjs';
import { validateAnimationResource } from './animation-runtime.mjs';
import { frameCameraToBounds } from '../viewport/camera-projection.mjs';
import { describeEffectiveCamera } from '../viewport/camera-evidence.mjs';
import { operationsSnapFollowShot } from '../viewport/view-mode.mjs';
import { buildExplorerOutline } from '../viewport/scene-explorer.mjs';
import { LAYOUT_PATTERN_MODES } from '../core/layout-patterns.mjs';
import { RTX_SCENE_LIMITS } from './rtx-scene-collector.mjs';
import { materialLookResource, queryLookCatalog } from './material-looks.mjs';
import {
  createGeometry,
  indexedMeshRecipeFromBufferGeometry,
  normalizeGeometryRecipe,
  queryGeometryCatalog,
  realizeGeometryRecipe,
} from './resource-factories.mjs';
import { createTransactionId } from '../core/util.mjs';

export { materialLookResource, queryLookCatalog } from './material-looks.mjs';
import { bakeProceduralTextureGraph } from './procedural-texture-compiler.mjs';
import { createLogicControllerRuntime, LOGIC_CONTROLLER_LIMITS } from './logic-controller-runtime.mjs';

const INSPECT_RESPONSE_ENVELOPE_RESERVE_BYTES = 2_048;

function monotonicMilliseconds() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function summarizeOperationTypes(operations) {
  const counts = new Map();
  for (const operation of operations) {
    const type = operation.op ?? operation.type;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => ({ type, count }));
}

const STATUS_SELECT_PRESETS = Object.freeze({
  minimal: [
    'success', 'protocolVersion', 'sessionId', 'pid', 'projectId', 'projectName',
    'revision', 'savedRevision', 'dirty', 'activeSceneId', 'mode',
    'viewport.ready', 'viewport.renderer', 'viewport.cameraId', 'viewport.viewMode',
    'viewport.width', 'viewport.height',
    'play.controller.available', 'play.controller.active', 'play.controller.entityId',
    'play.controller.activationKey',
    'rtx.supported', 'rtx.requested', 'rtx.active', 'rtx.failed', 'rtx.reason',
    'capabilities.controllerRuntime', 'capabilities.logicRuntime.globalExitKey',
    'capabilities.toolContract.contractVersion', 'capabilities.toolContract.serverVersion',
    'capabilities.toolContract.hash',
  ],
  authoring: [
    'success', 'protocolVersion', 'sessionId', 'pid', 'projectId', 'projectName',
    'revision', 'savedRevision', 'dirty', 'activeSceneId', 'sceneCount', 'entityCount',
    'collectionCount', 'undoAvailable', 'redoAvailable', 'mode', 'viewport.ready',
    'viewport.renderer', 'viewport.cameraId', 'viewport.viewMode',
    'capabilities.geometryRecipes', 'capabilities.geometryEditCommands',
    'capabilities.layoutPatterns', 'capabilities.jobs', 'capabilities.jobKinds',
    'capabilities.materialRecipes', 'capabilities.renderPasses',
    'capabilities.controllerRuntime', 'capabilities.logicRuntime', 'play.controller',
    'capabilities.toolContract.contractVersion', 'capabilities.toolContract.hash',
    'authoringTelemetry',
  ],
  rendering: [
    'success', 'protocolVersion', 'sessionId', 'projectId', 'projectName', 'revision', 'dirty',
    'viewport', 'rtx', 'capabilities.webgpu', 'capabilities.shadows',
    'capabilities.renderPasses', 'capabilities.toolContract.contractVersion',
    'capabilities.toolContract.hash', 'latestEvidence',
  ],
});

const INSPECT_SELECT_PRESETS = Object.freeze({
  summary: [
    'success', 'revision', 'projectId', 'scene.id', 'scene.name', 'scene.activeCameraId',
    'scene.entityCount', 'scene.collectionCount', 'scene.selectedEntityCount',
    'scene.sceneHash', 'scene.selectionHash', 'entities.id', 'entities.name',
    'entities.kind', 'entities.parentId', 'entities.visible', 'nextCursor',
  ],
  authoring: [
    'success', 'revision', 'projectId', 'scene', 'collection', 'entities.id', 'entities.name',
    'entities.kind', 'entities.parentId', 'entities.children', 'entities.visible',
    'entities.transform', 'entities.components', 'entities.referencesTo', 'nextCursor',
  ],
});

const RESOURCE_OPERATIONS = Object.freeze({
  'geometry.put': ['geometries', 'put'],
  'geometry.delete': ['geometries', 'delete'],
  'material.put': ['materials', 'put'],
  'material.delete': ['materials', 'delete'],
  'texture.put': ['textures', 'put'],
  'texture.delete': ['textures', 'delete'],
  'graph.put': ['graphs', 'put'],
  'graph.patch': ['graphs', 'patch'],
  'graph.delete': ['graphs', 'delete'],
  'animation.put': ['animations', 'put'],
  'animation.delete': ['animations', 'delete'],
  'prefab.put': ['prefabs', 'put'],
  'prefab.delete': ['prefabs', 'delete'],
});

const DIRECT_CORE_OPERATIONS = new Set([
  'scene.create', 'scene.patch', 'scene.delete', 'scene.setActive',
  'scene.settings.patch', 'scene.rtx.patch', 'scene.setActiveCamera',
  'entity.create', 'entity.patch', 'entity.duplicate', 'entity.reparent', 'entity.delete',
  'entity.patchMany', 'entity.transformMany', 'entity.group', 'entity.ungroup',
  'collection.create', 'collection.patch', 'collection.membership.patch', 'collection.reparent', 'collection.delete',
  'camera.frame', 'layout.pattern', 'geometry.edit',
  'modifier.create', 'modifier.patch', 'modifier.move', 'modifier.delete', 'modifier.stack.edit',
  'resource.create', 'resource.createMany', 'resource.patch', 'resource.delete',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function required(value, label) {
  if (value === undefined || value === null || value === '') throw new StudioError('invalid_operation', `${label} is required.`);
  return value;
}

function without(value, keys) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function authoredCameraEvidenceOptions(document, camera, sourceCameraId) {
  if (!sourceCameraId || sourceCameraId === 'review-camera') {
    return { sourceCameraId: sourceCameraId ?? 'review-camera', framingMode: 'review' };
  }
  let framing;
  try {
    framing = new ProjectIndex(document).getEntity(sourceCameraId).entity.components?.camera?.framing;
  } catch {
    framing = undefined;
  }
  return {
    sourceCameraId,
    framingMode: framing ? 'authored-frame' : 'authored',
    ...(Array.isArray(framing?.targetIds) ? { targetIds: framing.targetIds } : {}),
    ...(framing?.bounds ? { targetBounds: framing.bounds } : {}),
  };
}

function parseToolParams(method, params) {
  const schema = TOOL_SCHEMAS[method];
  if (!schema) throw new StudioError('method_not_found', `Unknown Studio method ${method}.`);
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw new StudioError('invalid_request', `Invalid ${method} request.`, {
      diagnostics: parsed.error.issues.map(issue => ({
        code: issue.code,
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

function resourceOperation(operation, document) {
  const [resourceType, action] = RESOURCE_OPERATIONS[operation.op];
  const data = operation.data ?? {};
  const resourceId = required(operation.targetId ?? data.resourceId ?? data.id ?? data.resource?.id, `${operation.op}.targetId`);
  if (action === 'delete') return { type: 'resource.delete', resourceType, resourceId };
  if (action === 'patch') {
    const patch = data.patch ?? without(data, ['resourceId']);
    return {
      type: 'resource.patch',
      resourceType,
      resourceId,
      patch: resourceType === 'graphs'
        ? normalizeGraphResourcePatch(patch, document.resources?.graphs?.[resourceId])
        : patch,
    };
  }
  const source = data.resource ?? data.value ?? data;
  const resource = resourceType === 'graphs'
    ? createResourceDocument(resourceType, { ...source, id: resourceId })
    : { ...source, id: resourceId };
  if (document.resources?.[resourceType]?.[resourceId]) {
    return { type: 'resource.patch', resourceType, resourceId, patch: without(resource, ['id']) };
  }
  return { type: 'resource.create', resourceType, resource, ...(operation.alias ? { alias: operation.alias } : {}) };
}

function strokeFromOperation(operation, document) {
  if (operation.stroke) return normalizeStroke(operation.stroke);
  const resource = document.resources?.assets?.[operation.strokeId];
  if (!resource || resource.kind !== 'stroke') {
    throw new StudioError('stroke_not_found', `Stroke asset ${operation.strokeId} does not exist.`, {
      strokeId: operation.strokeId,
    });
  }
  return normalizeStroke(resource.stroke ?? resource.recipe);
}

function subtract3(left, right) { return left.map((value, axis) => value - right[axis]); }
function addScaled3(origin, vector, amount) { return origin.map((value, axis) => value + vector[axis] * amount); }
function dot3(left, right) { return left.reduce((sum, value, axis) => sum + value * right[axis], 0); }

function closestPointOnTriangle(point, a, b, c) {
  const ab = subtract3(b, a); const ac = subtract3(c, a); const ap = subtract3(point, a);
  const d1 = dot3(ab, ap); const d2 = dot3(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = subtract3(point, b); const d3 = dot3(ab, bp); const d4 = dot3(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return addScaled3(a, ab, d1 / (d1 - d3));
  const cp = subtract3(point, c); const d5 = dot3(ab, cp); const d6 = dot3(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return addScaled3(a, ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return addScaled3(b, subtract3(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6)));
  const denominator = 1 / (va + vb + vc);
  return a.map((value, axis) => value + ab[axis] * vb * denominator + ac[axis] * vc * denominator);
}

function localTriangles(recipe) {
  if (recipe?.kind === 'indexedMesh' || recipe?.kind === 'explicit') {
    return Array.from({ length: recipe.indices.length / 3 }, (_, triangle) => recipe.indices.slice(triangle * 3, triangle * 3 + 3));
  }
  if (recipe?.kind === 'editableMesh') {
    const triangles = [];
    for (let face = 0; face < recipe.faceOffsets.length - 1; face += 1) {
      const vertices = recipe.cornerVertexIndices.slice(recipe.faceOffsets[face], recipe.faceOffsets[face + 1]);
      for (let index = 1; index < vertices.length - 1; index += 1) triangles.push([vertices[0], vertices[index], vertices[index + 1]]);
    }
    return triangles;
  }
  return null;
}

function projectLocalStrokeToSurface(stroke, recipe, entityId) {
  const triangles = localTriangles(recipe);
  if (!triangles) throw new StudioError(
    'surface_projection_unavailable',
    'Surface strokes require indexedMesh, explicit, or editableMesh geometry; convert procedural geometry before projecting.',
    { entityId, geometryKind: recipe?.kind },
  );
  if (triangles.length * stroke.points.length > STROKE_LIMITS.maxSurfaceProjectionTests) {
    throw new StudioError('surface_projection_limit', 'Surface stroke exceeds the bounded triangle-test budget.', {
      entityId, pointCount: stroke.points.length, triangleCount: triangles.length,
      maximum: STROKE_LIMITS.maxSurfaceProjectionTests,
    });
  }
  const positionAt = index => recipe.positions.slice(index * 3, index * 3 + 3);
  return {
    ...stroke,
    points: stroke.points.map(point => {
      let best = null;
      for (const triangle of triangles) {
        const a = positionAt(triangle[0]); const b = positionAt(triangle[1]); const c = positionAt(triangle[2]);
        const projected = closestPointOnTriangle(point.position, a, b, c);
        const distance = dot3(subtract3(point.position, projected), subtract3(point.position, projected));
        if (!best || distance < best.distance) {
          const ab = subtract3(b, a); const ac = subtract3(c, a);
          const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
          const length = Math.hypot(...normal) || 1;
          best = { distance, position: projected, normal: normal.map(value => value / length) };
        }
      }
      return { ...point, position: best.position, normal: best.normal };
    }),
  };
}

function lightingRigOperations(operation) {
  const center = operation.center ?? [0, 0, 0]; const scale = operation.scale ?? 1; const intensity = operation.intensity ?? 1;
  const position = offset => center.map((value, axis) => value + offset[axis] * scale);
  const entity = (suffix, kind, name, offset, light) => ({
    type: 'entity.create', sceneId: operation.sceneId,
    entity: {
      id: `${operation.rigId}/${suffix}`, kind, name, parentId: operation.rigId,
      transform: {
        position: position(offset),
        rotation: kind === 'areaLight'
          ? cameraEulerForDirection(offset.map(value => -value))
          : [0, 0, 0],
        scale: [1, 1, 1],
      },
      components: { light: { ...light, intensity: light.intensity * intensity } },
      tags: ['lighting', `rig-${operation.preset}`],
    },
  });
  const result = [{
    type: 'entity.create', sceneId: operation.sceneId,
    entity: { id: operation.rigId, kind: 'group', name: `${operation.preset} lighting rig`, parentId: operation.parentId ?? null, tags: ['lighting', 'lighting-rig'] },
  }];
  if (operation.preset === 'outdoor') {
    result.push(entity('sky', 'hemisphereLight', 'Outdoor sky fill', [0, 0, 0], { color: [0.55, 0.72, 1], groundColor: [0.18, 0.14, 0.09], intensity: 0.75, castShadow: false }));
    result.push(entity('sun', 'directionalLight', 'Outdoor sun', [-5, 8, 4], { color: [1, 0.84, 0.62], intensity: 2.4, castShadow: true, shadowMapSize: 2048, shadowBias: -0.0002, shadowNormalBias: 0.02 }));
  } else {
    const cinematic = operation.preset === 'cinematic'; const product = operation.preset === 'product';
    result.push(entity('ambient', 'ambientLight', 'Visibility fill', [0, 0, 0], { color: [0.42, 0.48, 0.6], intensity: cinematic ? 0.08 : 0.22, castShadow: false }));
    result.push(entity('key', 'pointLight', 'Key light', [4, 5, 5], { color: product ? [1, 0.93, 0.84] : [1, 0.72, 0.5], intensity: product ? 65 : 42, distance: 30 * scale, decay: 2, castShadow: true, shadowMapSize: 2048 }));
    result.push(entity('fill', 'pointLight', 'Fill light', [-4, 3, 2], { color: [0.48, 0.68, 1], intensity: cinematic ? 20 : 34, distance: 28 * scale, decay: 2, castShadow: false }));
    result.push(entity('rim', 'pointLight', 'Rim light', [1, 4, -5], { color: cinematic ? [0.9, 0.25, 0.12] : [0.65, 0.82, 1], intensity: cinematic ? 52 : 38, distance: 26 * scale, decay: 2, castShadow: false }));
    result.push(entity('key-softbox', 'areaLight', 'Key softbox', [4.5, 5.5, 4], { color: product ? [1, 0.94, 0.86] : [1, 0.76, 0.58], intensity: product ? 8 : 5, width: 4.5 * scale, height: 3.2 * scale, castShadow: false }));
    result.push(entity('rim-strip', 'areaLight', 'Rim strip', [-3.5, 3, -4.5], { color: [0.55, 0.72, 1], intensity: cinematic ? 6 : 4, width: 1.2 * scale, height: 4.8 * scale, castShadow: false }));
  }
  if (operation.rtx !== 'auto') result.push({
    type: 'scene.rtx.patch', sceneId: operation.sceneId,
    patch: operation.rtx === 'on'
      ? { enabled: true, lighting: true, shadows: true, ambientOcclusion: true }
      : { enabled: false },
  });
  return result;
}

function localStrokeForEntity(strokeValue, document, entityId) {
  const stroke = normalizeStroke(strokeValue);
  if (stroke.space === 'local') return stroke;
  if (stroke.space === 'uv') throw new StudioError('stroke_space_mismatch', 'UV strokes cannot target scene geometry.');
  const index = new ProjectIndex(document);
  const { scene, entity } = index.getEntity(entityId);
  const inverse = invertTransformMatrix(entityWorldMatrix(scene, entityId));
  const origin = transformPointByMatrix(inverse, [0, 0, 0]);
  const local = {
    ...stroke,
    space: 'local',
    targetEntityId: entityId,
    points: stroke.points.map(point => ({
      ...point,
      position: transformPointByMatrix(inverse, point.position),
      ...(point.normal ? {
        normal: (() => {
          const end = transformPointByMatrix(inverse, point.normal);
          const value = end.map((component, axis) => component - origin[axis]);
          const length = Math.hypot(...value);
          return length === 0 ? [0, 0, 1] : value.map(component => component / length);
        })(),
      } : {}),
    })),
  };
  if (stroke.space !== 'surface') return local;
  if (stroke.targetEntityId && stroke.targetEntityId !== entityId) throw new StudioError(
    'stroke_target_mismatch', `Surface stroke targets ${stroke.targetEntityId}, not ${entityId}.`,
    { targetEntityId: stroke.targetEntityId, entityId },
  );
  const geometryId = entity.components?.mesh?.geometryId;
  const geometry = index.getResource(geometryId, 'geometries').resource;
  return projectLocalStrokeToSurface(local, geometry.recipe ?? geometry, entityId);
}

const TEXTURE_PAINT_RECIPE_PATCH = Symbol('texturePaintRecipePatch');

function translateStrokeOperation(operation, document) {
  const stroke = strokeFromOperation(operation, document);
  const target = operation.target;
  const lowered = [];
  if (operation.storeAsAssetId) {
    lowered.push({
      type: 'resource.create',
      resourceType: 'assets',
      resource: { id: operation.storeAsAssetId, kind: 'stroke', stroke },
    });
  }
  if (target.kind === 'sculpt' || target.kind === 'attribute') {
    const index = new ProjectIndex(document);
    const { entity } = index.getEntity(target.entityId);
    if (!['mesh', 'instancedMesh'].includes(entity.kind) || !entity.components?.mesh?.geometryId) {
      throw new StudioError('invalid_stroke_target', `${target.kind} strokes require a mesh entity.`, { entityId: target.entityId });
    }
    const localStroke = localStrokeForEntity(stroke, document, target.entityId);
    const edits = [];
    if (target.kind === 'attribute') {
      const geometry = index.getResource(entity.components.mesh.geometryId, 'geometries').resource;
      if (!geometry.recipe?.colorLayers?.[target.layer]) {
        if (target.createIfMissing === false) {
          throw new StudioError('unknown_color_layer', `Color layer ${target.layer} does not exist.`, { entityId: target.entityId });
        }
        edits.push({ type: 'createColorLayer', name: target.layer, fill: target.fill ?? [1, 1, 1, 1], setActive: true });
      }
    }
    edits.push(target.kind === 'sculpt' ? {
      type: 'sculptStroke', stroke: localStroke, brush: target.brush, amount: target.amount,
      ...(target.direction ? { direction: target.direction } : {}),
      ...(target.falloff ? { falloff: target.falloff } : {}),
      ...(target.vertexIndices ? { vertexIndices: target.vertexIndices } : {}),
      ...(target.selection ? { selection: target.selection } : {}),
    } : {
      type: 'paintColorStroke', stroke: localStroke, layer: target.layer,
      ...(target.color ? { color: target.color } : {}),
      ...(target.opacity === undefined ? {} : { opacity: target.opacity }),
      ...(target.blend ? { blend: target.blend } : {}),
      ...(target.falloff ? { falloff: target.falloff } : {}),
      ...(target.setActive === undefined ? {} : { setActive: target.setActive }),
    });
    lowered.push({
      type: 'geometry.edit',
      resourceId: entity.components.mesh.geometryId,
      ...(target.expectedTopologyHash ? { expectedTopologyHash: target.expectedTopologyHash } : {}),
      edits,
    });
  } else if (target.kind === 'texture') {
    const textureId = target.textureId;
    const resource = new ProjectIndex(document).getResource(textureId, 'textures').resource;
    const recipe = paintDataTextureStroke(resource, stroke, target);
    delete recipe.pixels;
    const patchOperation = { type: 'resource.patch', resourceType: 'textures', resourceId: textureId, patch: { recipe } };
    Object.defineProperty(patchOperation, TEXTURE_PAINT_RECIPE_PATCH, { value: true });
    lowered.push(patchOperation);
  } else if (target.kind === 'curve') {
    const prepared = prepareStroke(stroke);
    if (prepared.points.length < 2) throw new StudioError('invalid_stroke_curve', 'Curve strokes require at least two points.');
    lowered.push({
      type: 'resource.create', resourceType: 'geometries',
      resource: {
        id: target.geometryId,
        recipe: {
          kind: 'tube', points: prepared.points.map(point => point.position), radius: target.radius,
          tubularSegments: target.tubularSegments ?? Math.min(512, Math.max(8, prepared.points.length * 4)),
          radialSegments: target.radialSegments, closed: target.closed ?? prepared.closed,
        },
      },
    });
    lowered.push({
      type: 'entity.create', sceneId: target.sceneId,
      entity: {
        id: target.entityId, kind: 'mesh', name: target.name ?? target.entityId.split('/').at(-1),
        parentId: target.parentId ?? null,
        components: { mesh: { geometryId: target.geometryId, materialId: target.materialId, castShadow: true, receiveShadow: true } },
      },
    });
  } else if (target.kind === 'scatter') {
    const { entity } = new ProjectIndex(document).getEntity(target.entityId);
    if (!['mesh', 'instancedMesh'].includes(entity.kind)) throw new StudioError('invalid_stroke_target', 'Scatter strokes require a mesh entity.');
    const localStroke = localStrokeForEntity(stroke, document, target.entityId);
    const instances = strokeInstanceTransforms(localStroke, target);
    lowered.push({
      type: 'entity.patch', entityId: target.entityId,
      patch: { kind: 'instancedMesh', components: { mesh: { instances, count: instances.length } } },
    });
  }
  return lowered;
}

export function translateToolOperation(operation, document) {
  const data = operation.data ?? {};
  if (operation.op === 'stroke.apply') return translateStrokeOperation(operation, document);
  if (operation.op === 'entity.createMany') return operation.items.map(item => ({
    type: 'entity.create', sceneId: operation.sceneId, entity: item.entity,
    ...(item.alias ? { alias: item.alias } : {}), ...(item.index === undefined ? {} : { index: item.index }),
  }));
  if (operation.op === 'entity.duplicateMany') return operation.items.flatMap(item => [{
      type: 'entity.duplicate', entityId: operation.entityId, newId: item.newId, deep: operation.deep === true,
      ...(item.idMap ? { idMap: item.idMap } : {}),
      ...(item.name ? { name: item.name } : {}),
      ...(item.parentId === undefined ? {} : { parentId: item.parentId }),
      ...(item.index === undefined ? {} : { index: item.index }),
      ...(item.alias ? { alias: item.alias } : {}),
    },
    ...(item.transform ? [{ type: 'entity.patch', entityId: item.newId, patch: { transform: item.transform } }] : []),
  ]);
  if (operation.op === 'resource.createMany') return {
    type: 'resource.createMany',
    items: operation.items.map(item => {
      const resourceType = normalizeResourceType(item.resourceType);
      return {
        resourceType,
        resource: resourceType === 'graphs' ? createResourceDocument('graphs', item.resource) : item.resource,
        ...(item.alias ? { alias: item.alias } : {}),
      };
    }),
  };
  if (operation.op === 'material.variant.create') {
    const base = new ProjectIndex(document).getResource(operation.baseMaterialId, 'materials').resource;
    const resource = mergePatch(base, operation.patch);
    resource.id = operation.materialId;
    return {
      type: 'resource.create', resourceType: 'materials', resource,
      ...(operation.alias ? { alias: operation.alias } : {}),
    };
  }
  if (operation.op === 'material.look.create') return {
    type: 'resource.create', resourceType: 'materials', resource: materialLookResource(operation),
    ...(operation.alias ? { alias: operation.alias } : {}),
  };
  if (operation.op === 'material.look.patch') {
    const { resource } = new ProjectIndex(document).getResource(operation.materialId, 'materials');
    const next = materialLookResource(operation, resource);
    return {
      type: 'resource.patch',
      resourceType: 'materials',
      resourceId: operation.materialId,
      patch: {
        recipe: next.recipe,
        metadata: next.metadata,
        ...(next.opacity === undefined ? {} : { opacity: next.opacity }),
        ...(next.transparent === undefined ? {} : { transparent: next.transparent }),
        ...(next.transmission === undefined ? {} : { transmission: next.transmission }),
      },
    };
  }
  if (operation.op === 'lighting.rig.create') return lightingRigOperations(operation);
  if (DIRECT_CORE_OPERATIONS.has(operation.op)) {
    const direct = structuredClone(operation);
    if (direct.op === 'camera.frame') {
      const target = direct.target;
      direct.bounds = target?.bounds;
      direct.targetIds = target?.targetIds;
      delete direct.target;
      if (direct.view) {
        const { azimuth, elevation, distanceScale, targetOffset, minHeight } = direct.view;
        const horizontal = Math.cos(elevation);
        direct.direction = [-Math.sin(azimuth) * horizontal, -Math.sin(elevation), -Math.cos(azimuth) * horizontal];
        if (distanceScale !== undefined) direct.distanceScale = distanceScale;
        direct.targetOffset = targetOffset;
        if (minHeight !== undefined) direct.minHeight = minHeight;
        delete direct.view;
      }
      if (direct.bounds === undefined) delete direct.bounds;
      if (direct.targetIds === undefined) delete direct.targetIds;
    }
    if (direct.op.startsWith('resource.')) direct.resourceType = normalizeResourceType(direct.resourceType);
    if (direct.op === 'resource.create' && direct.resourceType === 'graphs') {
      direct.resource = createResourceDocument('graphs', direct.resource);
    } else if (direct.op === 'resource.patch' && direct.resourceType === 'graphs') {
      direct.patch = normalizeGraphResourcePatch(direct.patch, document.resources?.graphs?.[direct.resourceId]);
    }
    return direct;
  }
  if (RESOURCE_OPERATIONS[operation.op]) return resourceOperation(operation, document);
  switch (operation.op) {
    case 'scene.create': {
      const source = data.scene ?? data;
      return {
        type: 'scene.create',
        scene: { ...source, id: source.id ?? required(operation.targetId, 'scene.create.targetId') },
        ...(data.index === undefined ? {} : { index: data.index }),
        ...(operation.alias ? { alias: operation.alias } : {}),
      };
    }
    case 'scene.patch': return {
      type: 'scene.patch',
      sceneId: required(operation.targetId ?? data.sceneId, 'scene.patch.targetId'),
      patch: data.patch ?? without(data, ['sceneId']),
    };
    case 'scene.delete': return {
      type: 'scene.delete',
      sceneId: required(operation.targetId ?? data.sceneId, 'scene.delete.targetId'),
      ...(operation.expectedHash || data.expectedSceneHash ? { expectedSceneHash: operation.expectedHash ?? data.expectedSceneHash } : {}),
    };
    case 'scene.active.set': return {
      type: 'scene.setActive',
      sceneId: required(operation.targetId ?? data.sceneId, 'scene.active.set.targetId'),
    };
    case 'scene.activeCamera.set': return {
      type: 'scene.setActiveCamera',
      sceneId: data.sceneId ?? document.activeSceneId,
      cameraId: operation.targetId ?? data.cameraId ?? null,
    };
    case 'entity.create': {
      const source = data.entity ?? without(data, ['sceneId', 'index']);
      return {
        type: 'entity.create',
        sceneId: data.sceneId ?? document.activeSceneId,
        entity: { ...source, id: source.id ?? required(operation.targetId, 'entity.create.targetId') },
        ...(data.index === undefined ? {} : { index: data.index }),
        ...(operation.alias ? { alias: operation.alias } : {}),
      };
    }
    case 'entity.patch': return {
      type: 'entity.patch',
      entityId: required(operation.targetId ?? data.entityId, 'entity.patch.targetId'),
      patch: data.patch ?? without(data, ['entityId']),
    };
    case 'entity.duplicate': return {
      type: 'entity.duplicate',
      entityId: required(operation.targetId ?? data.entityId, 'entity.duplicate.targetId'),
      ...without(data, ['entityId']),
      ...(operation.alias ? { alias: operation.alias } : {}),
    };
    case 'entity.reparent': return {
      type: 'entity.reparent',
      entityId: required(operation.targetId ?? data.entityId, 'entity.reparent.targetId'),
      parentId: data.parentId ?? null,
      ...(data.index === undefined ? {} : { index: data.index }),
    };
    case 'entity.delete': return {
      type: 'entity.delete',
      entityId: required(operation.targetId ?? data.entityId, 'entity.delete.targetId'),
      recursive: data.recursive === true,
      ...(operation.expectedHash || data.expectedSubtreeHash ? { expectedSubtreeHash: operation.expectedHash ?? data.expectedSubtreeHash } : {}),
    };
    default:
      throw new StudioError('operation_not_implemented', `${operation.op} is not in the lean v1 authoring slice yet.`, { operation: operation.op });
  }
}

function compactTextureRecipePatches(operations) {
  const lastRecipePatchByTexture = new Map();
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    const type = operation.type ?? operation.op;
    const patchKeys = operation.patch && typeof operation.patch === 'object'
      ? Object.keys(operation.patch)
      : [];
    if (
      operation[TEXTURE_PAINT_RECIPE_PATCH] === true
      && type === 'resource.patch'
      && operation.resourceType === 'textures'
      && typeof operation.resourceId === 'string'
      && patchKeys.length === 1
      && patchKeys[0] === 'recipe'
    ) {
      lastRecipePatchByTexture.set(operation.resourceId, index);
    }
  }
  if (lastRecipePatchByTexture.size === 0) return operations;
  return operations.filter((operation, index) => {
    const type = operation.type ?? operation.op;
    const patchKeys = operation.patch && typeof operation.patch === 'object'
      ? Object.keys(operation.patch)
      : [];
    if (
      operation[TEXTURE_PAINT_RECIPE_PATCH] !== true
      || type !== 'resource.patch'
      || operation.resourceType !== 'textures'
      || typeof operation.resourceId !== 'string'
      || patchKeys.length !== 1
      || patchKeys[0] !== 'recipe'
    ) return true;
    return lastRecipePatchByTexture.get(operation.resourceId) === index;
  });
}

function materializeGeometryRealizeOperation(operation, { document, THREE }) {
  const { resource } = new ProjectIndex(document).getResource(operation.resourceId, 'geometries');
  const resourceHash = contentHash(resource);
  if (operation.expectedResourceHash && operation.expectedResourceHash !== resourceHash) {
    throw new StudioError('resource_conflict', `Geometry resource ${operation.resourceId} changed after inspection.`, {
      resourceId: operation.resourceId,
      expectedResourceHash: operation.expectedResourceHash,
      actualResourceHash: resourceHash,
    });
  }
  return {
    type: 'resource.patch',
    resourceType: 'geometries',
    resourceId: operation.resourceId,
    patch: {
      recipe: {
        ...Object.fromEntries(Object.keys(resource.recipe ?? resource.parameters ?? {}).map(key => [key, null])),
        ...realizeGeometryRecipe(THREE, resource),
      },
    },
  };
}

function materializeLoftEditOperation(operation, document) {
  const { resource } = new ProjectIndex(document).getResource(operation.resourceId, 'geometries');
  const resourceHash = contentHash(resource);
  if (operation.expectedResourceHash && operation.expectedResourceHash !== resourceHash) {
    throw new StudioError('resource_conflict', `Geometry resource ${operation.resourceId} changed after inspection.`, {
      resourceId: operation.resourceId,
      expectedResourceHash: operation.expectedResourceHash,
      actualResourceHash: resourceHash,
    });
  }
  const recipe = normalizeGeometryRecipe(resource);
  if (recipe.kind !== 'loft' || !Array.isArray(recipe.sections)) {
    throw new StudioError('invalid_geometry_target', 'geometry.loft.edit requires a procedural loft resource.');
  }
  const sections = recipe.sections.map((section, index) => (Array.isArray(section)
    ? { id: `section/${index}`, points: structuredClone(section) }
    : structuredClone(section)));
  const find = sectionId => {
    const index = sections.findIndex(section => section.id === sectionId);
    if (index < 0) {
      throw new StudioError('loft_section_not_found', `Loft section ${sectionId} does not exist.`, {
        sectionId,
        sectionIds: sections.map(section => section.id),
      });
    }
    return index;
  };
  for (const change of operation.changes) {
    if (change.type === 'create') {
      if (sections.some(section => section.id === change.section.id)) {
        throw new StudioError('duplicate_id', `Loft section ${change.section.id} already exists.`);
      }
      const index = Math.min(change.index ?? sections.length, sections.length);
      sections.splice(index, 0, structuredClone(change.section));
    } else if (change.type === 'patch') {
      const index = find(change.sectionId);
      sections[index] = mergePatch(sections[index], change.patch);
    } else if (change.type === 'move') {
      const index = find(change.sectionId);
      const [section] = sections.splice(index, 1);
      sections.splice(Math.min(change.index, sections.length), 0, section);
    } else if (change.type === 'delete') sections.splice(find(change.sectionId), 1);
  }
  if (sections.length < 2) throw new StudioError('invalid_loft', 'A loft must retain at least two sections.');
  return {
    type: 'resource.patch',
    resourceType: 'geometries',
    resourceId: operation.resourceId,
    patch: { recipe: { sections } },
  };
}

const VERTEX_SELECTION_EDIT_TYPES = new Set([
  'move', 'proportionalMove', 'sculptStroke', 'scale', 'rotate', 'smooth', 'mergeVertices',
]);
const FACE_SELECTION_EDIT_TYPES = new Set([
  'subdivideFaces', 'insetFaces', 'extrudeFaces', 'deleteFaces', 'assignFaceMaterials',
]);

function materializeGeometrySelectionEdit(operation, document) {
  const { resource } = new ProjectIndex(document).getResource(operation.resourceId, 'geometries');
  const selection = buildMeshSelection(resource, {
    element: operation.element,
    meshFilter: operation.meshFilter,
  });
  if (selection.selectionHash !== operation.expectedSelectionHash) {
    throw new StudioError('mesh_selection_conflict', 'The semantic mesh selection changed after inspection.', {
      expectedSelectionHash: operation.expectedSelectionHash,
      actualSelectionHash: selection.selectionHash,
      matchedCount: selection.matchedCount,
    });
  }
  if (selection.indices.length === 0) throw new StudioError('empty_selection', 'The semantic mesh selection matched no elements.');
  const allowed = operation.element === 'vertices' ? VERTEX_SELECTION_EDIT_TYPES : FACE_SELECTION_EDIT_TYPES;
  const field = operation.element === 'vertices' ? 'vertexIndices' : 'faceIndices';
  const edits = operation.edits.map(edit => {
    if (!allowed.has(edit.type)) {
      throw new StudioError('selection_domain_mismatch', `${edit.type} does not accept a ${operation.element} semantic selection.`);
    }
    const materialized = structuredClone(edit);
    delete materialized.selection;
    delete materialized.vertexIndices;
    delete materialized.faceIndices;
    materialized[field] = selection.indices;
    return materialized;
  });
  return {
    type: 'geometry.edit',
    resourceId: operation.resourceId,
    expectedTopologyHash: selection.topologyHash,
    edits,
  };
}

const LIGHT_KINDS = new Set([
  'directionalLight', 'pointLight', 'spotLight', 'ambientLight', 'areaLight', 'hemisphereLight',
]);

function unionBounds(boundsList) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  let valid = false;
  for (const bounds of boundsList) {
    if (!bounds?.min || !bounds?.max) continue;
    valid = true;
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis], bounds.min[axis]);
      maximum[axis] = Math.max(maximum[axis], bounds.max[axis]);
    }
  }
  return valid ? { min: minimum, max: maximum } : null;
}

function transformAxisAlignedBounds(bounds, matrix) {
  const corners = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        corners.push(transformPointByMatrix(matrix, [x, y, z]));
      }
    }
  }
  return unionBounds(corners.map(point => ({ min: point, max: point })));
}

function estimateRecipeBounds(recipe) {
  const kind = recipe?.kind;
  if (kind === 'box') {
    const width = (recipe.width ?? 1) * 0.5;
    const height = (recipe.height ?? 1) * 0.5;
    const depth = (recipe.depth ?? 1) * 0.5;
    return { min: [-width, -height, -depth], max: [width, height, depth] };
  }
  if (kind === 'sphere' || kind === 'circle') {
    const radius = recipe.radius ?? 0.5;
    return { min: [-radius, -radius, -radius], max: [radius, radius, radius] };
  }
  if (kind === 'cylinder' || kind === 'cone' || kind === 'capsule') {
    const radius = Math.max(recipe.radius ?? 0, recipe.radiusTop ?? 0.5, recipe.radiusBottom ?? 0.5);
    const height = (recipe.height ?? recipe.length ?? 1) * 0.5;
    return { min: [-radius, -height, -radius], max: [radius, height, radius] };
  }
  if (kind === 'torus' || kind === 'torusKnot') {
    const tube = recipe.tube ?? 0.18;
    const outer = (recipe.radius ?? 0.5) + tube;
    return { min: [-outer, -outer, -tube], max: [outer, outer, tube] };
  }
  if (kind === 'plane') {
    const width = (recipe.width ?? 1) * 0.5;
    const height = (recipe.height ?? 1) * 0.5;
    return { min: [-width, -height, 0], max: [width, height, 0] };
  }
  if (kind === 'loft' && Array.isArray(recipe.sections)) {
    const points = [];
    for (const section of recipe.sections) {
      const localPoints = Array.isArray(section) ? section : section?.points;
      const translation = Array.isArray(section?.transform?.translation) ? section.transform.translation : [0, 0, 0];
      const scale = Array.isArray(section?.transform?.scale) ? section.transform.scale : [1, 1, 1];
      for (const point of localPoints ?? []) {
        const coords = Array.isArray(point) ? point : [point?.x, point?.y, point?.z];
        if (!Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) continue;
        points.push([
          (coords[0] * scale[0]) + translation[0],
          (coords[1] * scale[1]) + translation[1],
          ((coords[2] ?? 0) * scale[2]) + translation[2],
        ]);
      }
    }
    return controlPointBounds(points);
  }
  if (Array.isArray(recipe?.points)) return controlPointBounds(recipe.points);
  if (Array.isArray(recipe?.positions) && recipe.positions.length >= 3) {
    const points = [];
    for (let offset = 0; offset + 2 < recipe.positions.length; offset += 3) {
      points.push(recipe.positions.slice(offset, offset + 3));
    }
    return controlPointBounds(points);
  }
  return { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };
}

export function authoredEntityBounds(document, entityId, seen = new Set()) {
  if (!document || seen.has(entityId)) return null;
  seen.add(entityId);
  let record;
  try {
    record = new ProjectIndex(document).getEntity(entityId);
  } catch {
    return null;
  }
  const { scene, entity } = record;
  if (entity.kind === 'group' && Array.isArray(entity.children) && entity.children.length > 0) {
    return unionBounds(entity.children.map(childId => authoredEntityBounds(document, childId, seen)).filter(Boolean));
  }
  const geometryId = entity.components?.mesh?.geometryId;
  const geometry = geometryId ? document.resources?.geometries?.[geometryId] : null;
  const local = geometry
    ? estimateRecipeBounds(normalizeGeometryRecipe(geometry))
    : { min: [-0.05, -0.05, -0.05], max: [0.05, 0.05, 0.05] };
  if (!local) return null;
  try {
    return transformAxisAlignedBounds(local, entityWorldMatrix(scene, entityId));
  } catch {
    return local;
  }
}

function collectCameraFrameBounds(targetIds, { compiled, THREE, document } = {}) {
  const collected = [];
  const missing = [];
  compiled?.root?.updateWorldMatrix?.(true, true);
  for (const targetId of targetIds) {
    const object = compiled?.objects?.get?.(targetId);
    let bounds = null;
    if (object && THREE?.Box3) {
      const box = new THREE.Box3();
      box.expandByObject(object, true);
      if (!box.isEmpty()) bounds = { min: box.min.toArray(), max: box.max.toArray() };
    }
    if (!bounds) bounds = authoredEntityBounds(document, targetId);
    if (bounds) collected.push(bounds);
    else missing.push(targetId);
  }
  return { bounds: unionBounds(collected), missing };
}

function recordTranslationMutation(document, candidate) {
  const type = candidate.type ?? candidate.op;
  if (type === 'entity.create') {
    const scene = document.scenes?.[candidate.sceneId] ?? document.scenes?.[document.activeSceneId];
    if (!scene || !candidate.entity?.id) return;
    const entity = createEntityDocument(candidate.entity);
    scene.entities[entity.id] = entity;
    if (entity.parentId && scene.entities[entity.parentId]) {
      const parent = scene.entities[entity.parentId];
      if (!parent.children.includes(entity.id)) parent.children = [...parent.children, entity.id];
    } else if (!entity.parentId && !scene.rootEntityIds.includes(entity.id)) {
      scene.rootEntityIds = [...scene.rootEntityIds, entity.id];
    }
    return;
  }
  if (type === 'entity.patch') {
    let entity;
    for (const scene of Object.values(document.scenes ?? {})) {
      if (scene.entities?.[candidate.entityId]) {
        entity = scene.entities[candidate.entityId];
        break;
      }
    }
    if (entity && isRecord(candidate.patch)) {
      Object.assign(entity, mergePatch(entity, candidate.patch));
    }
  }
}

function buildLightingDigest(document, params = {}) {
  const sceneId = params.sceneId ?? document.activeSceneId;
  const scene = document.scenes?.[sceneId];
  if (!scene) throw new StudioError('not_found', `Scene ${sceneId} does not exist.`, { sceneId });
  let lights = Object.values(scene.entities ?? {}).filter(entity => LIGHT_KINDS.has(entity.kind));
  const selector = params.selector ?? {};
  if (Array.isArray(selector.ids) && selector.ids.length > 0) {
    const allowed = new Set(selector.ids);
    lights = lights.filter(entity => allowed.has(entity.id) || allowed.has(entity.parentId));
  }
  if (selector.kind) lights = lights.filter(entity => entity.kind === selector.kind);
  if (selector.tag) lights = lights.filter(entity => entity.tags?.includes(selector.tag));
  if (selector.name) {
    const needle = String(selector.name).toLowerCase();
    lights = lights.filter(entity => (
      entity.name.toLowerCase().includes(needle) || entity.id.toLowerCase().includes(needle)
    ));
  }
  lights.sort((a, b) => a.id.localeCompare(b.id));
  const offset = Math.max(0, Number.parseInt(params.cursor ?? '0', 10) || 0);
  const limit = Math.min(200, params.limit ?? 50);
  const page = lights.slice(offset, offset + limit);
  return {
    sceneId,
    lightCount: lights.length,
    lights: page.map(entity => ({
      id: entity.id,
      name: entity.name,
      kind: entity.kind,
      visible: entity.visible,
      parentId: entity.parentId,
      ...(entity.tags?.length ? { tags: entity.tags } : {}),
      transform: { position: [...(entity.transform?.position ?? [0, 0, 0])] },
      light: entity.components?.light ?? null,
    })),
    rigs: Object.values(scene.entities ?? {})
      .filter(entity => entity.kind === 'group' && entity.tags?.includes('lighting-rig'))
      .map(rig => ({
        id: rig.id,
        name: rig.name,
        visible: rig.visible,
        lightIds: (rig.children ?? []).filter(id => LIGHT_KINDS.has(scene.entities?.[id]?.kind)),
        ...(rig.tags?.length ? { tags: rig.tags } : {}),
      })),
    pageInfo: {
      returned: page.length,
      total: lights.length,
      nextCursor: offset + page.length < lights.length ? String(offset + page.length) : null,
      truncated: false,
    },
  };
}

export function materializeCameraFrameOperation(operation, { compiled, THREE, document } = {}) {
  if (operation?.op !== 'camera.frame' && operation?.type !== 'camera.frame') return operation;
  const shifted = value => {
    if (!operation.targetOffset) return value;
    return {
      min: value.min.map((component, axis) => component + operation.targetOffset[axis]),
      max: value.max.map((component, axis) => component + operation.targetOffset[axis]),
    };
  };
  if (operation.bounds !== undefined) {
    const result = { ...operation, bounds: shifted(operation.bounds) };
    delete result.targetOffset;
    return result;
  }
  if (!Array.isArray(operation.targetIds) || operation.targetIds.length === 0) {
    throw new StudioError('invalid_camera_frame_targets', 'camera.frame requires targetIds or explicit bounds.');
  }
  const { bounds, missing } = collectCameraFrameBounds(operation.targetIds, { compiled, THREE, document });
  if (missing.length > 0) {
    throw new StudioError(
      'camera_frame_target_not_compiled',
      `camera.frame target ${missing[0]} is not present in the active compiled revision or this apply's authored draft.`,
      { targetId: missing[0], missingTargetIds: missing },
    );
  }
  if (!bounds) {
    throw new StudioError('camera_frame_bounds_empty', 'camera.frame targetIds produced no renderable bounds.', {
      targetIds: structuredClone(operation.targetIds),
    });
  }
  const result = { ...operation, bounds: shifted(bounds) };
  delete result.targetOffset;
  return result;
}

function compactEntity(entity, include, { index, compiled, THREE } = {}) {
  const output = { id: entity.id, name: entity.name, kind: entity.kind, parentId: entity.parentId, visible: entity.visible };
  if (include.has('tree')) {
    output.children = [...entity.children];
    output.subtreeHash = index?.subtreeHash(entity.id);
  }
  if (include.has('transform')) output.transform = entity.transform;
  if (include.has('components')) output.components = entity.components;
  if (include.has('references')) output.referencesTo = index?.getReferencesTo(entity.id) ?? [];
  if (include.has('bounds')) {
    const object = compiled?.objects?.get(entity.id);
    if (object) {
      const bounds = new THREE.Box3().setFromObject(object);
      if (!bounds.isEmpty()) output.bounds = { min: bounds.min.toArray(), max: bounds.max.toArray() };
    }
  }
  if (entity.tags.length) output.tags = entity.tags;
  return output;
}

const RESOURCE_COMPONENT_ARRAY_LIMIT = 16;
const RESOURCE_COMPONENT_VALUE_BUDGET = 160;
const RESOURCE_COMPONENT_DEPTH_LIMIT = 5;
const LOFT_DIGEST_POINT_COORDINATE_BUDGET = 4096;
const RESOURCE_REFERENCE_LIMIT = 200;
const RESOURCE_TAG_LIMIT = 32;
const RESOURCE_DIGEST_RESPONSE_BYTE_BUDGET = MAX_INSPECT_RESPONSE_BYTES;
const RESOURCE_DIGEST_ENCODE = new TextEncoder();

function compactString(value, maximum = 256) {
  const source = String(value ?? '');
  return source.length <= maximum ? source : `${source.slice(0, maximum - 1)}\u2026`;
}

function resourceTags(resource) {
  const values = [
    ...(Array.isArray(resource?.tags) ? resource.tags : []),
    ...(Array.isArray(resource?.metadata?.tags) ? resource.metadata.tags : []),
  ].filter(value => typeof value === 'string');
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function geometryRecipe(resource) {
  const nested = resource?.recipe ?? resource?.parameters;
  return isRecord(nested) ? nested : resource;
}

function geometryArray(recipe, directKey, attributeKey) {
  const direct = recipe?.[directKey];
  if (Array.isArray(direct)) return direct;
  const attribute = recipe?.attributes?.[attributeKey];
  return Array.isArray(attribute) ? attribute : undefined;
}

function numericItemSize(key, values, parent) {
  const normalized = String(key).toLowerCase();
  if (['positions', 'position', 'normals', 'normal', 'tangents', 'tangent'].includes(normalized)) return 3;
  if (['uvs', 'uv'].includes(normalized)) return 2;
  if (['indices', 'index', 'times'].includes(normalized)) return 1;
  if (['colors', 'color'].includes(normalized)) {
    const positions = parent?.positions ?? parent?.position;
    const vertexCount = Array.isArray(positions) ? positions.length / 3 : 0;
    const inferred = vertexCount > 0 ? values.length / vertexCount : 0;
    if (inferred === 3 || inferred === 4) return inferred;
    return 3;
  }
  if (values.every(Number.isFinite)) return 1;
  if (values.length && values.every(value => Array.isArray(value) && value.length === values[0].length)) {
    return values[0].length;
  }
  return undefined;
}

function shouldSummarizeArray(key, values) {
  if (String(key).toLowerCase() === 'sections') return false;
  return values.length > RESOURCE_COMPONENT_ARRAY_LIMIT
    || ['positions', 'position', 'normals', 'normal', 'tangents', 'tangent', 'uvs', 'uv', 'colors', 'color', 'indices', 'index']
      .includes(String(key).toLowerCase());
}

function compactComponentValue(value, key, parent, state, depth = 0) {
  if (state.remaining <= 0) return { truncated: true };
  state.remaining -= 1;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return compactString(value);
  if (Array.isArray(value)) {
    if (shouldSummarizeArray(key, value)) {
      const itemSize = numericItemSize(key, value, parent);
      return { length: value.length, ...(itemSize === undefined ? {} : { itemSize }) };
    }
    const result = [];
    for (const item of value) {
      if (state.remaining <= 0) break;
      result.push(compactComponentValue(item, '', value, state, depth + 1));
    }
    if (result.length < value.length) result.push({ omitted: value.length - result.length });
    return result;
  }
  if (!isRecord(value)) return compactString(value);
  const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
  if (depth >= RESOURCE_COMPONENT_DEPTH_LIMIT) return { keyCount: keys.length, truncated: keys.length > 0 };
  const result = {};
  let included = 0;
  for (const childKey of keys) {
    if (state.remaining <= 0) break;
    result[childKey] = compactComponentValue(value[childKey], childKey, value, state, depth + 1);
    included += 1;
  }
  if (included < keys.length) result.omittedKeyCount = keys.length - included;
  return result;
}

function compactResourceComponents(resource) {
  const identity = new Set(['id', 'name', 'kind', 'tags']);
  let values = Object.fromEntries(
    Object.keys(resource)
      .filter(key => !identity.has(key))
      .sort((a, b) => a.localeCompare(b))
      .map(key => [key, resource[key]]),
  );
  const recipe = geometryRecipe(resource);
  if (recipe?.kind === 'loft' && isRecord(values.recipe) && Array.isArray(values.recipe.sections)) {
    values = {
      ...values,
      recipe: {
        ...values.recipe,
        sections: buildLoftDigest(recipe, { includePoints: false }).sections,
      },
    };
  }
  return compactComponentValue(values, 'components', values, {
    remaining: RESOURCE_COMPONENT_VALUE_BUDGET,
  });
}

function normalizeLoftSections(sections) {
  if (!Array.isArray(sections)) return [];
  return sections.map((section, index) => {
    if (Array.isArray(section)) {
      return { id: `section/${index}`, points: section };
    }
    return {
      id: typeof section?.id === 'string' && section.id ? section.id : `section/${index}`,
      points: Array.isArray(section?.points) ? section.points : [],
      ...(isRecord(section?.transform) ? { transform: section.transform } : {}),
    };
  });
}

function controlPointCoordinates(point) {
  if (Array.isArray(point)) return point.filter(Number.isFinite);
  if (!isRecord(point)) return [];
  return ['x', 'y', 'z'].map(key => point[key]).filter(Number.isFinite);
}

function controlPointBounds(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  let valid = false;
  for (const point of points) {
    const coords = controlPointCoordinates(point);
    if (coords.length < 2) continue;
    valid = true;
    const x = coords[0];
    const y = coords[1];
    const z = coords[2] ?? 0;
    minimum[0] = Math.min(minimum[0], x);
    minimum[1] = Math.min(minimum[1], y);
    minimum[2] = Math.min(minimum[2], z);
    maximum[0] = Math.max(maximum[0], x);
    maximum[1] = Math.max(maximum[1], y);
    maximum[2] = Math.max(maximum[2], z);
  }
  return valid ? { min: minimum, max: maximum } : null;
}

export function buildLoftDigest(recipe, { includePoints = false } = {}) {
  const sections = normalizeLoftSections(recipe?.sections);
  let remaining = includePoints ? LOFT_DIGEST_POINT_COORDINATE_BUDGET : 0;
  return {
    sectionCount: sections.length,
    ...(recipe?.closedProfile === undefined ? {} : { closedProfile: recipe.closedProfile === true }),
    ...(recipe?.capStart === undefined ? {} : { capStart: recipe.capStart !== false }),
    ...(recipe?.capEnd === undefined ? {} : { capEnd: recipe.capEnd !== false }),
    ...(recipe?.profileResolution === undefined ? {} : { profileResolution: recipe.profileResolution }),
    ...(recipe?.subdivisions === undefined ? {} : { subdivisions: recipe.subdivisions }),
    ...(recipe?.alignProfile === undefined ? {} : { alignProfile: recipe.alignProfile }),
    sections: sections.map((section, index) => {
      const points = Array.isArray(section.points) ? section.points : [];
      const coordinateCount = points.reduce((sum, point) => sum + controlPointCoordinates(point).length, 0);
      const summary = {
        id: section.id,
        index,
        pointCount: points.length,
        ...(section.transform ? { transform: section.transform } : {}),
      };
      const bounds = controlPointBounds(points);
      if (bounds) summary.localBounds = bounds;
      if (includePoints && remaining >= coordinateCount) {
        summary.points = points;
        remaining -= coordinateCount;
      } else if (includePoints) {
        summary.pointsOmitted = true;
      }
      return summary;
    }),
  };
}

function explicitGeometrySummary(resource, { includeBounds = false, includeControlPoints = false } = {}) {
  const recipe = geometryRecipe(resource);
  const recipeKind = recipe === resource
    ? (resource?.geometryKind ?? resource?.type ?? resource?.kind)
    : (recipe?.kind ?? recipe?.type ?? resource?.geometryKind ?? resource?.kind);
  const output = { recipeKind: compactString(recipeKind ?? 'box', 80) };
  if (recipeKind === 'loft') {
    output.loft = buildLoftDigest(recipe, { includePoints: includeControlPoints });
    return output;
  }
  if (!['explicit', 'indexedMesh'].includes(recipeKind)) return output;
  const positions = geometryArray(recipe, 'positions', 'position') ?? [];
  const indices = geometryArray(recipe, 'indices', 'index') ?? [];
  const normals = geometryArray(recipe, 'normals', 'normal');
  const uvs = geometryArray(recipe, 'uvs', 'uv');
  const colors = geometryArray(recipe, 'colors', 'color');
  const vertexCount = Math.floor(positions.length / 3);
  output.vertexCount = vertexCount;
  output.indexCount = indices.length;
  output.triangleCount = Math.floor((indices.length || vertexCount) / 3);
  output.hasNormals = Boolean(normals?.length);
  output.hasUVs = Boolean(uvs?.length);
  output.hasColors = Boolean(colors?.length);
  output.computeNormals = recipe.computeNormals !== false;
  if (includeBounds && vertexCount > 0) {
    const minimum = [Infinity, Infinity, Infinity];
    const maximum = [-Infinity, -Infinity, -Infinity];
    let valid = true;
    for (let offset = 0; offset + 2 < positions.length; offset += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = positions[offset + axis];
        if (!Number.isFinite(value)) {
          valid = false;
          break;
        }
        minimum[axis] = Math.min(minimum[axis], value);
        maximum[axis] = Math.max(maximum[axis], value);
      }
      if (!valid) break;
    }
    if (valid) output.localBounds = { min: minimum, max: maximum };
  }
  return output;
}

function dataTextureSummary(resource) {
  const authored = resource?.recipe ?? resource?.parameters;
  if (!isRecord(authored) || (authored.kind ?? authored.type) !== 'dataTexture') {
    return {
      recipeKind: compactString(authored?.kind ?? authored?.type ?? resource?.kind ?? 'texture', 80),
      liveRaster: false,
      legacyPlaceholder: true,
    };
  }
  const recipe = normalizeDataTextureResource(authored);
  return {
    recipeKind: recipe.kind,
    liveRaster: true,
    width: recipe.width,
    height: recipe.height,
    channels: recipe.channels,
    decodedBytes: recipe.width * recipe.height * recipe.channels,
    gpuBytes: dataTextureGpuByteLength(recipe),
    sourceEncoding: recipe.data === undefined ? 'numeric-bytes' : 'base64',
    colorSpace: recipe.colorSpace,
    sampler: {
      wrapS: recipe.wrapS,
      wrapT: recipe.wrapT,
      minFilter: recipe.minFilter,
      magFilter: recipe.magFilter,
      anisotropy: recipe.anisotropy,
      flipY: recipe.flipY,
      generateMipmaps: recipe.generateMipmaps,
    },
  };
}

function resourceKindMatches(resourceType, resource, expectedKind) {
  if (!expectedKind) return true;
  const singularType = resourceType.endsWith('ies')
    ? `${resourceType.slice(0, -3)}y`
    : resourceType.endsWith('s') ? resourceType.slice(0, -1) : resourceType;
  return [resourceType, singularType, resource.kind].includes(expectedKind);
}

/** Builds one deterministic, bounded page of project-wide resource summaries. */
export function buildResourceDigest(document, params = {}) {
  const include = new Set(params.include ?? ['summary']);
  const selector = params.selector ?? {};
  const selectorIds = selector.ids ? new Set(selector.ids) : null;
  const selectorName = selector.name?.toLowerCase();
  const index = new ProjectIndex(document);
  const allResources = Object.entries(document.resources ?? {})
    .flatMap(([resourceType, table]) => Object.values(table ?? {}).map(resource => ({ resourceType, resource })))
    .sort((first, second) => (
      first.resourceType.localeCompare(second.resourceType)
      || first.resource.id.localeCompare(second.resource.id)
    ));
  const selected = allResources.filter(({ resourceType, resource }) => (
    (!selectorIds || selectorIds.has(resource.id))
    && (!selectorName || String(resource.name ?? '').toLowerCase().includes(selectorName))
    && resourceKindMatches(resourceType, resource, selector.kind)
    && (!selector.tag || resourceTags(resource).includes(selector.tag))
  ));
  const offset = Math.max(0, Number.parseInt(params.cursor ?? '0', 10) || 0);
  const limit = Math.min(200, Math.max(1, params.limit ?? 50));
  const summarize = ({ resourceType, resource }) => {
    const tags = resourceTags(resource);
    const summary = {
      id: resource.id,
      name: compactString(resource.name, 240),
      kind: compactString(resource.kind, 80),
      resourceType,
      resourceHash: contentHash(resource),
      ...(tags.length ? {
        tags: tags.slice(0, RESOURCE_TAG_LIMIT).map(tag => compactString(tag, 120)),
        ...(tags.length > RESOURCE_TAG_LIMIT ? { tagCount: tags.length } : {}),
      } : {}),
      ...(resourceType === 'geometries' ? explicitGeometrySummary(resource, {
        includeBounds: include.has('bounds'),
        includeControlPoints: include.has('components'),
      }) : {}),
      ...(resourceType === 'textures' ? dataTextureSummary(resource) : {}),
    };
    if (include.has('components')) {
      summary.components = resourceType === 'textures'
        ? { recipe: dataTextureSummary(resource), metadata: compactResourceComponents(resource.metadata ?? {}) }
        : compactResourceComponents(resource);
    }
    if (include.has('references')) {
      const references = index.getReferencesTo(resource.id);
      summary.referencesTo = references.slice(0, RESOURCE_REFERENCE_LIMIT);
      summary.referenceCount = references.length;
    }
    return summary;
  };
  const page = [];
  let responseBytes = 256;
  let nextOffset = offset;
  const requestedEnd = Math.min(selected.length, offset + limit);
  for (let index = offset; index < requestedEnd; index += 1) {
    const summary = summarize(selected[index]);
    const summaryBytes = RESOURCE_DIGEST_ENCODE.encode(JSON.stringify(summary)).byteLength + 1;
    if (responseBytes + summaryBytes > RESOURCE_DIGEST_RESPONSE_BYTE_BUDGET) {
      if (page.length > 0) break;
      const fallback = {
        id: summary.id,
        name: summary.name,
        kind: summary.kind,
        resourceType: summary.resourceType,
        resourceHash: summary.resourceHash,
        truncated: true,
        omittedSlices: ['components', 'bounds', 'references'],
      };
      page.push(fallback);
      responseBytes += RESOURCE_DIGEST_ENCODE.encode(JSON.stringify(fallback)).byteLength + 1;
      nextOffset = index + 1;
      break;
    }
    page.push(summary);
    responseBytes += summaryBytes;
    nextOffset = index + 1;
  }
  return {
    resourceCount: allResources.length,
    selectedResourceCount: selected.length,
    resources: page,
    estimatedResponseBytes: responseBytes,
    responseByteBudget: RESOURCE_DIGEST_RESPONSE_BYTE_BUDGET,
    nextCursor: nextOffset < selected.length ? String(nextOffset) : null,
  };
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export class StudioApplication {
  #THREE;
  #TSL;
  #viewport;
  #bootstrap;
  #kernel = null;
  #projectRoot = null;
  #compiled = null;
  #prepared = null;
  #dryRunCandidate = null;
  #pendingCandidateToken = null;
  #unsubscribe = null;
  #bridge = null;
  #credentials;
  #markerPath;
  #localStatePath;
  #heartbeat = null;
  #markerTail = Promise.resolve();
  #markerPublished = false;
  #exclusiveTail = Promise.resolve();
  #latestEvidence = null;
  #idempotency = new Map();
  #mode = 'author';
  #play = { paused: false, tick: 0, elapsed: 0, latestInput: null };
  #logicController = null;
  #disposed = false;
  #viewHash = null;
  #beginCommand = null;
  #commandMetrics = null;
  #activeApplyMetrics = null;

  constructor({ THREE, TSL, viewport, bootstrap, markerPath, credentials, beginCommand, commandMetrics, environment = process.env, projectsRoot } = {}) {
    this.#THREE = THREE;
    this.#TSL = TSL;
    this.#viewport = viewport;
    this.#bootstrap = bootstrap;
    this.#credentials = credentials ?? createSessionCredentials();
    this.#beginCommand = typeof beginCommand === 'function' ? beginCommand : null;
    this.#commandMetrics = typeof commandMetrics === 'function' ? commandMetrics : null;
    const env = environment ?? process.env;
    const studioRoot = env.THREE_STUDIO_ROOT ?? process.cwd();
    this.studioRoot = path.resolve(studioRoot);
    const configuredProjects = String(projectsRoot ?? env.THREE_STUDIO_PROJECTS ?? '').trim();
    this.projectsRoot = path.resolve(configuredProjects || path.join(this.studioRoot, 'projects'));
    this.#markerPath = path.resolve(markerPath ?? env.THREE_STUDIO_SESSION_MARKER ?? defaultSessionMarkerPath({ env }));
    this.#localStatePath = path.join(path.dirname(this.#markerPath), 'studio-state.json');
  }

  get sessionId() { return this.#credentials.sessionId; }
  get markerPath() { return this.#markerPath; }
  get kernel() { return this.#kernel; }

  getControllerStatus() {
    return this.#logicController?.status ?? Object.freeze({
      available: false, active: false, entityId: null, activationKey: null, heldKeys: [], graphCount: 0,
      physics: { available: false, bodyCount: 0, colliderCount: 0, activeContactCount: 0, diagnostics: [] },
      diagnostics: [], capture: null,
    });
  }

  #syncControllerState() {
    this.#viewport.setControllerState?.(this.getControllerStatus());
  }

  #createLogicController() {
    const project = this.#kernel?.document;
    const scene = project?.scenes?.[project.activeSceneId];
    this.#logicController = createLogicControllerRuntime({
      project,
      scene,
      objects: this.#compiled?.objects,
      animationRuntime: this.#compiled?.animationRuntime,
      setActiveCamera: entityId => {
        const camera = this.#compiled?.objects?.get?.(entityId);
        if (!camera?.isCamera) return false;
        this.#viewport.setAuthoredCamera?.(camera);
        this.#viewport.followShot?.();
        return true;
      },
    });
    this.#syncControllerState();
  }

  #stopLogicController({ restore = true } = {}) {
    const stopped = this.#logicController?.stop({ restore }) === true;
    if (stopped) {
      this.#mode = 'author';
      this.#play = { paused: false, tick: 0, elapsed: 0, latestInput: null };
    }
    this.#syncControllerState();
    return stopped;
  }

  controllerKeyDown(code, { repeat = false } = {}) {
    const key = String(code ?? '');
    if (key === 'Escape' && this.#logicController?.active) {
      this.#stopLogicController();
      return { handled: true, action: 'deactivated', ...this.getControllerStatus() };
    }
    if (!this.#logicController?.active) {
      if (key !== this.#logicController?.settings?.activationKey || repeat) return { handled: false, ...this.getControllerStatus() };
      if (!this.#logicController.activate()) return { handled: false, ...this.getControllerStatus() };
      this.#mode = 'play';
      this.#play = { paused: false, tick: 0, elapsed: 0, latestInput: null };
      this.#syncControllerState();
      return { handled: true, action: 'activated', ...this.getControllerStatus() };
    }
    const handled = this.#logicController.keyDown(key, { repeat });
    this.#syncControllerState();
    return { handled, action: 'input', ...this.getControllerStatus() };
  }

  controllerKeyUp(code) {
    if (!this.#logicController?.active) return { handled: false, ...this.getControllerStatus() };
    const handled = this.#logicController.keyUp(String(code ?? ''));
    this.#syncControllerState();
    return { handled, action: 'input', ...this.getControllerStatus() };
  }

  releaseControllerKeys() {
    this.#logicController?.releaseKeys();
    this.#syncControllerState();
  }

  getActiveSceneRtxSettings() {
    if (!this.#kernel) return {};
    const document = this.#kernel.document;
    return structuredClone(document.scenes[document.activeSceneId]?.settings?.rtx ?? {});
  }

  patchActiveSceneRtx(patch = {}) {
    return this.#exclusive(async () => {
      if (!this.#kernel) throw new StudioError('project_not_open', 'No project is open.');
      if (!isRecord(patch)) {
        throw new StudioError('invalid_rtx_configuration', 'RTX settings patch must be an object.');
      }
      const document = this.#kernel.document;
      const sceneId = document.activeSceneId;
      return this.#apply({
        protocolVersion: PROTOCOL_VERSION,
        projectId: document.projectId,
        baseRevision: document.revision,
        idempotencyKey: createTransactionId('ui-rtx'),
        label: 'Update RTX settings from Studio',
        dryRun: false,
        operations: [{ op: 'scene.rtx.patch', sceneId, patch: structuredClone(patch) }],
      });
    });
  }

  async start({ projectPath = process.env.THREE_STUDIO_PROJECT } = {}) {
    await secureSessionMarkerDirectory(path.dirname(this.#markerPath));
    let rememberedProject = null;
    if (!projectPath) {
      try {
        const state = JSON.parse(await readFile(this.#localStatePath, 'utf8'));
        if (typeof state.lastProjectPath === 'string' && state.lastProjectPath.length <= 1024) rememberedProject = state.lastProjectPath;
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) console.warn('[ThreeBrowser Studio state]', error.message);
      }
      if (rememberedProject && !(await pathExists(path.join(rememberedProject, 'project.threestudio.json')))) rememberedProject = null;
    }
    const initial = path.resolve(projectPath ?? rememberedProject ?? path.join(this.projectsRoot, 'live'));
    await this.#openOrCreate(initial, { create: true, name: 'Live Studio Project', template: 'starter' });
    this.#bridge = await createLiveBridgeServer({
      credentials: this.#credentials,
      serverInfo: { toolContract: TOOL_CONTRACT },
      requestTimeoutMs: MAX_REQUEST_TIMEOUT_MS,
      dispatch: (method, params, context) => this.dispatch(method, params, context),
      beginCommand: this.#beginCommand,
      onError: error => console.error('[ThreeBrowser Studio bridge]', error.message),
    });
    await this.#writeMarker(true, { required: true });
    this.#heartbeat = setInterval(() => {
      void this.#writeMarker(true);
      void this.#writeView();
    }, 5_000);
    this.#heartbeat.unref?.();
    console.log(`[ThreeBrowser Studio] live control: ${this.#credentials.pipePath}`);
    console.log(`[ThreeBrowser Studio] MCP marker: ${this.#markerPath}`);
    return this;
  }

  exportProjectDocument() {
    return this.#exclusive(async () => {
      if (!this.#kernel) throw new StudioError('project_not_open', 'No project is open.');
      return createProjectPack(this.#kernel.document);
    });
  }

  importProjectDocument(source) {
    return this.#exclusive(async () => {
      const document = parseProjectPack(source);
      const folder = projectImportFolderName(document.name);
      const root = this.#managedProjectPath(path.join('imports', folder));
      if (await pathExists(path.join(root, 'project.threestudio.json'))) {
        throw new StudioError('project_exists', `A Studio project already exists at ${root}.`);
      }
      const store = new AtomicProjectStore(root);
      const projectId = `project/${path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'import'}`;
      const created = createProjectDocument({
        ...document,
        projectId,
        name: document.name,
        revision: 0,
        savedRevision: 0,
        scriptTrustPolicy: 'agent-safe',
      });
      await store.save(created);
      return this.#openOrCreate(root, { create: false });
    });
  }

  #aspect() {
    const canvas = this.#viewport.renderer.domElement;
    return Math.max(1, canvas.width || innerWidth) / Math.max(1, canvas.height || innerHeight);
  }

  async #compile(document) {
    const compiled = compileSceneDocument({ THREE: this.#THREE, TSL: this.#TSL, project: document, aspect: this.#aspect() });
    const errors = compiled.diagnostics.filter(item => item.severity === 'error');
    if (errors.length) {
      compiled.dispose();
      throw new StudioError('runtime_compile_failed', 'The candidate scene did not compile.', { diagnostics: errors });
    }
    if (typeof this.#viewport.renderer.compileAsync === 'function' && compiled.activeCamera) {
      const stagingScene = new this.#THREE.Scene();
      stagingScene.add(compiled.root);
      stagingScene.background = compiled.background;
      stagingScene.backgroundNode = compiled.backgroundNode;
      stagingScene.fog = compiled.fog;
      try {
        await this.#viewport.renderer.compileAsync(stagingScene, compiled.activeCamera);
      } catch (error) {
        compiled.dispose();
        throw new StudioError('runtime_pipeline_failed', 'WebGPU pipeline preparation failed.', {
          diagnostics: [{ severity: 'error', code: 'runtime_pipeline_failed', message: error.message }],
        });
      } finally {
        compiled.root.removeFromParent();
        stagingScene.background = null;
        stagingScene.backgroundNode = null;
        stagingScene.fog = null;
      }
    }
    return compiled;
  }

  async #prepare(document, context = {}) {
    if (context.dryRun !== true
        && this.#pendingCandidateToken
        && this.#dryRunCandidate?.token === this.#pendingCandidateToken) {
      this.#prepared?.dispose();
      this.#prepared = this.#dryRunCandidate.compiled;
      this.#dryRunCandidate = null;
      if (this.#activeApplyMetrics) this.#activeApplyMetrics.promotedCandidate = true;
      return;
    }
    if (context.dryRun !== true && this.#dryRunCandidate) {
      this.#dryRunCandidate.compiled.dispose();
      this.#dryRunCandidate = null;
    }
    const compileStarted = monotonicMilliseconds();
    let candidate;
    try {
      candidate = await this.#compile(document);
    } finally {
      if (this.#activeApplyMetrics) {
        this.#activeApplyMetrics.compileCount += 1;
        this.#activeApplyMetrics.compileMs += monotonicMilliseconds() - compileStarted;
      }
    }
    if (context.dryRun === true) {
      this.#dryRunCandidate?.compiled.dispose();
      this.#dryRunCandidate = this.#pendingCandidateToken
        ? { token: this.#pendingCandidateToken, compiled: candidate }
        : null;
      if (!this.#dryRunCandidate) candidate.dispose();
      return;
    }
    this.#prepared?.dispose();
    this.#prepared = candidate;
  }

  async #swapPrepared({ immediate = false } = {}) {
    const next = this.#prepared;
    if (!next) return;
    this.#prepared = null;
    if (!immediate) await new Promise(resolve => (globalThis.requestAnimationFrame ?? (callback => setTimeout(callback, 0)))(resolve));
    if (this.#logicController?.active) this.#stopLogicController();
    this.#bootstrap?.dispose();
    this.#bootstrap = null;
    this.#viewport.scene.add(next.root);
    if (typeof this.#viewport.setAppearance === 'function') {
      this.#viewport.setAppearance(next);
    } else {
      this.#viewport.scene.background = next.background;
      this.#viewport.scene.backgroundNode = next.backgroundNode;
      this.#viewport.scene.fog = next.fog;
    }
    if (typeof this.#viewport.setAuthoredCamera === 'function') {
      this.#viewport.setAuthoredCamera(next.activeCamera ?? this.#viewport.camera);
    } else {
      this.#viewport.setRenderCamera(next.activeCamera ?? this.#viewport.camera);
    }
    const previous = this.#compiled;
    this.#compiled = next;
    this.#createLogicController();
    if (this.#mode !== 'play') {
      for (const action of next.animationRuntime?.actions.values() ?? []) {
        next.animationRuntime.pause(action.id);
      }
    }
    const document = this.#kernel.document;
    const scene = document.scenes[document.activeSceneId];
    if (typeof this.#viewport.configureRtx === 'function') {
      next.root.updateWorldMatrix?.(true, true);
      void Promise.resolve(this.#viewport.configureRtx({
        root: next.root,
        settings: scene?.settings?.rtx ?? {},
      })).catch(error => console.warn('[ThreeBrowser Studio RTX]', error.message));
    }
    previous?.dispose();
    this.#viewport.setTitle({ project: document.name, scene: scene?.name, revision: document.revision, dirty: this.#kernel.dirty });
    this.#viewport.setExplorerOutline?.(buildExplorerOutline(document));
    if (this.#bridge) await this.#writeMarker(true);
  }

  #viewSnapshot() {
    if (!this.#kernel) return null;
    const reviewCamera = this.#viewport.camera;
    return {
      kind: 'ThreeStudioView',
      version: 1,
      projectId: this.#kernel.projectId,
      reviewCamera: {
        position: reviewCamera.position.toArray(),
        quaternion: reviewCamera.quaternion.toArray(),
        target: this.#viewport.controls.target.toArray(),
      },
      viewMode: this.#viewport.viewMode ?? 'follow-shot',
      renderCameraId: this.#viewport.authoredCamera?.userData?.studioEntityId
        ?? this.#viewport.renderCamera?.userData?.studioEntityId
        ?? 'review-camera',
      latestEvidence: this.#latestEvidence,
      authoringTelemetry: this.#commandMetrics?.() ?? null,
    };
  }

  async #writeView() {
    const view = this.#viewSnapshot();
    if (!view || !this.#kernel?.store) return;
    const hash = contentHash(view);
    if (hash === this.#viewHash) return;
    await this.#kernel.store.writeView(view);
    this.#viewHash = hash;
  }

  #restoreView(view) {
    if (!isRecord(view) || view.kind !== 'ThreeStudioView' || view.projectId !== this.#kernel.projectId) return;
    const cameraState = view.reviewCamera;
    const finiteArray = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);
    if (isRecord(cameraState)
        && finiteArray(cameraState.position, 3)
        && finiteArray(cameraState.quaternion, 4)
        && finiteArray(cameraState.target, 3)) {
      this.#viewport.camera.position.fromArray(cameraState.position);
      this.#viewport.camera.quaternion.fromArray(cameraState.quaternion);
      this.#viewport.controls.target.fromArray(cameraState.target);
      this.#viewport.camera.updateMatrixWorld(true);
      this.#viewport.controls.syncFromCamera();
    }
    const authoredCamera = view.renderCameraId === 'review-camera'
      ? this.#viewport.camera
      : this.#compiled?.objects.get(view.renderCameraId);
    if (authoredCamera?.isCamera) {
      if (typeof this.#viewport.setAuthoredCamera === 'function') this.#viewport.setAuthoredCamera(authoredCamera);
      else this.#viewport.setRenderCamera(authoredCamera);
    }
    if (view.viewMode === 'review') this.#viewport.enterReview?.({ seedFromAuthored: false });
    else this.#viewport.followShot?.();
    if (isRecord(view.latestEvidence)) this.#latestEvidence = view.latestEvidence;
    this.#viewHash = contentHash(view);
  }

  async #attachKernel(kernel, projectRoot) {
    const candidate = await this.#compile(kernel.document);
    const view = await kernel.store?.readView().catch(() => ({})) ?? {};
    await this.#writeView().catch(error => console.warn('[ThreeBrowser Studio view]', error.message));
    const previousUnsubscribe = this.#unsubscribe;
    previousUnsubscribe?.();
    this.#prepared?.dispose();
    this.#dryRunCandidate?.compiled.dispose();
    this.#dryRunCandidate = null;
    this.#prepared = candidate;
    this.#kernel = kernel;
    this.#projectRoot = projectRoot;
    this.#unsubscribe = kernel.subscribe(async () => this.#swapPrepared());
    await this.#swapPrepared({ immediate: true });
    this.#restoreView(view);
    await atomicWriteJson(this.#localStatePath, {
      kind: 'ThreeStudioLocalState',
      version: 1,
      lastProjectPath: this.#projectRoot,
    }).catch(error => console.warn('[ThreeBrowser Studio state]', error.message));
  }

  async #openOrCreate(projectRoot, { create = false, name = 'Untitled Project', template = null, mustBeNew = false } = {}) {
    const root = path.resolve(projectRoot);
    const manifest = path.join(root, 'project.threestudio.json');
    let kernel;
    if (await pathExists(manifest)) {
      if (mustBeNew) throw new StudioError('project_exists', `A Studio project already exists at ${root}.`);
      ({ kernel } = await AuthoringKernel.open(root, { prepare: (document, context) => this.#prepare(document, context) }));
    } else {
      if (!create) throw new StudioError('project_not_found', `No Studio project exists at ${root}.`);
      if (mustBeNew && await pathExists(root)) {
        if ((await lstat(root)).isSymbolicLink()) throw new StudioError('project_symlink', 'Project destinations cannot be symbolic links.', { path: root });
        const entries = await readdir(root);
        if (entries.length > 0) {
          throw new StudioError('project_destination_not_empty', 'A new project requires an empty destination inside the managed projects directory.', { path: root });
        }
      }
      const store = new AtomicProjectStore(root);
      const projectId = `project/${path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'untitled'}`;
      let created;
      if (template === 'starter') {
        const templateStore = new AtomicProjectStore(path.join(this.studioRoot, 'templates', 'starter-project'));
        const loaded = await templateStore.load();
        created = createProjectDocument({ ...loaded.document, projectId, name, revision: 0, savedRevision: 0 });
      } else created = createBlankProjectDocument({ projectId, name });
      const saved = await store.save(created);
      kernel = new AuthoringKernel(saved.document, { store, prepare: (document, context) => this.#prepare(document, context) });
    }
    await this.#attachKernel(kernel, root);
    return kernel.status();
  }

  #managedProjectPath(requestedPath) {
    const resolved = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(this.projectsRoot, requestedPath);
    if (!pathIsInside(this.projectsRoot, resolved)) {
      throw new StudioError('project_path_forbidden', 'MCP project paths must remain inside the managed projects directory.', {
        projectsRoot: this.projectsRoot,
      });
    }
    return resolved;
  }

  #assertSession(params) {
    if (params.sessionId !== undefined && params.sessionId !== this.sessionId) throw new StudioError('session_mismatch', 'Request targets another Studio session.');
  }

  #assertTarget(params, { requireActiveScene = false } = {}) {
    if (params.projectId !== undefined && params.projectId !== this.#kernel.projectId) {
      throw new StudioError('project_mismatch', `Active project is ${this.#kernel.projectId}.`);
    }
    if (params.sceneId !== undefined) {
      if (!this.#kernel.document.scenes[params.sceneId]) throw new StudioError('scene_not_found', `Scene ${params.sceneId} does not exist.`);
      if (requireActiveScene && params.sceneId !== this.#kernel.document.activeSceneId) {
        throw new StudioError('scene_not_active', 'The lean renderer only captures the active compiled scene.');
      }
    }
  }

  #assertNotAborted(signal) {
    if (signal?.aborted) throw signal.reason ?? new StudioError('cancelled', 'Studio request was cancelled before execution.');
  }

  #exclusive(work) {
    const result = this.#exclusiveTail.then(work, work);
    this.#exclusiveTail = result.catch(() => {});
    return result;
  }

  status() {
    const status = this.#kernel.status();
    const canvas = this.#viewport.renderer.domElement;
    const authoredCamera = this.#viewport.authoredCamera ?? this.#viewport.renderCamera;
    const cameraId = authoredCamera?.userData?.studioEntityId ?? 'review-camera';
    const windowCamera = this.#viewport.renderCamera;
    const windowCameraId = windowCamera?.userData?.studioEntityId ?? 'review-camera';
    const width = Math.max(1, Number(canvas?.clientWidth || canvas?.width || 1));
    const height = Math.max(1, Number(canvas?.clientHeight || canvas?.height || 1));
    const effectiveCamera = describeEffectiveCamera(
      authoredCamera,
      authoredCameraEvidenceOptions(this.#kernel.document, authoredCamera, cameraId),
    );
    const rtx = this.#viewport.getRtxStatus?.() ?? {
      supported: false,
      requested: false,
      configured: false,
      building: false,
      active: false,
      stale: false,
      failed: false,
      reason: 'native ray-query controller is unavailable',
    };
    return {
      success: true,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      pid: process.pid,
      projectPath: this.#projectRoot,
      ...status,
      sceneId: status.activeSceneId,
      mode: this.#mode,
      play: {
        ...this.#play,
        simulation: 'actions-controller-physics-and-timeline-modifiers',
        actions: this.#compiled?.animationStates() ?? [],
        timelineGeometryModifierIds: this.#compiled?.timelineGeometryModifierIds ?? [],
        timelineGeometrySampleCount: this.#compiled?.timelineGeometrySampleCount ?? 0,
        controller: this.getControllerStatus(),
      },
      viewport: {
        ready: true,
        renderer: 'webgpu',
        cameraId,
        viewMode: this.#viewport.viewMode ?? 'follow-shot',
        windowCameraId,
        width,
        height,
        aspect: width / height,
        effectiveCamera,
        rtx,
      },
      rtx,
      capabilities: {
        webgpu: this.#viewport.renderer.backend?.isWebGPUBackend === true,
        shadows: this.#viewport.renderer.shadowMap.enabled === true,
        rtx: rtx.supported === true,
        rtxLighting: rtx.supported === true,
        rtxShadows: rtx.supported === true,
        rtxAmbientOcclusion: rtx.supported === true,
        liveSceneCompilation: true,
        behaviorRuntime: false,
        controllerRuntime: true,
        logicRuntime: {
          domain: 'blueprint',
          events: ['Create', 'Activate', 'Deactivate', 'Step', 'Fixed Step', 'Key Pressed', 'Key Down', 'Key Up', 'Collision Enter', 'Collision Exit', 'Custom Event'],
          actions: ['componentQuery', 'state', 'transform', 'visibility', 'speed', 'angularSpeed', 'rigidBody', 'animation', 'cameraControl', 'customEvent'],
          globalExitKey: 'Escape',
          runtimeOnly: true,
          limits: LOGIC_CONTROLLER_LIMITS,
        },
        componentRuntime: {
          model: 'entity-components',
          executable: ['logic', 'camera', 'rigidBody', 'collider', 'animation'],
          rigidBodyTypes: ['dynamic', 'kinematic', 'static'],
          colliderShapes: ['box', 'sphere', 'ramp', 'mesh'],
          collisionEvents: ['enter', 'exit'],
        },
        graphCompilation: Boolean(this.#TSL),
        graphRuntime: this.#TSL ? 'three-tsl-webgpu' : null,
        proceduralTextureBake: true,
        graphValidation: true,
        blenderShaderNodes: BLENDER_SHADER_NODE_INVENTORY_SUMMARY,
        blenderCatalog: true,
        blenderCatalogSummary: BLENDER_CATALOG_SUMMARY,
        operationCatalog: true,
        geometryCatalog: true,
        lookCatalog: true,
        lightingDigest: true,
        loftSectionDigest: true,
        materialLookPatch: true,
        sameTransactionCameraFrame: true,
        cameraDistanceScale: true,
        animationRuntime: Boolean(this.#compiled?.animationRuntime),
        animationActions: this.#compiled?.animationActions ?? [],
        timelineGeometryRuntime: true,
        timelineGeometryModifierTypes: ['ocean'],
        timelineGeometryMaxSamples: GEOMETRY_MODIFIER_LIMITS.maxOceanTimelineSamples,
        dynamicRtxGeometry: 'excluded-from-static-scene',
        jobs: true,
        jobKinds: ['textureBake', 'sceneExport'],
        projectTemplates: ['blank', 'starter'],
        graphDomains: ['shader', 'texture', 'blueprint'],
        entityKinds: [
          'scene', 'group', 'empty', 'gameObject', 'mesh', 'instancedMesh',
          'perspectiveCamera', 'orthographicCamera', 'directionalLight',
          'pointLight', 'spotLight', 'ambientLight', 'areaLight', 'hemisphereLight',
        ],
        geometryRecipes: ['box', 'plane', 'sphere', 'capsule', 'circle', 'cone', 'cylinder', 'torus', 'torusKnot', 'lathe', 'tube', 'loft', 'shape', 'extrude', 'csg', 'explicit', 'indexedMesh', 'editableMesh'],
        geometryEditing: true,
        geometryEditCommands: [...GEOMETRY_EDIT_COMMAND_TYPES],
        editableMesh: {
          topology: 'polygon-corner-csr',
          topologyHashGuards: true,
          uvLayers: { storage: true, topologyPropagation: true, directEditing: true, viewportLayer: 'active-only' },
          colorLayers: { storage: true, topologyPropagation: true, directEditing: true, viewportLayer: 'active-only' },
          materialSlots: { storage: true, topologyPropagation: true, directEditing: true },
          sharpEdges: { storage: true, topologyPropagation: true, directEditing: true },
          edgeCreases: { storage: true, topologyPropagation: true, directEditing: true, viewport: 'storage-editing-only' },
          liveGeometryModifiers: 'indexed-mesh-and-seam-safe-editable-lowering',
          liveEditableMeshGeometryModifiers: [...LIVE_EDITABLE_MESH_GEOMETRY_MODIFIERS],
        },
        imageTextures: {
          resourceKind: 'dataTexture',
          authoring: {
            operation: { op: 'resource.create', resourceType: 'texture' },
            canonicalEnvelope: {
              id: 'texture/<stable-id>',
              kind: 'texture',
              recipe: { kind: 'dataTexture', width: 1, height: 1, channels: 4, data: '<canonical-padded-base64>' },
            },
            requiredRecipeFields: ['kind', 'width', 'height', 'channels', 'pixels|data'],
            sourceAlternatives: [{ pixels: '<byte-array>' }, { data: '<canonical-padded-base64>' }],
            optionalRecipeFields: ['name', 'colorSpace', 'wrapS', 'wrapT', 'minFilter', 'magFilter', 'anisotropy', 'flipY', 'generateMipmaps'],
            defaults: {
              colorSpace: 'srgb', wrapS: 'clamp', wrapT: 'clamp',
              minFilter: 'linearMipmapLinear', magFilter: 'linear', anisotropy: 4,
              flipY: false, generateMipmaps: true,
            },
            base64: 'canonical-padded-no-data-uri-no-whitespace',
            patchShape: 'recipe fields may be nested under recipe or supplied directly; never mix both forms',
            sourceSwap: 'setting non-null pixels clears data; setting non-null data clears pixels',
            legacyPlaceholders: 'preserved-for-format-v1-but-not-live-raster',
          },
          sourceEncodings: ['numeric-bytes', 'base64'],
          sourceChannels: [1, 2, 3, 4],
          gpuFormat: 'rgba8',
          uvChannel: 0,
          uvLayer: 'active-only',
          colorSpaces: ['srgb', 'linear', 'none'],
          materialSlots: MATERIAL_TEXTURE_BINDINGS.map(binding => binding.idKey),
          materialBindings: MATERIAL_TEXTURE_BINDINGS.map(binding => ({
            idKey: binding.idKey,
            aliases: binding.aliases,
            materialKinds: binding.kinds,
            colorSpace: binding.colorSpace,
            preferredColorSpace: binding.colorSpace,
            allowedColorSpaces: binding.colorSpaces,
            allowedSourceChannels: binding.allowedChannels,
          })),
          graphSamplerNode: 'texture.sample2d',
          imageAssetNode: 'cpu-bake-only',
          directMapGraphConflictPolicy: 'reject-overlap',
          mapAwareNeutralDefaults: true,
          materialControls: MATERIAL_TEXTURE_CONTROL_CONTRACT,
          perMaterialTextureTransforms: 'use-graph-uv-nodes',
          sharedRuntimeCache: true,
          exactDisposal: true,
          rasterMaterialShading: true,
          rtxHitShading: false,
          limits: DATA_TEXTURE_LIMITS,
        },
        maxGeometryEditCommands: 64,
        exactBulkEntityEditing: true,
        maxExactEntitySelection: 200,
        transformGrouping: true,
        organizationalCollections: true,
        materialRecipes: ['basic', 'standard', 'physical', 'toon'],
        modifierRuntime: [...LIVE_INSTANCE_MODIFIER_TYPES],
        geometryModifierRuntime: [...GEOMETRY_MODIFIER_TYPES],
        modifierAuthoring: {
          types: [...AUTHORABLE_MODIFIER_TYPES],
          maxStackEntries: MAX_MODIFIERS_PER_ENTITY,
          exactStackHashGuards: true,
          atomicStackEditing: true,
          bakeBoundary: 'validated-blender-operator-type',
          renderEnableFlag: 'authored-only-no-render-parity-claim',
        },
        layoutGenerators: true,
        layoutPatterns: [...LAYOUT_PATTERN_MODES],
        cameraFraming: true,
        persistentCameraShots: true,
        constraintRuntime: ['lookAt', 'trackTo', 'copyLocation', 'copyRotation', 'copyScale', 'limitLocation'],
        animationProperties: ['transform.position', 'transform.rotation', 'transform.scale', 'visible'],
        animationInterpolation: ['constant', 'linear', 'smooth', 'bezier'],
        animationLoops: ['once', 'repeat', 'pingpong'],
        renderers: ['webgpu'],
        renderPasses: ['beauty', 'raster', 'objectId', 'albedo', 'roughness', 'normal', 'uv'],
        viewportReviewMode: true,
        overlayInvalidation: true,
        applyPixelForecast: true,
        compileHeavyRpcTimeoutMs: 120_000,
        validationChecks: ['schemas', 'references', 'hierarchy', 'graphs', 'animations', 'budgets'],
        projectActions: ['list', 'create', 'open', 'save'],
        historyActions: ['list', 'inspect', 'undo', 'redo'],
        playSimulation: 'actions-controller-physics-and-timeline-modifiers',
        maxShadowLights: 16,
        maxOperations: 128,
        implementedOperations: [...OPERATION_TYPES],
        toolContract: TOOL_CONTRACT_SUMMARY,
      },
      latestEvidence: this.#latestEvidence,
      authoringTelemetry: this.#commandMetrics?.() ?? emptyStudioCommandMetrics(),
    };
  }

  async dispatch(method, rawParams = {}, context = {}) {
    const params = parseToolParams(method, rawParams);
    this.#assertSession(params);
    this.#assertNotAborted(context.signal);
    const exclusive = work => this.#exclusive(() => {
      this.#assertNotAborted(context.signal);
      return work();
    });
    switch (method) {
      case 'three_studio_status': return shapeToolResponse(this.status(), {
        select: params.select,
        defaultSelect: params.preset === 'full' ? undefined : STATUS_SELECT_PRESETS[params.preset],
        format: params.format,
        ifHash: params.ifHash,
        preset: params.preset,
      });
      case 'three_studio_project': return params.action === 'list'
        ? this.#project(params)
        : this.#idempotent(params, () => exclusive(() => this.#project(params)));
      case 'three_studio_inspect': return this.#inspect(params);
      case 'three_studio_apply': return exclusive(() => this.#apply(params, context));
      case 'three_studio_validate': return this.#validate(params);
      case 'three_studio_render': return exclusive(() => this.#render(params));
      case 'three_studio_history': return ['undo', 'redo'].includes(params.action)
        ? exclusive(() => this.#history(params))
        : this.#history(params);
      case 'three_studio_play': return params.action === 'query'
        ? this.#playTool(params)
        : this.#idempotent(params, () => exclusive(() => this.#playTool(params)));
      case 'three_studio_job': return this.#idempotent(params, () => exclusive(() => this.#job(params, context)));
      default: throw new StudioError('method_not_found', `Unknown Studio method ${method}.`);
    }
  }

  async #idempotent(params, work) {
    const key = required(params.idempotencyKey, 'idempotencyKey');
    const fingerprint = contentHash(params);
    const existing = this.#idempotency.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new StudioError('idempotency_conflict', `Idempotency key ${key} was used for another request.`);
      return structuredClone(await existing.promise);
    }
    const promise = Promise.resolve().then(work);
    this.#idempotency.set(key, { fingerprint, promise });
    if (this.#idempotency.size > 1_000) this.#idempotency.delete(this.#idempotency.keys().next().value);
    try {
      return structuredClone(await promise);
    } catch (error) {
      this.#idempotency.delete(key);
      throw error;
    }
  }

  async #job(params, context = {}) {
    this.#assertTarget(params, { requireActiveScene: false });
    if (params.action === 'sceneExport') return this.#exportScene(params);
    if (params.action !== 'textureBake') throw new StudioError('job_not_implemented', `Job ${params.action} is not enabled.`);
    const resource = this.#kernel.document.resources?.graphs?.[params.graphId];
    if (!resource) throw new StudioError('not_found', `Graph ${params.graphId} does not exist.`, { id: params.graphId, kind: 'graph' });
    const bake = bakeProceduralTextureGraph(resource.graph ?? resource, {
      bake: {
        resolution: params.resolution,
        outputs: [params.output],
        signal: context.signal,
      },
    });
    const map = bake.maps[params.output];
    if (!map || !(map.data instanceof Uint8Array)) {
      throw new StudioError('texture_bake_output_unsupported', `Output ${params.output} did not produce an 8-bit raster map.`);
    }
    const result = await this.#apply({
      protocolVersion: params.protocolVersion,
      sessionId: params.sessionId,
      projectId: params.projectId,
      baseRevision: params.baseRevision,
      idempotencyKey: params.idempotencyKey,
      label: params.label,
      operations: [{
        op: 'resource.create',
        resourceType: 'texture',
        resource: {
          id: params.textureId,
          kind: 'texture',
          name: params.name ?? `${params.output} bake`,
          recipe: {
            kind: 'dataTexture',
            width: map.width,
            height: map.height,
            channels: map.channels,
            data: Buffer.from(map.data).toString('base64'),
            colorSpace: map.colorSpace,
            flipY: true,
            generateMipmaps: true,
          },
          metadata: {
            generatedBy: 'textureBake',
            sourceGraphId: params.graphId,
            sourceGraphHash: contentHash(resource.graph ?? resource),
            output: params.output,
          },
        },
      }],
    }, context);
    return {
      ...result,
      job: {
        action: params.action,
        graphId: params.graphId,
        textureId: params.textureId,
        output: params.output,
        resolution: [map.width, map.height],
        range: map.range,
      },
    };
  }

  async #exportScene(params) {
    if (params.baseRevision !== this.#kernel.revision) {
      throw new StudioError('revision_conflict', `Base revision ${params.baseRevision} does not match ${this.#kernel.revision}.`);
    }
    const document = this.#kernel.document;
    const sceneId = params.sceneId ?? document.activeSceneId;
    const scene = document.scenes?.[sceneId];
    if (!scene) throw new StudioError('scene_not_found', `Scene ${sceneId} does not exist.`, { sceneId });
    if (params.entityId && !scene.entities[params.entityId]) {
      throw new StudioError('not_found', `Entity ${params.entityId} does not exist.`, { id: params.entityId, kind: 'entity' });
    }
    const exported = exportSceneInterchange(document, {
      sceneId,
      entityId: params.entityId ?? null,
      format: params.format ?? 'glb',
      tessellate: (resource) => {
        try {
          const geometry = createGeometry(this.#THREE, resource);
          try {
            return indexedMeshRecipeFromBufferGeometry(geometry);
          } finally {
            geometry.dispose?.();
          }
        } catch {
          return null;
        }
      },
    });
    const slug = String(params.name ?? scene.name ?? document.name ?? 'scene')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'scene';
    const extension = exported.format === 'gltf' ? 'gltf' : 'glb';
    const artifactsDir = path.join(this.studioRoot, 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    const filePath = path.join(artifactsDir, `studio-${Date.now()}-${slug}.${extension}`);
    await writeFile(filePath, exported.format === 'gltf' ? exported.bytes : Buffer.from(exported.bytes));
    return {
      success: true,
      revision: document.revision,
      projectId: document.projectId,
      dirty: this.#kernel.status().dirty,
      job: {
        action: 'sceneExport',
        sceneId,
        entityId: params.entityId ?? null,
        format: exported.format,
        mimeType: exported.mimeType,
        path: filePath,
        byteLength: exported.stats.byteLength,
        nodes: exported.stats.nodes,
        meshes: exported.stats.meshes,
        materials: exported.stats.materials,
        cameras: exported.stats.cameras,
        lights: exported.stats.lights,
        skipped: exported.skipped,
      },
    };
  }

  async #project(params) {
    if (params.action === 'list') {
      const entries = await readdir(this.projectsRoot, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
      const candidates = entries.filter(entry => entry.isDirectory());
      const projects = (await Promise.all(candidates.map(async entry => {
        const projectPath = path.join(this.projectsRoot, entry.name);
        return await pathExists(path.join(projectPath, 'project.threestudio.json'))
          ? { name: entry.name, path: projectPath }
          : null;
      }))).filter(Boolean);
      return {
        success: true,
        projects,
      };
    }
    if (params.action === 'create' && params.template && params.template !== 'starter' && params.template !== 'blank') {
      throw new StudioError('template_not_found', `Unknown project template ${params.template}.`);
    }
    if (params.action === 'create') return {
      success: true,
      ...(await this.#openOrCreate(this.#managedProjectPath(params.path), {
        create: true,
        mustBeNew: true,
        name: params.name,
        template: params.template === 'starter' ? 'starter' : 'blank',
      })),
    };
    if (params.action === 'open') {
      const requestedPath = params.path
        ? this.#managedProjectPath(params.path)
        : (params.projectId === this.#kernel.projectId ? this.#projectRoot : this.#managedProjectPath(params.projectId.split('/').at(-1)));
      return { success: true, ...(await this.#openOrCreate(requestedPath, { create: false })) };
    }
    if (params.projectId !== this.#kernel.projectId) throw new StudioError('project_mismatch', `Active project is ${this.#kernel.projectId}.`);
    if (params.baseRevision !== this.#kernel.revision) throw new StudioError('revision_conflict', `Base revision ${params.baseRevision} does not match ${this.#kernel.revision}.`);
    if (params.action === 'save' || params.action === 'checkpoint') {
      const result = await this.#kernel.save();
      this.#viewport.setTitle({ project: this.#kernel.document.name, scene: this.#kernel.document.scenes[this.#kernel.document.activeSceneId]?.name, revision: this.#kernel.revision, dirty: false });
      await this.#writeMarker(true);
      return result;
    }
    throw new StudioError('project_action_not_implemented', `Project action ${params.action} is not enabled yet.`);
  }

  #modifierDigestForMesh(document, entity) {
    const geometryId = entity.components?.mesh?.geometryId ?? null;
    const geometryResource = geometryId ? document.resources.geometries?.[geometryId] : null;
    const sourceRecipe = geometryResource ? normalizeGeometryRecipe(geometryResource) : null;
    const analysis = analyzeViewportModifierStack(entity, { sourceKind: sourceRecipe?.kind ?? null });
    const digest = buildModifierDigest(entity);
    const compiledGeometry = this.#compiled?.objects?.get(entity.id)?.geometry ?? null;
    const positionCount = compiledGeometry?.getAttribute?.('position')?.count;
    const indexCount = compiledGeometry?.getIndex?.()?.count ?? compiledGeometry?.index?.count;
    const sourceCounts = sourceRecipe?.kind === 'editableMesh'
      ? {
          vertices: sourceRecipe.positions.length / 3,
          faces: sourceRecipe.faceOffsets.length - 1,
          corners: sourceRecipe.cornerVertexIndices.length,
        }
      : (Array.isArray(sourceRecipe?.positions) ? {
          vertices: sourceRecipe.positions.length / 3,
          triangles: Array.isArray(sourceRecipe.indices)
            ? sourceRecipe.indices.length / 3
            : sourceRecipe.positions.length / 9,
        } : null);
    return {
      ...digest,
      sourceGeometryId: geometryId,
      sourceRecipeKind: sourceRecipe?.kind ?? null,
      viewportEvaluation: {
        target: analysis.target,
        status: analysis.status,
        ...(analysis.blocked ? { blocked: analysis.blocked } : {}),
        ...(sourceCounts ? { sourceCounts } : {}),
        ...(Number.isFinite(positionCount) ? {
          previewCounts: {
            vertices: positionCount,
            triangles: Number.isFinite(indexCount) ? indexCount / 3 : positionCount / 3,
          },
        } : {}),
      },
      modifiers: digest.modifiers.map((modifier, index) => ({
        ...modifier,
        viewport: analysis.entries[index],
      })),
    };
  }

  #inspect(params) {
    const effectiveParams = params.preset === 'authoring' && ['sceneDigest', 'selector'].includes(params.query)
      ? { ...params, include: ['summary', 'tree', 'transform', 'components', 'bounds', 'references'] }
      : params;
    const raw = this.#inspectRaw(effectiveParams);
    const projectableSelector = ['sceneDigest', 'selector'].includes(params.query);
    return shapeToolResponse(raw, {
      select: params.select,
      defaultSelect: projectableSelector && params.preset !== 'full'
        ? INSPECT_SELECT_PRESETS[params.preset]
        : undefined,
      format: params.format,
      ifHash: params.ifHash,
      preset: params.preset,
    });
  }

  #inspectRaw(params) {
    this.#assertTarget(params);
    const document = this.#kernel.document;
    if (params.query === 'resourceDigest') return {
      success: true,
      revision: document.revision,
      projectId: document.projectId,
      ...buildResourceDigest(document, params),
    };
    if (params.query === 'meshElements') {
      const resourceId = params.selector.ids[0];
      const { resource } = new ProjectIndex(document).getResource(resourceId, 'geometries');
      return {
        success: true,
        revision: document.revision,
        projectId: document.projectId,
        ...buildMeshElements(resource, {
          ...params,
          meshFilter: params.meshFilter,
          responseByteBudget: MAX_INSPECT_RESPONSE_BYTES - INSPECT_RESPONSE_ENVELOPE_RESERVE_BYTES,
        }),
      };
    }
    if (params.query === 'meshSelection') {
      const resourceId = params.selector.ids[0];
      const { resource } = new ProjectIndex(document).getResource(resourceId, 'geometries');
      return {
        success: true,
        revision: document.revision,
        projectId: document.projectId,
        ...buildMeshSelection(resource, {
          element: params.element,
          meshFilter: params.meshFilter,
        }),
      };
    }
    if (params.query === 'meshQuality') {
      const resourceId = params.selector.ids[0];
      const { resource } = new ProjectIndex(document).getResource(resourceId, 'geometries');
      return {
        success: true,
        revision: document.revision,
        projectId: document.projectId,
        quality: buildMeshQuality(resource),
      };
    }
    if (params.query === 'graphDigest') {
      const resourceId = params.selector.ids[0];
      const { resource } = new ProjectIndex(document).getResource(resourceId, 'graphs');
      return {
        success: true,
        revision: document.revision,
        projectId: document.projectId,
        ...buildGraphDigest(resource, {
          cursor: params.cursor,
          nodeLimit: params.limit,
          edgeLimit: params.limit,
          maxResponseBytes: MAX_INSPECT_RESPONSE_BYTES - INSPECT_RESPONSE_ENVELOPE_RESERVE_BYTES,
        }),
      };
    }
    if (params.query === 'beautyDigest') {
      return {
        success: true,
        revision: document.revision,
        projectId: document.projectId,
        ...buildBeautyDigest({
          studioRoot: this.studioRoot,
          latestEvidence: this.#latestEvidence,
          evidence: params.evidence ?? {},
        }),
      };
    }
    if (params.query === 'modifierDigest') {
      const entityId = params.selector.ids[0];
      const index = new ProjectIndex(document);
      const { scene, entity } = index.getEntity(entityId);
      if (entity.kind === 'group') {
        const descendantIds = index.collectSubtree(entityId).slice(1);
        const meshes = descendantIds
          .map(id => scene.entities[id])
          .filter(child => child && ['mesh', 'instancedMesh'].includes(child.kind));
        const truncated = meshes.length > 32;
        const selected = meshes.slice(0, 32);
        return {
          success: true,
          revision: document.revision,
          projectId: document.projectId,
          sceneId: scene.id,
          kind: 'group',
          entityId,
          meshCount: meshes.length,
          truncated,
          children: selected.map(child => this.#modifierDigestForMesh(document, child)),
        };
      }
      if (!['mesh', 'instancedMesh'].includes(entity.kind)) {
        throw new StudioError('invalid_modifier_target', 'modifierDigest requires a mesh, instancedMesh, or group entity.', {
          entityId,
          kind: entity.kind,
        });
      }
      return {
        success: true,
        revision: document.revision,
        projectId: document.projectId,
        sceneId: scene.id,
        ...this.#modifierDigestForMesh(document, entity),
      };
    }
    const scene = document.scenes[params.sceneId ?? document.activeSceneId];
    if (!scene) throw new StudioError('scene_not_found', `Scene ${params.sceneId} does not exist.`);
    if (params.query === 'projectVisibility') {
      const canvas = this.#viewport.renderer?.domElement;
      const objectId = params.projection?.objectIdPath
        ? loadObjectIdEvidence({
          path: params.projection.objectIdPath,
          entities: this.#latestEvidence?.objectId?.entities ?? [],
        }, { studioRoot: this.studioRoot })
        : this.#latestObjectIdEvidence();
      return {
        success: true,
        revision: document.revision,
        projectId: document.projectId,
        sceneId: scene.id,
        ...buildProjectVisibility(scene, {
          ...(params.projection ?? {}),
          width: params.projection?.width ?? objectId?.width ?? canvas?.width ?? 1280,
          height: params.projection?.height ?? objectId?.height ?? canvas?.height ?? 720,
          objectId,
        }),
      };
    }
    if (params.query === 'rtxDigest') {
      const status = this.#viewport.getRtxStatus?.() ?? null;
      const authored = scene.settings.rtx ?? null;
      return {
        success: true,
        revision: document.revision,
        projectId: document.projectId,
        sceneId: scene.id,
        sceneHash: contentHash(scene),
        authored: structuredClone(authored),
        authoredHash: contentHash(authored),
        effective: this.#viewport.getRtxDigest?.() ?? { status, collection: null },
        limits: RTX_SCENE_LIMITS,
      };
    }
    if (params.query === 'changedSinceRevision') return { success: true, revision: document.revision, ...this.#kernel.changedSince(params.sinceRevision ?? document.revision) };
    if (params.query === 'operationCatalog') return {
      success: true,
      revision: document.revision,
      catalog: queryOperationCatalog({
        search: params.selector?.name,
        family: params.selector?.kind,
        limit: params.limit,
      }),
    };
    if (params.query === 'geometryCatalog') return {
      success: true,
      revision: document.revision,
      catalog: queryGeometryCatalog({
        search: params.selector?.name,
        kind: params.selector?.kind,
        limit: params.limit,
      }),
    };
    if (params.query === 'lookCatalog') return {
      success: true,
      revision: document.revision,
      catalog: queryLookCatalog({
        search: params.selector?.name,
        look: params.selector?.kind,
        limit: params.limit,
      }),
    };
    if (params.query === 'lightingDigest') return {
      success: true,
      revision: document.revision,
      projectId: document.projectId,
      ...buildLightingDigest(document, params),
    };
    if (params.query === 'graphCatalog') return {
      success: true,
      revision: document.revision,
      catalog: queryGraphCatalog(params.selector?.kind ?? 'shader', { search: params.selector?.name, limit: params.limit }),
      ...((params.selector?.kind ?? 'shader') === 'shader' ? {
        blenderInventory: queryBlenderShaderNodeInventory({
          search: params.selector?.name,
          status: params.selector?.status,
          limit: params.limit,
        }),
      } : {}),
    };
    if (params.query === 'blenderCatalog') return {
      success: true,
      revision: document.revision,
      summary: BLENDER_CATALOG_SUMMARY,
      catalog: queryBlenderCatalog({
        domain: params.selector?.kind,
        search: params.selector?.name,
        status: params.selector?.status,
        limit: params.limit,
      }),
    };
    if (params.query === 'latestEvidence') return { success: true, revision: document.revision, evidence: this.#latestEvidence };
    if (params.query === 'playState') return {
      success: true,
      revision: document.revision,
      mode: this.#mode,
      simulation: 'actions-controller-physics-and-timeline-modifiers',
      ...this.#play,
      timeline: scene.settings.timeline,
      actions: this.#compiled?.animationStates() ?? [],
      timelineGeometryModifierIds: this.#compiled?.timelineGeometryModifierIds ?? [],
      timelineGeometrySampleCount: this.#compiled?.timelineGeometrySampleCount ?? 0,
    };
    if (params.query === 'unresolvedResources') {
      const diagnostics = validateProjectDocument(document).diagnostics.filter(item => item.code === 'missing_resource');
      return { success: diagnostics.length === 0, revision: document.revision, diagnostics };
    }
    if (params.query === 'unusedResources') {
      const index = new ProjectIndex(document);
      const resources = [...index.resources.keys()].filter(id => index.getReferencesTo(id).length === 0).sort();
      return { success: true, revision: document.revision, resources };
    }
    if (!['sceneDigest', 'selector'].includes(params.query)) {
      throw new StudioError('inspect_query_not_implemented', `Inspect query ${params.query} is not enabled in the lean runtime yet.`);
    }
    const include = new Set(params.include ?? ['summary']);
    const index = new ProjectIndex(document);
    let entities = Object.values(scene.entities);
    const selector = params.selector ?? {};
    if (selector.ids) entities = entities.filter(entity => selector.ids.includes(entity.id));
    if (selector.name) entities = entities.filter(entity => entity.name.toLowerCase().includes(selector.name.toLowerCase()));
    if (selector.kind) entities = entities.filter(entity => entity.kind === selector.kind);
    if (selector.tag) entities = entities.filter(entity => entity.tags.includes(selector.tag));
    let selectedCollection;
    if (selector.collectionId) {
      const record = index.getCollection(selector.collectionId);
      if (record.sceneId !== scene.id) throw new StudioError('collection_scene_mismatch', `Collection ${selector.collectionId} does not belong to scene ${scene.id}.`);
      selectedCollection = {
        id: record.collection.id,
        name: record.collection.name,
        parentId: record.collection.parentId,
        children: [...record.collection.children],
        entityIds: [...record.collection.entityIds],
        metadata: structuredClone(record.collection.metadata),
        membershipHash: index.collectionMembershipHash(record.collection.id),
        subtreeHash: index.collectionSubtreeHash(record.collection.id),
      };
      const membership = new Set(record.collection.entityIds);
      entities = entities.filter(entity => membership.has(entity.id));
    }
    const selectionHash = hashExactEntitySet(index, entities.map(entity => entity.id), { allowEmpty: true });
    const offset = Math.max(0, Number.parseInt(params.cursor ?? '0', 10) || 0);
    const limit = Math.min(200, params.limit ?? 50);
    const page = entities.sort((a, b) => a.id.localeCompare(b.id)).slice(offset, offset + limit);
    return {
      success: true,
      revision: document.revision,
      projectId: document.projectId,
      scene: {
        id: scene.id,
        name: scene.name,
        activeCameraId: scene.settings.activeCameraId,
        entityCount: Object.keys(scene.entities).length,
        collectionCount: Object.keys(scene.collections).length,
        rootCollectionIds: [...scene.rootCollectionIds],
        selectedEntityCount: entities.length,
        sceneHash: contentHash(scene),
        selectionHash,
      },
      collection: selectedCollection,
      entities: page.map(entity => compactEntity(entity, include, {
        index,
        compiled: this.#compiled,
        THREE: this.#THREE,
      })),
      resources: include.has('summary') ? Object.fromEntries(Object.entries(document.resources).map(([type, table]) => [type, Object.keys(table).length])) : undefined,
      nextCursor: offset + page.length < entities.length ? String(offset + page.length) : null,
    };
  }

  async #apply(params, context = {}) {
    this.#assertTarget(params);
    const applyStarted = monotonicMilliseconds();
    const applyMetrics = { compileCount: 0, compileMs: 0 };
    this.#activeApplyMetrics = applyMetrics;
    try {
    const document = this.#kernel.document;
    const plainform = params.program
      ? new PlainformCompiler().compile(params.program.source, { project: document })
      : null;
    const plainformOperations = plainform
      ? plainform.operations.map((operation, index) => {
          const parsed = operationSchema.safeParse(operation);
          if (!parsed.success) throw new StudioError(
            'plainform_compile_invalid',
            `Plainform generated an invalid operation at index ${index}.`,
            { index, diagnostics: parsed.error.issues },
          );
          return parsed.data;
        })
      : [];
    // A live MCP client may retain the older operations-required transport
    // shape while Studio refreshes its tool contract. Combining both inputs
    // keeps every supplied mutation explicit and preserves Plainform telemetry.
    const authoredOperations = [...(params.operations ?? []), ...plainformOperations];
    // A candidate token is an explicit request to promote the identical compiled
    // candidate. Natural-language preview intent must not force that promotion
    // back into another dry run.
    const dryRun = params.candidateToken === undefined
      && (params.dryRun === true || plainform?.requestedPreview === true);
    const translationDocument = structuredClone(document);
    const operations = [];
    for (const operation of authoredOperations) {
      const translated = operation.op === 'geometry.realize'
        ? materializeGeometryRealizeOperation(operation, { document: translationDocument, THREE: this.#THREE })
        : operation.op === 'geometry.loft.edit'
          ? materializeLoftEditOperation(operation, translationDocument)
          : operation.op === 'geometry.selection.edit'
            ? materializeGeometrySelectionEdit(operation, translationDocument)
          : translateToolOperation(operation, translationDocument);
      for (const candidateValue of (Array.isArray(translated) ? translated : [translated])) {
        const candidate = materializeCameraFrameOperation(candidateValue, {
          compiled: this.#compiled,
          THREE: this.#THREE,
          document: translationDocument,
        });
        operations.push(candidate);
        recordTranslationMutation(translationDocument, candidate);
        if ((candidate.type ?? candidate.op) === 'resource.create' && !candidate.alias) {
          const resourceType = normalizeResourceType(candidate.resourceType);
          const resource = createResourceDocument(resourceType, candidate.resource);
          translationDocument.resources[resourceType][resource.id] = resource;
        } else if ((candidate.type ?? candidate.op) === 'resource.createMany') {
          for (const item of candidate.items) {
            if (item.alias) continue;
            const resourceType = normalizeResourceType(item.resourceType);
            const resource = createResourceDocument(resourceType, item.resource);
            translationDocument.resources[resourceType][resource.id] = resource;
          }
        } else if ((candidate.type ?? candidate.op) === 'resource.patch') {
          const resourceType = normalizeResourceType(candidate.resourceType);
          const current = translationDocument.resources[resourceType][candidate.resourceId];
          if (current) {
            translationDocument.resources[resourceType][candidate.resourceId] = createResourceDocument(
              resourceType,
              mergePatch(current, candidate.patch),
            );
          }
        }
      }
    }
    operations.splice(0, operations.length, ...compactTextureRecipePatches(operations));
    const loweringFinished = monotonicMilliseconds();
    const pixelForecast = forecastPixelImpact({ before: document, operations });
    const candidateToken = contentHash({
      projectId: params.projectId,
      baseRevision: params.baseRevision,
      authoring: params.program ?? params.operations,
    });
    if (params.candidateToken && params.candidateToken !== candidateToken) {
      throw new StudioError('candidate_token_mismatch', 'candidateToken does not match this project revision and operation batch.');
    }
    if (params.candidateToken && this.#dryRunCandidate?.token !== params.candidateToken) {
      throw new StudioError('candidate_not_available', 'The compiled dry-run candidate is no longer available for promotion. Run the dry run again.');
    }
    this.#pendingCandidateToken = dryRun ? candidateToken : (params.candidateToken ?? null);
    let response;
    const kernelStarted = monotonicMilliseconds();
    try {
      response = await this.#kernel.apply({
        protocolVersion: params.protocolVersion,
        projectId: params.projectId,
        label: params.label,
        baseRevision: params.baseRevision,
        idempotencyKey: params.idempotencyKey,
        dryRun,
        operations,
      }, { signal: context.signal });
    } catch (error) {
      throw error;
    }
    const kernelFinished = monotonicMilliseconds();
    let previewEvidence;
    let previewDigest;
    const previewStarted = monotonicMilliseconds();
    if (params.previewEvidence && this.#dryRunCandidate) {
      const candidate = this.#dryRunCandidate.compiled;
      const scene = this.#viewport.scene;
      const previousRootVisible = this.#compiled?.root?.visible;
      const previousBackground = scene.background;
      const previousBackgroundNode = scene.backgroundNode;
      const previousFog = scene.fog;
      try {
        if (this.#compiled?.root) this.#compiled.root.visible = false;
        scene.add(candidate.root);
        scene.background = candidate.background;
        scene.backgroundNode = candidate.backgroundNode;
        scene.fog = candidate.fog;
        previewEvidence = await this.#viewport.capture(undefined, {
          width: params.previewEvidence.width,
          height: params.previewEvidence.height,
          pass: 'raster',
          camera: candidate.activeCamera ?? this.#viewport.renderCamera,
        });
        if (params.previewEvidence.digest !== false) previewDigest = buildBeautyDigest({
          studioRoot: this.studioRoot,
          latestEvidence: previewEvidence,
          evidence: {
            path: previewEvidence.path,
            ...(params.previewEvidence.probes ? { probes: params.previewEvidence.probes } : {}),
            ...(params.previewEvidence.bbox ? { bbox: params.previewEvidence.bbox } : {}),
          },
        });
      } finally {
        candidate.root.removeFromParent?.();
        if (this.#compiled?.root && previousRootVisible !== undefined) this.#compiled.root.visible = previousRootVisible;
        scene.background = previousBackground;
        scene.backgroundNode = previousBackgroundNode;
        scene.fog = previousFog;
      }
    }
    if (response.success && !dryRun && operationsSnapFollowShot(operations)) {
      this.#viewport.followShot?.();
    }
    const finished = monotonicMilliseconds();
    return {
      ...response,
      sessionId: this.sessionId,
      projectId: this.#kernel.projectId,
      evidenceRequested: params.evidence === true,
      pixelForecast,
      ...(dryRun ? { candidateToken } : {}),
      ...(plainform ? { plainform: {
        language: plainform.language,
        source: params.program.source,
        ...(plainform.dialect ? { dialect: plainform.dialect } : {}),
        interpretation: plainform.interpretation,
        aliases: plainform.aliases,
        requestedPreview: plainform.requestedPreview,
        ...(plainform.shader ? { shader: plainform.shader } : {}),
        ...(plainform.design ? { design: plainform.design } : {}),
      } } : {}),
      authoring: {
        authoredOperationCount: authoredOperations.length,
        loweredOperationCount: operations.length,
        authoredOperationTypes: summarizeOperationTypes(authoredOperations),
        loweredOperationTypes: summarizeOperationTypes(operations),
        compileCount: applyMetrics.compileCount,
        promotedCandidate: applyMetrics.promotedCandidate === true,
        timingsMs: {
          lowering: Math.max(0, loweringFinished - applyStarted),
          kernel: Math.max(0, kernelFinished - kernelStarted),
          compile: Math.max(0, applyMetrics.compileMs),
          preview: Math.max(0, finished - previewStarted),
          total: Math.max(0, finished - applyStarted),
        },
      },
      ...(previewEvidence ? { previewEvidence } : {}),
      ...(previewDigest ? { previewDigest } : {}),
    };
    } finally {
      this.#activeApplyMetrics = null;
      this.#pendingCandidateToken = null;
    }
  }

  #validate(params) {
    this.#assertTarget(params);
    if (params.scope !== 'project' || params.strictness !== 'interactive') {
      throw new StudioError('validation_mode_not_implemented', 'The lean runtime validates the active project interactively.');
    }
    const document = this.#kernel.document;
    const result = validateProjectDocument(document);
    const graphDiagnostics = [];
    const requestedChecks = params.checks ?? ['schemas', 'references', 'hierarchy', 'graphs', 'animations', 'budgets'];
    if (requestedChecks.includes('graphs')) {
      for (const resource of Object.values(document.resources.graphs)) {
        if (!resource.graph) continue;
        const validation = validateGraph(resource.graph);
        graphDiagnostics.push(...validation.warnings.map(item => ({ ...item, resourceId: resource.id })));
      }
    }
    const animationDiagnostics = [];
    if (requestedChecks.includes('animations')) {
      const targetIds = new Set(Object.values(document.scenes).flatMap(scene => Object.keys(scene.entities)));
      for (const resource of Object.values(document.resources.animations)) {
        const validation = validateAnimationResource(resource, { knownTargetIds: targetIds });
        animationDiagnostics.push(...validation.diagnostics.map(item => ({ ...item, resourceId: resource.id })));
      }
    }
    const diagnostics = [...result.diagnostics, ...graphDiagnostics, ...animationDiagnostics];
    return {
      success: diagnostics.every(item => item.severity !== 'error'),
      revision: document.revision,
      projectId: document.projectId,
      scope: 'project',
      strictness: params.strictness,
      requestedChecks,
      executedChecks: ['schemas', 'references', 'hierarchy', 'graphs', 'animations', 'budgets'],
      diagnostics,
      budgets: result.budgets,
    };
  }

  #latestObjectIdEvidence() {
    const item = this.#latestEvidence?.objectId
      ?? this.#latestEvidence?.items?.find(entry => entry.pass === 'objectId');
    if (!item?.path) return null;
    try {
      return loadObjectIdEvidence(item, { studioRoot: this.studioRoot });
    } catch {
      return null;
    }
  }

  async #captureObjectId(captureCamera, params) {
    const THREE = this.#THREE;
    const TSL = this.#TSL;
    const scene = this.#viewport.scene;
    const renderer = this.#viewport.renderer;
    const entities = [];
    const restored = [];
    const seen = new Map();
    const objects = this.#compiled?.objects ?? new Map();
    for (const [id, object] of [...objects.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      if (!object) continue;
      let hasMesh = object.isMesh || object.isSkinnedMesh || object.isInstancedMesh;
      object.traverse?.(child => {
        if (child.isMesh || child.isSkinnedMesh || child.isInstancedMesh) hasMesh = true;
      });
      if (!hasMesh || seen.has(id)) continue;
      seen.set(id, true);
      entities.push({ index: entities.length + 1, id });
    }
    const byId = new Map(entities.map(entity => [entity.id, entity]));
    const MaterialCtor = THREE.MeshBasicNodeMaterial ?? THREE.MeshBasicMaterial;
    scene.traverse(object => {
      const id = object.userData?.studioEntityId;
      if (!id || !(object.isMesh || object.isSkinnedMesh || object.isInstancedMesh)) return;
      const entity = byId.get(id);
      if (!entity) return;
      const rgb = encodeObjectIdRgb01(entity.index);
      const material = new MaterialCtor();
      if (TSL?.vec3 && 'colorNode' in material) material.colorNode = TSL.vec3(rgb[0], rgb[1], rgb[2]);
      else if (material.color?.setRGB) material.color.setRGB(rgb[0], rgb[1], rgb[2]);
      else if (THREE.Color) material.color = new THREE.Color(rgb[0], rgb[1], rgb[2]);
      restored.push({ object, material: object.material });
      object.material = material;
    });
    const previousBackground = scene.background;
    const previousBackgroundNode = scene.backgroundNode;
    const previousColorSpace = renderer.outputColorSpace;
    const previousTone = renderer.toneMapping;
    scene.background = THREE.Color ? new THREE.Color(0, 0, 0) : 0;
    scene.backgroundNode = null;
    if (THREE.NoColorSpace !== undefined) renderer.outputColorSpace = THREE.NoColorSpace;
    else if (THREE.LinearSRGBColorSpace !== undefined) renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    if (THREE.NoToneMapping !== undefined) renderer.toneMapping = THREE.NoToneMapping;
    try {
      const filePath = path.join(this.studioRoot, 'artifacts', `studio-${Date.now()}-objectid.png`);
      const item = await this.#viewport.capture(filePath, {
        width: params.width,
        height: params.height,
        pass: 'objectId',
        camera: captureCamera,
      });
      return { ...item, pass: 'objectId', entities };
    } finally {
      scene.background = previousBackground;
      scene.backgroundNode = previousBackgroundNode;
      renderer.outputColorSpace = previousColorSpace;
      renderer.toneMapping = previousTone;
      for (const { object, material } of restored) object.material = material;
    }
  }

  #diagnosticMaterial(source, pass) {
    const THREE = this.#THREE;
    const TSL = this.#TSL;
    const MaterialCtor = THREE.MeshBasicNodeMaterial ?? THREE.MeshBasicMaterial;
    const material = new MaterialCtor();
    const scalarColor = value => {
      const bounded = Math.min(1, Math.max(0, Number(value) || 0));
      material.color?.setRGB?.(bounded, bounded, bounded);
    };
    if (TSL?.vec3 && 'colorNode' in material) {
      if (pass === 'albedo') {
        material.colorNode = source?.colorNode
          ?? (source?.map && TSL.texture ? TSL.texture(source.map).rgb : null)
          ?? TSL.vec3(source?.color?.r ?? 1, source?.color?.g ?? 1, source?.color?.b ?? 1);
      } else if (pass === 'roughness') {
        const value = source?.roughnessNode ?? TSL.float?.(source?.roughness ?? 0.5) ?? (source?.roughness ?? 0.5);
        material.colorNode = TSL.vec3(value, value, value);
      } else if (pass === 'normal') {
        const normal = source?.normalNode ?? TSL.normalView;
        material.colorNode = normal?.mul?.(0.5)?.add?.(0.5) ?? TSL.vec3(0.5, 0.5, 1);
      } else if (pass === 'uv') {
        const uv = TSL.fract?.(TSL.uv?.()) ?? TSL.uv?.();
        material.colorNode = uv ? TSL.vec3(uv.x, uv.y, 0) : TSL.vec3(0, 0, 0);
      }
    } else if (pass === 'albedo' && material.color?.copy && source?.color) material.color.copy(source.color);
    else if (pass === 'roughness') scalarColor(source?.roughness ?? 0.5);
    else if (pass === 'normal') material.color?.setRGB?.(0.5, 0.5, 1);
    else material.color?.setRGB?.(0, 0, 0);
    material.name = `Studio diagnostic ${pass}`;
    material.toneMapped = false;
    return material;
  }

  async #captureMaterialDiagnostic(captureCamera, params, pass) {
    const scene = this.#viewport.scene;
    const renderer = this.#viewport.renderer;
    const restored = [];
    const owned = [];
    scene.traverse(object => {
      if (!(object.isMesh || object.isSkinnedMesh || object.isInstancedMesh)) return;
      const sources = Array.isArray(object.material) ? object.material : [object.material];
      const replacements = sources.map(source => {
        const material = this.#diagnosticMaterial(source, pass);
        owned.push(material);
        return material;
      });
      restored.push({ object, material: object.material });
      object.material = Array.isArray(object.material) ? replacements : replacements[0];
    });
    const previousBackground = scene.background;
    const previousBackgroundNode = scene.backgroundNode;
    const previousTone = renderer.toneMapping;
    scene.background = this.#THREE.Color ? new this.#THREE.Color(0, 0, 0) : 0;
    scene.backgroundNode = null;
    if (this.#THREE.NoToneMapping !== undefined) renderer.toneMapping = this.#THREE.NoToneMapping;
    try {
      const filePath = path.join(this.studioRoot, 'artifacts', `studio-${Date.now()}-${pass}.png`);
      return await this.#viewport.capture(filePath, {
        width: params.width,
        height: params.height,
        pass,
        camera: captureCamera,
      });
    } finally {
      scene.background = previousBackground;
      scene.backgroundNode = previousBackgroundNode;
      renderer.toneMapping = previousTone;
      for (const { object, material } of restored) object.material = material;
      for (const material of owned) material.dispose?.();
    }
  }

  async #render(params) {
    this.#assertTarget(params, { requireActiveScene: true });
    if (params.renderer && params.renderer !== 'webgpu') {
      throw new StudioError('renderer_not_available', `${params.renderer} evidence is not enabled; authored WebGPU remains active.`);
    }
    const previousAnimationTime = this.#compiled?.animationTime;
    if (params.timelineFrame !== undefined) {
      const scene = this.#kernel.document.scenes[this.#kernel.document.activeSceneId];
      const timeline = scene.settings.timeline;
      const seconds = (params.timelineFrame - timeline.frameStart) / timeline.framesPerSecond;
      this.#compiled?.setAnimationTime(seconds);
    }
    try {
      let captureCamera = this.#viewport.authoredCamera ?? this.#viewport.renderCamera;
      let evidenceTargetIds;
      let evidenceTargetBounds;
      if (params.cameraId) {
        captureCamera = this.#compiled?.objects.get(params.cameraId);
        if (!captureCamera?.isCamera) throw new StudioError('camera_not_found', `${params.cameraId} is not a compiled camera.`);
      }
      if (params.frame) {
        const bounds = new this.#THREE.Box3();
        if (params.frame.bounds) {
          bounds.min.fromArray(params.frame.bounds.min);
          bounds.max.fromArray(params.frame.bounds.max);
        } else {
          for (const id of params.frame.targetIds ?? []) {
            const object = this.#compiled?.objects.get(id);
            if (object) bounds.expandByObject(object);
          }
        }
        if (bounds.isEmpty()) throw new StudioError('frame_bounds_empty', 'The requested evidence frame has no compiled bounds.');
        evidenceTargetIds = params.frame.targetIds;
        evidenceTargetBounds = { min: bounds.min.toArray(), max: bounds.max.toArray() };
        captureCamera = frameCameraToBounds(this.#THREE, captureCamera, bounds, {
          aspect: params.width / params.height,
        });
      }
      const evidence = [];
      for (const pass of params.passes ?? ['beauty']) {
        if (pass === 'beauty') {
          evidence.push(await this.#viewport.capture(undefined, {
            width: params.width,
            height: params.height,
            pass,
            camera: captureCamera,
          }));
          continue;
        }
        if (pass === 'raster') {
          evidence.push(await this.#viewport.capture(undefined, {
            width: params.width,
            height: params.height,
            pass,
            camera: captureCamera,
          }));
          continue;
        }
        if (pass === 'objectId') {
          evidence.push(await this.#captureObjectId(captureCamera, params));
          continue;
        }
        if (['albedo', 'roughness', 'normal', 'uv'].includes(pass)) {
          evidence.push(await this.#captureMaterialDiagnostic(captureCamera, params, pass));
          continue;
        }
        throw new StudioError('render_pass_not_implemented', `Render pass ${pass} is not enabled yet.`);
      }
      const sourceCameraId = params.cameraId ?? captureCamera?.userData?.studioEntityId ?? 'review-camera';
      const cameraEvidence = describeEffectiveCamera(captureCamera, params.frame
        ? {
            sourceCameraId,
            framingMode: 'bounds',
            ...(evidenceTargetIds ? { targetIds: evidenceTargetIds } : {}),
            targetBounds: evidenceTargetBounds,
          }
        : authoredCameraEvidenceOptions(this.#kernel.document, captureCamera, sourceCameraId));
      const rtx = this.#viewport.getRtxStatus?.() ?? null;
      const objectIdItem = evidence.find(item => item.pass === 'objectId');
      this.#latestEvidence = {
        revision: this.#kernel.revision,
        createdAt: new Date().toISOString(),
        ...(params.timelineFrame === undefined ? {} : { timelineFrame: params.timelineFrame }),
        camera: cameraEvidence,
        ...(rtx ? { rtx } : {}),
        items: evidence,
        ...(objectIdItem ? {
          objectId: {
            path: objectIdItem.path,
            width: objectIdItem.width,
            height: objectIdItem.height,
            entities: objectIdItem.entities ?? [],
          },
        } : {}),
      };
      return {
        success: true,
        revision: this.#kernel.revision,
        projectId: this.#kernel.projectId,
        cameraId: sourceCameraId,
        camera: cameraEvidence,
        renderer: 'webgpu',
        ...(rtx ? { rtx } : {}),
        ...(params.timelineFrame === undefined ? {} : { timelineFrame: params.timelineFrame }),
        evidence,
      };
    } finally {
      if (params.timelineFrame !== undefined && previousAnimationTime !== undefined) {
        this.#compiled?.setAnimationTime(previousAnimationTime);
      }
    }
  }

  #history(params) {
    this.#assertTarget(params);
    if (params.action === 'list') return { success: true, revision: this.#kernel.revision, entries: this.#kernel.history({ limit: params.limit }) };
    if (params.action === 'undo' || params.action === 'redo') {
      return this.#kernel[params.action]({
        protocolVersion: params.protocolVersion,
        projectId: params.projectId,
        label: params.label,
        baseRevision: params.baseRevision,
        idempotencyKey: params.idempotencyKey,
        ...(params.transactionId ? { transactionId: params.transactionId } : {}),
      });
    }
    if (params.action === 'inspect') {
      const entry = this.#kernel.history({ limit: 200, includeOperations: true }).find(item => item.transactionId === params.transactionId);
      return { success: Boolean(entry), revision: this.#kernel.revision, entry: entry ?? null };
    }
    throw new StudioError('history_action_not_implemented', `History action ${params.action} is not enabled yet.`);
  }

  #playTool(params) {
    this.#assertTarget(params);
    const scene = this.#kernel.document.scenes[this.#kernel.document.activeSceneId];
    const timeline = scene.settings.timeline;
    const animationState = () => ({
      timeline,
      actions: this.#compiled?.animationStates() ?? [],
      timelineGeometryModifierIds: this.#compiled?.timelineGeometryModifierIds ?? [],
      timelineGeometrySampleCount: this.#compiled?.timelineGeometrySampleCount ?? 0,
    });
    if (params.action === 'query') return {
      success: true,
      mode: this.#mode,
      simulation: 'actions-controller-physics-and-timeline-modifiers',
      ...this.#play,
      ...animationState(),
    };
    if (params.baseRevision !== this.#kernel.revision) throw new StudioError('revision_conflict', `Base revision ${params.baseRevision} does not match ${this.#kernel.revision}.`);
    if (params.action === 'enter') {
      if (this.#logicController?.active) this.#stopLogicController();
      this.#mode = 'play';
      this.#play = { paused: false, tick: 0, elapsed: 0, latestInput: null };
      this.#compiled?.setAnimationTime(0);
      for (const action of this.#compiled?.animationRuntime?.actions.values() ?? []) {
        if (action.autoplay) this.#compiled.animationRuntime.play(action.id, { restart: true });
        else this.#compiled.animationRuntime.pause(action.id);
      }
    }
    else if (params.action === 'stop') {
      if (this.#logicController?.active) this.#logicController.stop();
      this.#mode = 'author';
      this.#play = { paused: false, tick: 0, elapsed: 0, latestInput: null };
      const authoredTime = (timeline.currentFrame - timeline.frameStart) / timeline.framesPerSecond;
      this.#compiled?.setAnimationTime(authoredTime);
      for (const action of this.#compiled?.animationRuntime?.actions.values() ?? []) {
        this.#compiled.animationRuntime.pause(action.id);
      }
      this.#syncControllerState();
    }
    else if (params.action === 'pause') this.#play.paused = true;
    else if (params.action === 'resume') this.#play.paused = false;
    else if (params.action === 'step') {
      const delta = params.ticks / 60;
      this.#play.tick += params.ticks;
      this.#play.elapsed += delta;
      this.#compiled?.advanceAnimation(delta);
    }
    else if (params.action === 'seek') {
      this.#play.elapsed = (params.frame - timeline.frameStart) / timeline.framesPerSecond;
      this.#play.tick = Math.round(this.#play.elapsed * 60);
      this.#compiled?.setAnimationTime(this.#play.elapsed);
    }
    else if (params.action === 'inject') this.#play.latestInput = { action: params.inputAction, input: params.input };
    return {
      success: true,
      mode: this.#mode,
      simulation: 'actions-controller-physics-and-timeline-modifiers',
      ...this.#play,
      ...animationState(),
      revision: this.#kernel.revision,
      warnings: [{ code: 'script_runtime_not_enabled', message: 'Typed controller logic is live, but arbitrary behaviour scripts are not executing.' }],
    };
  }

  update(deltaSeconds) {
    if (this.#disposed || this.#mode !== 'play' || this.#play.paused) return;
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    this.#play.elapsed += deltaSeconds;
    this.#play.tick = Math.round(this.#play.elapsed * 60);
    this.#compiled?.advanceAnimation(deltaSeconds, { restorePose: this.#logicController?.active !== true });
    this.#logicController?.update(deltaSeconds);
  }

  #writeMarker(viewportReady, { required = false } = {}) {
    const marker = createSessionMarker({
      credentials: this.#credentials,
      projectPath: this.#projectRoot,
      projectId: this.#kernel?.projectId ?? null,
      revision: this.#kernel?.revision ?? 0,
      viewportReady,
    });
    const write = this.#markerTail.then(async () => {
      await writeSessionMarker(this.#markerPath, marker);
      this.#markerPublished = true;
    });
    this.#markerTail = write.catch(error => {
      console.error('[ThreeBrowser Studio marker]', error.message);
    });
    return required ? write : this.#markerTail;
  }

  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    clearInterval(this.#heartbeat);
    this.#unsubscribe?.();
    await this.#writeView().catch(() => {});
    await this.#bridge?.close();
    await this.#exclusiveTail.catch(() => {});
    await this.#markerTail;
    if (this.#markerPublished) {
      const owned = await readSessionMarker(this.#markerPath, { maxAgeMs: Infinity })
        .then(marker => marker.sessionId === this.sessionId)
        .catch(() => false);
      if (owned) await rm(this.#markerPath, { force: true }).catch(() => {});
    }
    this.#prepared?.dispose();
    this.#dryRunCandidate?.compiled.dispose();
    this.#logicController?.stop();
    this.#logicController = null;
    this.#syncControllerState();
    const compiled = this.#compiled;
    if (typeof this.#viewport.setAppearance === 'function') this.#viewport.setAppearance({});
    else {
      if (this.#viewport.scene.background === compiled?.background) this.#viewport.scene.background = null;
      if (this.#viewport.scene.backgroundNode === compiled?.backgroundNode) this.#viewport.scene.backgroundNode = null;
      if (this.#viewport.scene.fog === compiled?.fog) this.#viewport.scene.fog = null;
    }
    compiled?.dispose();
    this.#prepared = null;
    this.#dryRunCandidate = null;
    this.#compiled = null;
  }
}

export async function startStudioApplication(options) {
  const application = new StudioApplication(options);
  try {
    await application.start();
    return application;
  } catch (error) {
    await application.dispose().catch(() => {});
    throw error;
  }
}
