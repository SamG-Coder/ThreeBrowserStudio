export const DEFAULT_RTX_SETTINGS = Object.freeze({
  lighting: true,
  shadows: true,
  ambientOcclusion: true,
  directionalSampleCount: 1,
  aoSampleCount: 2,
  directionalAngularRadius: 0.0065,
  shadowStrength: 0.9,
  aoStrength: 0.22,
  aoRadius: 0.8,
  maxDistance: 10_000,
  rayBias: 0.002,
});

const SETTING_KEYS = new Set(Object.keys(DEFAULT_RTX_SETTINGS));
const STATE_KEYS = new Set([
  'supported', 'requested', 'active', 'stale', 'building', 'failed', 'reason',
]);
const STATE_INPUT_KEYS = new Set(['supported', 'requested', 'reason']);
const EVENT_KEYS = Object.freeze({
  support: new Set(['type', 'supported', 'reason']),
  request: new Set(['type', 'requested', 'reason']),
  invalidate: new Set(['type', 'reason']),
  'build.start': new Set(['type', 'reason']),
  'build.success': new Set(['type']),
  'build.failure': new Set(['type', 'reason']),
});

export class RtxSettingsError extends TypeError {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RtxSettingsError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new RtxSettingsError(code, message, details);
}

function strictKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`invalid_${label}`, `${label} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`invalid_${label}`, `${label} contains unknown property ${key}.`, { key });
  }
}

function boolean(value, key) {
  if (typeof value !== 'boolean') fail('invalid_rtx_setting', `${key} must be boolean.`, { key, value });
  return value;
}

function integer(value, key, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail('invalid_rtx_setting', `${key} must be an integer from ${minimum} to ${maximum}.`, { key, value });
  }
  return value;
}

function number(value, key, minimum, maximum, { includeMinimum = true, includeMaximum = true } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('invalid_rtx_setting', `${key} must be a finite number.`, { key, value });
  }
  const aboveMinimum = includeMinimum ? value >= minimum : value > minimum;
  const belowMaximum = includeMaximum ? value <= maximum : value < maximum;
  if (!aboveMinimum || !belowMaximum) {
    const left = includeMinimum ? '[' : '(';
    const right = includeMaximum ? ']' : ')';
    fail('invalid_rtx_setting', `${key} must be finite and inside ${left}${minimum}, ${maximum}${right}.`, { key, value });
  }
  return value;
}

export function normalizeRtxSettings(input = {}) {
  strictKeys(input, SETTING_KEYS, 'rtx_settings');
  const source = { ...DEFAULT_RTX_SETTINGS, ...input };
  const normalized = {
    lighting: boolean(source.lighting, 'lighting'),
    shadows: boolean(source.shadows, 'shadows'),
    ambientOcclusion: boolean(source.ambientOcclusion, 'ambientOcclusion'),
    directionalSampleCount: integer(source.directionalSampleCount, 'directionalSampleCount', 1, 64),
    aoSampleCount: integer(source.aoSampleCount, 'aoSampleCount', 1, 64),
    directionalAngularRadius: number(
      source.directionalAngularRadius,
      'directionalAngularRadius',
      0,
      Math.PI / 2,
      { includeMaximum: false },
    ),
    shadowStrength: number(source.shadowStrength, 'shadowStrength', 0, 1),
    aoStrength: number(source.aoStrength, 'aoStrength', 0, 1),
    aoRadius: number(source.aoRadius, 'aoRadius', 0, 10_000, { includeMinimum: false }),
    maxDistance: number(source.maxDistance, 'maxDistance', 0, 1_000_000, { includeMinimum: false }),
    rayBias: number(source.rayBias, 'rayBias', 0, 10_000, { includeMinimum: false }),
  };
  if (normalized.rayBias >= normalized.maxDistance) {
    fail('invalid_rtx_setting', 'rayBias must be smaller than maxDistance.', {
      rayBias: normalized.rayBias,
      maxDistance: normalized.maxDistance,
    });
  }
  return Object.freeze(normalized);
}

export function rtxLightingEnabled(settings = DEFAULT_RTX_SETTINGS) {
  const normalized = normalizeRtxSettings(settings);
  return normalized.lighting && (
    (normalized.shadows && normalized.shadowStrength > 0)
    || (normalized.ambientOcclusion && normalized.aoStrength > 0)
  );
}

export function nativeRayLightingSettings(settings = DEFAULT_RTX_SETTINGS, directionalLight = null) {
  const normalized = normalizeRtxSettings(settings);
  if (directionalLight !== null) {
    strictKeys(
      directionalLight,
      new Set(['directionalLightDirection', 'directionalLightIntensity', 'sourceId']),
      'directional_light',
    );
    const direction = directionalLight.directionalLightDirection;
    if (!direction || typeof direction.length !== 'number' || direction.length !== 3
        || Array.from(direction).some(value => !Number.isFinite(Number(value)))
        || Math.hypot(...Array.from(direction, Number)) <= 1e-6) {
      fail('invalid_directional_light', 'directionalLightDirection must contain three finite values and be non-zero.');
    }
    if (!Number.isFinite(directionalLight.directionalLightIntensity)
        || directionalLight.directionalLightIntensity < 0) {
      fail('invalid_directional_light', 'directionalLightIntensity must be finite and non-negative.');
    }
  }
  return Object.freeze({
    ...(directionalLight ? {
      directionalLightDirection: new Float32Array(directionalLight.directionalLightDirection),
      directionalLightIntensity: directionalLight.directionalLightIntensity,
    } : {}),
    directionalAngularRadius: normalized.directionalAngularRadius,
    directionalSampleCount: normalized.directionalSampleCount,
    aoSampleCount: normalized.aoSampleCount,
    shadowStrength: normalized.lighting && normalized.shadows ? normalized.shadowStrength : 0,
    aoStrength: normalized.lighting && normalized.ambientOcclusion ? normalized.aoStrength : 0,
    aoRadius: normalized.aoRadius,
    maxDistance: normalized.maxDistance,
    rayBias: normalized.rayBias,
  });
}

function stateReason(value, { required = false } = {}) {
  if (value === null || value === undefined) {
    if (required) fail('invalid_rtx_state', 'A non-empty failure reason is required.');
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) {
    fail('invalid_rtx_state', 'RTX state reason must contain 1 to 512 characters.');
  }
  return value.trim();
}

function frozenState(state) {
  return Object.freeze({
    supported: state.supported,
    requested: state.requested,
    active: state.active,
    stale: state.stale,
    building: state.building,
    failed: state.failed,
    reason: state.reason,
  });
}

export function validateRtxState(state) {
  strictKeys(state, STATE_KEYS, 'rtx_state');
  for (const key of ['supported', 'requested', 'active', 'stale', 'building', 'failed']) {
    if (typeof state[key] !== 'boolean') fail('invalid_rtx_state', `${key} must be boolean.`, { key });
  }
  const reason = stateReason(state.reason, { required: state.failed });
  if (!state.supported && reason === null) {
    fail('invalid_rtx_state', 'Unsupported RTX state requires a reason.');
  }
  if ((state.stale || state.building) && reason === null) {
    fail('invalid_rtx_state', 'Stale and building RTX states require a reason.');
  }
  if ((state.active || (state.supported && !state.requested)) && reason !== null) {
    fail('invalid_rtx_state', 'Active and supported-disabled RTX states must not retain a reason.');
  }
  if (state.active && (!state.supported || !state.requested || state.stale || state.building || state.failed)) {
    fail('invalid_rtx_state', 'active requires supported/requested and excludes stale/building/failed.');
  }
  if (state.building && (!state.supported || !state.requested || state.active || state.failed)) {
    fail('invalid_rtx_state', 'building requires supported/requested and excludes active/failed.');
  }
  if (state.failed && (!state.supported || !state.requested || state.active || state.building)) {
    fail('invalid_rtx_state', 'failed requires supported/requested and excludes active/building.');
  }
  if (!state.supported && (state.active || state.stale || state.building || state.failed)) {
    fail('invalid_rtx_state', 'Unsupported RTX state cannot be active, stale, building, or failed.');
  }
  if (!state.requested && (state.active || state.stale || state.building || state.failed)) {
    fail('invalid_rtx_state', 'Unrequested RTX state cannot be active, stale, building, or failed.');
  }
  return frozenState({ ...state, reason });
}

export function createRtxState(input = {}) {
  strictKeys(input, STATE_INPUT_KEYS, 'rtx_state_input');
  const { supported = false, requested = false, reason = null } = input;
  boolean(supported, 'supported');
  boolean(requested, 'requested');
  const unavailableReason = supported
    ? null
    : stateReason(reason) ?? 'Native ray-query bridge is unsupported.';
  if (!supported) {
    return frozenState({
      supported: false,
      requested,
      active: false,
      stale: false,
      building: false,
      failed: false,
      reason: unavailableReason,
    });
  }
  return frozenState({
    supported: true,
    requested,
    active: false,
    stale: requested,
    building: false,
    failed: false,
    reason: requested ? stateReason(reason) ?? 'RTX scene requires a build.' : null,
  });
}

function eventObject(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    fail('invalid_rtx_event', 'RTX state event must be an object.');
  }
  const allowed = EVENT_KEYS[event.type];
  if (!allowed) fail('invalid_rtx_event', `Unknown RTX state event ${event.type}.`, { type: event.type });
  strictKeys(event, allowed, 'rtx_event');
  return event;
}

export function transitionRtxState(current, authoredEvent) {
  const state = validateRtxState(current);
  const event = eventObject(authoredEvent);
  if (event.type === 'support') {
    boolean(event.supported, 'supported');
    if (!event.supported) {
      return createRtxState({
        supported: false,
        requested: state.requested,
        reason: stateReason(event.reason) ?? 'Native ray-query bridge is unsupported.',
      });
    }
    return createRtxState({
      supported: true,
      requested: state.requested,
      reason: state.requested ? stateReason(event.reason) : null,
    });
  }
  if (event.type === 'request') {
    boolean(event.requested, 'requested');
    if (!event.requested) return createRtxState({ supported: state.supported, requested: false, reason: state.reason });
    if (!state.supported) {
      return createRtxState({ supported: false, requested: true, reason: stateReason(event.reason) ?? state.reason });
    }
    return createRtxState({ supported: true, requested: true, reason: stateReason(event.reason) });
  }
  if (!state.supported || !state.requested) {
    fail('invalid_rtx_transition', `${event.type} requires RTX to be supported and requested.`, { event: event.type });
  }
  if (event.type === 'invalidate') {
    return frozenState({
      supported: true,
      requested: true,
      active: false,
      stale: true,
      building: false,
      failed: false,
      reason: stateReason(event.reason) ?? 'RTX scene is stale.',
    });
  }
  if (event.type === 'build.start') {
    if (!state.stale && !state.failed) {
      fail('invalid_rtx_transition', 'build.start requires a stale or failed RTX state.');
    }
    return frozenState({
      supported: true,
      requested: true,
      active: false,
      stale: true,
      building: true,
      failed: false,
      reason: stateReason(event.reason) ?? 'RTX static scene is building.',
    });
  }
  if (event.type === 'build.success') {
    if (!state.building) fail('invalid_rtx_transition', 'build.success requires a building RTX state.');
    return frozenState({
      supported: true,
      requested: true,
      active: true,
      stale: false,
      building: false,
      failed: false,
      reason: null,
    });
  }
  const reason = stateReason(event.reason, { required: true });
  return frozenState({
    supported: true,
    requested: true,
    active: false,
    stale: true,
    building: false,
    failed: true,
    reason,
  });
}

export function rtxStatePhase(state) {
  const validated = validateRtxState(state);
  if (!validated.supported) return 'unsupported';
  if (!validated.requested) return 'disabled';
  if (validated.building) return 'building';
  if (validated.failed) return 'failed';
  if (validated.stale) return 'stale';
  if (validated.active) return 'active';
  return 'ready';
}

export function rtxCanBuild(state) {
  const validated = validateRtxState(state);
  return validated.supported && validated.requested && !validated.building
    && (validated.stale || validated.failed);
}

export function rtxCanEvaluate(state) {
  return validateRtxState(state).active;
}
