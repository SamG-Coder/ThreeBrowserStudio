import {
  clamp01,
  combineSeeds,
  hashFloatUnit,
} from './procedural-texture-noise.mjs';

const GRADIENT_SALTS = Object.freeze([0x68bc21eb, 0x02e5be93, 0x967a889b, 0x368cc8b7]);
const WARP_SALTS = Object.freeze([0xa341316c, 0xc8013ea4, 0xad90777d, 0x7e95761e]);
const MAX_DIMENSIONS = 4;
export const MAX_CPU_VORONOI_CANDIDATE_VISITS = 2500;

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function mix(left, right, amount) {
  return left + ((right - left) * amount);
}

function fade(value) {
  return value * value * value * (value * ((value * 6) - 15) + 10);
}

function smoothstep(value) {
  const bounded = clamp01(value);
  return bounded * bounded * (3 - (2 * bounded));
}

function dimensionsCount(value) {
  const count = Number.parseInt(String(value ?? '3D'), 10);
  if (!Number.isInteger(count) || count < 1 || count > MAX_DIMENSIONS) {
    throw new RangeError(`Dimensions must be 1D, 2D, 3D, or 4D; received ${value}.`);
  }
  return count;
}

function coordinateForDimensions(vector, w, dimensions) {
  const source = Array.isArray(vector) ? vector : [finite(vector)];
  if (dimensions === 1) return [finite(w)];
  return Array.from({ length: dimensions }, (_, index) => (
    index === 3 ? finite(w) : finite(source[index])
  ));
}

function gradient(cell, dimensions, seed) {
  const values = Array.from({ length: dimensions }, (_, index) => (
    (hashFloatUnit(cell, combineSeeds(seed, GRADIENT_SALTS[index])) * 2) - 1
  ));
  const length = Math.hypot(...values);
  if (length <= 1e-12) return Array.from({ length: dimensions }, (_, index) => index === 0 ? 1 : 0);
  return values.map(value => value / length);
}

/** Deterministic 1D-4D gradient noise in an approximately -1..1 range. */
export function gradientNoiseND(coordinate, seed = 0) {
  const dimensions = coordinate.length;
  if (dimensions < 1 || dimensions > MAX_DIMENSIONS) throw new RangeError('gradientNoiseND accepts 1 to 4 coordinates.');
  const lattice = coordinate.map(Math.floor);
  const fraction = coordinate.map((value, index) => value - lattice[index]);
  const faded = fraction.map(fade);
  let result = 0;
  const cornerCount = 2 ** dimensions;
  for (let corner = 0; corner < cornerCount; corner += 1) {
    const offset = Array.from({ length: dimensions }, (_, index) => (corner >> index) & 1);
    const cell = lattice.map((value, index) => value + offset[index]);
    const delta = fraction.map((value, index) => value - offset[index]);
    const sample = gradient(cell, dimensions, seed)
      .reduce((sum, value, index) => sum + (value * delta[index]), 0);
    const weight = faded.reduce((product, amount, index) => (
      product * (offset[index] ? amount : 1 - amount)
    ), 1);
    result += sample * weight;
  }
  return result;
}

function fractalNoise(coordinate, octaves, lacunarity, roughness, seed) {
  let sampleCoordinate = [...coordinate];
  let amplitude = 1;
  let amplitudeTotal = 0;
  let result = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    result += gradientNoiseND(sampleCoordinate, combineSeeds(seed, octave)) * amplitude;
    amplitudeTotal += amplitude;
    sampleCoordinate = sampleCoordinate.map(value => value * lacunarity);
    amplitude *= roughness;
  }
  return ((result / Math.max(amplitudeTotal, 1e-7)) * 0.5) + 0.5;
}

function noiseChannel(coordinate, {
  mode,
  octaves,
  lacunarity,
  roughness,
  offset,
  gain,
  normalize,
  seed,
}) {
  if (mode === 'FBM') return fractalNoise(coordinate, octaves, lacunarity, roughness, seed);
  if (mode === 'MULTIFRACTAL') {
    let sampleCoordinate = [...coordinate];
    let power = 1;
    let result = 1;
    for (let octave = 0; octave < octaves; octave += 1) {
      result *= 1 + (gradientNoiseND(sampleCoordinate, combineSeeds(seed, octave)) * power);
      sampleCoordinate = sampleCoordinate.map(value => value * lacunarity);
      power *= roughness;
    }
    return result;
  }
  if (mode === 'HYBRID_MULTIFRACTAL') {
    let sampleCoordinate = [...coordinate];
    let power = 1;
    let result = 0;
    let weight = 1;
    for (let octave = 0; octave < octaves; octave += 1) {
      weight = clamp01(weight);
      const signal = (gradientNoiseND(sampleCoordinate, combineSeeds(seed, octave)) + offset) * power;
      result += weight * signal;
      weight *= gain * signal;
      sampleCoordinate = sampleCoordinate.map(value => value * lacunarity);
      power *= roughness;
    }
    return result;
  }
  if (mode === 'RIDGED_MULTIFRACTAL') {
    let sampleCoordinate = [...coordinate];
    let amplitude = 1;
    let amplitudeTotal = 0;
    let result = 0;
    let weight = 1;
    for (let octave = 0; octave < octaves; octave += 1) {
      let ridge = 1 - Math.abs(gradientNoiseND(sampleCoordinate, combineSeeds(seed, octave)));
      ridge = ridge * ridge * weight;
      result += ridge * amplitude;
      amplitudeTotal += amplitude;
      weight = clamp01(ridge * gain);
      sampleCoordinate = sampleCoordinate.map(value => value * lacunarity);
      amplitude *= roughness;
    }
    return normalize ? result / Math.max(amplitudeTotal, 1e-7) : result;
  }
  if (mode === 'HETERO_TERRAIN') {
    let sampleCoordinate = [...coordinate];
    let result = (gradientNoiseND(sampleCoordinate, seed) * 0.5) + 0.5 + offset;
    let amplitude = roughness;
    for (let octave = 1; octave < octaves; octave += 1) {
      sampleCoordinate = sampleCoordinate.map(value => value * lacunarity);
      const signal = (gradientNoiseND(sampleCoordinate, combineSeeds(seed, octave)) * 0.5) + 0.5 + offset;
      result += signal * amplitude * result * gain;
      amplitude *= roughness;
    }
    return result;
  }
  throw new RangeError(`Unsupported Noise Texture mode ${mode}.`);
}

export function blenderNoiseND(vector, options = {}) {
  const dimensions = dimensionsCount(options.dimensions);
  const scale = finite(options.scale, 5);
  const octaves = Math.max(1, Math.min(8, Math.round(finite(options.detail, 2))));
  const roughness = Math.min(1, Math.max(0, finite(options.roughness, 0.5)));
  const lacunarity = Math.max(0, finite(options.lacunarity, 2));
  const offset = finite(options.offset);
  const gain = finite(options.gain, 1);
  const distortion = Math.max(0, finite(options.distortion));
  const normalize = options.normalize !== false;
  const mode = String(options.noiseType ?? 'FBM').toUpperCase();
  const seed = Number.isInteger(options.seed) ? options.seed : 0;
  let coordinate = coordinateForDimensions(vector, options.w, dimensions).map(value => value * scale);
  if (distortion !== 0) {
    const source = [...coordinate];
    coordinate = coordinate.map((value, index) => (
      value + (gradientNoiseND(source, combineSeeds(seed, WARP_SALTS[index])) * distortion)
    ));
  }
  const channelOptions = { mode, octaves, lacunarity, roughness, offset, gain, normalize, seed };
  let factor = noiseChannel(coordinate, channelOptions);
  if (normalize) factor = clamp01(factor);
  const color = [factor, 19.17, 47.53].map((entry, index) => {
    if (index === 0) return entry;
    const value = noiseChannel(coordinate.map(component => component + entry), {
      ...channelOptions,
      seed: combineSeeds(seed, index),
    });
    return normalize ? clamp01(value) : value;
  });
  return Object.freeze({ factor, color: Object.freeze(color) });
}

function neighborOffsets(dimensions, radius) {
  const result = [];
  const visit = (values) => {
    if (values.length === dimensions) {
      result.push(values);
      return;
    }
    for (let offset = -radius; offset <= radius; offset += 1) visit([...values, offset]);
  };
  visit([]);
  return result;
}

function voronoiDistance(delta, metric, exponent) {
  const values = delta.map(Math.abs);
  switch (metric) {
    case 'MANHATTAN': return values.reduce((sum, value) => sum + value, 0);
    case 'CHEBYCHEV': return Math.max(...values);
    case 'MINKOWSKI': {
      const power = Math.max(exponent, 1e-6);
      return values.reduce((sum, value) => sum + (value ** power), 0) ** (1 / power);
    }
    case 'EUCLIDEAN': return Math.hypot(...values);
    default: throw new RangeError(`Unsupported Voronoi metric ${metric}.`);
  }
}

function featurePoint(cell, dimensions, randomness, seed) {
  return Array.from({ length: dimensions }, (_, index) => (
    cell[index] + mix(0.5, hashFloatUnit(cell, combineSeeds(seed, GRADIENT_SALTS[index])), randomness)
  ));
}

function scanVoronoiOctave(coordinate, options) {
  const {
    dimensions, feature, metric, exponent, randomness, smoothness, seed,
  } = options;
  const smooth = feature === 'SMOOTH_F1';
  const baseCell = coordinate.map(Math.floor);
  const featureMetric = ['DISTANCE_TO_EDGE', 'N_SPHERE_RADIUS'].includes(feature) ? 'EUCLIDEAN' : metric;
  let first = Infinity;
  let second = Infinity;
  let smoothDistance = 1e6;
  let nearestPoint = Array(dimensions).fill(0);
  let nearestCell = Array(dimensions).fill(0);
  const smoothing = Math.min(0.5, Math.max(0, smoothness * 0.5));
  for (const offset of neighborOffsets(dimensions, smooth ? 2 : 1)) {
    const cell = baseCell.map((value, index) => value + offset[index]);
    const point = featurePoint(cell, dimensions, randomness, seed);
    const distance = voronoiDistance(point.map((value, index) => value - coordinate[index]), featureMetric, exponent);
    if (distance < first) {
      second = first;
      first = distance;
      nearestPoint = point;
      nearestCell = cell;
    } else if (distance < second) second = distance;
    if (smooth) {
      const amount = smoothstep(0.5 + (0.5 * (smoothDistance - distance) / Math.max(smoothing, 1e-7)));
      smoothDistance = mix(smoothDistance, distance, amount) - (smoothing * amount * (1 - amount));
    }
  }

  let distance = first;
  if (feature === 'F2') distance = second;
  else if (feature === 'SMOOTH_F1') distance = smoothing >= 1e-7 ? smoothDistance : first;
  else if (feature === 'DISTANCE_TO_EDGE') {
    let edge = Infinity;
    for (const offset of neighborOffsets(dimensions, 1)) {
      const cell = baseCell.map((value, index) => value + offset[index]);
      const point = featurePoint(cell, dimensions, randomness, seed);
      const difference = point.map((value, index) => value - nearestPoint[index]);
      const differenceLength = Math.hypot(...difference);
      if (differenceLength <= 1e-7) continue;
      const midpoint = point.map((value, index) => ((value + nearestPoint[index]) * 0.5) - coordinate[index]);
      const projected = Math.abs(midpoint.reduce((sum, value, index) => (
        sum + (value * difference[index] / differenceLength)
      ), 0));
      edge = Math.min(edge, projected);
    }
    distance = edge;
  } else if (feature === 'N_SPHERE_RADIUS') {
    let diameter = Infinity;
    for (const offset of neighborOffsets(dimensions, 1)) {
      const cell = nearestCell.map((value, index) => value + offset[index]);
      const point = featurePoint(cell, dimensions, randomness, seed);
      const candidate = Math.hypot(...point.map((value, index) => value - nearestPoint[index]));
      if (candidate > 1e-7) diameter = Math.min(diameter, candidate);
    }
    distance = diameter * 0.5;
  } else if (!['F1', 'F2', 'SMOOTH_F1'].includes(feature)) {
    throw new RangeError(`Unsupported Voronoi feature ${feature}.`);
  }

  const cellValue = hashFloatUnit(nearestCell, combineSeeds(seed, 0x7f4a7c15));
  return {
    distance,
    first,
    second,
    nearestPoint,
    nearestCell,
    color: [
      cellValue,
      hashFloatUnit(nearestCell, combineSeeds(seed, 0x9e3779b9)),
      hashFloatUnit(nearestCell, combineSeeds(seed, 0x243f6a88)),
    ],
  };
}

export function blenderVoronoiND(vector, options = {}) {
  const dimensions = dimensionsCount(options.dimensions);
  const feature = String(options.feature ?? 'F1').toUpperCase();
  const metric = String(options.distanceMetric ?? options.metric ?? 'EUCLIDEAN').toUpperCase();
  const detail = Math.max(0, Math.min(7, Math.floor(finite(options.detail))));
  const octaves = feature === 'N_SPHERE_RADIUS' ? 1 : detail + 1;
  const radius = feature === 'SMOOTH_F1' ? 2 : 1;
  const passes = ['DISTANCE_TO_EDGE', 'N_SPHERE_RADIUS'].includes(feature) ? 2 : 1;
  const candidateVisits = (((radius * 2) + 1) ** dimensions) * passes * octaves;
  const limit = options.maxCandidateVisits ?? MAX_CPU_VORONOI_CANDIDATE_VISITS;
  if (candidateVisits > limit) {
    const error = new RangeError(`Voronoi requires ${candidateVisits} feature visits; the limit is ${limit}.`);
    error.code = 'procedural_node_budget_exceeded';
    error.details = { candidateVisits, limit, dimensions, feature, octaves };
    throw error;
  }
  const scale = finite(options.scale, 5);
  const coordinate = coordinateForDimensions(vector, options.w, dimensions).map(value => value * scale);
  const randomness = clamp01(finite(options.randomness, 1));
  const exponent = Math.max(0, finite(options.exponent, 0.5));
  const smoothness = clamp01(finite(options.smoothness, 1));
  const lacunarity = Math.max(0, finite(options.lacunarity, 2));
  const roughness = clamp01(finite(options.roughness, 0.5));
  const seed = Number.isInteger(options.seed) ? options.seed : 0;
  let frequency = 1;
  let amplitude = 1;
  let amplitudeTotal = 0;
  let distance = 0;
  let base = null;
  for (let octave = 0; octave < octaves; octave += 1) {
    const sample = scanVoronoiOctave(coordinate.map(value => value * frequency), {
      dimensions, feature, metric, exponent, randomness, smoothness,
      seed: combineSeeds(seed, octave),
    });
    base ??= sample;
    distance += sample.distance * amplitude;
    amplitudeTotal += amplitude;
    frequency *= lacunarity;
    amplitude *= roughness;
  }
  distance /= Math.max(amplitudeTotal, 1e-7);
  if (options.normalize === true && feature !== 'N_SPHERE_RADIUS') distance = clamp01(distance);
  const position = [...base.nearestPoint, 0, 0, 0, 0];
  return Object.freeze({
    distance,
    color: Object.freeze([...base.color]),
    position: Object.freeze(position.slice(0, 3)),
    w: position[3],
    radius: feature === 'N_SPHERE_RADIUS' ? distance : base.first,
    candidateVisits,
  });
}
