import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PROTOCOL_VERSION } from '../bridge/protocol.mjs';
import {
  MAX_CONTROL_REQUEST_BYTES,
  MAX_INSPECT_RESPONSE_BYTES,
  MAX_MATERIAL_SLOTS_PER_MESH,
  MAX_OPERATIONS_PER_TRANSACTION,
} from '../core/constants.mjs';
import { MESH_ELEMENT_KINDS, MESH_INSPECTION_LIMITS } from '../core/mesh-inspection.mjs';
import { MAX_EXACT_ENTITY_SELECTION } from '../core/entity-selection.mjs';
import {
  EDITABLE_MESH_ATTRIBUTE_COMMAND_TYPES,
  EDITABLE_MESH_ATTRIBUTE_LIMITS,
} from '../core/editable-mesh-attributes.mjs';
import { DATA_TEXTURE_LIMITS } from '../core/image-texture.mjs';
import { MATERIAL_TEXTURE_BINDINGS } from '../core/material-textures.mjs';
import { GEOMETRY_MODIFIER_LIMITS } from '../core/geometry-modifier-evaluator.mjs';
import {
  BAKE_BOUNDARY_MODIFIER_TYPE,
  MAX_MODIFIERS_PER_ENTITY,
  normalizeModifierDocument,
} from '../core/modifier-stack.mjs';
import { BLENDER_MODIFIER_INVENTORY } from '../blender/modifier-inventory.mjs';

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
  collectionId: identifier.optional(),
  status: z.enum([
    'implemented', 'partial', 'planned', 'bake-required', 'not-applicable',
    'live-tsl', 'layout-only', 'api-only', 'catalogued', 'migration-required',
    'live-runtime', 'live-geometry',
  ]).optional(),
}).strict();

export const INSPECT_SLICES = Object.freeze([
  'summary', 'tree', 'transform', 'components', 'bounds', 'references',
]);

export const INSPECT_QUERIES = Object.freeze([
  'selector', 'sceneDigest', 'resourceDigest', 'meshElements', 'graphDigest', 'modifierDigest', 'rtxDigest', 'changedSinceRevision',
  'unresolvedResources', 'unusedResources', 'graphCatalog', 'playState',
  'latestEvidence', 'blenderCatalog', 'beautyDigest', 'projectVisibility',
]);

const inspectProbeSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  x: z.number().int().min(0).max(4095),
  y: z.number().int().min(0).max(4095),
}).strict();

const inspectEvidenceSchema = z.object({
  path: z.string().min(1).max(1024).optional(),
  comparePath: z.string().min(1).max(1024).optional(),
  objectIdPath: z.string().min(1).max(1024).optional(),
  probes: z.array(inspectProbeSchema).max(32).optional(),
  bbox: z.object({
    x0: z.number().int().min(0).max(4095),
    y0: z.number().int().min(0).max(4095),
    x1: z.number().int().min(0).max(4095),
    y1: z.number().int().min(0).max(4095),
  }).strict().optional(),
  maxChanged: z.number().int().min(1).max(32).optional(),
}).strict();

const inspectProjectionPointSchema = z.object({
  name: z.string().min(1).max(64),
  world: vec3,
}).strict();

const inspectProjectionSchema = z.object({
  cameraId: identifier.optional(),
  points: z.array(inspectProjectionPointSchema).max(32).optional(),
  entityIds: z.array(identifier).max(32).optional(),
  width: z.number().int().min(1).max(4096).optional(),
  height: z.number().int().min(1).max(4096).optional(),
  objectIdPath: z.string().min(1).max(1024).optional(),
}).strict();

const inspectMeshFilterSchema = z.object({
  min: vec3.optional(),
  max: vec3.optional(),
  yMin: finite.optional(),
  yMax: finite.optional(),
  boundary: z.boolean().optional(),
  notAdjacentTo: z.array(z.number().int().min(0).max(1_000_000)).max(64).optional(),
}).strict();

export const inspectSchema = z.object({
  ...connectionFields,
  ...projectFields,
  query: z.enum(INSPECT_QUERIES).default('sceneDigest'),
  selector: selectorSchema.optional(),
  element: z.enum(MESH_ELEMENT_KINDS).optional(),
  include: z.array(z.enum(INSPECT_SLICES)).max(6).optional().default(['summary']),
  sinceRevision: nonNegativeInteger.optional(),
  cursor: cursor.optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
  evidence: inspectEvidenceSchema.optional(),
  projection: inspectProjectionSchema.optional(),
  meshFilter: inspectMeshFilterSchema.optional(),
}).strict().superRefine((value, context) => {
  if (['meshElements', 'graphDigest', 'modifierDigest'].includes(value.query) && value.selector?.ids?.length !== 1) {
    context.addIssue({
      code: 'custom',
      path: ['selector', 'ids'],
      message: `${value.query} requires exactly one resource ID.`,
    });
  }
  if (value.element !== undefined && value.query !== 'meshElements') {
    context.addIssue({ code: 'custom', path: ['element'], message: 'element is only valid for meshElements.' });
  }
  if (value.evidence !== undefined && value.query !== 'beautyDigest') {
    context.addIssue({ code: 'custom', path: ['evidence'], message: 'evidence is only valid for beautyDigest.' });
  }
  if (value.projection !== undefined && value.query !== 'projectVisibility') {
    context.addIssue({ code: 'custom', path: ['projection'], message: 'projection is only valid for projectVisibility.' });
  }
  if (value.meshFilter !== undefined && value.query !== 'meshElements') {
    context.addIssue({ code: 'custom', path: ['meshFilter'], message: 'meshFilter is only valid for meshElements.' });
  }
  if (value.query === 'projectVisibility') {
    const pointCount = value.projection?.points?.length ?? 0;
    const entityCount = value.projection?.entityIds?.length ?? 0;
    if (pointCount === 0 && entityCount === 0) {
      context.addIssue({
        code: 'custom',
        path: ['projection'],
        message: 'projectVisibility requires projection.points or projection.entityIds.',
      });
    }
  }
});

export const OPERATION_TYPES = Object.freeze([
  'scene.create', 'scene.patch', 'scene.delete', 'scene.setActive',
  'scene.settings.patch', 'scene.rtx.patch', 'scene.setActiveCamera',
  'entity.create', 'entity.patch', 'entity.patchMany', 'entity.transformMany',
  'entity.group', 'entity.ungroup', 'entity.duplicate', 'entity.reparent', 'entity.delete',
  'collection.create', 'collection.patch', 'collection.membership.patch', 'collection.reparent', 'collection.delete',
  'camera.frame', 'layout.pattern',
  'modifier.create', 'modifier.patch', 'modifier.move', 'modifier.delete', 'modifier.stack.edit',
  'geometry.edit',
  'resource.create', 'resource.patch', 'resource.delete',
]);

const alias = z.string().min(2).max(65).regex(/^\$[a-z][a-z0-9_-]{0,63}$/);
const reference = z.union([identifier, alias]);
const hash = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const insertionIndex = z.number().int().min(0).max(20_000);
const modifierIndex = z.number().int().min(0).max(63);
const exactEntityReferences = z.array(reference).min(1).max(200).refine(
  values => new Set(values).size === values.length,
  { message: 'Entity ID lists cannot contain duplicates.' },
);
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
  z.object({
    id: identifier,
    mode: z.literal('surface'),
    count: layoutCount,
    seed: layoutScatterSeed,
    targetEntityId: reference,
    orientation: z.enum(['keep', 'normal', 'gravity']).optional(),
    normalAxis: z.enum(['x', 'y', 'z']).optional(),
    gravity: vec3.refine(axis => axis.some(component => component !== 0), { message: 'gravity must not be zero.' }).optional(),
    offset: finite.min(-1_000_000_000).max(1_000_000_000).optional(),
    minDistance: finite.min(0).max(1_000_000_000).optional(),
    rotationMin: finite.optional(),
    rotationMax: finite.optional(),
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
  if (pattern.mode === 'surface') {
    if ((pattern.rotationMin ?? pattern.rotationMax ?? 0) > (pattern.rotationMax ?? pattern.rotationMin ?? 0)) {
      context.addIssue({ code: 'custom', path: ['rotationMin'], message: 'rotationMin must not exceed rotationMax.' });
    }
    const minimum = pattern.scaleMin ?? pattern.scaleMax ?? [1, 1, 1];
    const maximum = pattern.scaleMax ?? pattern.scaleMin ?? [1, 1, 1];
    minimum.forEach((value, index) => {
      if (value > maximum[index]) context.addIssue({ code: 'custom', path: ['scaleMin', index], message: 'scale minimum must not exceed maximum.' });
    });
  }
});

const modifierFlags = {
  enabled: z.boolean().optional(),
  enabledViewport: z.boolean().optional(),
  enabledRender: z.boolean().optional(),
};
const modifierDocument = (type, fields = {}) => z.object({
  id: identifier,
  type: z.literal(type),
  ...fields,
  ...modifierFlags,
}).strict();
const patternModifierUnion = z.discriminatedUnion('mode', [
  modifierDocument('pattern', {
    mode: z.literal('linear'),
    count: layoutCount,
    offset: vec3,
  }),
  modifierDocument('pattern', {
    mode: z.literal('grid'),
    counts: layoutGridCounts,
    spacing: vec3,
  }),
  modifierDocument('pattern', {
    mode: z.literal('radial'),
    count: layoutCount,
    axis: z.enum(['x', 'y', 'z']),
    center: vec3,
    radius: z.number().finite().min(0).max(1_000_000_000),
    startAngle: finite,
    arc: finite,
    closed: z.boolean(),
    orientation: z.enum(['keep', 'radial', 'tangent']),
  }),
  modifierDocument('pattern', {
    mode: z.literal('scatter'),
    count: layoutCount,
    seed: layoutScatterSeed,
    bounds: bounds3,
    rotationMin: vec3.optional(),
    rotationMax: vec3.optional(),
    scaleMin: layoutPositiveVec3.optional(),
    scaleMax: layoutPositiveVec3.optional(),
  }),
  modifierDocument('pattern', {
    mode: z.literal('surface'),
    count: layoutCount,
    seed: layoutScatterSeed,
    targetEntityId: reference,
    orientation: z.enum(['keep', 'normal', 'gravity']).optional(),
    normalAxis: z.enum(['x', 'y', 'z']).optional(),
    gravity: vec3.refine(axis => axis.some(component => component !== 0), { message: 'gravity must not be zero.' }).optional(),
    offset: finite.min(-1_000_000_000).max(1_000_000_000).optional(),
    minDistance: finite.min(0).max(1_000_000_000).optional(),
    rotationMin: finite.optional(),
    rotationMax: finite.optional(),
    scaleMin: layoutPositiveVec3.optional(),
    scaleMax: layoutPositiveVec3.optional(),
  }),
]).superRefine((pattern, context) => {
  if (pattern.mode === 'grid') {
    const product = pattern.counts[0] * pattern.counts[1] * pattern.counts[2];
    if (!Number.isSafeInteger(product) || product > 8192) {
      context.addIssue({ code: 'custom', path: ['counts'], message: 'Grid count product must not exceed 8192.' });
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
  if (pattern.mode === 'surface') {
    if ((pattern.rotationMin ?? pattern.rotationMax ?? 0) > (pattern.rotationMax ?? pattern.rotationMin ?? 0)) {
      context.addIssue({ code: 'custom', path: ['rotationMin'], message: 'rotationMin must not exceed rotationMax.' });
    }
    const minimum = pattern.scaleMin ?? pattern.scaleMax ?? [1, 1, 1];
    const maximum = pattern.scaleMax ?? pattern.scaleMin ?? [1, 1, 1];
    minimum.forEach((value, index) => {
      if (value > maximum[index]) context.addIssue({ code: 'custom', path: ['scaleMin', index], message: 'scale minimum must not exceed maximum.' });
    });
  }
});
const recalculateNormalsField = { recalculateNormals: z.boolean().optional() };
const nonZeroThickness = z.union([
  z.number().finite().min(-10_000).negative(),
  z.number().finite().positive().max(10_000),
]).describe('Pattern modifiers are further discriminated by mode; grid products and every final instance count are bounded to 8192.');
const displacementSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('constant'),
    value: z.number().finite().min(0).max(1).optional(),
  }).strict(),
  z.object({
    type: z.literal('wave'),
    axis: vec3.refine(axis => axis.some(component => component !== 0), { message: 'axis must not be zero.' }).optional(),
    frequency: z.number().finite().min(0).max(10_000).optional(),
    phase: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
  }).strict(),
  z.object({
    type: z.literal('noise'),
    seed: layoutScatterSeed.optional(),
    frequency: z.number().finite().min(1e-6).max(10_000).optional(),
    octaves: z.number().int().min(1).max(8).optional(),
    persistence: z.number().finite().min(0).max(1).optional(),
    lacunarity: z.number().finite().min(1).max(8).optional(),
  }).strict(),
]);
const displacementDirectionSchema = z.union([
  z.enum(['normal', 'x', 'y', 'z']),
  vec3.refine(direction => direction.some(component => component !== 0), { message: 'direction must not be zero.' }),
]);
const oceanModifierFields = {
  mode: z.literal('displace'),
  seed: z.number().int().min(0).max(0x7fffffff).optional(),
  time: z.number().finite().min(0).max(1_000_000).optional(),
  timelineScale: z.number().finite().min(-64).max(64).optional(),
  spatialSize: z.number().finite().min(0.01).max(1_000_000).optional(),
  waveScale: z.number().finite().min(0).max(10_000).optional(),
  waveScaleMin: z.number().finite().min(0.001).max(1_000_000).optional(),
  windVelocity: z.number().finite().min(0).max(1_000).optional(),
  waveDirection: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
  waveAlignment: z.number().finite().min(0).max(1).optional(),
  choppiness: z.number().finite().min(0).max(10).optional(),
  damping: z.number().finite().min(0).max(1).optional(),
  depth: z.number().finite().min(0.01).max(1_000_000).optional(),
  waveCount: z.number().int().min(1).max(32).optional(),
  ...recalculateNormalsField,
};
const bakeBoundaryModifierSchema = z.object({
  id: identifier,
  type: z.literal(BAKE_BOUNDARY_MODIFIER_TYPE),
  operatorType: z.enum(BLENDER_MODIFIER_INVENTORY.entries.map(entry => entry.operatorType)),
  parameters: jsonObjectSchema.optional(),
  ...modifierFlags,
}).strict();
const decimateModifierSchema = modifierDocument('decimate', {
  ratio: z.number().finite().min(0.001).max(1).optional(),
  targetTriangles: z.number().int().min(1).max(2_000_000).optional(),
  ...recalculateNormalsField,
}).meta({
  description: 'Live decimation by either ratio or target triangle count; the two controls are mutually exclusive.',
  not: { required: ['ratio', 'targetTriangles'] },
});
export const modifierDocumentSchema = z.discriminatedUnion('type', [
  modifierDocument('array', {
    count: z.number().int().min(1).max(256),
    offset: vec3.optional(),
  }),
  modifierDocument('mirror', { axis: z.enum(['x', 'y', 'z']).optional() }),
  patternModifierUnion,
  modifierDocument('triangulate'),
  modifierDocument('weld', {
    tolerance: z.number().finite().min(1e-9).max(1_000_000).optional(),
  }),
  modifierDocument('smooth', {
    iterations: z.number().int().min(1).max(100).optional(),
    factor: z.number().finite().min(0).max(1).optional(),
    preserveBoundary: z.boolean().optional(),
    ...recalculateNormalsField,
  }),
  modifierDocument('weightedNormal', {
    weighting: z.enum(['area', 'cornerAngle', 'areaAngle']).optional(),
    influence: z.number().finite().min(0).max(1).optional(),
  }),
  modifierDocument('edgeSplit', {
    splitAngle: z.number().finite().min(0).max(Math.PI).optional(),
    ...recalculateNormalsField,
  }),
  modifierDocument('solidify', {
    thickness: nonZeroThickness.optional(),
    offset: z.number().finite().min(-1).max(1).optional(),
    ...recalculateNormalsField,
  }),
  modifierDocument('subdivision', {
    levels: z.number().int().min(1).max(6).optional(),
    scheme: z.enum(['simple', 'loop']).optional(),
    ...recalculateNormalsField,
  }),
  decimateModifierSchema,
  modifierDocument('displace', {
    source: displacementSourceSchema.optional(),
    direction: displacementDirectionSchema.optional(),
    coordinateSpace: z.literal('local').optional(),
    strength: z.number().finite().min(-10_000).max(10_000).optional(),
    midlevel: z.number().finite().min(0).max(1).optional(),
    ...recalculateNormalsField,
  }),
  modifierDocument('ocean', oceanModifierFields),
  bakeBoundaryModifierSchema,
]).superRefine((modifier, context) => {
  try {
    normalizeModifierDocument(modifier);
  } catch (error) {
    context.addIssue({ code: 'custom', message: error.message });
  }
}).describe('Strict canonical modifier document. Objects reject unknown controls; types not listed here require bakeBoundary.');

const patchable = schema => schema.nullable().optional();
const modifierPatchFlags = {
  enabled: patchable(z.boolean()),
  enabledViewport: patchable(z.boolean()),
  enabledRender: patchable(z.boolean()),
};
const modifierPatch = (target, fields) => z.object({ ...modifierPatchFlags, ...fields })
  .strict()
  .refine(value => Object.keys(value).length > 0, { message: 'modifier.patch requires at least one field.' })
  .describe(`Strict partial controls for ${target}; inspect modifierDigest before patching because id and type are immutable.`)
  .meta({ minProperties: 1 });
const decimateModifierPatchSchema = modifierPatch('decimate', {
  ratio: patchable(z.number().finite().min(0.001).max(1)),
  targetTriangles: patchable(z.number().int().min(1).max(2_000_000)),
  recalculateNormals: patchable(z.boolean()),
}).superRefine((patch, context) => {
  if (patch.ratio !== null && patch.ratio !== undefined
      && patch.targetTriangles !== null && patch.targetTriangles !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Decimate accepts ratio or targetTriangles, not both; set the old control to null when switching.',
    });
  }
}).meta({
  description: 'Strict partial controls for decimate; ratio and targetTriangles cannot both be non-null.',
  minProperties: 1,
  not: {
    required: ['ratio', 'targetTriangles'],
    properties: { ratio: { type: 'number' }, targetTriangles: { type: 'integer' } },
  },
});
export const modifierPatchSchema = z.union([
  modifierPatch('triangulate or common visibility flags on any modifier', {}),
  modifierPatch('array', { count: z.number().int().min(1).max(256).optional(), offset: patchable(vec3) }),
  modifierPatch('mirror', { axis: patchable(z.enum(['x', 'y', 'z'])) }),
  modifierPatch('pattern', {
    count: layoutCount.optional(),
    offset: vec3.optional(),
    counts: layoutGridCounts.optional(),
    spacing: vec3.optional(),
    axis: z.enum(['x', 'y', 'z']).optional(),
    center: vec3.optional(),
    radius: z.number().finite().min(0).max(1_000_000_000).optional(),
    startAngle: finite.optional(),
    arc: finite.optional(),
    closed: z.boolean().optional(),
    orientation: z.enum(['keep', 'radial', 'tangent']).optional(),
    seed: layoutScatterSeed.optional(),
    bounds: bounds3.optional(),
    rotationMin: patchable(vec3),
    rotationMax: patchable(vec3),
    scaleMin: patchable(layoutPositiveVec3),
    scaleMax: patchable(layoutPositiveVec3),
  }),
  modifierPatch('weld', { tolerance: patchable(z.number().finite().min(1e-9).max(1_000_000)) }),
  modifierPatch('smooth', {
    iterations: patchable(z.number().int().min(1).max(100)),
    factor: patchable(z.number().finite().min(0).max(1)),
    preserveBoundary: patchable(z.boolean()),
    recalculateNormals: patchable(z.boolean()),
  }),
  modifierPatch('weightedNormal', {
    weighting: patchable(z.enum(['area', 'cornerAngle', 'areaAngle'])),
    influence: patchable(z.number().finite().min(0).max(1)),
  }),
  modifierPatch('edgeSplit', {
    splitAngle: patchable(z.number().finite().min(0).max(Math.PI)),
    recalculateNormals: patchable(z.boolean()),
  }),
  modifierPatch('solidify', {
    thickness: patchable(nonZeroThickness),
    offset: patchable(z.number().finite().min(-1).max(1)),
    recalculateNormals: patchable(z.boolean()),
  }),
  modifierPatch('subdivision', {
    levels: patchable(z.number().int().min(1).max(6)),
    scheme: patchable(z.enum(['simple', 'loop'])),
    recalculateNormals: patchable(z.boolean()),
  }),
  decimateModifierPatchSchema,
  modifierPatch('displace', {
    source: patchable(displacementSourceSchema),
    direction: patchable(displacementDirectionSchema),
    coordinateSpace: patchable(z.literal('local')),
    strength: patchable(z.number().finite().min(-10_000).max(10_000)),
    midlevel: patchable(z.number().finite().min(0).max(1)),
    recalculateNormals: patchable(z.boolean()),
  }),
  modifierPatch('ocean', {
    seed: patchable(z.number().int().min(0).max(0x7fffffff)),
    time: patchable(z.number().finite().min(0).max(1_000_000)),
    timelineScale: patchable(z.number().finite().min(-64).max(64)),
    spatialSize: patchable(z.number().finite().min(0.01).max(1_000_000)),
    waveScale: patchable(z.number().finite().min(0).max(10_000)),
    waveScaleMin: patchable(z.number().finite().min(0.001).max(1_000_000)),
    windVelocity: patchable(z.number().finite().min(0).max(1_000)),
    waveDirection: patchable(z.number().finite().min(-1_000_000).max(1_000_000)),
    waveAlignment: patchable(z.number().finite().min(0).max(1)),
    choppiness: patchable(z.number().finite().min(0).max(10)),
    damping: patchable(z.number().finite().min(0).max(1)),
    depth: patchable(z.number().finite().min(0.01).max(1_000_000)),
    waveCount: patchable(z.number().int().min(1).max(32)),
    recalculateNormals: patchable(z.boolean()),
  }),
  modifierPatch('bakeBoundary', {
    operatorType: z.enum(BLENDER_MODIFIER_INVENTORY.entries.map(entry => entry.operatorType)).optional(),
    parameters: patchable(jsonObjectSchema),
  }),
]);

const modifierStackEditSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), modifier: modifierDocumentSchema, index: modifierIndex.optional() }).strict(),
  z.object({ type: z.literal('patch'), modifierId: identifier, patch: modifierPatchSchema }).strict(),
  z.object({ type: z.literal('move'), modifierId: identifier, index: modifierIndex }).strict(),
  z.object({ type: z.literal('delete'), modifierId: identifier }).strict(),
]);
export const modifierStackEditsSchema = z.array(modifierStackEditSchema).min(1).max(128);

export const GEOMETRY_EDIT_COMMAND_TYPES = Object.freeze([
  'move', 'proportionalMove', 'scale', 'rotate', 'smooth', 'recalculateNormals', 'weld', 'triangulate',
  'subdivideFaces', 'insetFaces', 'extrudeFaces', 'bevelEdges', 'deleteFaces', 'mergeVertices',
  ...EDITABLE_MESH_ATTRIBUTE_COMMAND_TYPES,
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
const geometryFaceIndices = z.array(
  z.number().int().min(0).max(999_999),
).min(1).max(MAX_GEOMETRY_EDIT_VERTEX_SELECTION).refine(
  indices => new Set(indices).size === indices.length,
  { message: 'faceIndices cannot contain duplicates.' },
);
const geometryEdges = z.array(z.tuple([
  z.number().int().min(0).max(999_999),
  z.number().int().min(0).max(999_999),
]).refine(([first, second]) => first !== second, {
  message: 'An edge cannot reference the same vertex twice.',
})).min(1).max(MAX_GEOMETRY_EDIT_VERTEX_SELECTION);
const geometryScale = z.union([geometryFinite, geometryVec3]);
const geometrySelectedVariants = (type, fields) => z.union([
  z.object({ type: z.literal(type), vertexIndices: geometryVertexIndices, ...fields }).strict(),
  z.object({ type: z.literal(type), selection: z.literal('all'), ...fields }).strict(),
]);
const geometryMoveEdit = geometrySelectedVariants('move', { offset: geometryVec3 });
const geometryProportionalMoveEdit = z.object({
  type: z.literal('proportionalMove'),
  vertexIndices: geometryVertexIndices.optional(),
  selection: z.literal('all').optional(),
  center: geometryVec3,
  radius: z.number().finite().gt(0).max(1_000_000),
  offset: geometryVec3,
  falloff: z.enum(['constant', 'linear', 'smooth', 'sharp', 'sphere']).optional(),
  axisScale: layoutPositiveVec3.optional(),
}).strict().refine(value => value.vertexIndices === undefined || value.selection === undefined, {
  message: 'proportionalMove accepts vertexIndices or selection, not both.',
});
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
const geometryFaceSelectedVariants = (type, fields = {}) => z.union([
  z.object({ type: z.literal(type), faceIndices: geometryFaceIndices, ...fields }).strict(),
  z.object({ type: z.literal(type), selection: z.literal('all'), ...fields }).strict(),
]);
const geometrySubdivideFacesEdit = geometryFaceSelectedVariants('subdivideFaces');
const geometryInsetFacesEdit = geometryFaceSelectedVariants('insetFaces', {
  factor: z.number().finite().gt(0).lt(1).optional(),
});
const geometryExtrudeFields = {
  mode: z.literal('individual').optional(),
  offset: geometryVec3.optional(),
  distance: geometryFinite.optional(),
  sideMaterialIndex: z.number().int().min(0).max(MAX_MATERIAL_SLOTS_PER_MESH - 1).optional(),
};
const geometryExtrudeFacesEdit = geometryFaceSelectedVariants('extrudeFaces', geometryExtrudeFields)
  .refine(value => value.offset === undefined || value.distance === undefined, {
    message: 'extrudeFaces accepts offset or distance, not both.',
  });
const geometryBevelFields = {
  factor: z.number().finite().gt(0).lt(0.5).optional(),
  materialIndex: z.number().int().min(0).max(MAX_MATERIAL_SLOTS_PER_MESH - 1).optional(),
};
const geometryBevelEdgesEdit = z.union([
  z.object({ type: z.literal('bevelEdges'), edges: geometryEdges, ...geometryBevelFields }).strict(),
  z.object({ type: z.literal('bevelEdges'), edgeVertexIndices: geometryEdges, ...geometryBevelFields }).strict(),
]);
const geometryDeleteFacesEdit = geometryFaceSelectedVariants('deleteFaces');
const geometryMergeVerticesEdit = geometrySelectedVariants('mergeVertices', {
  targetVertexIndex: z.number().int().min(0).max(999_999).optional(),
  position: z.enum(['average', 'target']).optional(),
});

const geometryLayerName = z.string().min(1).max(EDITABLE_MESH_ATTRIBUTE_LIMITS.maxLayerNameLength)
  .refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value), {
    message: 'Layer names cannot have surrounding whitespace or control characters.',
  });
const geometryCornerIndices = z.union([
  z.literal('all'),
  z.array(z.number().int().min(0).max(EDITABLE_MESH_ATTRIBUTE_LIMITS.maxCorners - 1))
    .min(1).max(MAX_GEOMETRY_EDIT_VERTEX_SELECTION)
    .refine(indices => new Set(indices).size === indices.length, {
      message: 'cornerIndices cannot contain duplicates.',
    }),
]);
const geometryAttributeFaceIndices = z.union([z.literal('all'), geometryFaceIndices]);
const geometryUvValue = z.number().finite()
  .min(-EDITABLE_MESH_ATTRIBUTE_LIMITS.maxUvAbsolute)
  .max(EDITABLE_MESH_ATTRIBUTE_LIMITS.maxUvAbsolute);
const geometryUvVec2 = z.tuple([geometryUvValue, geometryUvValue]);
const geometryUvScale = z.union([geometryUvValue, geometryUvVec2]);
const geometryColorValue = z.number().finite().min(0).max(1);
const geometryColorVec4 = z.tuple([
  geometryColorValue, geometryColorValue, geometryColorValue, geometryColorValue,
]);
const geometryUvValues = z.array(geometryUvValue).min(2).max(2_000_000)
  .refine(values => values.length % 2 === 0, { message: 'UV values must contain complete vec2 items.' });
const geometryColorValues = z.array(geometryColorValue).min(4).max(4_000_000)
  .refine(values => values.length % 4 === 0, { message: 'Color values must contain complete RGBA items.' });
const geometryCreateUvLayerEdit = z.object({
  type: z.literal('createUvLayer'),
  name: geometryLayerName,
  fill: geometryUvVec2.optional(),
  values: geometryUvValues.optional(),
  setActive: z.boolean().optional(),
}).strict().refine(value => value.fill === undefined || value.values === undefined, {
  message: 'createUvLayer accepts fill or values, not both.',
});
const geometryDeleteUvLayerEdit = z.object({
  type: z.literal('deleteUvLayer'),
  name: geometryLayerName,
  nextActiveLayer: geometryLayerName.nullable().optional(),
}).strict();
const geometryRenameUvLayerEdit = z.object({
  type: z.literal('renameUvLayer'), name: geometryLayerName, newName: geometryLayerName,
}).strict();
const geometrySetActiveUvLayerEdit = z.object({
  type: z.literal('setActiveUvLayer'), name: geometryLayerName.nullable(),
}).strict();
const geometrySetCornerUvsEdit = z.object({
  type: z.literal('setCornerUvs'),
  layer: geometryLayerName,
  cornerIndices: geometryCornerIndices,
  values: geometryUvValues,
}).strict().superRefine((value, context) => {
  if (Array.isArray(value.cornerIndices) && value.values.length !== value.cornerIndices.length * 2) {
    context.addIssue({ code: 'custom', path: ['values'], message: 'values must contain one vec2 per selected corner.' });
  }
});
const geometryTransformUvsEdit = z.object({
  type: z.literal('transformUvs'),
  layer: geometryLayerName,
  cornerIndices: geometryCornerIndices,
  translation: geometryUvVec2.optional(),
  scale: geometryUvScale.optional(),
  rotation: geometryFinite.optional(),
  pivot: geometryUvVec2.optional(),
}).strict().refine(value => (
  value.translation !== undefined || value.scale !== undefined || value.rotation !== undefined
), { message: 'transformUvs requires translation, scale, or rotation.' });
const geometryProjectUvsEdit = z.object({
  type: z.literal('projectUvs'),
  layer: geometryLayerName,
  cornerIndices: geometryCornerIndices,
  projection: z.enum(['planar', 'cylindrical', 'spherical']).optional(),
  axis: z.enum(['xy', 'xz', 'yz', 'x', 'y', 'z']),
  center: geometryVec3.optional(),
  scale: geometryUvScale.optional(),
  offset: geometryUvVec2.optional(),
}).strict().superRefine((value, context) => {
  const projection = value.projection ?? 'planar';
  if (projection === 'planar' && !['xy', 'xz', 'yz'].includes(value.axis)) {
    context.addIssue({ code: 'custom', path: ['axis'], message: 'Planar projection requires xy, xz, or yz.' });
  }
  if (projection !== 'planar' && !['x', 'y', 'z'].includes(value.axis)) {
    context.addIssue({ code: 'custom', path: ['axis'], message: 'Curved projection requires x, y, or z.' });
  }
});
const geometryCreateColorLayerEdit = z.object({
  type: z.literal('createColorLayer'),
  name: geometryLayerName,
  fill: geometryColorVec4.optional(),
  values: geometryColorValues.optional(),
  setActive: z.boolean().optional(),
}).strict().refine(value => value.fill === undefined || value.values === undefined, {
  message: 'createColorLayer accepts fill or values, not both.',
});
const geometryDeleteColorLayerEdit = z.object({
  type: z.literal('deleteColorLayer'),
  name: geometryLayerName,
  nextActiveLayer: geometryLayerName.nullable().optional(),
}).strict();
const geometryRenameColorLayerEdit = z.object({
  type: z.literal('renameColorLayer'), name: geometryLayerName, newName: geometryLayerName,
}).strict();
const geometrySetActiveColorLayerEdit = z.object({
  type: z.literal('setActiveColorLayer'), name: geometryLayerName.nullable(),
}).strict();
const geometrySetCornerColorsEdit = z.object({
  type: z.literal('setCornerColors'),
  layer: geometryLayerName,
  cornerIndices: geometryCornerIndices,
  values: geometryColorValues,
}).strict().superRefine((value, context) => {
  if (Array.isArray(value.cornerIndices) && value.values.length !== value.cornerIndices.length * 4) {
    context.addIssue({ code: 'custom', path: ['values'], message: 'values must contain one RGBA value per selected corner.' });
  }
});
const geometryAssignFaceMaterialsEdit = z.object({
  type: z.literal('assignFaceMaterials'),
  faceIndices: geometryAttributeFaceIndices,
  materialIndex: z.number().int().min(0).max(MAX_MATERIAL_SLOTS_PER_MESH - 1).optional(),
  materialIndices: z.array(
    z.number().int().min(0).max(MAX_MATERIAL_SLOTS_PER_MESH - 1),
  ).min(1).max(MAX_GEOMETRY_EDIT_VERTEX_SELECTION).optional(),
}).strict().superRefine((value, context) => {
  if ((value.materialIndex === undefined) === (value.materialIndices === undefined)) {
    context.addIssue({ code: 'custom', message: 'assignFaceMaterials requires exactly one of materialIndex or materialIndices.' });
  }
  if (Array.isArray(value.faceIndices) && value.materialIndices !== undefined
      && value.materialIndices.length !== value.faceIndices.length) {
    context.addIssue({ code: 'custom', path: ['materialIndices'], message: 'materialIndices must contain one slot per selected face.' });
  }
});
const geometryAttributeEdges = z.union([z.literal('all'), geometryEdges]);
const geometrySetSharpEdgesEdit = z.object({
  type: z.literal('setSharpEdges'), edges: geometryAttributeEdges, sharp: z.boolean(),
}).strict();
const geometrySetEdgeCreasesEdit = z.object({
  type: z.literal('setEdgeCreases'),
  edges: geometryAttributeEdges,
  weight: z.number().finite().min(0).max(1),
}).strict();
const geometryRemoveEdgeCreasesEdit = z.object({
  type: z.literal('removeEdgeCreases'), edges: geometryAttributeEdges,
}).strict();

export const geometryEditCommandSchema = z.union([
  geometryMoveEdit,
  geometryProportionalMoveEdit,
  geometryScaleEdit,
  geometryEulerRotateEdit,
  geometryAxisRotateEdit,
  geometrySmoothEdit,
  geometryRecalculateNormalsEdit,
  geometryWeldEdit,
  geometryTriangulateEdit,
  geometrySubdivideFacesEdit,
  geometryInsetFacesEdit,
  geometryExtrudeFacesEdit,
  geometryBevelEdgesEdit,
  geometryDeleteFacesEdit,
  geometryMergeVerticesEdit,
  geometryCreateUvLayerEdit,
  geometryDeleteUvLayerEdit,
  geometryRenameUvLayerEdit,
  geometrySetActiveUvLayerEdit,
  geometrySetCornerUvsEdit,
  geometryTransformUvsEdit,
  geometryProjectUvsEdit,
  geometryCreateColorLayerEdit,
  geometryDeleteColorLayerEdit,
  geometryRenameColorLayerEdit,
  geometrySetActiveColorLayerEdit,
  geometrySetCornerColorsEdit,
  geometryAssignFaceMaterialsEdit,
  geometrySetSharpEdgesEdit,
  geometrySetEdgeCreasesEdit,
  geometryRemoveEdgeCreasesEdit,
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

const transformManyPatch = z.object({
  position: vec3.optional(),
  rotation: vec3.optional(),
  scale: vec3.optional(),
}).strict().refine(value => Object.keys(value).length > 0, {
  message: 'entity.transformMany requires at least one transform field.',
});

const optionalExactEntityReferences = z.array(reference).max(200).refine(
  values => new Set(values).size === values.length,
  { message: 'Entity ID lists cannot contain duplicates.' },
).optional();

const collectionMembershipOperation = operation('collection.membership.patch', {
  collectionId: reference,
  addEntityIds: optionalExactEntityReferences,
  removeEntityIds: optionalExactEntityReferences,
  expectedMembershipHash: hash,
}).superRefine((value, context) => {
  const added = value.addEntityIds ?? [];
  const removed = value.removeEntityIds ?? [];
  if (added.length + removed.length === 0) {
    context.addIssue({ code: 'custom', message: 'At least one entity must be added or removed.' });
  }
  if (added.length + removed.length > 200) {
    context.addIssue({ code: 'custom', message: 'A membership patch may target at most 200 entities.' });
  }
  const removedSet = new Set(removed);
  if (added.some(id => removedSet.has(id))) {
    context.addIssue({ code: 'custom', message: 'An entity cannot be added and removed in the same patch.' });
  }
});

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
  operation('entity.patchMany', { entityIds: exactEntityReferences, patch: jsonObjectSchema, expectedEntitySetHash: hash }),
  operation('entity.transformMany', {
    entityIds: exactEntityReferences,
    mode: z.enum(['set', 'delta']),
    transform: transformManyPatch,
    expectedEntitySetHash: hash,
  }),
  operation('entity.group', {
    sceneId: reference,
    entityIds: exactEntityReferences,
    group: jsonObjectSchema,
    expectedEntitySetHash: hash,
    alias: alias.optional(),
    index: insertionIndex.optional(),
  }),
  operation('entity.ungroup', { entityId: reference, expectedSubtreeHash: hash }),
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
  operation('collection.create', { sceneId: reference, collection: jsonObjectSchema, alias: alias.optional(), index: insertionIndex.optional() }),
  operation('collection.patch', { collectionId: reference, patch: jsonObjectSchema }),
  collectionMembershipOperation,
  operation('collection.reparent', { collectionId: reference, parentId: reference.nullable(), index: insertionIndex.optional() }),
  operation('collection.delete', {
    collectionId: reference,
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
  operation('modifier.create', {
    entityId: reference, modifier: modifierDocumentSchema, expectedStackHash: hash, index: modifierIndex.optional(),
  }),
  operation('modifier.patch', {
    entityId: reference, modifierId: identifier, patch: modifierPatchSchema, expectedStackHash: hash,
  }),
  operation('modifier.move', {
    entityId: reference, modifierId: identifier, index: modifierIndex, expectedStackHash: hash,
  }),
  operation('modifier.delete', {
    entityId: reference, modifierId: identifier, expectedStackHash: hash,
  }),
  operation('modifier.stack.edit', {
    entityId: reference, changes: modifierStackEditsSchema, expectedStackHash: hash,
  }),
  operation('geometry.edit', { resourceId: reference, edits: geometryEditsSchema, expectedTopologyHash: hash.optional() }),
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
  previewEvidence: z.object({
    width: z.number().int().min(16).max(1920).optional().default(960),
    height: z.number().int().min(16).max(1080).optional().default(720),
  }).strict().optional(),
  operations: z.array(operationSchema).min(1).max(128),
}).strict().refine(value => value.previewEvidence === undefined || value.dryRun === true, {
  message: 'previewEvidence requires dryRun true.',
  path: ['previewEvidence'],
});

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
  passes: z.array(z.enum(['beauty', 'raster', 'objectId', 'albedo', 'roughness', 'normal', 'uv']))
    .min(1).max(7).optional().default(['beauty']),
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
  action: z.literal('textureBake'),
  projectId: identifier,
  graphId: identifier,
  textureId: identifier,
  output: z.enum(['albedo', 'roughness', 'normal']),
  resolution: z.tuple([
    z.number().int().min(1).max(512),
    z.number().int().min(1).max(512),
  ]),
  name: z.string().min(1).max(160).optional(),
  baseRevision: nonNegativeInteger,
  idempotencyKey,
  label,
}).strict().refine(value => {
  const channels = value.output === 'roughness' ? 1 : 4;
  return value.resolution[0] * value.resolution[1] * channels <= DATA_TEXTURE_LIMITS.maxEncodedBytes;
}, {
  message: 'Texture bake decoded output exceeds the canonical encoded-source byte budget.',
  path: ['resolution'],
});

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

export const MCP_SERVER_VERSION = '0.3.0';
export const TOOL_CONTRACT_VERSION = 'three-studio-tools/8';
export const TOOL_INPUT_SCHEMAS = Object.freeze(Object.fromEntries(
  STUDIO_TOOL_NAMES.map(name => [name, z.toJSONSchema(TOOL_SCHEMAS[name], { io: 'input' })]),
));
const TOOL_CONTRACT_LIMITS = Object.freeze({
  maxOperations: MAX_OPERATIONS_PER_TRANSACTION,
  maxControlRequestBytes: MAX_CONTROL_REQUEST_BYTES,
  maxInspectResponseBytes: MAX_INSPECT_RESPONSE_BYTES,
  maxResourceArrayItems: MAX_RESOURCE_ARRAY_ITEMS,
  maxGeometryEditCommands: MAX_GEOMETRY_EDIT_COMMANDS,
  maxGeometryEditVertexSelection: MAX_GEOMETRY_EDIT_VERTEX_SELECTION,
  maxMeshElementsPerPage: MESH_INSPECTION_LIMITS.maxElementsPerPage,
  maxMeshElementAdjacency: MESH_INSPECTION_LIMITS.maxAdjacencyPerElement,
  maxDerivedMeshEdges: MESH_INSPECTION_LIMITS.maxDerivedEdges,
  maxExactEntitySelection: MAX_EXACT_ENTITY_SELECTION,
  maxEditableMeshAttributeLayers: EDITABLE_MESH_ATTRIBUTE_LIMITS.maxLayersPerDomain,
  maxDataTextureDimension: DATA_TEXTURE_LIMITS.maxDimension,
  maxDataTexturePixels: DATA_TEXTURE_LIMITS.maxPixels,
  maxDataTextureNumericBytes: DATA_TEXTURE_LIMITS.maxNumericBytes,
  maxDataTextureEncodedBytes: DATA_TEXTURE_LIMITS.maxEncodedBytes,
  maxDataTextureBaseLevelGpuBytes: DATA_TEXTURE_LIMITS.maxBaseLevelGpuBytes,
  maxDataTextureGpuBytes: DATA_TEXTURE_LIMITS.maxGpuBytes,
  maxDataTextureAnisotropy: DATA_TEXTURE_LIMITS.maxAnisotropy,
  maxProjectTextureDecodedBytes: DATA_TEXTURE_LIMITS.maxProjectDecodedBytes,
  maxProjectTextureSerializedBytes: DATA_TEXTURE_LIMITS.maxProjectSerializedBytes,
});
const TOOL_CONTRACT_FEATURES = Object.freeze({
  compactGeometrySelectionAll: true,
  editableMeshUvEditing: true,
  editableMeshColorEditing: true,
  editableMeshFaceMaterialEditing: true,
  editableMeshEdgeAttributeEditing: true,
  editableMeshViewportLayers: 'active-only',
  editableMeshEdgeCreaseViewport: 'storage-editing-only',
  boundedDataTextures: true,
  dataTextureAuthoringInStatus: true,
  dataTextureSourceEncodings: Object.freeze(['numeric-bytes', 'base64']),
  dataTextureGraphSamplerNode: 'texture.sample2d',
  dataTextureUvLayer: 'active-only-channel-0',
  dataTextureLegacyPlaceholders: 'preserved-not-live-raster',
  dataTextureDirectGraphOverlap: 'rejected',
  materialTextureSlots: Object.freeze(MATERIAL_TEXTURE_BINDINGS.map(binding => binding.idKey)),
  rasterTexturesInRtxHitShading: false,
  resourceDigest: true,
  meshElements: true,
  meshElementFilters: true,
  graphDigest: true,
  graphSocketDigest: true,
  graphSocketLiveFlags: true,
  graphNodeInputPatch: true,
  applyPixelForecast: true,
  beautyDigest: true,
  objectIdPass: true,
  materialDiagnosticPasses: Object.freeze(['raster', 'albedo', 'roughness', 'normal', 'uv']),
  proceduralTextureBakeJob: true,
  dryRunCandidateEvidence: true,
  beautyProbeEntityId: true,
  projectVisibility: true,
  projectVisibilityOcclusion: true,
  compileHeavyRpcTimeoutMs: 120_000,
  editableMeshRecalculateNormals: true,
  editableMeshLiveGeometryModifiers: Object.freeze([
    'triangulate', 'smooth', 'weightedNormal', 'displace', 'ocean', 'edgeSplit',
  ]),
  timelineGeometryModifiers: Object.freeze(['ocean']),
  maxTimelineGeometrySamples: GEOMETRY_MODIFIER_LIMITS.maxOceanTimelineSamples,
  dynamicRtxGeometry: 'excluded-from-static-scene',
  principledSpecularAnisotropyIridescence: true,
  modifierDigestGroups: true,
  rtxDigest: true,
  exactBulkEntityEditing: true,
  transformGrouping: true,
  organizationalCollections: true,
  liveSchemaRefresh: true,
  viewportReviewMode: true,
  overlayInvalidation: true,
  studioSidePanel: true,
});
const TOOL_CONTRACT_SUMMARY_FIELDS = Object.freeze({
  contractVersion: TOOL_CONTRACT_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  serverVersion: MCP_SERVER_VERSION,
  operations: OPERATION_TYPES,
  inspectQueries: INSPECT_QUERIES,
  inspectSlices: INSPECT_SLICES,
  limits: TOOL_CONTRACT_LIMITS,
  features: TOOL_CONTRACT_FEATURES,
});
const TOOL_CONTRACT_METADATA = Object.freeze({
  ...TOOL_CONTRACT_SUMMARY_FIELDS,
  inputSchemas: TOOL_INPUT_SCHEMAS,
});
export function computeToolContractHash(contract) {
  const { hash: _ignored, ...metadata } = contract ?? {};
  return createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
}
export const TOOL_CONTRACT = Object.freeze({
  ...TOOL_CONTRACT_METADATA,
  hash: computeToolContractHash(TOOL_CONTRACT_METADATA),
});
export const TOOL_CONTRACT_SUMMARY = Object.freeze({
  ...TOOL_CONTRACT_SUMMARY_FIELDS,
  hash: TOOL_CONTRACT.hash,
});
