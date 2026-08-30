import { StudioError } from './errors.mjs';
import { assertStableId } from './ids.mjs';
import { cloneJson, isPlainRecord } from './util.mjs';

export const MAX_LAYOUT_PATTERN_INSTANCES = 8192;
export const MIN_LAYOUT_SCATTER_SEED = -2_147_483_648;
export const MAX_LAYOUT_SCATTER_SEED = 2_147_483_647;
export const MAX_LAYOUT_PATTERN_COMPONENT = 1_000_000_000;
export const LAYOUT_PATTERN_MODES = Object.freeze(['linear', 'grid', 'radial', 'scatter', 'surface']);
export const LAYOUT_PATTERN_ORIENTATIONS = Object.freeze(['keep', 'radial', 'tangent']);
export const LAYOUT_SURFACE_ORIENTATIONS = Object.freeze(['keep', 'normal', 'gravity']);

const COMMON_KEYS = new Set(['id', 'mode']);
const MODIFIER_KEYS = new Set(['type', 'enabled', 'enabledViewport', 'enabledRender']);
const MODE_KEYS = Object.freeze({
  linear: new Set(['count', 'offset']),
  grid: new Set(['counts', 'spacing']),
  radial: new Set(['count', 'axis', 'center', 'radius', 'startAngle', 'arc', 'closed', 'orientation']),
  scatter: new Set(['count', 'seed', 'bounds', 'rotationMin', 'rotationMax', 'scaleMin', 'scaleMax']),
  surface: new Set([
    'count', 'seed', 'targetEntityId', 'orientation', 'normalAxis', 'gravity',
    'offset', 'minDistance', 'rotationMin', 'rotationMax', 'scaleMin', 'scaleMax',
  ]),
});

function invalid(message, details = {}) {
  throw new StudioError('invalid_layout_pattern', message, details);
}

function assertKnownKeys(value, mode, { modifier }) {
  const allowed = new Set([...COMMON_KEYS, ...MODE_KEYS[mode], ...(modifier ? MODIFIER_KEYS : [])]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`Layout pattern contains unknown property ${key}.`, { key, mode });
  }
}

function finiteVector3(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || value.some(number => !Number.isFinite(number))) {
    invalid(`${label} must contain three finite numbers.`, { field: label });
  }
  return [...value];
}

function boundedVector3(value, label) {
  const vector = finiteVector3(value, label);
  if (vector.some(number => number < -MAX_LAYOUT_PATTERN_COMPONENT || number > MAX_LAYOUT_PATTERN_COMPONENT)) {
    invalid(
      `${label} entries must be from ${-MAX_LAYOUT_PATTERN_COMPONENT} to ${MAX_LAYOUT_PATTERN_COMPONENT}.`,
      { field: label, value },
    );
  }
  return vector;
}

function positiveScaleVector3(value, label) {
  const vector = boundedVector3(value, label);
  if (vector.some(number => number <= 0)) {
    invalid(`${label} entries must be greater than zero.`, { field: label, value });
  }
  return vector;
}

function orderedVectorRange(minimum, maximum, label) {
  for (let index = 0; index < 3; index += 1) {
    if (minimum[index] > maximum[index]) {
      invalid(`${label}.min must not exceed ${label}.max on any axis.`, {
        field: label,
        axis: index,
        minimum: minimum[index],
        maximum: maximum[index],
      });
    }
  }
}

function scatterBounds(value) {
  if (!isPlainRecord(value)) invalid('bounds must be an object.', { field: 'bounds' });
  for (const key of Object.keys(value)) {
    if (!['min', 'max'].includes(key)) invalid(`bounds contains unknown property ${key}.`, { field: 'bounds', key });
  }
  const minimum = boundedVector3(value.min, 'bounds.min');
  const maximum = boundedVector3(value.max, 'bounds.max');
  orderedVectorRange(minimum, maximum, 'bounds');
  return { min: minimum, max: maximum };
}

function scatterVectorRange(input, minimumKey, maximumKey, fallback, { positive = false } = {}) {
  const normalizeVector = positive ? positiveScaleVector3 : boundedVector3;
  const authoredMinimum = input[minimumKey] === undefined
    ? undefined
    : normalizeVector(input[minimumKey], minimumKey);
  const authoredMaximum = input[maximumKey] === undefined
    ? undefined
    : normalizeVector(input[maximumKey], maximumKey);
  const minimum = authoredMinimum ?? authoredMaximum ?? [...fallback];
  const maximum = authoredMaximum ?? authoredMinimum ?? [...fallback];
  orderedVectorRange(minimum, maximum, minimumKey.replace(/Min$/, ''));
  return { minimum, maximum };
}

function instanceCount(value, label = 'count') {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LAYOUT_PATTERN_INSTANCES) {
    invalid(`${label} must be an integer from 1 to ${MAX_LAYOUT_PATTERN_INSTANCES}.`, { field: label, value });
  }
  return value;
}

function optionalModifierFlags(input, output) {
  for (const key of ['enabled', 'enabledViewport', 'enabledRender']) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') invalid(`${key} must be boolean.`, { field: key });
    output[key] = input[key];
  }
}

/**
 * Normalizes the canonical live-instancing pattern modifier. Operation payloads
 * omit `type`; persisted component modifiers include `type: "pattern"`.
 */
export function normalizeLayoutPattern(input, { modifier = false } = {}) {
  if (!isPlainRecord(input)) invalid('Layout pattern must be an object.');
  const mode = input.mode;
  if (!LAYOUT_PATTERN_MODES.includes(mode)) invalid(`Unsupported layout pattern mode ${mode}.`, { mode });
  if (modifier && input.type !== 'pattern') invalid('Layout pattern modifier type must be pattern.', { type: input.type });
  if (!modifier && input.type !== undefined) invalid('layout.pattern.pattern must not include a modifier type.', { type: input.type });
  assertKnownKeys(input, mode, { modifier });

  const output = {
    id: assertStableId(input.id, 'layout pattern id'),
    type: 'pattern',
    mode,
  };
  if (modifier) optionalModifierFlags(input, output);

  if (mode === 'linear') {
    output.count = instanceCount(input.count);
    output.offset = finiteVector3(input.offset, 'offset');
  } else if (mode === 'grid') {
    const counts = finiteVector3(input.counts, 'counts');
    if (counts.some(value => !Number.isInteger(value) || value < 1 || value > MAX_LAYOUT_PATTERN_INSTANCES)) {
      invalid(`counts entries must be integers from 1 to ${MAX_LAYOUT_PATTERN_INSTANCES}.`, { counts });
    }
    const product = counts[0] * counts[1] * counts[2];
    if (!Number.isSafeInteger(product) || product > MAX_LAYOUT_PATTERN_INSTANCES) {
      invalid(`Grid count product must not exceed ${MAX_LAYOUT_PATTERN_INSTANCES}.`, { counts, product });
    }
    output.counts = counts;
    output.spacing = finiteVector3(input.spacing, 'spacing');
  } else if (mode === 'radial') {
    output.count = instanceCount(input.count);
    if (!['x', 'y', 'z'].includes(input.axis)) invalid('axis must be x, y, or z.', { axis: input.axis });
    output.axis = input.axis;
    output.center = finiteVector3(input.center, 'center');
    if (!Number.isFinite(input.radius) || input.radius < 0) invalid('radius must be a non-negative finite number.', { radius: input.radius });
    if (!Number.isFinite(input.startAngle)) invalid('startAngle must be finite.', { startAngle: input.startAngle });
    if (!Number.isFinite(input.arc)) invalid('arc must be finite.', { arc: input.arc });
    if (typeof input.closed !== 'boolean') invalid('closed must be boolean.', { closed: input.closed });
    if (!LAYOUT_PATTERN_ORIENTATIONS.includes(input.orientation)) {
      invalid(`orientation must be one of ${LAYOUT_PATTERN_ORIENTATIONS.join(', ')}.`, { orientation: input.orientation });
    }
    output.radius = input.radius;
    output.startAngle = input.startAngle;
    output.arc = input.arc;
    output.closed = input.closed;
    output.orientation = input.orientation;
  } else if (mode === 'scatter') {
    output.count = instanceCount(input.count);
    if (!Number.isInteger(input.seed)
        || input.seed < MIN_LAYOUT_SCATTER_SEED
        || input.seed > MAX_LAYOUT_SCATTER_SEED) {
      invalid(
        `seed must be a 32-bit integer from ${MIN_LAYOUT_SCATTER_SEED} to ${MAX_LAYOUT_SCATTER_SEED}.`,
        { field: 'seed', value: input.seed },
      );
    }
    output.seed = input.seed;
    output.bounds = scatterBounds(input.bounds);
    const rotation = scatterVectorRange(input, 'rotationMin', 'rotationMax', [0, 0, 0]);
    const scale = scatterVectorRange(input, 'scaleMin', 'scaleMax', [1, 1, 1], { positive: true });
    output.rotationMin = rotation.minimum;
    output.rotationMax = rotation.maximum;
    output.scaleMin = scale.minimum;
    output.scaleMax = scale.maximum;
  } else {
    output.count = instanceCount(input.count);
    if (!Number.isInteger(input.seed)
        || input.seed < MIN_LAYOUT_SCATTER_SEED
        || input.seed > MAX_LAYOUT_SCATTER_SEED) {
      invalid(`seed must be a signed 32-bit integer.`, { field: 'seed', value: input.seed });
    }
    output.seed = input.seed;
    output.targetEntityId = assertStableId(input.targetEntityId, 'surface target entity id');
    output.orientation = input.orientation ?? 'normal';
    if (!LAYOUT_SURFACE_ORIENTATIONS.includes(output.orientation)) {
      invalid(`orientation must be one of ${LAYOUT_SURFACE_ORIENTATIONS.join(', ')}.`, { orientation: input.orientation });
    }
    output.normalAxis = input.normalAxis ?? 'z';
    if (!['x', 'y', 'z'].includes(output.normalAxis)) invalid('normalAxis must be x, y, or z.');
    output.gravity = boundedVector3(input.gravity ?? [0, -1, 0], 'gravity');
    if (Math.hypot(...output.gravity) === 0) invalid('gravity must be non-zero.');
    output.offset = input.offset ?? 0;
    if (!Number.isFinite(output.offset) || Math.abs(output.offset) > MAX_LAYOUT_PATTERN_COMPONENT) {
      invalid('offset must be a bounded finite number.', { offset: input.offset });
    }
    output.minDistance = input.minDistance ?? 0;
    if (!Number.isFinite(output.minDistance) || output.minDistance < 0 || output.minDistance > MAX_LAYOUT_PATTERN_COMPONENT) {
      invalid('minDistance must be a bounded non-negative number.', { minDistance: input.minDistance });
    }
    const rotationMinimum = input.rotationMin ?? input.rotationMax ?? 0;
    const rotationMaximum = input.rotationMax ?? input.rotationMin ?? 0;
    if (!Number.isFinite(rotationMinimum) || !Number.isFinite(rotationMaximum) || rotationMinimum > rotationMaximum) {
      invalid('rotationMin and rotationMax must be finite and ordered.');
    }
    output.rotationMin = rotationMinimum;
    output.rotationMax = rotationMaximum;
    const scale = scatterVectorRange(input, 'scaleMin', 'scaleMax', [1, 1, 1], { positive: true });
    output.scaleMin = scale.minimum;
    output.scaleMax = scale.maximum;
  }
  return cloneJson(output);
}
