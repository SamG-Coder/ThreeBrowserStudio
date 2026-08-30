import { GRAPH_CATALOGS, GRAPH_OUTPUTS, NUMERIC_TYPES, VALUE_TYPES } from './catalogs.mjs';

export const GRAPH_LIMITS = Object.freeze({
  maxNodes: 256,
  maxEdges: 1024,
  maxDepth: 64,
  maxControlBytes: 1024 * 1024,
  maxShaderCost: 512,
  maxTextureCost: 1024,
  maxBlueprintCost: 4096,
  maxShaderSamplers: 16,
  maxCurveMappings: 12,
  maxGeneratedEntities: 20000,
  maxInteractiveResolution: 2048,
  maxBakeResolution: 4096,
  maxInteractiveTextureBytes: 64 * 1024 * 1024,
  maxBakeTextureBytes: 256 * 1024 * 1024,
});

const GRAPH_KEYS = new Set(['formatVersion', 'id', 'domain', 'nodes', 'edges', 'outputs', 'settings']);
const NODE_KEYS = new Set(['id', 'type', 'params', 'inputs', 'layout']);
const NODE_LAYOUT_KEYS = new Set(['position', 'dimensions', 'width', 'label', 'parentFrameId', 'collapsed', 'color']);
const EDGE_KEYS = new Set(['from', 'to']);
const REF_KEYS = new Set(['nodeId', 'port']);
const TEXTURE_OUTPUT_REF_KEYS = new Set(['nodeId', 'port', 'colorSpace']);
const TEXTURE_SETTING_KEYS = new Set(['seed', 'resolution', 'wrapS', 'wrapT', 'minFilter', 'magFilter', 'mode']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const STABLE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const NUMERIC_PORT_TYPES = new Set(['integer', 'float', 'vec2', 'vec3', 'vec4', 'color']);
const CURVE_MAPPING_NODE_TYPES = new Set([
  'blender.floatCurve', 'blender.rgbCurve', 'blender.vectorCurve',
]);
const NODE_LAYOUT_LIMITS = Object.freeze({
  coordinate: 1_000_000,
  dimension: 8192,
  labelLength: 256,
});

export class GraphValidationError extends Error {
  constructor(diagnostics) {
    super(diagnostics[0]?.message ?? 'Graph validation failed');
    this.name = 'GraphValidationError';
    this.code = 'graph_invalid';
    this.diagnostics = diagnostics;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeNumber(value) {
  return Object.is(value, -0) ? 0 : value;
}

function cloneCanonical(value) {
  if (typeof value === 'number') return normalizeNumber(value);
  if (Array.isArray(value)) return value.map(cloneCanonical);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, cloneCanonical(value[key])]));
}

function diagnostic(code, message, path, details = {}) {
  return { severity: 'error', code, message, path, ...details };
}

function warning(code, message, path, details = {}) {
  return { severity: 'warning', code, message, path, ...details };
}

function checkExactKeys(value, allowed, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(diagnostic('invalid_type', 'Expected an object.', path));
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(diagnostic('unknown_property', `Unknown property "${key}".`, `${path}/${key}`));
  }
  return true;
}

function checkFiniteJson(value, path, errors, seen = new Set(), depth = 0) {
  if (depth > 32) {
    errors.push(diagnostic('value_depth_exceeded', 'JSON value depth exceeds 32.', path));
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) errors.push(diagnostic('non_finite_number', 'Numbers must be finite.', path));
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 4096) errors.push(diagnostic('string_too_long', 'String exceeds 4096 characters.', path));
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value !== 'object') {
    errors.push(diagnostic('invalid_json_value', 'Values must be JSON data.', path));
    return;
  }
  if (seen.has(value)) {
    errors.push(diagnostic('cyclic_value', 'Values must not contain object cycles.', path));
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 4096) errors.push(diagnostic('array_too_large', 'Array exceeds 4096 items.', path));
    value.forEach((entry, index) => checkFiniteJson(entry, `${path}/${index}`, errors, seen, depth + 1));
  } else if (!isPlainObject(value)) {
    errors.push(diagnostic('invalid_object', 'Only plain JSON objects are accepted.', path));
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) errors.push(diagnostic('forbidden_property', `Property "${key}" is forbidden.`, `${path}/${key}`));
      checkFiniteJson(entry, `${path}/${key}`, errors, seen, depth + 1);
    }
  }
  seen.delete(value);
}

function isNumberArray(value, length, min = -Infinity, max = Infinity) {
  return Array.isArray(value) && value.length === length && value.every((entry) => Number.isFinite(entry) && entry >= min && entry <= max);
}

function normalizeNodeLayout(rawLayout, path, errors) {
  if (rawLayout === undefined) return null;
  if (!checkExactKeys(rawLayout, NODE_LAYOUT_KEYS, path, errors)) return null;

  const suppliedPosition = rawLayout.position;
  const positionValid = suppliedPosition === undefined
    || isNumberArray(suppliedPosition, 2, -NODE_LAYOUT_LIMITS.coordinate, NODE_LAYOUT_LIMITS.coordinate);
  if (!positionValid) {
    errors.push(diagnostic('invalid_node_layout', `position must contain two finite coordinates from -${NODE_LAYOUT_LIMITS.coordinate} to ${NODE_LAYOUT_LIMITS.coordinate}.`, `${path}/position`));
  }

  const suppliedDimensions = rawLayout.dimensions;
  const dimensionsValid = suppliedDimensions === undefined
    || isNumberArray(suppliedDimensions, 2, 0, NODE_LAYOUT_LIMITS.dimension);
  if (!dimensionsValid) {
    errors.push(diagnostic('invalid_node_layout', `dimensions must contain two finite values from 0 to ${NODE_LAYOUT_LIMITS.dimension}.`, `${path}/dimensions`));
  }

  const suppliedWidth = rawLayout.width;
  const widthValid = suppliedWidth === undefined
    || (Number.isFinite(suppliedWidth) && suppliedWidth >= 0 && suppliedWidth <= NODE_LAYOUT_LIMITS.dimension);
  if (!widthValid) {
    errors.push(diagnostic('invalid_node_layout', `width must be finite and range from 0 to ${NODE_LAYOUT_LIMITS.dimension}.`, `${path}/width`));
  }

  const labelValid = rawLayout.label === undefined
    || (typeof rawLayout.label === 'string' && rawLayout.label.length <= NODE_LAYOUT_LIMITS.labelLength);
  if (!labelValid) {
    errors.push(diagnostic('invalid_node_layout', `label must be a string no longer than ${NODE_LAYOUT_LIMITS.labelLength} characters.`, `${path}/label`));
  }

  const collapsedValid = rawLayout.collapsed === undefined || typeof rawLayout.collapsed === 'boolean';
  if (!collapsedValid) errors.push(diagnostic('invalid_node_layout', 'collapsed must be a boolean.', `${path}/collapsed`));

  const parentValid = rawLayout.parentFrameId === undefined
    || (typeof rawLayout.parentFrameId === 'string' && STABLE_ID.test(rawLayout.parentFrameId));
  if (!parentValid) errors.push(diagnostic('invalid_node_layout', 'parentFrameId must be a stable node ID.', `${path}/parentFrameId`));

  const colorValid = rawLayout.color === undefined || isNumberArray(rawLayout.color, 3, 0, 1);
  if (!colorValid) errors.push(diagnostic('invalid_node_layout', 'color must contain three finite RGB values from 0 to 1.', `${path}/color`));

  const width = widthValid && suppliedWidth !== undefined
    ? normalizeNumber(suppliedWidth)
    : dimensionsValid && suppliedDimensions !== undefined
      ? normalizeNumber(suppliedDimensions[0])
      : 140;
  const dimensions = dimensionsValid && suppliedDimensions !== undefined
    ? suppliedDimensions.map(normalizeNumber)
    : [width, 100];
  return {
    position: positionValid && suppliedPosition !== undefined ? suppliedPosition.map(normalizeNumber) : [0, 0],
    dimensions,
    width,
    label: labelValid && rawLayout.label !== undefined ? rawLayout.label : '',
    collapsed: collapsedValid && rawLayout.collapsed !== undefined ? rawLayout.collapsed : false,
    ...(parentValid && rawLayout.parentFrameId !== undefined ? { parentFrameId: rawLayout.parentFrameId } : {}),
    ...(colorValid && rawLayout.color !== undefined ? { color: rawLayout.color.map(normalizeNumber) } : {}),
  };
}

function validateTypedValue(value, valueType) {
  switch (valueType) {
    case 'boolean': return typeof value === 'boolean';
    case 'integer': return Number.isSafeInteger(value);
    case 'float': return Number.isFinite(value);
    case 'vec2': return isNumberArray(value, 2);
    case 'vec3': return isNumberArray(value, 3);
    case 'vec4': return isNumberArray(value, 4);
    case 'color': return isNumberArray(value, 3, 0, 1) || isNumberArray(value, 4, 0, 1);
    case 'string': return typeof value === 'string' && value.length <= 4096;
    case 'entityId':
    case 'resourceId': return typeof value === 'string' && STABLE_ID.test(value);
    case 'eventPayload': return value === null || typeof value === 'boolean' || typeof value === 'string' || Number.isFinite(value) || Array.isArray(value) || isPlainObject(value);
    default: return false;
  }
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key) => expectedKeys.includes(key));
}

function validateCurveMapping(value, definition) {
  if (!hasExactKeys(value, ['extend', 'clip', 'curves'])) return false;
  if (!definition.extendValues.includes(value.extend)) return false;
  if (!hasExactKeys(value.clip, ['enabled', 'min', 'max'])) return false;
  if (typeof value.clip.enabled !== 'boolean') return false;

  const coordinateMin = definition.min ?? -100;
  const coordinateMax = definition.max ?? 100;
  if (!isNumberArray(value.clip.min, 2, coordinateMin, coordinateMax)
    || !isNumberArray(value.clip.max, 2, coordinateMin, coordinateMax)) return false;
  for (let axis = 0; axis < 2; axis += 1) {
    if (Math.fround(value.clip.min[axis]) >= Math.fround(value.clip.max[axis])) return false;
  }

  const channels = definition.channels;
  if (!hasExactKeys(value.curves, channels)) return false;
  for (const channel of channels) {
    const points = value.curves[channel];
    if (!Array.isArray(points)
      || points.length < (definition.minItems ?? 2)
      || points.length > (definition.maxItems ?? 32)) return false;
    let priorX = -Infinity;
    for (const point of points) {
      if (!hasExactKeys(point, ['location', 'handleType'])) return false;
      if (!isNumberArray(point.location, 2, coordinateMin, coordinateMax)) return false;
      const pointX = Math.fround(point.location[0]);
      if (pointX <= priorX) return false;
      priorX = pointX;
      if (!definition.handleTypes.includes(point.handleType)) return false;
      if (value.clip.enabled && point.location.some((coordinate, axis) => (
        coordinate < value.clip.min[axis] || coordinate > value.clip.max[axis]
      ))) return false;
    }
  }
  return true;
}

function validateParamValue(value, definition, allParams, path, errors) {
  let valid = true;
  switch (definition.type) {
    case 'number': valid = Number.isFinite(value); break;
    case 'integer': valid = Number.isSafeInteger(value); break;
    case 'boolean': valid = typeof value === 'boolean'; break;
    case 'string': valid = typeof value === 'string'; break;
    case 'identifier': valid = typeof value === 'string' && IDENTIFIER.test(value); break;
    case 'stableId': valid = typeof value === 'string' && STABLE_ID.test(value); break;
    case 'enum': valid = definition.values.includes(value); break;
    case 'color': valid = isNumberArray(value, 3, 0, 1) || isNumberArray(value, 4, 0, 1); break;
    case 'numberArray': valid = isNumberArray(value, definition.length, definition.min ?? -Infinity, definition.max ?? Infinity); break;
    case 'typedValue': valid = validateTypedValue(value, allParams.valueType); break;
    case 'numericValue': valid = validateTypedValue(value, allParams.valueType) && NUMERIC_TYPES.includes(allParams.valueType); break;
    case 'curveMapping': valid = validateCurveMapping(value, definition); break;
    case 'colorStops': {
      valid = Array.isArray(value) && value.length >= (definition.minItems ?? 2) && value.length <= (definition.maxItems ?? 32);
      let prior = -Infinity;
      if (valid) {
        valid = value.every((stop) => {
          if (!isPlainObject(stop) || Object.keys(stop).some((key) => !['position', 'color'].includes(key))) return false;
          if (!Number.isFinite(stop.position) || stop.position < 0 || stop.position > 1 || stop.position < prior) return false;
          prior = stop.position;
          return isNumberArray(stop.color, 3, 0, 1) || isNumberArray(stop.color, 4, 0, 1);
        });
      }
      break;
    }
    default: valid = false;
  }
  if (valid && typeof value === 'number') {
    if (definition.min !== undefined && value < definition.min) valid = false;
    if (definition.max !== undefined && value > definition.max) valid = false;
  }
  if (!valid) errors.push(diagnostic('invalid_parameter', `Invalid ${definition.type} parameter value.`, path));
}

function resolvedPortType(portDefinition, node) {
  if (portDefinition.type === 'sameNumeric') return NUMERIC_TYPES.includes(node.params.valueType) ? node.params.valueType : null;
  if (portDefinition.type === 'sameValue') return VALUE_TYPES.includes(node.params.valueType) ? node.params.valueType : null;
  if (portDefinition.type === 'dimensionVector') {
    return ({ 2: 'vec2', 3: 'vec3', 4: 'vec4' })[node.params.dimensions] ?? null;
  }
  if (portDefinition.type === 'entityProperty') return node.params.property === 'visible' ? 'boolean' : ['position', 'rotation', 'scale'].includes(node.params.property) ? 'vec3' : null;
  return portDefinition.type;
}

function portsCompatible(actual, expected) {
  if (!actual || !expected) return false;
  if (actual === expected) return true;
  if (expected === 'numeric') return NUMERIC_PORT_TYPES.has(actual);
  if (actual === 'integer' && expected === 'float') return true;
  return false;
}

function resolvePortEntry(portTable, requestedName) {
  if (Object.hasOwn(portTable, requestedName)) return [requestedName, portTable[requestedName]];
  for (const [name, definition] of Object.entries(portTable)) {
    if (definition.blenderIdentifier === requestedName
      || definition.blenderName === requestedName
      || definition.aliases?.includes(requestedName)) return [name, definition];
  }
  return [null, null];
}

function calculateNodeCost(node, definition) {
  let cost = definition.cost;
  for (const [name, paramDefinition] of Object.entries(definition.params)) {
    if (paramDefinition.costMultiplier && Number.isFinite(node.params[name])) cost += node.params[name] * paramDefinition.costMultiplier;
  }
  return cost;
}

function generatedEntityCount(node) {
  switch (node.type) {
    case 'layout.array':
    case 'layout.scatter':
    case 'layout.alongCurve': return node.params.count ?? 0;
    case 'layout.grid': return (node.params.columns ?? 0) * (node.params.rows ?? 0);
    case 'entity.spawn':
    case 'prefab.instantiate': return 1;
    default: return 0;
  }
}

function normalizeParams(rawParams, definition, path, errors) {
  if (!checkExactKeys(rawParams, new Set(Object.keys(definition.params)), path, errors)) return {};
  const normalized = {};
  for (const [name, paramDefinition] of Object.entries(definition.params)) {
    if (Object.hasOwn(rawParams, name)) normalized[name] = cloneCanonical(rawParams[name]);
    else if (Object.hasOwn(paramDefinition, 'default')) normalized[name] = cloneCanonical(paramDefinition.default);
    else if (paramDefinition.required) errors.push(diagnostic('missing_parameter', `Required parameter "${name}" is missing.`, `${path}/${name}`));
  }
  for (const [name, value] of Object.entries(normalized)) validateParamValue(value, definition.params[name], normalized, `${path}/${name}`, errors);
  return normalized;
}

function normalizeInputs(rawInputs, definition, node, path, errors) {
  const supplied = rawInputs ?? {};
  if (!isPlainObject(supplied)) {
    errors.push(diagnostic('invalid_type', 'Expected an object.', path));
    return {};
  }
  const canonicalSupplied = {};
  for (const [requestedName, value] of Object.entries(supplied)) {
    const [name] = resolvePortEntry(definition.inputs, requestedName);
    if (!name) {
      errors.push(diagnostic('unknown_property', `Unknown socket "${requestedName}".`, `${path}/${requestedName}`));
      continue;
    }
    if (Object.hasOwn(canonicalSupplied, name)) {
      errors.push(diagnostic('duplicate_socket_default', `Socket "${name}" was supplied more than once through aliases.`, `${path}/${requestedName}`, { nodeId: node.id, port: name }));
      continue;
    }
    canonicalSupplied[name] = value;
  }
  const normalized = {};
  for (const [name, portDefinition] of Object.entries(definition.inputs)) {
    const hasSupplied = Object.hasOwn(canonicalSupplied, name);
    if (hasSupplied) normalized[name] = cloneCanonical(canonicalSupplied[name]);
    else if (Object.hasOwn(portDefinition, 'default')) normalized[name] = cloneCanonical(portDefinition.default);
    else continue;
    const valueType = resolvedPortType(portDefinition, node);
    if (!validateTypedValue(normalized[name], valueType)) {
      // Polymorphic Blender sockets expose one UI default in the catalog even
      // when a node mode resolves that socket to another numeric type. Do not
      // materialize that catalog fallback, but always reject an invalid value
      // explicitly authored on the node instance.
      if (!hasSupplied) delete normalized[name];
      else errors.push(diagnostic('invalid_socket_default', `Socket "${name}" requires a ${valueType} value.`, `${path}/${name}`, { nodeId: node.id, port: name }));
    }
  }
  return normalized;
}

function validateTextureSettings(settings, limits, errors) {
  const path = '/settings';
  if (!checkExactKeys(settings, TEXTURE_SETTING_KEYS, path, errors)) return null;
  for (const key of TEXTURE_SETTING_KEYS) {
    if (!Object.hasOwn(settings, key)) errors.push(diagnostic('missing_setting', `Texture setting "${key}" is required.`, `${path}/${key}`));
  }
  const normalized = cloneCanonical(settings);
  if (!Number.isSafeInteger(settings.seed) || settings.seed < 0 || settings.seed > 2147483647) errors.push(diagnostic('invalid_setting', 'seed must be an integer from 0 to 2147483647.', `${path}/seed`));
  if (!isNumberArray(settings.resolution, 2, 1, limits.maxBakeResolution) || !settings.resolution.every(Number.isSafeInteger)) errors.push(diagnostic('invalid_setting', 'resolution must contain two positive integer dimensions.', `${path}/resolution`));
  for (const key of ['wrapS', 'wrapT']) if (!['clamp', 'repeat', 'mirror'].includes(settings[key])) errors.push(diagnostic('invalid_setting', `${key} is not a supported wrapping mode.`, `${path}/${key}`));
  if (!['nearest', 'linear', 'nearestMipmapNearest', 'nearestMipmapLinear', 'linearMipmapNearest', 'linearMipmapLinear'].includes(settings.minFilter)) errors.push(diagnostic('invalid_setting', 'Unsupported minFilter.', `${path}/minFilter`));
  if (!['nearest', 'linear'].includes(settings.magFilter)) errors.push(diagnostic('invalid_setting', 'Unsupported magFilter.', `${path}/magFilter`));
  if (!['interactive', 'bake'].includes(settings.mode)) errors.push(diagnostic('invalid_setting', 'mode must be interactive or bake.', `${path}/mode`));
  const maxResolution = settings.mode === 'bake' ? limits.maxBakeResolution : limits.maxInteractiveResolution;
  if (Array.isArray(settings.resolution) && settings.resolution.some((entry) => entry > maxResolution)) errors.push(diagnostic('texture_resolution_exceeded', `${settings.mode} resolution exceeds ${maxResolution}.`, `${path}/resolution`));
  return normalized;
}

function topologicalMetrics(nodes, edges) {
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!indegree.has(edge.from.nodeId) || !indegree.has(edge.to.nodeId)) continue;
    outgoing.get(edge.from.nodeId).push(edge.to.nodeId);
    indegree.set(edge.to.nodeId, indegree.get(edge.to.nodeId) + 1);
  }
  const queue = [...nodes.map((node) => node.id).filter((id) => indegree.get(id) === 0)].sort(compareText);
  const depth = new Map(nodes.map((node) => [node.id, 1]));
  let visited = 0;
  while (queue.length) {
    const current = queue.shift();
    visited += 1;
    for (const next of outgoing.get(current).sort(compareText)) {
      depth.set(next, Math.max(depth.get(next), depth.get(current) + 1));
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) {
        queue.push(next);
        queue.sort(compareText);
      }
    }
  }
  return { hasCycle: visited !== nodes.length, depth: nodes.length ? Math.max(...depth.values()) : 0 };
}

function validateNodeLayoutParents(nodes, nodeById, definitions, nodePaths, errors) {
  const parentById = new Map();
  for (const node of nodes) {
    const parentFrameId = node.layout?.parentFrameId;
    if (!parentFrameId) continue;
    const path = `${nodePaths.get(node.id) ?? '/nodes'}/layout/parentFrameId`;
    const parent = nodeById.get(parentFrameId);
    if (!parent) {
      errors.push(diagnostic('missing_layout_parent', `Layout parent frame "${parentFrameId}" does not exist.`, path, { nodeId: node.id, parentFrameId }));
      continue;
    }
    const parentDefinition = definitions.get(parent.id);
    const parentType = parentDefinition?.canonicalType ?? parentDefinition?.type;
    if (parentType !== 'blender.frame') {
      errors.push(diagnostic('layout_parent_not_frame', `Layout parent "${parentFrameId}" must be a NodeFrame.`, path, { nodeId: node.id, parentFrameId }));
      continue;
    }
    parentById.set(node.id, parentFrameId);
  }

  const states = new Map();
  const stack = [];
  const reported = new Set();
  const visit = (nodeId) => {
    if (states.get(nodeId) === 2) return;
    if (states.get(nodeId) === 1) {
      const cycleStart = stack.indexOf(nodeId);
      const cycle = [...stack.slice(cycleStart), nodeId];
      const signature = [...new Set(cycle)].sort(compareText).join('\0');
      if (!reported.has(signature)) {
        reported.add(signature);
        errors.push(diagnostic(
          'layout_parent_cycle',
          `Node frame parenting contains a cycle: ${cycle.join(' -> ')}.`,
          `${nodePaths.get(nodeId) ?? '/nodes'}/layout/parentFrameId`,
          { nodeId, cycle },
        ));
      }
      return;
    }
    states.set(nodeId, 1);
    stack.push(nodeId);
    const parentFrameId = parentById.get(nodeId);
    if (parentFrameId) visit(parentFrameId);
    stack.pop();
    states.set(nodeId, 2);
  };
  for (const nodeId of parentById.keys()) visit(nodeId);
}

function findShaderAncestors(startId, incoming) {
  const result = new Set();
  const pending = [startId];
  while (pending.length) {
    const id = pending.pop();
    if (result.has(id)) continue;
    result.add(id);
    for (const source of incoming.get(id) ?? []) pending.push(source);
  }
  return result;
}

function blueprintReachableNodes(nodes, edges, definitions) {
  const reachable = new Set(nodes.filter((node) => definitions.get(node.id)?.tags.includes('event-root')).map((node) => node.id));
  const outgoingExec = new Map();
  for (const edge of edges) {
    const sourceNode = nodes.find((node) => node.id === edge.from.nodeId);
    const sourceDef = definitions.get(edge.from.nodeId);
    if (sourceNode && resolvedPortType(sourceDef.outputs[edge.from.port], sourceNode) === 'exec') {
      if (!outgoingExec.has(edge.from.nodeId)) outgoingExec.set(edge.from.nodeId, []);
      outgoingExec.get(edge.from.nodeId).push(edge.to.nodeId);
    }
  }
  const pending = [...reachable];
  while (pending.length) {
    const id = pending.pop();
    for (const next of outgoingExec.get(id) ?? []) if (!reachable.has(next)) { reachable.add(next); pending.push(next); }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (reachable.has(edge.to.nodeId) && !reachable.has(edge.from.nodeId)) { reachable.add(edge.from.nodeId); changed = true; }
    }
  }
  return reachable;
}

export function validateGraph(rawGraph, options = {}) {
  const errors = [];
  const warnings = [];
  const limits = { ...GRAPH_LIMITS, ...(options.limits ?? {}) };
  checkFiniteJson(rawGraph, '', errors);
  if (!checkExactKeys(rawGraph, GRAPH_KEYS, '', errors)) return result(null, errors, warnings, emptyMetrics());

  if (rawGraph.formatVersion !== 1) errors.push(diagnostic('unsupported_format_version', 'formatVersion must be 1.', '/formatVersion'));
  if (typeof rawGraph.id !== 'string' || !STABLE_ID.test(rawGraph.id)) errors.push(diagnostic('invalid_graph_id', 'Graph id must be a stable project ID.', '/id'));
  const catalog = GRAPH_CATALOGS[rawGraph.domain];
  if (!catalog) errors.push(diagnostic('unknown_graph_domain', 'domain must be shader, texture, or blueprint.', '/domain'));
  if (!Array.isArray(rawGraph.nodes)) errors.push(diagnostic('invalid_type', 'nodes must be an array.', '/nodes'));
  if (!Array.isArray(rawGraph.edges)) errors.push(diagnostic('invalid_type', 'edges must be an array.', '/edges'));
  if (!isPlainObject(rawGraph.outputs)) errors.push(diagnostic('invalid_type', 'outputs must be an object.', '/outputs'));
  if (!catalog || !Array.isArray(rawGraph.nodes) || !Array.isArray(rawGraph.edges) || !isPlainObject(rawGraph.outputs)) return result(null, errors, warnings, emptyMetrics());

  if (rawGraph.nodes.length > limits.maxNodes) errors.push(diagnostic('node_limit_exceeded', `Graph exceeds ${limits.maxNodes} nodes.`, '/nodes'));
  if (rawGraph.edges.length > limits.maxEdges) errors.push(diagnostic('edge_limit_exceeded', `Graph exceeds ${limits.maxEdges} edges.`, '/edges'));

  let byteLength = Infinity;
  try { byteLength = Buffer.byteLength(JSON.stringify(rawGraph)); } catch { /* reported by JSON walk */ }
  if (byteLength > limits.maxControlBytes) errors.push(diagnostic('graph_size_exceeded', `Graph exceeds ${limits.maxControlBytes} bytes.`, ''));

  let settings;
  if (rawGraph.domain === 'texture') settings = validateTextureSettings(rawGraph.settings, limits, errors);
  else if (rawGraph.settings !== undefined && (!isPlainObject(rawGraph.settings) || Object.keys(rawGraph.settings).length)) errors.push(diagnostic('settings_not_allowed', 'Only texture graphs accept settings in v1.', '/settings'));

  const nodes = [];
  const nodeById = new Map();
  const definitions = new Map();
  const nodePaths = new Map();
  let curveMappings = 0;
  for (let index = 0; index < rawGraph.nodes.length; index += 1) {
    const rawNode = rawGraph.nodes[index];
    const path = `/nodes/${index}`;
    if (!checkExactKeys(rawNode, NODE_KEYS, path, errors)) continue;
    const normalizedLayout = normalizeNodeLayout(rawNode.layout, `${path}/layout`, errors);
    if (typeof rawNode.id !== 'string' || !STABLE_ID.test(rawNode.id)) errors.push(diagnostic('invalid_node_id', 'Node id must be a stable ID.', `${path}/id`));
    else if (nodeById.has(rawNode.id)) errors.push(diagnostic('duplicate_node_id', `Duplicate node id "${rawNode.id}".`, `${path}/id`, { nodeId: rawNode.id }));
    const definition = catalog.nodes[rawNode.type];
    if (!definition) {
      errors.push(diagnostic('unknown_node_type', `Node type "${String(rawNode.type)}" is not in the ${rawGraph.domain} catalog.`, `${path}/type`, { nodeId: rawNode.id }));
      continue;
    }
    const normalized = { id: rawNode.id, type: rawNode.type, params: normalizeParams(rawNode.params, definition, `${path}/params`, errors) };
    const canonicalType = definition.canonicalType ?? definition.type;
    if (CURVE_MAPPING_NODE_TYPES.has(canonicalType)) curveMappings += 1;
    const normalizedInputs = normalizeInputs(rawNode.inputs, definition, normalized, `${path}/inputs`, errors);
    if (Object.keys(normalizedInputs).length) normalized.inputs = normalizedInputs;
    if (normalizedLayout) normalized.layout = normalizedLayout;
    nodes.push(normalized);
    if (!nodeById.has(rawNode.id)) {
      nodeById.set(rawNode.id, normalized);
      nodePaths.set(rawNode.id, path);
    }
    definitions.set(rawNode.id, definition);
  }

  if (curveMappings > limits.maxCurveMappings) {
    errors.push(diagnostic(
      'curve_mapping_limit_exceeded',
      `Graph uses ${curveMappings} CurveMapping nodes; maximum is ${limits.maxCurveMappings}.`,
      '/nodes',
    ));
  }

  validateNodeLayoutParents(nodes, nodeById, definitions, nodePaths, errors);

  if (rawGraph.domain === 'shader') {
    const parameterNames = new Map();
    for (const node of nodes.filter((entry) => entry.type.startsWith('parameter.'))) {
      if (parameterNames.has(node.params.name)) errors.push(diagnostic('duplicate_parameter_name', `Shader parameter "${node.params.name}" is declared more than once.`, '/nodes', { nodeId: node.id }));
      parameterNames.set(node.params.name, node.id);
    }
  }

  const edges = [];
  const edgeKeys = new Set();
  const occupiedInputs = new Map();
  for (let index = 0; index < rawGraph.edges.length; index += 1) {
    const rawEdge = rawGraph.edges[index];
    const path = `/edges/${index}`;
    if (!checkExactKeys(rawEdge, EDGE_KEYS, path, errors)) continue;
    if (!checkExactKeys(rawEdge.from, REF_KEYS, `${path}/from`, errors) || !checkExactKeys(rawEdge.to, REF_KEYS, `${path}/to`, errors)) continue;
    const fromNode = nodeById.get(rawEdge.from.nodeId);
    const toNode = nodeById.get(rawEdge.to.nodeId);
    if (!fromNode) errors.push(diagnostic('missing_node_reference', `Source node "${rawEdge.from.nodeId}" does not exist.`, `${path}/from/nodeId`));
    if (!toNode) errors.push(diagnostic('missing_node_reference', `Target node "${rawEdge.to.nodeId}" does not exist.`, `${path}/to/nodeId`));
    if (!fromNode || !toNode) continue;
    const [fromPortName, fromPort] = resolvePortEntry(definitions.get(fromNode.id).outputs, rawEdge.from.port);
    const [toPortName, toPort] = resolvePortEntry(definitions.get(toNode.id).inputs, rawEdge.to.port);
    if (!fromPort) errors.push(diagnostic('missing_output_port', `Output port "${rawEdge.from.port}" does not exist.`, `${path}/from/port`, { nodeId: fromNode.id }));
    if (!toPort) errors.push(diagnostic('missing_input_port', `Input port "${rawEdge.to.port}" does not exist.`, `${path}/to/port`, { nodeId: toNode.id }));
    if (!fromPort || !toPort) continue;
    const actualType = resolvedPortType(fromPort, fromNode);
    const expectedType = resolvedPortType(toPort, toNode);
    if (!portsCompatible(actualType, expectedType)) errors.push(diagnostic('port_type_mismatch', `Cannot connect ${actualType} to ${expectedType}.`, path, { fromNodeId: fromNode.id, toNodeId: toNode.id }));
    const inputKey = `${toNode.id}\u0000${toPortName}`;
    if (occupiedInputs.has(inputKey)) errors.push(diagnostic('input_already_connected', `Input "${toNode.id}.${rawEdge.to.port}" already has a connection.`, `${path}/to`));
    occupiedInputs.set(inputKey, true);
    const edgeKey = `${rawEdge.from.nodeId}\u0000${fromPortName}\u0000${rawEdge.to.nodeId}\u0000${toPortName}`;
    if (edgeKeys.has(edgeKey)) errors.push(diagnostic('duplicate_edge', 'Duplicate edge.', path));
    edgeKeys.add(edgeKey);
    edges.push({
      from: { nodeId: rawEdge.from.nodeId, port: fromPortName },
      to: { nodeId: rawEdge.to.nodeId, port: toPortName },
    });
  }

  for (const node of nodes) {
    const definition = definitions.get(node.id);
    for (const [portName, portDefinition] of Object.entries(definition.inputs)) {
      if (portDefinition.required && !occupiedInputs.has(`${node.id}\u0000${portName}`) && !Object.hasOwn(node.inputs ?? {}, portName)) errors.push(diagnostic('required_input_unconnected', `Required input "${portName}" is not connected.`, '/nodes', { nodeId: node.id, port: portName }));
    }
  }

  const topo = topologicalMetrics(nodes, edges);
  if (topo.hasCycle) errors.push(diagnostic('graph_cycle', 'Graph topology must be acyclic. Use timer, delay, event, or bounded-loop nodes without a back-edge.', '/edges'));
  if (topo.depth > limits.maxDepth) errors.push(diagnostic('graph_depth_exceeded', `Graph depth ${topo.depth} exceeds ${limits.maxDepth}.`, '/edges'));

  const normalizedOutputs = {};
  const legalOutputs = GRAPH_OUTPUTS[rawGraph.domain];
  for (const outputName of Object.keys(rawGraph.outputs).sort(compareText)) {
    const path = `/outputs/${outputName}`;
    const outputDefinition = legalOutputs[outputName];
    if (!outputDefinition) {
      errors.push(diagnostic('illegal_graph_output', `Output "${outputName}" is not legal for ${rawGraph.domain} graphs.`, path));
      continue;
    }
    const ref = rawGraph.outputs[outputName];
    const allowedKeys = rawGraph.domain === 'texture' ? TEXTURE_OUTPUT_REF_KEYS : REF_KEYS;
    if (!checkExactKeys(ref, allowedKeys, path, errors)) continue;
    const sourceNode = nodeById.get(ref.nodeId);
    if (!sourceNode) {
      errors.push(diagnostic('missing_node_reference', `Output node "${ref.nodeId}" does not exist.`, `${path}/nodeId`));
      continue;
    }
    const [sourcePortName, sourcePort] = resolvePortEntry(definitions.get(sourceNode.id).outputs, ref.port);
    if (!sourcePort) {
      errors.push(diagnostic('missing_output_port', `Output port "${ref.port}" does not exist.`, `${path}/port`, { nodeId: sourceNode.id }));
      continue;
    }
    const actualType = resolvedPortType(sourcePort, sourceNode);
    if (!outputDefinition.types.includes(actualType)) errors.push(diagnostic('graph_output_type_mismatch', `${outputName} requires ${outputDefinition.types.join(' or ')}, received ${actualType}.`, path));
    if (rawGraph.domain === 'texture') {
      if (ref.colorSpace !== outputDefinition.colorSpace) errors.push(diagnostic('color_space_mismatch', `${outputName} must use ${outputDefinition.colorSpace} colour space.`, `${path}/colorSpace`));
    }
    normalizedOutputs[outputName] = {
      nodeId: ref.nodeId,
      port: sourcePortName,
      ...(rawGraph.domain === 'texture' ? { colorSpace: ref.colorSpace } : {}),
    };
  }
  if (rawGraph.domain !== 'blueprint' && Object.keys(rawGraph.outputs).length === 0) errors.push(diagnostic('missing_graph_output', `${rawGraph.domain} graphs require at least one output.`, '/outputs'));

  const incoming = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) if (incoming.has(edge.to.nodeId)) incoming.get(edge.to.nodeId).push(edge.from.nodeId);
  if (rawGraph.domain === 'shader') {
    for (const [outputName, ref] of Object.entries(normalizedOutputs)) {
      const requiredStage = legalOutputs[outputName].stage;
      for (const nodeId of findShaderAncestors(ref.nodeId, incoming)) {
        if (!definitions.get(nodeId).stages.includes(requiredStage)) errors.push(diagnostic('shader_stage_mismatch', `Node "${nodeId}" is not legal in the ${requiredStage} stage required by ${outputName}.`, `/outputs/${outputName}`, { nodeId, stage: requiredStage }));
      }
    }
  }

  let cost = 0;
  let samplers = 0;
  let generatedEntities = 0;
  for (const node of nodes) {
    const definition = definitions.get(node.id);
    cost += calculateNodeCost(node, definition);
    if (definition.tags.includes('sampler')) samplers += 1;
    generatedEntities += generatedEntityCount(node);
  }
  const costLimit = rawGraph.domain === 'shader' ? limits.maxShaderCost : rawGraph.domain === 'texture' ? limits.maxTextureCost : limits.maxBlueprintCost;
  if (cost > costLimit) errors.push(diagnostic('graph_budget_exceeded', `Graph cost ${cost} exceeds ${costLimit}.`, '/nodes'));
  if (rawGraph.domain === 'shader' && samplers > limits.maxShaderSamplers) errors.push(diagnostic('sampler_budget_exceeded', `Shader uses ${samplers} samplers; maximum is ${limits.maxShaderSamplers}.`, '/nodes'));
  if (generatedEntities > limits.maxGeneratedEntities) errors.push(diagnostic('generated_entity_budget_exceeded', `Blueprint can generate ${generatedEntities} entities; maximum is ${limits.maxGeneratedEntities}.`, '/nodes'));

  let textureMemoryBytes = 0;
  if (rawGraph.domain === 'texture' && Array.isArray(settings?.resolution)) {
    const mipFactor = String(settings.minFilter).includes('Mipmap') ? 4 / 3 : 1;
    textureMemoryBytes = Math.ceil(settings.resolution[0] * settings.resolution[1] * 4 * Math.max(1, Object.keys(normalizedOutputs).length) * mipFactor);
    const memoryLimit = settings.mode === 'bake' ? limits.maxBakeTextureBytes : limits.maxInteractiveTextureBytes;
    if (textureMemoryBytes > memoryLimit) errors.push(diagnostic('texture_memory_budget_exceeded', `Texture outputs require ${textureMemoryBytes} bytes; maximum is ${memoryLimit}.`, '/settings/resolution'));
  }

  if (rawGraph.domain === 'blueprint') {
    const roots = nodes.filter((node) => definitions.get(node.id).tags.includes('event-root'));
    if (!roots.length && nodes.length) errors.push(diagnostic('missing_event_root', 'Blueprint graphs require at least one lifecycle, input, or named event node.', '/nodes'));
    const reachable = blueprintReachableNodes(nodes, edges, definitions);
    for (const node of nodes) if (!reachable.has(node.id)) warnings.push(warning('unreachable_node', `Node "${node.id}" is not reachable from an event.`, '/nodes', { nodeId: node.id }));
  } else {
    const used = new Set();
    for (const ref of Object.values(normalizedOutputs)) for (const id of findShaderAncestors(ref.nodeId, incoming)) used.add(id);
    for (const node of nodes) {
      if (!used.has(node.id) && !definitions.get(node.id).tags.includes('layout')) {
        warnings.push(warning('unused_node', `Node "${node.id}" does not contribute to an output.`, '/nodes', { nodeId: node.id }));
      }
    }
  }

  const canonical = {
    formatVersion: 1,
    id: rawGraph.id,
    domain: rawGraph.domain,
    nodes: nodes.sort((a, b) => compareText(a.id, b.id)).map(cloneCanonical),
    edges: edges.sort((a, b) => compareText(`${a.from.nodeId}\u0000${a.from.port}\u0000${a.to.nodeId}\u0000${a.to.port}`, `${b.from.nodeId}\u0000${b.from.port}\u0000${b.to.nodeId}\u0000${b.to.port}`)).map(cloneCanonical),
    outputs: cloneCanonical(normalizedOutputs),
    ...(rawGraph.domain === 'texture' ? { settings: cloneCanonical(settings) } : {}),
  };
  const metrics = { nodeCount: nodes.length, edgeCount: edges.length, outputCount: Object.keys(normalizedOutputs).length, depth: topo.depth, cost, samplers, generatedEntityUpperBound: generatedEntities, textureMemoryBytes, controlBytes: byteLength };
  return result(errors.length ? null : canonical, errors, warnings, metrics);
}

function emptyMetrics() {
  return { nodeCount: 0, edgeCount: 0, outputCount: 0, depth: 0, cost: 0, samplers: 0, generatedEntityUpperBound: 0, textureMemoryBytes: 0, controlBytes: 0 };
}

function result(graph, errors, warnings, metrics) {
  return { valid: errors.length === 0, graph, diagnostics: [...errors, ...warnings], errors, warnings, metrics };
}

export function assertValidGraph(graph, options) {
  const validation = validateGraph(graph, options);
  if (!validation.valid) throw new GraphValidationError(validation.errors);
  return validation.graph;
}

export function canonicalizeGraph(graph, options) {
  return assertValidGraph(graph, options);
}

export function canonicalGraphString(graph, options) {
  return JSON.stringify(canonicalizeGraph(graph, options));
}
