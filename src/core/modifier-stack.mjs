import { BLENDER_MODIFIER_INVENTORY } from '../blender/modifier-inventory.mjs';
import { StudioError } from './errors.mjs';
import { GEOMETRY_MODIFIER_TYPES } from './geometry-modifier-evaluator.mjs';
import { assertStableId } from './ids.mjs';
import { normalizeLayoutPattern } from './layout-patterns.mjs';
import {
  assertJsonValue,
  cloneJson,
  contentHash,
  isPlainRecord,
  stableStringify,
} from './util.mjs';

export const MAX_MODIFIERS_PER_ENTITY = 64;
export const MAX_MODIFIER_DOCUMENT_BYTES = 32 * 1024;
export const MAX_BAKE_BOUNDARY_PARAMETER_BYTES = 24 * 1024;
export const LIVE_INSTANCE_MODIFIER_TYPES = Object.freeze(['array', 'mirror', 'pattern']);
export const LIVE_EDITABLE_MESH_GEOMETRY_MODIFIERS = Object.freeze([
  'triangulate', 'smooth', 'weightedNormal', 'displace', 'ocean', 'edgeSplit',
  'simpleDeform', 'solidify', 'subdivision',
]);
const BLOCKED_EDITABLE_MESH_GEOMETRY_MODIFIERS = new Set([
  'weld', 'decimate',
]);
export const BAKE_BOUNDARY_MODIFIER_TYPE = 'bakeBoundary';
export const AUTHORABLE_MODIFIER_TYPES = Object.freeze([
  ...LIVE_INSTANCE_MODIFIER_TYPES,
  ...GEOMETRY_MODIFIER_TYPES,
  BAKE_BOUNDARY_MODIFIER_TYPE,
]);

const AUTHORABLE_TYPE_SET = new Set(AUTHORABLE_MODIFIER_TYPES);
const GEOMETRY_TYPE_SET = new Set(GEOMETRY_MODIFIER_TYPES);
const COMMON_KEYS = new Set(['id', 'type', 'enabled', 'enabledViewport', 'enabledRender']);
const GEOMETRY_KEYS = Object.freeze({
  triangulate: [],
  weld: ['tolerance'],
  smooth: ['iterations', 'factor', 'preserveBoundary', 'recalculateNormals'],
  weightedNormal: ['weighting', 'influence'],
  edgeSplit: ['splitAngle', 'recalculateNormals'],
  solidify: ['thickness', 'offset', 'recalculateNormals'],
  subdivision: ['levels', 'scheme', 'recalculateNormals'],
  decimate: ['ratio', 'targetTriangles', 'recalculateNormals'],
  displace: ['source', 'direction', 'coordinateSpace', 'strength', 'midlevel', 'recalculateNormals'],
  simpleDeform: ['mode', 'axis', 'factor', 'origin', 'recalculateNormals'],
  ocean: [
    'mode', 'seed', 'time', 'timelineScale', 'spatialSize', 'waveScale',
    'waveScaleMin', 'windVelocity', 'waveDirection', 'waveAlignment',
    'choppiness', 'damping', 'depth', 'waveCount', 'recalculateNormals',
  ],
});

export const LIVE_GEOMETRY_OPERATOR_TYPES = Object.freeze({
  triangulate: 'TRIANGULATE',
  weld: 'WELD',
  smooth: 'SMOOTH',
  weightedNormal: 'WEIGHTED_NORMAL',
  edgeSplit: 'EDGE_SPLIT',
  solidify: 'SOLIDIFY',
  subdivision: 'SUBSURF',
  decimate: 'DECIMATE',
  displace: 'DISPLACE',
  simpleDeform: 'SIMPLE_DEFORM',
  ocean: 'OCEAN',
});

function fail(code, message, modifier, details = {}) {
  throw new StudioError(code, message, {
    modifierId: modifier?.id,
    modifierType: modifier?.type,
    ...details,
  });
}

function byteLength(value) {
  return new TextEncoder().encode(stableStringify(value)).byteLength;
}

function assertKnownKeys(modifier, extraKeys) {
  const allowed = new Set([...COMMON_KEYS, ...extraKeys]);
  for (const key of Object.keys(modifier)) {
    if (!allowed.has(key)) {
      fail('unknown_modifier_property', `Modifier ${modifier.id} (${modifier.type}) contains unknown property ${key}.`, modifier, {
        key,
        allowed: [...allowed].sort(),
      });
    }
  }
}

function optionalFinite(modifier, key, minimum, maximum, { nonZero = false } = {}) {
  if (modifier[key] === undefined) return;
  const value = modifier[key];
  if (!Number.isFinite(value) || value < minimum || value > maximum || (nonZero && value === 0)) {
    fail('invalid_geometry_modifier', `${key} must be a finite number from ${minimum} to ${maximum}${nonZero ? ' and must not be zero' : ''}.`, modifier, {
      key, value, minimum, maximum,
    });
  }
}

function optionalInteger(modifier, key, minimum, maximum) {
  if (modifier[key] === undefined) return;
  const value = modifier[key];
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail('invalid_geometry_modifier', `${key} must be an integer from ${minimum} to ${maximum}.`, modifier, {
      key, value, minimum, maximum,
    });
  }
}

function optionalBoolean(modifier, key) {
  if (modifier[key] !== undefined && typeof modifier[key] !== 'boolean') {
    fail('invalid_geometry_modifier', `${key} must be boolean when provided.`, modifier, { key });
  }
}

function vector3(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

function validateDisplacementSource(source, modifier) {
  if (source === undefined) return;
  if (!isPlainRecord(source)) fail('invalid_geometry_modifier', 'source must be an object.', modifier);
  const sourceKeys = {
    constant: new Set(['type', 'value']),
    wave: new Set(['type', 'axis', 'frequency', 'phase']),
    noise: new Set(['type', 'seed', 'frequency', 'octaves', 'persistence', 'lacunarity']),
  };
  const allowed = sourceKeys[source.type];
  if (!allowed) fail('invalid_geometry_modifier', 'source.type must be constant, wave, or noise.', modifier, { sourceType: source.type });
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) fail('unknown_modifier_property', `Displacement source contains unknown property ${key}.`, modifier, { key });
  }
  const finite = (key, minimum, maximum) => {
    if (source[key] !== undefined && (!Number.isFinite(source[key]) || source[key] < minimum || source[key] > maximum)) {
      fail('invalid_geometry_modifier', `source.${key} must be from ${minimum} to ${maximum}.`, modifier, { key, value: source[key] });
    }
  };
  if (source.type === 'constant') finite('value', 0, 1);
  if (source.type === 'wave') {
    if (source.axis !== undefined && !vector3(source.axis)) fail('invalid_geometry_modifier', 'source.axis must contain three finite numbers.', modifier);
    if (source.axis?.every(value => value === 0)) fail('invalid_geometry_modifier', 'source.axis must not be zero.', modifier);
    finite('frequency', 0, 10_000);
    finite('phase', -1_000_000, 1_000_000);
  }
  if (source.type === 'noise') {
    if (source.seed !== undefined && (!Number.isInteger(source.seed) || source.seed < -0x80000000 || source.seed > 0x7fffffff)) {
      fail('invalid_geometry_modifier', 'source.seed must be a signed 32-bit integer.', modifier);
    }
    finite('frequency', 1e-6, 10_000);
    if (source.octaves !== undefined && (!Number.isInteger(source.octaves) || source.octaves < 1 || source.octaves > 8)) {
      fail('invalid_geometry_modifier', 'source.octaves must be an integer from 1 to 8.', modifier);
    }
    finite('persistence', 0, 1);
    finite('lacunarity', 1, 8);
  }
}

function validateGeometryModifier(modifier) {
  assertKnownKeys(modifier, GEOMETRY_KEYS[modifier.type]);
  optionalBoolean(modifier, 'recalculateNormals');
  if (modifier.type === 'weld') optionalFinite(modifier, 'tolerance', 1e-9, 1_000_000);
  if (modifier.type === 'smooth') {
    optionalInteger(modifier, 'iterations', 1, 100);
    optionalFinite(modifier, 'factor', 0, 1);
    optionalBoolean(modifier, 'preserveBoundary');
  }
  if (modifier.type === 'weightedNormal') {
    if (modifier.weighting !== undefined && !['area', 'cornerAngle', 'areaAngle'].includes(modifier.weighting)) {
      fail('invalid_geometry_modifier', 'weighting must be area, cornerAngle, or areaAngle.', modifier);
    }
    optionalFinite(modifier, 'influence', 0, 1);
  }
  if (modifier.type === 'edgeSplit') optionalFinite(modifier, 'splitAngle', 0, Math.PI);
  if (modifier.type === 'solidify') {
    optionalFinite(modifier, 'thickness', -10_000, 10_000, { nonZero: true });
    optionalFinite(modifier, 'offset', -1, 1);
  }
  if (modifier.type === 'subdivision') {
    optionalInteger(modifier, 'levels', 1, 6);
    if (modifier.scheme !== undefined && !['simple', 'loop'].includes(modifier.scheme)) {
      fail('invalid_geometry_modifier', 'scheme must be simple or loop.', modifier);
    }
  }
  if (modifier.type === 'decimate') {
    optionalFinite(modifier, 'ratio', 0.001, 1);
    optionalInteger(modifier, 'targetTriangles', 1, 2_000_000);
    if (modifier.ratio !== undefined && modifier.targetTriangles !== undefined) {
      fail('invalid_geometry_modifier', 'Decimate accepts ratio or targetTriangles, not both.', modifier);
    }
  }
  if (modifier.type === 'displace') {
    validateDisplacementSource(modifier.source, modifier);
    if (modifier.direction !== undefined
      && !['normal', 'x', 'y', 'z'].includes(modifier.direction)
      && !vector3(modifier.direction)) {
      fail('invalid_geometry_modifier', 'direction must be normal, x, y, z, or a three-number vector.', modifier);
    }
    if (Array.isArray(modifier.direction) && modifier.direction.every(value => value === 0)) {
      fail('invalid_geometry_modifier', 'direction vector must not be zero.', modifier);
    }
    if (modifier.coordinateSpace !== undefined && modifier.coordinateSpace !== 'local') {
      fail('invalid_geometry_modifier', 'coordinateSpace must be local.', modifier);
    }
    optionalFinite(modifier, 'strength', -10_000, 10_000);
    optionalFinite(modifier, 'midlevel', 0, 1);
  }
  if (modifier.type === 'simpleDeform') {
    if (modifier.mode !== undefined && !['bend', 'twist', 'taper', 'stretch'].includes(modifier.mode)) {
      fail('invalid_geometry_modifier', 'mode must be bend, twist, taper, or stretch.', modifier);
    }
    if (modifier.axis !== undefined && !['x', 'y', 'z'].includes(modifier.axis)) {
      fail('invalid_geometry_modifier', 'axis must be x, y, or z.', modifier);
    }
    optionalFinite(modifier, 'factor', -1000, 1000);
    if (modifier.origin !== undefined && !vector3(modifier.origin)) {
      fail('invalid_geometry_modifier', 'origin must contain three finite numbers.', modifier);
    }
  }
  if (modifier.type === 'ocean') {
    if (modifier.mode !== 'displace') {
      fail(
        'invalid_geometry_modifier',
        "Ocean mode must be 'displace'; generated grids, caches, foam, and spray are not live.",
        modifier,
      );
    }
    optionalInteger(modifier, 'seed', 0, 0x7fffffff);
    optionalFinite(modifier, 'time', 0, 1_000_000);
    optionalFinite(modifier, 'timelineScale', -64, 64);
    optionalFinite(modifier, 'spatialSize', 0.01, 1_000_000);
    optionalFinite(modifier, 'waveScale', 0, 10_000);
    optionalFinite(modifier, 'waveScaleMin', 0.001, 1_000_000);
    optionalFinite(modifier, 'windVelocity', 0, 1_000);
    optionalFinite(modifier, 'waveDirection', -1_000_000, 1_000_000);
    optionalFinite(modifier, 'waveAlignment', 0, 1);
    optionalFinite(modifier, 'choppiness', 0, 10);
    optionalFinite(modifier, 'damping', 0, 1);
    optionalFinite(modifier, 'depth', 0.01, 1_000_000);
    optionalInteger(modifier, 'waveCount', 1, 32);
    const spatialSize = modifier.spatialSize ?? 50;
    const waveScaleMin = modifier.waveScaleMin ?? 0.01;
    if (waveScaleMin > spatialSize) {
      fail('invalid_geometry_modifier', 'waveScaleMin must not exceed spatialSize.', modifier, {
        waveScaleMin,
        spatialSize,
      });
    }
  }
}

function validateLiveInstanceModifier(modifier) {
  if (modifier.type === 'array') {
    assertKnownKeys(modifier, ['count', 'offset']);
    if (!Number.isInteger(modifier.count) || modifier.count < 1 || modifier.count > 256) {
      fail('invalid_array_count', 'Array count must be an integer from 1 to 256.', modifier);
    }
    if (modifier.offset !== undefined && !vector3(modifier.offset)) {
      fail('invalid_array_offset', 'Array offset must contain three finite numbers.', modifier);
    }
  } else if (modifier.type === 'mirror') {
    assertKnownKeys(modifier, ['axis']);
    if (modifier.axis !== undefined && !['x', 'y', 'z'].includes(modifier.axis)) {
      fail('invalid_mirror_axis', 'Mirror axis must be x, y, or z.', modifier);
    }
  } else {
    normalizeLayoutPattern(modifier, { modifier: true });
  }
}

function validateBakeBoundary(modifier) {
  assertKnownKeys(modifier, ['operatorType', 'parameters']);
  if (typeof modifier.operatorType !== 'string' || !Object.hasOwn(BLENDER_MODIFIER_INVENTORY.byType, modifier.operatorType)) {
    fail('unknown_blender_modifier_type', 'bakeBoundary.operatorType must be one of the 83 Blender modifier operator types.', modifier, {
      operatorType: modifier.operatorType,
    });
  }
  if (modifier.parameters !== undefined && !isPlainRecord(modifier.parameters)) {
    fail('invalid_bake_boundary_parameters', 'bakeBoundary.parameters must be a JSON object when provided.', modifier);
  }
  if (modifier.parameters !== undefined && byteLength(modifier.parameters) > MAX_BAKE_BOUNDARY_PARAMETER_BYTES) {
    fail('modifier_budget_exceeded', `bakeBoundary.parameters exceeds ${MAX_BAKE_BOUNDARY_PARAMETER_BYTES} bytes.`, modifier, {
      byteLength: byteLength(modifier.parameters),
      maximum: MAX_BAKE_BOUNDARY_PARAMETER_BYTES,
    });
  }
}

export function classifyModifierExecution(modifierOrType) {
  const type = typeof modifierOrType === 'string' ? modifierOrType : modifierOrType?.type;
  if (LIVE_INSTANCE_MODIFIER_TYPES.includes(type)) return 'live-runtime';
  if (GEOMETRY_TYPE_SET.has(type)) return 'live-geometry';
  return 'bake-required';
}

export function modifierBlenderInventoryEntry(modifier) {
  const operatorType = modifier.type === BAKE_BOUNDARY_MODIFIER_TYPE
    ? modifier.operatorType
    : LIVE_GEOMETRY_OPERATOR_TYPES[modifier.type]
      ?? ({ array: 'ARRAY', mirror: 'MIRROR' })[modifier.type];
  return operatorType ? BLENDER_MODIFIER_INVENTORY.byType[operatorType] ?? null : null;
}

export function normalizeModifierDocument(input, { allowLegacyUnknown = false } = {}) {
  if (!isPlainRecord(input)) throw new StudioError('invalid_modifier', 'Modifier must be an object.');
  assertJsonValue(input, 'modifier');
  const modifier = cloneJson(input);
  modifier.id = assertStableId(modifier.id, 'modifier.id');
  if (typeof modifier.type !== 'string' || modifier.type.length === 0) {
    throw new StudioError('invalid_modifier_type', 'Modifier type is required.', {
      modifierId: modifier.id,
      type: modifier.type,
    });
  }
  const isLegacyUnknown = !AUTHORABLE_TYPE_SET.has(modifier.type);
  if (isLegacyUnknown && !allowLegacyUnknown) {
    throw new StudioError('unsupported_modifier_type', `Modifier type must be one of: ${AUTHORABLE_MODIFIER_TYPES.join(', ')}. Use bakeBoundary with a validated Blender operatorType for unsupported Blender semantics.`, {
      modifierId: modifier.id,
      type: modifier.type,
      supportedTypes: AUTHORABLE_MODIFIER_TYPES,
    });
  }
  for (const key of ['enabled', 'enabledViewport', 'enabledRender']) {
    if (modifier[key] !== undefined && typeof modifier[key] !== 'boolean') {
      throw new StudioError('invalid_modifier_enabled', `${key} must be boolean when provided.`, {
        modifierId: modifier.id,
        key,
      });
    }
  }
  if (GEOMETRY_TYPE_SET.has(modifier.type)) validateGeometryModifier(modifier);
  else if (LIVE_INSTANCE_MODIFIER_TYPES.includes(modifier.type)) validateLiveInstanceModifier(modifier);
  else if (!isLegacyUnknown) validateBakeBoundary(modifier);
  const documentBytes = byteLength(modifier);
  if (documentBytes > MAX_MODIFIER_DOCUMENT_BYTES) {
    fail('modifier_budget_exceeded', `Modifier document exceeds ${MAX_MODIFIER_DOCUMENT_BYTES} bytes.`, modifier, {
      byteLength: documentBytes,
      maximum: MAX_MODIFIER_DOCUMENT_BYTES,
    });
  }
  return modifier;
}

export function normalizedModifierStack(entity, { allowLegacyUnknown = true } = {}) {
  const source = entity?.components?.modifiers ?? [];
  if (!Array.isArray(source)) throw new StudioError('invalid_modifiers', 'Entity modifiers must be an array.');
  if (source.length > MAX_MODIFIERS_PER_ENTITY) {
    throw new StudioError('modifier_limit', `An entity may contain at most ${MAX_MODIFIERS_PER_ENTITY} modifiers.`, {
      count: source.length,
      maximum: MAX_MODIFIERS_PER_ENTITY,
    });
  }
  const ids = new Set();
  return source.map((input) => {
    const modifier = normalizeModifierDocument(input, { allowLegacyUnknown });
    if (ids.has(modifier.id)) throw new StudioError('duplicate_modifier_id', `Duplicate modifier ID ${modifier.id}.`);
    ids.add(modifier.id);
    return modifier;
  });
}

export function modifierStackHash(entity) {
  return contentHash(normalizedModifierStack(entity));
}

/**
 * Describes the exact viewport-evaluable prefix of an ordered modifier stack.
 * A bake/order/seam boundary remains authored, but downstream entries are not
 * silently evaluated against an incomplete result.
 */
export function analyzeViewportModifierStack(entity, { sourceKind = null } = {}) {
  const modifiers = normalizedModifierStack(entity);
  const entries = [];
  const previewModifiers = [];
  const geometryModifiers = [];
  let encounteredInstanceModifier = false;
  let timelineGeometryModifier = null;
  let editableRenderBoundary = null;
  let blocked = null;
  for (let index = 0; index < modifiers.length; index += 1) {
    const modifier = modifiers[index];
    const enabled = modifier.enabled !== false
      && modifier.enabledViewport !== false
      && modifier.showViewport !== false;
    if (!enabled) {
      entries.push({ index, modifierId: modifier.id, status: 'disabled', reasonCode: 'viewport-disabled' });
      if (!blocked) previewModifiers.push(modifier);
      continue;
    }
    if (blocked) {
      entries.push({
        index,
        modifierId: modifier.id,
        status: 'blocked',
        reasonCode: 'runtime_modifier_after_boundary',
        boundaryModifierId: blocked.modifierId,
      });
      continue;
    }
    if (LIVE_INSTANCE_MODIFIER_TYPES.includes(modifier.type)) {
      encounteredInstanceModifier = true;
      previewModifiers.push(modifier);
      entries.push({ index, modifierId: modifier.id, status: 'live', execution: 'live-runtime' });
      continue;
    }
    if (GEOMETRY_TYPE_SET.has(modifier.type)) {
      if (timelineGeometryModifier) {
        blocked = {
          index,
          modifierId: modifier.id,
          modifierType: modifier.type,
          reasonCode: 'runtime_dynamic_modifier_order_unsupported',
          message: `Geometry modifier ${modifier.id} (${modifier.type}) follows timeline-driven Ocean modifier ${timelineGeometryModifier.id}; move Ocean to the end of the live geometry stack.`,
        };
      } else if (encounteredInstanceModifier) {
        blocked = {
          index,
          modifierId: modifier.id,
          modifierType: modifier.type,
          reasonCode: 'runtime_modifier_order_unsupported',
          message: `Geometry modifier ${modifier.id} (${modifier.type}) follows an instance modifier and requires baking or reordering.`,
        };
      } else if (sourceKind === 'editableMesh' && editableRenderBoundary && ['solidify', 'subdivision'].includes(modifier.type)) {
        blocked = {
          index,
          modifierId: modifier.id,
          modifierType: modifier.type,
          reasonCode: 'runtime_editable_topology_after_render_boundary',
          message: `Topology modifier ${modifier.id} (${modifier.type}) follows ${editableRenderBoundary.id}, which expands render seams; move topology modifiers before weightedNormal, edgeSplit, and Ocean.`,
        };
      } else if (sourceKind === 'editableMesh' && BLOCKED_EDITABLE_MESH_GEOMETRY_MODIFIERS.has(modifier.type)) {
        blocked = {
          index,
          modifierId: modifier.id,
          modifierType: modifier.type,
          reasonCode: 'runtime_editable_modifier_bake_required',
          message: `Geometry modifier ${modifier.id} (${modifier.type}) requires a seam-safe editableMesh bake before viewport evaluation.`,
        };
      }
      if (blocked) {
        entries.push({ index, modifierId: modifier.id, status: 'blocked', reasonCode: blocked.reasonCode });
        continue;
      }
      previewModifiers.push(modifier);
      geometryModifiers.push(modifier);
      entries.push({ index, modifierId: modifier.id, status: 'live', execution: 'live-geometry' });
      if (modifier.type === 'ocean' && (modifier.timelineScale ?? 1) !== 0) {
        timelineGeometryModifier = modifier;
      }
      if (sourceKind === 'editableMesh' && ['weightedNormal', 'edgeSplit', 'ocean'].includes(modifier.type)) editableRenderBoundary = modifier;
      continue;
    }
    blocked = {
      index,
      modifierId: modifier.id,
      modifierType: modifier.type,
      reasonCode: 'runtime_modifier_bake_required',
      message: `Modifier ${modifier.id} (${modifier.type}) has no deterministic viewport evaluator and must be baked.`,
    };
    entries.push({ index, modifierId: modifier.id, status: 'blocked', reasonCode: blocked.reasonCode });
  }
  return {
    target: 'viewport',
    sourceKind,
    stackHash: contentHash(modifiers),
    modifiers,
    entries,
    previewModifiers,
    geometryModifiers,
    hasActiveGeometryModifiers: geometryModifiers.some(modifier => (
      modifier.enabled !== false && modifier.enabledViewport !== false && modifier.showViewport !== false
    )),
    blocked,
    status: blocked ? 'partial-preview' : 'live',
  };
}

export function assertExpectedModifierStackHash(entity, expectedHash) {
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new StudioError('invalid_modifier_stack_hash', 'expectedStackHash must be a lowercase SHA-256 hash.', {
      expectedStackHash: expectedHash,
    });
  }
  const actualStackHash = modifierStackHash(entity);
  if (actualStackHash !== expectedHash) {
    throw new StudioError('modifier_stack_conflict', 'The modifier stack changed after it was inspected.', {
      expectedStackHash: expectedHash,
      actualStackHash,
    });
  }
  return actualStackHash;
}

export function buildModifierDigest(entity, classify = classifyModifierExecution, options = {}) {
  const modifiers = normalizedModifierStack(entity);
  const maximumInlineParameterBytes = options.maximumInlineParameterBytes ?? 2_048;
  let remainingInlineBytes = options.maximumTotalInlineParameterBytes ?? 64 * 1024;
  return {
    entityId: entity.id,
    stackHash: contentHash(modifiers),
    count: modifiers.length,
    modifiers: modifiers.map((modifier, index) => {
      const parameters = Object.fromEntries(Object.entries(modifier).filter(([key]) => ![
        'id', 'type', 'enabled', 'enabledViewport', 'enabledRender',
      ].includes(key)));
      const parametersBytes = byteLength(parameters);
      const inline = parametersBytes <= maximumInlineParameterBytes && parametersBytes <= remainingInlineBytes;
      if (inline) remainingInlineBytes -= parametersBytes;
      const inventory = modifierBlenderInventoryEntry(modifier);
      return {
        index,
        id: modifier.id,
        type: modifier.type,
        authoredFlags: {
          enabled: modifier.enabled !== false,
          viewport: modifier.enabledViewport !== false,
          render: modifier.enabledRender !== false,
        },
        execution: classify(modifier.type, modifier),
        legacyUnknown: !AUTHORABLE_TYPE_SET.has(modifier.type),
        modifierHash: contentHash(modifier),
        parameterHash: contentHash(parameters),
        parameterBytes: parametersBytes,
        parameterKeys: Object.keys(parameters).sort(),
        ...(inline ? { parameters } : { parametersOmitted: true }),
        ...(inventory ? {
          blender: {
            id: inventory.id,
            operatorType: inventory.operatorType,
            rnaIdentifier: inventory.rnaIdentifier,
            compatibilityStatus: inventory.status,
          },
        } : {}),
      };
    }),
  };
}
