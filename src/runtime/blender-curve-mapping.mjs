/**
 * Pure CurveMapping table compilation and CPU evaluation compatible with the
 * Blender 5.2 curve-node path. The authored mapping remains the source of
 * truth; these tables and packing records are disposable runtime products.
 */

export const CURVE_TABLE_SIZE = 257;
export const CURVE_BEZIER_SAMPLES = 32;
export const CURVE_POINT_LIMIT = 32;

export const FLOAT_CURVE_CHANNELS = Object.freeze(['value']);
export const VECTOR_CURVE_CHANNELS = Object.freeze(['x', 'y', 'z']);
export const RGB_CURVE_CHANNELS = Object.freeze(['red', 'green', 'blue', 'combined']);

const HANDLE_TYPES = new Set(['AUTO', 'AUTO_CLAMPED', 'VECTOR']);
const EXTEND_MODES = new Set(['HORIZONTAL', 'EXTRAPOLATED']);
const TABLE_SEGMENTS = CURVE_TABLE_SIZE - 1;
const FLOAT32_EPSILON = 2 ** -23;
const AUTO_HANDLE_SCALE = Math.fround(2.5614);

const f32 = Math.fround;

function identityPoints(minimum, maximum) {
  return [
    { location: [minimum, minimum], handleType: 'AUTO' },
    { location: [maximum, maximum], handleType: 'AUTO' },
  ];
}

function createDefaultMapping(channelNames, minimum, maximum) {
  return {
    extend: 'EXTRAPOLATED',
    clip: {
      enabled: true,
      min: [minimum, minimum],
      max: [maximum, maximum],
    },
    curves: Object.fromEntries(channelNames.map(name => [name, identityPoints(minimum, maximum)])),
  };
}

export function createFloatCurveMapping() {
  return createDefaultMapping(FLOAT_CURVE_CHANNELS, 0, 1);
}

export function createVectorCurveMapping() {
  return createDefaultMapping(VECTOR_CURVE_CHANNELS, -1, 1);
}

export function createRgbCurveMapping() {
  return createDefaultMapping(RGB_CURVE_CHANNELS, 0, 1);
}

function assertFinitePair(value, label) {
  if (!Array.isArray(value) || value.length !== 2 || value.some(component => !Number.isFinite(component))) {
    throw new TypeError(`${label} must contain exactly two finite numbers.`);
  }
  return [f32(value[0]), f32(value[1])];
}

function normalizeChannelNames(channelNames) {
  if (!Array.isArray(channelNames) || ![1, 3, 4].includes(channelNames.length)) {
    throw new RangeError('CurveMapping channelNames must contain 1, 3, or 4 names.');
  }
  const names = channelNames.map((name, index) => {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError(`CurveMapping channelNames[${index}] must be a non-empty string.`);
    }
    return name;
  });
  if (new Set(names).size !== names.length) {
    throw new RangeError('CurveMapping channelNames must be unique.');
  }
  return names;
}

function normalizePoints(points, channelName) {
  if (!Array.isArray(points) || points.length < 2 || points.length > CURVE_POINT_LIMIT) {
    throw new RangeError(
      `CurveMapping curve "${channelName}" must contain between 2 and ${CURVE_POINT_LIMIT} points.`,
    );
  }
  const normalized = points.map((point, index) => {
    if (point === null || typeof point !== 'object' || Array.isArray(point)) {
      throw new TypeError(`CurveMapping curve "${channelName}" point ${index} must be an object.`);
    }
    const location = assertFinitePair(
      point.location,
      `CurveMapping curve "${channelName}" point ${index}.location`,
    );
    if (!HANDLE_TYPES.has(point.handleType)) {
      throw new RangeError(
        `CurveMapping curve "${channelName}" point ${index}.handleType must be AUTO, AUTO_CLAMPED, or VECTOR.`,
      );
    }
    return { location, handleType: point.handleType, sourceIndex: index };
  });
  normalized.sort((left, right) => (
    left.location[0] - right.location[0] || left.sourceIndex - right.sourceIndex
  ));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].location[0] <= normalized[index - 1].location[0]) {
      throw new RangeError(`CurveMapping curve "${channelName}" point x locations must be unique.`);
    }
  }
  return normalized;
}

function length2(vector) {
  return f32(Math.hypot(vector[0], vector[1]));
}

function subtract2(left, right) {
  return [f32(left[0] - right[0]), f32(left[1] - right[1])];
}

function addScaled2(origin, direction, scale) {
  return [
    f32(origin[0] + f32(direction[0] * scale)),
    f32(origin[1] + f32(direction[1] * scale)),
  ];
}

function calculateHandles(bezier, index) {
  const current = bezier[index];
  const previous = index > 0 ? bezier[index - 1].center : [
    (2 * current.center[0]) - bezier[index + 1].center[0],
    (2 * current.center[1]) - bezier[index + 1].center[1],
  ];
  const next = index + 1 < bezier.length ? bezier[index + 1].center : [
    (2 * current.center[0]) - bezier[index - 1].center[0],
    (2 * current.center[1]) - bezier[index - 1].center[1],
  ];
  const incoming = subtract2(current.center, previous);
  const outgoing = subtract2(next, current.center);
  const incomingLength = length2(incoming) || 1;
  const outgoingLength = length2(outgoing) || 1;

  if (current.handleType === 'VECTOR') {
    current.left = addScaled2(current.center, incoming, -1 / 3);
    current.right = addScaled2(current.center, outgoing, 1 / 3);
    return;
  }

  const tangent = [
    f32(f32(outgoing[0] / outgoingLength) + f32(incoming[0] / incomingLength)),
    f32(f32(outgoing[1] / outgoingLength) + f32(incoming[1] / incomingLength)),
  ];
  const divisor = f32(length2(tangent) * AUTO_HANDLE_SCALE);
  if (divisor !== 0) {
    current.left = addScaled2(current.center, tangent, -(incomingLength / divisor));
    current.right = addScaled2(current.center, tangent, outgoingLength / divisor);
  } else {
    current.left = [...current.center];
    current.right = [...current.center];
  }

  if (current.handleType !== 'AUTO_CLAMPED' || index === 0 || index === bezier.length - 1) return;

  const previousDelta = previous[1] - current.center[1];
  const nextDelta = next[1] - current.center[1];
  if ((previousDelta <= 0 && nextDelta <= 0) || (previousDelta >= 0 && nextDelta >= 0)) {
    current.left[1] = current.center[1];
    current.right[1] = current.center[1];
  } else if (previousDelta <= 0) {
    current.left[1] = Math.max(previous[1], current.left[1]);
    current.right[1] = Math.min(next[1], current.right[1]);
  } else {
    current.left[1] = Math.min(previous[1], current.left[1]);
    current.right[1] = Math.max(next[1], current.right[1]);
  }
}

function correctEndpointAutoHandles(bezier) {
  if (bezier.length <= 2) return;

  const first = bezier[0];
  if (first.handleType === 'AUTO') {
    const handleLength = length2(subtract2(first.center, first.right));
    const direction = subtract2([
      Math.max(bezier[1].left[0], first.center[0]),
      bezier[1].left[1],
    ], first.center);
    const directionLength = length2(direction);
    if (directionLength > FLOAT32_EPSILON) {
      const scaled = direction.map(component => component * (handleLength / directionLength));
      first.right = addScaled2(first.center, scaled, 1);
      first.left = addScaled2(first.center, scaled, -1);
    }
  }

  const last = bezier.at(-1);
  if (last.handleType === 'AUTO') {
    const handleLength = length2(subtract2(last.center, last.left));
    const direction = subtract2([
      Math.min(bezier.at(-2).right[0], last.center[0]),
      bezier.at(-2).right[1],
    ], last.center);
    const directionLength = length2(direction);
    if (directionLength > FLOAT32_EPSILON) {
      const scaled = direction.map(component => component * (handleLength / directionLength));
      last.left = addScaled2(last.center, scaled, 1);
      last.right = addScaled2(last.center, scaled, -1);
    }
  }
}

function correctBezierSegment(start, end) {
  const startDelta = subtract2(start.center, start.right);
  const endDelta = subtract2(end.center, end.left);
  const span = end.center[0] - start.center[0];
  const handleSpan = Math.abs(startDelta[0]) + Math.abs(endDelta[0]);
  if (handleSpan === 0 || handleSpan <= span) return;
  const factor = span / handleSpan;
  start.right = addScaled2(start.center, startDelta, -factor);
  end.left = addScaled2(end.center, endDelta, -factor);
}

function forwardDifferenceBezier(start, control1, control2, end) {
  let iterations = f32(CURVE_BEZIER_SAMPLES - 1);
  const delta0 = f32(start);
  const delta1 = f32(f32(3 * f32(control1 - start)) / iterations);
  iterations = f32(iterations * iterations);
  const delta2 = f32(
    f32(3 * f32(f32(start - f32(2 * control1)) + control2)) / iterations,
  );
  iterations = f32(iterations * (CURVE_BEZIER_SAMPLES - 1));
  const delta3 = f32(
    f32(f32(end - start) + f32(3 * f32(control1 - control2))) / iterations,
  );

  let value = delta0;
  let firstDifference = f32(f32(delta1 + delta2) + delta3);
  let secondDifference = f32(f32(2 * delta2) + f32(6 * delta3));
  const thirdDifference = f32(6 * delta3);
  const result = [];
  for (let index = 0; index < CURVE_BEZIER_SAMPLES; index += 1) {
    result.push(value);
    value = f32(value + firstDifference);
    firstDifference = f32(firstDifference + secondDifference);
    secondDifference = f32(secondDifference + thirdDifference);
  }
  return result;
}

function sampleBezierCurve(points) {
  const bezier = points.map(point => ({
    center: [...point.location],
    left: [0, 0],
    right: [0, 0],
    handleType: point.handleType,
  }));
  for (let index = 0; index < bezier.length; index += 1) calculateHandles(bezier, index);
  correctEndpointAutoHandles(bezier);

  const samples = [];
  for (let index = 0; index < bezier.length - 1; index += 1) {
    const start = bezier[index];
    const end = bezier[index + 1];
    correctBezierSegment(start, end);
    const xSamples = forwardDifferenceBezier(
      start.center[0], start.right[0], end.left[0], end.center[0],
    );
    const ySamples = forwardDifferenceBezier(
      start.center[1], start.right[1], end.left[1], end.center[1],
    );
    for (let sample = 0; sample < CURVE_BEZIER_SAMPLES; sample += 1) {
      samples.push([xSamples[sample], ySamples[sample]]);
    }
  }
  return { bezier, samples };
}

function normalizedDirection(vector) {
  const magnitude = length2(vector);
  return magnitude === 0 ? [0, 0] : [f32(vector[0] / magnitude), f32(vector[1] / magnitude)];
}

function extendSample(x, first, last, extensionIn, extensionOut, extend) {
  if (x <= first[0]) {
    if (extend === 'HORIZONTAL') return first[1];
    if (extensionIn[0] === 0) return first[1] + (extensionIn[1] * 10_000);
    return first[1] + (extensionIn[1] * (x - first[0]) / extensionIn[0]);
  }
  if (extend === 'HORIZONTAL') return last[1];
  if (extensionOut[0] === 0) return last[1] - (extensionOut[1] * 10_000);
  return last[1] + (extensionOut[1] * (x - last[0]) / extensionOut[0]);
}

function buildTable(samples, minimum, maximum, extensionIn, extensionOut, extend) {
  const table = new Float32Array(CURVE_TABLE_SIZE);
  const first = samples[0];
  const lastIndex = samples.length - 1;
  const last = samples[lastIndex];
  const step = f32(f32(maximum - minimum) / TABLE_SEGMENTS);
  let cursor = 0;

  for (let index = 0; index < CURVE_TABLE_SIZE; index += 1) {
    const x = f32(minimum + f32(step * index));
    while (cursor !== lastIndex && x >= samples[cursor][0]) cursor += 1;
    const sample = samples[cursor];
    let value;
    if (cursor === 0 || (cursor === lastIndex && x >= sample[0])) {
      value = Math.abs(x - sample[0]) <= 1e-6
        ? sample[1]
        : extendSample(x, first, last, extensionIn, extensionOut, extend);
    } else {
      const previous = samples[cursor - 1];
      const width = f32(sample[0] - previous[0]);
      const previousWeight = width > FLOAT32_EPSILON ? f32(f32(sample[0] - x) / width) : 0;
      value = f32(
        f32(previousWeight * previous[1]) + f32(f32(1 - previousWeight) * sample[1]),
      );
    }
    table[index] = value;
  }
  return table;
}

function compileChannel(points, clip, extend) {
  const { bezier, samples } = sampleBezierCurve(points);
  const minimum = Math.min(clip.min[0], ...points.map(point => point.location[0]));
  const maximum = Math.max(clip.max[0], ...points.map(point => point.location[0]));
  const divider = f32(1 / Math.max(f32(1e-8), f32(maximum - minimum)));
  const extensionIn = normalizedDirection(subtract2(bezier[0].left, bezier[0].center));
  const extensionOut = normalizedDirection(subtract2(bezier.at(-1).center, bezier.at(-1).right));
  const startSlope = extend === 'HORIZONTAL' ? 0
    : extensionIn[0] === 0 ? 1e8 : extensionIn[1] / (extensionIn[0] * divider);
  const endSlope = extend === 'HORIZONTAL' ? 0
    : extensionOut[0] === 0 ? 1e8 : extensionOut[1] / (extensionOut[0] * divider);

  return Object.freeze({
    table: buildTable(samples, minimum, maximum, extensionIn, extensionOut, extend),
    minimum: f32(minimum),
    maximum: f32(maximum),
    divider,
    startSlope: f32(startSlope),
    endSlope: f32(endSlope),
  });
}

function packedFormat(channelCount) {
  if (channelCount === 1) return 'R';
  if (channelCount === 3) return 'RGB';
  return 'RGBA';
}

/**
 * Compile canonical CurveMapping data into per-channel 257-entry tables and
 * one four-wide row-major float payload suitable for texture pooling.
 */
export function compileCurveMapping(mapping, channelNames) {
  if (mapping === null || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new TypeError('CurveMapping mapping must be an object.');
  }
  const names = normalizeChannelNames(channelNames);
  if (!EXTEND_MODES.has(mapping.extend)) {
    throw new RangeError('CurveMapping extend must be HORIZONTAL or EXTRAPOLATED.');
  }
  if (mapping.clip === null || typeof mapping.clip !== 'object' || Array.isArray(mapping.clip)) {
    throw new TypeError('CurveMapping clip must be an object.');
  }
  if (typeof mapping.clip.enabled !== 'boolean') {
    throw new TypeError('CurveMapping clip.enabled must be a boolean.');
  }
  const clip = {
    enabled: mapping.clip.enabled,
    min: assertFinitePair(mapping.clip.min, 'CurveMapping clip.min'),
    max: assertFinitePair(mapping.clip.max, 'CurveMapping clip.max'),
  };
  if (clip.min[0] >= clip.max[0] || clip.min[1] >= clip.max[1]) {
    throw new RangeError('CurveMapping clip bounds must have non-zero ordered ranges.');
  }
  if (mapping.curves === null || typeof mapping.curves !== 'object' || Array.isArray(mapping.curves)) {
    throw new TypeError('CurveMapping curves must be an object.');
  }

  const channels = {};
  for (const name of names) {
    channels[name] = compileChannel(normalizePoints(mapping.curves[name], name), clip, mapping.extend);
  }

  const frozenNames = Object.freeze([...names]);
  const packedData = new Float32Array(CURVE_TABLE_SIZE * 4);
  for (let row = 0; row < CURVE_TABLE_SIZE; row += 1) {
    for (let channel = 0; channel < names.length; channel += 1) {
      packedData[(row * 4) + channel] = channels[names[channel]].table[row];
    }
  }
  const packed = Object.freeze({
    format: packedFormat(names.length),
    width: CURVE_TABLE_SIZE,
    componentCount: 4,
    channelCount: names.length,
    channels: frozenNames,
    channelNames: frozenNames,
    data: packedData,
  });

  return Object.freeze({
    kind: 'CompiledBlenderCurveMapping',
    extend: mapping.extend,
    tableSize: CURVE_TABLE_SIZE,
    bezierSamples: CURVE_BEZIER_SAMPLES,
    channelNames: frozenNames,
    channels: Object.freeze(channels),
    packed,
  });
}

/** Evaluate one compiled table with Blender's normalized-range extrapolation. */
export function evaluateCurveTable(channel, value) {
  if (channel === null || typeof channel !== 'object'
    || !(channel.table instanceof Float32Array) || channel.table.length !== CURVE_TABLE_SIZE) {
    throw new TypeError('evaluateCurveTable requires a compiled CurveMapping channel.');
  }
  const parameter = (Number(value) - channel.minimum) * channel.divider;
  if (parameter < 0) return channel.table[0] + (parameter * channel.startSlope);
  if (parameter > 1) return channel.table[TABLE_SEGMENTS] + ((parameter - 1) * channel.endSlope);
  const tablePosition = parameter * TABLE_SEGMENTS;
  const index = Math.floor(tablePosition);
  if (index >= TABLE_SEGMENTS) return channel.table[TABLE_SEGMENTS];
  const amount = tablePosition - index;
  return channel.table[index] + ((channel.table[index + 1] - channel.table[index]) * amount);
}

function mix(left, right, factor) {
  return left + ((right - left) * factor);
}

function compiledChannel(compiled, name) {
  const channel = compiled?.channels?.[name];
  if (!channel) throw new TypeError(`Compiled CurveMapping is missing channel "${name}".`);
  return channel;
}

export function evaluateFloatCurveMapping(compiled, value, factor = 1) {
  const source = Number(value);
  return mix(source, evaluateCurveTable(compiledChannel(compiled, 'value'), source), Number(factor));
}

export function evaluateVectorCurveMapping(compiled, vector, factor = 1) {
  if (!Array.isArray(vector) || vector.length < 3) {
    throw new TypeError('Vector Curve input must contain at least three components.');
  }
  const amount = Number(factor);
  return VECTOR_CURVE_CHANNELS.map((name, index) => {
    const source = Number(vector[index]);
    return mix(source, evaluateCurveTable(compiledChannel(compiled, name), source), amount);
  });
}

export function evaluateRgbCurveMapping(compiled, color, factor = 1) {
  if (!Array.isArray(color) || color.length < 3) {
    throw new TypeError('RGB Curve input must contain at least three components.');
  }
  const amount = Number(factor);
  const combined = compiledChannel(compiled, 'combined');
  const result = RGB_CURVE_CHANNELS.slice(0, 3).map((name, index) => {
    const source = Number(color[index]);
    const combinedValue = evaluateCurveTable(combined, source);
    const mapped = evaluateCurveTable(compiledChannel(compiled, name), combinedValue);
    return mix(source, mapped, amount);
  });
  if (color.length >= 4) result.push(color[3]);
  return result;
}
