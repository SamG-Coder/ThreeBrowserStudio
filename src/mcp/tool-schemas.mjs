import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PROTOCOL_VERSION } from '../bridge/protocol.mjs';
import {
  MAX_CONTROL_REQUEST_BYTES,
  MAX_INSPECT_RESPONSE_BYTES,
  MAX_OPERATIONS_PER_TRANSACTION,
} from '../core/constants.mjs';

const finite = z.number().finite().min(-1_000_000_000).max(1_000_000_000);
const nonNegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().min(1).max(160).regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)*$/);
const idempotencyKey = z.string().min(8).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const label = z.string().min(1).max(240);
const cursor = z.string().min(1).max(1024);
const vec3 = z.tuple([finite, finite, finite]);
const bounds3 = z.object({ min: vec3, max: vec3 }).strict();

export const jsonValueSchema = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  finite,
  z.string().max(1_000_000),
  z.array(jsonValueSchema).max(20_000),
  z.record(z.string().max(160), jsonValueSchema),
]));
export const jsonObjectSchema = z.record(z.string().max(160), jsonValueSchema);

// Resource payloads can contain dense indexed-mesh attributes. Their practical
// ceiling remains the one MiB control-message budget, while core geometry
// validation applies topology-specific limits after transport validation.
export const MAX_RESOURCE_ARRAY_ITEMS = 6_000_000;
export const resourceJsonValueSchema = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  finite,
  z.string().max(1_000_000),
  z.array(resourceJsonValueSchema).max(MAX_RESOURCE_ARRAY_ITEMS),
  z.record(z.string().max(160), resourceJsonValueSchema),
]));
export const resourceJsonObjectSchema = z.record(z.string().max(160), resourceJsonValueSchema);

const connectionFields = {
  protocolVersion: z.literal(PROTOCOL_VERSION).optional().default(PROTOCOL_VERSION),
  sessionId: z.string().min(1).max(128).optional(),
};

const projectFields = {
  projectId: identifier.optional(),
  sceneId: identifier.optional(),
};

const mutationFields = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  sessionId: z.string().min(1).max(128),
  projectId: identifier,
  baseRevision: nonNegativeInteger,
  idempotencyKey,
  label,
};

export const statusSchema = z.object({
  ...connectionFields,
}).strict();

const selectorSchema = z.object({
  ids: z.array(identifier).min(1).max(200).optional(),
  name: z.string().min(1).max(240).optional(),
  kind: z.string().min(1).max(80).optional(),
  tag: z.string().min(1).max(120).optional(),
  status: z.enum([
    'implemented', 'partial', 'planned', 'bake-required', 'not-applicable',
    'live-tsl', 'layout-only', 'catalogued', 'migration-required',
    'live-runtime', 'live-geometry',
  ]).optional(),
}).strict();

export const INSPECT_SLICES = Object.freeze([
  'summary', 'tree', 'transform', 'components', 'bounds', 'references',
]);

export const INSPECT_QUERIES = Object.freeze([
  'selector', 'sceneDigest', 'resourceDigest', 'changedSinceRevision',
  'unresolvedResources', 'unusedResources', 'graphCatalog', 'playState',
  'latestEvidence', 'blenderCatalog',
]);

export const inspectSchema = z.object({
  ...connectionFields,
  ...projectFields,
  query: z.enum(INSPECT_QUERIES).default('sceneDigest'),
  selector: selectorSchema.optional(),
  include: z.array(z.enum(INSPECT_SLICES)).max(6).optional().default(['summary']),
  sinceRevision: nonNegativeInteger.optional(),
  cursor: cursor.optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
}).strict();

export const OPERATION_TYPES = Object.freeze([
  'scene.create', 'scene.patch', 'scene.delete', 'scene.setActive',
  'scene.settings.patch', 'scene.rtx.patch', 'scene.setActiveCamera',
  'entity.create', 'entity.patch', 'entity.duplicate', 'entity.reparent', 'entity.delete',
  'camera.frame', 'layout.pattern', 'geometry.edit',
  'resource.create', 'resource.patch', 'resource.delete',
]);

const alias = z.string().min(2).max(65).regex(/^\$[a-z][a-z0-9_-]{0,63}$/);
const reference = z.union([identifier, alias]);
const hash = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const insertionIndex = z.number().int().min(0).max(20_000);
const resourceType = z.enum([
  'geometries', 'materials', 'textures', 'graphs', 'animations', 'prefabs', 'audio', 'assets',
  'geometry', 'material', 'texture', 'graph', 'animation', 'prefab', 'asset',
]);
export const rtxPatchSchema = z.object({
  enabled: z.boolean().optional(),
  lighting: z.boolean().optional(),
  shadows: z.boolean().optional(),
  ambientOcclusion: z.boolean().optional(),
  directionalSampleCount: z.number().int().min(1).max(64).optional(),
  aoSampleCount: z.number().int().min(1).max(64).optional(),
  directionalAngularRadius: z.number().finite().min(0).lt(Math.PI / 2).optional(),
  shadowStrength: z.number().finite().min(0).max(1).optional(),
  aoStrength: z.number().finite().min(0).max(1).optional(),
  aoRadius: z.number().finite().gt(0).max(10_000).optional(),
  maxDistance: z.number().finite().gt(0).max(1_000_000).optional(),
  rayBias: z.number().finite().gt(0).max(10_000).optional(),
}).strict().refine(value => Object.keys(value).length > 0, {
  message: 'scene.rtx.patch requires at least one setting.',
});
const layoutCount = z.number().int().min(1).max(8192);
const layoutScatterSeed = z.number().int().min(-2_147_483_648).max(2_147_483_647);
const layoutPositiveVec3 = z.tuple([
  z.number().finite().gt(0).max(1_000_000_000),
  z.number().finite().gt(0).max(1_000_000_000),
  z.number().finite().gt(0).max(1_000_000_000),
]);
const layoutGridCounts = z.tuple([layoutCount, layoutCount, layoutCount]);
const layoutPatternUnion = z.discriminatedUnion('mode', [
  z.object({
    id: identifier,
    mode: z.literal('linear'),
    count: layoutCount,
    offset: vec3,
  }).strict(),
  z.object({
    id: identifier,
    mode: z.literal('grid'),
    counts: layoutGridCounts,
    spacing: vec3,
  }).strict(),
  z.object({
    id: identifier,
    mode: z.literal('radial'),
    count: layoutCount,
    axis: z.enum(['x', 'y', 'z']),
    center: vec3,
    radius: z.number().finite().min(0).max(1_000_000_000),
    startAngle: finite,
    arc: finite,
    closed: z.boolean(),
    orientation: z.enum(['keep', 'radial', 'tangent']),
  }).strict(),
  z.object({
    id: identifier,
    mode: z.literal('scatter'),
    count: layoutCount,
    seed: layoutScatterSeed,
    bounds: bounds3,
    rotationMin: vec3.optional(),
    rotationMax: vec3.optional(),
    scaleMin: layoutPositiveVec3.optional(),
    scaleMax: layoutPositiveVec3.optional(),
  }).strict(),
]);
export const layoutPatternSchema = layoutPatternUnion.superRefine((pattern, context) => {
  if (pattern.mode === 'grid') {
    const product = pattern.counts[0] * pattern.counts[1] * pattern.counts[2];
    if (!Number.isSafeInteger(product) || product > 8192) {
      context.addIssue({
        code: 'custom',
        path: ['counts'],
        message: 'Grid count product must not exceed 8192.',
      });
    }
  }
  if (pattern.mode === 'scatter') {
    const ranges = [
      ['bounds', pattern.bounds.min, pattern.bounds.max],
      ['rotation', pattern.rotationMin ?? pattern.rotationMax ?? [0, 0, 0], pattern.rotationMax ?? pattern.rotationMin ?? [0, 0, 0]],
      ['scale', pattern.scaleMin ?? pattern.scaleMax ?? [1, 1, 1], pattern.scaleMax ?? pattern.scaleMin ?? [1, 1, 1]],
    ];
    for (const [label, minimum, maximum] of ranges) {
      minimum.forEach((value, index) => {
        if (value <= maximum[index]) return;
        context.addIssue({
          code: 'custom',
          path: label === 'bounds' ? ['bounds', 'min', index] : [`${label}Min`, index],
          message: `${label} minimum must not exceed maximum on any axis.`,
        });
      });
    }
  }
});

export const GEOMETRY_EDIT_COMMAND_TYPES = Object.freeze([
  'move', 'scale', 'rotate', 'smooth', 'recalculateNormals', 'weld', 'triangulate',
]);
export const MAX_GEOMETRY_EDIT_COMMANDS = 64;
export const MAX_GEOMETRY_EDIT_VERTEX_SELECTION = 20_000;

const geometryFinite = z.number().finite().min(-1_000_000).max(1_000_000);
const geometryVec3 = z.tuple([geometryFinite, geometryFinite, geometryFinite]);
const geometryAxis = geometryVec3.refine(
  axis => axis.some(component => component !== 0),
  { message: 'axis must not be zero.' },
);
const geometryVertexIndices = z.array(
  z.number().int().min(0).max(999_999),
).min(1).max(MAX_GEOMETRY_EDIT_VERTEX_SELECTION).refine(
  indices => new Set(indices).size === indices.length,
  { message: 'vertexIndices cannot contain duplicates.' },
);
const geometryScale = z.union([geometryFinite, geometryVec3]);
const geometrySelectedVariants = (type, fields) => z.union([
  z.object({ type: z.literal(type), vertexIndices: geometryVertexIndices, ...fields }).strict(),
  z.object({ type: z.literal(type), selection: z.literal('all'), ...fields }).strict(),
]);
const geometryMoveEdit = geometrySelectedVariants('move', { offset: geometryVec3 });
const geometryScaleEdit = geometrySelectedVariants('scale', {
  scale: geometryScale,
  pivot: geometryVec3.optional(),
});
const geometryEulerRotateEdit = geometrySelectedVariants('rotate', {
  rotation: geometryVec3,
  pivot: geometryVec3.optional(),
});
const geometryAxisRotateEdit = geometrySelectedVariants('rotate', {
  axis: geometryAxis,
  angle: geometryFinite,
  pivot: geometryVec3.optional(),
});
const geometrySmoothEdit = z.object({
  type: z.literal('smooth'),
  vertexIndices: geometryVertexIndices.optional(),
  selection: z.literal('all').optional(),
  iterations: z.number().int().min(1).max(100).optional(),
  factor: z.number().finite().min(0).max(1).optional(),
  preserveBoundary: z.boolean().optional(),
}).strict().refine(value => value.vertexIndices === undefined || value.selection === undefined, {
  message: 'smooth accepts vertexIndices or selection, not both.',
});
const geometryRecalculateNormalsEdit = z.object({
  type: z.literal('recalculateNormals'),
}).strict();
const geometryWeldEdit = z.object({
  type: z.literal('weld'),
  tolerance: z.number().finite().min(1e-9).max(1_000_000).optional(),
}).strict();
const geometryTriangulateEdit = z.object({
  type: z.literal('triangulate'),
}).strict();

export const geometryEditCommandSchema = z.union([
  geometryMoveEdit,
  geometryScaleEdit,
  geometryEulerRotateEdit,
  geometryAxisRotateEdit,
  geometrySmoothEdit,
  geometryRecalculateNormalsEdit,
  geometryWeldEdit,
  geometryTriangulateEdit,
]);
export const geometryEditsSchema = z.array(geometryEditCommandSchema)
  .min(1)
  .max(MAX_GEOMETRY_EDIT_COMMANDS);

export const cameraFrameTargetSchema = z.union([
  z.object({ targetIds: z.array(identifier).min(1).max(100) }).strict(),
  z.object({ bounds: bounds3 }).strict(),
]);
const cameraDirection = vec3.refine(
  direction => direction.some(component => component !== 0),
  { message: 'direction must not be zero.' },
);

const operation = (name, fields) => z.object({ op: z.literal(name), ...fields }).strict();

const directOperations = [
  operation('scene.create', { scene: jsonObjectSchema, alias: alias.optional(), index: insertionIndex.optional() }),
  operation('scene.patch', { sceneId: reference, patch: jsonObjectSchema }),
  operation('scene.delete', { sceneId: reference, expectedSceneHash: hash.optional() }),
  operation('scene.setActive', { sceneId: reference }),
  operation('scene.settings.patch', { sceneId: reference, patch: jsonObjectSchema }),
  operation('scene.rtx.patch', { sceneId: reference, patch: rtxPatchSchema }),
  operation('scene.setActiveCamera', { sceneId: reference, cameraId: reference.nullable() }),
  operation('entity.create', { sceneId: reference, entity: jsonObjectSchema, alias: alias.optional(), index: insertionIndex.optional() }),
  operation('entity.patch', { entityId: reference, patch: jsonObjectSchema }),
  operation('entity.duplicate', {
    entityId: reference,
    newId: reference.optional(),
    name: z.string().min(1).max(240).optional(),
    parentId: reference.nullable().optional(),
    index: insertionIndex.optional(),
    deep: z.boolean().optional().default(false),
    idMap: z.record(identifier, reference).optional(),
    alias: alias.optional(),
  }),
  operation('entity.reparent', { entityId: reference, parentId: reference.nullable(), index: insertionIndex.optional() }),
  operation('entity.delete', {
    entityId: reference,
    recursive: z.boolean().optional().default(false),
    expectedSubtreeHash: hash.optional(),
  }),
  operation('camera.frame', {
    cameraId: reference,
    target: cameraFrameTargetSchema,
    aspect: z.number().finite().min(0.1).max(10),
    padding: z.number().finite().min(1).max(10).optional().default(1.15),
    direction: cameraDirection.optional().default([0, -0.2, -1]),
    lockPreviewAspect: z.boolean().optional().default(true),
  }),
  operation('layout.pattern', { entityId: reference, pattern: layoutPatternSchema }),
  operation('geometry.edit', { resourceId: reference, edits: geometryEditsSchema }),
  operation('resource.create', { resourceType, resource: resourceJsonObjectSchema, alias: alias.optional() }),
  operation('resource.patch', { resourceType, resourceId: reference, patch: resourceJsonObjectSchema }),
  operation('resource.delete', { resourceType, resourceId: reference }),
];

export const operationSchema = z.discriminatedUnion('op', [
  ...directOperations,
]);

export const applySchema = z.object({
  ...mutationFields,
  dryRun: z.boolean().optional().default(false),
  operations: z.array(operationSchema).min(1).max(128),
}).strict();

export const validateSchema = z.object({
  ...connectionFields,
  projectId: identifier.optional(),
  scope: z.literal('project').default('project'),
  strictness: z.literal('interactive').default('interactive'),
  checks: z.array(z.enum([
    'schemas', 'references', 'hierarchy', 'graphs', 'animations', 'budgets',
  ])).max(6).optional(),
}).strict();

const frameSchema = z.object({
  targetIds: z.array(identifier).min(1).max(100).optional(),
  bounds: bounds3.optional(),
}).strict().refine(value => value.targetIds !== undefined || value.bounds !== undefined, {
  message: 'frame requires targetIds or bounds.',
});

export const renderSchema = z.object({
  ...connectionFields,
  projectId: identifier.optional(),
  cameraId: identifier.optional(),
  timelineFrame: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  frame: frameSchema.optional(),
  width: z.number().int().min(16).max(1920).optional().default(1280),
  height: z.number().int().min(16).max(1080).optional().default(720),
  passes: z.array(z.literal('beauty')).min(1).max(1).optional().default(['beauty']),
  renderer: z.literal('webgpu').optional().default('webgpu'),
}).strict();

export const historySchema = z.object({
  ...connectionFields,
  projectId: identifier.optional(),
  action: z.enum(['list', 'inspect', 'undo', 'redo']),
  transactionId: identifier.optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
  baseRevision: nonNegativeInteger.optional(),
  idempotencyKey: idempotencyKey.optional(),
  label: label.optional(),
}).strict().superRefine((value, context) => {
  if (value.action === 'inspect' && value.transactionId === undefined) {
    context.addIssue({ code: 'custom', path: ['transactionId'], message: 'transactionId is required for inspect.' });
  }
  if (value.action === 'undo' || value.action === 'redo') {
    for (const field of ['sessionId', 'projectId', 'baseRevision', 'idempotencyKey', 'label']) {
      if (value[field] === undefined) context.addIssue({ code: 'custom', path: [field], message: `${field} is required for ${value.action}.` });
    }
  }
});

export const JOB_KINDS = Object.freeze([
  'assetImport', 'textureBake', 'meshBake', 'imageToGeometry', 'lightmap',
  'projectExport', 'applicationExport',
]);

export const jobSchema = z.object({
  ...connectionFields,
}).strict();

export const projectSchema = z.object({
  ...connectionFields,
  action: z.enum(['list', 'create', 'open', 'save']),
  projectId: identifier.optional(),
  path: z.string().min(1).max(1024).optional(),
  name: z.string().min(1).max(160).optional(),
  template: z.literal('starter').optional(),
  baseRevision: nonNegativeInteger.optional(),
  idempotencyKey: idempotencyKey.optional(),
  label: label.optional(),
}).strict().superRefine((value, context) => {
  if (value.action === 'list') return;
  for (const field of ['sessionId', 'idempotencyKey', 'label']) {
    if (value[field] === undefined) context.addIssue({ code: 'custom', path: [field], message: `${field} is required for ${value.action}.` });
  }
  if (value.action === 'create' && value.path === undefined) context.addIssue({ code: 'custom', path: ['path'], message: 'path is required to create a project.' });
  if (value.action === 'open' && value.path === undefined && value.projectId === undefined) context.addIssue({ code: 'custom', path: ['path'], message: 'path or projectId is required to open a project.' });
  if (value.action === 'save' && value.projectId === undefined) context.addIssue({ code: 'custom', path: ['projectId'], message: 'projectId is required for save.' });
  if (value.action === 'save' && value.baseRevision === undefined) context.addIssue({ code: 'custom', path: ['baseRevision'], message: 'baseRevision is required for save.' });
});

export const playSchema = z.object({
  ...connectionFields,
  projectId: identifier.optional(),
  action: z.enum(['enter', 'stop', 'pause', 'resume', 'step', 'seek', 'inject', 'query']),
  baseRevision: nonNegativeInteger.optional(),
  idempotencyKey: idempotencyKey.optional(),
  label: label.optional(),
  ticks: z.number().int().min(1).max(10_000).optional().default(1),
  frame: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  inputAction: z.string().min(1).max(160).optional(),
  input: jsonObjectSchema.optional().default({}),
}).strict().superRefine((value, context) => {
  if (value.action === 'query') return;
  for (const field of ['sessionId', 'projectId', 'baseRevision', 'idempotencyKey', 'label']) {
    if (value[field] === undefined) context.addIssue({ code: 'custom', path: [field], message: `${field} is required for ${value.action}.` });
  }
  if (value.action === 'inject' && value.inputAction === undefined) context.addIssue({ code: 'custom', path: ['inputAction'], message: 'inputAction is required to inject input.' });
  if (value.action === 'seek' && value.frame === undefined) context.addIssue({ code: 'custom', path: ['frame'], message: 'frame is required to seek.' });
});

export const TOOL_SCHEMAS = Object.freeze({
  three_studio_status: statusSchema,
  three_studio_inspect: inspectSchema,
  three_studio_apply: applySchema,
  three_studio_validate: validateSchema,
  three_studio_render: renderSchema,
  three_studio_history: historySchema,
  three_studio_job: jobSchema,
  three_studio_project: projectSchema,
  three_studio_play: playSchema,
});

export const STUDIO_TOOL_NAMES = Object.freeze(Object.keys(TOOL_SCHEMAS));

export const MCP_SERVER_VERSION = '0.2.0';
export const TOOL_CONTRACT_VERSION = 'three-studio-tools/2';
const TOOL_INPUT_SCHEMAS = Object.fromEntries(
  STUDIO_TOOL_NAMES.map(name => [name, z.toJSONSchema(TOOL_SCHEMAS[name], { io: 'input' })]),
);
const TOOL_CONTRACT_LIMITS = Object.freeze({
  maxOperations: MAX_OPERATIONS_PER_TRANSACTION,
  maxControlRequestBytes: MAX_CONTROL_REQUEST_BYTES,
  maxInspectResponseBytes: MAX_INSPECT_RESPONSE_BYTES,
  maxResourceArrayItems: MAX_RESOURCE_ARRAY_ITEMS,
  maxGeometryEditCommands: MAX_GEOMETRY_EDIT_COMMANDS,
  maxGeometryEditVertexSelection: MAX_GEOMETRY_EDIT_VERTEX_SELECTION,
});
const TOOL_CONTRACT_FEATURES = Object.freeze({
  compactGeometrySelectionAll: true,
  resourceDigest: true,
});
const TOOL_CONTRACT_METADATA = Object.freeze({
  contractVersion: TOOL_CONTRACT_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  serverVersion: MCP_SERVER_VERSION,
  operations: OPERATION_TYPES,
  inspectQueries: INSPECT_QUERIES,
  inspectSlices: INSPECT_SLICES,
  limits: TOOL_CONTRACT_LIMITS,
  features: TOOL_CONTRACT_FEATURES,
});
export const TOOL_CONTRACT = Object.freeze({
  ...TOOL_CONTRACT_METADATA,
  hash: createHash('sha256').update(JSON.stringify({
    ...TOOL_CONTRACT_METADATA,
    inputSchemas: TOOL_INPUT_SCHEMAS,
  })).digest('hex'),
});
