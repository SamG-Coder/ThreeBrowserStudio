import { isStableId } from '../core/ids.mjs';

export const ANIMATION_PROPERTY_PATHS = Object.freeze([
  'transform.position',
  'transform.rotation',
  'transform.scale',
  'visible',
]);

export const ANIMATION_INTERPOLATIONS = Object.freeze([
  'constant',
  'linear',
  'bezier',
  'smooth',
]);

export const ANIMATION_LOOP_MODES = Object.freeze(['once', 'repeat', 'pingpong']);

export const ANIMATION_LIMITS = Object.freeze({
  maxTracks: 1024,
  maxKeyframes: 100_000,
  maxFps: 1000,
  maxSpeed: 64,
  maxTime: 1_000_000_000,
});

const TOP_LEVEL_KEYS = new Set([
  'formatVersion', 'id', 'kind', 'name', 'enabled', 'autoplay', 'fps',
  'frameStart', 'frameEnd', 'startTime', 'endTime', 'duration', 'timeUnit',
  'loop', 'speed', 'tracks', 'metadata',
]);
const TRACK_KEYS = new Set([
  'targetId', 'property', 'interpolation', 'timeUnit', 'keyframes', 'times', 'values',
]);
const KEYFRAME_KEYS = new Set(['time', 'frame', 'value', 'inTangent', 'outTangent']);
const VECTOR_PROPERTIES = new Set([
  'transform.position',
  'transform.rotation',
  'transform.scale',
]);
const COMPILED_ACTIONS = new WeakSet();

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function diagnostic(code, message, path, details = {}) {
  return Object.freeze({ severity: 'error', code, path, message, ...details });
}

function unknownKeys(value, allowed, path, diagnostics) {
  if (!isPlainRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      diagnostics.push(diagnostic(
        'animation_unknown_property',
        `Unknown animation property "${key}".`,
        `${path}/${key}`,
      ));
    }
  }
}

function finiteNumber(value, { min = -Infinity, max = Infinity } = {}) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function cloneValue(value) {
  return Array.isArray(value) ? [...value] : value;
}

function freezeValue(value) {
  return Array.isArray(value) ? Object.freeze([...value]) : value;
}

function validateTrackValue(value, property, path, diagnostics, label = 'value') {
  if (VECTOR_PROPERTIES.has(property)) {
    if (!Array.isArray(value) || value.length !== 3 || value.some(entry => !Number.isFinite(entry))) {
      diagnostics.push(diagnostic(
        'animation_invalid_value',
        `${label} for ${property} must contain exactly three finite numbers.`,
        path,
      ));
      return null;
    }
    if (property === 'transform.scale' && label === 'value' && value.some(entry => entry === 0)) {
      diagnostics.push(diagnostic(
        'animation_zero_scale',
        'Scale keyframes cannot contain a zero component.',
        path,
      ));
      return null;
    }
    return [...value];
  }
  if (property === 'visible') {
    if (typeof value !== 'boolean') {
      diagnostics.push(diagnostic(
        'animation_invalid_value',
        'visible keyframe values must be boolean.',
        path,
      ));
      return null;
    }
    return value;
  }
  return null;
}

function validateTimeline(resource, diagnostics) {
  const hasFrameStart = resource.frameStart !== undefined;
  const hasFrameEnd = resource.frameEnd !== undefined;
  const hasStartTime = resource.startTime !== undefined;
  const hasEndTime = resource.endTime !== undefined;
  const hasDuration = resource.duration !== undefined;

  if (hasFrameStart !== hasFrameEnd) {
    diagnostics.push(diagnostic(
      'animation_incomplete_frame_range',
      'frameStart and frameEnd must be provided together.',
      hasFrameStart ? '/frameEnd' : '/frameStart',
    ));
  }
  if (hasStartTime !== hasEndTime) {
    diagnostics.push(diagnostic(
      'animation_incomplete_time_range',
      'startTime and endTime must be provided together.',
      hasStartTime ? '/endTime' : '/startTime',
    ));
  }
  const rangeModes = Number(hasFrameStart || hasFrameEnd)
    + Number(hasStartTime || hasEndTime)
    + Number(hasDuration);
  if (rangeModes > 1) {
    diagnostics.push(diagnostic(
      'animation_conflicting_time_range',
      'Use one timeline range: frames, seconds, or duration.',
      '/',
    ));
  }

  const fps = resource.fps ?? 24;
  if (!finiteNumber(fps, { min: Number.EPSILON, max: ANIMATION_LIMITS.maxFps })) {
    diagnostics.push(diagnostic(
      'animation_invalid_fps',
      `fps must be greater than zero and no more than ${ANIMATION_LIMITS.maxFps}.`,
      '/fps',
    ));
  }

  if (hasFrameStart && (!Number.isSafeInteger(resource.frameStart)
    || Math.abs(resource.frameStart) > ANIMATION_LIMITS.maxTime)) {
    diagnostics.push(diagnostic(
      'animation_invalid_frame_range',
      'frameStart must be a bounded safe integer.',
      '/frameStart',
    ));
  }
  if (hasFrameEnd && (!Number.isSafeInteger(resource.frameEnd)
    || Math.abs(resource.frameEnd) > ANIMATION_LIMITS.maxTime)) {
    diagnostics.push(diagnostic(
      'animation_invalid_frame_range',
      'frameEnd must be a bounded safe integer.',
      '/frameEnd',
    ));
  }
  if (hasFrameStart && hasFrameEnd && Number.isFinite(resource.frameStart)
    && Number.isFinite(resource.frameEnd) && resource.frameEnd < resource.frameStart) {
    diagnostics.push(diagnostic(
      'animation_invalid_frame_range',
      'frameEnd must be greater than or equal to frameStart.',
      '/frameEnd',
    ));
  }

  for (const [key, present] of [['startTime', hasStartTime], ['endTime', hasEndTime]]) {
    if (present && !finiteNumber(resource[key], {
      min: -ANIMATION_LIMITS.maxTime,
      max: ANIMATION_LIMITS.maxTime,
    })) {
      diagnostics.push(diagnostic(
        'animation_invalid_time_range',
        `${key} must be a bounded finite number.`,
        `/${key}`,
      ));
    }
  }
  if (hasStartTime && hasEndTime && Number.isFinite(resource.startTime)
    && Number.isFinite(resource.endTime) && resource.endTime < resource.startTime) {
    diagnostics.push(diagnostic(
      'animation_invalid_time_range',
      'endTime must be greater than or equal to startTime.',
      '/endTime',
    ));
  }
  if (hasDuration && !finiteNumber(resource.duration, { min: 0, max: ANIMATION_LIMITS.maxTime })) {
    diagnostics.push(diagnostic(
      'animation_invalid_duration',
      'duration must be a bounded non-negative number of seconds.',
      '/duration',
    ));
  }

  const timeUnit = resource.timeUnit ?? (hasFrameStart ? 'frames' : 'seconds');
  if (!['seconds', 'frames'].includes(timeUnit)) {
    diagnostics.push(diagnostic(
      'animation_invalid_time_unit',
      'timeUnit must be seconds or frames.',
      '/timeUnit',
    ));
  }

  const frameOrigin = hasFrameStart && Number.isFinite(resource.frameStart) ? resource.frameStart : 0;
  const timeOrigin = hasStartTime && Number.isFinite(resource.startTime) ? resource.startTime : 0;
  let explicitDuration = null;
  if (hasFrameStart && hasFrameEnd && finiteNumber(fps, { min: Number.EPSILON })
    && Number.isFinite(resource.frameStart) && Number.isFinite(resource.frameEnd)) {
    explicitDuration = (resource.frameEnd - resource.frameStart) / fps;
  } else if (hasStartTime && hasEndTime && Number.isFinite(resource.startTime)
    && Number.isFinite(resource.endTime)) {
    explicitDuration = resource.endTime - resource.startTime;
  } else if (hasDuration && Number.isFinite(resource.duration)) {
    explicitDuration = resource.duration;
  }

  return { fps, timeUnit, frameOrigin, timeOrigin, explicitDuration };
}

function timeToSeconds(rawTime, unit, timeline) {
  return unit === 'frames'
    ? (rawTime - timeline.frameOrigin) / timeline.fps
    : rawTime - timeline.timeOrigin;
}

function valuesFromArrays(rawValues, timesLength, property, path, diagnostics) {
  if (!Array.isArray(rawValues)) {
    diagnostics.push(diagnostic(
      'animation_invalid_values',
      'values must be an array.',
      path,
    ));
    return [];
  }
  if (VECTOR_PROPERTIES.has(property)
    && rawValues.length === timesLength * 3
    && rawValues.every(Number.isFinite)) {
    return Array.from({ length: timesLength }, (_, index) => rawValues.slice(index * 3, index * 3 + 3));
  }
  if (rawValues.length !== timesLength) {
    diagnostics.push(diagnostic(
      'animation_keyframe_count_mismatch',
      `times contains ${timesLength} entries but values contains ${rawValues.length}.`,
      path,
    ));
    return [];
  }
  return [...rawValues];
}

function parseKeyframes(track, trackPath, property, timeline, diagnostics) {
  const hasKeyframes = track.keyframes !== undefined;
  const hasTimes = track.times !== undefined;
  const hasValues = track.values !== undefined;
  if (hasKeyframes && (hasTimes || hasValues)) {
    diagnostics.push(diagnostic(
      'animation_conflicting_keyframe_format',
      'Use keyframes or times plus values, not both.',
      trackPath,
    ));
    return [];
  }
  if (!hasKeyframes && hasTimes !== hasValues) {
    diagnostics.push(diagnostic(
      'animation_incomplete_keyframe_arrays',
      'times and values must be provided together.',
      trackPath,
    ));
    return [];
  }
  if (!hasKeyframes && !hasTimes) {
    diagnostics.push(diagnostic(
      'animation_missing_keyframes',
      'A track requires keyframes or times plus values.',
      trackPath,
    ));
    return [];
  }

  const parsed = [];
  if (hasKeyframes) {
    if (!Array.isArray(track.keyframes) || track.keyframes.length === 0) {
      diagnostics.push(diagnostic(
        'animation_invalid_keyframes',
        'keyframes must be a non-empty array.',
        `${trackPath}/keyframes`,
      ));
      return [];
    }
    for (let index = 0; index < track.keyframes.length; index += 1) {
      const raw = track.keyframes[index];
      const path = `${trackPath}/keyframes/${index}`;
      if (!isPlainRecord(raw)) {
        diagnostics.push(diagnostic('animation_invalid_keyframe', 'Keyframe must be an object.', path));
        continue;
      }
      unknownKeys(raw, KEYFRAME_KEYS, path, diagnostics);
      const hasTime = raw.time !== undefined;
      const hasFrame = raw.frame !== undefined;
      if (hasTime === hasFrame) {
        diagnostics.push(diagnostic(
          'animation_invalid_keyframe_time',
          'Each keyframe requires exactly one of time or frame.',
          path,
        ));
        continue;
      }
      const rawTime = hasFrame ? raw.frame : raw.time;
      if (!finiteNumber(rawTime, {
        min: -ANIMATION_LIMITS.maxTime,
        max: ANIMATION_LIMITS.maxTime,
      })) {
        diagnostics.push(diagnostic(
          'animation_invalid_keyframe_time',
          'Keyframe time must be a bounded finite number.',
          hasFrame ? `${path}/frame` : `${path}/time`,
        ));
        continue;
      }
      const value = validateTrackValue(raw.value, property, `${path}/value`, diagnostics);
      const inTangent = raw.inTangent === undefined
        ? null
        : validateTrackValue(raw.inTangent, property, `${path}/inTangent`, diagnostics, 'inTangent');
      const outTangent = raw.outTangent === undefined
        ? null
        : validateTrackValue(raw.outTangent, property, `${path}/outTangent`, diagnostics, 'outTangent');
      if (property === 'visible' && (raw.inTangent !== undefined || raw.outTangent !== undefined)) {
        diagnostics.push(diagnostic(
          'animation_visibility_tangent_forbidden',
          'Visibility keyframes cannot declare tangents.',
          path,
        ));
      }
      if (value !== null) {
        parsed.push({
          time: timeToSeconds(rawTime, hasFrame ? 'frames' : 'seconds', timeline),
          value,
          inTangent,
          outTangent,
        });
      }
    }
    return parsed;
  }

  if (!Array.isArray(track.times) || track.times.length === 0) {
    diagnostics.push(diagnostic(
      'animation_invalid_times',
      'times must be a non-empty array.',
      `${trackPath}/times`,
    ));
    return [];
  }
  const unit = track.timeUnit ?? timeline.timeUnit;
  if (!['seconds', 'frames'].includes(unit)) {
    diagnostics.push(diagnostic(
      'animation_invalid_time_unit',
      'Track timeUnit must be seconds or frames.',
      `${trackPath}/timeUnit`,
    ));
  }
  const values = valuesFromArrays(track.values, track.times.length, property, `${trackPath}/values`, diagnostics);
  for (let index = 0; index < track.times.length; index += 1) {
    const rawTime = track.times[index];
    const path = `${trackPath}/times/${index}`;
    if (!finiteNumber(rawTime, {
      min: -ANIMATION_LIMITS.maxTime,
      max: ANIMATION_LIMITS.maxTime,
    })) {
      diagnostics.push(diagnostic(
        'animation_invalid_keyframe_time',
        'Keyframe time must be a bounded finite number.',
        path,
      ));
      continue;
    }
    const value = validateTrackValue(values[index], property, `${trackPath}/values/${index}`, diagnostics);
    if (value !== null) {
      parsed.push({
        time: timeToSeconds(rawTime, unit, timeline),
        value,
        inTangent: null,
        outTangent: null,
      });
    }
  }
  return parsed;
}

function validateKeyframeOrder(keyframes, trackPath, duration, diagnostics) {
  for (let index = 0; index < keyframes.length; index += 1) {
    const keyframe = keyframes[index];
    if (keyframe.time < 0 || (duration !== null && keyframe.time > duration)) {
      diagnostics.push(diagnostic(
        'animation_keyframe_out_of_range',
        duration === null
          ? 'Keyframe time cannot be before the timeline origin.'
          : `Keyframe time must be between 0 and ${duration} seconds.`,
        `${trackPath}/keyframes/${index}`,
      ));
    }
    if (index > 0 && keyframe.time <= keyframes[index - 1].time) {
      diagnostics.push(diagnostic(
        'animation_keyframes_not_increasing',
        'Keyframe times must be strictly increasing in authored order.',
        `${trackPath}/keyframes/${index}`,
      ));
    }
  }
}

function freezeTrack(track) {
  return Object.freeze({
    targetId: track.targetId,
    property: track.property,
    interpolation: track.interpolation,
    times: Object.freeze([...track.keyframes.map(keyframe => keyframe.time)]),
    values: Object.freeze(track.keyframes.map(keyframe => freezeValue(keyframe.value))),
    inTangents: Object.freeze(track.keyframes.map(keyframe => freezeValue(keyframe.inTangent))),
    outTangents: Object.freeze(track.keyframes.map(keyframe => freezeValue(keyframe.outTangent))),
  });
}

/**
 * Validates and normalizes one canonical Blender-style Action resource. Frame
 * timelines are converted to local seconds so evaluation is deterministic and
 * independent of the render cadence.
 */
export function validateAnimationResource(resource, { knownTargetIds = null } = {}) {
  const diagnostics = [];
  if (!isPlainRecord(resource)) {
    diagnostics.push(diagnostic(
      'animation_invalid_resource',
      'Animation resource must be a plain object.',
      '/',
    ));
    return Object.freeze({
      valid: false,
      action: null,
      diagnostics: Object.freeze(diagnostics),
      errors: Object.freeze(diagnostics),
    });
  }
  unknownKeys(resource, TOP_LEVEL_KEYS, '', diagnostics);

  if (resource.formatVersion !== undefined && resource.formatVersion !== 1) {
    diagnostics.push(diagnostic(
      'animation_unsupported_format_version',
      'formatVersion must be 1.',
      '/formatVersion',
    ));
  }
  if (!isStableId(resource.id)) {
    diagnostics.push(diagnostic(
      'animation_invalid_id',
      'Animation id must be a stable project ID.',
      '/id',
    ));
  }
  if (resource.kind !== undefined && !['animation', 'action'].includes(resource.kind)) {
    diagnostics.push(diagnostic(
      'animation_invalid_kind',
      'kind must be animation or action.',
      '/kind',
    ));
  }
  if (resource.name !== undefined && (typeof resource.name !== 'string'
    || resource.name.length === 0 || resource.name.length > 160)) {
    diagnostics.push(diagnostic(
      'animation_invalid_name',
      'name must contain 1 to 160 characters.',
      '/name',
    ));
  }
  for (const key of ['enabled', 'autoplay']) {
    if (resource[key] !== undefined && typeof resource[key] !== 'boolean') {
      diagnostics.push(diagnostic(
        'animation_invalid_flag',
        `${key} must be boolean.`,
        `/${key}`,
      ));
    }
  }
  const loop = resource.loop ?? 'once';
  if (!ANIMATION_LOOP_MODES.includes(loop)) {
    diagnostics.push(diagnostic(
      'animation_invalid_loop',
      `loop must be one of: ${ANIMATION_LOOP_MODES.join(', ')}.`,
      '/loop',
    ));
  }
  const speed = resource.speed ?? 1;
  if (!finiteNumber(speed, { min: -ANIMATION_LIMITS.maxSpeed, max: ANIMATION_LIMITS.maxSpeed })) {
    diagnostics.push(diagnostic(
      'animation_invalid_speed',
      `speed must be finite and between -${ANIMATION_LIMITS.maxSpeed} and ${ANIMATION_LIMITS.maxSpeed}.`,
      '/speed',
    ));
  }
  if (resource.metadata !== undefined && !isPlainRecord(resource.metadata)) {
    diagnostics.push(diagnostic(
      'animation_invalid_metadata',
      'metadata must be a plain object.',
      '/metadata',
    ));
  }

  const timeline = validateTimeline(resource, diagnostics);
  if (!Array.isArray(resource.tracks) || resource.tracks.length === 0) {
    diagnostics.push(diagnostic(
      'animation_invalid_tracks',
      'tracks must be a non-empty array.',
      '/tracks',
    ));
  } else if (resource.tracks.length > ANIMATION_LIMITS.maxTracks) {
    diagnostics.push(diagnostic(
      'animation_track_limit_exceeded',
      `Animation exceeds the ${ANIMATION_LIMITS.maxTracks} track limit.`,
      '/tracks',
    ));
  }

  const targetSet = knownTargetIds === null
    ? null
    : new Set(knownTargetIds instanceof Map ? knownTargetIds.keys() : knownTargetIds);
  const compiledTracks = [];
  const trackKeys = new Set();
  let keyframeCount = 0;
  for (let index = 0; index < (Array.isArray(resource.tracks) ? resource.tracks.length : 0); index += 1) {
    const track = resource.tracks[index];
    const path = `/tracks/${index}`;
    if (!isPlainRecord(track)) {
      diagnostics.push(diagnostic('animation_invalid_track', 'Track must be a plain object.', path));
      continue;
    }
    unknownKeys(track, TRACK_KEYS, path, diagnostics);
    const targetId = track.targetId;
    const property = track.property;
    if (!isStableId(targetId)) {
      diagnostics.push(diagnostic(
        'animation_invalid_target',
        'targetId must be a stable entity ID.',
        `${path}/targetId`,
      ));
    } else if (targetSet && !targetSet.has(targetId)) {
      diagnostics.push(diagnostic(
        'animation_missing_target',
        `Animation target ${targetId} does not exist in the compiled scene.`,
        `${path}/targetId`,
        { targetId },
      ));
    }
    if (!ANIMATION_PROPERTY_PATHS.includes(property)) {
      diagnostics.push(diagnostic(
        'animation_invalid_property_path',
        `property must be one of: ${ANIMATION_PROPERTY_PATHS.join(', ')}.`,
        `${path}/property`,
      ));
    }
    const interpolation = track.interpolation ?? (property === 'visible' ? 'constant' : 'linear');
    if (!ANIMATION_INTERPOLATIONS.includes(interpolation)) {
      diagnostics.push(diagnostic(
        'animation_invalid_interpolation',
        `interpolation must be one of: ${ANIMATION_INTERPOLATIONS.join(', ')}.`,
        `${path}/interpolation`,
      ));
    }
    if (property === 'visible' && interpolation !== 'constant') {
      diagnostics.push(diagnostic(
        'animation_visibility_interpolation_forbidden',
        'Visibility tracks require constant interpolation.',
        `${path}/interpolation`,
      ));
    }
    const key = `${targetId}\u0000${property}`;
    if (trackKeys.has(key)) {
      diagnostics.push(diagnostic(
        'animation_duplicate_track',
        `Action already contains a track for ${targetId}.${property}.`,
        path,
      ));
    }
    trackKeys.add(key);

    const keyframes = parseKeyframes(track, path, property, timeline, diagnostics);
    keyframeCount += keyframes.length;
    validateKeyframeOrder(keyframes, path, timeline.explicitDuration, diagnostics);
    compiledTracks.push({ targetId, property, interpolation, keyframes });
  }
  if (keyframeCount > ANIMATION_LIMITS.maxKeyframes) {
    diagnostics.push(diagnostic(
      'animation_keyframe_limit_exceeded',
      `Animation exceeds the ${ANIMATION_LIMITS.maxKeyframes} keyframe limit.`,
      '/tracks',
    ));
  }

  const inferredDuration = compiledTracks.reduce((maximum, track) => (
    Math.max(maximum, track.keyframes.at(-1)?.time ?? 0)
  ), 0);
  const duration = timeline.explicitDuration ?? inferredDuration;
  if (duration === 0 && loop !== 'once') {
    diagnostics.push(diagnostic(
      'animation_zero_duration_loop',
      'repeat and pingpong actions require a duration greater than zero.',
      '/loop',
    ));
  }

  const errors = Object.freeze([...diagnostics]);
  if (errors.length > 0) {
    return Object.freeze({
      valid: false,
      action: null,
      diagnostics: errors,
      errors,
    });
  }

  const action = Object.freeze({
    formatVersion: 1,
    id: resource.id,
    kind: 'animation',
    name: resource.name ?? resource.id.split('/').at(-1),
    enabled: resource.enabled ?? true,
    autoplay: resource.autoplay ?? false,
    fps: timeline.fps,
    duration,
    loop,
    speed,
    tracks: Object.freeze(compiledTracks.map(freezeTrack)),
    metadata: Object.freeze({ ...(resource.metadata ?? {}) }),
  });
  COMPILED_ACTIONS.add(action);
  return Object.freeze({
    valid: true,
    action,
    diagnostics: Object.freeze([]),
    errors: Object.freeze([]),
  });
}

export class AnimationValidationError extends Error {
  constructor(diagnostics) {
    super(diagnostics[0]?.message ?? 'Animation validation failed.');
    this.name = 'AnimationValidationError';
    this.code = 'animation_invalid';
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

export class AnimationRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AnimationRuntimeError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function compileAnimationAction(resource, options) {
  if (COMPILED_ACTIONS.has(resource)) return resource;
  const validation = validateAnimationResource(resource, options);
  if (!validation.valid) throw new AnimationValidationError(validation.errors);
  return validation.action;
}

function modulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

export function resolveAnimationTime(actionInput, timeSeconds) {
  const action = compileAnimationAction(actionInput);
  if (!finiteNumber(timeSeconds, {
    min: -ANIMATION_LIMITS.maxTime,
    max: ANIMATION_LIMITS.maxTime,
  })) {
    throw new AnimationRuntimeError(
      'animation_invalid_time',
      'Animation time must be a bounded finite number.',
      { timeSeconds },
    );
  }
  const duration = action.duration;
  if (duration === 0) {
    return Object.freeze({ time: 0, cycle: 0, direction: 1, completed: action.loop === 'once' });
  }
  if (action.loop === 'once') {
    return Object.freeze({
      time: Math.min(duration, Math.max(0, timeSeconds)),
      cycle: 0,
      direction: timeSeconds < 0 ? -1 : 1,
      completed: timeSeconds < 0 || timeSeconds >= duration,
    });
  }
  if (action.loop === 'repeat') {
    const phase = modulo(timeSeconds, duration);
    return Object.freeze({
      time: phase,
      cycle: Math.floor(timeSeconds / duration),
      direction: 1,
      completed: false,
    });
  }
  const span = duration * 2;
  const phase = modulo(timeSeconds, span);
  const backwards = phase > duration;
  return Object.freeze({
    time: backwards ? span - phase : phase,
    cycle: Math.floor(timeSeconds / span),
    direction: backwards ? -1 : 1,
    completed: false,
  });
}

function automaticTangent(track, index) {
  const previous = Math.max(0, index - 1);
  const next = Math.min(track.times.length - 1, index + 1);
  const elapsed = track.times[next] - track.times[previous];
  if (elapsed <= 0) return [0, 0, 0];
  return track.values[next].map((value, component) => (
    (value - track.values[previous][component]) / elapsed
  ));
}

function interpolateVector(track, leftIndex, amount) {
  const left = track.values[leftIndex];
  const right = track.values[leftIndex + 1];
  if (track.interpolation === 'constant') return [...left];
  if (track.interpolation === 'linear') {
    return left.map((value, component) => value + ((right[component] - value) * amount));
  }
  if (track.interpolation === 'smooth') {
    const smoothAmount = amount * amount * (3 - (2 * amount));
    return left.map((value, component) => value + ((right[component] - value) * smoothAmount));
  }

  const elapsed = track.times[leftIndex + 1] - track.times[leftIndex];
  const outTangent = track.outTangents[leftIndex] ?? automaticTangent(track, leftIndex);
  const inTangent = track.inTangents[leftIndex + 1] ?? automaticTangent(track, leftIndex + 1);
  const amount2 = amount * amount;
  const amount3 = amount2 * amount;
  const h00 = (2 * amount3) - (3 * amount2) + 1;
  const h10 = amount3 - (2 * amount2) + amount;
  const h01 = (-2 * amount3) + (3 * amount2);
  const h11 = amount3 - amount2;
  return left.map((value, component) => (
    (h00 * value)
    + (h10 * elapsed * outTangent[component])
    + (h01 * right[component])
    + (h11 * elapsed * inTangent[component])
  ));
}

function sampleTrack(track, time) {
  if (time <= track.times[0]) return cloneValue(track.values[0]);
  const lastIndex = track.times.length - 1;
  if (time >= track.times[lastIndex]) return cloneValue(track.values[lastIndex]);

  let low = 0;
  let high = lastIndex;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (track.times[middle] <= time) low = middle;
    else high = middle;
  }
  if (track.property === 'visible' || track.interpolation === 'constant') {
    return cloneValue(track.values[low]);
  }
  const amount = (time - track.times[low]) / (track.times[low + 1] - track.times[low]);
  return interpolateVector(track, low, amount);
}

/** Returns immutable target/property/value samples without touching Three.js. */
export function evaluateAnimationAction(actionInput, timeSeconds) {
  const action = compileAnimationAction(actionInput);
  const resolved = resolveAnimationTime(action, timeSeconds);
  const samples = action.enabled
    ? action.tracks.map(track => Object.freeze({
      targetId: track.targetId,
      property: track.property,
      value: freezeValue(sampleTrack(track, resolved.time)),
    }))
    : [];
  return Object.freeze({
    actionId: action.id,
    inputTime: timeSeconds,
    localTime: resolved.time,
    duration: action.duration,
    cycle: resolved.cycle,
    direction: resolved.direction,
    completed: resolved.completed,
    samples: Object.freeze(samples),
  });
}

function writeVector(object, property, value, targetId) {
  const destination = object[property];
  if (destination?.fromArray) destination.fromArray(value);
  else if (destination?.set) destination.set(...value);
  else if (Array.isArray(destination) && destination.length >= 3) {
    destination[0] = value[0];
    destination[1] = value[1];
    destination[2] = value[2];
  } else if (destination && typeof destination === 'object'
    && ['x', 'y', 'z'].every(component => component in destination)) {
    destination.x = value[0];
    destination.y = value[1];
    destination.z = value[2];
  } else {
    throw new AnimationRuntimeError(
      'animation_property_unavailable',
      `Target ${targetId} does not expose mutable ${property}.`,
      { targetId, property },
    );
  }
}

function supportsVectorWrite(object, property) {
  const destination = object?.[property];
  return Boolean(
    destination?.fromArray
    || destination?.set
    || (Array.isArray(destination) && destination.length >= 3)
    || (destination && typeof destination === 'object'
      && ['x', 'y', 'z'].every(component => component in destination)),
  );
}

/** Applies one evaluated Action to an entity-id -> object Map. */
export function applyAnimationAction(actionInput, timeSeconds, objects) {
  if (!(objects instanceof Map)) {
    throw new AnimationRuntimeError(
      'animation_invalid_object_map',
      'Animation targets must be supplied as a Map.',
    );
  }
  const evaluation = evaluateAnimationAction(actionInput, timeSeconds);
  // Preflight every binding so a stale scene map cannot produce a partial pose.
  for (const sample of evaluation.samples) {
    const object = objects.get(sample.targetId);
    if (!object) {
      throw new AnimationRuntimeError(
        'animation_target_missing',
        `Animation target ${sample.targetId} is not available.`,
        { targetId: sample.targetId },
      );
    }
    if (sample.property !== 'visible') {
      const property = sample.property.slice('transform.'.length);
      if (!supportsVectorWrite(object, property)) {
        throw new AnimationRuntimeError(
          'animation_property_unavailable',
          `Target ${sample.targetId} does not expose mutable ${property}.`,
          { targetId: sample.targetId, property },
        );
      }
    }
  }
  const transformTargets = new Set();
  for (const sample of evaluation.samples) {
    const object = objects.get(sample.targetId);
    if (sample.property === 'visible') object.visible = sample.value;
    else {
      const property = sample.property.slice('transform.'.length);
      writeVector(object, property, sample.value, sample.targetId);
      transformTargets.add(object);
    }
  }
  for (const object of transformTargets) object.updateMatrix?.();
  return Object.freeze({ ...evaluation, appliedTracks: evaluation.samples.length });
}

/**
 * Small deterministic transport for compiled Actions. It deliberately avoids
 * AnimationMixer: canonical IDs and property paths remain the only bindings.
 */
export class AnimationRuntime {
  constructor({ objects = new Map(), actions = [] } = {}) {
    if (!(objects instanceof Map)) {
      throw new AnimationRuntimeError(
        'animation_invalid_object_map',
        'AnimationRuntime objects must be a Map.',
      );
    }
    this.objects = objects;
    this.actions = new Map();
    this.states = new Map();
    for (const action of actions) this.addAction(action);
  }

  addAction(resource) {
    const action = compileAnimationAction(resource, { knownTargetIds: this.objects.keys() });
    for (const track of action.tracks) {
      if (!this.objects.has(track.targetId)) {
        throw new AnimationRuntimeError(
          'animation_target_missing',
          `Animation target ${track.targetId} is not available.`,
          { actionId: action.id, targetId: track.targetId },
        );
      }
    }
    if (this.actions.has(action.id)) {
      throw new AnimationRuntimeError(
        'animation_duplicate_action',
        `Animation action ${action.id} is already registered.`,
        { actionId: action.id },
      );
    }
    this.actions.set(action.id, action);
    this.states.set(action.id, {
      time: action.speed < 0 ? action.duration : 0,
      playing: action.enabled && action.autoplay,
      completed: false,
    });
    return action;
  }

  removeAction(actionId) {
    const removed = this.actions.delete(actionId);
    this.states.delete(actionId);
    return removed;
  }

  getState(actionId) {
    const action = this.#action(actionId);
    const state = this.states.get(action.id);
    return Object.freeze({
      actionId,
      time: state.time,
      playing: state.playing,
      completed: state.completed,
      enabled: action.enabled,
    });
  }

  play(actionId, { restart = false } = {}) {
    const action = this.#action(actionId);
    const state = this.states.get(actionId);
    if (restart || state.completed) state.time = action.speed < 0 ? action.duration : 0;
    state.completed = false;
    state.playing = action.enabled;
    return this.getState(actionId);
  }

  pause(actionId) {
    this.#action(actionId);
    this.states.get(actionId).playing = false;
    return this.getState(actionId);
  }

  stop(actionId, { apply = true } = {}) {
    const action = this.#action(actionId);
    const state = this.states.get(actionId);
    state.playing = false;
    state.completed = false;
    state.time = action.speed < 0 ? action.duration : 0;
    if (apply && action.enabled) applyAnimationAction(action, state.time, this.objects);
    return this.getState(actionId);
  }

  setTime(timeSeconds, { actionId = null } = {}) {
    if (!finiteNumber(timeSeconds, {
      min: -ANIMATION_LIMITS.maxTime,
      max: ANIMATION_LIMITS.maxTime,
    })) {
      throw new AnimationRuntimeError(
        'animation_invalid_time',
        'Animation time must be a bounded finite number.',
        { timeSeconds },
      );
    }
    const actions = actionId === null ? [...this.actions.values()] : [this.#action(actionId)];
    const evaluations = [];
    for (const action of actions) {
      const state = this.states.get(action.id);
      state.time = timeSeconds;
      state.completed = action.loop === 'once' && (timeSeconds <= 0 || timeSeconds >= action.duration);
      if (action.enabled) evaluations.push(applyAnimationAction(action, timeSeconds, this.objects));
    }
    return Object.freeze(evaluations);
  }

  advance(deltaSeconds) {
    if (!finiteNumber(deltaSeconds, {
      min: 0,
      max: ANIMATION_LIMITS.maxTime,
    })) {
      throw new AnimationRuntimeError(
        'animation_invalid_delta',
        'Animation delta must be a bounded non-negative finite number.',
        { deltaSeconds },
      );
    }
    const evaluations = [];
    for (const action of this.actions.values()) {
      const state = this.states.get(action.id);
      if (!action.enabled || !state.playing) continue;
      state.time += deltaSeconds * action.speed;
      if (action.loop === 'once') {
        const hitEnd = action.speed >= 0 && state.time >= action.duration;
        const hitStart = action.speed < 0 && state.time <= 0;
        if (hitEnd || hitStart) {
          state.time = hitEnd ? action.duration : 0;
          state.playing = false;
          state.completed = true;
        }
      }
      evaluations.push(applyAnimationAction(action, state.time, this.objects));
    }
    return Object.freeze(evaluations);
  }

  #action(actionId) {
    const action = this.actions.get(actionId);
    if (!action) {
      throw new AnimationRuntimeError(
        'animation_action_missing',
        `Animation action ${actionId} is not registered.`,
        { actionId },
      );
    }
    return action;
  }
}

export function createAnimationRuntime(options) {
  return new AnimationRuntime(options);
}
