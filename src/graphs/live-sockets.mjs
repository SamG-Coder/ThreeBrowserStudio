import { getGraphNode } from './catalogs.mjs';
import { stableStringify } from '../core/util.mjs';

export const GRAPH_SOCKET_CONTRACT = 'full-vs-default+live';
export const PIXEL_QUANTUM = 1 / 255;

/** Canonical Studio types that have a live TSL compiler branch. */
export const COMPILED_SHADER_NODE_TYPES = Object.freeze(new Set([
  'constant.float', 'blender.value',
  'constant.vec2', 'constant.vec3',
  'constant.color', 'blender.rgb',
  'blender.inputVector', 'blender.rgbToBw',
  'blender.reroute',
  'input.uv', 'input.worldPosition', 'input.normal', 'input.viewDirection', 'input.time',
  'uv', 'worldPosition', 'constant',
  'texture.sample2d',
  'pattern.gradient', 'gradient',
  'pattern.checker', 'checker',
  'noise.value', 'valueNoise',
  'noise.fbm', 'fbm',
  'noise.voronoi', 'voronoi',
  'ramp.color', 'colorRamp',
  'arithmetic',
  'math.add', 'math.subtract', 'math.multiply', 'math.divide',
  'math.min', 'math.max', 'math.power',
  'math.abs', 'math.saturate', 'math.mix', 'mix', 'math.remap', 'remap',
  'vector.dot', 'vector.normalize', 'vector.combine3',
  'normal.fromHeight', 'normalFromHeight',
  'lighting.fresnel',
  'warp', 'channelPack',
  'blender.textureCoordinate', 'blender.separateXYZ', 'blender.combineXYZ', 'blender.mapping',
  'blender.checkerTexture', 'blender.gradientTexture', 'blender.whiteNoiseTexture',
  'blender.magicTexture', 'blender.brickTexture', 'blender.math', 'blender.vectorMath',
  'blender.noiseTexture', 'blender.voronoiTexture', 'blender.waveTexture',
  'blender.colorRamp', 'blender.mapRange', 'blender.mix',
  'blender.attribute', 'blender.colorAttribute',
  'blender.bump', 'blender.normalMap',
  'blender.fresnel', 'blender.layerWeight',
  'blender.gamma', 'blender.invert', 'blender.brightnessContrast', 'blender.clamp',
  'blender.separateColor', 'blender.combineColor', 'blender.hueSaturation',
  'blender.principledBSDF', 'blender.materialOutput',
]));

export const PRINCIPLED_CATALOG_ONLY_SOCKETS = Object.freeze(new Set([
  'weight',
  'diffuseRoughness',
  'subsurfaceWeight',
  'subsurfaceRadius',
  'subsurfaceScale',
  'subsurfaceIor',
  'subsurfaceAnisotropy',
  'coatIor',
  'coatTint',
  'tangent',
]));

export const PRINCIPLED_ALWAYS_LIVE_SOCKETS = Object.freeze(new Set([
  'baseColor',
  'metallic',
  'roughness',
  'ior',
  'alpha',
  'emissionColor',
  'emissionStrength',
  'coatWeight',
  'coatRoughness',
  'transmissionWeight',
]));

function valuesEqual(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function incomingHas(incoming, port) {
  if (!incoming) return false;
  if (typeof incoming.has === 'function') return incoming.has(port);
  return Object.hasOwn(incoming, port);
}

function nodeStatic(node, ports, fallback) {
  const names = Array.isArray(ports) ? ports : [ports];
  const inputs = node?.inputs ?? {};
  for (const port of names) {
    if (Object.hasOwn(inputs, port)) return inputs[port];
  }
  return fallback;
}

export function canonicalGraphNodeType(domain, type) {
  const definition = getGraphNode(domain, type);
  return definition?.canonicalType ?? definition?.type ?? type;
}

export function isCompiledShaderNodeType(domain, type) {
  const canonical = canonicalGraphNodeType(domain, type);
  if (typeof canonical === 'string' && canonical.startsWith('parameter.')) return true;
  if (canonical === 'blur') return false;
  return COMPILED_SHADER_NODE_TYPES.has(canonical);
}

export function bumpEffectiveScale(strength, distance) {
  const scale = Math.abs(Number(strength) * Number(distance));
  return Number.isFinite(scale) ? scale : null;
}

export function isBelowPixelQuantum(scale) {
  return Number.isFinite(scale) && scale < PIXEL_QUANTUM;
}

/**
 * Principled extra-lobe flags used by both TSL compile and inspect/forecast.
 * Defaults stay unbound so catalog zeros do not start unused lobes.
 */
export function principledFeatureFlags(node, incoming) {
  const sheenConnected = incomingHas(incoming, 'sheenWeight') || incomingHas(incoming, 'sheen');
  const staticSheen = sheenConnected ? null : Number(nodeStatic(node, ['sheenWeight', 'sheen'], 0));
  const sheen = sheenConnected || (Number.isFinite(staticSheen) && staticSheen > 0);

  const specLevelConnected = incomingHas(incoming, 'specularIorLevel') || incomingHas(incoming, 'specularIntensity');
  const specTintConnected = incomingHas(incoming, 'specularTint') || incomingHas(incoming, 'specularColor');
  const staticSpec = specLevelConnected ? null : nodeStatic(node, ['specularIorLevel', 'specularIntensity'], 0.5);
  const staticTint = specTintConnected ? null : nodeStatic(node, ['specularTint', 'specularColor'], [1, 1, 1, 1]);
  const specular = specLevelConnected
    || specTintConnected
    || (Number.isFinite(staticSpec) && staticSpec !== 0.5)
    || (staticTint !== null && !valuesEqual(staticTint, [1, 1, 1, 1]));

  const anisoConnected = incomingHas(incoming, 'anisotropic')
    || incomingHas(incoming, 'anisotropy')
    || incomingHas(incoming, 'anisotropicRotation');
  const staticAniso = anisoConnected ? null : Number(nodeStatic(node, ['anisotropic', 'anisotropy'], 0));
  const anisotropy = anisoConnected || (Number.isFinite(staticAniso) && staticAniso > 0);

  const filmConnected = incomingHas(incoming, 'thinFilmThickness') || incomingHas(incoming, 'thinFilmIor');
  const staticFilm = filmConnected ? null : Number(nodeStatic(node, 'thinFilmThickness', 0));
  const iridescence = filmConnected || (Number.isFinite(staticFilm) && staticFilm > 0);

  return {
    sheen,
    specular,
    anisotropy,
    iridescence,
    coatNormal: incomingHas(incoming, 'coatNormal'),
    normal: incomingHas(incoming, 'normal'),
  };
}

function describePrincipledSocket(node, port, incoming) {
  if (PRINCIPLED_CATALOG_ONLY_SOCKETS.has(port)) {
    return { compiled: true, live: false, reason: 'catalog-only-socket' };
  }
  if (PRINCIPLED_ALWAYS_LIVE_SOCKETS.has(port)) {
    return { compiled: true, live: true, reason: 'live-tsl' };
  }
  const features = principledFeatureFlags(node, incoming);
  if (port === 'normal') {
    return { compiled: true, live: features.normal, reason: features.normal ? 'live-tsl' : 'unbound-default-normal' };
  }
  if (port === 'coatNormal') {
    return { compiled: true, live: features.coatNormal, reason: features.coatNormal ? 'live-tsl' : 'unbound-unless-connected' };
  }
  if (port === 'sheenWeight' || port === 'sheenRoughness' || port === 'sheenTint') {
    return { compiled: true, live: features.sheen, reason: features.sheen ? 'live-tsl' : 'unbound-zero-sheen' };
  }
  if (port === 'specularIorLevel' || port === 'specularTint') {
    return { compiled: true, live: features.specular, reason: features.specular ? 'live-tsl' : 'unbound-default-specular' };
  }
  if (port === 'anisotropic' || port === 'anisotropicRotation') {
    return { compiled: true, live: features.anisotropy, reason: features.anisotropy ? 'live-tsl' : 'unbound-zero-anisotropy' };
  }
  if (port === 'thinFilmThickness' || port === 'thinFilmIor') {
    return { compiled: true, live: features.iridescence, reason: features.iridescence ? 'live-tsl' : 'unbound-zero-thin-film' };
  }
  return { compiled: true, live: false, reason: 'catalog-only-socket' };
}

/**
 * Whether a catalog socket is in the live TSL subset for this node instance.
 * `incoming` is a Set/Map of connected input port names.
 */
export function describeSocketLiveness(node, domain, port, incoming) {
  const compiled = isCompiledShaderNodeType(domain, node?.type);
  if (!compiled) {
    return { compiled: false, live: false, reason: 'catalog-only-node' };
  }
  const canonical = canonicalGraphNodeType(domain, node.type);
  if (canonical === 'blender.principledBSDF') {
    return describePrincipledSocket(node, port, incoming);
  }
  return { compiled: true, live: true, reason: 'live-tsl' };
}
