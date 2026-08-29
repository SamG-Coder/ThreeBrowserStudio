import { lstat, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  AtomicProjectStore,
  AuthoringKernel,
  buildBeautyDigest,
  buildMeshElements,
  buildProjectVisibility,
  MAX_INSPECT_RESPONSE_BYTES,
  ProjectIndex,
  PROTOCOL_VERSION,
  StudioError,
  atomicWriteJson,
  analyzeViewportModifierStack,
  AUTHORABLE_MODIFIER_TYPES,
  buildModifierDigest,
  contentHash,
  createProjectDocument,
  createResourceDocument,
  DATA_TEXTURE_LIMITS,
  dataTextureGpuByteLength,
  EDITABLE_MESH_ATTRIBUTE_COMMAND_TYPES,
  hashExactEntitySet,
  LIVE_EDITABLE_MESH_GEOMETRY_MODIFIERS,
  LIVE_INSTANCE_MODIFIER_TYPES,
  encodeObjectIdRgb01,
  forecastPixelImpact,
  loadObjectIdEvidence,
  MATERIAL_TEXTURE_BINDINGS,
  MATERIAL_TEXTURE_CONTROL_CONTRACT,
  MAX_MODIFIERS_PER_ENTITY,
  normalizeDataTextureResource,
  normalizeGraphResourcePatch,
  normalizeResourceType,
  supportedOperationTypes,
  validateProjectDocument,
} from '../core/index.mjs';
import { GEOMETRY_MODIFIER_TYPES } from '../core/geometry-modifier-evaluator.mjs';
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
import { TOOL_CONTRACT, TOOL_CONTRACT_SUMMARY, TOOL_SCHEMAS } from '../mcp/tool-schemas.mjs';
import { compileSceneDocument } from './scene-compiler.mjs';
import { validateAnimationResource } from './animation-runtime.mjs';
import { frameCameraToBounds } from '../viewport/camera-projection.mjs';
import { describeEffectiveCamera } from '../viewport/camera-evidence.mjs';
import { operationsSnapFollowShot } from '../viewport/view-mode.mjs';
import { buildExplorerOutline } from '../viewport/scene-explorer.mjs';
import { LAYOUT_PATTERN_MODES } from '../core/layout-patterns.mjs';
import { RTX_SCENE_LIMITS } from './rtx-scene-collector.mjs';
import { normalizeGeometryRecipe } from './resource-factories.mjs';

const INSPECT_RESPONSE_ENVELOPE_RESERVE_BYTES = 2_048;

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
  'resource.create', 'resource.patch', 'resource.delete',
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

export function translateToolOperation(operation, document) {
  const data = operation.data ?? {};
  if (DIRECT_CORE_OPERATIONS.has(operation.op)) {
    const direct = structuredClone(operation);
    if (direct.op === 'camera.frame') {
      const target = direct.target;
      direct.bounds = target?.bounds;
      direct.targetIds = target?.targetIds;
      delete direct.target;
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

export function materializeCameraFrameOperation(operation, { compiled, THREE } = {}) {
  if (operation?.op !== 'camera.frame' && operation?.type !== 'camera.frame') return operation;
  if (operation.bounds !== undefined) return operation;
  if (!Array.isArray(operation.targetIds) || operation.targetIds.length === 0) {
    throw new StudioError('invalid_camera_frame_targets', 'camera.frame requires targetIds or explicit bounds.');
  }
  if (!compiled || !THREE?.Box3) {
    throw new StudioError('camera_frame_runtime_unavailable', 'camera.frame target bounds require the active compiled scene.');
  }
  compiled.root?.updateWorldMatrix?.(true, true);
  const bounds = new THREE.Box3();
  for (const targetId of operation.targetIds) {
    const object = compiled.objects?.get?.(targetId);
    if (!object) {
      throw new StudioError(
        'camera_frame_target_not_compiled',
        `camera.frame target ${targetId} is not present in the active compiled revision; use explicit bounds for entities created in this transaction.`,
        { targetId },
      );
    }
    bounds.expandByObject(object, true);
  }
  if (bounds.isEmpty()) {
    throw new StudioError('camera_frame_bounds_empty', 'camera.frame targetIds produced no renderable bounds.', {
      targetIds: structuredClone(operation.targetIds),
    });
  }
  return {
    ...operation,
    bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
  };
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
  const values = Object.fromEntries(
    Object.keys(resource)
      .filter(key => !identity.has(key))
      .sort((a, b) => a.localeCompare(b))
      .map(key => [key, resource[key]]),
  );
  return compactComponentValue(values, 'components', values, {
    remaining: RESOURCE_COMPONENT_VALUE_BUDGET,
  });
}

function explicitGeometrySummary(resource, { includeBounds = false } = {}) {
  const recipe = geometryRecipe(resource);
  const recipeKind = recipe === resource
    ? (resource?.geometryKind ?? resource?.type ?? resource?.kind)
    : (recipe?.kind ?? recipe?.type ?? resource?.geometryKind ?? resource?.kind);
  const output = { recipeKind: compactString(recipeKind ?? 'box', 80) };
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
  #disposed = false;
  #viewHash = null;
  #beginCommand = null;

  constructor({ THREE, TSL, viewport, bootstrap, markerPath, credentials, beginCommand } = {}) {
    this.#THREE = THREE;
    this.#TSL = TSL;
    this.#viewport = viewport;
    this.#bootstrap = bootstrap;
    this.#credentials = credentials ?? createSessionCredentials();
    this.#beginCommand = typeof beginCommand === 'function' ? beginCommand : null;
    const studioRoot = process.env.THREE_STUDIO_ROOT ?? process.cwd();
    this.studioRoot = path.resolve(studioRoot);
    this.projectsRoot = path.join(this.studioRoot, 'projects');
    this.#markerPath = path.resolve(markerPath ?? process.env.THREE_STUDIO_SESSION_MARKER ?? defaultSessionMarkerPath());
    this.#localStatePath = path.join(path.dirname(this.#markerPath), 'studio-state.json');
  }

  get sessionId() { return this.#credentials.sessionId; }
  get markerPath() { return this.#markerPath; }
  get kernel() { return this.#kernel; }

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
    const candidate = await this.#compile(document);
    if (context.dryRun === true) {
      candidate.dispose();
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
      } else created = createProjectDocument({ projectId, name });
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
        simulation: 'animation-only',
        actions: this.#compiled?.animationStates() ?? [],
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
        graphCompilation: Boolean(this.#TSL),
        graphRuntime: this.#TSL ? 'three-tsl-webgpu' : null,
        proceduralTextureBake: true,
        graphValidation: true,
        blenderShaderNodes: BLENDER_SHADER_NODE_INVENTORY_SUMMARY,
        blenderCatalog: true,
        blenderCatalogSummary: BLENDER_CATALOG_SUMMARY,
        animationRuntime: Boolean(this.#compiled?.animationRuntime),
        animationActions: this.#compiled?.animationActions ?? [],
        jobs: false,
        graphDomains: ['shader', 'texture', 'blueprint'],
        entityKinds: [
          'scene', 'group', 'empty', 'gameObject', 'mesh', 'instancedMesh',
          'perspectiveCamera', 'orthographicCamera', 'directionalLight',
          'pointLight', 'spotLight', 'ambientLight', 'areaLight', 'hemisphereLight',
        ],
        geometryRecipes: ['box', 'plane', 'sphere', 'capsule', 'circle', 'cone', 'cylinder', 'torus', 'torusKnot', 'lathe', 'tube', 'shape', 'extrude', 'explicit', 'indexedMesh', 'editableMesh'],
        geometryEditing: true,
        geometryEditCommands: [
          'move', 'scale', 'rotate', 'smooth', 'recalculateNormals', 'weld', 'triangulate',
          'subdivideFaces', 'insetFaces', 'extrudeFaces', 'bevelEdges', 'deleteFaces', 'mergeVertices',
          ...EDITABLE_MESH_ATTRIBUTE_COMMAND_TYPES,
        ],
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
        renderPasses: ['beauty', 'objectId'],
        viewportReviewMode: true,
        overlayInvalidation: true,
        applyPixelForecast: true,
        compileHeavyRpcTimeoutMs: 120_000,
        validationChecks: ['schemas', 'references', 'hierarchy', 'graphs', 'animations', 'budgets'],
        projectActions: ['list', 'create', 'open', 'save'],
        historyActions: ['list', 'inspect', 'undo', 'redo'],
        playSimulation: 'animation-only',
        maxShadowLights: 16,
        maxOperations: 128,
        implementedOperations: supportedOperationTypes(),
        toolContract: TOOL_CONTRACT_SUMMARY,
      },
      latestEvidence: this.#latestEvidence,
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
      case 'three_studio_status': return this.status();
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
      case 'three_studio_job': throw new StudioError('job_not_implemented', 'File-producing jobs are not enabled in the lean authoring slice yet.');
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
    if (params.action === 'create' && params.template && params.template !== 'starter') {
      throw new StudioError('template_not_found', `Unknown project template ${params.template}.`);
    }
    if (params.action === 'create') return {
      success: true,
      ...(await this.#openOrCreate(this.#managedProjectPath(params.path), {
        create: true,
        mustBeNew: true,
        name: params.name,
        template: params.template === 'starter' ? 'starter' : null,
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
      simulation: 'animation-only',
      ...this.#play,
      timeline: scene.settings.timeline,
      actions: this.#compiled?.animationStates() ?? [],
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
    const document = this.#kernel.document;
    const operations = params.operations.map(operation => materializeCameraFrameOperation(
      translateToolOperation(operation, document),
      { compiled: this.#compiled, THREE: this.#THREE },
    ));
    const pixelForecast = forecastPixelImpact({ before: document, operations });
    const response = await this.#kernel.apply({
      protocolVersion: params.protocolVersion,
      projectId: params.projectId,
      label: params.label,
      baseRevision: params.baseRevision,
      idempotencyKey: params.idempotencyKey,
      dryRun: params.dryRun ?? false,
      operations,
    }, { signal: context.signal });
    if (response.success && params.dryRun !== true && operationsSnapFollowShot(operations)) {
      this.#viewport.followShot?.();
    }
    return {
      ...response,
      sessionId: this.sessionId,
      projectId: this.#kernel.projectId,
      evidenceRequested: params.evidence === true,
      pixelForecast,
    };
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
        if (pass === 'objectId') {
          evidence.push(await this.#captureObjectId(captureCamera, params));
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
    });
    if (params.action === 'query') return {
      success: true,
      mode: this.#mode,
      simulation: 'animation-only',
      ...this.#play,
      ...animationState(),
    };
    if (params.baseRevision !== this.#kernel.revision) throw new StudioError('revision_conflict', `Base revision ${params.baseRevision} does not match ${this.#kernel.revision}.`);
    if (params.action === 'enter') {
      this.#mode = 'play';
      this.#play = { paused: false, tick: 0, elapsed: 0, latestInput: null };
      this.#compiled?.setAnimationTime(0);
      for (const action of this.#compiled?.animationRuntime?.actions.values() ?? []) {
        if (action.autoplay) this.#compiled.animationRuntime.play(action.id, { restart: true });
        else this.#compiled.animationRuntime.pause(action.id);
      }
    }
    else if (params.action === 'stop') {
      this.#mode = 'author';
      this.#play = { paused: false, tick: 0, elapsed: 0, latestInput: null };
      const authoredTime = (timeline.currentFrame - timeline.frameStart) / timeline.framesPerSecond;
      this.#compiled?.setAnimationTime(authoredTime);
      for (const action of this.#compiled?.animationRuntime?.actions.values() ?? []) {
        this.#compiled.animationRuntime.pause(action.id);
      }
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
      simulation: 'animation-only',
      ...this.#play,
      ...animationState(),
      revision: this.#kernel.revision,
      warnings: [{ code: 'behavior_runtime_not_enabled', message: 'Play state is isolated, but scripts and blueprints are not executing yet.' }],
    };
  }

  update(deltaSeconds) {
    if (this.#disposed || this.#mode !== 'play' || this.#play.paused) return;
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    this.#play.elapsed += deltaSeconds;
    this.#play.tick = Math.round(this.#play.elapsed * 60);
    this.#compiled?.advanceAnimation(deltaSeconds);
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
    const compiled = this.#compiled;
    if (typeof this.#viewport.setAppearance === 'function') this.#viewport.setAppearance({});
    else {
      if (this.#viewport.scene.background === compiled?.background) this.#viewport.scene.background = null;
      if (this.#viewport.scene.backgroundNode === compiled?.backgroundNode) this.#viewport.scene.backgroundNode = null;
      if (this.#viewport.scene.fog === compiled?.fog) this.#viewport.scene.fog = null;
    }
    compiled?.dispose();
    this.#prepared = null;
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
