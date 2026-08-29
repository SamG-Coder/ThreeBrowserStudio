import { MAX_OPERATIONS_PER_TRANSACTION } from './constants.mjs';
import {
  assertValidProjectDocument,
  createCollectionDocument,
  createEntityDocument,
  createResourceDocument,
  createSceneDocument,
  normalizeGraphResourcePatch,
  normalizeResourceType,
} from './documents.mjs';
import { StudioError, studioAssert } from './errors.mjs';
import { assertStableId, assertTransactionAlias, resolveId } from './ids.mjs';
import { buildProjectIndex } from './indexes.mjs';
import {
  assertExpectedEntitySetHash,
  resolveExactEntitySelection,
} from './entity-selection.mjs';
import {
  composeEntityTransforms,
  composeTransformMatrix,
  entityWorldMatrix,
  multiplyTransformMatrices,
  relativeEntityTransform,
} from './transform-math.mjs';
import { solveCameraFrame } from './camera-framing.mjs';
import { applyIndexedMeshEdit, validateIndexedMeshRecipe } from './indexed-mesh-editing.mjs';
import {
  applyEditableMeshEdit,
  editableMeshTopologyHash,
  normalizeEditableMeshRecipe,
} from './editable-mesh.mjs';
import {
  EDITABLE_MESH_ATTRIBUTE_COMMAND_TYPES,
  applyEditableMeshAttributeEdit,
} from './editable-mesh-attributes.mjs';
import { DATA_TEXTURE_RECIPE_KEYS } from './image-texture.mjs';
import { normalizeLayoutPattern } from './layout-patterns.mjs';
import { DEFAULT_RTX_SETTINGS, normalizeRtxSettings } from './rtx-settings.mjs';
import {
  assertExpectedModifierStackHash,
  MAX_MODIFIERS_PER_ENTITY,
  normalizeModifierDocument,
  normalizedModifierStack,
} from './modifier-stack.mjs';
import { MATERIAL_TEXTURE_ID_KEYS } from './material-textures.mjs';
import { cloneJson, contentHash, isPlainRecord, mergePatch, uniqueSorted } from './util.mjs';

const MAX_GEOMETRY_EDIT_COMMANDS = 64;
const GEOMETRY_RECIPE_FIELDS = Object.freeze([
  'positions', 'indices', 'normals', 'uvs', 'colors', 'computeNormals', 'triangleMaterialIndices',
  'faceOffsets', 'cornerVertexIndices', 'uvLayers', 'colorLayers',
  'activeUvLayer', 'activeColorLayer', 'faceMaterialIndices', 'sharpEdges', 'edgeCreases',
]);
const GEOMETRY_EDIT_KEYS = new Map([
  ['move', new Set(['type', 'vertexIndices', 'selection', 'offset'])],
  ['scale', new Set(['type', 'vertexIndices', 'selection', 'scale', 'pivot'])],
  ['rotate', new Set(['type', 'vertexIndices', 'selection', 'rotation', 'axis', 'angle', 'pivot'])],
  ['smooth', new Set(['type', 'vertexIndices', 'selection', 'iterations', 'factor', 'preserveBoundary'])],
  ['recalculateNormals', new Set(['type'])],
  ['weld', new Set(['type', 'tolerance'])],
  ['triangulate', new Set(['type'])],
  ['subdivideFaces', new Set(['type', 'faceIndices', 'selection'])],
  ['insetFaces', new Set(['type', 'faceIndices', 'selection', 'factor'])],
  ['extrudeFaces', new Set(['type', 'faceIndices', 'selection', 'mode', 'offset', 'distance', 'sideMaterialIndex'])],
  ['bevelEdges', new Set(['type', 'edges', 'edgeVertexIndices', 'factor', 'materialIndex'])],
  ['deleteFaces', new Set(['type', 'faceIndices', 'selection'])],
  ['mergeVertices', new Set(['type', 'vertexIndices', 'selection', 'targetVertexIndex', 'position'])],
  ['createUvLayer', new Set(['type', 'name', 'fill', 'values', 'setActive'])],
  ['deleteUvLayer', new Set(['type', 'name', 'nextActiveLayer'])],
  ['renameUvLayer', new Set(['type', 'name', 'newName'])],
  ['setActiveUvLayer', new Set(['type', 'name'])],
  ['setCornerUvs', new Set(['type', 'layer', 'cornerIndices', 'values'])],
  ['transformUvs', new Set(['type', 'layer', 'cornerIndices', 'translation', 'scale', 'rotation', 'pivot'])],
  ['projectUvs', new Set(['type', 'layer', 'cornerIndices', 'axis', 'scale', 'offset'])],
  ['createColorLayer', new Set(['type', 'name', 'fill', 'values', 'setActive'])],
  ['deleteColorLayer', new Set(['type', 'name', 'nextActiveLayer'])],
  ['renameColorLayer', new Set(['type', 'name', 'newName'])],
  ['setActiveColorLayer', new Set(['type', 'name'])],
  ['setCornerColors', new Set(['type', 'layer', 'cornerIndices', 'values'])],
  ['assignFaceMaterials', new Set(['type', 'faceIndices', 'materialIndex', 'materialIndices'])],
  ['setSharpEdges', new Set(['type', 'edges', 'sharp'])],
  ['setEdgeCreases', new Set(['type', 'edges', 'weight'])],
  ['removeEdgeCreases', new Set(['type', 'edges'])],
]);
const INDEXED_GEOMETRY_EDIT_TYPES = new Set([
  'move', 'scale', 'rotate', 'smooth', 'recalculateNormals', 'weld', 'triangulate',
]);
const EDITABLE_GEOMETRY_EDIT_TYPES = new Set([
  'move', 'scale', 'rotate', 'smooth', 'recalculateNormals', 'subdivideFaces', 'insetFaces', 'extrudeFaces',
  'bevelEdges', 'deleteFaces', 'mergeVertices',
  ...EDITABLE_MESH_ATTRIBUTE_COMMAND_TYPES,
]);
const RTX_PATCH_KEYS = new Set(['enabled', ...Object.keys(DEFAULT_RTX_SETTINGS)]);
const MODIFIER_STACK_EDIT_KEYS = new Map([
  ['create', new Set(['type', 'modifier', 'index'])],
  ['patch', new Set(['type', 'modifierId', 'patch'])],
  ['move', new Set(['type', 'modifierId', 'index'])],
  ['delete', new Set(['type', 'modifierId'])],
]);

const OPERATION_KEYS = new Map([
  ['scene.create', new Set(['type', 'op', 'scene', 'alias', 'index'])],
  ['scene.patch', new Set(['type', 'op', 'sceneId', 'patch'])],
  ['scene.delete', new Set(['type', 'op', 'sceneId', 'expectedSceneHash'])],
  ['scene.setActive', new Set(['type', 'op', 'sceneId'])],
  ['scene.settings.patch', new Set(['type', 'op', 'sceneId', 'patch'])],
  ['scene.rtx.patch', new Set(['type', 'op', 'sceneId', 'patch'])],
  ['scene.setActiveCamera', new Set(['type', 'op', 'sceneId', 'cameraId'])],
  ['entity.create', new Set(['type', 'op', 'sceneId', 'entity', 'alias', 'index'])],
  ['entity.patch', new Set(['type', 'op', 'entityId', 'patch'])],
  ['entity.patchMany', new Set(['type', 'op', 'entityIds', 'patch', 'expectedEntitySetHash'])],
  ['entity.transformMany', new Set(['type', 'op', 'entityIds', 'mode', 'transform', 'expectedEntitySetHash'])],
  ['entity.group', new Set(['type', 'op', 'sceneId', 'entityIds', 'group', 'expectedEntitySetHash', 'alias', 'index'])],
  ['entity.ungroup', new Set(['type', 'op', 'entityId', 'expectedSubtreeHash'])],
  ['entity.duplicate', new Set(['type', 'op', 'entityId', 'newId', 'name', 'parentId', 'index', 'deep', 'idMap', 'alias'])],
  ['entity.reparent', new Set(['type', 'op', 'entityId', 'parentId', 'index'])],
  ['entity.delete', new Set(['type', 'op', 'entityId', 'recursive', 'expectedSubtreeHash'])],
  ['collection.create', new Set(['type', 'op', 'sceneId', 'collection', 'alias', 'index'])],
  ['collection.patch', new Set(['type', 'op', 'collectionId', 'patch'])],
  ['collection.membership.patch', new Set(['type', 'op', 'collectionId', 'addEntityIds', 'removeEntityIds', 'expectedMembershipHash'])],
  ['collection.reparent', new Set(['type', 'op', 'collectionId', 'parentId', 'index'])],
  ['collection.delete', new Set(['type', 'op', 'collectionId', 'recursive', 'expectedSubtreeHash'])],
  ['camera.frame', new Set(['type', 'op', 'cameraId', 'bounds', 'targetIds', 'aspect', 'padding', 'direction', 'lockPreviewAspect'])],
  ['layout.pattern', new Set(['type', 'op', 'entityId', 'pattern'])],
  ['modifier.create', new Set(['type', 'op', 'entityId', 'modifier', 'expectedStackHash', 'index'])],
  ['modifier.patch', new Set(['type', 'op', 'entityId', 'modifierId', 'patch', 'expectedStackHash'])],
  ['modifier.move', new Set(['type', 'op', 'entityId', 'modifierId', 'index', 'expectedStackHash'])],
  ['modifier.delete', new Set(['type', 'op', 'entityId', 'modifierId', 'expectedStackHash'])],
  ['modifier.stack.edit', new Set(['type', 'op', 'entityId', 'changes', 'expectedStackHash'])],
  ['geometry.edit', new Set(['type', 'op', 'resourceId', 'edits', 'expectedTopologyHash'])],
  ['resource.create', new Set(['type', 'op', 'resourceType', 'resource', 'alias'])],
  ['resource.patch', new Set(['type', 'op', 'resourceType', 'resourceId', 'patch'])],
  ['resource.delete', new Set(['type', 'op', 'resourceType', 'resourceId'])],
  ['_scene.restore', new Set(['type', 'sceneId', 'snapshot', 'index', 'activeSceneId', 'restoreActive', 'expectedCurrentHash'])],
  ['_scene.fields.restore', new Set(['type', 'sceneId', 'fields'])],
  ['_scene.settings.restore', new Set(['type', 'sceneId', 'fields'])],
  ['_entity.fields.restore', new Set(['type', 'entityId', 'fields'])],
  ['_entity.many.restore', new Set(['type', 'entries'])],
  ['_collection.fields.restore', new Set(['type', 'collectionId', 'fields'])],
  ['_resource.restore', new Set(['type', 'resourceType', 'resourceId', 'snapshot', 'expectedCurrentHash'])],
]);

const ENTITY_PATCH_KEYS = new Set(['kind', 'name', 'visible', 'transform', 'components', 'tags', 'scriptIds', 'metadata']);
const TRANSFORM_PATCH_KEYS = new Set(['position', 'rotation', 'scale']);
const COLLECTION_PATCH_KEYS = new Set(['name', 'metadata']);
const SCENE_PATCH_KEYS = new Set(['name', 'settings', 'scriptIds', 'metadata']);

function operationType(operation) {
  if (!isPlainRecord(operation)) throw new StudioError('invalid_operation', 'Each operation must be an object');
  if (operation.type && operation.op && operation.type !== operation.op) {
    throw new StudioError('invalid_operation', 'Operation type and op disagree');
  }
  const type = operation.type ?? operation.op;
  if (typeof type !== 'string') throw new StudioError('invalid_operation', 'Operation type is required');
  return type;
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new StudioError('unknown_property', `${label} contains unknown property ${key}`, { key });
  }
}

function assertPatchKeys(patch, allowed, label) {
  studioAssert(isPlainRecord(patch), 'invalid_patch', `${label} must be an object`);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new StudioError('unknown_property', `${label} cannot patch ${key}`, { key });
  }
}

function addAlias(aliases, resolvedIds, alias, id) {
  if (!alias) return;
  assertTransactionAlias(alias);
  if (aliases.has(alias)) throw new StudioError('duplicate_alias', `Alias ${alias} is already defined`);
  aliases.set(alias, id);
  resolvedIds[alias] = id;
}

function resolveEntityReferences(source, aliases) {
  const resolved = value => aliases.get(value) ?? value;
  if (source.parentId && aliases.has(source.parentId)) source.parentId = aliases.get(source.parentId);
  if (Array.isArray(source.scriptIds)) source.scriptIds = source.scriptIds.map(resolved);
  if (source.components?.mesh?.geometryId && aliases.has(source.components.mesh.geometryId)) {
    source.components.mesh.geometryId = aliases.get(source.components.mesh.geometryId);
  }
  if (source.components?.mesh?.materialId) {
    source.components.mesh.materialId = resolved(source.components.mesh.materialId);
  }
  if (Array.isArray(source.components?.mesh?.materialIds)) {
    source.components.mesh.materialIds = source.components.mesh.materialIds.map(resolved);
  }
  if (source.components?.light?.targetId) source.components.light.targetId = resolved(source.components.light.targetId);
  if (Array.isArray(source.components?.constraints)) {
    for (const constraint of source.components.constraints) {
      if (constraint?.targetId) constraint.targetId = resolved(constraint.targetId);
    }
  }
  if (source.components?.animation?.actionId) source.components.animation.actionId = resolved(source.components.animation.actionId);
  if (source.components?.prefab?.prefabId) source.components.prefab.prefabId = resolved(source.components.prefab.prefabId);
  if (source.components?.audio?.audioId) source.components.audio.audioId = resolved(source.components.audio.audioId);
  return source;
}

function resolveExactIds(values, aliases, label) {
  studioAssert(Array.isArray(values), 'invalid_operation', `${label} must be an array of exact entity IDs`);
  return values.map((value, index) => resolveId(value, aliases, `${label}[${index}]`));
}

function resolveCollectionReferences(source, aliases) {
  if (!isPlainRecord(source)) return source;
  if (source.parentId && aliases.has(source.parentId)) source.parentId = aliases.get(source.parentId);
  if (Array.isArray(source.entityIds)) {
    source.entityIds = source.entityIds.map((value, index) => resolveId(value, aliases, `collection.entityIds[${index}]`));
  }
  return source;
}

function resolveResourceReferences(source, resourceType, aliases) {
  if (!isPlainRecord(source)) return source;
  if (resourceType === 'materials') {
    for (const values of [source, source.recipe, source.parameters, source.values]) {
      if (!isPlainRecord(values)) continue;
      if (values.graphId) values.graphId = aliases.get(values.graphId) ?? values.graphId;
      for (const key of MATERIAL_TEXTURE_ID_KEYS) {
        if (values[key]) values[key] = aliases.get(values[key]) ?? values[key];
      }
    }
  }
  if (resourceType === 'graphs') {
    const graph = source.graph ?? source;
    for (const node of graph.nodes ?? []) {
      if (!isPlainRecord(node?.params)) continue;
      for (const key of ['textureId', 'assetId']) {
        if (node.params[key]) node.params[key] = aliases.get(node.params[key]) ?? node.params[key];
      }
    }
  }
  return source;
}

function normalizeTextureResourcePatch(source) {
  const patch = cloneJson(source);
  const directKind = patch.textureKind ?? patch.type ?? patch.kind;
  const directKeys = DATA_TEXTURE_RECIPE_KEYS.filter(key => (
    !['kind', 'name'].includes(key) && Object.hasOwn(patch, key)
  ));
  const hasRecipe = Object.hasOwn(patch, 'recipe');
  const hasParameters = Object.hasOwn(patch, 'parameters');
  studioAssert(!(hasRecipe && hasParameters), 'ambiguous_texture_patch', 'Texture patches cannot define both recipe and parameters.');
  studioAssert(
    directKeys.length === 0 || (!hasRecipe && !hasParameters),
    'ambiguous_texture_patch',
    'Texture patches cannot mix nested and direct texture fields.',
    { directFields: directKeys },
  );
  if (hasParameters) {
    patch.recipe = patch.parameters;
    delete patch.parameters;
  }
  if (directKeys.length > 0 || (directKind === 'dataTexture' && !hasRecipe && !hasParameters)) {
    patch.recipe = Object.fromEntries(directKeys.map(key => [key, patch[key]]));
    if (directKind === 'dataTexture') {
      patch.recipe.kind = 'dataTexture';
    }
    for (const key of directKeys) delete patch[key];
    if (patch.kind === 'dataTexture') delete patch.kind;
    if (patch.type === 'dataTexture') delete patch.type;
    if (patch.textureKind === 'dataTexture') delete patch.textureKind;
  }
  if (isPlainRecord(patch.recipe)) {
    const hasPixels = Object.hasOwn(patch.recipe, 'pixels') && patch.recipe.pixels !== null;
    const hasData = Object.hasOwn(patch.recipe, 'data') && patch.recipe.data !== null;
    studioAssert(!(hasPixels && hasData), 'ambiguous_texture_patch', 'Texture patches accept pixels or data, not both.');
    if (hasPixels) patch.recipe.data = null;
    if (hasData) patch.recipe.pixels = null;
  }
  return patch;
}

function entityMutationInverse(entries) {
  return {
    type: '_entity.many.restore',
    entries: entries.map(({ entityId, snapshot, current }) => ({
      entityId,
      snapshot: cloneJson(snapshot),
      expectedCurrentHash: contentHash(current),
    })),
  };
}

function insertAt(list, value, index) {
  const target = Number.isInteger(index) ? Math.max(0, Math.min(index, list.length)) : list.length;
  list.splice(target, 0, value);
  return target;
}

function removeFrom(list, value) {
  const index = list.indexOf(value);
  if (index >= 0) list.splice(index, 1);
  return index;
}

function captureFields(value, fieldNames) {
  return Object.fromEntries(fieldNames.map((field) => [field, Object.hasOwn(value, field)
    ? { present: true, value: cloneJson(value[field]) }
    : { present: false }]));
}

function restoreFields(value, fields) {
  const inverse = captureFields(value, Object.keys(fields));
  for (const [field, snapshot] of Object.entries(fields)) {
    if (snapshot.present) value[field] = cloneJson(snapshot.value);
    else delete value[field];
  }
  return inverse;
}

function assertStrictSuppliedModifiers(entityLike, label) {
  const components = entityLike?.components;
  if (!isPlainRecord(components) || !Object.hasOwn(components, 'modifiers')) return;
  // JSON Merge Patch uses null to remove a field. Clearing a legacy stack is
  // allowed; any replacement stack is newly authored and must use the strict
  // canonical modifier contract.
  if (components.modifiers === null) return;
  try {
    normalizedModifierStack(
      { components: { modifiers: components.modifiers } },
      { allowLegacyUnknown: false },
    );
  } catch (error) {
    if (error instanceof StudioError) {
      error.details = { ...(error.details ?? {}), operationPath: `${label}.components.modifiers` };
    }
    throw error;
  }
}

function assertIndexFree(draft, id) {
  const index = buildProjectIndex(draft);
  if (index.scenes.has(id) || index.entities.has(id) || index.collections.has(id) || index.resources.has(id) || index.scripts.has(id) || draft.projectId === id) {
    throw new StudioError('duplicate_id', `Stable ID ${id} is already in use`, { id });
  }
}

function invalidationsFor(type, operation) {
  if (type.startsWith('_scene.')) return ['sceneGraph', 'renderer', 'rtxTopology', 'persistence'];
  if (type.startsWith('_entity.')) return ['sceneGraph', 'transforms', 'renderer', 'rtxTransforms', 'persistence'];
  if (type.startsWith('_collection.')) return ['selection', 'persistence'];
  if (type.startsWith('_resource.')) {
    const resourceType = normalizeResourceType(operation.resourceType);
    return uniqueSorted([
      resourceType, 'renderer', 'persistence',
      ...(resourceType === 'geometries' ? ['rtxTopology'] : []),
      ...(['materials', 'textures', 'graphs'].includes(resourceType) ? ['materials'] : []),
    ]);
  }
  if (type.startsWith('scene.')) return ['sceneGraph', 'renderer', 'rtxTopology', 'persistence'];
  if (type === 'camera.frame') return ['sceneGraph', 'transforms', 'renderer', 'persistence'];
  if (type === 'entity.reparent') return ['sceneGraph', 'transforms', 'renderer', 'rtxTransforms', 'persistence'];
  if (type === 'entity.transformMany') return ['transforms', 'renderer', 'rtxTransforms', 'persistence'];
  if (type === 'entity.group' || type === 'entity.ungroup') return ['sceneGraph', 'transforms', 'renderer', 'rtxTransforms', 'persistence'];
  if (type === 'entity.patchMany') {
    const fields = Object.keys(operation.patch ?? {});
    const result = ['renderer', 'persistence'];
    if (fields.includes('transform')) result.push('transforms', 'rtxTransforms');
    if (fields.includes('components') || fields.includes('kind')) result.push('sceneGraph', 'geometry', 'materials', 'rtxTopology');
    return result;
  }
  if (type.startsWith('collection.')) return ['selection', 'persistence'];
  if (type === 'layout.pattern') return ['sceneGraph', 'transforms', 'geometry', 'renderer', 'rtxTopology', 'persistence'];
  if (type.startsWith('modifier.')) return ['sceneGraph', 'geometry', 'transforms', 'renderer', 'rtxTopology', 'persistence'];
  if (type === 'geometry.edit') return ['geometry', 'renderer', 'rtxTopology', 'persistence'];
  if (type === 'entity.patch') {
    const fields = Object.keys(operation.patch ?? {});
    const result = ['renderer', 'persistence'];
    if (fields.includes('transform')) result.push('transforms', 'rtxTransforms');
    if (fields.includes('components') || fields.includes('kind')) result.push('sceneGraph', 'geometry', 'materials', 'rtxTopology');
    return result;
  }
  if (type.startsWith('entity.')) return ['sceneGraph', 'renderer', 'rtxTopology', 'persistence'];
  if (type.startsWith('resource.')) {
    const resourceType = normalizeResourceType(operation.resourceType);
    const result = [resourceType, 'renderer', 'persistence'];
    if (resourceType === 'geometries') result.push('rtxTopology');
    if (resourceType === 'materials' || resourceType === 'textures' || resourceType === 'graphs') result.push('materials');
    return result;
  }
  return ['document', 'renderer', 'persistence'];
}

function applySceneCreate(draft, operation, aliases, resolvedIds) {
  const previousActiveSceneId = draft.activeSceneId;
  const sceneInput = cloneJson(operation.scene);
  studioAssert(isPlainRecord(sceneInput), 'invalid_operation', 'scene.create requires scene');
  if (sceneInput.id && aliases.has(sceneInput.id)) sceneInput.id = aliases.get(sceneInput.id);
  const sceneEntities = Array.isArray(sceneInput.entities) ? sceneInput.entities : Object.values(sceneInput.entities ?? {});
  for (const entity of sceneEntities) {
    resolveEntityReferences(entity, aliases);
    assertStrictSuppliedModifiers(entity, 'scene.create.scene.entities');
  }
  const sceneCollections = Array.isArray(sceneInput.collections) ? sceneInput.collections : Object.values(sceneInput.collections ?? {});
  for (const collection of sceneCollections) resolveCollectionReferences(collection, aliases);
  if (sceneInput.settings?.activeCameraId && aliases.has(sceneInput.settings.activeCameraId)) {
    sceneInput.settings.activeCameraId = aliases.get(sceneInput.settings.activeCameraId);
  }
  if (Array.isArray(sceneInput.scriptIds)) sceneInput.scriptIds = sceneInput.scriptIds.map((id) => aliases.get(id) ?? id);
  const scene = createSceneDocument(sceneInput);
  assertIndexFree(draft, scene.id);
  draft.scenes[scene.id] = scene;
  const index = insertAt(draft.sceneOrder, scene.id, operation.index);
  if (draft.activeSceneId === null) draft.activeSceneId = scene.id;
  addAlias(aliases, resolvedIds, operation.alias, scene.id);
  return {
    resolved: { type: 'scene.create', scene: cloneJson(scene), index },
    inverse: {
      type: '_scene.restore', sceneId: scene.id, snapshot: null, index,
      activeSceneId: previousActiveSceneId, restoreActive: previousActiveSceneId === null,
      expectedCurrentHash: contentHash(scene),
    },
  };
}

function applyScenePatch(draft, operation, aliases) {
  const sceneId = resolveId(operation.sceneId, aliases, 'sceneId');
  const scene = buildProjectIndex(draft).getScene(sceneId);
  assertPatchKeys(operation.patch, SCENE_PATCH_KEYS, 'scene.patch');
  const fields = captureFields(scene, Object.keys(operation.patch));
  const patched = createSceneDocument(mergePatch(scene, operation.patch));
  draft.scenes[sceneId] = patched;
  return {
    resolved: { type: 'scene.patch', sceneId, patch: cloneJson(operation.patch) },
    inverse: { type: '_scene.fields.restore', sceneId, fields },
  };
}

function applySceneDelete(draft, operation, aliases) {
  const sceneId = resolveId(operation.sceneId, aliases, 'sceneId');
  const scene = buildProjectIndex(draft).getScene(sceneId);
  if (Object.keys(scene.entities).length > 0) {
    studioAssert(operation.expectedSceneHash === contentHash(scene), 'guard_failed', 'Deleting a non-empty scene requires its exact expectedSceneHash', {
      expectedSceneHash: operation.expectedSceneHash,
      actualSceneHash: contentHash(scene),
    });
  }
  const index = draft.sceneOrder.indexOf(sceneId);
  const activeSceneId = draft.activeSceneId;
  delete draft.scenes[sceneId];
  removeFrom(draft.sceneOrder, sceneId);
  if (draft.activeSceneId === sceneId) draft.activeSceneId = draft.sceneOrder[0] ?? null;
  return {
    resolved: { type: 'scene.delete', sceneId, ...(operation.expectedSceneHash ? { expectedSceneHash: operation.expectedSceneHash } : {}) },
    inverse: {
      type: '_scene.restore', sceneId, snapshot: cloneJson(scene), index, activeSceneId,
      restoreActive: activeSceneId === sceneId,
      expectedCurrentHash: null,
    },
  };
}

function applySceneSetActive(draft, operation, aliases) {
  const sceneId = resolveId(operation.sceneId, aliases, 'sceneId');
  buildProjectIndex(draft).getScene(sceneId);
  const previous = draft.activeSceneId;
  draft.activeSceneId = sceneId;
  return {
    resolved: { type: 'scene.setActive', sceneId },
    inverse: previous ? { type: 'scene.setActive', sceneId: previous } : { type: '_scene.restore', sceneId: '__none__', snapshot: null, index: -1, activeSceneId: null, restoreActive: true },
  };
}

function applySceneSettings(draft, operation, aliases) {
  const sceneId = resolveId(operation.sceneId, aliases, 'sceneId');
  const scene = buildProjectIndex(draft).getScene(sceneId);
  studioAssert(isPlainRecord(operation.patch), 'invalid_patch', 'scene.settings.patch requires an object patch');
  const fields = captureFields(scene.settings, Object.keys(operation.patch));
  scene.settings = mergePatch(scene.settings, operation.patch);
  return {
    resolved: { type: 'scene.settings.patch', sceneId, patch: cloneJson(operation.patch) },
    inverse: { type: '_scene.settings.restore', sceneId, fields },
  };
}

function normalizeSceneRtxConfiguration(value = {}) {
  studioAssert(isPlainRecord(value), 'invalid_rtx_configuration', 'scene RTX configuration must be an object.');
  assertKnownKeys(value, RTX_PATCH_KEYS, 'scene RTX configuration');
  const { enabled = false, ...settings } = value;
  studioAssert(typeof enabled === 'boolean', 'invalid_rtx_configuration', 'scene RTX enabled must be boolean.');
  try {
    return { enabled, ...normalizeRtxSettings(settings) };
  } catch (error) {
    throw new StudioError(error.code ?? 'invalid_rtx_configuration', error.message, error.details);
  }
}

function applySceneRtxPatch(draft, operation, aliases) {
  const sceneId = resolveId(operation.sceneId, aliases, 'sceneId');
  const scene = buildProjectIndex(draft).getScene(sceneId);
  studioAssert(isPlainRecord(operation.patch), 'invalid_rtx_configuration', 'scene.rtx.patch requires an object patch.');
  assertKnownKeys(operation.patch, RTX_PATCH_KEYS, 'scene.rtx.patch');
  const current = normalizeSceneRtxConfiguration(scene.settings.rtx ?? {});
  const next = normalizeSceneRtxConfiguration({ ...current, ...cloneJson(operation.patch) });
  const fields = captureFields(scene.settings, ['rtx']);
  scene.settings.rtx = next;
  return {
    resolved: { type: 'scene.rtx.patch', sceneId, patch: cloneJson(operation.patch) },
    inverse: { type: '_scene.settings.restore', sceneId, fields },
  };
}

function applySceneSetCamera(draft, operation, aliases) {
  const sceneId = resolveId(operation.sceneId, aliases, 'sceneId');
  const scene = buildProjectIndex(draft).getScene(sceneId);
  const cameraId = operation.cameraId === null ? null : resolveId(operation.cameraId, aliases, 'cameraId');
  const fields = captureFields(scene.settings, ['activeCameraId']);
  scene.settings.activeCameraId = cameraId;
  return {
    resolved: { type: 'scene.setActiveCamera', sceneId, cameraId },
    inverse: { type: '_scene.settings.restore', sceneId, fields },
  };
}

function applyCollectionCreate(draft, operation, aliases, resolvedIds) {
  const sceneId = resolveId(operation.sceneId, aliases, 'sceneId');
  const scene = buildProjectIndex(draft).getScene(sceneId);
  const source = resolveCollectionReferences(cloneJson(operation.collection), aliases);
  studioAssert(isPlainRecord(source), 'invalid_operation', 'collection.create requires collection');
  studioAssert(!source.children || source.children.length === 0, 'invalid_operation', 'New collections cannot adopt children; use collection.reparent');
  const collection = createCollectionDocument(source);
  assertIndexFree(draft, collection.id);
  if (collection.parentId) {
    const parent = buildProjectIndex(draft).getCollection(collection.parentId);
    studioAssert(parent.sceneId === sceneId, 'cross_scene_parent', 'Collections cannot be parented across scenes');
  }
  if (collection.entityIds.length > 0) {
    resolveExactEntitySelection(draft, collection.entityIds, { requireSameScene: true, sceneId });
  }
  scene.collections[collection.id] = collection;
  const siblings = collection.parentId ? scene.collections[collection.parentId].children : scene.rootCollectionIds;
  const insertionIndex = insertAt(siblings, collection.id, operation.index);
  addAlias(aliases, resolvedIds, operation.alias, collection.id);
  return {
    resolved: { type: 'collection.create', sceneId, collection: cloneJson(collection), index: insertionIndex },
    inverse: { type: 'collection.delete', collectionId: collection.id, recursive: false },
  };
}

function applyCollectionPatch(draft, operation, aliases) {
  const collectionId = resolveId(operation.collectionId, aliases, 'collectionId');
  const { scene, collection } = buildProjectIndex(draft).getCollection(collectionId);
  assertPatchKeys(operation.patch, COLLECTION_PATCH_KEYS, 'collection.patch');
  const fields = captureFields(collection, Object.keys(operation.patch));
  scene.collections[collectionId] = createCollectionDocument(mergePatch(collection, cloneJson(operation.patch)));
  return {
    resolved: { type: 'collection.patch', collectionId, patch: cloneJson(operation.patch) },
    inverse: { type: '_collection.fields.restore', collectionId, fields },
  };
}

function applyCollectionMembershipPatch(draft, operation, aliases) {
  const collectionId = resolveId(operation.collectionId, aliases, 'collectionId');
  const { sceneId, scene, collection } = buildProjectIndex(draft).getCollection(collectionId);
  const addEntityIds = resolveExactIds(operation.addEntityIds ?? [], aliases, 'addEntityIds');
  const removeEntityIds = resolveExactIds(operation.removeEntityIds ?? [], aliases, 'removeEntityIds');
  studioAssert(addEntityIds.length + removeEntityIds.length > 0, 'invalid_collection_membership_patch', 'collection.membership.patch requires at least one added or removed entity');
  studioAssert(addEntityIds.length + removeEntityIds.length <= 200, 'entity_selection_too_large', 'A collection membership patch may target at most 200 entities', {
    count: addEntityIds.length + removeEntityIds.length,
    maximum: 200,
  });
  studioAssert(new Set(addEntityIds).size === addEntityIds.length, 'duplicate_entity_selection', 'addEntityIds cannot contain duplicates');
  studioAssert(new Set(removeEntityIds).size === removeEntityIds.length, 'duplicate_entity_selection', 'removeEntityIds cannot contain duplicates');
  const overlap = addEntityIds.filter((id) => removeEntityIds.includes(id));
  studioAssert(overlap.length === 0, 'invalid_collection_membership_patch', 'An entity cannot be added and removed in the same membership patch', { overlap });
  resolveExactEntitySelection(draft, [...addEntityIds, ...removeEntityIds], {
    allowEmpty: true,
    requireSameScene: true,
    sceneId,
  });
  const index = buildProjectIndex(draft);
  const actualMembershipHash = index.collectionMembershipHash(collectionId);
  studioAssert(operation.expectedMembershipHash === actualMembershipHash, 'guard_failed', 'Collection membership changed after it was inspected', {
    expectedMembershipHash: operation.expectedMembershipHash,
    actualMembershipHash,
  });
  const members = new Set(collection.entityIds);
  const alreadyPresent = addEntityIds.filter((id) => members.has(id));
  const alreadyAbsent = removeEntityIds.filter((id) => !members.has(id));
  studioAssert(alreadyPresent.length === 0 && alreadyAbsent.length === 0, 'collection_membership_conflict', 'Collection membership patch does not match the inspected membership', {
    alreadyPresent,
    alreadyAbsent,
  });
  for (const id of addEntityIds) members.add(id);
  for (const id of removeEntityIds) members.delete(id);
  const fields = captureFields(collection, ['entityIds']);
  collection.entityIds = [...members].sort();
  return {
    resolved: {
      type: 'collection.membership.patch', collectionId, addEntityIds, removeEntityIds,
      expectedMembershipHash: operation.expectedMembershipHash,
    },
    inverse: { type: '_collection.fields.restore', collectionId, fields },
  };
}

function applyCollectionReparent(draft, operation, aliases) {
  const collectionId = resolveId(operation.collectionId, aliases, 'collectionId');
  const record = buildProjectIndex(draft).getCollection(collectionId);
  const { scene, collection } = record;
  const parentId = operation.parentId === null ? null : resolveId(operation.parentId, aliases, 'parentId');
  if (parentId) {
    const parentRecord = buildProjectIndex(draft).getCollection(parentId);
    studioAssert(parentRecord.sceneId === record.sceneId, 'cross_scene_parent', 'Collections cannot be parented across scenes');
    studioAssert(!buildProjectIndex(draft).collectCollectionSubtree(collectionId).includes(parentId), 'collection_hierarchy_cycle', 'Cannot parent a collection beneath its own subtree');
  }
  const snapshot = cloneJson(scene);
  const oldSiblings = collection.parentId ? scene.collections[collection.parentId].children : scene.rootCollectionIds;
  removeFrom(oldSiblings, collectionId);
  collection.parentId = parentId;
  const newSiblings = parentId ? scene.collections[parentId].children : scene.rootCollectionIds;
  insertAt(newSiblings, collectionId, operation.index);
  return {
    resolved: { type: 'collection.reparent', collectionId, parentId, ...(operation.index === undefined ? {} : { index: operation.index }) },
    inverse: {
      type: '_scene.restore', sceneId: scene.id, snapshot, index: draft.sceneOrder.indexOf(scene.id),
      restoreActive: false, expectedCurrentHash: contentHash(scene),
    },
  };
}

function applyCollectionDelete(draft, operation, aliases) {
  const collectionId = resolveId(operation.collectionId, aliases, 'collectionId');
  const index = buildProjectIndex(draft);
  const { scene, collection } = index.getCollection(collectionId);
  const subtree = index.collectCollectionSubtree(collectionId);
  if (subtree.length > 1) {
    studioAssert(operation.recursive === true, 'non_empty_collection', 'Collection has children; recursive delete was not requested');
    const actual = index.collectionSubtreeHash(collectionId);
    studioAssert(operation.expectedSubtreeHash === actual, 'guard_failed', 'Recursive collection delete requires the exact expectedSubtreeHash', {
      expectedSubtreeHash: operation.expectedSubtreeHash,
      actualSubtreeHash: actual,
    });
  }
  const snapshot = cloneJson(scene);
  const siblings = collection.parentId ? scene.collections[collection.parentId].children : scene.rootCollectionIds;
  removeFrom(siblings, collectionId);
  for (const id of subtree.reverse()) delete scene.collections[id];
  return {
    resolved: {
      type: 'collection.delete', collectionId, recursive: operation.recursive === true,
      ...(operation.expectedSubtreeHash ? { expectedSubtreeHash: operation.expectedSubtreeHash } : {}),
    },
    inverse: {
      type: '_scene.restore', sceneId: scene.id, snapshot, index: draft.sceneOrder.indexOf(scene.id),
      restoreActive: false, expectedCurrentHash: contentHash(scene),
    },
  };
}

function applyEntityCreate(draft, operation, aliases, resolvedIds) {
  const sceneId = resolveId(operation.sceneId, aliases, 'sceneId');
  const scene = buildProjectIndex(draft).getScene(sceneId);
  const source = cloneJson(operation.entity);
  studioAssert(isPlainRecord(source), 'invalid_operation', 'entity.create requires entity');
  if (aliases.has(source.id)) source.id = aliases.get(source.id);
  resolveEntityReferences(source, aliases);
  assertStrictSuppliedModifiers(source, 'entity.create.entity');
  studioAssert(!source.children || source.children.length === 0, 'invalid_operation', 'New entities cannot adopt children; use entity.reparent');
  const entity = createEntityDocument(source);
  assertIndexFree(draft, entity.id);
  if (entity.parentId) {
    const parent = buildProjectIndex(draft).getEntity(entity.parentId);
    studioAssert(parent.sceneId === sceneId, 'cross_scene_parent', 'Entities cannot be parented across scenes');
  }
  scene.entities[entity.id] = entity;
  const siblings = entity.parentId ? scene.entities[entity.parentId].children : scene.rootEntityIds;
  const insertionIndex = insertAt(siblings, entity.id, operation.index);
  addAlias(aliases, resolvedIds, operation.alias, entity.id);
  return {
    resolved: { type: 'entity.create', sceneId, entity: cloneJson(entity), index: insertionIndex },
    inverse: { type: 'entity.delete', entityId: entity.id, recursive: false },
  };
}

function applyEntityPatch(draft, operation, aliases) {
  const entityId = resolveId(operation.entityId, aliases, 'entityId');
  const { scene, entity } = buildProjectIndex(draft).getEntity(entityId);
  assertPatchKeys(operation.patch, ENTITY_PATCH_KEYS, 'entity.patch');
  const resolvedPatch = resolveEntityReferences(cloneJson(operation.patch), aliases);
  assertStrictSuppliedModifiers(resolvedPatch, 'entity.patch.patch');
  const fields = captureFields(entity, Object.keys(resolvedPatch));
  scene.entities[entityId] = createEntityDocument(mergePatch(entity, resolvedPatch));
  return {
    resolved: { type: 'entity.patch', entityId, patch: resolvedPatch },
    inverse: { type: '_entity.fields.restore', entityId, fields },
  };
}

function applyEntityPatchMany(draft, operation, aliases) {
  const entityIds = resolveExactIds(operation.entityIds, aliases, 'entityIds');
  const selection = resolveExactEntitySelection(draft, entityIds);
  assertExpectedEntitySetHash(selection.entitySetHash, operation.expectedEntitySetHash);
  assertPatchKeys(operation.patch, ENTITY_PATCH_KEYS, 'entity.patchMany');
  const resolvedPatch = resolveEntityReferences(cloneJson(operation.patch), aliases);
  assertStrictSuppliedModifiers(resolvedPatch, 'entity.patchMany.patch');
  const snapshots = selection.entries.map(({ entityId, scene, entity }) => ({
    entityId,
    scene,
    snapshot: cloneJson(entity),
  }));
  for (const entry of snapshots) {
    entry.scene.entities[entry.entityId] = createEntityDocument(mergePatch(entry.snapshot, resolvedPatch));
    entry.current = entry.scene.entities[entry.entityId];
  }
  return {
    resolved: {
      type: 'entity.patchMany', entityIds, patch: resolvedPatch,
      expectedEntitySetHash: operation.expectedEntitySetHash,
    },
    inverse: entityMutationInverse(snapshots),
  };
}

function applyEntityTransformMany(draft, operation, aliases) {
  const entityIds = resolveExactIds(operation.entityIds, aliases, 'entityIds');
  const selection = resolveExactEntitySelection(draft, entityIds);
  assertExpectedEntitySetHash(selection.entitySetHash, operation.expectedEntitySetHash);
  studioAssert(['set', 'delta'].includes(operation.mode), 'invalid_transform_mode', 'entity.transformMany mode must be set or delta');
  assertPatchKeys(operation.transform, TRANSFORM_PATCH_KEYS, 'entity.transformMany.transform');
  studioAssert(Object.keys(operation.transform).length > 0, 'invalid_transform', 'entity.transformMany requires at least one transform field');
  const vector = (value, fallback, combine) => {
    if (value === undefined) return [...fallback];
    studioAssert(Array.isArray(value) && value.length === 3 && value.every(Number.isFinite), 'invalid_transform', 'Transform fields must contain exactly three finite numbers');
    return value.map((component, index) => combine(fallback[index], component));
  };
  const snapshots = selection.entries.map(({ entityId, scene, entity }) => ({
    entityId,
    scene,
    snapshot: cloneJson(entity),
  }));
  for (const entry of snapshots) {
    const prior = entry.snapshot.transform;
    const transform = operation.mode === 'set'
      ? {
          position: vector(operation.transform.position, prior.position, (_prior, next) => next),
          rotation: vector(operation.transform.rotation, prior.rotation, (_prior, next) => next),
          scale: vector(operation.transform.scale, prior.scale, (_prior, next) => next),
        }
      : {
          position: vector(operation.transform.position, prior.position, (current, delta) => current + delta),
          rotation: vector(operation.transform.rotation, prior.rotation, (current, delta) => current + delta),
          scale: vector(operation.transform.scale, prior.scale, (current, factor) => current * factor),
        };
    entry.scene.entities[entry.entityId] = createEntityDocument({ ...entry.snapshot, transform });
    entry.current = entry.scene.entities[entry.entityId];
  }
  return {
    resolved: {
      type: 'entity.transformMany', entityIds, mode: operation.mode,
      transform: cloneJson(operation.transform), expectedEntitySetHash: operation.expectedEntitySetHash,
    },
    inverse: entityMutationInverse(snapshots),
  };
}

function applyEntityGroup(draft, operation, aliases, resolvedIds) {
  const sceneId = resolveId(operation.sceneId, aliases, 'sceneId');
  const scene = buildProjectIndex(draft).getScene(sceneId);
  const entityIds = resolveExactIds(operation.entityIds, aliases, 'entityIds');
  const selection = resolveExactEntitySelection(draft, entityIds, { requireSameScene: true, sceneId });
  assertExpectedEntitySetHash(selection.entitySetHash, operation.expectedEntitySetHash);
  const source = cloneJson(operation.group);
  studioAssert(isPlainRecord(source), 'invalid_operation', 'entity.group requires a group entity document');
  resolveEntityReferences(source, aliases);
  assertStrictSuppliedModifiers(source, 'entity.group.group');
  studioAssert(source.kind === undefined || source.kind === 'group', 'invalid_group_entity', 'entity.group requires kind group');
  studioAssert(!source.children || source.children.length === 0, 'invalid_group_entity', 'entity.group determines the group children from entityIds');
  const parentIds = new Set(selection.entries.map(({ entity }) => entity.parentId));
  const parentId = Object.hasOwn(source, 'parentId')
    ? source.parentId
    : (parentIds.size === 1 ? [...parentIds][0] : null);
  if (parentId) {
    const parentRecord = buildProjectIndex(draft).getEntity(parentId);
    studioAssert(parentRecord.sceneId === sceneId, 'cross_scene_parent', 'Group parent must belong to the same scene');
  }
  const selected = new Set(entityIds);
  for (const entityId of entityIds) {
    const subtree = buildProjectIndex(draft).collectSubtree(entityId);
    const nestedSelection = subtree.filter((id) => id !== entityId && selected.has(id));
    studioAssert(nestedSelection.length === 0, 'overlapping_entity_selection', 'entity.group cannot select both an entity and its descendant', {
      entityId,
      nestedSelection,
    });
    studioAssert(!parentId || !subtree.includes(parentId), 'hierarchy_cycle', 'Group parent cannot be inside a selected entity subtree', {
      entityId,
      parentId,
    });
  }
  const group = createEntityDocument({ ...source, kind: 'group', parentId, children: entityIds });
  assertIndexFree(draft, group.id);
  const worldMemo = new Map();
  const parentWorld = parentId ? entityWorldMatrix(scene, parentId, worldMemo) : composeTransformMatrix({});
  const groupWorld = multiplyTransformMatrices(parentWorld, composeTransformMatrix(group.transform));
  const childTransforms = new Map(entityIds.map((entityId) => [
    entityId,
    relativeEntityTransform(groupWorld, entityWorldMatrix(scene, entityId, worldMemo)),
  ]));
  const snapshot = cloneJson(scene);
  const targetSiblings = parentId ? scene.entities[parentId].children : scene.rootEntityIds;
  let insertionIndex = operation.index;
  if (insertionIndex === undefined) {
    const selectedIndices = entityIds
      .filter((id) => scene.entities[id].parentId === parentId)
      .map((id) => targetSiblings.indexOf(id))
      .filter((index) => index >= 0);
    if (selectedIndices.length > 0) {
      const first = Math.min(...selectedIndices);
      insertionIndex = targetSiblings.slice(0, first).filter((id) => !selected.has(id)).length;
    }
  }
  for (const entityId of entityIds) {
    const entity = scene.entities[entityId];
    const siblings = entity.parentId ? scene.entities[entity.parentId].children : scene.rootEntityIds;
    removeFrom(siblings, entityId);
    entity.parentId = group.id;
    entity.transform = childTransforms.get(entityId);
  }
  scene.entities[group.id] = group;
  const resolvedIndex = insertAt(targetSiblings, group.id, insertionIndex);
  addAlias(aliases, resolvedIds, operation.alias, group.id);
  return {
    resolved: {
      type: 'entity.group', sceneId, entityIds, group: cloneJson(group),
      expectedEntitySetHash: operation.expectedEntitySetHash, index: resolvedIndex,
    },
    inverse: {
      type: '_scene.restore', sceneId: scene.id, snapshot, index: draft.sceneOrder.indexOf(scene.id),
      restoreActive: false, expectedCurrentHash: contentHash(scene),
    },
  };
}

function applyEntityUngroup(draft, operation, aliases) {
  const entityId = resolveId(operation.entityId, aliases, 'entityId');
  const index = buildProjectIndex(draft);
  const { scene, entity } = index.getEntity(entityId);
  studioAssert(entity.kind === 'group', 'invalid_ungroup_target', 'entity.ungroup requires a group entity', { entityId, kind: entity.kind });
  const actualSubtreeHash = index.subtreeHash(entityId);
  studioAssert(operation.expectedSubtreeHash === actualSubtreeHash, 'guard_failed', 'entity.ungroup requires the exact expectedSubtreeHash', {
    expectedSubtreeHash: operation.expectedSubtreeHash,
    actualSubtreeHash,
  });
  const external = index.getReferencesTo(entityId).filter((reference) => !['parent', 'collectionMember'].includes(reference.kind));
  studioAssert(external.length === 0, 'entity_in_use', `Group ${entityId} is still referenced`, { references: external });
  const childTransforms = new Map(entity.children.map((childId) => [
    childId,
    composeEntityTransforms(entity.transform, scene.entities[childId].transform),
  ]));
  const snapshot = cloneJson(scene);
  const siblings = entity.parentId ? scene.entities[entity.parentId].children : scene.rootEntityIds;
  const groupIndex = removeFrom(siblings, entityId);
  siblings.splice(groupIndex < 0 ? siblings.length : groupIndex, 0, ...entity.children);
  for (const childId of entity.children) {
    const child = scene.entities[childId];
    child.parentId = entity.parentId;
    child.transform = childTransforms.get(childId);
  }
  for (const collection of Object.values(scene.collections)) {
    if (!collection.entityIds.includes(entityId)) continue;
    collection.entityIds = [...new Set([
      ...collection.entityIds.filter((id) => id !== entityId),
      ...entity.children,
    ])].sort();
  }
  delete scene.entities[entityId];
  return {
    resolved: { type: 'entity.ungroup', entityId, expectedSubtreeHash: operation.expectedSubtreeHash },
    inverse: {
      type: '_scene.restore', sceneId: scene.id, snapshot, index: draft.sceneOrder.indexOf(scene.id),
      restoreActive: false, expectedCurrentHash: contentHash(scene),
    },
  };
}

function applyEntityDuplicate(draft, operation, aliases, resolvedIds) {
  const entityId = resolveId(operation.entityId, aliases, 'entityId');
  const { scene, entity } = buildProjectIndex(draft).getEntity(entityId);
  const deep = operation.deep === true;
  const sourceIds = deep ? buildProjectIndex(draft).collectSubtree(entityId) : [entityId];
  const idMap = {};
  if (deep) {
    studioAssert(isPlainRecord(operation.idMap), 'invalid_operation', 'Deep duplicate requires an explicit idMap for every entity');
    for (const sourceId of sourceIds) {
      const mapped = operation.idMap[sourceId];
      studioAssert(mapped, 'invalid_operation', `Deep duplicate idMap is missing ${sourceId}`);
      idMap[sourceId] = resolveId(mapped, aliases, `idMap.${sourceId}`);
    }
  } else {
    idMap[entityId] = resolveId(operation.newId, aliases, 'newId');
  }
  for (const newId of Object.values(idMap)) assertIndexFree(draft, newId);
  studioAssert(new Set(Object.values(idMap)).size === Object.values(idMap).length, 'duplicate_id', 'Duplicate target IDs in idMap');
  const parentId = operation.parentId === undefined ? entity.parentId : (operation.parentId === null ? null : resolveId(operation.parentId, aliases, 'parentId'));
  if (parentId) buildProjectIndex(draft).getEntity(parentId);
  const snapshot = cloneJson(scene);
  for (const sourceId of sourceIds) {
    const source = scene.entities[sourceId];
    const isRoot = sourceId === entityId;
    const copy = createEntityDocument({
      ...cloneJson(source),
      id: idMap[sourceId],
      name: isRoot && operation.name ? operation.name : source.name,
      parentId: isRoot ? parentId : idMap[source.parentId],
      children: deep ? source.children.map((id) => idMap[id]) : [],
    });
    scene.entities[copy.id] = copy;
  }
  for (const collection of Object.values(scene.collections)) {
    const duplicateMembers = sourceIds
      .filter((sourceId) => collection.entityIds.includes(sourceId))
      .map((sourceId) => idMap[sourceId]);
    if (duplicateMembers.length > 0) {
      collection.entityIds = [...new Set([...collection.entityIds, ...duplicateMembers])].sort();
    }
  }
  const rootCopyId = idMap[entityId];
  const siblings = parentId ? scene.entities[parentId].children : scene.rootEntityIds;
  insertAt(siblings, rootCopyId, operation.index);
  addAlias(aliases, resolvedIds, operation.alias, rootCopyId);
  return {
    resolved: { type: 'entity.duplicate', entityId, newId: rootCopyId, parentId, deep, idMap, ...(operation.name ? { name: operation.name } : {}) },
    inverse: {
      type: '_scene.restore', sceneId: scene.id, snapshot, index: draft.sceneOrder.indexOf(scene.id),
      restoreActive: false, expectedCurrentHash: contentHash(scene),
    },
  };
}

function applyEntityReparent(draft, operation, aliases) {
  const entityId = resolveId(operation.entityId, aliases, 'entityId');
  const record = buildProjectIndex(draft).getEntity(entityId);
  const { scene, entity } = record;
  const parentId = operation.parentId === null ? null : resolveId(operation.parentId, aliases, 'parentId');
  if (parentId) {
    const parentRecord = buildProjectIndex(draft).getEntity(parentId);
    studioAssert(parentRecord.sceneId === record.sceneId, 'cross_scene_parent', 'Entities cannot be parented across scenes');
    studioAssert(!buildProjectIndex(draft).collectSubtree(entityId).includes(parentId), 'hierarchy_cycle', 'Cannot parent an entity beneath its own subtree');
  }
  const snapshot = cloneJson(scene);
  const oldSiblings = entity.parentId ? scene.entities[entity.parentId].children : scene.rootEntityIds;
  removeFrom(oldSiblings, entityId);
  entity.parentId = parentId;
  const newSiblings = parentId ? scene.entities[parentId].children : scene.rootEntityIds;
  insertAt(newSiblings, entityId, operation.index);
  return {
    resolved: { type: 'entity.reparent', entityId, parentId, ...(operation.index === undefined ? {} : { index: operation.index }) },
    inverse: {
      type: '_scene.restore', sceneId: scene.id, snapshot, index: draft.sceneOrder.indexOf(scene.id),
      restoreActive: false, expectedCurrentHash: contentHash(scene),
    },
  };
}

function applyEntityDelete(draft, operation, aliases) {
  const entityId = resolveId(operation.entityId, aliases, 'entityId');
  const index = buildProjectIndex(draft);
  const { scene, entity } = index.getEntity(entityId);
  const subtree = index.collectSubtree(entityId);
  if (subtree.length > 1) {
    studioAssert(operation.recursive === true, 'non_empty_hierarchy', 'Entity has children; recursive delete was not requested');
    const actual = index.subtreeHash(entityId);
    studioAssert(operation.expectedSubtreeHash === actual, 'guard_failed', 'Recursive delete requires the exact expectedSubtreeHash', {
      expectedSubtreeHash: operation.expectedSubtreeHash,
      actualSubtreeHash: actual,
    });
  }
  const deleting = new Set(subtree);
  for (const id of subtree) {
    const external = index.getReferencesTo(id).filter((reference) => !deleting.has(reference.sourceId) && !['parent', 'collectionMember'].includes(reference.kind));
    studioAssert(external.length === 0, 'resource_in_use', `Entity ${id} is still referenced`, { references: external });
  }
  const snapshot = cloneJson(scene);
  const siblings = entity.parentId ? scene.entities[entity.parentId].children : scene.rootEntityIds;
  removeFrom(siblings, entityId);
  for (const collection of Object.values(scene.collections)) {
    collection.entityIds = collection.entityIds.filter((id) => !deleting.has(id));
  }
  for (const id of subtree.reverse()) delete scene.entities[id];
  return {
    resolved: {
      type: 'entity.delete', entityId, recursive: operation.recursive === true,
      ...(operation.expectedSubtreeHash ? { expectedSubtreeHash: operation.expectedSubtreeHash } : {}),
    },
    inverse: {
      type: '_scene.restore', sceneId: scene.id, snapshot, index: draft.sceneOrder.indexOf(scene.id),
      restoreActive: false, expectedCurrentHash: contentHash(scene),
    },
  };
}

function applyLayoutPattern(draft, operation, aliases) {
  const entityId = resolveId(operation.entityId, aliases, 'entityId');
  const { scene, entity } = buildProjectIndex(draft).getEntity(entityId);
  studioAssert(entity.kind === 'mesh', 'invalid_layout_source', 'layout.pattern requires a mesh source entity', {
    entityId,
    kind: entity.kind,
  });
  studioAssert(isPlainRecord(entity.components?.mesh), 'invalid_layout_source', 'layout.pattern source requires components.mesh', {
    entityId,
  });
  const modifier = normalizeLayoutPattern(operation.pattern);
  const components = cloneJson(entity.components);
  studioAssert(
    components.modifiers === undefined || Array.isArray(components.modifiers),
    'invalid_modifiers',
    'layout.pattern requires components.modifiers to be an array when present.',
    { entityId },
  );
  const modifiers = components.modifiers === undefined ? [] : [...components.modifiers];
  const existingIndex = modifiers.findIndex(item => item?.id === modifier.id);
  if (existingIndex >= 0) {
    studioAssert(
      modifiers[existingIndex]?.type === 'pattern',
      'layout_pattern_id_collision',
      `Modifier ${modifier.id} already exists and is not a layout pattern.`,
      { entityId, modifierId: modifier.id, existingType: modifiers[existingIndex]?.type },
    );
    modifiers[existingIndex] = modifier;
  } else modifiers.push(modifier);
  components.modifiers = modifiers;
  const fields = captureFields(entity, ['components']);
  scene.entities[entityId] = createEntityDocument({ ...entity, components });
  const { type: _type, ...resolvedPattern } = modifier;
  return {
    resolved: { type: 'layout.pattern', entityId, pattern: cloneJson(resolvedPattern) },
    inverse: { type: '_entity.fields.restore', entityId, fields },
  };
}

function modifierTarget(draft, operation, aliases) {
  const entityId = resolveId(operation.entityId, aliases, 'entityId');
  const { scene, entity } = buildProjectIndex(draft).getEntity(entityId);
  studioAssert(['mesh', 'instancedMesh'].includes(entity.kind), 'invalid_modifier_target', 'Modifier operations require a mesh or instancedMesh entity', {
    entityId,
    kind: entity.kind,
  });
  studioAssert(isPlainRecord(entity.components?.mesh), 'invalid_modifier_target', 'Modifier operations require components.mesh', { entityId });
  assertExpectedModifierStackHash(entity, operation.expectedStackHash);
  return { entityId, scene, entity, modifiers: normalizedModifierStack(entity) };
}

function commitModifierStack(scene, entity, modifiers) {
  const fields = captureFields(entity, ['components']);
  const components = cloneJson(entity.components);
  components.modifiers = modifiers;
  scene.entities[entity.id] = createEntityDocument({ ...entity, components });
  return fields;
}

function applyModifierCreate(draft, operation, aliases) {
  const { entityId, scene, entity, modifiers } = modifierTarget(draft, operation, aliases);
  studioAssert(modifiers.length < MAX_MODIFIERS_PER_ENTITY, 'modifier_limit', `An entity may contain at most ${MAX_MODIFIERS_PER_ENTITY} modifiers`);
  const modifier = normalizeModifierDocument(operation.modifier);
  studioAssert(!modifiers.some(item => item.id === modifier.id), 'duplicate_modifier_id', `Modifier ${modifier.id} already exists on ${entityId}`);
  studioAssert(
    operation.index === undefined
      || (Number.isInteger(operation.index) && operation.index >= 0 && operation.index <= modifiers.length),
    'invalid_modifier_index',
    'modifier.create index must be an insertion position in the current stack',
    { index: operation.index, count: modifiers.length },
  );
  const index = insertAt(modifiers, modifier, operation.index);
  const fields = commitModifierStack(scene, entity, modifiers);
  return {
    resolved: {
      type: 'modifier.create', entityId, modifier: cloneJson(modifier), index,
      expectedStackHash: operation.expectedStackHash,
    },
    inverse: { type: '_entity.fields.restore', entityId, fields },
  };
}

function applyModifierPatch(draft, operation, aliases) {
  const { entityId, scene, entity, modifiers } = modifierTarget(draft, operation, aliases);
  const modifierId = assertStableId(operation.modifierId, 'modifierId');
  studioAssert(isPlainRecord(operation.patch), 'invalid_patch', 'modifier.patch requires an object patch');
  studioAssert(!Object.hasOwn(operation.patch, 'id') && !Object.hasOwn(operation.patch, 'type'), 'invalid_patch', 'Modifier ID and type are immutable');
  const index = modifiers.findIndex(item => item.id === modifierId);
  studioAssert(index >= 0, 'not_found', `Modifier ${modifierId} does not exist on ${entityId}`, { id: modifierId, kind: 'modifier' });
  modifiers[index] = normalizeModifierDocument(mergePatch(modifiers[index], cloneJson(operation.patch)));
  const fields = commitModifierStack(scene, entity, modifiers);
  return {
    resolved: {
      type: 'modifier.patch', entityId, modifierId, patch: cloneJson(operation.patch),
      expectedStackHash: operation.expectedStackHash,
    },
    inverse: { type: '_entity.fields.restore', entityId, fields },
  };
}

function applyModifierMove(draft, operation, aliases) {
  const { entityId, scene, entity, modifiers } = modifierTarget(draft, operation, aliases);
  const modifierId = assertStableId(operation.modifierId, 'modifierId');
  studioAssert(Number.isInteger(operation.index) && operation.index >= 0 && operation.index < modifiers.length, 'invalid_modifier_index', 'modifier.move index must target an existing stack position', {
    index: operation.index,
    count: modifiers.length,
  });
  const currentIndex = modifiers.findIndex(item => item.id === modifierId);
  studioAssert(currentIndex >= 0, 'not_found', `Modifier ${modifierId} does not exist on ${entityId}`, { id: modifierId, kind: 'modifier' });
  const [modifier] = modifiers.splice(currentIndex, 1);
  modifiers.splice(operation.index, 0, modifier);
  const fields = commitModifierStack(scene, entity, modifiers);
  return {
    resolved: {
      type: 'modifier.move', entityId, modifierId, index: operation.index,
      expectedStackHash: operation.expectedStackHash,
    },
    inverse: { type: '_entity.fields.restore', entityId, fields },
  };
}

function applyModifierDelete(draft, operation, aliases) {
  const { entityId, scene, entity, modifiers } = modifierTarget(draft, operation, aliases);
  const modifierId = assertStableId(operation.modifierId, 'modifierId');
  const index = modifiers.findIndex(item => item.id === modifierId);
  studioAssert(index >= 0, 'not_found', `Modifier ${modifierId} does not exist on ${entityId}`, { id: modifierId, kind: 'modifier' });
  modifiers.splice(index, 1);
  const fields = commitModifierStack(scene, entity, modifiers);
  return {
    resolved: {
      type: 'modifier.delete', entityId, modifierId,
      expectedStackHash: operation.expectedStackHash,
    },
    inverse: { type: '_entity.fields.restore', entityId, fields },
  };
}

function applyModifierStackEdit(draft, operation, aliases) {
  const { entityId, scene, entity, modifiers } = modifierTarget(draft, operation, aliases);
  studioAssert(
    Array.isArray(operation.changes) && operation.changes.length > 0 && operation.changes.length <= 128,
    'invalid_modifier_stack_edits',
    'modifier.stack.edit requires from 1 to 128 ordered edits',
    { count: Array.isArray(operation.changes) ? operation.changes.length : undefined },
  );
  const resolvedEdits = [];
  for (let editIndex = 0; editIndex < operation.changes.length; editIndex += 1) {
    const edit = operation.changes[editIndex];
    studioAssert(isPlainRecord(edit) && typeof edit.type === 'string', 'invalid_modifier_stack_edit', 'Each modifier stack edit requires a type', { editIndex });
    const allowedKeys = MODIFIER_STACK_EDIT_KEYS.get(edit.type);
    studioAssert(allowedKeys, 'invalid_modifier_stack_edit', `Unknown modifier stack edit ${edit.type}`, { editIndex, type: edit.type });
    assertKnownKeys(edit, allowedKeys, `modifier.stack.edit.edits[${editIndex}]`);
    if (edit.type === 'create') {
      studioAssert(modifiers.length < MAX_MODIFIERS_PER_ENTITY, 'modifier_limit', `An entity may contain at most ${MAX_MODIFIERS_PER_ENTITY} modifiers`);
      const modifier = normalizeModifierDocument(edit.modifier);
      studioAssert(!modifiers.some(item => item.id === modifier.id), 'duplicate_modifier_id', `Modifier ${modifier.id} already exists on ${entityId}`);
      studioAssert(
        edit.index === undefined || (Number.isInteger(edit.index) && edit.index >= 0 && edit.index <= modifiers.length),
        'invalid_modifier_index',
        'A modifier create index must be an insertion position in the current stack',
        { editIndex, index: edit.index, count: modifiers.length },
      );
      const index = insertAt(modifiers, modifier, edit.index);
      resolvedEdits.push({ type: 'create', modifier: cloneJson(modifier), index });
      continue;
    }
    const modifierId = assertStableId(edit.modifierId, `modifier.stack.edit.edits[${editIndex}].modifierId`);
    const currentIndex = modifiers.findIndex(item => item.id === modifierId);
    studioAssert(currentIndex >= 0, 'not_found', `Modifier ${modifierId} does not exist on ${entityId}`, {
      editIndex, id: modifierId, kind: 'modifier',
    });
    if (edit.type === 'patch') {
      studioAssert(isPlainRecord(edit.patch), 'invalid_patch', 'A modifier stack patch edit requires an object patch', { editIndex });
      studioAssert(!Object.hasOwn(edit.patch, 'id') && !Object.hasOwn(edit.patch, 'type'), 'invalid_patch', 'Modifier ID and type are immutable', { editIndex });
      modifiers[currentIndex] = normalizeModifierDocument(mergePatch(modifiers[currentIndex], cloneJson(edit.patch)));
      resolvedEdits.push({ type: 'patch', modifierId, patch: cloneJson(edit.patch) });
      continue;
    }
    if (edit.type === 'move') {
      studioAssert(
        Number.isInteger(edit.index) && edit.index >= 0 && edit.index < modifiers.length,
        'invalid_modifier_index',
        'A modifier move index must target an existing current stack position',
        { editIndex, index: edit.index, count: modifiers.length },
      );
      const [modifier] = modifiers.splice(currentIndex, 1);
      modifiers.splice(edit.index, 0, modifier);
      resolvedEdits.push({ type: 'move', modifierId, index: edit.index });
      continue;
    }
    modifiers.splice(currentIndex, 1);
    resolvedEdits.push({ type: 'delete', modifierId });
  }
  const fields = commitModifierStack(scene, entity, modifiers);
  return {
    resolved: {
      type: 'modifier.stack.edit',
      entityId,
      changes: resolvedEdits,
      expectedStackHash: operation.expectedStackHash,
    },
    inverse: { type: '_entity.fields.restore', entityId, fields },
  };
}

function applyCameraFrame(draft, operation, aliases) {
  const cameraId = resolveId(operation.cameraId, aliases, 'cameraId');
  const { scene, entity } = buildProjectIndex(draft).getEntity(cameraId);
  studioAssert(
    ['perspectiveCamera', 'orthographicCamera'].includes(entity.kind),
    'invalid_camera_frame_target',
    'camera.frame requires a perspectiveCamera or orthographicCamera entity.',
    { cameraId, kind: entity.kind },
  );
  studioAssert(isPlainRecord(operation.bounds), 'invalid_camera_frame_bounds', 'camera.frame requires resolved bounds.');
  const targetIds = operation.targetIds === undefined ? undefined : cloneJson(operation.targetIds);
  if (targetIds !== undefined) {
    studioAssert(
      Array.isArray(targetIds) && targetIds.length > 0 && targetIds.every(id => typeof id === 'string'),
      'invalid_camera_frame_targets',
      'camera.frame targetIds must contain at least one stable entity ID.',
    );
    for (const targetId of targetIds) buildProjectIndex(draft).getEntity(targetId);
  }

  let framed;
  try {
    framed = solveCameraFrame({
      kind: entity.kind,
      bounds: operation.bounds,
      transform: entity.transform,
      camera: entity.components?.camera ?? {},
      aspect: operation.aspect,
      padding: operation.padding,
      direction: operation.direction,
      lockPreviewAspect: operation.lockPreviewAspect,
    });
  } catch (error) {
    throw new StudioError('invalid_camera_frame', `camera.frame failed: ${error.message}`, { cameraId });
  }

  const fields = captureFields(entity, ['transform', 'components']);
  const components = cloneJson(entity.components ?? {});
  components.camera = {
    ...framed.camera,
    framing: {
      ...framed.framing,
      bounds: framed.target.bounds,
      ...(targetIds ? { targetIds } : {}),
    },
  };
  scene.entities[cameraId] = createEntityDocument({
    ...entity,
    transform: framed.transform,
    components,
  });
  return {
    resolved: {
      type: 'camera.frame',
      cameraId,
      bounds: cloneJson(framed.target.bounds),
      ...(targetIds ? { targetIds } : {}),
      aspect: framed.framing.aspect,
      padding: framed.framing.padding,
      direction: cloneJson(framed.framing.direction),
      lockPreviewAspect: framed.framing.lockPreviewAspect,
    },
    inverse: { type: '_entity.fields.restore', entityId: cameraId, fields },
  };
}

function geometryRecipeSource(resource) {
  if (isPlainRecord(resource.recipe)) {
    return { source: resource.recipe, kind: resource.recipe.kind ?? resource.recipe.type };
  }
  if (isPlainRecord(resource.parameters)) {
    return { source: resource.parameters, kind: resource.parameters.kind ?? resource.parameters.type };
  }
  const directKind = ['indexedMesh', 'explicit', 'editableMesh'].includes(resource.type)
    ? resource.type
    : (resource.geometryKind ?? resource.kind);
  const source = Object.fromEntries(GEOMETRY_RECIPE_FIELDS
    .filter(key => Object.hasOwn(resource, key))
    .map(key => [key, cloneJson(resource[key])]));
  return { source, kind: directKind };
}

function canonicalGeometryEditRecipe(resource, resourceId) {
  const { source, kind } = geometryRecipeSource(resource);
  if (kind === 'editableMesh') {
    const recipe = { ...cloneJson(source), kind: 'editableMesh' };
    delete recipe.type;
    try {
      return { kind: 'editableMesh', recipe: normalizeEditableMeshRecipe(recipe) };
    } catch (error) {
      throw new StudioError('invalid_geometry_edit_target', `Geometry ${resourceId} has an invalid editable mesh recipe: ${error.message}`, {
        resourceId,
      });
    }
  }
  studioAssert(
    ['indexedMesh', 'explicit'].includes(kind),
    'invalid_geometry_edit_target',
    `geometry.edit requires an editableMesh, indexedMesh, or explicit geometry recipe, not ${String(kind)}.`,
    { resourceId, recipeKind: kind ?? null },
  );
  const recipe = { ...cloneJson(source), kind: 'indexedMesh' };
  delete recipe.type;
  try {
    return { kind: 'indexedMesh', recipe: validateIndexedMeshRecipe(recipe) };
  } catch (error) {
    throw new StudioError('invalid_geometry_edit_target', `Geometry ${resourceId} has an invalid indexed mesh recipe: ${error.message}`, {
      resourceId,
    });
  }
}

function assertGeometryEditCommand(command, editIndex, recipeKind) {
  studioAssert(isPlainRecord(command), 'invalid_geometry_edit', `geometry.edit edits[${editIndex}] must be an object.`, {
    editIndex,
  });
  const allowed = GEOMETRY_EDIT_KEYS.get(command.type);
  studioAssert(allowed, 'invalid_geometry_edit', `Unsupported geometry edit command ${String(command.type)}.`, {
    editIndex,
    commandType: command.type ?? null,
  });
  assertKnownKeys(command, allowed, `geometry.edit edits[${editIndex}]`);
  const supportedTypes = recipeKind === 'editableMesh'
    ? EDITABLE_GEOMETRY_EDIT_TYPES
    : INDEXED_GEOMETRY_EDIT_TYPES;
  studioAssert(
    supportedTypes.has(command.type),
    'invalid_geometry_edit',
    `geometry.edit command ${command.type} is not supported for ${recipeKind}.`,
    { editIndex, commandType: command.type, recipeKind },
  );
  const supportsSelection = ['move', 'scale', 'rotate', 'smooth', 'mergeVertices'].includes(command.type);
  if (supportsSelection) {
    const hasVertexIndices = command.vertexIndices !== undefined;
    const hasCompactSelection = command.selection !== undefined;
    studioAssert(
      !hasCompactSelection || command.selection === 'all',
      'invalid_geometry_edit',
      `geometry.edit edits[${editIndex}] selection must be 'all'.`,
      { editIndex },
    );
    studioAssert(
      !(hasVertexIndices && hasCompactSelection),
      'invalid_geometry_edit',
      `geometry.edit edits[${editIndex}] accepts vertexIndices or selection, not both.`,
      { editIndex },
    );
    if (command.type !== 'smooth') {
      studioAssert(
        hasVertexIndices || hasCompactSelection,
        'invalid_geometry_edit',
        `geometry.edit edits[${editIndex}] requires vertexIndices or selection.`,
        { editIndex },
      );
    }
  }
  if (['subdivideFaces', 'insetFaces', 'extrudeFaces', 'deleteFaces'].includes(command.type)) {
    const hasFaceIndices = command.faceIndices !== undefined;
    const hasCompactSelection = command.selection !== undefined;
    studioAssert(
      !hasCompactSelection || command.selection === 'all',
      'invalid_geometry_edit',
      `geometry.edit edits[${editIndex}] selection must be 'all'.`,
      { editIndex },
    );
    studioAssert(
      hasFaceIndices !== hasCompactSelection,
      'invalid_geometry_edit',
      `geometry.edit edits[${editIndex}] requires exactly one of faceIndices or selection.`,
      { editIndex },
    );
  }
  if (command.type === 'bevelEdges') {
    studioAssert(
      (command.edges !== undefined) !== (command.edgeVertexIndices !== undefined),
      'invalid_geometry_edit',
      `geometry.edit edits[${editIndex}] bevelEdges requires exactly one of edges or edgeVertexIndices.`,
      { editIndex },
    );
  }
  if (command.type === 'rotate') {
    const hasEuler = command.rotation !== undefined;
    const hasAxis = command.axis !== undefined;
    const hasAngle = command.angle !== undefined;
    studioAssert(
      (hasEuler && !hasAxis && !hasAngle) || (!hasEuler && hasAxis && hasAngle),
      'invalid_geometry_edit',
      `geometry.edit edits[${editIndex}] rotate requires either rotation or both axis and angle.`,
      { editIndex },
    );
  }
}

function applyGeometryEdit(draft, operation, aliases) {
  const resourceId = resolveId(operation.resourceId, aliases, 'resourceId');
  const { resource } = buildProjectIndex(draft).getResource(resourceId, 'geometries');
  studioAssert(Array.isArray(operation.edits), 'invalid_geometry_edit', 'geometry.edit edits must be an array.');
  studioAssert(operation.edits.length > 0, 'invalid_geometry_edit', 'geometry.edit requires at least one edit command.');
  studioAssert(
    operation.edits.length <= MAX_GEOMETRY_EDIT_COMMANDS,
    'geometry_edit_limit',
    `geometry.edit supports at most ${MAX_GEOMETRY_EDIT_COMMANDS} commands per operation.`,
    { commandCount: operation.edits.length, maximum: MAX_GEOMETRY_EDIT_COMMANDS },
  );

  const snapshot = cloneJson(resource);
  const canonical = canonicalGeometryEditRecipe(resource, resourceId);
  let { recipe } = canonical;
  const initialTopologyHash = canonical.kind === 'editableMesh'
    ? editableMeshTopologyHash(recipe)
    : contentHash({ vertexCount: recipe.positions.length / 3, indices: recipe.indices });
  if (canonical.kind === 'editableMesh') {
    studioAssert(
      operation.expectedTopologyHash !== undefined,
      'geometry_topology_guard_required',
      'geometry.edit requires expectedTopologyHash for editableMesh resources.',
      { resourceId, actualTopologyHash: initialTopologyHash },
    );
  }
  if (operation.expectedTopologyHash !== undefined) {
    studioAssert(
      typeof operation.expectedTopologyHash === 'string' && /^[a-f0-9]{64}$/u.test(operation.expectedTopologyHash),
      'invalid_geometry_edit',
      'expectedTopologyHash must be a lowercase SHA-256 hash.',
      { resourceId },
    );
  }
  if (operation.expectedTopologyHash !== undefined) {
    studioAssert(
      operation.expectedTopologyHash === initialTopologyHash,
      'geometry_topology_changed',
      `Geometry ${resourceId} topology changed after it was inspected.`,
      {
        resourceId,
        expectedTopologyHash: operation.expectedTopologyHash,
        actualTopologyHash: initialTopologyHash,
      },
    );
  }
  const edits = cloneJson(operation.edits);
  for (let editIndex = 0; editIndex < edits.length; editIndex += 1) {
    const command = edits[editIndex];
    assertGeometryEditCommand(command, editIndex, canonical.kind);
    try {
      recipe = canonical.kind === 'editableMesh'
        ? (EDITABLE_MESH_ATTRIBUTE_COMMAND_TYPES.includes(command.type)
            ? applyEditableMeshAttributeEdit(recipe, command)
            : applyEditableMeshEdit(recipe, command))
        : applyIndexedMeshEdit(recipe, command);
    } catch (error) {
      if (error instanceof StudioError) throw error;
      throw new StudioError('invalid_geometry_edit', `geometry.edit edits[${editIndex}] failed: ${error.message}`, {
        resourceId,
        editIndex,
        commandType: command.type,
      });
    }
  }

  const editedResource = createResourceDocument('geometries', { ...resource, recipe });
  draft.resources.geometries[resourceId] = editedResource;
  return {
    resolved: {
      type: 'geometry.edit', resourceId, edits,
      ...(operation.expectedTopologyHash === undefined
        ? {}
        : { expectedTopologyHash: operation.expectedTopologyHash }),
    },
    inverse: {
      type: '_resource.restore', resourceType: 'geometries', resourceId, snapshot,
      expectedCurrentHash: contentHash(editedResource),
    },
  };
}

function applyResourceCreate(draft, operation, aliases, resolvedIds) {
  const resourceType = normalizeResourceType(operation.resourceType);
  const source = cloneJson(operation.resource);
  studioAssert(isPlainRecord(source), 'invalid_operation', 'resource.create requires resource');
  if (aliases.has(source.id)) source.id = aliases.get(source.id);
  resolveResourceReferences(source, resourceType, aliases);
  const resource = createResourceDocument(resourceType, source);
  assertIndexFree(draft, resource.id);
  draft.resources[resourceType][resource.id] = resource;
  addAlias(aliases, resolvedIds, operation.alias, resource.id);
  return {
    resolved: { type: 'resource.create', resourceType, resource: cloneJson(resource) },
    inverse: {
      type: '_resource.restore', resourceType, resourceId: resource.id, snapshot: null,
      expectedCurrentHash: contentHash(resource),
    },
  };
}

function applyResourcePatch(draft, operation, aliases) {
  const resourceType = normalizeResourceType(operation.resourceType);
  const resourceId = resolveId(operation.resourceId, aliases, 'resourceId');
  const { resource } = buildProjectIndex(draft).getResource(resourceId, resourceType);
  studioAssert(isPlainRecord(operation.patch), 'invalid_patch', 'resource.patch requires an object patch');
  const authoredPatch = resolveResourceReferences(
    resourceType === 'textures'
      ? normalizeTextureResourcePatch(operation.patch)
      : cloneJson(operation.patch),
    resourceType,
    aliases,
  );
  const patch = resourceType === 'graphs'
    ? normalizeGraphResourcePatch(authoredPatch, resource)
    : authoredPatch;
  studioAssert(!Object.hasOwn(patch, 'id'), 'invalid_patch', 'Resource IDs are immutable');
  const snapshot = cloneJson(resource);
  if (resourceType === 'textures' && isPlainRecord(patch.recipe)) {
    const currentRecipe = resource.recipe ?? resource.parameters ?? resource;
    const currentKind = currentRecipe?.kind ?? currentRecipe?.type;
    const patchKind = patch.recipe.kind ?? patch.recipe.type;
    const partialDataTextureFields = DATA_TEXTURE_RECIPE_KEYS.some(key => (
      !['kind', 'name'].includes(key) && Object.hasOwn(patch.recipe, key)
    ));
    studioAssert(
      currentKind === 'dataTexture' || patchKind === 'dataTexture' || !partialDataTextureFields,
      'invalid_texture_patch',
      'Upgrading a legacy texture placeholder requires kind, type, or textureKind to be dataTexture.',
      { resourceId },
    );
  }
  const patchedResource = mergePatch(resource, patch);
  if (resourceType === 'textures' && isPlainRecord(patch.recipe)
      && (patch.recipe.kind ?? patch.recipe.type) === 'dataTexture') {
    const currentRecipe = resource.recipe ?? resource.parameters ?? resource;
    if ((currentRecipe?.kind ?? currentRecipe?.type) !== 'dataTexture') {
      // Upgrading a format-v1 placeholder is a recipe replacement, not a
      // recursive merge: legacy asset IDs and opaque placeholder fields must
      // not contaminate the strict canonical dataTexture envelope.
      // Re-run merge-patch semantics against an empty object so the source-
      // swap null sentinel (pixels vs data) is removed from the replacement.
      patchedResource.recipe = mergePatch({}, patch.recipe);
      delete patchedResource.parameters;
    }
  }
  draft.resources[resourceType][resourceId] = createResourceDocument(resourceType, patchedResource);
  return {
    resolved: { type: 'resource.patch', resourceType, resourceId, patch: cloneJson(patch) },
    inverse: {
      type: '_resource.restore', resourceType, resourceId, snapshot,
      expectedCurrentHash: contentHash(draft.resources[resourceType][resourceId]),
    },
  };
}

function applyResourceDelete(draft, operation, aliases) {
  const resourceType = normalizeResourceType(operation.resourceType);
  const resourceId = resolveId(operation.resourceId, aliases, 'resourceId');
  const index = buildProjectIndex(draft);
  const { resource } = index.getResource(resourceId, resourceType);
  const references = index.getReferencesTo(resourceId);
  studioAssert(references.length === 0, 'resource_in_use', `Resource ${resourceId} is still referenced`, { references });
  delete draft.resources[resourceType][resourceId];
  return {
    resolved: { type: 'resource.delete', resourceType, resourceId },
    inverse: {
      type: '_resource.restore', resourceType, resourceId, snapshot: cloneJson(resource),
      expectedCurrentHash: null,
    },
  };
}

function applyInternalSceneRestore(draft, operation) {
  const current = draft.scenes[operation.sceneId] ?? null;
  if (Object.hasOwn(operation, 'expectedCurrentHash')) {
    const actual = current === null ? null : contentHash(current);
    studioAssert(actual === operation.expectedCurrentHash, 'history_conflict', `Scene ${operation.sceneId} changed after the transaction being compensated`, {
      expectedCurrentHash: operation.expectedCurrentHash,
      actualCurrentHash: actual,
    });
  }
  const currentIndex = draft.sceneOrder.indexOf(operation.sceneId);
  const currentActive = draft.activeSceneId;
  if (operation.sceneId !== '__none__') {
    if (operation.snapshot === null) {
      delete draft.scenes[operation.sceneId];
      removeFrom(draft.sceneOrder, operation.sceneId);
    } else {
      draft.scenes[operation.sceneId] = cloneJson(operation.snapshot);
      removeFrom(draft.sceneOrder, operation.sceneId);
      insertAt(draft.sceneOrder, operation.sceneId, operation.index);
    }
  }
  if (operation.restoreActive === true) draft.activeSceneId = operation.activeSceneId;
  return {
    resolved: cloneJson(operation),
    inverse: {
      type: '_scene.restore', sceneId: operation.sceneId, snapshot: cloneJson(current), index: currentIndex,
      ...(operation.restoreActive === true ? { activeSceneId: currentActive, restoreActive: true } : { restoreActive: false }),
      expectedCurrentHash: operation.snapshot === null ? null : contentHash(operation.snapshot),
    },
  };
}

function applyInternalSceneFieldsRestore(draft, operation) {
  const scene = buildProjectIndex(draft).getScene(operation.sceneId);
  const inverse = restoreFields(scene, operation.fields);
  draft.scenes[scene.id] = createSceneDocument(scene);
  return {
    resolved: cloneJson(operation),
    inverse: { type: '_scene.fields.restore', sceneId: scene.id, fields: inverse },
  };
}

function applyInternalSceneSettingsRestore(draft, operation) {
  const scene = buildProjectIndex(draft).getScene(operation.sceneId);
  const inverse = restoreFields(scene.settings, operation.fields);
  return {
    resolved: cloneJson(operation),
    inverse: { type: '_scene.settings.restore', sceneId: scene.id, fields: inverse },
  };
}

function applyInternalEntityFieldsRestore(draft, operation) {
  const { scene, entity } = buildProjectIndex(draft).getEntity(operation.entityId);
  const inverse = restoreFields(entity, operation.fields);
  scene.entities[entity.id] = createEntityDocument(entity);
  return {
    resolved: cloneJson(operation),
    inverse: { type: '_entity.fields.restore', entityId: entity.id, fields: inverse },
  };
}

function applyInternalEntityManyRestore(draft, operation) {
  studioAssert(Array.isArray(operation.entries) && operation.entries.length > 0, 'invalid_history_entry', '_entity.many.restore requires entries');
  const seen = new Set();
  const prepared = operation.entries.map((entry) => {
    studioAssert(isPlainRecord(entry), 'invalid_history_entry', 'Each entity restore entry must be an object');
    const { scene, entity } = buildProjectIndex(draft).getEntity(entry.entityId);
    studioAssert(!seen.has(entity.id), 'invalid_history_entry', `Duplicate entity restore entry ${entity.id}`);
    seen.add(entity.id);
    const actualCurrentHash = contentHash(entity);
    studioAssert(actualCurrentHash === entry.expectedCurrentHash, 'history_conflict', `Entity ${entity.id} changed after the transaction being compensated`, {
      expectedCurrentHash: entry.expectedCurrentHash,
      actualCurrentHash,
    });
    const snapshot = createEntityDocument(entry.snapshot);
    studioAssert(snapshot.id === entity.id, 'invalid_history_entry', 'Entity restore snapshot ID does not match target', {
      entityId: entity.id,
      snapshotId: snapshot.id,
    });
    return { scene, entity, snapshot };
  });
  for (const entry of prepared) entry.scene.entities[entry.entity.id] = entry.snapshot;
  return {
    resolved: cloneJson(operation),
    inverse: {
      type: '_entity.many.restore',
      entries: prepared.map(({ entity, snapshot }) => ({
        entityId: entity.id,
        snapshot: cloneJson(entity),
        expectedCurrentHash: contentHash(snapshot),
      })),
    },
  };
}

function applyInternalCollectionFieldsRestore(draft, operation) {
  const { scene, collection } = buildProjectIndex(draft).getCollection(operation.collectionId);
  const inverse = restoreFields(collection, operation.fields);
  scene.collections[collection.id] = createCollectionDocument(collection);
  return {
    resolved: cloneJson(operation),
    inverse: { type: '_collection.fields.restore', collectionId: collection.id, fields: inverse },
  };
}

function applyInternalResourceRestore(draft, operation) {
  const resourceType = normalizeResourceType(operation.resourceType);
  const current = draft.resources[resourceType][operation.resourceId] ?? null;
  if (Object.hasOwn(operation, 'expectedCurrentHash')) {
    const actual = current === null ? null : contentHash(current);
    studioAssert(actual === operation.expectedCurrentHash, 'history_conflict', `Resource ${operation.resourceId} changed after the transaction being compensated`, {
      expectedCurrentHash: operation.expectedCurrentHash,
      actualCurrentHash: actual,
    });
  }
  if (operation.snapshot === null) delete draft.resources[resourceType][operation.resourceId];
  else draft.resources[resourceType][operation.resourceId] = cloneJson(operation.snapshot);
  return {
    resolved: cloneJson(operation),
    inverse: {
      type: '_resource.restore', resourceType, resourceId: operation.resourceId, snapshot: cloneJson(current),
      expectedCurrentHash: operation.snapshot === null ? null : contentHash(operation.snapshot),
    },
  };
}

function applyOne(draft, operation, aliases, resolvedIds, allowInternal) {
  const type = operationType(operation);
  const allowed = OPERATION_KEYS.get(type);
  if (!allowed || (type.startsWith('_') && !allowInternal)) throw new StudioError('unknown_operation', `Unknown operation ${type}`);
  assertKnownKeys(operation, allowed, type);
  switch (type) {
    case 'scene.create': return applySceneCreate(draft, operation, aliases, resolvedIds);
    case 'scene.patch': return applyScenePatch(draft, operation, aliases);
    case 'scene.delete': return applySceneDelete(draft, operation, aliases);
    case 'scene.setActive': return applySceneSetActive(draft, operation, aliases);
    case 'scene.settings.patch': return applySceneSettings(draft, operation, aliases);
    case 'scene.rtx.patch': return applySceneRtxPatch(draft, operation, aliases);
    case 'scene.setActiveCamera': return applySceneSetCamera(draft, operation, aliases);
    case 'collection.create': return applyCollectionCreate(draft, operation, aliases, resolvedIds);
    case 'collection.patch': return applyCollectionPatch(draft, operation, aliases);
    case 'collection.membership.patch': return applyCollectionMembershipPatch(draft, operation, aliases);
    case 'collection.reparent': return applyCollectionReparent(draft, operation, aliases);
    case 'collection.delete': return applyCollectionDelete(draft, operation, aliases);
    case 'entity.create': return applyEntityCreate(draft, operation, aliases, resolvedIds);
    case 'entity.patch': return applyEntityPatch(draft, operation, aliases);
    case 'entity.patchMany': return applyEntityPatchMany(draft, operation, aliases);
    case 'entity.transformMany': return applyEntityTransformMany(draft, operation, aliases);
    case 'entity.group': return applyEntityGroup(draft, operation, aliases, resolvedIds);
    case 'entity.ungroup': return applyEntityUngroup(draft, operation, aliases);
    case 'entity.duplicate': return applyEntityDuplicate(draft, operation, aliases, resolvedIds);
    case 'entity.reparent': return applyEntityReparent(draft, operation, aliases);
    case 'entity.delete': return applyEntityDelete(draft, operation, aliases);
    case 'camera.frame': return applyCameraFrame(draft, operation, aliases);
    case 'layout.pattern': return applyLayoutPattern(draft, operation, aliases);
    case 'modifier.create': return applyModifierCreate(draft, operation, aliases);
    case 'modifier.patch': return applyModifierPatch(draft, operation, aliases);
    case 'modifier.move': return applyModifierMove(draft, operation, aliases);
    case 'modifier.delete': return applyModifierDelete(draft, operation, aliases);
    case 'modifier.stack.edit': return applyModifierStackEdit(draft, operation, aliases);
    case 'geometry.edit': return applyGeometryEdit(draft, operation, aliases);
    case 'resource.create': return applyResourceCreate(draft, operation, aliases, resolvedIds);
    case 'resource.patch': return applyResourcePatch(draft, operation, aliases);
    case 'resource.delete': return applyResourceDelete(draft, operation, aliases);
    case '_scene.restore': return applyInternalSceneRestore(draft, operation);
    case '_scene.fields.restore': return applyInternalSceneFieldsRestore(draft, operation);
    case '_scene.settings.restore': return applyInternalSceneSettingsRestore(draft, operation);
    case '_entity.fields.restore': return applyInternalEntityFieldsRestore(draft, operation);
    case '_entity.many.restore': return applyInternalEntityManyRestore(draft, operation);
    case '_collection.fields.restore': return applyInternalCollectionFieldsRestore(draft, operation);
    case '_resource.restore': return applyInternalResourceRestore(draft, operation);
    default: throw new StudioError('unknown_operation', `Unknown operation ${type}`);
  }
}

export function applyOperations(project, operations, { allowInternal = false } = {}) {
  studioAssert(Array.isArray(operations), 'invalid_request', 'operations must be an array');
  studioAssert(operations.length > 0, 'invalid_request', 'At least one operation is required');
  studioAssert(operations.length <= MAX_OPERATIONS_PER_TRANSACTION, 'operation_limit', `A transaction may contain at most ${MAX_OPERATIONS_PER_TRANSACTION} operations`);
  const draft = cloneJson(project);
  const aliases = new Map();
  const resolvedIds = {};
  const resolvedOperations = [];
  const inverseOperations = [];
  const invalidations = [];
  for (const operation of operations) {
    const type = operationType(operation);
    const result = applyOne(draft, operation, aliases, resolvedIds, allowInternal);
    resolvedOperations.push(result.resolved);
    inverseOperations.unshift(result.inverse);
    invalidations.push(...invalidationsFor(type, operation));
  }
  assertValidProjectDocument(draft);
  return {
    document: draft,
    resolvedOperations,
    inverseOperations,
    resolvedIds,
    invalidations: uniqueSorted(invalidations),
  };
}

export function supportedOperationTypes() {
  return [...OPERATION_KEYS.keys()].filter((type) => !type.startsWith('_'));
}
