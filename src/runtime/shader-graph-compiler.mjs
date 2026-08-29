import { principledFeatureFlags } from '../graphs/live-sockets.mjs';
import { assertValidGraph } from '../graphs/validator.mjs';

const TYPE_ALIASES = Object.freeze({
  ShaderNodeValue: 'blender.value',
  ShaderNodeRGB: 'blender.rgb',
  NodeReroute: 'blender.reroute',
  ShaderNodeTexCoord: 'blender.textureCoordinate',
  ShaderNodeSeparateXYZ: 'blender.separateXYZ',
  ShaderNodeCombineXYZ: 'blender.combineXYZ',
  ShaderNodeMapping: 'blender.mapping',
  ShaderNodeTexChecker: 'blender.checkerTexture',
  ShaderNodeTexGradient: 'blender.gradientTexture',
  ShaderNodeTexWhiteNoise: 'blender.whiteNoiseTexture',
  ShaderNodeTexMagic: 'blender.magicTexture',
  ShaderNodeTexBrick: 'blender.brickTexture',
  ShaderNodeMath: 'blender.math',
  ShaderNodeVectorMath: 'blender.vectorMath',
  ShaderNodeTexNoise: 'blender.noiseTexture',
  ShaderNodeTexVoronoi: 'blender.voronoiTexture',
  ShaderNodeTexWave: 'blender.waveTexture',
  ShaderNodeValToRGB: 'blender.colorRamp',
  ShaderNodeMapRange: 'blender.mapRange',
  ShaderNodeMix: 'blender.mix',
  ShaderNodeMixRGB: 'blender.mix',
  ShaderNodeAttribute: 'blender.attribute',
  ShaderNodeVertexColor: 'blender.colorAttribute',
  ShaderNodeBump: 'blender.bump',
  ShaderNodeNormalMap: 'blender.normalMap',
  ShaderNodeFresnel: 'blender.fresnel',
  ShaderNodeLayerWeight: 'blender.layerWeight',
  ShaderNodeHueSaturation: 'blender.hueSaturation',
  ShaderNodeBrightContrast: 'blender.brightnessContrast',
  ShaderNodeGamma: 'blender.gamma',
  ShaderNodeInvert: 'blender.invert',
  ShaderNodeClamp: 'blender.clamp',
  ShaderNodeSeparateColor: 'blender.separateColor',
  ShaderNodeCombineColor: 'blender.combineColor',
  ShaderNodeBsdfPrincipled: 'blender.principledBSDF',
  ShaderNodeOutputMaterial: 'blender.materialOutput',
});

const SURFACE = Symbol('studio.shader.surface');

export class ShaderGraphCompileError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ShaderGraphCompileError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new ShaderGraphCompileError(code, message, details);
}

function canonicalType(type) {
  return TYPE_ALIASES[type] ?? type;
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function array(value, length, fallback = 0) {
  if (Array.isArray(value) && value.length >= length) return value.slice(0, length).map(entry => finite(entry, fallback));
  return Array(length).fill(fallback);
}

function scalar(TSL, value, fallback = 0) {
  return TSL.float(finite(value, fallback));
}

function valueNode(TSL, value, fallback = 0) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (Array.isArray(value)) {
    if (value.length >= 4) return TSL.vec4(...array(value, 4));
    if (value.length === 3) return TSL.vec3(...array(value, 3));
    if (value.length === 2) return TSL.vec2(...array(value, 2));
  }
  return scalar(TSL, value, fallback);
}

function vector2(TSL, value, fallback = [0, 0]) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return TSL.vec2(...array(value ?? fallback, 2));
}

function vector3(TSL, value, fallback = [0, 0, 0]) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return TSL.vec3(...array(value ?? fallback, 3));
}

function color3(TSL, value, fallback = [0.8, 0.8, 0.8]) {
  return vector3(TSL, value, fallback);
}

function surface(channels, features = {}) {
  return Object.freeze({
    [SURFACE]: true,
    ...channels,
    features: Object.freeze({
      transparent: Boolean(features.transparent),
      transmission: Boolean(features.transmission),
      sheen: Boolean(features.sheen),
      specular: Boolean(features.specular),
      anisotropy: Boolean(features.anisotropy),
      iridescence: Boolean(features.iridescence),
    }),
  });
}

export function isCompiledSurface(value) {
  return Boolean(value?.[SURFACE]);
}

function seedOffset(seed) {
  const n = (Number.isSafeInteger(seed) ? seed : 0) >>> 0;
  return [
    ((n * 16807) % 2147483647) / 2147483647 * 97.13,
    ((n * 48271) % 2147483647) / 2147483647 * 83.71,
    ((n * 69621) % 2147483647) / 2147483647 * 71.39,
  ];
}

function addSeed(TSL, coordinate, seed) {
  if (!seed) return coordinate;
  const offset = seedOffset(seed);
  return coordinate.add(TSL.vec3(...offset));
}

function combineStaticSeeds(...seeds) {
  let value = 0x811c9dc5;
  for (const seed of seeds) {
    value ^= Number(seed) >>> 0;
    value = Math.imul(value, 0x01000193);
    value ^= value >>> 16;
  }
  return value >>> 0;
}

function coordinateComponent(coordinate, index) {
  return coordinate[['x', 'y', 'z', 'w'][index]];
}

function hashFloatCoordinates(TSL, coordinate, dimensions, seed = 0) {
  let value = TSL.uint(0x811c9dc5);
  const mixWord = word => {
    value = value.bitXor(TSL.uint(word)).mul(TSL.uint(0x01000193));
    value = value.bitXor(value.shiftRight(16));
  };
  mixWord(seed >>> 0);
  for (let index = 0; index < dimensions; index += 1) {
    mixWord(TSL.floatBitsToUint(coordinateComponent(coordinate, index)));
  }
  return TSL.float(value).div(0xffffffff);
}

function signedGradient4(TSL, lattice, seed) {
  const gradient = TSL.vec4(
    hashFloatCoordinates(TSL, lattice, 4, combineStaticSeeds(seed, 0x68bc21eb)).mul(2).sub(1),
    hashFloatCoordinates(TSL, lattice, 4, combineStaticSeeds(seed, 0x02e5be93)).mul(2).sub(1),
    hashFloatCoordinates(TSL, lattice, 4, combineStaticSeeds(seed, 0x967a889b)).mul(2).sub(1),
    hashFloatCoordinates(TSL, lattice, 4, combineStaticSeeds(seed, 0x368cc8b7)).mul(2).sub(1),
  );
  return gradient.div(TSL.max(TSL.length(gradient), 1e-7));
}

function gradientNoise4D(TSL, coordinate, seed = 0) {
  const lattice = TSL.floor(coordinate);
  const fraction = TSL.fract(coordinate);
  const fade = fraction.mul(fraction).mul(fraction)
    .mul(fraction.mul(fraction.mul(6).sub(15)).add(10));
  const samples = [];
  for (let corner = 0; corner < 16; corner += 1) {
    const offset = TSL.vec4(corner & 1, (corner >> 1) & 1, (corner >> 2) & 1, (corner >> 3) & 1);
    const delta = fraction.sub(offset);
    samples.push(TSL.dot(signedGradient4(TSL, lattice.add(offset), seed), delta));
  }
  const mixPairs = (values, amount) => {
    const mixed = [];
    for (let index = 0; index < values.length; index += 2) mixed.push(TSL.mix(values[index], values[index + 1], amount));
    return mixed;
  };
  return mixPairs(mixPairs(mixPairs(mixPairs(samples, fade.x), fade.y), fade.z), fade.w)[0];
}

function fractalNoise4D(TSL, coordinate, octaves, lacunarity, roughness, seed) {
  let sampleCoordinate = coordinate;
  let amplitude = TSL.float(1);
  let amplitudeTotal = TSL.float(0);
  let value = TSL.float(0);
  for (let octave = 0; octave < octaves; octave += 1) {
    value = value.add(gradientNoise4D(TSL, sampleCoordinate, combineStaticSeeds(seed, octave)).mul(amplitude));
    amplitudeTotal = amplitudeTotal.add(amplitude);
    sampleCoordinate = sampleCoordinate.mul(lacunarity);
    amplitude = amplitude.mul(roughness);
  }
  return value.div(TSL.max(amplitudeTotal, 1e-7)).mul(0.5).add(0.5);
}

function blenderNoiseChannel(TSL, coordinate, {
  mode,
  octaves,
  lacunarity,
  roughness,
  offset,
  gain,
  normalize,
  sampleNoise = value => TSL.mx_noise_float(value),
  fractalNoise = null,
}) {
  if (mode === 'FBM') {
    // Keep the original FBM lowering byte-for-byte equivalent so existing
    // authored materials retain their appearance.
    if (fractalNoise) return fractalNoise(coordinate);
    return TSL.mx_fractal_noise_float(coordinate, octaves, lacunarity, roughness)
      .mul(0.5).add(0.5);
  }

  if (mode === 'MULTIFRACTAL') {
    let sampleCoordinate = coordinate;
    let power = TSL.float(1);
    let result = TSL.float(1);
    for (let octave = 0; octave < octaves; octave += 1) {
      result = result.mul(TSL.float(1).add(sampleNoise(sampleCoordinate).mul(power)));
      sampleCoordinate = sampleCoordinate.mul(lacunarity);
      power = power.mul(roughness);
    }
    return result;
  }

  if (mode === 'HYBRID_MULTIFRACTAL') {
    let sampleCoordinate = coordinate;
    let power = TSL.float(1);
    let result = TSL.float(0);
    let weight = TSL.float(1);
    for (let octave = 0; octave < octaves; octave += 1) {
      weight = TSL.clamp(weight, 0, 1);
      const signal = sampleNoise(sampleCoordinate).add(offset).mul(power);
      result = result.add(weight.mul(signal));
      weight = weight.mul(gain).mul(signal);
      sampleCoordinate = sampleCoordinate.mul(lacunarity);
      power = power.mul(roughness);
    }
    return result;
  }

  if (mode === 'RIDGED_MULTIFRACTAL') {
    let sampleCoordinate = coordinate;
    let amplitude = TSL.float(1);
    let amplitudeTotal = TSL.float(0);
    let result = TSL.float(0);
    let weight = TSL.float(1);
    for (let octave = 0; octave < octaves; octave += 1) {
      let ridge = TSL.float(1).sub(TSL.abs(sampleNoise(sampleCoordinate)));
      ridge = ridge.mul(ridge).mul(weight);
      result = result.add(ridge.mul(amplitude));
      amplitudeTotal = amplitudeTotal.add(amplitude);
      weight = ridge.mul(gain).saturate();
      sampleCoordinate = sampleCoordinate.mul(lacunarity);
      amplitude = amplitude.mul(roughness);
    }
    return normalize ? result.div(TSL.max(amplitudeTotal, 1e-7)) : result;
  }

  if (mode === 'HETERO_TERRAIN') {
    let sampleCoordinate = coordinate;
    let value = sampleNoise(sampleCoordinate).mul(0.5).add(0.5).add(offset);
    let amplitude = roughness;
    for (let octave = 1; octave < octaves; octave += 1) {
      sampleCoordinate = sampleCoordinate.mul(lacunarity);
      const signal = sampleNoise(sampleCoordinate).mul(0.5).add(0.5).add(offset);
      value = value.add(signal.mul(amplitude).mul(value).mul(gain));
      amplitude = amplitude.mul(roughness);
    }
    return value;
  }

  fail('shader_node_mode_unsupported', `Noise Texture mode ${mode} is catalogued for interchange but not compiled live yet.`, { mode });
}

function component(value, name, fallback) {
  return value?.[name] ?? fallback;
}

function arithmetic(TSL, operation, a, b) {
  switch (String(operation).toUpperCase()) {
    case 'ADD': return a.add(b);
    case 'SUBTRACT': return a.sub(b);
    case 'MULTIPLY': return a.mul(b);
    case 'DIVIDE': return a.div(b);
    case 'MIN':
    case 'MINIMUM': return TSL.min(a, b);
    case 'MAX':
    case 'MAXIMUM': return TSL.max(a, b);
    case 'POWER': return TSL.pow(TSL.max(a, 0), b);
    case 'MODULO': return TSL.mod(a, b);
    case 'SNAP': return TSL.floor(a.div(b)).mul(b);
    case 'PINGPONG': return TSL.abs(TSL.mod(a, b.mul(2)).sub(b));
    default: fail('shader_node_mode_unsupported', `Math operation ${operation} is not compiled yet.`, { operation });
  }
}

function unaryMath(TSL, operation, value) {
  switch (String(operation).toUpperCase()) {
    case 'ABSOLUTE': return TSL.abs(value);
    case 'FLOOR': return TSL.floor(value);
    case 'CEIL': return TSL.ceil(value);
    case 'FRACT':
    case 'FRACTION': return TSL.fract(value);
    case 'SINE': return TSL.sin(value);
    case 'COSINE': return TSL.cos(value);
    case 'TANGENT': return TSL.tan(value);
    case 'ARCSINE': return TSL.asin(value);
    case 'ARCCOSINE': return TSL.acos(value);
    case 'ARCTANGENT': return TSL.atan(value);
    case 'SQRT': return TSL.sqrt(TSL.max(value, 0));
    case 'INVERSE_SQRT': return TSL.inversesqrt(TSL.max(value, 1e-7));
    case 'EXPONENT': return TSL.exp(value);
    case 'LOGARITHM': return TSL.log(TSL.max(value, 1e-7));
    case 'SIGN': return TSL.sign(value);
    case 'TRUNC': return TSL.trunc(value);
    case 'ROUND': return TSL.round(value);
    case 'SINH': return TSL.sinh(value);
    case 'COSH': return TSL.cosh(value);
    case 'TANH': return TSL.tanh(value);
    case 'RADIANS': return value.mul(Math.PI / 180);
    case 'DEGREES': return value.mul(180 / Math.PI);
    case 'SATURATE': return value.saturate();
    default: fail('shader_node_mode_unsupported', `Unary math operation ${operation} is not compiled yet.`, { operation });
  }
}

function blenderMath(TSL, operation, a, b, c) {
  const mode = String(operation).toUpperCase();
  const unary = [
    'ABSOLUTE', 'FLOOR', 'CEIL', 'FRACT', 'FRACTION', 'SINE', 'COSINE',
    'TANGENT', 'ARCSINE', 'ARCCOSINE', 'ARCTANGENT', 'SQRT',
    'INVERSE_SQRT', 'EXPONENT', 'SIGN', 'TRUNC', 'ROUND', 'SINH', 'COSH',
    'TANH', 'RADIANS', 'DEGREES', 'SATURATE',
  ];
  if (unary.includes(mode)) return unaryMath(TSL, mode, a);
  switch (mode) {
    case 'MULTIPLY_ADD': return a.mul(b).add(c);
    case 'LOGARITHM': return TSL.log(TSL.max(a, 1e-7)).div(TSL.log(TSL.max(b, 1e-7)));
    case 'LESS_THAN': return TSL.select(TSL.lessThan(a, b), 1, 0);
    case 'GREATER_THAN': return TSL.select(TSL.greaterThan(a, b), 1, 0);
    case 'COMPARE': return TSL.select(TSL.lessThanEqual(TSL.abs(a.sub(b)), TSL.max(c, 0)), 1, 0);
    case 'ARCTAN2': return TSL.atan(a, b);
    case 'FLOORED_MODULO': return a.sub(TSL.floor(a.div(b)).mul(b));
    case 'WRAP': {
      const width = c.sub(b);
      return a.sub(b).sub(TSL.floor(a.sub(b).div(width)).mul(width)).add(b);
    }
    case 'SMOOTH_MIN': {
      const radius = TSL.max(c, 1e-7);
      const h = TSL.max(radius.sub(TSL.abs(a.sub(b))).div(radius), 0);
      return TSL.min(a, b).sub(h.mul(h).mul(h).mul(radius).mul(1 / 6));
    }
    case 'SMOOTH_MAX': {
      const radius = TSL.max(c, 1e-7);
      const h = TSL.max(radius.sub(TSL.abs(a.sub(b))).div(radius), 0);
      return TSL.max(a, b).add(h.mul(h).mul(h).mul(radius).mul(1 / 6));
    }
    default: return arithmetic(TSL, mode, a, b);
  }
}

function rgbToHsv(TSL, color) {
  const rgb = color.xyz;
  const p = TSL.mix(
    TSL.vec4(rgb.z, rgb.y, -1, 2 / 3),
    TSL.vec4(rgb.y, rgb.z, 0, -1 / 3),
    TSL.step(rgb.z, rgb.y),
  );
  const q = TSL.mix(
    TSL.vec4(p.x, p.y, p.w, rgb.x),
    TSL.vec4(rgb.x, p.y, p.z, p.x),
    TSL.step(p.x, rgb.x),
  );
  const delta = q.x.sub(TSL.min(q.w, q.y));
  const epsilon = 1e-10;
  return TSL.vec3(
    TSL.abs(q.z.add(q.w.sub(q.y).div(delta.mul(6).add(epsilon)))),
    delta.div(q.x.add(epsilon)),
    q.x,
  );
}

function hsvToRgb(TSL, hsv) {
  const shape = TSL.abs(
    TSL.fract(TSL.vec3(hsv.x).add(TSL.vec3(0, 2 / 3, 1 / 3))).mul(6).sub(3),
  );
  return TSL.vec3(hsv.z).mul(TSL.mix(TSL.vec3(1), TSL.clamp(shape.sub(1), 0, 1), hsv.y));
}

function rgbToHsl(TSL, color) {
  const rgb = color.xyz;
  const hsv = rgbToHsv(TSL, rgb);
  const high = TSL.max(rgb.x, TSL.max(rgb.y, rgb.z));
  const low = TSL.min(rgb.x, TSL.min(rgb.y, rgb.z));
  const lightness = TSL.min(1, high.add(low).mul(0.5));
  const saturation = high.sub(low).div(
    TSL.max(TSL.float(1).sub(TSL.abs(lightness.mul(2).sub(1))), 1e-10),
  );
  return TSL.vec3(hsv.x, saturation, lightness);
}

function hslToRgb(TSL, hsl) {
  const hue = hsl.x.mul(6);
  const shape = TSL.clamp(TSL.vec3(
    TSL.abs(hue.sub(3)).sub(1),
    TSL.float(2).sub(TSL.abs(hue.sub(2))),
    TSL.float(2).sub(TSL.abs(hue.sub(4))),
  ), 0, 1);
  const chroma = TSL.float(1).sub(TSL.abs(hsl.z.mul(2).sub(1))).mul(hsl.y);
  return shape.sub(0.5).mul(chroma).add(hsl.z);
}

function hueMix(TSL, left, right, amount, interpolation = 'NEAR') {
  const delta = right.sub(left);
  const one = TSL.float(1);
  const direct = TSL.mix(left, right, amount);
  const increasing = TSL.fract(TSL.mix(left, right.add(1), amount));
  const decreasing = TSL.fract(TSL.mix(left.add(1), right, amount));
  const isLess = edge => one.sub(TSL.step(edge, delta));
  const isGreater = edge => one.sub(TSL.step(delta, edge));
  const equalZero = TSL.step(TSL.abs(delta), 0);
  let down = TSL.float(0);
  let up = TSL.float(0);

  switch (String(interpolation ?? 'NEAR').toUpperCase()) {
    case 'NEAR':
      down = isGreater(0.5);
      up = isLess(-0.5);
      break;
    case 'FAR':
      down = isGreater(0).mul(isLess(0.5));
      up = equalZero.add(isLess(0).mul(isGreater(-0.5))).saturate();
      break;
    case 'CW': up = isLess(0); break;
    case 'CCW': down = isGreater(0); break;
    default: fail('shader_node_mode_unsupported', `Hue interpolation ${interpolation} is not compiled live.`, { interpolation });
  }

  return TSL.mix(TSL.mix(direct, decreasing, down), increasing, up);
}

function mixBlend(TSL, mode, a, b, valueType = 'color') {
  switch (String(mode ?? 'MIX').toUpperCase()) {
    case 'MIX': return b;
    case 'ADD': return a.add(b);
    case 'SUBTRACT': return a.sub(b);
    case 'MULTIPLY': return a.mul(b);
    case 'DIVIDE': return a.div(TSL.max(b, 1e-7));
    case 'DIFFERENCE': return TSL.abs(a.sub(b));
    case 'DARKEN': return TSL.min(a, b);
    case 'LIGHTEN': return TSL.max(a, b);
    case 'SCREEN': return TSL.float(1).sub(TSL.float(1).sub(a).mul(TSL.float(1).sub(b)));
    case 'EXCLUSION': return a.add(b).sub(a.mul(b).mul(2));
    case 'DODGE': return a.div(TSL.max(TSL.float(1).sub(b), 1e-7));
    case 'BURN': return TSL.float(1).sub(TSL.float(1).sub(a).div(TSL.max(b, 1e-7)));
    case 'LINEAR_LIGHT': return a.add(b.mul(2)).sub(1);
    case 'OVERLAY': {
      const low = a.mul(b).mul(2);
      const high = TSL.float(1).sub(TSL.float(2).mul(TSL.float(1).sub(a)).mul(TSL.float(1).sub(b)));
      return TSL.select(a.lessThan(0.5), low, high);
    }
    case 'SOFT_LIGHT': return TSL.mix(a.mul(b).mul(2), TSL.float(1).sub(TSL.float(2).mul(TSL.float(1).sub(a)).mul(TSL.float(1).sub(b))), a);
    case 'HUE':
    case 'SATURATION':
    case 'COLOR':
    case 'VALUE': {
      const kind = String(valueType ?? 'color').toUpperCase();
      if (!['COLOR', 'VEC3', 'VEC4'].includes(kind)) return b;
      const aRgb = a.xyz;
      const bRgb = b.xyz;
      const aHsv = rgbToHsv(TSL, aRgb);
      const bHsv = rgbToHsv(TSL, bRgb);
      const hasSaturation = saturation => TSL.float(1).sub(TSL.step(saturation, 0));
      let target;
      if (String(mode).toUpperCase() === 'HUE') {
        target = TSL.mix(aRgb, hsvToRgb(TSL, TSL.vec3(bHsv.x, aHsv.y, aHsv.z)), hasSaturation(bHsv.y));
      } else if (String(mode).toUpperCase() === 'SATURATION') {
        target = TSL.mix(aRgb, hsvToRgb(TSL, TSL.vec3(aHsv.x, bHsv.y, aHsv.z)), hasSaturation(aHsv.y));
      } else if (String(mode).toUpperCase() === 'COLOR') {
        target = TSL.mix(aRgb, hsvToRgb(TSL, TSL.vec3(bHsv.x, bHsv.y, aHsv.z)), hasSaturation(bHsv.y));
      } else {
        target = hsvToRgb(TSL, TSL.vec3(aHsv.x, aHsv.y, bHsv.z));
      }
      return kind === 'VEC4' ? TSL.vec4(target, a.w) : target;
    }
    default: fail('shader_node_mode_unsupported', `Mix blend mode ${mode} is not compiled yet.`, { mode });
  }
}

function normalMapBySpace(TSL, color, strength, space) {
  const mode = String(space ?? 'TANGENT').toUpperCase();
  const decoded = color.mul(2).sub(1);
  const boundedStrength = TSL.max(strength, 0);

  if (mode === 'TANGENT') {
    // Three's normalMap() helper decodes sampled colours internally. The
    // graph compiler receives an already-decoded vector here so it can share
    // Blender's strength semantics with the other coordinate spaces without
    // accidentally applying the decode twice.
    const mapped = TSL.vec3(
      decoded.xy.mul(boundedStrength),
      TSL.mix(1, decoded.z, boundedStrength.saturate()),
    );
    return TSL.TBNViewMatrix.mul(mapped).normalize();
  }

  if (!['OBJECT', 'WORLD', 'BLENDER_OBJECT', 'BLENDER_WORLD'].includes(mode)) {
    fail('shader_node_mode_unsupported', `Normal Map space ${space} is not compiled live.`, { space: mode });
  }

  const legacy = mode.startsWith('BLENDER_')
    ? decoded.mul(TSL.vec3(1, -1, -1))
    : decoded;
  const transformed = mode.endsWith('OBJECT')
    ? TSL.transformNormalToView(legacy)
    : TSL.cameraViewMatrix.transformDirection(legacy);
  const target = TSL.directionToFaceDirection(transformed).normalize();
  const base = TSL.directionToFaceDirection(TSL.normalViewGeometry).normalize();
  return TSL.mix(base, target, boundedStrength).normalize();
}

function splineRamp(TSL, factor, ordered, interpolation) {
  const count = ordered.length;
  let result = TSL.vec4(0, 0, 0, 0);

  for (let region = 0; region <= count; region += 1) {
    const right = ordered[Math.min(region, count - 1)];
    const left = ordered[Math.max(0, region - 1)];
    const next = ordered[Math.min(region + 1, count - 1)];
    const previous = ordered[Math.max(0, region - 2)];
    const rightPosition = region === count ? 1 : right.position;
    const leftPosition = region === 0 ? 0 : left.position;
    const width = leftPosition - rightPosition;
    const amount = Math.abs(width) < 1e-7
      ? TSL.float(region === count ? 1 : 0)
      : TSL.clamp(factor.sub(rightPosition).div(width), 0, 1);
    const squared = amount.mul(amount);
    const cubed = squared.mul(amount);
    let weights;

    if (String(interpolation).toUpperCase() === 'CARDINAL') {
      const tension = 0.71;
      weights = [
        cubed.mul(-tension).add(squared.mul(2 * tension)).sub(amount.mul(tension)),
        cubed.mul(2 - tension).add(squared.mul(tension - 3)).add(1),
        cubed.mul(tension - 2).add(squared.mul(3 - 2 * tension)).add(amount.mul(tension)),
        cubed.mul(tension).sub(squared.mul(tension)),
      ];
    } else {
      weights = [
        cubed.mul(-1 / 6).add(squared.mul(0.5)).sub(amount.mul(0.5)).add(1 / 6),
        cubed.mul(0.5).sub(squared).add(2 / 3),
        cubed.mul(-0.5).add(squared.mul(0.5)).add(amount.mul(0.5)).add(1 / 6),
        cubed.mul(1 / 6),
      ];
    }

    const candidate = TSL.vec4(...array(previous.color, 4)).mul(weights[3])
      .add(TSL.vec4(...array(left.color, 4)).mul(weights[2]))
      .add(TSL.vec4(...array(right.color, 4)).mul(weights[1]))
      .add(TSL.vec4(...array(next.color, 4)).mul(weights[0]));
    const mask = region === 0
      ? TSL.float(1).sub(TSL.step(ordered[0].position, factor))
      : region === count
        ? TSL.step(ordered[count - 1].position, factor)
        : TSL.step(ordered[region - 1].position, factor)
          .mul(TSL.float(1).sub(TSL.step(ordered[region].position, factor)));
    result = result.add(candidate.mul(mask));
  }

  return TSL.clamp(result, 0, 1);
}

function colorRamp(TSL, factor, stops, interpolation = 'linear', colorMode = 'RGB', hueInterpolation = 'NEAR') {
  const ordered = [...(Array.isArray(stops) ? stops : [])].sort((a, b) => a.position - b.position);
  if (ordered.length < 2) fail('shader_ramp_invalid', 'A colour ramp requires at least two stops.');
  const mode = String(colorMode ?? 'RGB').toUpperCase();
  const curve = String(interpolation ?? 'LINEAR').toUpperCase();

  if (mode === 'RGB' && ['CARDINAL', 'B_SPLINE'].includes(curve)) {
    const result = splineRamp(TSL, factor, ordered, curve);
    return { color: result.xyz, alpha: result.w };
  }

  if (!['RGB', 'HSV', 'HSL'].includes(mode)) {
    fail('shader_node_mode_unsupported', `Colour Ramp mode ${colorMode} is not compiled live.`, { colorMode });
  }

  let result = color3(TSL, ordered[0].color);
  let alpha = scalar(TSL, ordered[0].color?.[3], 1);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const width = current.position - previous.position;
    let amount = Math.abs(width) < 1e-7
      ? TSL.step(current.position, factor)
      : factor.sub(previous.position).div(width).saturate();
    // Blender forces non-RGB ramps to linear interpolation regardless of the
    // selected RGB spline/constant mode.
    if (mode === 'RGB' && curve === 'CONSTANT') amount = TSL.step(current.position, factor);
    else if (mode === 'RGB' && ['SMOOTHSTEP', 'EASE'].includes(curve)) amount = TSL.smoothstep(0, 1, amount);
    const currentColor = color3(TSL, current.color);
    if (mode === 'RGB') {
      result = TSL.mix(result, currentColor, amount);
    } else {
      const left = mode === 'HSV' ? rgbToHsv(TSL, result) : rgbToHsl(TSL, result);
      const right = mode === 'HSV' ? rgbToHsv(TSL, currentColor) : rgbToHsl(TSL, currentColor);
      const channels = TSL.vec3(
        hueMix(TSL, left.x, right.x, amount, hueInterpolation),
        TSL.mix(left.y, right.y, amount),
        TSL.mix(left.z, right.z, amount),
      );
      result = mode === 'HSV' ? hsvToRgb(TSL, channels) : hslToRgb(TSL, channels);
    }
    alpha = TSL.mix(alpha, scalar(TSL, current.color?.[3], 1), amount);
  }
  return { color: result, alpha };
}

function rotateXYZ(TSL, vector, rotation) {
  const xAngle = component(rotation, 'x', scalar(TSL, 0));
  const yAngle = component(rotation, 'y', scalar(TSL, 0));
  const zAngle = component(rotation, 'z', scalar(TSL, 0));
  const cx = TSL.cos(xAngle); const sx = TSL.sin(xAngle);
  const cy = TSL.cos(yAngle); const sy = TSL.sin(yAngle);
  const cz = TSL.cos(zAngle); const sz = TSL.sin(zAngle);
  const x0 = component(vector, 'x', scalar(TSL, 0));
  const y0 = component(vector, 'y', scalar(TSL, 0));
  const z0 = component(vector, 'z', scalar(TSL, 0));
  const x1 = x0;
  const y1 = y0.mul(cx).sub(z0.mul(sx));
  const z1 = y0.mul(sx).add(z0.mul(cx));
  const x2 = x1.mul(cy).add(z1.mul(sy));
  const y2 = y1;
  const z2 = z1.mul(cy).sub(x1.mul(sy));
  return TSL.vec3(x2.mul(cz).sub(y2.mul(sz)), x2.mul(sz).add(y2.mul(cz)), z2);
}

function gradientTexture(TSL, coordinate, gradientType) {
  const x = component(coordinate, 'x', scalar(TSL, 0));
  const y = component(coordinate, 'y', scalar(TSL, 0));
  const mode = String(gradientType ?? 'LINEAR').toUpperCase();
  let factor;
  switch (mode) {
    case 'LINEAR': factor = x; break;
    case 'QUADRATIC': {
      const bounded = x.saturate();
      factor = bounded.mul(bounded);
      break;
    }
    case 'EASING': factor = TSL.smoothstep(0, 1, x); break;
    case 'DIAGONAL': factor = x.add(y).mul(0.5); break;
    case 'SPHERICAL': factor = TSL.float(0.999999).sub(TSL.length(coordinate)); break;
    case 'QUADRATIC_SPHERE': {
      const sphere = TSL.float(0.999999).sub(TSL.length(coordinate)).saturate();
      factor = sphere.mul(sphere);
      break;
    }
    case 'RADIAL': factor = TSL.atan(y, x).div(Math.PI * 2).add(0.5); break;
    default: fail('shader_node_mode_unsupported', `Gradient Texture mode ${gradientType} is not compiled live.`, { gradientType });
  }
  factor = factor.saturate();
  return { factor, color: TSL.vec3(factor, factor, factor) };
}

function whiteNoiseTexture(TSL, vector, w, dimensions) {
  const mode = String(dimensions ?? '3D').toUpperCase();
  if (mode === '4D') {
    const coordinate = TSL.vec4(vector, w);
    const value = hashFloatCoordinates(TSL, coordinate, 4, 0);
    return {
      value,
      color: TSL.vec3(
        value,
        hashFloatCoordinates(TSL, coordinate, 4, combineStaticSeeds(0, 0x68bc21eb)),
        hashFloatCoordinates(TSL, coordinate, 4, combineStaticSeeds(0, 0x02e5be93)),
      ),
    };
  }
  let coordinate;
  if (mode === '1D') coordinate = TSL.vec3(w, 0, 0);
  else if (mode === '2D') coordinate = TSL.vec3(vector.x, vector.y, 0);
  else if (mode === '3D') coordinate = vector;
  else fail('shader_node_mode_unsupported', `White Noise Texture ${dimensions} coordinates are catalogued for interchange but not compiled live yet.`, { dimensions });
  const value = TSL.mx_cell_noise_float(coordinate).saturate();
  const color = TSL.vec3(
    value,
    TSL.mx_cell_noise_float(coordinate.add(TSL.vec3(19.19, 73.31, 11.17))).saturate(),
    TSL.mx_cell_noise_float(coordinate.add(TSL.vec3(47.53, 5.93, 101.41))).saturate(),
  );
  return { value, color };
}

function magicTexture(TSL, coordinate, scale, distortion, depth) {
  const point = TSL.mod(coordinate.mul(scale), Math.PI * 2);
  let x = TSL.sin(point.x.add(point.y).add(point.z).mul(5));
  let y = TSL.cos(point.x.negate().add(point.y).sub(point.z).mul(5));
  let z = TSL.cos(point.x.negate().sub(point.y).add(point.z).mul(5)).negate();
  const boundedDepth = Math.max(0, Math.min(10, Math.round(finite(depth, 2))));
  if (boundedDepth > 0) {
    x = x.mul(distortion); y = y.mul(distortion); z = z.mul(distortion);
    y = TSL.cos(x.sub(y).add(z)).negate().mul(distortion);
  }
  if (boundedDepth > 1) x = TSL.cos(x.sub(y).sub(z)).mul(distortion);
  if (boundedDepth > 2) z = TSL.sin(x.negate().sub(y).sub(z)).mul(distortion);
  if (boundedDepth > 3) x = TSL.cos(x.negate().add(y).sub(z)).negate().mul(distortion);
  if (boundedDepth > 4) y = TSL.sin(x.negate().add(y).add(z)).negate().mul(distortion);
  if (boundedDepth > 5) y = TSL.cos(x.negate().add(y).add(z)).negate().mul(distortion);
  if (boundedDepth > 6) x = TSL.cos(x.add(y).add(z)).mul(distortion);
  if (boundedDepth > 7) z = TSL.sin(x.add(y).sub(z)).mul(distortion);
  if (boundedDepth > 8) x = TSL.cos(x.negate().sub(y).add(z)).negate().mul(distortion);
  if (boundedDepth > 9) y = TSL.sin(x.sub(y).add(z)).negate().mul(distortion);
  const divisor = TSL.select(TSL.lessThan(TSL.abs(distortion), 1e-7), 1, distortion.mul(2));
  x = x.div(divisor); y = y.div(divisor); z = z.div(divisor);
  const red = TSL.float(0.5).sub(x);
  const green = TSL.float(0.5).sub(y);
  const blue = TSL.float(0.5).sub(z);
  const color = TSL.vec3(red, green, blue);
  return { color, factor: red.add(green).add(blue).div(3) };
}

function brickTexture(TSL, {
  coordinate,
  color1,
  color2,
  mortar,
  scale,
  mortarSize,
  mortarSmooth,
  bias,
  brickWidth,
  rowHeight,
  offset,
  offsetFrequency,
  squash,
  squashFrequency,
}) {
  const x = coordinate.x.mul(scale);
  const y = coordinate.y.mul(scale);
  const safeHeight = TSL.max(rowHeight, 1e-7);
  const row = TSL.floor(y.div(safeHeight));
  const offsetMask = TSL.float(1).sub(TSL.step(0.5, TSL.mod(row, Math.max(1, offsetFrequency))));
  const squashMask = TSL.float(1).sub(TSL.step(0.5, TSL.mod(row, Math.max(1, squashFrequency))));
  const baseWidth = TSL.max(brickWidth, 1e-7);
  const width = TSL.mix(baseWidth, baseWidth.mul(squash), squashMask);
  const shiftedX = x.add(width.mul(offset).mul(offsetMask));
  const cellX = TSL.floor(shiftedX.div(width));
  const localX = TSL.fract(shiftedX.div(width));
  const localY = TSL.fract(y.div(safeHeight));
  const edgeX = TSL.min(localX, TSL.float(1).sub(localX)).mul(width);
  const edgeY = TSL.min(localY, TSL.float(1).sub(localY)).mul(safeHeight);
  const edgeDistance = TSL.min(edgeX, edgeY);
  const proximity = TSL.float(1).sub(edgeDistance.div(TSL.max(mortarSize, 1e-7))).saturate();
  const mortarFactor = TSL.smoothstep(0, TSL.max(mortarSmooth, 1e-7), proximity).saturate();
  const cellNoise = TSL.mx_cell_noise_float(TSL.vec3(cellX, row, 0));
  const brickColor = TSL.mix(color1, color2, cellNoise.add(bias).saturate());
  return { color: TSL.mix(brickColor, mortar, mortarFactor), factor: mortarFactor };
}

function vectorMath(TSL, operation, a, b, c, scale) {
  switch (String(operation).toUpperCase()) {
    case 'ADD': return { vector: a.add(b), value: scalar(TSL, 0) };
    case 'SUBTRACT': return { vector: a.sub(b), value: scalar(TSL, 0) };
    case 'MULTIPLY': return { vector: a.mul(b), value: scalar(TSL, 0) };
    case 'DIVIDE': return { vector: a.div(b), value: scalar(TSL, 0) };
    case 'CROSS_PRODUCT': return { vector: TSL.cross(a, b), value: scalar(TSL, 0) };
    case 'PROJECT': return { vector: b.mul(TSL.dot(a, b).div(TSL.max(TSL.dot(b, b), 1e-7))), value: scalar(TSL, 0) };
    case 'DOT_PRODUCT': return { vector: vector3(TSL, [0, 0, 0]), value: TSL.dot(a, b) };
    case 'DISTANCE': return { vector: vector3(TSL, [0, 0, 0]), value: TSL.distance(a, b) };
    case 'LENGTH': return { vector: vector3(TSL, [0, 0, 0]), value: TSL.length(a) };
    case 'SCALE': return { vector: a.mul(scale), value: scalar(TSL, 0) };
    case 'NORMALIZE': return { vector: TSL.normalize(a), value: scalar(TSL, 0) };
    case 'ABSOLUTE': return { vector: TSL.abs(a), value: scalar(TSL, 0) };
    case 'MINIMUM': return { vector: TSL.min(a, b), value: scalar(TSL, 0) };
    case 'MAXIMUM': return { vector: TSL.max(a, b), value: scalar(TSL, 0) };
    case 'FLOOR': return { vector: TSL.floor(a), value: scalar(TSL, 0) };
    case 'CEIL': return { vector: TSL.ceil(a), value: scalar(TSL, 0) };
    case 'FRACTION': return { vector: TSL.fract(a), value: scalar(TSL, 0) };
    case 'MODULO': return { vector: TSL.mod(a, b), value: scalar(TSL, 0) };
    case 'SINE': return { vector: TSL.sin(a), value: scalar(TSL, 0) };
    case 'COSINE': return { vector: TSL.cos(a), value: scalar(TSL, 0) };
    case 'TANGENT': return { vector: TSL.tan(a), value: scalar(TSL, 0) };
    case 'REFLECT': return { vector: TSL.reflect(a, TSL.normalize(b)), value: scalar(TSL, 0) };
    case 'REFRACT': return { vector: TSL.refract(a, TSL.normalize(b), scale), value: scalar(TSL, 0) };
    case 'FACEFORWARD': return { vector: TSL.faceforward(a, b, c), value: scalar(TSL, 0) };
    case 'MULTIPLY_ADD': return { vector: a.mul(b).add(c), value: scalar(TSL, 0) };
    case 'WRAP': {
      const width = c.sub(b);
      return { vector: a.sub(b).sub(TSL.floor(a.sub(b).div(width)).mul(width)).add(b), value: scalar(TSL, 0) };
    }
    case 'SNAP': return { vector: TSL.floor(a.div(b)).mul(b), value: scalar(TSL, 0) };
    default: fail('shader_node_mode_unsupported', `Vector Math operation ${operation} is not compiled yet.`, { operation });
  }
}

function makeInputResolver({ TSL, graph, compileOutput }) {
  const incoming = new Map();
  for (const edge of graph.edges) incoming.set(`${edge.to.nodeId}\u0000${edge.to.port}`, edge.from);
  return {
    connected(node, name) { return incoming.has(`${node.id}\u0000${name}`); },
    incomingPorts(node) {
      const ports = new Set();
      for (const key of incoming.keys()) {
        if (key.startsWith(`${node.id}\u0000`)) ports.add(key.slice(node.id.length + 1));
      }
      return ports;
    },
    get(node, names, fallback, kind = 'value') {
      for (const name of Array.isArray(names) ? names : [names]) {
        const source = incoming.get(`${node.id}\u0000${name}`);
        if (source) return compileOutput(source.nodeId, source.port);
        if (Object.hasOwn(node.inputs ?? {}, name)) return valueNode(TSL, node.inputs[name]);
        if (Object.hasOwn(node.params ?? {}, name)) return valueNode(TSL, node.params[name]);
        const defaultName = `${name}Default`;
        if (Object.hasOwn(node.params ?? {}, defaultName)) return valueNode(TSL, node.params[defaultName]);
      }
      if (kind === 'vec2') return vector2(TSL, fallback);
      if (kind === 'vec3' || kind === 'color') return vector3(TSL, fallback);
      return valueNode(TSL, fallback);
    },
    static(node, names, fallback) {
      for (const name of Array.isArray(names) ? names : [names]) {
        if (incoming.has(`${node.id}\u0000${name}`)) fail('shader_dynamic_setting_unsupported', `${node.type}.${name} must be a constant socket for deterministic compilation.`, { nodeId: node.id, port: name });
        if (Object.hasOwn(node.inputs ?? {}, name)) return node.inputs[name];
        if (Object.hasOwn(node.params ?? {}, name)) return node.params[name];
        const defaultName = `${name}Default`;
        if (Object.hasOwn(node.params ?? {}, defaultName)) return node.params[defaultName];
      }
      return fallback;
    },
  };
}

function compileNodeFactory({ TSL, graph, parameters, textureResolver, featureTracker }) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const cache = new Map();
  let input;

  const compileOutput = (nodeId, port) => {
    const key = `${nodeId}\u0000${port}`;
    if (cache.has(key)) return cache.get(key);
    const node = nodes.get(nodeId);
    if (!node) fail('shader_node_missing', `Shader graph references missing node ${nodeId}.`, { nodeId, port });
    let outputs;
    try {
      outputs = compileNode(node);
    } catch (error) {
      if (error instanceof ShaderGraphCompileError) {
        error.details = { nodeId, nodeType: node.type, ...error.details };
        throw error;
      }
      fail('shader_node_compile_failed', `Could not compile ${node.type} (${nodeId}): ${error.message}`, { nodeId, nodeType: node.type, cause: error.message });
    }
    for (const [outputName, value] of Object.entries(outputs)) cache.set(`${nodeId}\u0000${outputName}`, value);
    if (!cache.has(key)) fail('shader_output_unsupported', `Node ${nodeId} (${node.type}) has no compiled output named ${port}.`, { nodeId, nodeType: node.type, port });
    return cache.get(key);
  };

  input = makeInputResolver({ TSL, graph, compileOutput });

  const compileNode = node => {
    const p = node.params ?? {};
    const type = canonicalType(node.type);
    if (type === 'constant.float' || type === 'blender.value') return { value: scalar(TSL, p.value) };
    if (type === 'constant.vec2') return { value: vector2(TSL, p.value) };
    if (type === 'constant.vec3') return { value: vector3(TSL, p.value) };
    if (type === 'constant.color' || type === 'blender.rgb') return { value: color3(TSL, p.value ?? p.color, [1, 1, 1]), color: color3(TSL, p.value ?? p.color, [1, 1, 1]) };
    if (type === 'blender.reroute') {
      const valueType = String(p.valueType ?? 'float').toLowerCase();
      if (!['integer', 'float', 'vec2', 'vec3', 'vec4', 'color'].includes(valueType)) {
        fail('shader_node_mode_unsupported', `Reroute value type ${p.valueType} is not a numeric live TSL value.`, { valueType: p.valueType });
      }
      const fallback = valueType === 'vec2' ? [0, 0]
        : ['vec3', 'color'].includes(valueType) ? [0, 0, 0]
          : valueType === 'vec4' ? [0, 0, 0, 0] : 0;
      return { output: input.get(node, 'input', fallback, valueType === 'color' ? 'color' : valueType) };
    }
    if (type.startsWith('parameter.')) {
      const value = Object.hasOwn(parameters, p.name) ? parameters[p.name] : p.value;
      const nodeValue = valueNode(TSL, value);
      return { value: TSL.uniform ? TSL.uniform(nodeValue) : nodeValue };
    }
    if (type === 'input.uv') {
      featureTracker.requiresGeometryUv = true;
      return { uv: TSL.uv() };
    }
    if (type === 'input.worldPosition') return { position: TSL.positionWorld };
    if (type === 'input.normal') return { normal: TSL.normalWorld };
    if (type === 'input.viewDirection') return { direction: TSL.cameraPosition.sub(TSL.positionWorld).normalize() };
    if (type === 'input.time') return { seconds: TSL.time };
    if (type === 'uv') {
      featureTracker.requiresGeometryUv = true;
      return { uv: TSL.uv() };
    }
    if (type === 'worldPosition') return { position: TSL.positionWorld };
    if (type === 'constant') return { value: valueNode(TSL, p.value) };

    if (type === 'image') {
      fail(
        'shader_image_asset_live_unsupported',
        'Image asset nodes are available to bounded CPU texture baking, not live WebGPU materials; use texture.sample2d with a dataTexture resource.',
        { assetId: p.assetId },
      );
    }
    if (type === 'texture.sample2d') {
      const textureId = p.textureId;
      const texture = textureResolver?.(textureId);
      if (!texture) fail('shader_texture_unavailable', `Texture ${textureId} is not available to the live graph compiler.`, { textureId });
      const sourceColorSpace = texture.userData?.studioColorSpace;
      if (sourceColorSpace !== undefined && sourceColorSpace !== p.colorSpace) {
        fail(
          'graph_texture_color_space_mismatch',
          `Texture sampler ${node.id} expects ${p.colorSpace} data, but ${textureId} is ${sourceColorSpace}.`,
          { nodeId: node.id, textureId, expectedColorSpace: p.colorSpace, sourceColorSpace },
        );
      }
      const sample = TSL.texture(texture, input.get(node, 'uv', [0, 0], 'vec2'));
      return { color: sample.rgb, alpha: sample.a };
    }
    if (type === 'pattern.gradient' || type === 'gradient') {
      const coordinate = input.get(node, 'coordinate', 0);
      const start = finite(p.start, 0); const end = finite(p.end, 1);
      return { value: coordinate.sub(start).div(Math.abs(end - start) < 1e-7 ? 1e-7 : end - start).saturate() };
    }
    if (type === 'pattern.checker' || type === 'checker') {
      const coordinate = input.get(node, 'coordinate', [0, 0], 'vec2');
      const a = input.get(node, 'a', [0, 0, 0], 'color');
      const b = input.get(node, 'b', [1, 1, 1], 'color');
      const cell = TSL.floor(component(coordinate, 'x', coordinate).mul(p.scale ?? 8)).add(TSL.floor(component(coordinate, 'y', coordinate).mul(p.scale ?? 8)));
      return { color: TSL.mix(a, b, TSL.mod(cell, 2)) };
    }
    if (type === 'noise.value' || type === 'valueNoise') {
      const coordinate = addSeed(TSL, input.get(node, 'coordinate', [0, 0, 0], 'vec3'), p.seed);
      return { value: TSL.mx_noise_float(coordinate).mul(0.5).add(0.5).saturate() };
    }
    if (type === 'noise.fbm' || type === 'fbm') {
      const coordinate = addSeed(TSL, input.get(node, 'coordinate', [0, 0, 0], 'vec3'), p.seed);
      return { value: TSL.mx_fractal_noise_float(coordinate, p.octaves ?? 4, p.lacunarity ?? 2, p.gain ?? 0.5).mul(0.5).add(0.5).saturate() };
    }
    if (type === 'noise.voronoi' || type === 'voronoi') {
      const coordinate = addSeed(TSL, input.get(node, 'coordinate', [0, 0, 0], 'vec3'), p.seed);
      const distances = TSL.mx_worley_noise_vec2(coordinate);
      return { distance: distances.x, cell: TSL.mx_cell_noise_float(TSL.floor(coordinate)) };
    }
    if (type === 'ramp.color' || type === 'colorRamp') return colorRamp(TSL, input.get(node, 'value', 0), p.stops, p.interpolation);
    if (type.startsWith('math.') && !['math.mix', 'math.remap', 'math.abs', 'math.saturate'].includes(type)) {
      return { value: arithmetic(TSL, type.slice(5), input.get(node, 'a', 0), input.get(node, 'b', 0)) };
    }
    if (type === 'arithmetic') return { value: arithmetic(TSL, p.operation, input.get(node, 'a', 0), input.get(node, 'b', 0)) };
    if (type === 'math.abs') return { value: TSL.abs(input.get(node, 'value', 0)) };
    if (type === 'math.saturate') return { value: input.get(node, 'value', 0).saturate() };
    if (type === 'math.mix' || type === 'mix') return { value: TSL.mix(input.get(node, 'a', 0), input.get(node, 'b', 1), input.get(node, 'factor', 0.5).saturate()) };
    if (type === 'math.remap' || type === 'remap') {
      const value = input.get(node, 'value', 0);
      const args = [value, p.inMin ?? 0, p.inMax ?? 1, p.outMin ?? 0, p.outMax ?? 1];
      return { value: p.clamp === false ? TSL.remap(...args) : TSL.remapClamp(...args) };
    }
    if (type === 'vector.dot') return { value: TSL.dot(input.get(node, 'a', [0, 0, 0], 'vec3'), input.get(node, 'b', [0, 0, 0], 'vec3')) };
    if (type === 'vector.normalize') return { value: TSL.normalize(input.get(node, 'value', [0, 0, 1], 'vec3')) };
    if (type === 'vector.combine3') return { value: TSL.vec3(input.get(node, 'x', 0), input.get(node, 'y', 0), input.get(node, 'z', 0)) };
    if (type === 'normal.fromHeight' || type === 'normalFromHeight') return { normal: TSL.bumpMap(input.get(node, 'height', 0), p.strength ?? 1) };
    if (type === 'lighting.fresnel') {
      const normal = TSL.normalize(input.get(node, 'normal', [0, 0, 1], 'vec3'));
      const view = TSL.normalize(input.get(node, 'viewDirection', [0, 0, 1], 'vec3'));
      return { value: TSL.pow(TSL.float(1).sub(TSL.max(TSL.dot(normal, view), 0)), p.power ?? 5) };
    }
    if (type === 'warp') return { coordinate: input.get(node, 'coordinate', [0, 0], 'vec2').add(input.get(node, 'offset', [0, 0], 'vec2').mul(p.strength ?? 1)) };
    if (type === 'channelPack') {
      const defaults = array(p.defaults, 4);
      return { value: TSL.vec4(input.get(node, 'r', defaults[0]), input.get(node, 'g', defaults[1]), input.get(node, 'b', defaults[2]), input.get(node, 'a', defaults[3])) };
    }
    if (type === 'blur') fail('shader_node_unsupported', 'Blur is a bake filter and cannot run as a live material node.');

    if (type === 'blender.textureCoordinate') {
      const uv = TSL.uv();
      const view = TSL.cameraPosition.sub(TSL.positionWorld).normalize();
      const reflection = TSL.reflect(view.negate(), TSL.normalWorld);
      return {
        generated: TSL.attribute('studioGenerated', 'vec3'),
        normal: TSL.normalLocal,
        uv: TSL.vec3(uv.x, uv.y, 0),
        object: TSL.positionLocal,
        camera: TSL.positionView ?? TSL.positionWorld,
        window: TSL.vec3(uv.x, uv.y, 0),
        reflection,
      };
    }
    if (type === 'blender.separateXYZ') {
      const vector = input.get(node, 'vector', [0, 0, 0], 'vec3');
      return { x: vector.x, y: vector.y, z: vector.z };
    }
    if (type === 'blender.combineXYZ') return { vector: TSL.vec3(input.get(node, 'x', 0), input.get(node, 'y', 0), input.get(node, 'z', 0)) };
    if (type === 'blender.mapping') {
      let vector = input.get(node, 'vector', [0, 0, 0], 'vec3');
      const location = input.get(node, 'location', [0, 0, 0], 'vec3');
      const rotation = input.get(node, 'rotation', [0, 0, 0], 'vec3');
      const scale = input.get(node, 'scale', [1, 1, 1], 'vec3');
      vector = rotateXYZ(TSL, vector.mul(scale), rotation);
      if (!['VECTOR', 'NORMAL'].includes(String(p.vectorType).toUpperCase())) vector = vector.add(location);
      if (String(p.vectorType).toUpperCase() === 'NORMAL') vector = TSL.normalize(vector);
      return { vector };
    }
    if (type === 'blender.checkerTexture') {
      const coordinate = input.get(node, 'vector', [0, 0, 0], 'vec3')
        .mul(input.get(node, 'scale', 5)).add(0.000001).mul(0.999999);
      const cell = TSL.abs(TSL.floor(coordinate.x))
        .add(TSL.abs(TSL.floor(coordinate.y))).add(TSL.abs(TSL.floor(coordinate.z)));
      const factor = TSL.mod(cell, 2).saturate();
      return {
        color: TSL.mix(
          input.get(node, 'color2', [0.2, 0.2, 0.2, 1], 'color'),
          input.get(node, 'color1', [0.8, 0.8, 0.8, 1], 'color'),
          factor,
        ),
        factor,
      };
    }
    if (type === 'blender.gradientTexture') {
      return gradientTexture(TSL, input.get(node, 'vector', [0, 0, 0], 'vec3'), p.gradientType);
    }
    if (type === 'blender.whiteNoiseTexture') {
      return whiteNoiseTexture(
        TSL,
        input.get(node, 'vector', [0, 0, 0], 'vec3'),
        input.get(node, 'w', 0),
        p.dimensions,
      );
    }
    if (type === 'blender.magicTexture') {
      return magicTexture(
        TSL,
        input.get(node, 'vector', [0, 0, 0], 'vec3'),
        input.get(node, 'scale', 5),
        input.get(node, 'distortion', 1),
        p.depth,
      );
    }
    if (type === 'blender.brickTexture') {
      return brickTexture(TSL, {
        coordinate: input.get(node, 'vector', [0, 0, 0], 'vec3'),
        color1: input.get(node, 'color1', [0.8, 0.8, 0.8, 1], 'color'),
        color2: input.get(node, 'color2', [0.2, 0.2, 0.2, 1], 'color'),
        mortar: input.get(node, 'mortar', [0, 0, 0, 1], 'color'),
        scale: input.get(node, 'scale', 5),
        mortarSize: input.get(node, 'mortarSize', 0.02),
        mortarSmooth: input.get(node, 'mortarSmooth', 0),
        bias: input.get(node, 'bias', 0),
        brickWidth: input.get(node, 'brickWidth', 0.5),
        rowHeight: input.get(node, 'rowHeight', 0.25),
        offset: finite(p.offset, 0.5),
        offsetFrequency: Math.max(1, Math.round(finite(p.offsetFrequency, 2))),
        squash: finite(p.squash, 1),
        squashFrequency: Math.max(1, Math.round(finite(p.squashFrequency, 2))),
      });
    }
    if (type === 'blender.math') {
      const operation = p.operation ?? 'ADD';
      const a = input.get(node, ['value', 'a'], 0);
      const b = input.get(node, ['valueB', 'b'], 0);
      const c = input.get(node, ['valueC', 'c'], 0);
      let result = blenderMath(TSL, operation, a, b, c);
      if (p.clamp === true) result = result.saturate();
      return { value: result };
    }
    if (type === 'blender.vectorMath') {
      return vectorMath(TSL, p.operation ?? 'ADD', input.get(node, 'vector', [0, 0, 0], 'vec3'), input.get(node, 'vectorB', [0, 0, 0], 'vec3'), input.get(node, 'vectorC', [0, 0, 0], 'vec3'), input.get(node, 'scale', 1));
    }
    if (type === 'blender.noiseTexture') {
      const noiseType = String(p.noiseType ?? 'FBM').toUpperCase();
      if (!['FBM', 'MULTIFRACTAL', 'HYBRID_MULTIFRACTAL', 'RIDGED_MULTIFRACTAL', 'HETERO_TERRAIN'].includes(noiseType)) {
        fail(
          'shader_node_mode_unsupported',
          `Noise Texture mode ${p.noiseType} is not compiled live.`,
          { mode: noiseType },
        );
      }
      const dimensions = String(p.dimensions ?? '3D').toUpperCase();
      const vector = input.get(node, 'vector', [0, 0, 0], 'vec3');
      const scale = input.get(node, 'scale', 5);
      let coordinate;
      if (dimensions === '4D') coordinate = TSL.vec4(vector, input.get(node, 'w', 0)).mul(scale);
      else {
        coordinate = vector;
        if (dimensions === '1D') coordinate = TSL.vec3(input.get(node, 'w', 0), 0, 0);
        else if (dimensions === '2D') coordinate = TSL.vec3(coordinate.x, coordinate.y, 0);
        coordinate = addSeed(TSL, coordinate.mul(scale), p.seed);
      }
      const octaves = Math.max(1, Math.min(8, Math.round(finite(input.static(node, 'detail', 2), 2))));
      const lacunarity = input.get(node, 'lacunarity', 2);
      const roughness = input.get(node, 'roughness', 0.5);
      const offset = input.get(node, 'offset', 0);
      const gain = input.get(node, 'gain', 1);
      const distortion = input.get(node, 'distortion', 0);
      let distortedCoordinate;
      if (dimensions === '4D') {
        const staticDistortion = input.connected(node, 'distortion') ? null : finite(input.static(node, 'distortion', 0), 0);
        if (staticDistortion === 0) distortedCoordinate = coordinate;
        else {
          const warp = TSL.vec4(
            gradientNoise4D(TSL, coordinate, combineStaticSeeds(p.seed, 0xa341316c)),
            gradientNoise4D(TSL, coordinate, combineStaticSeeds(p.seed, 0xc8013ea4)),
            gradientNoise4D(TSL, coordinate, combineStaticSeeds(p.seed, 0xad90777d)),
            gradientNoise4D(TSL, coordinate, combineStaticSeeds(p.seed, 0x7e95761e)),
          );
          distortedCoordinate = coordinate.add(warp.mul(distortion));
        }
      } else distortedCoordinate = coordinate.add(TSL.mx_noise_vec3(coordinate).mul(distortion));
      const channelOptions = {
        mode: noiseType,
        octaves,
        lacunarity,
        roughness,
        offset,
        gain,
        normalize: p.normalize !== false,
      };
      if (dimensions === '4D') {
        channelOptions.sampleNoise = value => gradientNoise4D(TSL, value, p.seed);
        channelOptions.fractalNoise = value => fractalNoise4D(TSL, value, octaves, lacunarity, roughness, p.seed);
      }
      let factor = blenderNoiseChannel(TSL, distortedCoordinate, channelOptions);
      if (p.normalize !== false) factor = factor.saturate();
      const color = TSL.vec3(
        factor,
        blenderNoiseChannel(TSL, distortedCoordinate.add(19.17), channelOptions),
        blenderNoiseChannel(TSL, distortedCoordinate.add(47.53), channelOptions),
      ).saturate();
      return { factor, color };
    }
    if (type === 'blender.voronoiTexture') {
      if (String(p.dimensions ?? '3D').toUpperCase() === '4D') fail('shader_node_mode_unsupported', 'Live TSL Voronoi does not yet implement Blender 4D coordinates.');
      if (String(p.distanceMetric ?? 'EUCLIDEAN').toUpperCase() !== 'EUCLIDEAN') fail('shader_node_mode_unsupported', `Voronoi distance metric ${p.distanceMetric} is catalogued for interchange but not compiled live yet.`);
      let coordinate = input.get(node, ['vector', 'w'], [0, 0, 0], 'vec3').mul(input.get(node, 'scale', 5));
      if (String(p.dimensions).toUpperCase() === '1D') coordinate = TSL.vec3(input.get(node, 'w', 0).mul(input.get(node, 'scale', 5)), 0, 0);
      else if (String(p.dimensions).toUpperCase() === '2D') coordinate = TSL.vec3(coordinate.x, coordinate.y, 0);
      coordinate = addSeed(TSL, coordinate, p.seed);
      const randomness = input.get(node, 'randomness', 1);
      const distances = TSL.mx_worley_noise_vec2(coordinate, randomness);
      const cell = TSL.mx_cell_noise_float(TSL.floor(coordinate));
      const feature = String(p.feature ?? 'F1').toUpperCase();
      let distance = feature === 'DISTANCE_TO_EDGE' ? distances.y.sub(distances.x) : feature === 'F2' ? distances.y : distances.x;
      if (p.normalize === true) distance = distance.saturate();
      return { distance, color: TSL.vec3(cell, TSL.mx_cell_noise_float(TSL.floor(coordinate).add(17)), TSL.mx_cell_noise_float(TSL.floor(coordinate).add(41))), position: TSL.floor(coordinate).add(0.5), w: cell, radius: distances.x };
    }
    if (type === 'blender.waveTexture') {
      const coordinate = input.get(node, 'vector', [0, 0, 0], 'vec3');
      const waveType = String(p.waveType ?? 'BANDS').toUpperCase();
      const bandDirection = String(p.bandsDirection ?? 'X').toUpperCase();
      const ringDirection = String(p.ringsDirection ?? 'X').toUpperCase();
      const bands = bandDirection === 'DIAGONAL' ? coordinate.x.add(coordinate.y).add(coordinate.z) : component(coordinate, bandDirection.toLowerCase(), coordinate.x);
      const rings = ringDirection === 'SPHERICAL' ? TSL.length(coordinate) : ringDirection === 'X' ? TSL.length(TSL.vec2(coordinate.y, coordinate.z)) : ringDirection === 'Y' ? TSL.length(TSL.vec2(coordinate.x, coordinate.z)) : TSL.length(TSL.vec2(coordinate.x, coordinate.y));
      const direction = waveType === 'RINGS' ? rings : bands;
      let phase = direction.mul(input.get(node, 'scale', 5)).add(input.get(node, 'phaseOffset', 0));
      const distortion = input.get(node, 'distortion', 0);
      phase = phase.add(TSL.mx_noise_float(coordinate.mul(input.get(node, 'detailScale', 1))).mul(distortion));
      const profile = String(p.profile ?? 'SIN').toUpperCase();
      let factor;
      if (profile === 'SAW') factor = TSL.fract(phase);
      else if (profile === 'TRI') factor = TSL.abs(TSL.fract(phase).sub(0.5)).mul(2);
      else factor = TSL.sin(phase.mul(Math.PI * 2)).mul(0.5).add(0.5);
      return { factor, color: TSL.vec3(factor, factor, factor) };
    }
    if (type === 'blender.colorRamp') {
      const factor = input.get(node, ['factor', 'value'], 0);
      return colorRamp(TSL, factor, p.stops, p.interpolation, p.colorMode, p.hueInterpolation);
    }
    if (type === 'blender.mapRange') {
      const value = input.get(node, 'value', 0);
      const fromMin = input.get(node, 'fromMin', 0); const fromMax = input.get(node, 'fromMax', 1);
      const toMin = input.get(node, 'toMin', 0); const toMax = input.get(node, 'toMax', 1);
      const t = value.sub(fromMin).div(fromMax.sub(fromMin));
      const mode = String(p.interpolationType ?? 'LINEAR').toUpperCase();
      let amount = mode === 'SMOOTHERSTEP' ? t.mul(t).mul(t).mul(t.mul(t.mul(6).sub(15)).add(10)) : mode === 'SMOOTHSTEP' ? TSL.smoothstep(0, 1, t) : mode === 'STEPPED' ? TSL.floor(t.mul(input.get(node, 'steps', 4))).div(input.get(node, 'steps', 4)) : t;
      if (p.clamp === true) amount = amount.saturate();
      return { result: TSL.mix(toMin, toMax, amount) };
    }
    if (type === 'blender.mix') {
      let factor = input.get(node, 'factor', 0.5);
      if (p.clampFactor !== false) factor = factor.saturate();
      const valueType = String(p.valueType ?? 'color').toUpperCase();
      const fallback = valueType === 'FLOAT' || valueType === 'INTEGER' ? 0
        : valueType === 'VEC2' ? [0, 0]
          : valueType === 'VEC4' ? [0, 0, 0, 0] : [0, 0, 0];
      const kind = valueType === 'COLOR' ? 'color' : valueType.toLowerCase();
      let a = input.get(node, 'a', fallback, kind);
      let b = input.get(node, 'b', fallback, kind);
      // Studio's semantic colour sockets are RGB; authored literal colours
      // may carry an interchange alpha component that is exposed separately.
      if (valueType === 'COLOR') { a = a.xyz; b = b.xyz; }
      let result = TSL.mix(a, mixBlend(TSL, p.blendMode, a, b, p.valueType), factor);
      if (p.clampResult === true) result = result.saturate();
      return { result, color: result };
    }
    if (type === 'blender.attribute' || type === 'blender.colorAttribute') {
      const name = p.name ?? p.layerName;
      if (!name) {
        return { color: TSL.vec3(0, 0, 0), vector: TSL.vec3(0, 0, 0), factor: scalar(TSL, 0), alpha: scalar(TSL, 0) };
      }
      const attribute = TSL.attribute(name, 'vec4');
      return { color: attribute.rgb, vector: attribute.xyz, factor: attribute.x, alpha: attribute.w };
    }
    if (type === 'blender.bump') {
      const strength = input.get(node, 'strength', 1);
      const distance = input.get(node, 'distance', 1);
      const signed = p.invert === true ? strength.mul(distance).negate() : strength.mul(distance);
      const bumped = TSL.bumpMap(input.get(node, 'height', 0), signed);
      if (!input.connected(node, 'normal')) return { normal: bumped };
      const base = TSL.normalize(input.get(node, 'normal', TSL.normalLocal));
      return { normal: TSL.normalize(base.add(bumped.sub(TSL.normalLocal))) };
    }
    if (type === 'blender.normalMap') {
      const color = input.get(node, 'color', [0.5, 0.5, 1], 'color');
      const strength = input.get(node, 'strength', 1);
      return { normal: normalMapBySpace(TSL, color, strength, p.space) };
    }
    if (type === 'blender.fresnel' || type === 'blender.layerWeight') {
      const normal = TSL.normalize(input.get(node, 'normal', TSL.normalWorld));
      const view = TSL.cameraPosition.sub(TSL.positionWorld).normalize();
      const facing = TSL.max(TSL.dot(normal, view), 0);
      const ior = input.get(node, 'ior', 1.45);
      const f0 = ior.sub(1).div(ior.add(1));
      const fresnel = f0.mul(f0).add(TSL.float(1).sub(f0.mul(f0)).mul(TSL.pow(TSL.float(1).sub(facing), 5)));
      const blend = TSL.float(1).sub(facing).mul(input.get(node, 'blend', 0.5)).saturate();
      return { factor: fresnel, fresnel, facing, blend };
    }
    if (type === 'blender.gamma') return { color: TSL.pow(TSL.max(input.get(node, 'color', [0, 0, 0], 'color'), 0), input.get(node, 'gamma', 1)) };
    if (type === 'blender.invert') {
      const factor = input.get(node, 'factor', 1).saturate(); const color = input.get(node, 'color', [0, 0, 0], 'color');
      return { color: TSL.mix(color, TSL.float(1).sub(color), factor) };
    }
    if (type === 'blender.brightnessContrast') {
      const color = input.get(node, 'color', [0, 0, 0], 'color');
      return { color: color.sub(0.5).mul(input.get(node, 'contrast', 0).add(1)).add(0.5).add(input.get(node, ['brightness', 'bright'], 0)) };
    }
    if (type === 'blender.clamp') return { result: TSL.clamp(input.get(node, 'value', 0), input.get(node, 'min', 0), input.get(node, 'max', 1)) };
    if (type === 'blender.separateColor') {
      const color = input.get(node, 'color', [0, 0, 0], 'color');
      const mode = String(p.mode ?? 'RGB').toUpperCase();
      if (!['RGB', 'HSV', 'HSL'].includes(mode)) fail('shader_node_mode_unsupported', `Separate Color mode ${p.mode} is not compiled live.`, { mode });
      const channels = mode === 'HSV' ? rgbToHsv(TSL, color) : mode === 'HSL' ? rgbToHsl(TSL, color) : color.xyz;
      return { red: channels.x, green: channels.y, blue: channels.z, alpha: scalar(TSL, 1) };
    }
    if (type === 'blender.combineColor') {
      const mode = String(p.mode ?? 'RGB').toUpperCase();
      if (!['RGB', 'HSV', 'HSL'].includes(mode)) fail('shader_node_mode_unsupported', `Combine Color mode ${p.mode} is not compiled live.`, { mode });
      const channels = TSL.vec3(input.get(node, ['red', 'r'], 0), input.get(node, ['green', 'g'], 0), input.get(node, ['blue', 'b'], 0));
      const color = mode === 'HSV' ? hsvToRgb(TSL, channels) : mode === 'HSL' ? hslToRgb(TSL, channels) : channels;
      return { color: TSL.vec4(color, input.get(node, ['alpha', 'a'], 1)) };
    }
    if (type === 'blender.hueSaturation') {
      // Hue rotation around the neutral axis is continuous, branch-free, and preserves luminance better than channel swapping.
      const color = input.get(node, 'color', [0, 0, 0], 'color');
      const angle = input.get(node, 'hue', 0.5).sub(0.5).mul(Math.PI * 2);
      const axis = TSL.normalize(TSL.vec3(1, 1, 1));
      const rotated = color.mul(TSL.cos(angle)).add(TSL.cross(axis, color).mul(TSL.sin(angle))).add(axis.mul(TSL.dot(axis, color)).mul(TSL.float(1).sub(TSL.cos(angle))));
      const grey = TSL.dot(rotated, TSL.vec3(0.2126, 0.7152, 0.0722));
      const saturated = TSL.mix(TSL.vec3(grey, grey, grey), rotated, input.get(node, 'saturation', 1));
      const adjusted = saturated.mul(input.get(node, 'value', 1));
      return { color: TSL.mix(color, adjusted, input.get(node, 'factor', 1).saturate()) };
    }
    if (type === 'blender.principledBSDF') {
      const alphaConnected = input.connected(node, 'alpha') || input.connected(node, 'opacity');
      const transmissionConnected = input.connected(node, 'transmissionWeight') || input.connected(node, 'transmission');
      const staticAlpha = alphaConnected ? null : input.static(node, ['alpha', 'opacity'], 1);
      const staticTransmission = transmissionConnected ? null : input.static(node, ['transmissionWeight', 'transmission'], 0);
      const extras = principledFeatureFlags(node, input.incomingPorts(node));
      return { surface: surface({
        baseColor: input.get(node, 'baseColor', [0.8, 0.8, 0.8], 'color'),
        metallic: input.get(node, ['metallic', 'metalness'], 0),
        roughness: input.get(node, 'roughness', 0.5),
        ior: input.get(node, 'ior', 1.5),
        alpha: input.get(node, ['alpha', 'opacity'], 1),
        normal: extras.normal ? input.get(node, 'normal', TSL.normalLocal) : null,
        emissionColor: input.get(node, ['emissionColor', 'emission'], [0, 0, 0], 'color'),
        emissionStrength: input.get(node, 'emissionStrength', 1),
        coatWeight: input.get(node, ['coatWeight', 'clearcoat'], 0),
        coatRoughness: input.get(node, ['coatRoughness', 'clearcoatRoughness'], 0.03),
        transmissionWeight: input.get(node, ['transmissionWeight', 'transmission'], 0),
        sheenWeight: input.get(node, ['sheenWeight', 'sheen'], 0),
        sheenRoughness: input.get(node, 'sheenRoughness', 0.5),
        sheenTint: input.get(node, ['sheenTint', 'sheenColor'], [1, 1, 1], 'color'),
        specularIorLevel: extras.specular ? input.get(node, ['specularIorLevel', 'specularIntensity'], 0.5) : null,
        specularTint: extras.specular ? input.get(node, ['specularTint', 'specularColor'], [1, 1, 1], 'color') : null,
        anisotropic: extras.anisotropy ? input.get(node, ['anisotropic', 'anisotropy'], 0) : null,
        anisotropicRotation: extras.anisotropy ? input.get(node, 'anisotropicRotation', 0) : null,
        coatNormal: extras.coatNormal ? input.get(node, 'coatNormal', TSL.normalLocal) : null,
        thinFilmThickness: extras.iridescence ? input.get(node, 'thinFilmThickness', 0) : null,
        thinFilmIor: extras.iridescence ? input.get(node, 'thinFilmIor', 1.33) : null,
      }, {
        transparent: alphaConnected || (Number.isFinite(staticAlpha) && staticAlpha < 1),
        transmission: transmissionConnected || (Number.isFinite(staticTransmission) && staticTransmission > 0),
        sheen: extras.sheen,
        specular: extras.specular,
        anisotropy: extras.anisotropy,
        iridescence: extras.iridescence,
      }) };
    }
    if (type === 'blender.materialOutput') {
      const compiledSurface = input.get(node, 'surface', null);
      if (!isCompiledSurface(compiledSurface)) fail('shader_surface_required', 'Material Output requires a compiled BSDF surface input.');
      return { surface: compiledSurface };
    }

    fail('shader_node_unsupported', `Node ${node.type} is catalogued but has no live TSL compiler.`, { nodeId: node.id, nodeType: node.type });
  };

  return { compileOutput, cache };
}

/**
 * Compile a validated Studio shader/texture DAG to live Three.js TSL nodes.
 * Unsupported nodes fail before the candidate scene is swapped into the viewport.
 */
export function compileShaderGraph({ TSL, graph, parameterValues = {}, textureResolver } = {}) {
  if (!TSL) fail('shader_compiler_unavailable', 'The Three.js TSL module is required for live shader graph compilation.');
  const source = graph?.graph ?? graph;
  if (!source) fail('shader_graph_missing', 'A shader graph document is required.');
  const canonical = assertValidGraph(source);
  if (!['shader', 'texture'].includes(canonical.domain)) fail('shader_domain_unsupported', `Graph domain ${canonical.domain} cannot compile as a material.`);
  const textureIds = new Set();
  const featureTracker = { requiresGeometryUv: false };
  const trackedTextureResolver = textureResolver
    ? textureId => {
        const texture = textureResolver(textureId);
        if (texture) textureIds.add(textureId);
        return texture;
      }
    : undefined;
  const { compileOutput, cache } = compileNodeFactory({
    TSL,
    graph: canonical,
    parameters: parameterValues,
    textureResolver: trackedTextureResolver,
    featureTracker,
  });
  const outputs = {};
  for (const [name, reference] of Object.entries(canonical.outputs)) outputs[name] = compileOutput(reference.nodeId, reference.port);
  let features = Object.freeze({
    transparent: false,
    transmission: false,
    sheen: false,
    specular: false,
    anisotropy: false,
    iridescence: false,
  });
  if (isCompiledSurface(outputs.surface)) {
    const value = outputs.surface;
    features = value.features;
    outputs.baseColor ??= value.baseColor;
    outputs.metalness ??= value.metallic;
    outputs.roughness ??= value.roughness;
    outputs.normal ??= value.normal;
    outputs.emissive ??= value.emissionColor.mul(value.emissionStrength);
    outputs.opacity ??= value.alpha;
    outputs.ior ??= value.ior;
    outputs.clearcoat ??= value.coatWeight;
    outputs.clearcoatRoughness ??= value.coatRoughness;
    outputs.transmission ??= value.transmissionWeight;
    if (features.sheen) {
      outputs.sheen ??= value.sheenWeight;
      outputs.sheenRoughness ??= value.sheenRoughness;
      outputs.sheenColor ??= value.sheenTint;
    }
    if (features.specular) {
      outputs.specularIntensity ??= value.specularIorLevel;
      outputs.specularColor ??= value.specularTint;
    }
    if (features.anisotropy) {
      outputs.anisotropy ??= value.anisotropic;
      outputs.anisotropyRotation ??= value.anisotropicRotation;
    }
    if (features.iridescence) {
      outputs.iridescence ??= value.thinFilmThickness ? TSL.float(1) : value.thinFilmThickness;
      outputs.iridescenceIOR ??= value.thinFilmIor;
      outputs.iridescenceThickness ??= value.thinFilmThickness;
    }
    if (value.coatNormal) outputs.clearcoatNormal ??= value.coatNormal;
  }
  return Object.freeze({
    graphId: canonical.id,
    domain: canonical.domain,
    mode: 'tsl-webgpu',
    outputs: Object.freeze(outputs),
    outputNames: Object.freeze(Object.keys(canonical.outputs)),
    features,
    nodesCompiled: new Set([...cache.keys()].map(key => key.split('\u0000')[0])).size,
    textureIds: Object.freeze([...textureIds].sort()),
    requiresGeometryUv: featureTracker.requiresGeometryUv,
  });
}

export const BLENDER_SHADER_NODE_ALIASES = TYPE_ALIASES;
