import { StudioError } from './errors.mjs';
import { assertStableId } from './ids.mjs';
import { cloneJson, isPlainRecord } from './util.mjs';

export const MAX_LAYOUT_PATTERN_INSTANCES = 8192;
export const LAYOUT_PATTERN_MODES = Object.freeze(['linear', 'grid', 'radial']);
export const LAYOUT_PATTERN_ORIENTATIONS = Object.freeze(['keep', 'radial', 'tangent']);

const COMMON_KEYS = new Set(['id', 'mode']);
const MODIFIER_KEYS = new Set(['type', 'enabled', 'enabledViewport', 'enabledRender']);
const MODE_KEYS = Object.freeze({
  linear: new Set(['count', 'offset']),
  grid: new Set(['counts', 'spacing']),
  radial: new Set(['count', 'axis', 'center', 'radius', 'startAngle', 'arc', 'closed', 'orientation']),
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
  } else {
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
  }
  return cloneJson(output);
}
