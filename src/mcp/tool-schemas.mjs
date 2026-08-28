import { z } from 'zod';
import { PROTOCOL_VERSION } from '../bridge/protocol.mjs';

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
  ]).optional(),
}).strict();

export const INSPECT_SLICES = Object.freeze([
  'summary', 'tree', 'transform', 'components', 'bounds', 'references',
]);

export const inspectSchema = z.object({
  ...connectionFields,
  ...projectFields,
  query: z.enum([
    'selector', 'sceneDigest', 'changedSinceRevision', 'unresolvedResources',
    'unusedResources', 'graphCatalog', 'playState', 'latestEvidence',
    'blenderCatalog',
  ]).default('sceneDigest'),
  selector: selectorSchema.optional(),
  include: z.array(z.enum(INSPECT_SLICES)).max(6).optional().default(['summary']),
  sinceRevision: nonNegativeInteger.optional(),
  cursor: cursor.optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
}).strict();

export const OPERATION_TYPES = Object.freeze([
  'scene.create', 'scene.patch', 'scene.delete', 'scene.setActive',
  'scene.settings.patch', 'scene.setActiveCamera',
  'entity.create', 'entity.patch', 'entity.duplicate', 'entity.reparent', 'entity.delete',
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
const operation = (name, fields) => z.object({ op: z.literal(name), ...fields }).strict();

const directOperations = [
  operation('scene.create', { scene: jsonObjectSchema, alias: alias.optional(), index: insertionIndex.optional() }),
  operation('scene.patch', { sceneId: reference, patch: jsonObjectSchema }),
  operation('scene.delete', { sceneId: reference, expectedSceneHash: hash.optional() }),
  operation('scene.setActive', { sceneId: reference }),
  operation('scene.settings.patch', { sceneId: reference, patch: jsonObjectSchema }),
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
  operation('resource.create', { resourceType, resource: jsonObjectSchema, alias: alias.optional() }),
  operation('resource.patch', { resourceType, resourceId: reference, patch: jsonObjectSchema }),
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
