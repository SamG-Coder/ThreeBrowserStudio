import {
  CAMERA_KINDS,
  ENTITY_KINDS,
  FORMAT_VERSION,
  MAX_AUTHORED_COLLECTIONS,
  MAX_AUTHORED_ENTITIES,
  PROTOCOL_VERSION,
  RESOURCE_TYPES,
} from './constants.mjs';
import { StudioError } from './errors.mjs';
import { assertStableId, isStableId } from './ids.mjs';
import { assertJsonValue, cloneJson, isPlainRecord, mergePatch, nowIso, uniqueSorted } from './util.mjs';
import { entityComponentReferences, validateEntityComponents } from './component-validation.mjs';
import { validateIndexedMeshRecipe } from './indexed-mesh-editing.mjs';
import { normalizeEditableMeshRecipe } from './editable-mesh.mjs';
import {
  DATA_TEXTURE_LIMITS,
  DATA_TEXTURE_RECIPE_KEYS,
  dataTextureDecodedByteLength,
  dataTextureSerializedByteLength,
  normalizeDataTextureResource,
  validateDataTextureResource,
} from './image-texture.mjs';
import {
  assertMaterialTextureCompatibility,
  assertMaterialTextureControls,
  materialTextureGraphConflicts,
  materialTextureReferences,
} from './material-textures.mjs';
import { validateGraph } from '../graphs/validator.mjs';

const PROJECT_KEYS = new Set([
  'kind', 'protocolVersion', 'formatVersion', 'projectId', 'name', 'revision',
  'savedRevision', 'activeSceneId', 'sceneOrder', 'scenes', 'resources', 'scripts',
  'scriptTrustPolicy', 'settings', 'exportSettings', 'metadata',
]);
const SCENE_KEYS = new Set([
  'id', 'name', 'rootEntityIds', 'entities', 'rootCollectionIds', 'collections',
  'settings', 'scriptIds', 'metadata',
]);
const COLLECTION_KEYS = new Set([
  'id', 'name', 'parentId', 'children', 'entityIds', 'metadata',
]);
const ENTITY_KEYS = new Set([
  'id', 'kind', 'name', 'parentId', 'children', 'visible', 'transform',
  'components', 'tags', 'scriptIds', 'metadata',
]);
const TRANSFORM_KEYS = new Set(['position', 'rotation', 'scale']);
const FLAT_GRAPH_KEYS = Object.freeze(['formatVersion', 'domain', 'nodes', 'edges', 'outputs', 'settings']);
const INDEXED_GEOMETRY_FIELDS = Object.freeze([
  'positions', 'indices', 'normals', 'uvs', 'colors', 'computeNormals', 'triangleMaterialIndices',
]);
const EDITABLE_GEOMETRY_FIELDS = Object.freeze([
  'positions', 'faceOffsets', 'cornerVertexIndices', 'uvLayers', 'colorLayers',
  'activeUvLayer', 'activeColorLayer', 'faceMaterialIndices', 'sharpEdges', 'edgeCreases',
]);

function validateGeometryResource(id, source) {
  const nested = isPlainRecord(source.recipe)
    ? source.recipe
    : isPlainRecord(source.parameters) ? source.parameters : null;
  const candidate = nested ?? source;
  const recipeKind = nested
    ? (candidate.kind ?? candidate.type)
    : (source.geometryKind ?? source.type ?? source.kind);
  if (recipeKind === 'editableMesh') {
    const editableCandidate = nested
      ? { ...candidate, kind: 'editableMesh' }
      : {
        kind: 'editableMesh',
        ...Object.fromEntries(EDITABLE_GEOMETRY_FIELDS
          .filter(key => Object.hasOwn(candidate, key))
          .map(key => [key, candidate[key]])),
      };
    delete editableCandidate.type;
    try {
      const recipe = normalizeEditableMeshRecipe(editableCandidate);
      if (isPlainRecord(source.recipe)) {
        source.recipe = recipe;
      } else {
        source.recipe = recipe;
        delete source.parameters;
        for (const field of EDITABLE_GEOMETRY_FIELDS) delete source[field];
        if (source.type === 'editableMesh') delete source.type;
        if (source.geometryKind === 'editableMesh') delete source.geometryKind;
        if (source.kind === 'editableMesh') delete source.kind;
      }
      return;
    } catch (error) {
      throw new StudioError(
        'invalid_geometry_resource',
        `Geometry resource ${id} has an invalid editableMesh recipe: ${error.message}`,
        { resourceId: id, recipeKind },
      );
    }
  }
  if (!['explicit', 'indexedMesh'].includes(recipeKind)) return;
  const recipe = {
    kind: 'indexedMesh',
    ...Object.fromEntries(INDEXED_GEOMETRY_FIELDS
      .filter(key => Object.hasOwn(candidate, key))
      .map(key => [key, candidate[key]])),
  };
  try {
    validateIndexedMeshRecipe(recipe);
  } catch (error) {
    throw new StudioError(
      'invalid_geometry_resource',
      `Geometry resource ${id} has an invalid ${recipeKind} recipe: ${error.message}`,
      { resourceId: id, recipeKind },
    );
  }
}

function normalizeTextureResource(id, source) {
  const nested = isPlainRecord(source.recipe)
    ? source.recipe
    : isPlainRecord(source.parameters) ? source.parameters : null;
  const directFields = DATA_TEXTURE_RECIPE_KEYS.filter(key => (
    !['kind', 'name'].includes(key) && Object.hasOwn(source, key)
  ));
  const directKind = source.textureKind ?? source.type ?? source.kind;
  const candidateKind = nested ? (nested.kind ?? nested.type) : directKind;
  if (candidateKind !== 'dataTexture') {
    const partialFields = nested
      ? DATA_TEXTURE_RECIPE_KEYS.filter(key => !['kind', 'name'].includes(key) && Object.hasOwn(nested, key))
      : [];
    if ((nested?.kind ?? nested?.type) === undefined && partialFields.length > 0) {
      throw new StudioError(
        'invalid_texture_resource',
        `Texture resource ${id} has dataTexture fields but its nested recipe does not declare kind: dataTexture.`,
        { resourceId: id, partialFields },
      );
    }
    // Format-v1 projects previously allowed generic placeholder texture
    // envelopes. Preserve those documents exactly; they remain indexable and
    // deletable but cannot enter the live raster material path until patched
    // to a canonical dataTexture recipe.
    return;
  }
  if (nested && directFields.length > 0) {
    throw new StudioError(
      'ambiguous_texture_resource',
      `Texture resource ${id} cannot mix a nested recipe with direct texture fields.`,
      { resourceId: id, directFields },
    );
  }
  if (source.recipe !== undefined && source.parameters !== undefined) {
    throw new StudioError(
      'ambiguous_texture_resource',
      `Texture resource ${id} cannot define both recipe and parameters.`,
      { resourceId: id },
    );
  }
  if (source.recipe !== undefined && !isPlainRecord(source.recipe)) {
    throw new StudioError('invalid_texture_resource', `Texture resource ${id} recipe must be a plain object.`, { resourceId: id });
  }
  if (source.parameters !== undefined && !isPlainRecord(source.parameters)) {
    throw new StudioError('invalid_texture_resource', `Texture resource ${id} parameters must be a plain object.`, { resourceId: id });
  }
  const candidate = nested
    ? { ...nested, kind: 'dataTexture' }
    : {
        kind: 'dataTexture',
        ...Object.fromEntries(DATA_TEXTURE_RECIPE_KEYS
          .filter(key => key !== 'kind' && Object.hasOwn(source, key))
          .map(key => [key, source[key]])),
      };
  delete candidate.type;
  try {
    source.recipe = normalizeDataTextureResource(candidate);
  } catch (error) {
    throw new StudioError(
      'invalid_texture_resource',
      `Texture resource ${id} has an invalid dataTexture recipe: ${error.message}`,
      { resourceId: id, recipeKind: 'dataTexture', diagnostics: error.details?.diagnostics ?? [] },
    );
  }
  delete source.parameters;
  for (const field of DATA_TEXTURE_RECIPE_KEYS) {
    if (!['name'].includes(field)) delete source[field];
  }
  if (source.type === 'dataTexture') delete source.type;
  if (source.textureKind === 'dataTexture') delete source.textureKind;
  source.kind = 'texture';
}

function defaultResources() {
  return Object.fromEntries(RESOURCE_TYPES.map((type) => [type, {}]));
}

function defaultSceneSettings() {
  return {
    background: {
      mode: 'color',
      color: [0.035, 0.045, 0.06],
      colorSpace: 'linear-srgb',
    },
    environment: null,
    fog: null,
    activeCameraId: null,
    timeline: {
      frameStart: 1,
      frameEnd: 250,
      currentFrame: 1,
      framesPerSecond: 24,
    },
  };
}

export function normalizeResourceType(type) {
  const aliases = {
    geometry: 'geometries', material: 'materials', texture: 'textures', graph: 'graphs',
    animation: 'animations', prefab: 'prefabs', asset: 'assets',
  };
  const normalized = aliases[type] ?? type;
  if (!RESOURCE_TYPES.includes(normalized)) {
    throw new StudioError('invalid_resource_type', `Unknown resource type ${type}`);
  }
  return normalized;
}

function graphValidationError(resourceId, diagnostics) {
  return new StudioError('graph_validation_failed', `Graph ${resourceId ?? '<unknown>'} is invalid.`, { diagnostics });
}

/**
 * Accept the historical flat MCP graph form while keeping the project document
 * canonical. Envelope metadata remains outside `graph`; graph control data is
 * moved under `graph` and validated by createResourceDocument.
 */
export function normalizeGraphResourceEnvelope(input, { graphId } = {}) {
  if (!isPlainRecord(input)) throw new StudioError('invalid_graph_resource', 'Graph resource must be an object.');
  const normalized = cloneJson(input);
  const flatKeys = FLAT_GRAPH_KEYS.filter(key => Object.hasOwn(normalized, key));
  if (Object.hasOwn(normalized, 'graph') && flatKeys.length) {
    throw new StudioError(
      'ambiguous_graph_resource',
      `Graph resource cannot mix nested graph with flat fields: ${flatKeys.join(', ')}.`,
      { fields: flatKeys },
    );
  }
  if (!Object.hasOwn(normalized, 'graph') && flatKeys.length) {
    const graph = {};
    const resolvedGraphId = graphId ?? normalized.id;
    if (resolvedGraphId !== undefined) graph.id = resolvedGraphId;
    for (const key of flatKeys) {
      graph[key] = normalized[key];
      delete normalized[key];
    }
    normalized.graph = graph;
  }
  return normalized;
}

export function normalizeGraphResourcePatch(patch, currentResource) {
  if (!isPlainRecord(patch)) throw new StudioError('invalid_patch', 'Graph resource patch must be an object.');
  const source = cloneJson(patch);
  const suppliedGraphId = source.id;
  const currentGraphId = currentResource?.graph?.id ?? currentResource?.id;
  if (suppliedGraphId !== undefined && currentGraphId !== undefined && suppliedGraphId !== currentGraphId) {
    throw new StudioError(
      'invalid_patch',
      `Graph id ${suppliedGraphId} does not match existing graph ${currentGraphId}.`,
      { graphId: suppliedGraphId, expectedGraphId: currentGraphId },
    );
  }
  delete source.id;
  const normalized = normalizeGraphResourceEnvelope(source, {
    graphId: suppliedGraphId ?? currentGraphId,
  });
  if (!currentResource) return normalized;
  const candidate = createResourceDocument('graphs', mergePatch(currentResource, normalized));
  if (Object.hasOwn(normalized, 'graph')) normalized.graph = candidate.graph;
  return normalized;
}

export function createEntityDocument(input = {}) {
  const id = assertStableId(input.id, 'entity.id');
  const kind = input.kind ?? 'empty';
  return {
    id,
    kind,
    name: input.name ?? id.split('/').at(-1),
    parentId: input.parentId ?? null,
    children: [...(input.children ?? [])],
    visible: input.visible ?? true,
    transform: {
      position: [...(input.transform?.position ?? [0, 0, 0])],
      rotation: [...(input.transform?.rotation ?? [0, 0, 0])],
      scale: [...(input.transform?.scale ?? [1, 1, 1])],
    },
    components: cloneJson(input.components ?? {}),
    tags: uniqueSorted(input.tags ?? []),
    scriptIds: uniqueSorted(input.scriptIds ?? []),
    metadata: cloneJson(input.metadata ?? {}),
  };
}

export function createCollectionDocument(input = {}) {
  const id = assertStableId(input.id, 'collection.id');
  return {
    id,
    name: input.name ?? id.split('/').at(-1),
    parentId: input.parentId ?? null,
    children: [...(input.children ?? [])],
    entityIds: uniqueSorted(input.entityIds ?? []),
    metadata: cloneJson(input.metadata ?? {}),
  };
}

export function createSceneDocument(input = {}) {
  const id = assertStableId(input.id, 'scene.id');
  const entities = {};
  const sourceEntities = Array.isArray(input.entities)
    ? input.entities
    : Object.values(input.entities ?? {});
  for (const source of sourceEntities) {
    const entity = createEntityDocument(source);
    entities[entity.id] = entity;
  }
  const collections = {};
  const sourceCollections = Array.isArray(input.collections)
    ? input.collections
    : Object.values(input.collections ?? {});
  for (const source of sourceCollections) {
    const collection = createCollectionDocument(source);
    collections[collection.id] = collection;
  }
  const defaults = defaultSceneSettings();
  const authoredSettings = cloneJson(input.settings) ?? {};
  const settings = {
    ...defaults,
    ...authoredSettings,
    background: authoredSettings.background === undefined
      ? defaults.background
      : { ...defaults.background, ...authoredSettings.background },
    timeline: authoredSettings.timeline === undefined
      ? defaults.timeline
      : { ...defaults.timeline, ...authoredSettings.timeline },
  };
  return {
    id,
    name: input.name ?? id.split('/').at(-1),
    rootEntityIds: [...(input.rootEntityIds ?? Object.values(entities)
      .filter((entity) => entity.parentId === null)
      .map((entity) => entity.id))],
    entities,
    rootCollectionIds: [...(input.rootCollectionIds ?? Object.values(collections)
      .filter((collection) => collection.parentId === null)
      .map((collection) => collection.id))],
    collections,
    settings,
    scriptIds: uniqueSorted(input.scriptIds ?? []),
    metadata: cloneJson(input.metadata ?? {}),
  };
}

export function createResourceDocument(resourceType, input = {}) {
  const normalizedResourceType = normalizeResourceType(resourceType);
  const source = normalizedResourceType === 'graphs'
    ? normalizeGraphResourceEnvelope(input)
    : cloneJson(input);
  const id = assertStableId(source.id, 'resource.id');
  if (normalizedResourceType === 'graphs') {
    if (!isPlainRecord(source.graph)) {
      throw new StudioError(
        'invalid_graph_resource',
        `Graph resource ${id} requires a nested graph object.`,
        { canonicalEnvelope: { id, kind: 'graph', graph: { formatVersion: 1, id, domain: 'shader', nodes: [], edges: [], outputs: {} } } },
      );
    }
    const validation = validateGraph(source.graph);
    if (!validation.valid) throw graphValidationError(id, validation.diagnostics);
    source.graph = validation.graph;
  }
  if (normalizedResourceType === 'geometries') validateGeometryResource(id, source);
  if (normalizedResourceType === 'textures') normalizeTextureResource(id, source);
  if (normalizedResourceType === 'materials') assertMaterialTextureCompatibility(source);
  const defaultKinds = {
    geometries: 'geometry',
    materials: 'material',
    textures: 'texture',
    graphs: 'graph',
    animations: 'animation',
    prefabs: 'prefab',
    audio: 'audio',
    assets: 'asset',
  };
  return {
    ...source,
    id,
    kind: source.kind ?? defaultKinds[normalizedResourceType],
    name: source.name ?? id.split('/').at(-1),
    metadata: cloneJson(source.metadata ?? {}),
  };
}

export function createScriptDocument(input = {}) {
  const id = assertStableId(input.id, 'script.id');
  return {
    id,
    name: input.name ?? id.split('/').at(-1),
    path: input.path ?? `scripts/${id.replaceAll('/', '-')}.mjs`,
    trustLevel: input.trustLevel ?? 'agent-safe',
    hash: input.hash ?? null,
    exposedFunctions: uniqueSorted(input.exposedFunctions ?? []),
    metadata: cloneJson(input.metadata ?? {}),
  };
}

export function createProjectDocument(options = {}) {
  const projectId = assertStableId(options.projectId ?? options.id ?? 'project/main', 'projectId');
  const timestamp = options.timestamp ?? nowIso(options.clock);
  const sceneInputs = options.scenes
    ? (Array.isArray(options.scenes) ? options.scenes : Object.values(options.scenes))
    : (options.withDefaultScene === false ? [] : [{ id: options.defaultSceneId ?? 'scene/main', name: 'Main Scene' }]);
  const scenes = {};
  for (const source of sceneInputs) {
    const scene = createSceneDocument(source);
    scenes[scene.id] = scene;
  }
  const sceneOrder = options.sceneOrder
    ? [...options.sceneOrder]
    : Object.keys(scenes);
  const activeSceneId = options.activeSceneId ?? sceneOrder[0] ?? null;
  const resources = defaultResources();
  for (const type of RESOURCE_TYPES) {
    const source = options.resources?.[type] ?? {};
    for (const item of Array.isArray(source) ? source : Object.values(source)) {
      const resource = createResourceDocument(type, item);
      resources[type][resource.id] = resource;
    }
  }
  const scripts = {};
  for (const item of Array.isArray(options.scripts) ? options.scripts : Object.values(options.scripts ?? {})) {
    const script = createScriptDocument(item);
    scripts[script.id] = script;
  }
  return {
    kind: 'ThreeStudioProject',
    protocolVersion: PROTOCOL_VERSION,
    formatVersion: FORMAT_VERSION,
    projectId,
    name: options.name ?? 'Untitled Project',
    revision: options.revision ?? 0,
    savedRevision: options.savedRevision ?? 0,
    activeSceneId,
    sceneOrder,
    scenes,
    resources,
    scripts,
    scriptTrustPolicy: options.scriptTrustPolicy ?? 'agent-safe',
    settings: {
      lengthUnit: 'metre',
      angleUnit: 'radian',
      timeUnit: 'second',
      workingColorSpace: 'linear-srgb',
      ...(cloneJson(options.settings) ?? {}),
    },
    exportSettings: cloneJson(options.exportSettings ?? {}),
    metadata: {
      createdAt: options.metadata?.createdAt ?? timestamp,
      updatedAt: options.metadata?.updatedAt ?? timestamp,
      ...(cloneJson(options.metadata) ?? {}),
    },
  };
}

export function normalizeProjectDocument(input) {
  assertJsonValue(input);
  const project = createProjectDocument({
    ...input,
    projectId: input.projectId,
    scenes: input.scenes ?? [],
    withDefaultScene: false,
  });
  const validation = validateProjectDocument(project);
  if (!validation.valid) {
    throw new StudioError('validation_failed', 'Project document is invalid', {
      diagnostics: validation.diagnostics,
    });
  }
  return project;
}

function issue(diagnostics, code, path, message) {
  diagnostics.push({ severity: 'error', code, path, message });
}

function unknownKeys(value, allowed, path, diagnostics) {
  if (!isPlainRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issue(diagnostics, 'unknown_property', `${path}.${key}`, `Unknown property ${key}`);
  }
}

function vector3(value, path, diagnostics, { nonZero = false } = {}) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((number) => !Number.isFinite(number))) {
    issue(diagnostics, 'invalid_vector3', path, 'Expected three finite numbers');
    return;
  }
  if (nonZero && value.some((number) => number === 0)) {
    issue(diagnostics, 'zero_scale', path, 'Scale components must be non-zero');
  }
}

function validateEntity(entity, key, scene, diagnostics) {
  const path = `$.scenes.${scene.id}.entities.${key}`;
  if (!isPlainRecord(entity)) {
    issue(diagnostics, 'invalid_entity', path, 'Entity must be an object');
    return;
  }
  unknownKeys(entity, ENTITY_KEYS, path, diagnostics);
  if (!isStableId(entity.id)) issue(diagnostics, 'invalid_id', `${path}.id`, 'Invalid stable entity ID');
  if (key !== entity.id) issue(diagnostics, 'index_mismatch', path, 'Entity map key must match entity.id');
  if (!ENTITY_KINDS.includes(entity.kind)) issue(diagnostics, 'invalid_entity_kind', `${path}.kind`, `Unsupported kind ${entity.kind}`);
  if (typeof entity.name !== 'string' || entity.name.length === 0) issue(diagnostics, 'invalid_name', `${path}.name`, 'Name is required');
  if (entity.parentId !== null && !isStableId(entity.parentId)) issue(diagnostics, 'invalid_parent', `${path}.parentId`, 'parentId must be null or a stable ID');
  if (!Array.isArray(entity.children) || entity.children.some((id) => !isStableId(id))) issue(diagnostics, 'invalid_children', `${path}.children`, 'children must be stable IDs');
  if (new Set(entity.children ?? []).size !== (entity.children?.length ?? 0)) issue(diagnostics, 'duplicate_child', `${path}.children`, 'children cannot contain duplicates');
  if (typeof entity.visible !== 'boolean') issue(diagnostics, 'invalid_visible', `${path}.visible`, 'visible must be boolean');
  if (!isPlainRecord(entity.transform)) issue(diagnostics, 'invalid_transform', `${path}.transform`, 'transform must be an object');
  else {
    unknownKeys(entity.transform, TRANSFORM_KEYS, `${path}.transform`, diagnostics);
    vector3(entity.transform.position, `${path}.transform.position`, diagnostics);
    vector3(entity.transform.rotation, `${path}.transform.rotation`, diagnostics);
    vector3(entity.transform.scale, `${path}.transform.scale`, diagnostics, { nonZero: true });
  }
  if (!isPlainRecord(entity.components)) issue(diagnostics, 'invalid_components', `${path}.components`, 'components must be an object');
  else validateEntityComponents(entity, path, diagnostics);
  if (!Array.isArray(entity.tags) || entity.tags.some((tag) => typeof tag !== 'string')) issue(diagnostics, 'invalid_tags', `${path}.tags`, 'tags must be strings');
  if (!Array.isArray(entity.scriptIds) || entity.scriptIds.some((id) => !isStableId(id))) issue(diagnostics, 'invalid_scripts', `${path}.scriptIds`, 'scriptIds must be stable IDs');
  if (!isPlainRecord(entity.metadata)) issue(diagnostics, 'invalid_metadata', `${path}.metadata`, 'metadata must be an object');
}

function validateCollection(collection, key, scene, diagnostics) {
  const path = `$.scenes.${scene.id}.collections.${key}`;
  if (!isPlainRecord(collection)) {
    issue(diagnostics, 'invalid_collection', path, 'Collection must be an object');
    return;
  }
  unknownKeys(collection, COLLECTION_KEYS, path, diagnostics);
  if (!isStableId(collection.id)) issue(diagnostics, 'invalid_id', `${path}.id`, 'Invalid stable collection ID');
  if (key !== collection.id) issue(diagnostics, 'index_mismatch', path, 'Collection map key must match collection.id');
  if (typeof collection.name !== 'string' || collection.name.length === 0) issue(diagnostics, 'invalid_name', `${path}.name`, 'Name is required');
  if (collection.parentId !== null && !isStableId(collection.parentId)) issue(diagnostics, 'invalid_parent', `${path}.parentId`, 'parentId must be null or a stable ID');
  if (!Array.isArray(collection.children) || collection.children.some((id) => !isStableId(id))) issue(diagnostics, 'invalid_children', `${path}.children`, 'children must be stable IDs');
  if (new Set(collection.children ?? []).size !== (collection.children?.length ?? 0)) issue(diagnostics, 'duplicate_child', `${path}.children`, 'children cannot contain duplicates');
  if (!Array.isArray(collection.entityIds) || collection.entityIds.some((id) => !isStableId(id))) issue(diagnostics, 'invalid_collection_members', `${path}.entityIds`, 'entityIds must be stable IDs');
  if (new Set(collection.entityIds ?? []).size !== (collection.entityIds?.length ?? 0)) issue(diagnostics, 'duplicate_collection_member', `${path}.entityIds`, 'entityIds cannot contain duplicates');
  if (!isPlainRecord(collection.metadata)) issue(diagnostics, 'invalid_metadata', `${path}.metadata`, 'metadata must be an object');
}

function validateScene(scene, key, project, diagnostics) {
  const path = `$.scenes.${key}`;
  if (!isPlainRecord(scene)) {
    issue(diagnostics, 'invalid_scene', path, 'Scene must be an object');
    return;
  }
  unknownKeys(scene, SCENE_KEYS, path, diagnostics);
  if (!isStableId(scene.id)) issue(diagnostics, 'invalid_id', `${path}.id`, 'Invalid stable scene ID');
  if (key !== scene.id) issue(diagnostics, 'index_mismatch', path, 'Scene map key must match scene.id');
  if (typeof scene.name !== 'string' || scene.name.length === 0) issue(diagnostics, 'invalid_name', `${path}.name`, 'Name is required');
  if (!isPlainRecord(scene.entities)) issue(diagnostics, 'invalid_entities', `${path}.entities`, 'entities must be an object');
  else for (const [entityId, entity] of Object.entries(scene.entities)) validateEntity(entity, entityId, scene, diagnostics);
  if (!Array.isArray(scene.rootEntityIds)) issue(diagnostics, 'invalid_roots', `${path}.rootEntityIds`, 'rootEntityIds must be an array');
  else {
    if (scene.rootEntityIds.some((id) => !isStableId(id))) issue(diagnostics, 'invalid_roots', `${path}.rootEntityIds`, 'rootEntityIds must contain stable IDs');
    if (new Set(scene.rootEntityIds).size !== scene.rootEntityIds.length) issue(diagnostics, 'duplicate_root', `${path}.rootEntityIds`, 'rootEntityIds cannot contain duplicates');
  }
  if (!isPlainRecord(scene.collections)) issue(diagnostics, 'invalid_collections', `${path}.collections`, 'collections must be an object');
  else for (const [collectionId, collection] of Object.entries(scene.collections)) validateCollection(collection, collectionId, scene, diagnostics);
  if (!Array.isArray(scene.rootCollectionIds)) issue(diagnostics, 'invalid_collection_roots', `${path}.rootCollectionIds`, 'rootCollectionIds must be an array');
  else {
    if (scene.rootCollectionIds.some((id) => !isStableId(id))) issue(diagnostics, 'invalid_collection_roots', `${path}.rootCollectionIds`, 'rootCollectionIds must contain stable IDs');
    if (new Set(scene.rootCollectionIds).size !== scene.rootCollectionIds.length) issue(diagnostics, 'duplicate_collection_root', `${path}.rootCollectionIds`, 'rootCollectionIds cannot contain duplicates');
  }
  if (!isPlainRecord(scene.settings)) issue(diagnostics, 'invalid_settings', `${path}.settings`, 'settings must be an object');
  else {
    const timeline = scene.settings.timeline;
    if (!isPlainRecord(timeline)) issue(diagnostics, 'invalid_timeline', `${path}.settings.timeline`, 'timeline must be an object');
    else {
      for (const key of ['frameStart', 'frameEnd', 'currentFrame']) {
        if (!Number.isInteger(timeline[key])) issue(diagnostics, 'invalid_timeline', `${path}.settings.timeline.${key}`, `${key} must be an integer`);
      }
      if (Number.isInteger(timeline.frameStart) && Number.isInteger(timeline.frameEnd) && timeline.frameEnd < timeline.frameStart) {
        issue(diagnostics, 'invalid_timeline', `${path}.settings.timeline.frameEnd`, 'frameEnd must not precede frameStart');
      }
      if (!Number.isFinite(timeline.framesPerSecond) || timeline.framesPerSecond <= 0 || timeline.framesPerSecond > 240) {
        issue(diagnostics, 'invalid_timeline', `${path}.settings.timeline.framesPerSecond`, 'framesPerSecond must be greater than zero and at most 240');
      }
    }
  }
  if (!Array.isArray(scene.scriptIds)) issue(diagnostics, 'invalid_scripts', `${path}.scriptIds`, 'scriptIds must be an array');

  if (!isPlainRecord(scene.entities)) return;
  const roots = new Set(scene.rootEntityIds ?? []);
  for (const rootId of roots) {
    const root = scene.entities[rootId];
    if (!root) issue(diagnostics, 'missing_root', `${path}.rootEntityIds`, `Root ${rootId} does not exist`);
    else if (root.parentId !== null) issue(diagnostics, 'root_has_parent', `${path}.rootEntityIds`, `Root ${rootId} has a parent`);
  }
  for (const entity of Object.values(scene.entities)) {
    if (entity.parentId === null && !roots.has(entity.id)) issue(diagnostics, 'unindexed_root', `${path}.entities.${entity.id}`, 'Root entity is missing from rootEntityIds');
    if (entity.parentId !== null) {
      const parent = scene.entities[entity.parentId];
      if (!parent) issue(diagnostics, 'missing_parent', `${path}.entities.${entity.id}.parentId`, `Parent ${entity.parentId} does not exist`);
      else if (!parent.children.includes(entity.id)) issue(diagnostics, 'parent_child_mismatch', `${path}.entities.${entity.id}`, 'Parent does not list this child');
    }
    for (const childId of entity.children ?? []) {
      const child = scene.entities[childId];
      if (!child) issue(diagnostics, 'missing_child', `${path}.entities.${entity.id}.children`, `Child ${childId} does not exist`);
      else if (child.parentId !== entity.id) issue(diagnostics, 'parent_child_mismatch', `${path}.entities.${entity.id}.children`, `Child ${childId} points to another parent`);
    }
    for (const scriptId of entity.scriptIds ?? []) {
      if (!project.scripts?.[scriptId]) issue(diagnostics, 'missing_script', `${path}.entities.${entity.id}.scriptIds`, `Script ${scriptId} does not exist`);
    }
    for (const reference of entityComponentReferences(entity)) {
      if (['constraintTarget', 'lightTarget'].includes(reference.kind)) {
        if (!scene.entities[reference.targetId]) issue(diagnostics, 'missing_entity_reference', `${path}.entities.${entity.id}.${reference.path}`, `Entity ${reference.targetId} does not exist`);
        continue;
      }
      const tables = {
        geometry: 'geometries', material: 'materials', animation: 'animations',
        prefab: 'prefabs', audio: 'audio',
      };
      const table = tables[reference.kind];
      if (table && !project.resources?.[table]?.[reference.targetId]) {
        issue(diagnostics, 'missing_resource', `${path}.entities.${entity.id}.${reference.path}`, `${reference.kind} ${reference.targetId} does not exist`);
      }
    }
  }
  if (isPlainRecord(scene.collections)) {
    const collectionRoots = new Set(scene.rootCollectionIds ?? []);
    for (const rootId of collectionRoots) {
      const root = scene.collections[rootId];
      if (!root) issue(diagnostics, 'missing_collection_root', `${path}.rootCollectionIds`, `Collection root ${rootId} does not exist`);
      else if (root.parentId !== null) issue(diagnostics, 'collection_root_has_parent', `${path}.rootCollectionIds`, `Collection root ${rootId} has a parent`);
    }
    for (const collection of Object.values(scene.collections)) {
      if (collection.parentId === null && !collectionRoots.has(collection.id)) issue(diagnostics, 'unindexed_collection_root', `${path}.collections.${collection.id}`, 'Root collection is missing from rootCollectionIds');
      if (collection.parentId !== null) {
        const parent = scene.collections[collection.parentId];
        if (!parent) issue(diagnostics, 'missing_collection_parent', `${path}.collections.${collection.id}.parentId`, `Collection parent ${collection.parentId} does not exist`);
        else if (!parent.children.includes(collection.id)) issue(diagnostics, 'collection_parent_child_mismatch', `${path}.collections.${collection.id}`, 'Collection parent does not list this child');
      }
      for (const childId of collection.children ?? []) {
        const child = scene.collections[childId];
        if (!child) issue(diagnostics, 'missing_collection_child', `${path}.collections.${collection.id}.children`, `Collection child ${childId} does not exist`);
        else if (child.parentId !== collection.id) issue(diagnostics, 'collection_parent_child_mismatch', `${path}.collections.${collection.id}.children`, `Collection child ${childId} points to another parent`);
      }
      for (const entityId of collection.entityIds ?? []) {
        if (!scene.entities[entityId]) issue(diagnostics, 'missing_collection_entity', `${path}.collections.${collection.id}.entityIds`, `Collection member ${entityId} does not exist`);
      }
    }
    const collectionVisiting = new Set();
    const collectionVisited = new Set();
    const visitCollection = (id) => {
      if (collectionVisiting.has(id)) {
        issue(diagnostics, 'collection_hierarchy_cycle', `${path}.collections.${id}`, 'Collection hierarchy contains a cycle');
        return;
      }
      if (collectionVisited.has(id) || !scene.collections[id]) return;
      collectionVisiting.add(id);
      for (const child of scene.collections[id].children ?? []) visitCollection(child);
      collectionVisiting.delete(id);
      collectionVisited.add(id);
    };
    for (const id of Object.keys(scene.collections)) visitCollection(id);
  }
  for (const scriptId of scene.scriptIds ?? []) {
    if (!project.scripts?.[scriptId]) issue(diagnostics, 'missing_script', `${path}.scriptIds`, `Script ${scriptId} does not exist`);
  }
  const activeCameraId = scene.settings?.activeCameraId;
  if (activeCameraId !== null && activeCameraId !== undefined) {
    const camera = scene.entities[activeCameraId];
    if (!camera) issue(diagnostics, 'missing_camera', `${path}.settings.activeCameraId`, `Camera ${activeCameraId} does not exist`);
    else if (!CAMERA_KINDS.includes(camera.kind)) issue(diagnostics, 'invalid_camera', `${path}.settings.activeCameraId`, `${activeCameraId} is not a camera`);
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) {
      issue(diagnostics, 'hierarchy_cycle', `${path}.entities.${id}`, 'Entity hierarchy contains a cycle');
      return;
    }
    if (visited.has(id) || !scene.entities[id]) return;
    visiting.add(id);
    for (const child of scene.entities[id].children ?? []) visit(child);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of Object.keys(scene.entities)) visit(id);
}

export function validateProjectDocument(project, {
  maxEntities = MAX_AUTHORED_ENTITIES,
  maxCollections = MAX_AUTHORED_COLLECTIONS,
} = {}) {
  const diagnostics = [];
  let textureDecodedBytes = 0;
  let textureSerializedBytes = 0;
  try {
    assertJsonValue(project);
  } catch (error) {
    issue(diagnostics, 'invalid_json', '$', error.message);
    return { valid: false, diagnostics, budgets: { entities: 0, maxEntities, collections: 0, maxCollections } };
  }
  if (!isPlainRecord(project)) {
    issue(diagnostics, 'invalid_project', '$', 'Project must be an object');
    return { valid: false, diagnostics, budgets: { entities: 0, maxEntities, collections: 0, maxCollections } };
  }
  unknownKeys(project, PROJECT_KEYS, '$', diagnostics);
  if (project.kind !== 'ThreeStudioProject') issue(diagnostics, 'invalid_kind', '$.kind', 'Expected ThreeStudioProject');
  if (project.protocolVersion !== PROTOCOL_VERSION) issue(diagnostics, 'protocol_mismatch', '$.protocolVersion', `Expected ${PROTOCOL_VERSION}`);
  if (project.formatVersion !== FORMAT_VERSION) issue(diagnostics, 'format_mismatch', '$.formatVersion', `Expected ${FORMAT_VERSION}`);
  if (!isStableId(project.projectId)) issue(diagnostics, 'invalid_id', '$.projectId', 'Invalid stable project ID');
  if (typeof project.name !== 'string' || project.name.length === 0 || project.name.length > 160) issue(diagnostics, 'invalid_name', '$.name', 'Project name must contain 1 to 160 characters');
  if (!Number.isSafeInteger(project.revision) || project.revision < 0) issue(diagnostics, 'invalid_revision', '$.revision', 'revision must be a non-negative safe integer');
  if (!Number.isSafeInteger(project.savedRevision) || project.savedRevision < 0 || project.savedRevision > project.revision) issue(diagnostics, 'invalid_saved_revision', '$.savedRevision', 'savedRevision must be between zero and revision');
  if (!isPlainRecord(project.scenes)) issue(diagnostics, 'invalid_scenes', '$.scenes', 'scenes must be an object');
  if (!Array.isArray(project.sceneOrder)) issue(diagnostics, 'invalid_scene_order', '$.sceneOrder', 'sceneOrder must be an array');
  if (!isPlainRecord(project.resources)) issue(diagnostics, 'invalid_resources', '$.resources', 'resources must be an object');
  else for (const key of Object.keys(project.resources)) if (!RESOURCE_TYPES.includes(key)) issue(diagnostics, 'unknown_property', `$.resources.${key}`, `Unknown resource type ${key}`);
  if (!isPlainRecord(project.scripts)) issue(diagnostics, 'invalid_scripts', '$.scripts', 'scripts must be an object');
  if (!['agent-safe', 'trusted-project'].includes(project.scriptTrustPolicy)) issue(diagnostics, 'invalid_trust_policy', '$.scriptTrustPolicy', 'Unknown script trust policy');
  if (!isPlainRecord(project.settings)) issue(diagnostics, 'invalid_settings', '$.settings', 'settings must be an object');
  else {
    if (project.settings.lengthUnit !== 'metre') issue(diagnostics, 'invalid_unit', '$.settings.lengthUnit', 'World length unit must be metre');
    if (project.settings.angleUnit !== 'radian') issue(diagnostics, 'invalid_unit', '$.settings.angleUnit', 'Rotation unit must be radian');
    if (project.settings.timeUnit !== 'second') issue(diagnostics, 'invalid_unit', '$.settings.timeUnit', 'Time unit must be second');
    if (typeof project.settings.workingColorSpace !== 'string' || project.settings.workingColorSpace.length === 0) issue(diagnostics, 'invalid_color_space', '$.settings.workingColorSpace', 'Working colour space is required');
  }
  if (!isPlainRecord(project.exportSettings)) issue(diagnostics, 'invalid_export_settings', '$.exportSettings', 'exportSettings must be an object');
  if (!isPlainRecord(project.metadata)) issue(diagnostics, 'invalid_metadata', '$.metadata', 'metadata must be an object');

  for (const type of RESOURCE_TYPES) {
    const table = project.resources?.[type];
    if (!isPlainRecord(table)) {
      issue(diagnostics, 'invalid_resource_index', `$.resources.${type}`, `${type} must be an object`);
      continue;
    }
    for (const [id, resource] of Object.entries(table)) {
      if (!isPlainRecord(resource) || !isStableId(resource.id) || resource.id !== id) issue(diagnostics, 'invalid_resource', `$.resources.${type}.${id}`, 'Resource key and stable resource.id must match');
      if (type === 'graphs' && isPlainRecord(resource)) {
        const graphPath = `$.resources.graphs.${id}.graph`;
        if (!isPlainRecord(resource.graph)) {
          issue(diagnostics, 'invalid_graph_resource', graphPath, 'Graph resources require a canonical nested graph object.');
        } else {
          const validation = validateGraph(resource.graph);
          for (const item of validation.errors) {
            const suffix = item.path ? item.path.replaceAll('/', '.') : '';
            issue(diagnostics, item.code, `${graphPath}${suffix}`, item.message);
          }
        }
      }
      if (type === 'textures' && isPlainRecord(resource)) {
        const recipe = resource.recipe ?? resource.parameters ?? resource;
        const recipeKind = isPlainRecord(recipe) ? (recipe.kind ?? recipe.type) : null;
        if (recipeKind !== 'dataTexture') {
          const partialFields = isPlainRecord(recipe) && recipe !== resource && recipeKind === undefined
            ? DATA_TEXTURE_RECIPE_KEYS.filter(key => !['kind', 'name'].includes(key) && Object.hasOwn(recipe, key))
            : [];
          if (partialFields.length > 0) {
            issue(
              diagnostics,
              'invalid_texture_resource',
              `$.resources.textures.${id}.recipe`,
              'Nested dataTexture fields require recipe.kind to be dataTexture.',
            );
          }
          continue;
        }
        const validation = validateDataTextureResource(recipe);
        for (const item of validation.errors) {
          const suffix = item.path === '/' ? '' : item.path.replaceAll('/', '.');
          issue(diagnostics, item.code, `$.resources.textures.${id}.recipe${suffix}`, item.message);
        }
        if (validation.valid) {
          textureDecodedBytes += dataTextureDecodedByteLength(validation.resource);
          textureSerializedBytes += dataTextureSerializedByteLength(validation.resource);
        }
      }
    }
  }
  if (textureDecodedBytes > DATA_TEXTURE_LIMITS.maxProjectDecodedBytes) {
    issue(
      diagnostics,
      'project_texture_budget_exceeded',
      '$.resources.textures',
      `Decoded texture data uses ${textureDecodedBytes} bytes; the project limit is ${DATA_TEXTURE_LIMITS.maxProjectDecodedBytes}.`,
    );
  }
  if (textureSerializedBytes > DATA_TEXTURE_LIMITS.maxProjectSerializedBytes) {
    issue(
      diagnostics,
      'project_texture_serialized_budget_exceeded',
      '$.resources.textures',
      `Serialized texture recipes use ${textureSerializedBytes} bytes; the project limit is ${DATA_TEXTURE_LIMITS.maxProjectSerializedBytes}.`,
    );
  }
  for (const [id, material] of Object.entries(project.resources?.materials ?? {})) {
    let references = [];
    try {
      assertMaterialTextureCompatibility(material);
      references = materialTextureReferences(material);
    } catch (error) {
      issue(diagnostics, error.code ?? 'invalid_material_texture_reference', `$.resources.materials.${id}`, error.message);
      continue;
    }
    const hasLiveTextureReference = references.some(reference => {
      const texture = project.resources?.textures?.[reference.textureId];
      const recipe = texture?.recipe ?? texture?.parameters;
      return isPlainRecord(recipe) && recipe.kind === 'dataTexture';
    });
    if (hasLiveTextureReference) {
      try {
        assertMaterialTextureControls(material);
      } catch (error) {
        issue(diagnostics, error.code ?? 'invalid_material_texture_control', `$.resources.materials.${id}`, error.message);
      }
    }
    for (const reference of references) {
      const texture = project.resources?.textures?.[reference.textureId];
      const path = `$.resources.materials.${id}.${reference.authoredKey}`;
      if (!texture) {
        issue(diagnostics, 'missing_resource', path, `texture ${reference.textureId} does not exist`);
        continue;
      }
      const textureRecipe = texture.recipe ?? texture.parameters;
      if (!isPlainRecord(textureRecipe) || textureRecipe.kind !== 'dataTexture') continue;
      const colorSpace = textureRecipe.colorSpace;
      if (!reference.colorSpaces.includes(colorSpace)) {
        issue(
          diagnostics,
          'material_texture_color_space_mismatch',
          path,
          `${reference.idKey} requires texture color space ${reference.colorSpaces.join(' or ')}, but ${reference.textureId} is ${String(colorSpace)}.`,
        );
      }
      const channels = textureRecipe.channels;
      if (!reference.allowedChannels.includes(channels)) {
        issue(
          diagnostics,
          'material_texture_channel_mismatch',
          path,
          `${reference.idKey} requires source channels ${reference.allowedChannels.join(' or ')}, but ${reference.textureId} has ${String(channels)}.`,
        );
      }
    }
    const graphId = material.graphId
      ?? material.recipe?.graphId
      ?? material.parameters?.graphId
      ?? material.values?.graphId;
    const graphResource = graphId ? project.resources?.graphs?.[graphId] : null;
    if (graphId && !graphResource) {
      issue(
        diagnostics,
        'missing_resource',
        `$.resources.materials.${id}.graphId`,
        `graph ${graphId} does not exist`,
      );
    }
    for (const conflict of materialTextureGraphConflicts(material, graphResource)) {
      issue(
        diagnostics,
        'material_texture_graph_conflict',
        `$.resources.materials.${id}.${conflict.idKey}`,
        `${conflict.idKey} is overridden by graph output ${conflict.graphOutput}; sample ${conflict.textureId} inside the graph instead.`,
      );
    }
  }
  for (const [id, graphResource] of Object.entries(project.resources?.graphs ?? {})) {
    if (!isPlainRecord(graphResource) || !isPlainRecord(graphResource.graph)
        || !Array.isArray(graphResource.graph.nodes)) continue;
    for (const node of graphResource.graph.nodes) {
      if (!isPlainRecord(node)) continue;
      if (node.type === 'image') {
        const assetId = node.params?.assetId;
        const path = `$.resources.graphs.${id}.graph.nodes.${node.id}.params.assetId`;
        if (!project.resources?.assets?.[assetId]) {
          issue(diagnostics, 'missing_resource', path, `asset ${String(assetId)} does not exist`);
        }
        continue;
      }
      if (node.type !== 'texture.sample2d') continue;
      const textureId = node.params?.textureId;
      const path = `$.resources.graphs.${id}.graph.nodes.${node.id}.params.textureId`;
      if (!project.resources?.textures?.[textureId]) {
        issue(diagnostics, 'missing_resource', path, `texture ${String(textureId)} does not exist`);
        continue;
      }
      const textureRecipe = project.resources.textures[textureId].recipe
        ?? project.resources.textures[textureId].parameters;
      if (!isPlainRecord(textureRecipe) || textureRecipe.kind !== 'dataTexture') continue;
      const expectedColorSpace = node.params?.colorSpace;
      const actualColorSpace = textureRecipe.colorSpace;
      if (['srgb', 'linear', 'none'].includes(expectedColorSpace)
          && actualColorSpace !== expectedColorSpace) {
        issue(
          diagnostics,
          'graph_texture_color_space_mismatch',
          path,
          `Graph node expects ${expectedColorSpace} texture data, but ${textureId} is ${String(actualColorSpace)}.`,
        );
      }
    }
  }
  for (const [id, script] of Object.entries(project.scripts ?? {})) {
    if (!isPlainRecord(script) || script.id !== id || !isStableId(id)) issue(diagnostics, 'invalid_script', `$.scripts.${id}`, 'Script key and stable script.id must match');
    if (script?.trustLevel === 'trusted-project' && project.scriptTrustPolicy !== 'trusted-project') issue(diagnostics, 'trust_violation', `$.scripts.${id}.trustLevel`, 'Trusted script is not allowed by project policy');
    if (typeof script?.path !== 'string' || script.path.length === 0 || /(^[a-zA-Z]:|^[\\/]|(^|[\\/])\.\.([\\/]|$))/.test(script.path)) issue(diagnostics, 'invalid_script_path', `$.scripts.${id}.path`, 'Script path must remain relative to the project root');
  }
  for (const [id, scene] of Object.entries(project.scenes ?? {})) validateScene(scene, id, project, diagnostics);

  const order = project.sceneOrder ?? [];
  if (new Set(order).size !== order.length) issue(diagnostics, 'duplicate_scene_order', '$.sceneOrder', 'sceneOrder contains duplicates');
  for (const id of order) if (!project.scenes?.[id]) issue(diagnostics, 'missing_scene', '$.sceneOrder', `Scene ${id} does not exist`);
  for (const id of Object.keys(project.scenes ?? {})) if (!order.includes(id)) issue(diagnostics, 'unindexed_scene', `$.scenes.${id}`, 'Scene is missing from sceneOrder');
  if (project.activeSceneId !== null && !project.scenes?.[project.activeSceneId]) issue(diagnostics, 'missing_active_scene', '$.activeSceneId', 'Active scene does not exist');
  if (project.activeSceneId === null && order.length > 0) issue(diagnostics, 'missing_active_scene', '$.activeSceneId', 'A project with scenes requires an active scene');

  const allIds = new Map([[project.projectId, '$.projectId']]);
  const register = (id, path) => {
    if (allIds.has(id)) issue(diagnostics, 'duplicate_id', path, `ID ${id} is already used at ${allIds.get(id)}`);
    else allIds.set(id, path);
  };
  for (const scene of Object.values(project.scenes ?? {})) {
    register(scene.id, `$.scenes.${scene.id}`);
    for (const entity of Object.values(scene.entities ?? {})) register(entity.id, `$.scenes.${scene.id}.entities.${entity.id}`);
    for (const collection of Object.values(scene.collections ?? {})) register(collection.id, `$.scenes.${scene.id}.collections.${collection.id}`);
  }
  for (const type of RESOURCE_TYPES) for (const id of Object.keys(project.resources?.[type] ?? {})) register(id, `$.resources.${type}.${id}`);
  for (const id of Object.keys(project.scripts ?? {})) register(id, `$.scripts.${id}`);

  const entityCount = Object.values(project.scenes ?? {}).reduce((count, scene) => count + Object.keys(scene.entities ?? {}).length, 0);
  const collectionCount = Object.values(project.scenes ?? {}).reduce((count, scene) => count + Object.keys(scene.collections ?? {}).length, 0);
  if (entityCount > maxEntities) issue(diagnostics, 'entity_budget_exceeded', '$.scenes', `${entityCount} entities exceeds the ${maxEntities} entity limit`);
  if (collectionCount > maxCollections) issue(diagnostics, 'collection_budget_exceeded', '$.scenes', `${collectionCount} collections exceeds the ${maxCollections} collection limit`);
  return {
    valid: diagnostics.length === 0,
    diagnostics,
    budgets: { entities: entityCount, maxEntities, collections: collectionCount, maxCollections },
  };
}

export function assertValidProjectDocument(project, options) {
  const result = validateProjectDocument(project, options);
  if (!result.valid) {
    throw new StudioError('validation_failed', 'Project document is invalid', {
      diagnostics: result.diagnostics,
      budgets: result.budgets,
    });
  }
  return result;
}
