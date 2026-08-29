import { GRAPH_CATALOGS, GRAPH_OUTPUTS, validateGraph } from '../graphs/index.mjs';
import {
  clamp01,
  combineSeeds,
  fbm2D,
  hashFloatUnit,
  sampleColorRamp,
  valueNoise2D,
  voronoi2D,
  wave2D,
} from './procedural-texture-noise.mjs';
import {
  combineBlenderColor,
  mixBlenderValues,
  sampleBlenderColorRamp,
  separateBlenderColor,
} from './procedural-texture-color.mjs';

export const PROCEDURAL_TEXTURE_LIMITS = Object.freeze({
  maxNodes: 256,
  maxEdges: 1024,
  maxResolution: 2048,
  maxPixels: 2048 * 2048,
  maxOutputs: 4,
  maxBlurRadius: 16,
  maxBlenderNoiseDetail: 8,
  maxBlenderVoronoiDetail: 7,
  maxVoronoiCandidateVisits: 2500,
  maxEstimatedSamples: 250_000_000,
});

export const PROCEDURAL_TEXTURE_MAPS = Object.freeze({
  albedo: Object.freeze({ channels: 4, format: 'rgba8unorm', colorSpace: 'srgb' }),
  roughness: Object.freeze({ channels: 1, format: 'r8unorm', colorSpace: 'none' }),
  normal: Object.freeze({ channels: 4, format: 'rgba8unorm', colorSpace: 'none' }),
  height: Object.freeze({ channels: 1, format: 'r32float', colorSpace: 'none' }),
});

const GRAPH_KEYS = new Set(['formatVersion', 'id', 'domain', 'nodes', 'edges', 'outputs', 'settings']);
const NODE_KEYS = new Set(['id', 'type', 'params', 'inputs', 'layout']);
const EDGE_KEYS = new Set(['from', 'to']);
const REF_KEYS = new Set(['nodeId', 'port']);
const OUTPUT_REF_KEYS = new Set(['nodeId', 'port', 'colorSpace']);
const SETTING_KEYS = new Set(['seed', 'resolution', 'wrapS', 'wrapT', 'minFilter', 'magFilter', 'mode']);
const STABLE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;

const catalogModes = (nodeType, property) => new Set(GRAPH_CATALOGS.texture.nodes[nodeType].params[property].values);
const BLENDER_NOISE_DIMENSIONS = catalogModes('blender.noiseTexture', 'dimensions');
const BLENDER_NOISE_TYPES = catalogModes('blender.noiseTexture', 'noiseType');
const CPU_NOISE_DIMENSIONS = new Set(['2D']);
const CPU_NOISE_TYPES = new Set(['FBM']);
const BLENDER_VORONOI_FEATURES = catalogModes('blender.voronoiTexture', 'feature');
const CPU_VORONOI_FEATURES = new Set(['F1', 'F2', 'DISTANCE_TO_EDGE']);
const BLENDER_VORONOI_METRICS = catalogModes('blender.voronoiTexture', 'distanceMetric');
const CPU_VORONOI_METRICS = new Set(['EUCLIDEAN', 'MANHATTAN', 'CHEBYCHEV']);
const BLENDER_RAMP_INTERPOLATIONS = catalogModes('blender.colorRamp', 'interpolation');
const CPU_RAMP_INTERPOLATIONS = BLENDER_RAMP_INTERPOLATIONS;
const BLENDER_RAMP_COLOR_MODES = catalogModes('blender.colorRamp', 'colorMode');
const CPU_RAMP_COLOR_MODES = BLENDER_RAMP_COLOR_MODES;
const BLENDER_HUE_INTERPOLATIONS = catalogModes('blender.colorRamp', 'hueInterpolation');
const BLENDER_MIX_MODES = catalogModes('blender.mix', 'blendMode');
const CPU_MIX_MODES = BLENDER_MIX_MODES;
const BLENDER_COLOR_MODES = catalogModes('blender.separateColor', 'mode');
const NUMERIC_VALUE_TYPES = new Set([...catalogModes('blender.mix', 'valueType')].map(value => value.toUpperCase()));

const COMMON_NOISE_PARAMS = [
  'seed', 'scale', 'detail', 'octaves', 'roughness', 'gain', 'lacunarity',
  'distortion', 'normalize',
];

const NODE_SPECS = Object.freeze({
  coordinate: spec([], ['uv', 'generated', 'object', 'position', 'vector', 'normal'], ['space', 'fromInstancer']),
  normalInput: spec([], ['normal'], []),
  viewInput: spec([], ['direction', 'viewdirection', 'vector'], []),
  timeInput: spec([], ['seconds', 'value'], ['time']),
  constant: spec([], ['value', 'fac', 'color', 'vector'], ['value', 'valueType', 'name']),
  reroute: spec([['input', 'value']], ['output', 'value'], ['valueType']),
  separate: spec([['vector', 'value']], ['x', 'y', 'z'], []),
  combine: spec([['x'], ['y'], ['z']], ['value', 'vector'], []),
  separateColor: spec([['color']], ['red', 'green', 'blue', 'alpha'], ['mode']),
  combineColor: spec([['red'], ['green'], ['blue']], ['color'], ['mode']),
  mapping: spec([['vector', 'coordinate']], ['vector', 'value'], [
    'location', 'translation', 'rotation', 'scale', 'vectorType',
  ]),
  valueNoise: spec([['coordinate', 'vector']], ['value', 'fac', 'factor', 'color'], [
    ...COMMON_NOISE_PARAMS, 'dimensions', 'noiseType',
  ]),
  fbm: spec([['coordinate', 'vector']], ['value', 'fac', 'factor', 'color'], [
    ...COMMON_NOISE_PARAMS, 'dimensions', 'noiseType',
  ]),
  voronoi: spec([['coordinate', 'vector']], ['distance', 'f1', 'f2', 'edge', 'cell', 'color'], [
    'seed', 'scale', 'randomness', 'feature', 'distanceMetric', 'metric', 'dimensions', 'normalize',
  ]),
  wave: spec([['coordinate', 'vector']], ['value', 'fac', 'factor', 'color'], [
    'seed', 'scale', 'distortion', 'detail', 'detailScale', 'detailRoughness',
    'phase', 'phaseOffset', 'direction', 'bandsDirection', 'ringsDirection', 'waveType', 'profile',
  ]),
  ramp: spec([['value', 'fac', 'factor']], ['color', 'alpha'], [
    'stops', 'interpolation', 'colorMode', 'hueInterpolation',
  ]),
  arithmetic: spec([['a', 'value'], ['b']], ['value'], ['operation', 'valueType', 'clamp']),
  unaryMath: spec([['value', 'a']], ['value'], ['operation', 'valueType', 'clamp']),
  mix: spec([['a', 'color1'], ['b', 'color2'], ['factor', 'fac']], ['value', 'result', 'color'], [
    'valueType', 'blendType', 'blendMode', 'operation', 'clamp', 'clampFactor', 'clampResult',
  ]),
  remap: spec([['value']], ['value', 'result'], [
    'inMin', 'inMax', 'outMin', 'outMax', 'fromMin', 'fromMax', 'toMin', 'toMax',
    'clamp', 'interpolation', 'interpolationType', 'steps',
  ]),
  gradient: spec([['coordinate', 'vector', 'value', 'fac']], ['value', 'fac', 'factor', 'color'], ['start', 'end', 'gradientType']),
  checker: spec([['coordinate', 'vector'], ['a', 'color1'], ['b', 'color2']], ['color', 'value', 'factor'], ['scale']),
  whiteNoise: spec([], ['value', 'color'], ['dimensions']),
  magic: spec([], ['color', 'factor', 'value'], ['depth']),
  brick: spec([], ['color', 'factor', 'value'], ['offset', 'offsetFrequency', 'squash', 'squashFrequency']),
  warp: spec([['coordinate', 'vector'], ['offset']], ['coordinate', 'vector'], ['strength']),
  blur: spec([['value', 'color', 'fac']], ['value', 'color'], ['valueType', 'radius']),
  normalFromHeight: spec([['height', 'value']], ['normal'], ['strength', 'distance', 'invert']),
  channelPack: spec([], ['value', 'color'], ['defaults']),
  image: spec([['uv', 'vector']], ['color', 'alpha'], ['assetId', 'textureId', 'colorSpace']),
  dot: spec([['a'], ['b']], ['value'], []),
  normalize: spec([['value', 'vector']], ['value', 'vector'], []),
  fresnel: spec([['normal'], ['viewdirection', 'view']], ['value', 'fac'], ['power']),
});

function spec(requiredInputs, outputs, params) {
  return Object.freeze({
    requiredInputs: Object.freeze(requiredInputs.map(group => Object.freeze(group))),
    outputs: Object.freeze(outputs),
    params: Object.freeze(params),
  });
}

function diagnostic(code, message, path, details = {}) {
  return Object.freeze({ severity: 'error', code, message, path, ...details });
}

function warning(code, message, path, details = {}) {
  return Object.freeze({ severity: 'warning', code, message, path, ...details });
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function portKey(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function typeKey(value) {
  return portKey(value);
}

function classifyNode(node) {
  const key = typeKey(node.type);
  if (['uv', 'inputuv', 'uvmap', 'shadernodeuvmap'].includes(key)) return { kind: 'coordinate', variant: 'uv' };
  if (['worldposition', 'inputworldposition', 'object', 'objectcoordinate'].includes(key)) return { kind: 'coordinate', variant: 'object' };
  if (['generated', 'generatedcoordinate'].includes(key)) return { kind: 'coordinate', variant: 'generated' };
  if (['texturecoordinate', 'shadernodetexcoord', 'texcoord', 'blendertexturecoordinate'].includes(key)) return { kind: 'coordinate', variant: 'multi', blenderDefaults: true };
  if (['inputnormal', 'normalinput', 'geometrynormal'].includes(key)) return { kind: 'normalInput' };
  if (['inputviewdirection', 'viewdirection'].includes(key)) return { kind: 'viewInput' };
  if (['inputtime', 'time'].includes(key)) return { kind: 'timeInput' };

  const constants = new Map([
    ['constant', null], ['constantfloat', 'float'], ['parameterfloat', 'float'],
    ['shadernodevalue', 'float'], ['blendervalue', 'float'], ['value', 'float'], ['constantvec2', 'vec2'],
    ['parametervec2', 'vec2'], ['constantvec3', 'vec3'], ['parametervec3', 'vec3'],
    ['constantcolor', 'color'], ['parametercolor', 'color'], ['shadernodergb', 'color'], ['blenderrgb', 'color'],
    ['rgb', 'color'],
  ]);
  if (constants.has(key)) return { kind: 'constant', variant: constants.get(key) };
  if (['nodereroute', 'blenderreroute'].includes(key)) return { kind: 'reroute', blenderDefaults: true };
  if (['separatexyz', 'vectorseparatexyz', 'shadernodeseparatexyz', 'blenderseparatexyz'].includes(key)) return { kind: 'separate', blenderDefaults: key.startsWith('shadernode') || key.startsWith('blender') };
  if (['vectorcombine3', 'combinexyz', 'shadernodecombinexyz', 'blendercombinexyz'].includes(key)) return { kind: 'combine', blenderDefaults: key.startsWith('shadernode') || key.startsWith('blender') };
  if (['separatecolor', 'shadernodeseparatecolor', 'blenderseparatecolor'].includes(key)) return { kind: 'separateColor', blenderDefaults: true };
  if (['combinecolor', 'shadernodecombinecolor', 'blendercombinecolor'].includes(key)) return { kind: 'combineColor', blenderDefaults: true };
  if (['mapping', 'vectormapping', 'shadernodemapping', 'blendermapping'].includes(key)) return { kind: 'mapping', blenderDefaults: key.startsWith('shadernode') || key.startsWith('blender') };
  if (['valuenoise', 'noisevalue'].includes(key)) return { kind: 'valueNoise' };
  if (['fbm', 'noisefbm', 'noisetexture', 'shadernodetexnoise', 'blendernoisetexture'].includes(key)) return { kind: 'fbm', blenderDefaults: key.startsWith('shadernode') || key.startsWith('blender') };
  if (['voronoi', 'noisevoronoi', 'voronoitexture', 'shadernodetexvoronoi', 'blendervoronoitexture'].includes(key)) return { kind: 'voronoi', blenderDefaults: key.startsWith('shadernode') || key.startsWith('blender') };
  if (['wave', 'wavetexture', 'shadernodetexwave', 'blenderwavetexture'].includes(key)) return { kind: 'wave', blenderDefaults: key.startsWith('shadernode') || key.startsWith('blender') };
  if (['colorramp', 'rampcolor', 'valtorgb', 'shadernodevaltorgb', 'blendercolorramp'].includes(key)) return { kind: 'ramp', blenderDefaults: key.startsWith('shadernode') || key.startsWith('blender') };
  if (['mix', 'mathmix', 'mixrgb', 'shadernodemix', 'shadernodemixrgb', 'blendermix'].includes(key)) return { kind: 'mix', blenderDefaults: key.startsWith('shadernode') || key.startsWith('blender') };
  if (['remap', 'mathremap', 'maprange', 'shadernodemaprange', 'blendermaprange'].includes(key)) return { kind: 'remap', blenderDefaults: key.startsWith('shadernode') || key.startsWith('blender') };
  if (['gradient', 'patterngradient'].includes(key)) return { kind: 'gradient' };
  if (['gradienttexture', 'shadernodetexgradient', 'blendergradienttexture'].includes(key)) return { kind: 'gradient', variant: 'blender', blenderDefaults: true };
  if (['checker', 'patternchecker', 'checkertexture'].includes(key)) return { kind: 'checker' };
  if (['shadernodetexchecker', 'blendercheckertexture'].includes(key)) return { kind: 'checker', variant: 'blender', blenderDefaults: true };
  if (['whitenoisetexture', 'shadernodetexwhitenoise', 'blenderwhitenoisetexture'].includes(key)) return { kind: 'whiteNoise', blenderDefaults: true };
  if (['magictexture', 'shadernodetexmagic', 'blendermagictexture'].includes(key)) return { kind: 'magic', blenderDefaults: true };
  if (['bricktexture', 'shadernodetexbrick', 'blenderbricktexture'].includes(key)) return { kind: 'brick', blenderDefaults: true };
  if (key === 'warp') return { kind: 'warp' };
  if (key === 'blur') return { kind: 'blur' };
  if (['normalfromheight', 'bump', 'shadernodebump', 'blenderbump'].includes(key)) return { kind: 'normalFromHeight', blenderDefaults: key.startsWith('shadernode') || key.startsWith('blender') };
  if (key === 'channelpack') return { kind: 'channelPack' };
  if (['image', 'texturesample2d', 'imagetexture', 'shadernodeteximage'].includes(key)) return { kind: 'image' };
  if (['vectordot', 'dotproduct'].includes(key)) return { kind: 'dot' };
  if (['vectornormalize', 'normalize'].includes(key)) return { kind: 'normalize' };
  if (['lightingfresnel', 'fresnel'].includes(key)) return { kind: 'fresnel' };

  if (key === 'arithmetic' || key === 'math' || key === 'shadernodemath' || key === 'blendermath') {
    const operation = normalizeOperation(node.params?.operation ?? 'add');
    return { kind: isUnaryOperation(operation) ? 'unaryMath' : 'arithmetic', operation, blenderDefaults: key.startsWith('shadernode') || key.startsWith('blender') };
  }
  if (key.startsWith('math')) {
    const operation = normalizeOperation(key.slice(4));
    if (SUPPORTED_BINARY_OPERATIONS.has(operation)) return { kind: 'arithmetic', operation };
    if (SUPPORTED_UNARY_OPERATIONS.has(operation)) return { kind: 'unaryMath', operation };
  }
  return null;
}

const SUPPORTED_BINARY_OPERATIONS = new Set([
  'add', 'subtract', 'multiply', 'divide', 'min', 'max', 'power', 'modulo',
  'greaterthan', 'lessthan',
]);
const SUPPORTED_UNARY_OPERATIONS = new Set([
  'abs', 'saturate', 'clamp', 'sine', 'cosine', 'floor', 'ceil', 'fract', 'sqrt', 'negate',
]);

function normalizeOperation(value) {
  const key = portKey(value);
  const aliases = {
    absolute: 'abs', minimum: 'min', maximum: 'max', pingpong: 'triangle',
    multiplyadd: 'multiplyadd', greater: 'greaterthan', less: 'lessthan',
  };
  return aliases[key] ?? key;
}

function isUnaryOperation(operation) {
  return SUPPORTED_UNARY_OPERATIONS.has(operation);
}

function exactKeys(value, allowed, path, diagnostics, code = 'procedural_unknown_property') {
  if (!isPlainRecord(value)) {
    diagnostics.push(diagnostic('procedural_invalid_type', 'Expected a plain object.', path));
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) diagnostics.push(diagnostic(code, `Unknown property "${key}".`, `${path}/${key}`));
  }
  return true;
}

function finiteJson(value, path, diagnostics, seen = new Set(), depth = 0) {
  if (depth > 24) {
    diagnostics.push(diagnostic('procedural_value_depth_exceeded', 'Value nesting exceeds 24 levels.', path));
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) diagnostics.push(diagnostic('procedural_non_finite_number', 'Numbers must be finite.', path));
    return;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value !== 'object') {
    diagnostics.push(diagnostic('procedural_invalid_json_value', 'Only JSON values are accepted.', path));
    return;
  }
  if (seen.has(value)) {
    diagnostics.push(diagnostic('procedural_cyclic_value', 'Cyclic values are forbidden.', path));
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) value.forEach((entry, index) => finiteJson(entry, `${path}/${index}`, diagnostics, seen, depth + 1));
  else if (!isPlainRecord(value)) diagnostics.push(diagnostic('procedural_invalid_json_value', 'Only plain JSON objects are accepted.', path));
  else {
    for (const [key, entry] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) {
        diagnostics.push(diagnostic('procedural_forbidden_property', `Property "${key}" is forbidden.`, `${path}/${key}`));
      }
      finiteJson(entry, `${path}/${key}`, diagnostics, seen, depth + 1);
    }
  }
  seen.delete(value);
}

function copyGraphEnvelope(graph) {
  return {
    formatVersion: graph.formatVersion,
    id: graph.id,
    domain: graph.domain,
    nodes: graph.nodes.map(node => ({
      id: node.id,
      type: node.type,
      params: structuredClone(node.params ?? {}),
      ...(node.inputs === undefined ? {} : { inputs: structuredClone(node.inputs) }),
      ...(node.layout === undefined ? {} : { layout: structuredClone(node.layout) }),
    })),
    edges: graph.edges.map(edge => structuredClone(edge)),
    outputs: structuredClone(graph.outputs),
    ...(graph.settings === undefined ? {} : { settings: structuredClone(graph.settings) }),
  };
}

function validateAliasEnvelope(rawGraph, diagnostics) {
  if (!isPlainRecord(rawGraph)) {
    diagnostics.push(diagnostic('procedural_invalid_graph', 'Graph must be a plain object.', '/'));
    return null;
  }
  exactKeys(rawGraph, GRAPH_KEYS, '', diagnostics);
  finiteJson(rawGraph, '', diagnostics);
  if (rawGraph.formatVersion !== 1) diagnostics.push(diagnostic('procedural_unsupported_format_version', 'formatVersion must be 1.', '/formatVersion'));
  if (!STABLE_ID.test(rawGraph.id ?? '')) diagnostics.push(diagnostic('procedural_invalid_graph_id', 'Graph id must be a stable project ID.', '/id'));
  if (!['texture', 'shader'].includes(rawGraph.domain)) diagnostics.push(diagnostic('procedural_invalid_domain', 'Only texture and shader graphs can be CPU baked.', '/domain'));
  if (!Array.isArray(rawGraph.nodes)) diagnostics.push(diagnostic('procedural_invalid_nodes', 'nodes must be an array.', '/nodes'));
  if (!Array.isArray(rawGraph.edges)) diagnostics.push(diagnostic('procedural_invalid_edges', 'edges must be an array.', '/edges'));
  if (!isPlainRecord(rawGraph.outputs)) diagnostics.push(diagnostic('procedural_invalid_outputs', 'outputs must be an object.', '/outputs'));
  if (rawGraph.settings !== undefined) exactKeys(rawGraph.settings, SETTING_KEYS, '/settings', diagnostics, 'procedural_unknown_setting');
  if (!Array.isArray(rawGraph.nodes) || !Array.isArray(rawGraph.edges) || !isPlainRecord(rawGraph.outputs)) return null;
  return copyGraphEnvelope(rawGraph);
}

function currentCatalogGraph(graph) {
  const catalog = GRAPH_CATALOGS[graph?.domain];
  return Boolean(catalog && Array.isArray(graph.nodes)
    && graph.nodes.every(node => catalog.nodes[node?.type]));
}

function imageSources(options) {
  return options.images ?? options.textures ?? new Map();
}

function getImageSource(sources, id) {
  if (!id) return null;
  if (sources instanceof Map) return sources.get(id) ?? null;
  if (isPlainRecord(sources)) return sources[id] ?? null;
  return null;
}

function validImageSource(source) {
  if (!source || !Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height)
    || source.width < 1 || source.height < 1 || !Number.isSafeInteger(source.channels)
    || source.channels < 1 || source.channels > 4 || !ArrayBuffer.isView(source.data)) return false;
  return source.data.length >= source.width * source.height * source.channels;
}

function validateResolution(graph, options, diagnostics) {
  const resolution = options.resolution ?? graph.settings?.resolution ?? [256, 256];
  const maxResolution = Math.max(1, Math.min(
    PROCEDURAL_TEXTURE_LIMITS.maxResolution,
    Number.isSafeInteger(options.maxResolution) ? options.maxResolution : PROCEDURAL_TEXTURE_LIMITS.maxResolution,
  ));
  if (!Array.isArray(resolution) || resolution.length !== 2
    || resolution.some(value => !Number.isSafeInteger(value) || value < 1 || value > maxResolution)) {
    diagnostics.push(diagnostic(
      'procedural_resolution_exceeded',
      `resolution must contain two integers from 1 to ${maxResolution}.`,
      '/settings/resolution',
    ));
    return [1, 1];
  }
  if (resolution[0] * resolution[1] > PROCEDURAL_TEXTURE_LIMITS.maxPixels) {
    diagnostics.push(diagnostic(
      'procedural_pixel_budget_exceeded',
      `Texture exceeds the ${PROCEDURAL_TEXTURE_LIMITS.maxPixels} pixel CPU bake budget.`,
      '/settings/resolution',
    ));
  }
  return [...resolution];
}

function sourceMapName(domain, outputName) {
  if (domain === 'shader' && outputName === 'baseColor') return 'albedo';
  return ['albedo', 'roughness', 'normal', 'height'].includes(outputName) ? outputName : null;
}

function modeValue(value, fallback) {
  return String(value ?? fallback).toUpperCase();
}

function blenderStyleNoise(descriptor) {
  const key = typeKey(descriptor.node.type);
  return descriptor.classification.blenderDefaults || ['noisetexture', 'shadernodetexnoise', 'blendernoisetexture'].includes(key);
}

function blenderStyleVoronoi(descriptor) {
  const key = typeKey(descriptor.node.type);
  return descriptor.classification.blenderDefaults || ['voronoitexture', 'shadernodetexvoronoi', 'blendervoronoitexture'].includes(key);
}

function blenderStyleRamp(descriptor) {
  const key = typeKey(descriptor.node.type);
  return descriptor.classification.blenderDefaults
    || ['valtorgb', 'shadernodevaltorgb', 'blendercolorramp'].includes(key)
    || Object.hasOwn(descriptor.node.params ?? {}, 'colorMode')
    || Object.hasOwn(descriptor.node.params ?? {}, 'hueInterpolation');
}

function blenderStyleMix(descriptor) {
  const key = typeKey(descriptor.node.type);
  return descriptor.classification.blenderDefaults
    || ['mixrgb', 'shadernodemix', 'shadernodemixrgb', 'blendermix'].includes(key)
    || Object.hasOwn(descriptor.node.params ?? {}, 'blendMode');
}

function literalInput(node, name, fallback) {
  const entry = Object.entries(node.inputs ?? {}).find(([key]) => portKey(key) === portKey(name));
  return entry ? entry[1] : fallback;
}

function numericLiteralInput(node, name, fallback) {
  const value = literalInput(node, name, fallback);
  return Number.isFinite(value) ? value : NaN;
}

function modeDiagnostic(diagnostics, path, node, property, value, supported) {
  diagnostics.push(diagnostic(
    'procedural_node_mode_unsupported',
    `${node.type} ${property} ${value} is catalogued but is not implemented by bounded CPU bake.`,
    `${path}/params/${property}`,
    { nodeId: node.id, nodeType: node.type, property, value, supported: [...supported] },
  ));
}

function invalidModeDiagnostic(diagnostics, path, node, property, value, advertised) {
  diagnostics.push(diagnostic(
    'procedural_invalid_node_mode',
    `${node.type} ${property} ${value} is not an advertised mode.`,
    `${path}/params/${property}`,
    { nodeId: node.id, nodeType: node.type, property, value, advertised: [...advertised] },
  ));
}

function validateMode({ diagnostics, path, node, property, value, advertised, supported }) {
  if (!advertised.has(value)) invalidModeDiagnostic(diagnostics, path, node, property, value, advertised);
  else if (!supported.has(value)) modeDiagnostic(diagnostics, path, node, property, value, supported);
}

function voronoiCost(descriptor) {
  const node = descriptor.node;
  const dimensions = Math.max(1, Math.min(4, Number.parseInt(modeValue(node.params?.dimensions, '3D'), 10) || 3));
  const feature = modeValue(node.params?.feature, 'F1');
  const dynamicDetail = descriptor.inputs.has('detail');
  const detailValue = numericLiteralInput(node, 'detail', 0);
  const detail = dynamicDetail || !Number.isFinite(detailValue)
    ? PROCEDURAL_TEXTURE_LIMITS.maxBlenderVoronoiDetail
    : Math.max(0, Math.min(PROCEDURAL_TEXTURE_LIMITS.maxBlenderVoronoiDetail, Math.floor(detailValue)));
  const radius = feature === 'SMOOTH_F1' ? 2 : 1;
  const passes = ['DISTANCE_TO_EDGE', 'N_SPHERE_RADIUS'].includes(feature) ? 2 : 1;
  const octaves = feature === 'N_SPHERE_RADIUS' ? 1 : detail + 1;
  const candidateVisits = (((radius * 2) + 1) ** dimensions) * passes * octaves;
  return { dimensions, feature, radius, passes, octaves, candidateVisits };
}

function validateCpuCapabilities(graph, runtimeNodes, diagnostics) {
  for (const descriptor of runtimeNodes.values()) {
    const { node, classification } = descriptor;
    const path = `/nodes/${graph.nodes.indexOf(node)}`;
    const params = node.params ?? {};

    if (classification.kind === 'fbm' && blenderStyleNoise(descriptor)) {
      const dimensions = modeValue(params.dimensions, '3D');
      const noiseType = modeValue(params.noiseType, 'FBM');
      validateMode({ diagnostics, path, node, property: 'dimensions', value: dimensions, advertised: BLENDER_NOISE_DIMENSIONS, supported: CPU_NOISE_DIMENSIONS });
      validateMode({ diagnostics, path, node, property: 'noiseType', value: noiseType, advertised: BLENDER_NOISE_TYPES, supported: CPU_NOISE_TYPES });
      if (params.normalize !== undefined && typeof params.normalize !== 'boolean') {
        diagnostics.push(diagnostic('procedural_invalid_node_property', `${node.type} normalize must be boolean.`, `${path}/params/normalize`, { nodeId: node.id, property: 'normalize' }));
      } else if (params.normalize === false) {
        diagnostics.push(diagnostic(
          'procedural_node_property_unsupported',
          `${node.type} normalize=false is catalogued but raw noise ranges are not implemented by bounded CPU bake.`,
          `${path}/params/normalize`,
          { nodeId: node.id, property: 'normalize', value: false, supported: true },
        ));
      }
      if (descriptor.inputs.has('detail')) {
        diagnostics.push(diagnostic(
          'procedural_dynamic_setting_unsupported',
          `${node.type} Detail must be a static socket value for bounded CPU bake.`,
          `${path}/inputs/detail`,
          { nodeId: node.id, property: 'detail' },
        ));
      } else {
        const detail = numericLiteralInput(node, 'detail', 2);
        if (!Number.isFinite(detail) || detail < 0 || detail > 15) {
          diagnostics.push(diagnostic('procedural_invalid_node_property', `${node.type} Detail must be in 0..15.`, `${path}/inputs/detail`, { nodeId: node.id, property: 'detail', value: detail }));
        } else if (detail > PROCEDURAL_TEXTURE_LIMITS.maxBlenderNoiseDetail) {
          diagnostics.push(diagnostic(
            'procedural_detail_limit_exceeded',
            `${node.type} Detail ${detail} exceeds the published live CPU limit ${PROCEDURAL_TEXTURE_LIMITS.maxBlenderNoiseDetail}.`,
            `${path}/inputs/detail`,
            { nodeId: node.id, property: 'detail', value: detail, limit: PROCEDURAL_TEXTURE_LIMITS.maxBlenderNoiseDetail },
          ));
        }
      }
    }

    if (classification.kind === 'voronoi' && blenderStyleVoronoi(descriptor)) {
      const dimensions = modeValue(params.dimensions, '3D');
      const feature = modeValue(params.feature, 'F1');
      const metric = modeValue(params.distanceMetric ?? params.metric, 'EUCLIDEAN');
      validateMode({ diagnostics, path, node, property: 'dimensions', value: dimensions, advertised: BLENDER_NOISE_DIMENSIONS, supported: CPU_NOISE_DIMENSIONS });
      validateMode({ diagnostics, path, node, property: 'feature', value: feature, advertised: BLENDER_VORONOI_FEATURES, supported: CPU_VORONOI_FEATURES });
      validateMode({ diagnostics, path, node, property: 'distanceMetric', value: metric, advertised: BLENDER_VORONOI_METRICS, supported: CPU_VORONOI_METRICS });
      if (params.normalize !== undefined && typeof params.normalize !== 'boolean') {
        diagnostics.push(diagnostic('procedural_invalid_node_property', `${node.type} normalize must be boolean.`, `${path}/params/normalize`, { nodeId: node.id, property: 'normalize' }));
      } else if (params.normalize === true) {
        diagnostics.push(diagnostic(
          'procedural_node_property_unsupported',
          `${node.type} normalize=true is catalogued but is not implemented by bounded CPU bake.`,
          `${path}/params/normalize`,
          { nodeId: node.id, property: 'normalize', value: true, supported: false },
        ));
      }

      if (descriptor.inputs.has('detail')) {
        diagnostics.push(diagnostic(
          'procedural_dynamic_setting_unsupported',
          `${node.type} Detail must be a static socket value for bounded CPU bake.`,
          `${path}/inputs/detail`,
          { nodeId: node.id, property: 'detail' },
        ));
      } else {
        const detail = numericLiteralInput(node, 'detail', 0);
        if (!Number.isFinite(detail) || detail < 0 || detail > 15) {
          diagnostics.push(diagnostic('procedural_invalid_node_property', `${node.type} Detail must be in 0..15.`, `${path}/inputs/detail`, { nodeId: node.id, property: 'detail', value: detail }));
        } else if (detail > PROCEDURAL_TEXTURE_LIMITS.maxBlenderVoronoiDetail) {
          diagnostics.push(diagnostic(
            'procedural_detail_limit_exceeded',
            `${node.type} Detail ${detail} exceeds the published live CPU limit ${PROCEDURAL_TEXTURE_LIMITS.maxBlenderVoronoiDetail}.`,
            `${path}/inputs/detail`,
            { nodeId: node.id, property: 'detail', value: detail, limit: PROCEDURAL_TEXTURE_LIMITS.maxBlenderVoronoiDetail },
          ));
        } else if (detail > 0) {
          diagnostics.push(diagnostic(
            'procedural_node_property_unsupported',
            `${node.type} fractal Detail is catalogued but is not implemented by bounded CPU bake.`,
            `${path}/inputs/detail`,
            { nodeId: node.id, property: 'detail', value: detail, supported: 0 },
          ));
        }
      }

      const cost = voronoiCost(descriptor);
      if (cost.candidateVisits > PROCEDURAL_TEXTURE_LIMITS.maxVoronoiCandidateVisits) {
        diagnostics.push(diagnostic(
          'procedural_node_budget_exceeded',
          `${node.type} requires ${cost.candidateVisits} Voronoi feature visits; the bounded CPU limit is ${PROCEDURAL_TEXTURE_LIMITS.maxVoronoiCandidateVisits}.`,
          `${path}/inputs/detail`,
          { nodeId: node.id, nodeType: node.type, ...cost, limit: PROCEDURAL_TEXTURE_LIMITS.maxVoronoiCandidateVisits },
        ));
      }
    }

    if (classification.kind === 'ramp' && blenderStyleRamp(descriptor)) {
      const interpolation = modeValue(params.interpolation, 'LINEAR');
      const colorMode = modeValue(params.colorMode, 'RGB');
      const hueInterpolation = modeValue(params.hueInterpolation, 'NEAR');
      validateMode({ diagnostics, path, node, property: 'interpolation', value: interpolation, advertised: BLENDER_RAMP_INTERPOLATIONS, supported: CPU_RAMP_INTERPOLATIONS });
      validateMode({ diagnostics, path, node, property: 'colorMode', value: colorMode, advertised: BLENDER_RAMP_COLOR_MODES, supported: CPU_RAMP_COLOR_MODES });
      if (!BLENDER_HUE_INTERPOLATIONS.has(hueInterpolation)) {
        invalidModeDiagnostic(diagnostics, path, node, 'hueInterpolation', hueInterpolation, BLENDER_HUE_INTERPOLATIONS);
      }
    }

    if (classification.kind === 'mix' && blenderStyleMix(descriptor)) {
      const blendMode = modeValue(params.blendMode ?? params.blendType ?? params.operation, 'MIX');
      const valueType = modeValue(params.valueType, 'COLOR');
      validateMode({ diagnostics, path, node, property: 'blendMode', value: blendMode, advertised: BLENDER_MIX_MODES, supported: CPU_MIX_MODES });
      if (!NUMERIC_VALUE_TYPES.has(valueType)) {
        invalidModeDiagnostic(diagnostics, path, node, 'valueType', valueType, NUMERIC_VALUE_TYPES);
      }
    }

    if (['separateColor', 'combineColor'].includes(classification.kind)) {
      const mode = modeValue(params.mode, 'RGB');
      if (!BLENDER_COLOR_MODES.has(mode)) {
        invalidModeDiagnostic(diagnostics, path, node, 'mode', mode, BLENDER_COLOR_MODES);
      }
    }
  }
}

function validateCommonGraph(graph, options, diagnostics, warnings) {
  if (graph.nodes.length > PROCEDURAL_TEXTURE_LIMITS.maxNodes) {
    diagnostics.push(diagnostic('procedural_node_limit_exceeded', `Graph exceeds ${PROCEDURAL_TEXTURE_LIMITS.maxNodes} nodes.`, '/nodes'));
  }
  if (graph.edges.length > PROCEDURAL_TEXTURE_LIMITS.maxEdges) {
    diagnostics.push(diagnostic('procedural_edge_limit_exceeded', `Graph exceeds ${PROCEDURAL_TEXTURE_LIMITS.maxEdges} edges.`, '/edges'));
  }
  const nodeById = new Map();
  const runtimeNodes = new Map();
  for (let index = 0; index < graph.nodes.length; index += 1) {
    const node = graph.nodes[index];
    const path = `/nodes/${index}`;
    if (!exactKeys(node, NODE_KEYS, path, diagnostics)) continue;
    if (!STABLE_ID.test(node.id ?? '')) diagnostics.push(diagnostic('procedural_invalid_node_id', 'Node id must be stable.', `${path}/id`));
    else if (nodeById.has(node.id)) diagnostics.push(diagnostic('procedural_duplicate_node_id', `Duplicate node id "${node.id}".`, `${path}/id`));
    nodeById.set(node.id, node);
    if (!isPlainRecord(node.params)) diagnostics.push(diagnostic('procedural_invalid_params', 'Node params must be an object.', `${path}/params`));
    if (node.inputs !== undefined && !isPlainRecord(node.inputs)) {
      diagnostics.push(diagnostic('procedural_invalid_inputs', 'Node input defaults must be an object.', `${path}/inputs`));
    }
    const classification = classifyNode(node);
    if (!classification) {
      diagnostics.push(diagnostic(
        'procedural_unsupported_node',
        `Node type "${String(node.type)}" has no bounded CPU implementation.`,
        `${path}/type`,
        { nodeId: node.id, nodeType: node.type },
      ));
      continue;
    }
    const nodeSpec = NODE_SPECS[classification.kind];
    if (isPlainRecord(node.params)) {
      exactKeys(node.params, new Set(nodeSpec.params), `${path}/params`, diagnostics, 'procedural_unknown_parameter');
    }
    const operation = classification.operation ?? (['arithmetic', 'unaryMath'].includes(classification.kind)
      ? normalizeOperation(node.params?.operation ?? 'add')
      : null);
    if (classification.kind === 'arithmetic' && !SUPPORTED_BINARY_OPERATIONS.has(operation)) {
      diagnostics.push(diagnostic('procedural_unsupported_math_operation', `Math operation "${operation}" is unsupported.`, `${path}/params/operation`, { nodeId: node.id }));
    }
    if (classification.kind === 'unaryMath' && !SUPPORTED_UNARY_OPERATIONS.has(operation)) {
      diagnostics.push(diagnostic('procedural_unsupported_math_operation', `Math operation "${operation}" is unsupported.`, `${path}/params/operation`, { nodeId: node.id }));
    }
    if (classification.kind === 'ramp') validateRamp(node, path, diagnostics);
    if (classification.kind === 'blur') {
      const radius = node.params?.radius ?? 2;
      if (!Number.isSafeInteger(radius) || radius < 1 || radius > PROCEDURAL_TEXTURE_LIMITS.maxBlurRadius) {
        diagnostics.push(diagnostic('procedural_invalid_blur_radius', `Blur radius must be 1 to ${PROCEDURAL_TEXTURE_LIMITS.maxBlurRadius}.`, `${path}/params/radius`));
      }
    }
    if (classification.kind === 'image') {
      const id = node.params?.assetId ?? node.params?.textureId;
      const source = getImageSource(imageSources(options), id);
      if (!validImageSource(source)) {
        diagnostics.push(diagnostic(
          'procedural_image_unresolved',
          `Image node ${node.id} requires a bounded CPU source for ${String(id)}.`,
          `${path}/params/${node.params?.assetId ? 'assetId' : 'textureId'}`,
          { nodeId: node.id, resourceId: id },
        ));
      }
    }
    runtimeNodes.set(node.id, Object.freeze({
      node,
      classification: Object.freeze({ ...classification, operation }),
      spec: nodeSpec,
      inputs: new Map(),
    }));
  }

  // Unsupported nodes already have their own actionable diagnostic. Keep them
  // out of the DAG walk so they do not also masquerade as a cycle.
  const outgoing = new Map([...runtimeNodes.keys()].map(id => [id, []]));
  const indegree = new Map([...runtimeNodes.keys()].map(id => [id, 0]));
  const inputOwners = new Set();
  for (let index = 0; index < graph.edges.length; index += 1) {
    const edge = graph.edges[index];
    const path = `/edges/${index}`;
    if (!exactKeys(edge, EDGE_KEYS, path, diagnostics)) continue;
    if (!isPlainRecord(edge.from) || !isPlainRecord(edge.to)) {
      diagnostics.push(diagnostic('procedural_invalid_edge', 'Edge endpoints must be objects.', path));
      continue;
    }
    exactKeys(edge.from, REF_KEYS, `${path}/from`, diagnostics);
    exactKeys(edge.to, REF_KEYS, `${path}/to`, diagnostics);
    const source = runtimeNodes.get(edge.from.nodeId);
    const target = runtimeNodes.get(edge.to.nodeId);
    if (!source) diagnostics.push(diagnostic('procedural_missing_node_reference', `Source node ${edge.from.nodeId} does not exist or is unsupported.`, `${path}/from/nodeId`));
    if (!target) diagnostics.push(diagnostic('procedural_missing_node_reference', `Target node ${edge.to.nodeId} does not exist or is unsupported.`, `${path}/to/nodeId`));
    if (!source || !target) continue;
    const sourcePort = portKey(edge.from.port);
    const targetPort = portKey(edge.to.port);
    if (!source.spec.outputs.includes(sourcePort)) {
      diagnostics.push(diagnostic('procedural_missing_output_port', `Output port "${edge.from.port}" is unsupported on ${source.node.type}.`, `${path}/from/port`, { nodeId: source.node.id }));
    }
    const inputKey = `${target.node.id}\u0000${targetPort}`;
    if (inputOwners.has(inputKey)) diagnostics.push(diagnostic('procedural_input_already_connected', `Input ${target.node.id}.${edge.to.port} is connected twice.`, `${path}/to`));
    inputOwners.add(inputKey);
    target.inputs.set(targetPort, Object.freeze({ nodeId: source.node.id, port: sourcePort }));
    outgoing.get(source.node.id)?.push(target.node.id);
    indegree.set(target.node.id, (indegree.get(target.node.id) ?? 0) + 1);
  }

  validateCpuCapabilities(graph, runtimeNodes, diagnostics);

  for (const descriptor of runtimeNodes.values()) {
    if (descriptor.classification.blenderDefaults) continue;
    for (const group of descriptor.spec.requiredInputs) {
      if (!group.some(name => descriptor.inputs.has(name))) {
        diagnostics.push(diagnostic(
          'procedural_missing_input',
          `Node ${descriptor.node.id} requires input ${group.join(' or ')}.`,
          `/nodes/${graph.nodes.indexOf(descriptor.node)}/params`,
          { nodeId: descriptor.node.id, ports: group },
        ));
      }
    }
  }

  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id).sort();
  let visited = 0;
  while (queue.length) {
    const id = queue.shift();
    visited += 1;
    for (const next of outgoing.get(id) ?? []) {
      const degree = indegree.get(next) - 1;
      indegree.set(next, degree);
      if (degree === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }
  if (visited !== runtimeNodes.size) diagnostics.push(diagnostic('procedural_graph_cycle', 'Procedural graphs must be acyclic.', '/edges'));

  const outputDescriptors = [];
  for (const [outputName, ref] of Object.entries(graph.outputs).sort(([a], [b]) => a.localeCompare(b))) {
    const path = `/outputs/${outputName}`;
    if (!isPlainRecord(ref)) {
      diagnostics.push(diagnostic('procedural_invalid_output', 'Output reference must be an object.', path));
      continue;
    }
    exactKeys(ref, OUTPUT_REF_KEYS, path, diagnostics);
    if (!GRAPH_OUTPUTS[graph.domain]?.[outputName]) {
      diagnostics.push(diagnostic('procedural_illegal_output', `Output ${outputName} is not legal for ${graph.domain} graphs.`, path));
      continue;
    }
    const source = runtimeNodes.get(ref.nodeId);
    if (!source) {
      diagnostics.push(diagnostic('procedural_missing_node_reference', `Output node ${ref.nodeId} does not exist or is unsupported.`, `${path}/nodeId`));
      continue;
    }
    const sourcePort = portKey(ref.port);
    if (!source.spec.outputs.includes(sourcePort)) diagnostics.push(diagnostic('procedural_missing_output_port', `Output port ${ref.port} is unsupported on ${source.node.type}.`, `${path}/port`));
    if (graph.domain === 'texture') {
      const expected = GRAPH_OUTPUTS.texture[outputName].colorSpace;
      if (ref.colorSpace !== expected) diagnostics.push(diagnostic('procedural_color_space_mismatch', `${outputName} must use ${expected} colour space.`, `${path}/colorSpace`));
    }
    const mapName = sourceMapName(graph.domain, outputName);
    if (mapName) outputDescriptors.push(Object.freeze({ outputName, mapName, ref: Object.freeze({ nodeId: ref.nodeId, port: sourcePort }) }));
    else warnings.push(warning('procedural_output_skipped', `CPU bake does not emit ${outputName}.`, path, { outputName }));
  }
  if (outputDescriptors.length === 0) diagnostics.push(diagnostic('procedural_no_bake_outputs', 'Graph has no albedo, roughness, normal, or height output.', '/outputs'));
  if (outputDescriptors.length > PROCEDURAL_TEXTURE_LIMITS.maxOutputs) diagnostics.push(diagnostic('procedural_output_limit_exceeded', `CPU bake supports at most ${PROCEDURAL_TEXTURE_LIMITS.maxOutputs} maps.`, '/outputs'));

  return { runtimeNodes, outputDescriptors };
}

function validateRamp(node, path, diagnostics) {
  const stops = node.params?.stops;
  if (!Array.isArray(stops) || stops.length < 2 || stops.length > 32) {
    diagnostics.push(diagnostic('procedural_invalid_ramp', 'Color Ramp requires 2 to 32 stops.', `${path}/params/stops`));
    return;
  }
  let prior = -Infinity;
  for (let index = 0; index < stops.length; index += 1) {
    const stop = stops[index];
    if (!isPlainRecord(stop) || Object.keys(stop).some(key => !['position', 'color'].includes(key))
      || !Number.isFinite(stop.position) || stop.position < prior || stop.position < 0 || stop.position > 1
      || !Array.isArray(stop.color) || ![3, 4].includes(stop.color.length)
      || stop.color.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
      diagnostics.push(diagnostic('procedural_invalid_ramp', 'Ramp stops require sorted positions and RGB/RGBA values in 0..1.', `${path}/params/stops/${index}`));
    }
    prior = Number(stop?.position);
  }
}

function estimatedSamples(runtimeNodes, resolution, outputs) {
  let factor = 0;
  for (const descriptor of runtimeNodes.values()) {
    if (descriptor.classification.kind === 'fbm') {
      if (blenderStyleNoise(descriptor)) {
        const detail = descriptor.inputs.has('detail')
          ? PROCEDURAL_TEXTURE_LIMITS.maxBlenderNoiseDetail
          : numericLiteralInput(descriptor.node, 'detail', 2);
        const boundedDetail = Number.isFinite(detail) ? detail : PROCEDURAL_TEXTURE_LIMITS.maxBlenderNoiseDetail;
        factor += Math.max(1, Math.min(PROCEDURAL_TEXTURE_LIMITS.maxBlenderNoiseDetail, Math.round(boundedDetail) || 1));
      } else factor += Math.max(1, Math.min(12, Math.trunc(descriptor.node.params.octaves ?? descriptor.node.params.detail ?? 4)));
    } else if (descriptor.classification.kind === 'voronoi') {
      // The current bounded 2D kernel examines a 5x5 lattice. Future N-D
      // modes use the exact catalogued neighborhood/pass/octave cost. Taking
      // the maximum keeps the estimate conservative during that transition.
      factor += Math.max(25, voronoiCost(descriptor).candidateVisits);
    }
    else if (descriptor.classification.kind === 'blur') {
      const radius = descriptor.node.params.radius ?? 2;
      factor += (radius * 2 + 1) ** 2;
    } else if (descriptor.classification.kind === 'normalFromHeight') factor += 4;
    else factor += 1;
  }
  return resolution[0] * resolution[1] * Math.max(1, outputs.length) * Math.max(1, factor);
}

/** Strict validation for the bounded CPU procedural subset. */
export function validateProceduralTextureGraph(rawGraph, options = {}) {
  const errors = [];
  const warnings = [];
  let graph;
  if (currentCatalogGraph(rawGraph)) {
    const validation = validateGraph(rawGraph);
    if (!validation.valid) errors.push(...validation.errors.map(item => {
      const code = item.code === 'graph_cycle' ? 'procedural_graph_cycle'
        : item.code === 'texture_resolution_exceeded' ? 'procedural_resolution_exceeded'
          : item.code;
      return Object.freeze({
        ...item,
        code,
        ...(code === item.code ? {} : { sourceCode: item.code }),
      });
    }));
    else {
      graph = validation.graph;
      warnings.push(...validation.warnings.map(item => Object.freeze({ ...item })));
    }
  } else graph = validateAliasEnvelope(rawGraph, errors);

  let resolution = [1, 1];
  let runtimeNodes = new Map();
  let outputDescriptors = [];
  if (graph) {
    resolution = validateResolution(graph, options, errors);
    ({ runtimeNodes, outputDescriptors } = validateCommonGraph(graph, options, errors, warnings));
    const estimate = estimatedSamples(runtimeNodes, resolution, outputDescriptors);
    if (estimate > PROCEDURAL_TEXTURE_LIMITS.maxEstimatedSamples) {
      errors.push(diagnostic(
        'procedural_sample_budget_exceeded',
        `Estimated work ${estimate} exceeds the ${PROCEDURAL_TEXTURE_LIMITS.maxEstimatedSamples} CPU sample budget.`,
        '/settings/resolution',
        { estimatedSamples: estimate },
      ));
    }
  }
  const result = {
    valid: errors.length === 0,
    graph: errors.length === 0 ? graph : null,
    resolution: Object.freeze([...resolution]),
    outputs: Object.freeze(outputDescriptors.map(output => output.mapName)),
    diagnostics: Object.freeze([...errors, ...warnings]),
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
  };
  Object.defineProperty(result, '_runtimeNodes', { value: runtimeNodes });
  Object.defineProperty(result, '_outputDescriptors', { value: outputDescriptors });
  return Object.freeze(result);
}

export class ProceduralTextureCompileError extends Error {
  constructor(diagnostics) {
    super(diagnostics[0]?.message ?? 'Procedural texture graph compilation failed.');
    this.name = 'ProceduralTextureCompileError';
    this.code = 'procedural_texture_compile_failed';
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

export class ProceduralTextureBakeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProceduralTextureBakeError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function number(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function scalar(value) {
  return Array.isArray(value) ? number(value[0]) : number(value);
}

function vector(value, length = 3, fallback = 0) {
  if (Array.isArray(value)) return Array.from({ length }, (_, index) => number(value[index], index === 3 ? 1 : fallback));
  const component = number(value, fallback);
  return Array(length).fill(component);
}

function mapUnary(value, operation) {
  const apply = component => {
    switch (operation) {
      case 'abs': return Math.abs(component);
      case 'saturate':
      case 'clamp': return clamp01(component);
      case 'sine': return Math.sin(component);
      case 'cosine': return Math.cos(component);
      case 'floor': return Math.floor(component);
      case 'ceil': return Math.ceil(component);
      case 'fract': return component - Math.floor(component);
      case 'sqrt': return Math.sqrt(Math.max(0, component));
      case 'negate': return -component;
      default: return component;
    }
  };
  return Array.isArray(value) ? value.map(apply) : apply(number(value));
}

function mapBinary(a, b, operation) {
  const length = Math.max(Array.isArray(a) ? a.length : 1, Array.isArray(b) ? b.length : 1);
  const left = vector(a, length);
  const right = vector(b, length);
  const apply = (x, y) => {
    let result;
    switch (operation) {
      case 'add': result = x + y; break;
      case 'subtract': result = x - y; break;
      case 'multiply': result = x * y; break;
      case 'divide': result = y === 0 ? 0 : x / y; break;
      case 'min': result = Math.min(x, y); break;
      case 'max': result = Math.max(x, y); break;
      case 'power': result = Math.pow(x, y); break;
      case 'modulo': result = y === 0 ? 0 : ((x % y) + y) % y; break;
      case 'greaterthan': result = x > y ? 1 : 0; break;
      case 'lessthan': result = x < y ? 1 : 0; break;
      default: result = 0;
    }
    return Number.isFinite(result) ? result : 0;
  };
  const output = left.map((value, index) => apply(value, right[index]));
  return length === 1 && !Array.isArray(a) && !Array.isArray(b) ? output[0] : output;
}

function mixValues(a, b, amount, mode = 'mix') {
  const factor = number(amount);
  const length = Math.max(Array.isArray(a) ? a.length : 1, Array.isArray(b) ? b.length : 1);
  const left = vector(a, length);
  const right = vector(b, length);
  const operation = portKey(mode);
  const output = left.map((value, index) => {
    const target = operation === 'multiply' ? value * right[index]
      : operation === 'add' ? value + right[index]
        : operation === 'subtract' ? value - right[index]
          : operation === 'screen' ? 1 - ((1 - value) * (1 - right[index]))
            : right[index];
    return value + ((target - value) * factor);
  });
  return length === 1 && !Array.isArray(a) && !Array.isArray(b) ? output[0] : output;
}

function rotateVector(value, rotation) {
  let [x, y, z] = vector(value, 3);
  const [rx, ry, rz] = vector(rotation, 3);
  let cosine = Math.cos(rx); let sine = Math.sin(rx);
  [y, z] = [(y * cosine) - (z * sine), (y * sine) + (z * cosine)];
  cosine = Math.cos(ry); sine = Math.sin(ry);
  [x, z] = [(x * cosine) + (z * sine), (-x * sine) + (z * cosine)];
  cosine = Math.cos(rz); sine = Math.sin(rz);
  [x, y] = [(x * cosine) - (y * sine), (x * sine) + (y * cosine)];
  return [x, y, z];
}

function normalizeVector(value) {
  const result = vector(value, 3);
  const length = Math.hypot(...result);
  return length > 1e-12 ? result.map(component => component / length) : [0, 0, 1];
}

function srgbToLinear(value) {
  const component = clamp01(value);
  return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value) {
  const component = clamp01(value);
  return component <= 0.0031308 ? component * 12.92 : (1.055 * (component ** (1 / 2.4))) - 0.055;
}

function wrapCoordinate(value, mode = 'repeat') {
  if (mode === 'clamp') return clamp01(value);
  const repeated = value - Math.floor(value);
  if (mode !== 'mirror') return repeated;
  const whole = Math.floor(value);
  return Math.abs(whole % 2) === 1 ? 1 - repeated : repeated;
}

function sampleImage(source, uv, settings, node) {
  const u = wrapCoordinate(number(uv[0]), settings.wrapS);
  const v = wrapCoordinate(number(uv[1]), settings.wrapT);
  const x = Math.min(source.width - 1, Math.max(0, Math.floor(u * source.width)));
  const y = Math.min(source.height - 1, Math.max(0, Math.floor(v * source.height)));
  const offset = (y * source.width + x) * source.channels;
  const scale = source.data instanceof Uint8Array || source.data instanceof Uint8ClampedArray ? 1 / 255 : 1;
  const values = Array.from({ length: source.channels }, (_, index) => number(source.data[offset + index]) * scale);
  const color = [values[0] ?? 0, values[1] ?? values[0] ?? 0, values[2] ?? values[0] ?? 0];
  if ((node.params.colorSpace ?? source.colorSpace) === 'srgb') {
    for (let index = 0; index < 3; index += 1) color[index] = srgbToLinear(color[index]);
  }
  return { color, alpha: values[3] ?? 1 };
}

function freezeSample(sample) {
  return Object.freeze(Object.fromEntries(Object.entries(sample).map(([key, value]) => [
    key,
    Array.isArray(value) ? Object.freeze([...value]) : value,
  ])));
}

function buildEvaluator(validation, options) {
  const graph = validation.graph;
  const descriptors = validation._runtimeNodes;
  const globalSeed = combineSeeds(graph.settings?.seed ?? 0, options.seed ?? 0);
  const settings = {
    wrapS: graph.settings?.wrapS ?? 'repeat',
    wrapT: graph.settings?.wrapT ?? 'repeat',
  };
  const parameters = options.parameters ?? {};
  const sources = imageSources(options);

  const evaluate = (nodeId, context, cache) => {
    if (cache.has(nodeId)) return cache.get(nodeId);
    const descriptor = descriptors.get(nodeId);
    if (!descriptor) throw new ProceduralTextureBakeError('procedural_node_missing', `Compiled node ${nodeId} is unavailable.`, { nodeId });
    const { node, classification } = descriptor;
    const params = node.params ?? {};
    const input = (names, fallback = 0, alternateContext = context) => {
      const candidates = Array.isArray(names) ? names : [names];
      const bindingName = candidates.find(name => descriptor.inputs.has(portKey(name)));
      if (!bindingName) {
        const defaultName = Object.keys(node.inputs ?? {}).find(name => candidates.some(candidate => portKey(candidate) === portKey(name)));
        return defaultName === undefined ? fallback : node.inputs[defaultName];
      }
      const binding = descriptor.inputs.get(portKey(bindingName));
      const inputCache = alternateContext === context ? cache : new Map();
      return evaluate(binding.nodeId, alternateContext, inputCache)[binding.port];
    };
    const nodeSeed = combineSeeds(globalSeed, params.seed ?? 0);
    let result;
    switch (classification.kind) {
      case 'coordinate': {
        const values = {
          uv: context.uv,
          generated: context.generated,
          object: context.object,
          position: context.object,
          normal: context.normal,
          vector: classification.variant === 'uv' ? context.uv
            : classification.variant === 'generated' ? context.generated : context.object,
        };
        result = classification.variant === 'multi' ? values
          : classification.variant === 'uv' ? { uv: context.uv, vector: context.uv }
            : classification.variant === 'generated' ? { generated: context.generated, vector: context.generated }
              : { object: context.object, position: context.object, vector: context.object };
        break;
      }
      case 'normalInput': result = { normal: context.normal }; break;
      case 'viewInput': result = { direction: context.viewDirection, viewdirection: context.viewDirection, vector: context.viewDirection }; break;
      case 'timeInput': result = { seconds: context.time, value: context.time }; break;
      case 'constant': {
        const named = params.name && Object.hasOwn(parameters, params.name) ? parameters[params.name] : params.value;
        const valueType = classification.variant ?? params.valueType ?? 'float';
        const fallback = ['vec2', 'vec3', 'color'].includes(valueType)
          ? Array(valueType === 'vec2' ? 2 : 3).fill(valueType === 'color' ? 1 : 0)
          : 0;
        const value = named ?? fallback;
        result = { value, fac: scalar(value), color: vector(value, 3), vector: Array.isArray(value) ? value : [value, value, value] };
        break;
      }
      case 'reroute': {
        const valueType = String(params.valueType ?? 'float').toLowerCase();
        if (!['integer', 'float', 'vec2', 'vec3', 'vec4', 'color'].includes(valueType)) {
          throw new ProceduralTextureBakeError('procedural_reroute_type_unsupported', `Reroute value type ${params.valueType} is not numeric.`, { nodeId: node.id, valueType: params.valueType });
        }
        const value = input(['input', 'value'], 0);
        result = { output: value, value };
        break;
      }
      case 'separate': {
        const value = vector(input(['vector', 'value'], [0, 0, 0]), 3);
        result = { x: value[0], y: value[1], z: value[2] };
        break;
      }
      case 'combine': result = {
        value: [scalar(input('x')), scalar(input('y')), scalar(input('z'))],
        vector: [scalar(input('x')), scalar(input('y')), scalar(input('z'))],
      }; break;
      case 'separateColor': {
        result = separateBlenderColor(input('color', [0.8, 0.8, 0.8, 1]), params.mode ?? 'RGB');
        break;
      }
      case 'combineColor': {
        result = { color: combineBlenderColor(
          scalar(input('red', 0)),
          scalar(input('green', 0)),
          scalar(input('blue', 0)),
          scalar(input('alpha', 1)),
          params.mode ?? 'RGB',
        ) };
        break;
      }
      case 'mapping': {
        const source = vector(input(['vector', 'coordinate'], [0, 0, 0]), 3);
        const scale = vector(input('scale', params.scale ?? [1, 1, 1]), 3, 1);
        const location = vector(input('location', params.location ?? params.translation ?? [0, 0, 0]), 3);
        const scaled = source.map((component, index) => component * scale[index]);
        const rotated = rotateVector(scaled, input('rotation', params.rotation ?? [0, 0, 0]));
        const mapped = String(params.vectorType ?? 'point').toLowerCase() === 'vector'
          ? rotated
          : rotated.map((component, index) => component + location[index]);
        result = { vector: mapped, value: mapped };
        break;
      }
      case 'valueNoise': {
        const coordinate = vector(input(['coordinate', 'vector']), 2);
        const scale = scalar(input('scale', params.scale ?? 1));
        const value = valueNoise2D(coordinate[0] * scale, coordinate[1] * scale, nodeSeed);
        result = { value, fac: value, factor: value, color: [value, value, value] };
        break;
      }
      case 'fbm': {
        const coordinate = vector(input(['coordinate', 'vector']), 2);
        const isBlenderNoise = blenderStyleNoise(descriptor);
        const scale = scalar(input('scale', params.scale ?? (isBlenderNoise ? 5 : 1)));
        const detail = scalar(input('detail', params.octaves ?? params.detail ?? (isBlenderNoise ? 2 : 4)));
        const value = fbm2D(coordinate[0] * scale, coordinate[1] * scale, {
          seed: nodeSeed,
          octaves: isBlenderNoise
            ? Math.max(1, Math.min(PROCEDURAL_TEXTURE_LIMITS.maxBlenderNoiseDetail, Math.round(detail)))
            : detail,
          lacunarity: scalar(input('lacunarity', params.lacunarity ?? 2)),
          gain: scalar(input('roughness', input('gain', params.gain ?? params.roughness ?? 0.5))),
          distortion: scalar(input('distortion', params.distortion ?? 0)),
        });
        result = { value, fac: value, factor: value, color: [value, value, value] };
        break;
      }
      case 'voronoi': {
        const coordinate = vector(input(['coordinate', 'vector']), 2);
        const scale = scalar(input('scale', params.scale ?? (blenderStyleVoronoi(descriptor) ? 5 : 1)));
        const values = voronoi2D(coordinate[0] * scale, coordinate[1] * scale, {
          seed: nodeSeed,
          randomness: scalar(input('randomness', params.randomness ?? 1)),
          metric: portKey(params.distanceMetric ?? params.metric ?? 'euclidean') === 'minkowski'
            ? 'euclidean' : portKey(params.distanceMetric ?? params.metric ?? 'euclidean'),
        });
        const feature = portKey(params.feature ?? 'f1');
        const distance = feature === 'f2' || feature === 'distancetosecond' ? values.f2
          : feature === 'distancetoedge' || feature === 'edge' ? values.edge : values.f1;
        result = { distance, f1: values.f1, f2: values.f2, edge: values.edge, cell: values.cell, color: [values.cell, values.cell, values.cell] };
        break;
      }
      case 'wave': {
        const coordinate = vector(input(['coordinate', 'vector']), 2);
        const value = wave2D(coordinate[0], coordinate[1], {
          seed: nodeSeed,
          scale: scalar(input('scale', params.scale ?? 5)),
          distortion: scalar(input('distortion', params.distortion ?? 0)),
          detail: scalar(input('detail', params.detail ?? 2)),
          detailScale: scalar(input('detailScale', params.detailScale ?? 1)),
          detailRoughness: scalar(input('detailRoughness', params.detailRoughness ?? 0.5)),
          phase: scalar(input('phaseOffset', params.phase ?? params.phaseOffset ?? 0)),
          direction: params.direction ?? (portKey(params.waveType) === 'rings' ? params.ringsDirection : params.bandsDirection) ?? 'x',
          waveType: params.waveType ?? 'bands',
          profile: params.profile ?? 'sine',
        });
        result = { value, fac: value, factor: value, color: [value, value, value] };
        break;
      }
      case 'ramp': {
        const color = blenderStyleRamp(descriptor)
          ? sampleBlenderColorRamp(
            params.stops,
            scalar(input(['value', 'fac', 'factor'], 0.5)),
            params.interpolation,
            params.colorMode,
            params.hueInterpolation,
          )
          : sampleColorRamp(params.stops, scalar(input(['value', 'fac', 'factor'], 0.5)), params.interpolation);
        result = { color: color.slice(0, 3), alpha: color[3] };
        break;
      }
      case 'arithmetic': {
        let value = mapBinary(input(['a', 'value'], 0.5), input(['b', 'valueB'], 0.5), classification.operation);
        if (params.clamp) value = mapUnary(value, 'clamp');
        result = { value };
        break;
      }
      case 'unaryMath': {
        let value = mapUnary(input(['value', 'a']), classification.operation);
        if (params.clamp) value = mapUnary(value, 'clamp');
        result = { value };
        break;
      }
      case 'mix': {
        const factor = params.clampFactor === false ? scalar(input(['factor', 'fac'], 0.5)) : clamp01(scalar(input(['factor', 'fac'], 0.5)));
        const left = input(['a', 'color1'], 0.5);
        const right = input(['b', 'color2'], 0.5);
        let value = blenderStyleMix(descriptor)
          ? mixBlenderValues(
            left,
            right,
            factor,
            params.blendMode ?? params.blendType ?? params.operation ?? 'MIX',
            params.valueType ?? 'color',
          )
          : mixValues(left, right, factor, params.blendMode ?? params.blendType ?? params.operation ?? 'mix');
        if (params.clamp || params.clampResult) value = mapUnary(value, 'clamp');
        result = { value, result: value, color: vector(value, 3) };
        break;
      }
      case 'remap': {
        const value = scalar(input('value'));
        const inMin = scalar(input('fromMin', params.inMin ?? params.fromMin ?? 0));
        const inMax = scalar(input('fromMax', params.inMax ?? params.fromMax ?? 1));
        const outMin = scalar(input('toMin', params.outMin ?? params.toMin ?? 0));
        const outMax = scalar(input('toMax', params.outMax ?? params.toMax ?? 1));
        let amount = inMax === inMin ? 0 : (value - inMin) / (inMax - inMin);
        const interpolation = portKey(params.interpolationType ?? params.interpolation ?? 'linear');
        if (interpolation === 'smoothstep') amount = clamp01(amount) ** 2 * (3 - (2 * clamp01(amount)));
        else if (interpolation === 'smootherstep') {
          const t = clamp01(amount);
          amount = t ** 3 * (t * ((t * 6) - 15) + 10);
        } else if (interpolation === 'stepped') {
          const steps = Math.max(1, Math.trunc(scalar(input('steps', params.steps ?? 4))));
          amount = Math.floor(amount * steps) / steps;
        }
        let mapped = outMin + ((outMax - outMin) * amount);
        if (params.clamp ?? true) mapped = Math.min(Math.max(mapped, Math.min(outMin, outMax)), Math.max(outMin, outMax));
        result = { value: mapped, result: mapped };
        break;
      }
      case 'gradient': {
        if (classification.variant === 'blender') {
          const coordinate = vector(input(['coordinate', 'vector'], [0, 0, 0]), 3);
          const mode = String(params.gradientType ?? 'LINEAR').toUpperCase();
          let value;
          if (mode === 'LINEAR') value = coordinate[0];
          else if (mode === 'QUADRATIC') value = Math.max(coordinate[0], 0) ** 2;
          else if (mode === 'EASING') {
            const bounded = clamp01(coordinate[0]);
            value = (3 * bounded * bounded) - (2 * bounded * bounded * bounded);
          } else if (mode === 'DIAGONAL') value = (coordinate[0] + coordinate[1]) * 0.5;
          else if (mode === 'RADIAL') value = (Math.atan2(coordinate[1], coordinate[0]) / (Math.PI * 2)) + 0.5;
          else {
            const sphere = Math.max(0.999999 - Math.hypot(...coordinate), 0);
            value = mode === 'QUADRATIC_SPHERE' ? sphere * sphere : sphere;
          }
          value = clamp01(value);
          result = { value, fac: value, factor: value, color: [value, value, value] };
        } else {
          const coordinate = scalar(input(['coordinate', 'value', 'fac']));
          const start = number(params.start, 0);
          const end = number(params.end, 1);
          const value = end === start ? 0 : clamp01((coordinate - start) / (end - start));
          result = { value, fac: value, factor: value, color: [value, value, value] };
        }
        break;
      }
      case 'checker': {
        if (classification.variant === 'blender') {
          const coordinate = vector(input(['coordinate', 'vector'], [0, 0, 0]), 3);
          const scale = scalar(input('scale', 5));
          const parity = coordinate
            .map(component => Math.abs(Math.floor(((component * scale) + 0.000001) * 0.999999)))
            .reduce((sum, component) => sum + component, 0) % 2;
          const color1 = input(['a', 'color1'], [0.8, 0.8, 0.8, 1]);
          const color2 = input(['b', 'color2'], [0.2, 0.2, 0.2, 1]);
          const color = vector(parity === 1 ? color1 : color2, 4);
          result = { color, value: color, factor: parity };
        } else {
          const coordinate = vector(input(['coordinate', 'vector']), 2);
          const scale = number(params.scale, 8);
          const chooseB = (Math.floor(coordinate[0] * scale) + Math.floor(coordinate[1] * scale)) % 2 !== 0;
          const value = chooseB ? input(['b', 'color2']) : input(['a', 'color1']);
          result = { color: vector(value, 3), value, factor: chooseB ? 1 : 0 };
        }
        break;
      }
      case 'whiteNoise': {
        const dimensions = String(params.dimensions ?? '3D').toUpperCase();
        const coordinate = vector(input('vector', [0, 0, 0]), 3);
        const w = scalar(input('w', 0));
        const seedCoordinate = dimensions === '1D' ? [w]
          : dimensions === '2D' ? coordinate.slice(0, 2)
            : dimensions === '4D' ? [...coordinate, w] : coordinate;
        const value = hashFloatUnit(seedCoordinate, nodeSeed);
        const color = [
          value,
          hashFloatUnit(seedCoordinate, combineSeeds(nodeSeed, 0x68bc21eb)),
          hashFloatUnit(seedCoordinate, combineSeeds(nodeSeed, 0x02e5be93)),
        ];
        result = { value, color };
        break;
      }
      case 'magic': {
        const coordinate = vector(input('vector', [0, 0, 0]), 3);
        const scale = scalar(input('scale', 5));
        const distortion = scalar(input('distortion', 1));
        const point = coordinate.map(component => {
          const value = component * scale;
          return ((value % (Math.PI * 2)) + (Math.PI * 2)) % (Math.PI * 2);
        });
        let x = Math.sin((point[0] + point[1] + point[2]) * 5);
        let y = Math.cos((-point[0] + point[1] - point[2]) * 5);
        let z = -Math.cos((-point[0] - point[1] + point[2]) * 5);
        const depth = Math.max(0, Math.min(10, Math.trunc(params.depth ?? 2)));
        if (depth > 0) {
          x *= distortion; y *= distortion; z *= distortion;
          y = -Math.cos(x - y + z) * distortion;
        }
        if (depth > 1) x = Math.cos(x - y - z) * distortion;
        if (depth > 2) z = Math.sin(-x - y - z) * distortion;
        if (depth > 3) x = -Math.cos(-x + y - z) * distortion;
        if (depth > 4) y = -Math.sin(-x + y + z) * distortion;
        if (depth > 5) y = -Math.cos(-x + y + z) * distortion;
        if (depth > 6) x = Math.cos(x + y + z) * distortion;
        if (depth > 7) z = Math.sin(x + y - z) * distortion;
        if (depth > 8) x = -Math.cos(-x - y + z) * distortion;
        if (depth > 9) y = -Math.sin(x - y + z) * distortion;
        if (distortion !== 0) {
          x /= distortion * 2; y /= distortion * 2; z /= distortion * 2;
        }
        const color = [0.5 - x, 0.5 - y, 0.5 - z];
        const factor = color.reduce((sum, component) => sum + component, 0) / 3;
        result = { color, factor, value: factor };
        break;
      }
      case 'brick': {
        const coordinate = vector(input('vector', [0, 0, 0]), 3);
        const scale = scalar(input('scale', 5));
        const mortarSize = Math.max(0, scalar(input('mortarSize', 0.02)));
        const mortarSmooth = Math.max(0, scalar(input('mortarSmooth', 0.1)));
        const bias = scalar(input('bias', 0));
        let brickWidth = Math.max(1e-7, scalar(input('brickWidth', 0.5)));
        const rowHeight = Math.max(1e-7, scalar(input('rowHeight', 0.25)));
        const offsetFrequency = Math.max(1, Math.trunc(params.offsetFrequency ?? 2));
        const squashFrequency = Math.max(1, Math.trunc(params.squashFrequency ?? 2));
        const row = Math.floor((coordinate[1] * scale) / rowHeight);
        if (row % squashFrequency === 0) brickWidth *= number(params.squash, 1);
        const offset = row % offsetFrequency === 0 ? brickWidth * number(params.offset, 0.5) : 0;
        const brick = Math.floor(((coordinate[0] * scale) + offset) / Math.max(brickWidth, 1e-7));
        const x = ((coordinate[0] * scale) + offset) - (brickWidth * brick);
        const y = (coordinate[1] * scale) - (rowHeight * row);
        const tint = clamp01(hashFloatUnit([row, brick], nodeSeed) + bias);
        const minimumDistance = Math.min(x, y, brickWidth - x, rowHeight - y);
        let factor = 0;
        if (minimumDistance < mortarSize) {
          if (mortarSmooth === 0 || mortarSize === 0) factor = 1;
          else {
            const amount = clamp01((1 - (minimumDistance / mortarSize)) / mortarSmooth);
            factor = amount * amount * (3 - (2 * amount));
          }
        }
        const color1 = vector(input('color1', [0.8, 0.8, 0.8, 1]), 4);
        const color2 = vector(input('color2', [0.2, 0.2, 0.2, 1]), 4);
        const mortar = vector(input('mortar', [0, 0, 0, 1]), 4);
        const brickColor = color1.map((component, index) => component + ((color2[index] - component) * tint));
        const color = brickColor.map((component, index) => component + ((mortar[index] - component) * factor));
        result = { color, factor, value: factor };
        break;
      }
      case 'warp': {
        const coordinate = vector(input(['coordinate', 'vector']), 2);
        const offset = vector(input('offset'), 2);
        const strength = number(params.strength, 1);
        const value = coordinate.map((component, index) => component + (offset[index] * strength));
        result = { coordinate: value, vector: value };
        break;
      }
      case 'blur': {
        const radius = Math.max(1, Math.min(PROCEDURAL_TEXTURE_LIMITS.maxBlurRadius, Math.trunc(params.radius ?? 2)));
        let sum = null;
        let count = 0;
        for (let y = -radius; y <= radius; y += 1) {
          for (let x = -radius; x <= radius; x += 1) {
            const value = input(['value', 'color', 'fac'], 0, context.offset(x * context.du, y * context.dv));
            const values = Array.isArray(value) ? value : [value];
            sum ??= Array(values.length).fill(0);
            for (let index = 0; index < sum.length; index += 1) sum[index] += number(values[index]);
            count += 1;
          }
        }
        const averaged = sum.map(component => component / count);
        const value = averaged.length === 1 ? averaged[0] : averaged;
        result = { value, color: vector(value, 3) };
        break;
      }
      case 'normalFromHeight': {
        const left = scalar(input(['height', 'value'], 0, context.offset(-context.du, 0)));
        const right = scalar(input(['height', 'value'], 0, context.offset(context.du, 0)));
        const down = scalar(input(['height', 'value'], 0, context.offset(0, -context.dv)));
        const up = scalar(input(['height', 'value'], 0, context.offset(0, context.dv)));
        const strength = scalar(input('strength', params.strength ?? 1))
          * scalar(input('distance', params.distance ?? 1)) * (params.invert ? -1 : 1);
        const dx = (right - left) / Math.max(1e-9, context.du * 2);
        const dy = (up - down) / Math.max(1e-9, context.dv * 2);
        const base = normalizeVector(input('normal', context.normal));
        result = { normal: normalizeVector([
          base[0] - (dx * strength),
          base[1] - (dy * strength),
          base[2],
        ]) };
        break;
      }
      case 'channelPack': {
        const defaults = vector(params.defaults ?? [0, 0, 0, 1], 4);
        const value = ['r', 'g', 'b', 'a'].map((name, index) => scalar(input(name, defaults[index])));
        result = { value, color: value };
        break;
      }
      case 'image': {
        const source = getImageSource(sources, params.assetId ?? params.textureId);
        result = sampleImage(source, vector(input(['uv', 'vector']), 2), settings, node);
        break;
      }
      case 'dot': {
        const a = vector(input('a'), 3);
        const b = vector(input('b'), 3);
        result = { value: a.reduce((sum, component, index) => sum + (component * b[index]), 0) };
        break;
      }
      case 'normalize': {
        const value = normalizeVector(input(['value', 'vector']));
        result = { value, vector: value };
        break;
      }
      case 'fresnel': {
        const normal = normalizeVector(input('normal'));
        const view = normalizeVector(input(['viewdirection', 'view']));
        const facing = clamp01(normal.reduce((sum, component, index) => sum + (component * view[index]), 0));
        const value = (1 - facing) ** number(params.power, 5);
        result = { value, fac: value };
        break;
      }
      default: throw new ProceduralTextureBakeError('procedural_node_unreachable', `No evaluator for ${classification.kind}.`);
    }
    const frozen = freezeSample(result);
    cache.set(nodeId, frozen);
    return frozen;
  };

  const makeContext = (u, v, sampleOptions = {}) => {
    const resolution = sampleOptions.resolution ?? validation.resolution;
    const objectScale = vector(options.objectScale ?? [1, 1, 1], 3, 1);
    const objectOffset = vector(options.objectOffset ?? [0, 0, 0], 3);
    const context = {
      uv: sampleOptions.uv ?? [u, v],
      generated: sampleOptions.generated ?? [u, v, number(options.generatedZ, 0)],
      object: sampleOptions.object ?? [
        (u * objectScale[0]) + objectOffset[0],
        (v * objectScale[1]) + objectOffset[1],
        objectOffset[2],
      ],
      normal: sampleOptions.normal ?? [0, 0, 1],
      viewDirection: sampleOptions.viewDirection ?? [0, 0, 1],
      time: number(options.time, 0),
      du: 1 / resolution[0],
      dv: 1 / resolution[1],
    };
    context.offset = (offsetU, offsetV) => makeContext(u + offsetU, v + offsetV, { resolution });
    return context;
  };

  const sampleRaw = (u, v, sampleOptions = {}) => {
    const context = makeContext(u, v, sampleOptions);
    const cache = new Map();
    const output = {};
    for (const descriptor of validation._outputDescriptors) {
      output[descriptor.mapName] = evaluate(descriptor.ref.nodeId, context, cache)[descriptor.ref.port];
    }
    return output;
  };

  return { globalSeed, sampleRaw };
}

function writeAlbedo(data, offset, value) {
  const color = vector(value, 4);
  data[offset] = Math.round(clamp01(linearToSrgb(color[0])) * 255);
  data[offset + 1] = Math.round(clamp01(linearToSrgb(color[1])) * 255);
  data[offset + 2] = Math.round(clamp01(linearToSrgb(color[2])) * 255);
  data[offset + 3] = Math.round(clamp01(color[3] ?? 1) * 255);
}

function writeNormal(data, offset, value) {
  const normal = normalizeVector(value);
  data[offset] = Math.round(clamp01((normal[0] * 0.5) + 0.5) * 255);
  data[offset + 1] = Math.round(clamp01((normal[1] * 0.5) + 0.5) * 255);
  data[offset + 2] = Math.round(clamp01((normal[2] * 0.5) + 0.5) * 255);
  data[offset + 3] = 255;
}

function allocateMaps(outputNames, width, height) {
  return Object.fromEntries(outputNames.map(name => {
    const format = PROCEDURAL_TEXTURE_MAPS[name];
    const data = name === 'height'
      ? new Float32Array(width * height)
      : new Uint8Array(width * height * format.channels);
    return [name, {
      name,
      width,
      height,
      channels: format.channels,
      format: format.format,
      colorSpace: format.colorSpace,
      origin: 'top-left',
      data,
      min: Infinity,
      max: -Infinity,
    }];
  }));
}

function finishMaps(maps) {
  return Object.freeze(Object.fromEntries(Object.entries(maps).map(([name, map]) => {
    const minimum = Number.isFinite(map.min) ? map.min : 0;
    const maximum = Number.isFinite(map.max) ? map.max : 1;
    return [name, Object.freeze({
      name: map.name,
      width: map.width,
      height: map.height,
      channels: map.channels,
      format: map.format,
      colorSpace: map.colorSpace,
      origin: map.origin,
      range: Object.freeze([minimum, maximum]),
      data: map.data,
    })];
  })));
}

function assertBakeResolution(resolution, maxResolution) {
  if (!Array.isArray(resolution) || resolution.length !== 2
    || resolution.some(value => !Number.isSafeInteger(value) || value < 1 || value > maxResolution)
    || resolution[0] * resolution[1] > PROCEDURAL_TEXTURE_LIMITS.maxPixels) {
    throw new ProceduralTextureBakeError(
      'procedural_invalid_bake_resolution',
      `Bake resolution exceeds ${maxResolution} per axis or ${PROCEDURAL_TEXTURE_LIMITS.maxPixels} pixels.`,
      { resolution },
    );
  }
}

/**
 * Compiles a canonical texture/shader DAG to a pure CPU sampler. Compilation
 * allocates no pixel buffers; bake() is the only generation boundary.
 */
export function compileProceduralTextureGraph(graph, options = {}) {
  const validation = validateProceduralTextureGraph(graph, options);
  if (!validation.valid) throw new ProceduralTextureCompileError(validation.errors);
  const evaluator = buildEvaluator(validation, options);
  const maxResolution = Math.max(1, Math.min(
    PROCEDURAL_TEXTURE_LIMITS.maxResolution,
    Number.isSafeInteger(options.maxResolution) ? options.maxResolution : PROCEDURAL_TEXTURE_LIMITS.maxResolution,
  ));
  const outputNames = Object.freeze([...new Set(validation.outputs)]);

  return Object.freeze({
    kind: 'CompiledProceduralTextureGraph',
    graphId: validation.graph.id,
    domain: validation.graph.domain,
    resolution: validation.resolution,
    seed: evaluator.globalSeed,
    outputNames,
    diagnostics: validation.diagnostics,
    execution: 'explicit-cpu-bake',
    sample(uv, sampleOptions = {}) {
      if (!Array.isArray(uv) || uv.length !== 2 || uv.some(value => !Number.isFinite(value))) {
        throw new ProceduralTextureBakeError('procedural_invalid_uv', 'sample uv must contain two finite numbers.', { uv });
      }
      return freezeSample(evaluator.sampleRaw(uv[0], uv[1], sampleOptions));
    },
    bake(bakeOptions = {}) {
      const resolution = bakeOptions.resolution ?? validation.resolution;
      assertBakeResolution(resolution, maxResolution);
      const requested = bakeOptions.outputs ?? outputNames;
      if (!Array.isArray(requested) || requested.length === 0 || requested.some(name => !outputNames.includes(name))) {
        throw new ProceduralTextureBakeError('procedural_invalid_outputs', 'Bake outputs must be a non-empty subset of compiled outputNames.', { outputs: requested });
      }
      const selected = [...new Set(requested)];
      const [width, height] = resolution;
      const maps = allocateMaps(selected, width, height);
      for (let y = 0; y < height; y += 1) {
        if (bakeOptions.signal?.aborted) throw new ProceduralTextureBakeError('procedural_bake_aborted', 'CPU texture bake was aborted.');
        const v = (y + 0.5) / height;
        for (let x = 0; x < width; x += 1) {
          const u = (x + 0.5) / width;
          const sample = evaluator.sampleRaw(u, v, { resolution });
          const pixel = (y * width) + x;
          for (const name of selected) {
            const map = maps[name];
            if (name === 'albedo') writeAlbedo(map.data, pixel * 4, sample[name]);
            else if (name === 'normal') writeNormal(map.data, pixel * 4, sample[name]);
            else if (name === 'roughness') map.data[pixel] = Math.round(clamp01(scalar(sample[name])) * 255);
            else if (name === 'height') map.data[pixel] = scalar(sample[name]);
            const observed = name === 'height' ? map.data[pixel]
              : name === 'roughness' ? map.data[pixel] / 255 : scalar(sample[name]);
            map.min = Math.min(map.min, observed);
            map.max = Math.max(map.max, observed);
          }
        }
        bakeOptions.onProgress?.(Object.freeze({ completedRows: y + 1, totalRows: height }));
      }
      return Object.freeze({
        kind: 'ProceduralTextureBake',
        graphId: validation.graph.id,
        width,
        height,
        seed: evaluator.globalSeed,
        maps: finishMaps(maps),
        generatedAtRuntime: false,
      });
    },
  });
}

export function bakeProceduralTextureGraph(graph, options = {}) {
  const { bake = {}, ...compileOptions } = options;
  return compileProceduralTextureGraph(graph, compileOptions).bake(bake);
}
