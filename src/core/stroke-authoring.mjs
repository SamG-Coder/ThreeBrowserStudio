import { decodeDataTexturePixels, encodeDataTexturePixels, normalizeDataTextureResource } from './image-texture.mjs';
import { cloneJson, isPlainRecord } from './util.mjs';
import { recalculateVertexNormals, validateIndexedMeshRecipe } from './indexed-mesh-editing.mjs';

export const STROKE_LIMITS = Object.freeze({
  maxPoints: 2048,
  maxInstances: 8192,
  maxRadius: 1_000_000,
  maxTexturePixelsVisited: 8_000_000,
});

export const STROKE_SPACES = Object.freeze(['local', 'world', 'surface', 'uv']);
export const SCULPT_STROKE_BRUSHES = Object.freeze(['draw', 'inflate', 'crease', 'flatten', 'smooth', 'grab']);
export const STROKE_BLEND_MODES = Object.freeze(['mix', 'add', 'subtract', 'multiply', 'lighten', 'darken']);
export const STROKE_FALLOFFS = Object.freeze(['constant', 'linear', 'smooth', 'sharp', 'sphere']);

function finite(value, label, minimum = -1_000_000, maximum = 1_000_000) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite.`);
  if (value < minimum || value > maximum) throw new RangeError(`${label} must be from ${minimum} to ${maximum}.`);
  return value;
}

function vector(value, size, label, minimum = -1_000_000, maximum = 1_000_000) {
  if (!Array.isArray(value) || value.length !== size) throw new TypeError(`${label} must contain ${size} numbers.`);
  return value.map((component, index) => finite(component, `${label}[${index}]`, minimum, maximum));
}

function normalized(value, label) {
  const result = vector(value, 3, label);
  const length = Math.hypot(...result);
  if (length === 0) throw new RangeError(`${label} must not be zero.`);
  return result.map(component => component / length);
}

/** Validates and canonicalizes one reusable AI-authored brush stroke. */
export function normalizeStroke(value) {
  if (!isPlainRecord(value)) throw new TypeError('stroke must be an object.');
  const allowed = new Set(['space', 'targetEntityId', 'closed', 'defaultRadius', 'defaultStrength', 'falloff', 'points', 'metadata']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`stroke contains unknown property ${key}.`);
  const space = value.space ?? 'local';
  if (!STROKE_SPACES.includes(space)) throw new TypeError(`stroke.space must be one of ${STROKE_SPACES.join(', ')}.`);
  if (!Array.isArray(value.points) || value.points.length < 1 || value.points.length > STROKE_LIMITS.maxPoints) {
    throw new RangeError(`stroke.points must contain 1 to ${STROKE_LIMITS.maxPoints} points.`);
  }
  const defaultRadius = finite(value.defaultRadius ?? 0.1, 'stroke.defaultRadius', Number.MIN_VALUE, STROKE_LIMITS.maxRadius);
  const defaultStrength = finite(value.defaultStrength ?? 1, 'stroke.defaultStrength', 0, 1);
  const falloff = value.falloff ?? 'smooth';
  if (!STROKE_FALLOFFS.includes(falloff)) throw new TypeError(`stroke.falloff must be one of ${STROKE_FALLOFFS.join(', ')}.`);
  const points = value.points.map((point, index) => {
    if (!isPlainRecord(point)) throw new TypeError(`stroke.points[${index}] must be an object.`);
    const pointAllowed = new Set(['position', 'normal', 'radius', 'strength', 'pressure', 'color', 'opacity', 'time']);
    for (const key of Object.keys(point)) if (!pointAllowed.has(key)) throw new TypeError(`stroke.points[${index}] contains unknown property ${key}.`);
    return {
      position: vector(point.position, 3, `stroke.points[${index}].position`),
      ...(point.normal === undefined ? {} : { normal: normalized(point.normal, `stroke.points[${index}].normal`) }),
      radius: finite(point.radius ?? defaultRadius, `stroke.points[${index}].radius`, Number.MIN_VALUE, STROKE_LIMITS.maxRadius),
      strength: finite(point.strength ?? defaultStrength, `stroke.points[${index}].strength`, 0, 1),
      pressure: finite(point.pressure ?? 1, `stroke.points[${index}].pressure`, 0, 1),
      ...(point.color === undefined ? {} : { color: vector(point.color, 4, `stroke.points[${index}].color`, 0, 1) }),
      opacity: finite(point.opacity ?? 1, `stroke.points[${index}].opacity`, 0, 1),
      ...(point.time === undefined ? {} : { time: finite(point.time, `stroke.points[${index}].time`, 0, 1_000_000_000) }),
    };
  });
  return {
    space,
    ...(value.targetEntityId === undefined ? {} : { targetEntityId: value.targetEntityId }),
    closed: value.closed ?? false,
    defaultRadius,
    defaultStrength,
    falloff,
    points,
    metadata: cloneJson(value.metadata ?? {}),
  };
}

function mix(left, right, amount) {
  return left.map((value, index) => value + (right[index] - value) * amount);
}

function closestOnSegment(point, first, second) {
  const delta = second.position.map((value, axis) => value - first.position[axis]);
  const lengthSquared = delta.reduce((sum, value) => sum + value * value, 0);
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
    delta.reduce((sum, value, axis) => sum + (point[axis] - first.position[axis]) * value, 0) / lengthSquared));
  const center = first.position.map((value, axis) => value + delta[axis] * t);
  const distance = Math.hypot(...point.map((value, axis) => value - center[axis]));
  const normal = first.normal && second.normal ? normalized(mix(first.normal, second.normal, t), 'interpolated normal') : (first.normal ?? second.normal);
  return {
    distance,
    center,
    tangent: lengthSquared === 0 ? [1, 0, 0] : delta.map(value => value / Math.sqrt(lengthSquared)),
    radius: first.radius + (second.radius - first.radius) * t,
    strength: first.strength + (second.strength - first.strength) * t,
    pressure: first.pressure + (second.pressure - first.pressure) * t,
    opacity: first.opacity + (second.opacity - first.opacity) * t,
    color: first.color && second.color ? mix(first.color, second.color, t) : (first.color ?? second.color),
    normal,
  };
}

export function closestStrokeSample(position, strokeValue) {
  const stroke = strokeValue.points ? strokeValue : normalizeStroke(strokeValue);
  if (stroke.points.length === 1) return closestOnSegment(position, stroke.points[0], stroke.points[0]);
  const segments = stroke.closed
    ? stroke.points.map((point, index) => [point, stroke.points[(index + 1) % stroke.points.length]])
    : stroke.points.slice(0, -1).map((point, index) => [point, stroke.points[index + 1]]);
  let closest = null;
  for (const [first, second] of segments) {
    const candidate = closestOnSegment(position, first, second);
    if (!closest || candidate.distance < closest.distance) closest = candidate;
  }
  return closest;
}

export function strokeFalloff(distance, radius, mode = 'smooth') {
  if (distance > radius) return 0;
  const t = radius === 0 ? 0 : distance / radius;
  if (mode === 'constant') return 1;
  if (mode === 'sharp') return (1 - t) ** 2;
  if (mode === 'sphere') return Math.sqrt(Math.max(0, 1 - t * t));
  if (mode === 'smooth') return 1 - (3 * t * t - 2 * t * t * t);
  return 1 - t;
}

function adjacency(vertexCount, indices) {
  const result = Array.from({ length: vertexCount }, () => new Set());
  for (let offset = 0; offset < indices.length; offset += 3) {
    const tri = indices.slice(offset, offset + 3);
    for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
      result[a].add(b); result[b].add(a);
    }
  }
  return result;
}

/** Applies a complete bounded sculpt stroke in one geometry edit command. */
export function sculptIndexedMeshWithStroke(recipe, command = {}) {
  const mesh = recalculateVertexNormals(validateIndexedMeshRecipe(recipe));
  const stroke = normalizeStroke(command.stroke);
  if (!['local'].includes(stroke.space)) throw new TypeError('sculptStroke requires a local-space stroke after operation lowering.');
  const brush = command.brush ?? 'draw';
  if (!SCULPT_STROKE_BRUSHES.includes(brush)) throw new TypeError(`Unsupported sculpt stroke brush ${brush}.`);
  const amount = finite(command.amount ?? 0.1, 'amount', -10_000, 10_000);
  const direction = command.direction === undefined ? null : normalized(command.direction, 'direction');
  if (brush === 'grab' && !direction) throw new TypeError('grab sculpt strokes require direction.');
  const selected = command.selection === 'all' || command.vertexIndices === undefined
    ? new Set(Array.from({ length: mesh.positions.length / 3 }, (_, index) => index))
    : new Set(command.vertexIndices);
  const graph = brush === 'smooth' ? adjacency(mesh.positions.length / 3, mesh.indices) : null;
  const before = [...mesh.positions];
  const next = [...before];
  for (const vertexIndex of selected) {
    if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= before.length / 3) throw new RangeError(`Invalid sculpt vertex index ${vertexIndex}.`);
    const offset = vertexIndex * 3;
    const position = before.slice(offset, offset + 3);
    const sample = closestStrokeSample(position, stroke);
    const influence = strokeFalloff(sample.distance, sample.radius, command.falloff ?? stroke.falloff)
      * sample.strength * sample.pressure;
    if (influence === 0) continue;
    const normal = mesh.normals.slice(offset, offset + 3);
    let result = position;
    if (brush === 'draw' || brush === 'inflate') result = position.map((value, axis) => value + normal[axis] * amount * influence);
    if (brush === 'grab') result = position.map((value, axis) => value + direction[axis] * amount * influence);
    if (brush === 'flatten') {
      const planeNormal = sample.normal ?? normal;
      const signed = position.reduce((sum, value, axis) => sum + (value - sample.center[axis]) * planeNormal[axis], 0);
      result = position.map((value, axis) => value - planeNormal[axis] * signed * Math.min(1, Math.abs(amount)) * influence);
    }
    if (brush === 'crease') {
      const radial = sample.center.map((value, axis) => value - position[axis]);
      const radialLength = Math.hypot(...radial) || 1;
      result = position.map((value, axis) => value
        - normal[axis] * Math.abs(amount) * influence * 0.5
        + radial[axis] / radialLength * Math.abs(amount) * influence * 0.35);
    }
    if (brush === 'smooth') {
      const neighbours = graph[vertexIndex];
      if (neighbours.size > 0) {
        const average = [0, 0, 0];
        for (const neighbour of neighbours) for (let axis = 0; axis < 3; axis += 1) average[axis] += before[neighbour * 3 + axis];
        result = position.map((value, axis) => value + (average[axis] / neighbours.size - value) * Math.min(1, Math.abs(amount)) * influence);
      }
    }
    for (let axis = 0; axis < 3; axis += 1) next[offset + axis] = finite(result[axis], `result.positions[${vertexIndex}][${axis}]`);
  }
  mesh.positions = next;
  delete mesh.normals;
  return mesh;
}

/** Sculpts editable polygon vertices while preserving polygon/corner topology and layers. */
export function sculptEditableMeshWithStroke(recipe, command = {}) {
  if (!isPlainRecord(recipe) || recipe.kind !== 'editableMesh') throw new TypeError('Expected an editableMesh recipe.');
  const indices = [];
  for (let faceIndex = 0; faceIndex < recipe.faceOffsets.length - 1; faceIndex += 1) {
    const start = recipe.faceOffsets[faceIndex];
    const end = recipe.faceOffsets[faceIndex + 1];
    const vertices = recipe.cornerVertexIndices.slice(start, end);
    for (let index = 1; index < vertices.length - 1; index += 1) indices.push(vertices[0], vertices[index], vertices[index + 1]);
  }
  const sculpted = sculptIndexedMeshWithStroke({
    kind: 'indexedMesh', positions: recipe.positions, indices, computeNormals: true,
  }, command);
  return { ...cloneJson(recipe), positions: sculpted.positions };
}

function blendScalar(before, target, amount, mode) {
  if (mode === 'add') return before + target * amount;
  if (mode === 'subtract') return before - target * amount;
  if (mode === 'multiply') return before * (1 + (target - 1) * amount);
  if (mode === 'lighten') return Math.max(before, before + (target - before) * amount);
  if (mode === 'darken') return Math.min(before, before + (target - before) * amount);
  return before + (target - before) * amount;
}

export function paintEditableMeshColorStroke(recipe, command = {}) {
  const stroke = normalizeStroke(command.stroke);
  if (stroke.space !== 'local') throw new TypeError('paintColorStroke requires a local-space stroke after operation lowering.');
  const mode = command.blend ?? 'mix';
  if (!STROKE_BLEND_MODES.includes(mode)) throw new TypeError(`Unsupported stroke blend mode ${mode}.`);
  const mesh = cloneJson(recipe);
  const layer = command.layer;
  if (typeof layer !== 'string' || !mesh.colorLayers?.[layer]) throw new RangeError(`Unknown color layer ${String(layer)}.`);
  const values = [...mesh.colorLayers[layer]];
  const target = vector(command.color ?? [1, 1, 1, 1], 4, 'color', 0, 1);
  const opacity = finite(command.opacity ?? 1, 'opacity', 0, 1);
  for (let cornerIndex = 0; cornerIndex < mesh.cornerVertexIndices.length; cornerIndex += 1) {
    const vertexIndex = mesh.cornerVertexIndices[cornerIndex];
    const position = mesh.positions.slice(vertexIndex * 3, vertexIndex * 3 + 3);
    const sample = closestStrokeSample(position, stroke);
    const influence = strokeFalloff(sample.distance, sample.radius, command.falloff ?? stroke.falloff)
      * sample.strength * sample.pressure * sample.opacity * opacity;
    const color = sample.color ?? target;
    for (let channel = 0; channel < 4; channel += 1) {
      const offset = cornerIndex * 4 + channel;
      values[offset] = Math.max(0, Math.min(1, blendScalar(values[offset], color[channel], influence, mode)));
    }
  }
  mesh.colorLayers[layer] = values;
  if (command.setActive !== false) mesh.activeColorLayer = layer;
  return mesh;
}

/** Paints a UV-space stroke into an existing canonical inline data texture. */
export function paintDataTextureStroke(resource, strokeValue, options = {}) {
  const recipe = normalizeDataTextureResource(resource?.recipe ?? resource?.parameters ?? resource);
  const stroke = normalizeStroke(strokeValue);
  if (stroke.space !== 'uv') throw new TypeError('Texture painting requires stroke.space uv.');
  const pixels = decodeDataTexturePixels(recipe);
  const mode = options.blend ?? 'mix';
  if (!STROKE_BLEND_MODES.includes(mode)) throw new TypeError(`Unsupported texture stroke blend mode ${mode}.`);
  if (recipe.width * recipe.height * stroke.points.length > STROKE_LIMITS.maxTexturePixelsVisited) {
    throw new RangeError('Texture stroke exceeds the bounded paint work budget.');
  }
  const authored = options.color ?? [1, 1, 1, 1];
  const target = vector(authored, 4, 'color', 0, 1);
  const opacity = finite(options.opacity ?? 1, 'opacity', 0, 1);
  const channel = options.channel ?? 'rgba';
  const channelMap = { r: [0], g: [1], b: [2], a: [3], rgba: [0, 1, 2, 3] };
  if (!channelMap[channel]) throw new TypeError('channel must be r, g, b, a, or rgba.');
  for (let y = 0; y < recipe.height; y += 1) {
    for (let x = 0; x < recipe.width; x += 1) {
      const uv = [(x + 0.5) / recipe.width, (y + 0.5) / recipe.height, 0];
      const sample = closestStrokeSample(uv, stroke);
      const influence = strokeFalloff(sample.distance, sample.radius, options.falloff ?? stroke.falloff)
        * sample.strength * sample.pressure * sample.opacity * opacity;
      if (influence === 0) continue;
      const color = sample.color ?? target;
      for (const component of channelMap[channel]) {
        if (component >= recipe.channels) continue;
        const offset = (y * recipe.width + x) * recipe.channels + component;
        pixels[offset] = Math.round(Math.max(0, Math.min(1,
          blendScalar(pixels[offset] / 255, color[component], influence, mode),
        )) * 255);
      }
    }
  }
  return { ...recipe, data: encodeDataTexturePixels(pixels), pixels: undefined };
}

function randomFactory(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normalEuler(normal, twist = 0) {
  const n = normalized(normal, 'orientation normal');
  return [Math.atan2(-n[1], n[2]), Math.atan2(n[0], Math.hypot(n[1], n[2])), twist];
}

/** Converts a stroke to explicit canonical instance transforms. */
export function strokeInstanceTransforms(strokeValue, options = {}) {
  const stroke = normalizeStroke(strokeValue);
  if (!['local'].includes(stroke.space)) throw new TypeError('Stroke scatter requires local-space points after operation lowering.');
  const spacing = finite(options.spacing ?? stroke.defaultRadius * 2, 'spacing', Number.MIN_VALUE, STROKE_LIMITS.maxRadius);
  const maximum = Math.min(STROKE_LIMITS.maxInstances, options.count ?? STROKE_LIMITS.maxInstances);
  const random = randomFactory(options.seed ?? 0);
  const samples = [];
  const points = stroke.closed ? [...stroke.points, stroke.points[0]] : stroke.points;
  if (points.length === 1) samples.push({ ...points[0], tangent: [1, 0, 0] });
  for (let index = 0; index < points.length - 1 && samples.length < maximum; index += 1) {
    const first = points[index]; const second = points[index + 1];
    const delta = second.position.map((value, axis) => value - first.position[axis]);
    const length = Math.hypot(...delta);
    const count = Math.max(1, Math.floor(length / spacing));
    for (let step = index === 0 ? 0 : 1; step <= count && samples.length < maximum; step += 1) {
      const t = count === 0 ? 0 : step / count;
      samples.push({
        position: mix(first.position, second.position, t),
        normal: first.normal && second.normal ? normalized(mix(first.normal, second.normal, t), 'instance normal') : (first.normal ?? second.normal),
        tangent: length === 0 ? [1, 0, 0] : delta.map(value => value / length),
        pressure: first.pressure + (second.pressure - first.pressure) * t,
      });
    }
  }
  const scaleMin = vector(options.scaleMin ?? [1, 1, 1], 3, 'scaleMin', Number.MIN_VALUE, 1_000_000);
  const scaleMax = vector(options.scaleMax ?? scaleMin, 3, 'scaleMax', Number.MIN_VALUE, 1_000_000);
  const jitter = finite(options.jitter ?? 0, 'jitter', 0, STROKE_LIMITS.maxRadius);
  const orientation = options.orientation ?? 'keep';
  if (!['keep', 'tangent', 'normal', 'gravity'].includes(orientation)) throw new TypeError('Invalid stroke scatter orientation.');
  const gravity = normalized(options.gravity ?? [0, -1, 0], 'gravity').map(value => -value);
  return samples.map(sample => {
    const twist = (random() * 2 - 1) * (options.rotationJitter ?? 0);
    const position = sample.position.map(value => value + (random() * 2 - 1) * jitter);
    const basis = orientation === 'normal' ? (sample.normal ?? [0, 0, 1])
      : orientation === 'gravity' ? gravity
        : orientation === 'tangent' ? sample.tangent : null;
    return {
      position,
      rotation: basis ? normalEuler(basis, twist) : [0, 0, twist],
      scale: scaleMin.map((value, axis) => (value + (scaleMax[axis] - value) * random()) * sample.pressure),
    };
  });
}
