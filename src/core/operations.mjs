import { MAX_OPERATIONS_PER_TRANSACTION } from './constants.mjs';
import {
  assertValidProjectDocument,
  createEntityDocument,
  createResourceDocument,
  createSceneDocument,
  normalizeGraphResourcePatch,
  normalizeResourceType,
} from './documents.mjs';
import { StudioError, studioAssert } from './errors.mjs';
import { assertStableId, assertTransactionAlias, resolveId } from './ids.mjs';
import { buildProjectIndex } from './indexes.mjs';
import { solveCameraFrame } from './camera-framing.mjs';
import { applyIndexedMeshEdit, validateIndexedMeshRecipe } from './indexed-mesh-editing.mjs';
import { normalizeLayoutPattern } from './layout-patterns.mjs';
import { DEFAULT_RTX_SETTINGS, normalizeRtxSettings } from './rtx-settings.mjs';
import { cloneJson, contentHash, isPlainRecord, mergePatch, uniqueSorted } from './util.mjs';

const MAX_GEOMETRY_EDIT_COMMANDS = 64;
const GEOMETRY_RECIPE_FIELDS = Object.freeze([
  'positions', 'indices', 'normals', 'uvs', 'colors', 'computeNormals',
]);
const GEOMETRY_EDIT_KEYS = new Map([
  ['move', new Set(['type', 'vertexIndices', 'selection', 'offset'])],
  ['scale', new Set(['type', 'vertexIndices', 'selection', 'scale', 'pivot'])],
  ['rotate', new Set(['type', 'vertexIndices', 'selection', 'rotation', 'axis', 'angle', 'pivot'])],
  ['smooth', new Set(['type', 'vertexIndices', 'selection', 'iterations', 'factor', 'preserveBoundary'])],
  ['recalculateNormals', new Set(['type'])],
  ['weld', new Set(['type', 'tolerance'])],
  ['triangulate', new Set(['type'])],
]);
const RTX_PATCH_KEYS = new Set(['enabled', ...Object.keys(DEFAULT_RTX_SETTINGS)]);

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
  ['entity.duplicate', new Set(['type', 'op', 'entityId', 'newId', 'name', 'parentId', 'index', 'deep', 'idMap', 'alias'])],
  ['entity.reparent', new Set(['type', 'op', 'entityId', 'parentId', 'index'])],
  ['entity.delete', new Set(['type', 'op', 'entityId', 'recursive', 'expectedSubtreeHash'])],
  ['camera.frame', new Set(['type', 'op', 'cameraId', 'bounds', 'targetIds', 'aspect', 'padding', 'direction', 'lockPreviewAspect'])],
  ['layout.pattern', new Set(['type', 'op', 'entityId', 'pattern'])],
  ['geometry.edit', new Set(['type', 'op', 'resourceId', 'edits'])],
  ['resource.create', new Set(['type', 'op', 'resourceType', 'resource', 'alias'])],
  ['resource.patch', new Set(['type', 'op', 'resourceType', 'resourceId', 'patch'])],
  ['resource.delete', new Set(['type', 'op', 'resourceType', 'resourceId'])],
  ['_scene.restore', new Set(['type', 'sceneId', 'snapshot', 'index', 'activeSceneId', 'restoreActive', 'expectedCurrentHash'])],
  ['_scene.fields.restore', new Set(['type', 'sceneId', 'fields'])],
  ['_scene.settings.restore', new Set(['type', 'sceneId', 'fields'])],
  ['_entity.fields.restore', new Set(['type', 'entityId', 'fields'])],
  ['_resource.restore', new Set(['type', 'resourceType', 'resourceId', 'snapshot', 'expectedCurrentHash'])],
]);

const ENTITY_PATCH_KEYS = new Set(['kind', 'name', 'visible', 'transform', 'components', 'tags', 'scriptIds', 'metadata']);
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

function assertIndexFree(draft, id) {
  const index = buildProjectIndex(draft);
  if (index.scenes.has(id) || index.entities.has(id) || index.resources.has(id) || index.scripts.has(id) || draft.projectId === id) {
    throw new StudioError('duplicate_id', `Stable ID ${id} is already in use`, { id });
  }
}

function invalidationsFor(type, operation) {
  if (type.startsWith('_scene.')) return ['sceneGraph', 'renderer', 'rtxTopology', 'persistence'];
  if (type.startsWith('_entity.')) return ['sceneGraph', 'transforms', 'renderer', 'rtxTransforms', 'persistence'];
  if (type.startsWith('_resource.')) {
    const resourceType = normalizeResourceType(operation.resourceType);
    return uniqueSorted([resourceType, 'renderer', 'persistence', ...(resourceType === 'geometries' ? ['rtxTopology'] : [])]);
  }
  if (type.startsWith('scene.')) return ['sceneGraph', 'renderer', 'rtxTopology', 'persistence'];
  if (type === 'camera.frame') return ['sceneGraph', 'transforms', 'renderer', 'persistence'];
  if (type === 'entity.reparent') return ['sceneGraph', 'transforms', 'renderer', 'rtxTransforms', 'persistence'];
  if (type === 'layout.pattern') return ['sceneGraph', 'transforms', 'geometry', 'renderer', 'rtxTopology', 'persistence'];
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
    if (resourceType === 'materials' || resourceType === 'graphs') result.push('materials');
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
  for (const entity of sceneEntities) resolveEntityReferences(entity, aliases);
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

function applyEntityCreate(draft, operation, aliases, resolvedIds) {
  const sceneId = resolveId(operation.sceneId, aliases, 'sceneId');
  const scene = buildProjectIndex(draft).getScene(sceneId);
  const source = cloneJson(operation.entity);
  studioAssert(isPlainRecord(source), 'invalid_operation', 'entity.create requires entity');
  if (aliases.has(source.id)) source.id = aliases.get(source.id);
  resolveEntityReferences(source, aliases);
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
  const fields = captureFields(entity, Object.keys(resolvedPatch));
  scene.entities[entityId] = createEntityDocument(mergePatch(entity, resolvedPatch));
  return {
    resolved: { type: 'entity.patch', entityId, patch: resolvedPatch },
    inverse: { type: '_entity.fields.restore', entityId, fields },
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
    const external = index.getReferencesTo(id).filter((reference) => !deleting.has(reference.sourceId) && reference.kind !== 'parent');
    studioAssert(external.length === 0, 'resource_in_use', `Entity ${id} is still referenced`, { references: external });
  }
  const snapshot = cloneJson(scene);
  const siblings = entity.parentId ? scene.entities[entity.parentId].children : scene.rootEntityIds;
  removeFrom(siblings, entityId);
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
  const directKind = ['indexedMesh', 'explicit'].includes(resource.type)
    ? resource.type
    : (resource.geometryKind ?? resource.kind);
  const source = Object.fromEntries(GEOMETRY_RECIPE_FIELDS
    .filter(key => Object.hasOwn(resource, key))
    .map(key => [key, cloneJson(resource[key])]));
  return { source, kind: directKind };
}

function canonicalIndexedMeshRecipe(resource, resourceId) {
  const { source, kind } = geometryRecipeSource(resource);
  studioAssert(
    ['indexedMesh', 'explicit'].includes(kind),
    'invalid_geometry_edit_target',
    `geometry.edit requires an indexedMesh or explicit geometry recipe, not ${String(kind)}.`,
    { resourceId, recipeKind: kind ?? null },
  );
  const recipe = { ...cloneJson(source), kind: 'indexedMesh' };
  delete recipe.type;
  try {
    return validateIndexedMeshRecipe(recipe);
  } catch (error) {
    throw new StudioError('invalid_geometry_edit_target', `Geometry ${resourceId} has an invalid indexed mesh recipe: ${error.message}`, {
      resourceId,
    });
  }
}

function assertGeometryEditCommand(command, editIndex) {
  studioAssert(isPlainRecord(command), 'invalid_geometry_edit', `geometry.edit edits[${editIndex}] must be an object.`, {
    editIndex,
  });
  const allowed = GEOMETRY_EDIT_KEYS.get(command.type);
  studioAssert(allowed, 'invalid_geometry_edit', `Unsupported geometry edit command ${String(command.type)}.`, {
    editIndex,
    commandType: command.type ?? null,
  });
  assertKnownKeys(command, allowed, `geometry.edit edits[${editIndex}]`);
  const supportsSelection = ['move', 'scale', 'rotate', 'smooth'].includes(command.type);
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
  let recipe = canonicalIndexedMeshRecipe(resource, resourceId);
  const edits = cloneJson(operation.edits);
  for (let editIndex = 0; editIndex < edits.length; editIndex += 1) {
    const command = edits[editIndex];
    assertGeometryEditCommand(command, editIndex);
    try {
      recipe = applyIndexedMeshEdit(recipe, command);
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
    resolved: { type: 'geometry.edit', resourceId, edits },
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
  const patch = resourceType === 'graphs'
    ? normalizeGraphResourcePatch(operation.patch, resource)
    : cloneJson(operation.patch);
  studioAssert(!Object.hasOwn(patch, 'id'), 'invalid_patch', 'Resource IDs are immutable');
  const snapshot = cloneJson(resource);
  draft.resources[resourceType][resourceId] = createResourceDocument(resourceType, mergePatch(resource, patch));
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
    case 'entity.create': return applyEntityCreate(draft, operation, aliases, resolvedIds);
    case 'entity.patch': return applyEntityPatch(draft, operation, aliases);
    case 'entity.duplicate': return applyEntityDuplicate(draft, operation, aliases, resolvedIds);
    case 'entity.reparent': return applyEntityReparent(draft, operation, aliases);
    case 'entity.delete': return applyEntityDelete(draft, operation, aliases);
    case 'camera.frame': return applyCameraFrame(draft, operation, aliases);
    case 'layout.pattern': return applyLayoutPattern(draft, operation, aliases);
    case 'geometry.edit': return applyGeometryEdit(draft, operation, aliases);
    case 'resource.create': return applyResourceCreate(draft, operation, aliases, resolvedIds);
    case 'resource.patch': return applyResourcePatch(draft, operation, aliases);
    case 'resource.delete': return applyResourceDelete(draft, operation, aliases);
    case '_scene.restore': return applyInternalSceneRestore(draft, operation);
    case '_scene.fields.restore': return applyInternalSceneFieldsRestore(draft, operation);
    case '_scene.settings.restore': return applyInternalSceneSettingsRestore(draft, operation);
    case '_entity.fields.restore': return applyInternalEntityFieldsRestore(draft, operation);
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
