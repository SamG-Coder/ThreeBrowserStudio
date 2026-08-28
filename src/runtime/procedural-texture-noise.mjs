export function clamp01(value) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function fade(value) {
  return value * value * value * (value * ((value * 6) - 15) + 10);
}

function mix(a, b, amount) {
  return a + ((b - a) * amount);
}

/** Stable 32-bit lattice hash. It never touches Math.random(). */
export function hashLattice(x, y, seed = 0) {
  let value = (seed >>> 0)
    ^ Math.imul(Math.trunc(x), 0x9e3779b1)
    ^ Math.imul(Math.trunc(y), 0x85ebca77);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

export function hashUnit(x, y, seed = 0) {
  return hashLattice(x, y, seed) / 0xffffffff;
}

export function combineSeeds(...seeds) {
  let value = 0x811c9dc5;
  for (const seed of seeds) {
    value ^= Number(seed) >>> 0;
    value = Math.imul(value, 0x01000193);
    value ^= value >>> 16;
  }
  return value >>> 0;
}

const FLOAT_BITS_BUFFER = new ArrayBuffer(4);
const FLOAT_BITS_VIEW = new DataView(FLOAT_BITS_BUFFER);

/** Stable float-coordinate hash used by Blender-style White Noise and cells. */
export function hashFloatUnit(values, seed = 0) {
  const bits = [seed];
  for (const value of values) {
    FLOAT_BITS_VIEW.setFloat32(0, Number.isFinite(value) ? value : 0, true);
    bits.push(FLOAT_BITS_VIEW.getUint32(0, true));
  }
  return combineSeeds(...bits) / 0xffffffff;
}

export function valueNoise2D(x, y, seed = 0) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = fade(x - x0);
  const ty = fade(y - y0);
  const a = hashUnit(x0, y0, seed);
  const b = hashUnit(x0 + 1, y0, seed);
  const c = hashUnit(x0, y0 + 1, seed);
  const d = hashUnit(x0 + 1, y0 + 1, seed);
  return mix(mix(a, b, tx), mix(c, d, tx), ty);
}

export function fbm2D(x, y, {
  seed = 0,
  octaves = 4,
  lacunarity = 2,
  gain = 0.5,
  distortion = 0,
} = {}) {
  const boundedOctaves = Math.max(1, Math.min(12, Math.trunc(octaves) || 1));
  let sampleX = x;
  let sampleY = y;
  if (distortion !== 0) {
    const warpX = valueNoise2D(x + 17.17, y - 9.31, combineSeeds(seed, 0xa341316c)) - 0.5;
    const warpY = valueNoise2D(x - 4.73, y + 23.41, combineSeeds(seed, 0xc8013ea4)) - 0.5;
    sampleX += warpX * distortion;
    sampleY += warpY * distortion;
  }
  let frequency = 1;
  let amplitude = 1;
  let value = 0;
  let weight = 0;
  for (let octave = 0; octave < boundedOctaves; octave += 1) {
    value += valueNoise2D(
      sampleX * frequency,
      sampleY * frequency,
      combineSeeds(seed, octave * 0x9e3779b1),
    ) * amplitude;
    weight += amplitude;
    frequency *= Math.max(1, lacunarity);
    amplitude *= Math.min(1, Math.max(0, gain));
  }
  return weight > 0 ? value / weight : 0;
}

function metricDistance(dx, dy, metric) {
  switch (metric) {
    case 'manhattan': return Math.abs(dx) + Math.abs(dy);
    case 'chebychev':
    case 'chebyshev': return Math.max(Math.abs(dx), Math.abs(dy));
    case 'squared': return (dx * dx) + (dy * dy);
    default: return Math.hypot(dx, dy);
  }
}

/** Returns F1, F2 and a deterministic nearest-cell value. */
export function voronoi2D(x, y, {
  seed = 0,
  randomness = 1,
  metric = 'euclidean',
} = {}) {
  const baseX = Math.floor(x);
  const baseY = Math.floor(y);
  const jitter = clamp01(randomness);
  let first = Infinity;
  let second = Infinity;
  let nearestCell = 0;
  for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
    for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
      const cellX = baseX + offsetX;
      const cellY = baseY + offsetY;
      const pointX = cellX + mix(0.5, hashUnit(cellX, cellY, combineSeeds(seed, 0x68bc21eb)), jitter);
      const pointY = cellY + mix(0.5, hashUnit(cellX, cellY, combineSeeds(seed, 0x02e5be93)), jitter);
      const distance = metricDistance(pointX - x, pointY - y, metric);
      if (distance < first) {
        second = first;
        first = distance;
        nearestCell = hashUnit(cellX, cellY, combineSeeds(seed, 0x967a889b));
      } else if (distance < second) second = distance;
    }
  }
  return Object.freeze({
    f1: first,
    f2: second,
    edge: Math.max(0, second - first),
    cell: nearestCell,
  });
}

function fract(value) {
  return value - Math.floor(value);
}

export function wave2D(x, y, {
  scale = 5,
  distortion = 0,
  detail = 2,
  detailScale = 1,
  detailRoughness = 0.5,
  phase = 0,
  direction = 'x',
  waveType = 'bands',
  profile = 'sine',
  seed = 0,
} = {}) {
  let coordinate;
  if (String(waveType).toLowerCase() === 'rings') coordinate = Math.hypot(x, y);
  else {
    switch (String(direction).toLowerCase()) {
      case 'y': coordinate = y; break;
      case 'diagonal': coordinate = (x + y) * Math.SQRT1_2; break;
      default: coordinate = x; break;
    }
  }
  if (distortion !== 0) {
    coordinate += (fbm2D(x * detailScale, y * detailScale, {
      seed,
      octaves: detail,
      gain: detailRoughness,
    }) - 0.5) * distortion;
  }
  const value = (coordinate * scale) + phase;
  switch (String(profile).toLowerCase()) {
    case 'saw':
    case 'sawtooth': return fract(value);
    case 'tri':
    case 'triangle': return 1 - Math.abs((2 * fract(value)) - 1);
    default: return 0.5 + (0.5 * Math.sin(value * Math.PI * 2));
  }
}

function smoothstep(value) {
  return value * value * (3 - (2 * value));
}

/** Samples canonical Color Ramp stops in linear working space. */
export function sampleColorRamp(stops, value, interpolation = 'linear') {
  if (!Array.isArray(stops) || stops.length === 0) return [0, 0, 0, 1];
  const normalized = stops.map(stop => ({
    position: Number(stop.position),
    color: [...stop.color, 1].slice(0, 4),
  }));
  if (value <= normalized[0].position) return [...normalized[0].color];
  const last = normalized.at(-1);
  if (value >= last.position) return [...last.color];
  let rightIndex = 1;
  while (rightIndex < normalized.length && value > normalized[rightIndex].position) rightIndex += 1;
  const left = normalized[rightIndex - 1];
  const right = normalized[rightIndex];
  if (String(interpolation).toLowerCase() === 'constant') return [...left.color];
  const span = right.position - left.position;
  let amount = span > 0 ? (value - left.position) / span : 0;
  if (['smooth', 'smoothstep', 'ease', 'cardinal', 'b_spline', 'bspline'].includes(String(interpolation).toLowerCase())) amount = smoothstep(amount);
  return left.color.map((component, index) => mix(component, right.color[index], amount));
}
