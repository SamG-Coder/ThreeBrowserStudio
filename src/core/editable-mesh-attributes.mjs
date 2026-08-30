import { MAX_MATERIAL_SLOTS_PER_MESH } from './constants.mjs';
import {
  EDITABLE_MESH_LIMITS,
  editableMeshTopologyHash,
  normalizeEditableMeshRecipe,
} from './editable-mesh.mjs';
import { assertJsonValue, isPlainRecord } from './util.mjs';

const MAX_ATTRIBUTE_EDIT_COMMANDS = 256;
const MAX_UV_ABSOLUTE = EDITABLE_MESH_LIMITS.maxCoordinate;
const MAX_TRANSFORM_ABSOLUTE = EDITABLE_MESH_LIMITS.maxCoordinate;

export const EDITABLE_MESH_ATTRIBUTE_LIMITS = Object.freeze({
  maxCommands: MAX_ATTRIBUTE_EDIT_COMMANDS,
  maxLayersPerDomain: EDITABLE_MESH_LIMITS.maxLayers,
  maxLayerNameLength: EDITABLE_MESH_LIMITS.maxLayerNameLength,
  maxUvAbsolute: MAX_UV_ABSOLUTE,
  maxCorners: EDITABLE_MESH_LIMITS.maxCorners,
  maxFaces: EDITABLE_MESH_LIMITS.maxFaces,
  maxMaterialSlots: MAX_MATERIAL_SLOTS_PER_MESH,
});

export const EDITABLE_MESH_ATTRIBUTE_COMMAND_TYPES = Object.freeze([
  'createUvLayer',
  'deleteUvLayer',
  'renameUvLayer',
  'setActiveUvLayer',
  'setCornerUvs',
  'transformUvs',
  'projectUvs',
  'createColorLayer',
  'deleteColorLayer',
  'renameColorLayer',
  'setActiveColorLayer',
  'setCornerColors',
  'assignFaceMaterials',
  'setSharpEdges',
  'setEdgeCreases',
  'removeEdgeCreases',
]);

const COMMON_KEYS = ['type', 'expectedTopologyHash'];
const COMMAND_KEYS = new Map([
  ['createUvLayer', new Set([...COMMON_KEYS, 'name', 'fill', 'values', 'setActive'])],
  ['deleteUvLayer', new Set([...COMMON_KEYS, 'name', 'nextActiveLayer'])],
  ['renameUvLayer', new Set([...COMMON_KEYS, 'name', 'newName'])],
  ['setActiveUvLayer', new Set([...COMMON_KEYS, 'name'])],
  ['setCornerUvs', new Set([...COMMON_KEYS, 'layer', 'cornerIndices', 'values'])],
  ['transformUvs', new Set([...COMMON_KEYS, 'layer', 'cornerIndices', 'translation', 'scale', 'rotation', 'pivot'])],
  ['projectUvs', new Set([...COMMON_KEYS, 'layer', 'cornerIndices', 'projection', 'axis', 'center', 'scale', 'offset'])],
  ['createColorLayer', new Set([...COMMON_KEYS, 'name', 'fill', 'values', 'setActive'])],
  ['deleteColorLayer', new Set([...COMMON_KEYS, 'name', 'nextActiveLayer'])],
  ['renameColorLayer', new Set([...COMMON_KEYS, 'name', 'newName'])],
  ['setActiveColorLayer', new Set([...COMMON_KEYS, 'name'])],
  ['setCornerColors', new Set([...COMMON_KEYS, 'layer', 'cornerIndices', 'values'])],
  ['assignFaceMaterials', new Set([...COMMON_KEYS, 'faceIndices', 'materialIndex', 'materialIndices'])],
  ['setSharpEdges', new Set([...COMMON_KEYS, 'edges', 'sharp'])],
  ['setEdgeCreases', new Set([...COMMON_KEYS, 'edges', 'weight'])],
  ['removeEdgeCreases', new Set([...COMMON_KEYS, 'edges'])],
]);

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label}.${key} is not supported.`);
  }
}

function finiteNumber(value, label, minimum = -MAX_TRANSFORM_ABSOLUTE, maximum = MAX_TRANSFORM_ABSOLUTE) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be a finite number.`);
  if (value < minimum || value > maximum) {
    throw new RangeError(`${label} must be from ${minimum} to ${maximum}.`);
  }
  return value;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isInteger(value)) throw new TypeError(`${label} must be an integer.`);
  if (value < minimum || value > maximum) {
    throw new RangeError(`${label} must be from ${minimum} to ${maximum}.`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean.`);
  return value;
}

function layerName(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > EDITABLE_MESH_LIMITS.maxLayerNameLength
  ) {
    throw new TypeError(
      `${label} must be a non-empty string no longer than ${EDITABLE_MESH_LIMITS.maxLayerNameLength} characters.`,
    );
  }
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} cannot have surrounding whitespace or control characters.`);
  }
  return value;
}

function vector(value, size, label, minimum, maximum) {
  if (!Array.isArray(value) || value.length !== size) {
    throw new TypeError(`${label} must contain exactly ${size} finite numbers.`);
  }
  return value.map((component, index) => finiteNumber(component, `${label}[${index}]`, minimum, maximum));
}

function scalarOrVector2(value, label) {
  if (Number.isFinite(value)) {
    const scalar = finiteNumber(value, label);
    return [scalar, scalar];
  }
  return vector(value, 2, label, -MAX_TRANSFORM_ABSOLUTE, MAX_TRANSFORM_ABSOLUTE);
}

function selectedIndices(value, count, label) {
  if (value === 'all') {
    if (count === 0) throw new RangeError(`${label} has no selectable elements.`);
    return Array.from({ length: count }, (_, index) => index);
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array of unique indices, or 'all'.`);
  }
  const seen = new Set();
  return value.map((entry, index) => {
    const result = integer(entry, `${label}[${index}]`, 0, Math.max(0, count - 1));
    if (seen.has(result)) throw new RangeError(`${label} contains duplicate index ${result}.`);
    seen.add(result);
    return result;
  });
}

function exactValues(value, selectionCount, itemSize, label, minimum, maximum) {
  const expectedLength = selectionCount * itemSize;
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw new RangeError(`${label} must contain exactly ${expectedLength} numbers.`);
  }
  return value.map((entry, index) => finiteNumber(entry, `${label}[${index}]`, minimum, maximum));
}

function assertExpectedTopologyHash(mesh, command) {
  if (command.expectedTopologyHash === undefined) return;
  if (
    typeof command.expectedTopologyHash !== 'string'
    || !/^[a-f0-9]{64}$/u.test(command.expectedTopologyHash)
  ) {
    throw new TypeError('expectedTopologyHash must be a lowercase SHA-256 hash.');
  }
  const actual = editableMeshTopologyHash(mesh);
  if (actual !== command.expectedTopologyHash) {
    throw new RangeError(`Editable mesh topology changed: expected ${command.expectedTopologyHash}, received ${actual}.`);
  }
}

function withUvLayers(mesh, uvLayers, activeUvLayer = mesh.activeUvLayer) {
  return normalizeEditableMeshRecipe({ ...mesh, uvLayers, activeUvLayer });
}

function withColorLayers(mesh, colorLayers, activeColorLayer = mesh.activeColorLayer) {
  return normalizeEditableMeshRecipe({ ...mesh, colorLayers, activeColorLayer });
}

function requireLayer(layers, name, label) {
  const normalized = layerName(name, label);
  if (!Object.hasOwn(layers, normalized)) throw new RangeError(`${label} references unknown layer ${normalized}.`);
  return normalized;
}

function createLayer(mesh, command, domain) {
  const isUv = domain === 'uv';
  const layers = isUv ? mesh.uvLayers : mesh.colorLayers;
  const name = layerName(command.name, 'name');
  if (Object.hasOwn(layers, name)) throw new RangeError(`${domain.toUpperCase()} layer ${name} already exists.`);
  if (Object.keys(layers).length >= EDITABLE_MESH_LIMITS.maxLayers) {
    throw new RangeError(`${domain.toUpperCase()} layers cannot contain more than ${EDITABLE_MESH_LIMITS.maxLayers} layers.`);
  }
  if (command.fill !== undefined && command.values !== undefined) {
    throw new TypeError('create layer accepts either fill or values, not both.');
  }
  if (command.setActive !== undefined) boolean(command.setActive, 'setActive');
  const itemSize = isUv ? 2 : 4;
  const minimum = isUv ? -MAX_UV_ABSOLUTE : 0;
  const maximum = isUv ? MAX_UV_ABSOLUTE : 1;
  const defaultFill = isUv ? [0, 0] : [1, 1, 1, 1];
  const cornerCount = mesh.cornerVertexIndices.length;
  let values;
  if (command.values !== undefined) {
    values = exactValues(command.values, cornerCount, itemSize, 'values', minimum, maximum);
  } else {
    const fill = command.fill === undefined
      ? defaultFill
      : vector(command.fill, itemSize, 'fill', minimum, maximum);
    values = new Array(cornerCount * itemSize);
    for (let cornerIndex = 0; cornerIndex < cornerCount; cornerIndex += 1) {
      const offset = cornerIndex * itemSize;
      for (let component = 0; component < itemSize; component += 1) values[offset + component] = fill[component];
    }
  }
  const nextLayers = { ...layers, [name]: values };
  const currentActive = isUv ? mesh.activeUvLayer : mesh.activeColorLayer;
  const active = command.setActive === true || (command.setActive === undefined && Object.keys(layers).length === 0)
    ? name
    : currentActive;
  return isUv
    ? withUvLayers(mesh, nextLayers, active)
    : withColorLayers(mesh, nextLayers, active);
}

function deleteLayer(mesh, command, domain) {
  const isUv = domain === 'uv';
  const layers = isUv ? mesh.uvLayers : mesh.colorLayers;
  const currentActive = isUv ? mesh.activeUvLayer : mesh.activeColorLayer;
  const name = requireLayer(layers, command.name, 'name');
  const nextLayers = Object.fromEntries(Object.entries(layers).filter(([entry]) => entry !== name));
  const remainingNames = Object.keys(nextLayers);
  let active = currentActive;
  if (currentActive === name) {
    if (remainingNames.length === 0) {
      if (command.nextActiveLayer !== undefined && command.nextActiveLayer !== null) {
        throw new RangeError('nextActiveLayer must be null when deleting the final layer.');
      }
      active = null;
    } else {
      if (command.nextActiveLayer === undefined || command.nextActiveLayer === null) {
        throw new TypeError('nextActiveLayer is required when deleting an active layer while other layers remain.');
      }
      active = requireLayer(nextLayers, command.nextActiveLayer, 'nextActiveLayer');
    }
  } else if (command.nextActiveLayer !== undefined) {
    throw new TypeError('nextActiveLayer is only valid when deleting the active layer.');
  }
  return isUv
    ? withUvLayers(mesh, nextLayers, active)
    : withColorLayers(mesh, nextLayers, active);
}

function renameLayer(mesh, command, domain) {
  const isUv = domain === 'uv';
  const layers = isUv ? mesh.uvLayers : mesh.colorLayers;
  const currentActive = isUv ? mesh.activeUvLayer : mesh.activeColorLayer;
  const name = requireLayer(layers, command.name, 'name');
  const newName = layerName(command.newName, 'newName');
  if (newName !== name && Object.hasOwn(layers, newName)) {
    throw new RangeError(`${domain.toUpperCase()} layer ${newName} already exists.`);
  }
  if (newName === name) return normalizeEditableMeshRecipe(mesh);
  const nextLayers = Object.fromEntries(Object.entries(layers).map(([entry, values]) => (
    entry === name ? [newName, values] : [entry, values]
  )));
  const active = currentActive === name ? newName : currentActive;
  return isUv
    ? withUvLayers(mesh, nextLayers, active)
    : withColorLayers(mesh, nextLayers, active);
}

function setActiveLayer(mesh, command, domain) {
  const isUv = domain === 'uv';
  const layers = isUv ? mesh.uvLayers : mesh.colorLayers;
  let name = command.name;
  if (name !== null) name = requireLayer(layers, name, 'name');
  return isUv
    ? withUvLayers(mesh, mesh.uvLayers, name)
    : withColorLayers(mesh, mesh.colorLayers, name);
}

function setCornerValues(mesh, command, domain) {
  const isUv = domain === 'uv';
  const layers = isUv ? mesh.uvLayers : mesh.colorLayers;
  const layer = requireLayer(layers, command.layer, 'layer');
  const selection = selectedIndices(command.cornerIndices, mesh.cornerVertexIndices.length, 'cornerIndices');
  const itemSize = isUv ? 2 : 4;
  const values = exactValues(
    command.values,
    selection.length,
    itemSize,
    'values',
    isUv ? -MAX_UV_ABSOLUTE : 0,
    isUv ? MAX_UV_ABSOLUTE : 1,
  );
  const target = [...layers[layer]];
  for (let index = 0; index < selection.length; index += 1) {
    const targetOffset = selection[index] * itemSize;
    const sourceOffset = index * itemSize;
    for (let component = 0; component < itemSize; component += 1) {
      target[targetOffset + component] = values[sourceOffset + component];
    }
  }
  const nextLayers = { ...layers, [layer]: target };
  return isUv ? withUvLayers(mesh, nextLayers) : withColorLayers(mesh, nextLayers);
}

function transformUvs(mesh, command) {
  const layer = requireLayer(mesh.uvLayers, command.layer, 'layer');
  const selection = selectedIndices(command.cornerIndices, mesh.cornerVertexIndices.length, 'cornerIndices');
  if (
    command.translation === undefined
    && command.scale === undefined
    && command.rotation === undefined
  ) {
    throw new TypeError('transformUvs requires translation, scale, or rotation.');
  }
  const translation = command.translation === undefined
    ? [0, 0]
    : vector(command.translation, 2, 'translation', -MAX_TRANSFORM_ABSOLUTE, MAX_TRANSFORM_ABSOLUTE);
  const scale = command.scale === undefined ? [1, 1] : scalarOrVector2(command.scale, 'scale');
  const rotation = command.rotation === undefined
    ? 0
    : finiteNumber(command.rotation, 'rotation', -MAX_TRANSFORM_ABSOLUTE, MAX_TRANSFORM_ABSOLUTE);
  const pivot = command.pivot === undefined
    ? [0, 0]
    : vector(command.pivot, 2, 'pivot', -MAX_UV_ABSOLUTE, MAX_UV_ABSOLUTE);
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const values = [...mesh.uvLayers[layer]];
  for (const cornerIndex of selection) {
    const offset = cornerIndex * 2;
    const scaledX = (values[offset] - pivot[0]) * scale[0];
    const scaledY = (values[offset + 1] - pivot[1]) * scale[1];
    values[offset] = pivot[0] + scaledX * cosine - scaledY * sine + translation[0];
    values[offset + 1] = pivot[1] + scaledX * sine + scaledY * cosine + translation[1];
  }
  return withUvLayers(mesh, { ...mesh.uvLayers, [layer]: values });
}

function projectUvs(mesh, command) {
  const layer = requireLayer(mesh.uvLayers, command.layer, 'layer');
  const selection = selectedIndices(command.cornerIndices, mesh.cornerVertexIndices.length, 'cornerIndices');
  const projection = command.projection ?? 'planar';
  if (!['planar', 'box', 'cylindrical', 'spherical'].includes(projection)) throw new TypeError('Unsupported UV projection.');
  if (projection === 'planar' && !['xy', 'xz', 'yz'].includes(command.axis)) throw new TypeError("Planar axis must be 'xy', 'xz', or 'yz'.");
  if (['cylindrical', 'spherical'].includes(projection) && !['x', 'y', 'z'].includes(command.axis)) throw new TypeError('Curved projection axis must be x, y, or z.');
  const center = command.center === undefined ? [0, 0, 0] : vector(command.center, 3, 'center');
  const scale = command.scale === undefined ? [1, 1] : scalarOrVector2(command.scale, 'scale');
  const offset = command.offset === undefined
    ? [0, 0]
    : vector(command.offset, 2, 'offset', -MAX_UV_ABSOLUTE, MAX_UV_ABSOLUTE);
  const values = [...mesh.uvLayers[layer]];
  const cornerAxes = new Map();
  if (projection === 'box') {
    for (let faceIndex = 0; faceIndex < mesh.faceOffsets.length - 1; faceIndex += 1) {
      const start = mesh.faceOffsets[faceIndex]; const end = mesh.faceOffsets[faceIndex + 1];
      if (end - start < 3) continue;
      const point = corner => {
        const vertex = mesh.cornerVertexIndices[corner];
        return mesh.positions.slice(vertex * 3, vertex * 3 + 3);
      };
      const a = point(start); const b = point(start + 1); const c = point(start + 2);
      const ab = b.map((value, axis) => value - a[axis]); const ac = c.map((value, axis) => value - a[axis]);
      const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      const dominant = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
      for (let corner = start; corner < end; corner += 1) cornerAxes.set(corner, dominant);
    }
  }
  for (const cornerIndex of selection) {
    const vertexIndex = mesh.cornerVertexIndices[cornerIndex];
    const positionOffset = vertexIndex * 3;
    const x = mesh.positions[positionOffset] - center[0];
    const y = mesh.positions[positionOffset + 1] - center[1];
    const z = mesh.positions[positionOffset + 2] - center[2];
    let projected;
    if (projection === 'planar') projected = command.axis === 'xy' ? [x, y] : command.axis === 'xz' ? [x, z] : [y, z];
    else if (projection === 'box') {
      const dominant = cornerAxes.get(cornerIndex) ?? 2;
      projected = dominant === 0 ? [z, y] : dominant === 1 ? [x, z] : [x, y];
    }
    else {
      const axial = command.axis === 'x' ? x : command.axis === 'y' ? y : z;
      const first = command.axis === 'x' ? y : x;
      const second = command.axis === 'z' ? y : z;
      const longitude = Math.atan2(second, first) / (Math.PI * 2) + 0.5;
      if (projection === 'cylindrical') projected = [longitude, axial];
      else {
        const radius = Math.hypot(x, y, z);
        projected = [longitude, radius > 1e-12 ? Math.asin(Math.max(-1, Math.min(1, axial / radius))) / Math.PI + 0.5 : 0.5];
      }
    }
    values[cornerIndex * 2] = projected[0] * scale[0] + offset[0];
    values[cornerIndex * 2 + 1] = projected[1] * scale[1] + offset[1];
  }
  return withUvLayers(mesh, { ...mesh.uvLayers, [layer]: values });
}

function assignFaceMaterials(mesh, command) {
  const selection = selectedIndices(command.faceIndices, mesh.faceOffsets.length - 1, 'faceIndices');
  if ((command.materialIndex === undefined) === (command.materialIndices === undefined)) {
    throw new TypeError('assignFaceMaterials requires exactly one of materialIndex or materialIndices.');
  }
  let materialIndices;
  if (command.materialIndex !== undefined) {
    const materialIndex = integer(command.materialIndex, 'materialIndex', 0, MAX_MATERIAL_SLOTS_PER_MESH - 1);
    materialIndices = new Array(selection.length).fill(materialIndex);
  } else {
    if (!Array.isArray(command.materialIndices) || command.materialIndices.length !== selection.length) {
      throw new RangeError(`materialIndices must contain exactly ${selection.length} entries.`);
    }
    materialIndices = command.materialIndices.map((value, index) => integer(
      value,
      `materialIndices[${index}]`,
      0,
      MAX_MATERIAL_SLOTS_PER_MESH - 1,
    ));
  }
  const faceMaterialIndices = [...mesh.faceMaterialIndices];
  selection.forEach((faceIndex, index) => {
    faceMaterialIndices[faceIndex] = materialIndices[index];
  });
  return normalizeEditableMeshRecipe({ ...mesh, faceMaterialIndices });
}

function edgeKey(first, second) {
  return first < second ? `${first}:${second}` : `${second}:${first}`;
}

function edgeTuple(first, second) {
  return first < second ? [first, second] : [second, first];
}

function topologyEdgeKeys(mesh) {
  const result = new Set();
  for (let faceIndex = 0; faceIndex < mesh.faceOffsets.length - 1; faceIndex += 1) {
    const start = mesh.faceOffsets[faceIndex];
    const end = mesh.faceOffsets[faceIndex + 1];
    for (let corner = start; corner < end; corner += 1) {
      const next = corner + 1 === end ? start : corner + 1;
      result.add(edgeKey(mesh.cornerVertexIndices[corner], mesh.cornerVertexIndices[next]));
    }
  }
  return result;
}

function selectedEdges(mesh, value, label = 'edges') {
  const topologyEdges = topologyEdgeKeys(mesh);
  if (value === 'all') {
    if (topologyEdges.size === 0) throw new RangeError(`${label} has no selectable elements.`);
    return [...topologyEdges].sort().map(key => key.split(':').map(Number));
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array of unique vertex-index pairs, or 'all'.`);
  }
  const vertexCount = mesh.positions.length / 3;
  const seen = new Set();
  return value.map((pair, index) => {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new TypeError(`${label}[${index}] must contain exactly two vertex indices.`);
    }
    const first = integer(pair[0], `${label}[${index}][0]`, 0, Math.max(0, vertexCount - 1));
    const second = integer(pair[1], `${label}[${index}][1]`, 0, Math.max(0, vertexCount - 1));
    if (first === second) throw new RangeError(`${label}[${index}] cannot reference the same vertex twice.`);
    const key = edgeKey(first, second);
    if (!topologyEdges.has(key)) throw new RangeError(`${label}[${index}] does not reference a mesh edge.`);
    if (seen.has(key)) throw new RangeError(`${label} contains duplicate edge ${key}.`);
    seen.add(key);
    return edgeTuple(first, second);
  });
}

function setSharpEdges(mesh, command) {
  const edges = selectedEdges(mesh, command.edges);
  const sharp = boolean(command.sharp, 'sharp');
  const values = new Map(mesh.sharpEdges.map(pair => [edgeKey(...pair), pair]));
  for (const pair of edges) {
    if (sharp) values.set(edgeKey(...pair), pair);
    else values.delete(edgeKey(...pair));
  }
  return normalizeEditableMeshRecipe({ ...mesh, sharpEdges: [...values.values()] });
}

function setEdgeCreases(mesh, command) {
  const edges = selectedEdges(mesh, command.edges);
  const weight = finiteNumber(command.weight, 'weight', 0, 1);
  const values = new Map(mesh.edgeCreases.map(tuple => [edgeKey(tuple[0], tuple[1]), tuple]));
  for (const [first, second] of edges) values.set(edgeKey(first, second), [first, second, weight]);
  return normalizeEditableMeshRecipe({ ...mesh, edgeCreases: [...values.values()] });
}

function removeEdgeCreases(mesh, command) {
  const edges = selectedEdges(mesh, command.edges);
  const remove = new Set(edges.map(pair => edgeKey(...pair)));
  return normalizeEditableMeshRecipe({
    ...mesh,
    edgeCreases: mesh.edgeCreases.filter(tuple => !remove.has(edgeKey(tuple[0], tuple[1]))),
  });
}

/**
 * Applies one strict, serializable per-corner/per-face/per-edge attribute edit.
 * Inputs are normalized and detached before any changes are made.
 */
export function applyEditableMeshAttributeEdit(recipe, command) {
  const mesh = normalizeEditableMeshRecipe(recipe);
  if (!isPlainRecord(command)) throw new TypeError('Editable mesh attribute command must be a plain object.');
  assertJsonValue(command, 'command');
  const allowed = COMMAND_KEYS.get(command.type);
  if (!allowed) throw new TypeError(`Unsupported editable mesh attribute command: ${String(command.type)}.`);
  assertKnownKeys(command, allowed, `command ${command.type}`);
  assertExpectedTopologyHash(mesh, command);

  switch (command.type) {
    case 'createUvLayer': return createLayer(mesh, command, 'uv');
    case 'deleteUvLayer': return deleteLayer(mesh, command, 'uv');
    case 'renameUvLayer': return renameLayer(mesh, command, 'uv');
    case 'setActiveUvLayer': return setActiveLayer(mesh, command, 'uv');
    case 'setCornerUvs': return setCornerValues(mesh, command, 'uv');
    case 'transformUvs': return transformUvs(mesh, command);
    case 'projectUvs': return projectUvs(mesh, command);
    case 'createColorLayer': return createLayer(mesh, command, 'color');
    case 'deleteColorLayer': return deleteLayer(mesh, command, 'color');
    case 'renameColorLayer': return renameLayer(mesh, command, 'color');
    case 'setActiveColorLayer': return setActiveLayer(mesh, command, 'color');
    case 'setCornerColors': return setCornerValues(mesh, command, 'color');
    case 'assignFaceMaterials': return assignFaceMaterials(mesh, command);
    case 'setSharpEdges': return setSharpEdges(mesh, command);
    case 'setEdgeCreases': return setEdgeCreases(mesh, command);
    case 'removeEdgeCreases': return removeEdgeCreases(mesh, command);
    default: throw new TypeError(`Unsupported editable mesh attribute command: ${String(command.type)}.`);
  }
}

/** Applies a bounded command sequence and returns one canonical detached recipe. */
export function applyEditableMeshAttributeEdits(recipe, commands) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new TypeError('commands must be a non-empty array.');
  }
  if (commands.length > MAX_ATTRIBUTE_EDIT_COMMANDS) {
    throw new RangeError(`commands cannot contain more than ${MAX_ATTRIBUTE_EDIT_COMMANDS} entries.`);
  }
  return commands.reduce((mesh, command) => applyEditableMeshAttributeEdit(mesh, command), recipe);
}
