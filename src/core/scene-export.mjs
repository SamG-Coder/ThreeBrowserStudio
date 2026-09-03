import { triangulateEditableMesh } from './editable-mesh.mjs';
import { StudioError } from './errors.mjs';
import { evaluateGeometryModifierStack } from './geometry-modifier-evaluator.mjs';
import { decodeDataTexturePixels } from './image-texture.mjs';
import { analyzeViewportModifierStack } from './modifier-stack.mjs';
import { encodePngRgba } from './png-rgba.mjs';
import { isPlainRecord } from './util.mjs';

const GLB_MAGIC = 0x46546C67;
const GLB_JSON = 0x4E4F534A;
const GLB_BIN = 0x004E4942;
const COMPONENT_FLOAT = 5126;
const COMPONENT_USHORT = 5123;
const COMPONENT_UINT = 5125;

const MESH_KINDS = new Set(['mesh', 'instancedMesh']);
const CAMERA_KINDS = new Set(['perspectiveCamera', 'orthographicCamera']);
const LIGHT_KINDS = new Set(['directionalLight', 'pointLight', 'spotLight']);

export const SCENE_EXPORT_FORMATS = Object.freeze(['glb', 'gltf']);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

const CSS_COLOR_NAMES = Object.freeze({
  aqua: 0x00ffff, black: 0x000000, blue: 0x0000ff, fuchsia: 0xff00ff,
  gray: 0x808080, green: 0x008000, grey: 0x808080, lime: 0x00ff00,
  maroon: 0x800000, navy: 0x000080, olive: 0x808000, orange: 0xffa500,
  purple: 0x800080, red: 0xff0000, silver: 0xc0c0c0, teal: 0x008080,
  white: 0xffffff, yellow: 0xffff00,
});

function numericColor(value) {
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function hueToRgb(p, q, t) {
  let hue = t;
  if (hue < 0) hue += 1;
  if (hue > 1) hue -= 1;
  if (hue < 1 / 6) return p + ((q - p) * 6 * hue);
  if (hue < 1 / 2) return q;
  if (hue < 2 / 3) return p + ((q - p) * ((2 / 3) - hue) * 6);
  return p;
}

function cssColor(value) {
  const normalized = value.toLowerCase();
  if (CSS_COLOR_NAMES[normalized] !== undefined) return numericColor(CSS_COLOR_NAMES[normalized]);
  const hex = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/u);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map(digit => digit + digit).join('') : hex[1];
    return numericColor(Number.parseInt(digits, 16));
  }
  const rgb = value.match(/^rgb\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)\s*\)$/u);
  if (rgb) {
    const percent = rgb.slice(1).every(component => component.trim().endsWith('%'));
    const divisor = percent ? 100 : 255;
    return rgb.slice(1).map(component => Number.parseFloat(component) / divisor);
  }
  const hsl = value.match(/^hsl\(\s*([^,]+)\s*,\s*([^,]+)%\s*,\s*([^,]+)%\s*\)$/u);
  if (!hsl) return null;
  const hue = (Number.parseFloat(hsl[1]) % 360) / 360;
  const saturation = Number.parseFloat(hsl[2]) / 100;
  const lightness = Number.parseFloat(hsl[3]) / 100;
  if (saturation === 0) return [lightness, lightness, lightness];
  const q = lightness < 0.5
    ? lightness * (1 + saturation)
    : lightness + saturation - (lightness * saturation);
  const p = (2 * lightness) - q;
  return [hueToRgb(p, q, hue + (1 / 3)), hueToRgb(p, q, hue), hueToRgb(p, q, hue - (1 / 3))];
}

function color3(value, fallback = [1, 1, 1]) {
  if (Array.isArray(value) && value.length >= 3) {
    return [
      finiteNumber(value[0], fallback[0]),
      finiteNumber(value[1], fallback[1]),
      finiteNumber(value[2], fallback[2]),
    ];
  }
  if (Number.isInteger(value) && value >= 0 && value <= 0xffffff) return numericColor(value);
  if (typeof value === 'string') return cssColor(value) ?? [...fallback];
  return [...fallback];
}

function color4(value, alpha = 1) {
  const rgb = color3(value, [0.7, 0.7, 0.7]);
  return [...rgb, Array.isArray(value) ? finiteNumber(value[3], alpha) : alpha];
}

/** Three.js default Euler XYZ (radians) to glTF quaternion [x, y, z, w]. */
export function eulerXyzToQuaternion([x = 0, y = 0, z = 0] = []) {
  const cx = Math.cos(x * 0.5);
  const sx = Math.sin(x * 0.5);
  const cy = Math.cos(y * 0.5);
  const sy = Math.sin(y * 0.5);
  const cz = Math.cos(z * 0.5);
  const sz = Math.sin(z * 0.5);
  return [
    (sx * cy * cz) - (cx * sy * sz),
    (cx * sy * cz) + (sx * cy * sz),
    (cx * cy * sz) - (sx * sy * cz),
    (cx * cy * cz) + (sx * sy * sz),
  ];
}

function nearlyEqual(left, right, epsilon = 1e-8) {
  return Math.abs(left - right) <= epsilon;
}

function recipeOf(resource) {
  return resource?.recipe ?? resource?.parameters ?? resource ?? {};
}

function collectSubtreeIds(scene, rootId) {
  if (!rootId) return new Set(Object.keys(scene.entities));
  const root = scene.entities[rootId];
  if (!root) {
    throw new StudioError('not_found', `Entity ${rootId} does not exist.`, { id: rootId, kind: 'entity' });
  }
  const ids = new Set();
  const visit = (id) => {
    if (ids.has(id)) return;
    const entity = scene.entities[id];
    if (!entity) return;
    ids.add(id);
    for (const childId of asArray(entity.children)) visit(childId);
  };
  visit(rootId);
  return ids;
}

function computeVertexNormals(positions, indices) {
  const normals = new Float64Array(positions.length);
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset] * 3;
    const b = indices[offset + 1] * 3;
    const c = indices[offset + 2] * 3;
    const ax = positions[a];
    const ay = positions[a + 1];
    const az = positions[a + 2];
    const bx = positions[b];
    const by = positions[b + 1];
    const bz = positions[b + 2];
    const cx = positions[c];
    const cy = positions[c + 1];
    const cz = positions[c + 2];
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;
    const nx = (aby * acz) - (abz * acy);
    const ny = (abz * acx) - (abx * acz);
    const nz = (abx * acy) - (aby * acx);
    normals[a] += nx;
    normals[a + 1] += ny;
    normals[a + 2] += nz;
    normals[b] += nx;
    normals[b + 1] += ny;
    normals[b + 2] += nz;
    normals[c] += nx;
    normals[c + 1] += ny;
    normals[c + 2] += nz;
  }
  const result = new Array(positions.length);
  for (let offset = 0; offset < positions.length; offset += 3) {
    const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]) || 1;
    result[offset] = normals[offset] / length;
    result[offset + 1] = normals[offset + 1] / length;
    result[offset + 2] = normals[offset + 2] / length;
  }
  return result;
}

function minMax3(values) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < values.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = values[offset + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  return { min, max };
}

function textureToRgbaPng(resource) {
  const recipe = recipeOf(resource);
  const width = recipe.width;
  const height = recipe.height;
  const channels = recipe.channels ?? 4;
  const source = decodeDataTexturePixels(resource);
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const dest = index * 4;
    if (channels === 1) {
      const value = source[index];
      rgba[dest] = value;
      rgba[dest + 1] = value;
      rgba[dest + 2] = value;
      rgba[dest + 3] = 255;
    } else if (channels === 2) {
      rgba[dest] = source[index * 2];
      rgba[dest + 1] = source[index * 2 + 1];
      rgba[dest + 2] = 0;
      rgba[dest + 3] = 255;
    } else if (channels === 3) {
      rgba[dest] = source[index * 3];
      rgba[dest + 1] = source[index * 3 + 1];
      rgba[dest + 2] = source[index * 3 + 2];
      rgba[dest + 3] = 255;
    } else {
      rgba[dest] = source[dest];
      rgba[dest + 1] = source[dest + 1];
      rgba[dest + 2] = source[dest + 2];
      rgba[dest + 3] = source[dest + 3];
    }
  }
  return encodePngRgba(width, height, rgba);
}

function resolveIndexedMesh(document, entity, { tessellate } = {}) {
  const geometryId = entity.components?.mesh?.geometryId;
  if (!geometryId) {
    return { skipped: { entityId: entity.id, reason: 'mesh-missing-geometry' } };
  }
  const resource = document.resources?.geometries?.[geometryId];
  if (!resource) {
    return { skipped: { entityId: entity.id, reason: 'geometry-not-found', geometryId } };
  }
  const recipe = recipeOf(resource);
  const kind = recipe.kind ?? recipe.type ?? resource.geometryKind;
  let indexed = null;
  if (kind === 'indexedMesh' || kind === 'explicit') {
    indexed = {
      positions: asArray(recipe.positions),
      indices: asArray(recipe.indices),
      normals: Array.isArray(recipe.normals) ? recipe.normals : null,
      uvs: Array.isArray(recipe.uvs) ? recipe.uvs : null,
      triangleMaterialIndices: Array.isArray(recipe.triangleMaterialIndices)
        ? recipe.triangleMaterialIndices
        : null,
    };
  } else if (kind === 'editableMesh') {
    const compiled = triangulateEditableMesh(recipe);
    indexed = {
      positions: compiled.recipe.positions,
      indices: compiled.recipe.indices,
      normals: compiled.recipe.normals ?? null,
      uvs: compiled.recipe.uvs ?? null,
      triangleMaterialIndices: compiled.triangleMaterialIndices ?? compiled.recipe.triangleMaterialIndices ?? null,
    };
  } else if (typeof tessellate === 'function') {
    const tessellated = tessellate(resource, entity);
    if (tessellated && Array.isArray(tessellated.positions) && Array.isArray(tessellated.indices)) {
      indexed = {
        positions: tessellated.positions,
        indices: tessellated.indices,
        normals: Array.isArray(tessellated.normals) ? tessellated.normals : null,
        uvs: Array.isArray(tessellated.uvs) ? tessellated.uvs : null,
        triangleMaterialIndices: Array.isArray(tessellated.triangleMaterialIndices)
          ? tessellated.triangleMaterialIndices
          : null,
      };
    }
  }
  if (!indexed) {
    return { skipped: { entityId: entity.id, reason: 'geometry-requires-tessellation', geometryId, kind } };
  }
  if (indexed.positions.length < 9 || indexed.indices.length < 3) {
    return { skipped: { entityId: entity.id, reason: 'geometry-empty', geometryId } };
  }
  const plan = analyzeViewportModifierStack(entity, { sourceKind: kind });
  if (plan.hasActiveGeometryModifiers) {
    const evaluated = evaluateGeometryModifierStack({
      kind: 'indexedMesh',
      positions: indexed.positions,
      indices: indexed.indices,
      ...(indexed.normals ? { normals: indexed.normals } : {}),
      ...(indexed.uvs ? { uvs: indexed.uvs } : {}),
    }, plan.geometryModifiers, { target: 'viewport', unsupported: 'skip' });
    indexed = {
      ...indexed,
      positions: evaluated.recipe.positions,
      indices: evaluated.recipe.indices,
      normals: evaluated.recipe.normals ?? indexed.normals,
      uvs: evaluated.recipe.uvs ?? indexed.uvs,
    };
  }
  if (!indexed.normals || indexed.normals.length !== indexed.positions.length) {
    indexed.normals = computeVertexNormals(indexed.positions, indexed.indices);
  }
  return { mesh: indexed, geometryId };
}

class BinaryWriter {
  constructor() {
    this.parts = [];
    this.byteLength = 0;
  }

  align(alignment = 4) {
    const pad = (alignment - (this.byteLength % alignment)) % alignment;
    if (pad === 0) return;
    this.parts.push(new Uint8Array(pad));
    this.byteLength += pad;
  }

  writeBytes(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const offset = this.byteLength;
    this.parts.push(view);
    this.byteLength += view.byteLength;
    return { byteOffset: offset, byteLength: view.byteLength };
  }

  writeFloat32(values) {
    this.align(4);
    return this.writeBytes(new Uint8Array(Float32Array.from(values).buffer));
  }

  writeIndices(indices) {
    const maximum = indices.reduce((current, value) => Math.max(current, value), 0);
    if (maximum <= 65535) {
      this.align(2);
      const packed = this.writeBytes(new Uint8Array(Uint16Array.from(indices).buffer));
      this.align(4);
      return { ...packed, componentType: COMPONENT_USHORT };
    }
    this.align(4);
    return { ...this.writeBytes(new Uint8Array(Uint32Array.from(indices).buffer)), componentType: COMPONENT_UINT };
  }

  concat() {
    const output = new Uint8Array(this.byteLength);
    let offset = 0;
    for (const part of this.parts) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    return output;
  }
}

function encodeGlb(json, binary) {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadding = (4 - (jsonBytes.length % 4)) % 4;
  const jsonChunkLength = jsonBytes.length + jsonPadding;
  const binPadding = (4 - (binary.length % 4)) % 4;
  const binChunkLength = binary.length + binPadding;
  const total = 12 + 8 + jsonChunkLength + 8 + binChunkLength;
  const output = Buffer.alloc(total);
  output.writeUInt32LE(GLB_MAGIC, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(total, 8);
  output.writeUInt32LE(jsonChunkLength, 12);
  output.writeUInt32LE(GLB_JSON, 16);
  jsonBytes.copy(output, 20);
  output.fill(0x20, 20 + jsonBytes.length, 20 + jsonChunkLength);
  const binHeader = 20 + jsonChunkLength;
  output.writeUInt32LE(binChunkLength, binHeader);
  output.writeUInt32LE(GLB_BIN, binHeader + 4);
  Buffer.from(binary).copy(output, binHeader + 8);
  return output;
}

/** Parse a GLB container produced by this exporter. */
export function readGlbJson(bytes) {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== GLB_MAGIC) {
    throw new StudioError('invalid_glb', 'Not a GLB container.');
  }
  const jsonLength = buffer.readUInt32LE(12);
  const jsonType = buffer.readUInt32LE(16);
  if (jsonType !== GLB_JSON) throw new StudioError('invalid_glb', 'GLB JSON chunk is missing.');
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8').trimEnd());
}

function materialValues(resource) {
  return recipeOf(resource);
}

function buildMaterial(document, materialId, images, writer) {
  const resource = materialId ? document.resources?.materials?.[materialId] : null;
  const values = resource ? materialValues(resource) : {};
  const opacity = finiteNumber(values.opacity, 1);
  const color = color4(values.baseColor ?? values.color, opacity);
  const material = {
    name: resource?.name ?? materialId ?? 'Studio material',
    extras: {
      ...(materialId ? { studioMaterialId: materialId } : {}),
      ...(resource?.graphId || values.graphId ? { studioGraphId: resource?.graphId ?? values.graphId } : {}),
    },
    pbrMetallicRoughness: {
      baseColorFactor: color,
      metallicFactor: finiteNumber(values.metalness, 0),
      roughnessFactor: finiteNumber(values.roughness, 0.7),
    },
  };
  const mapId = values.baseColorMapId ?? values.mapId;
  const texture = mapId ? document.resources?.textures?.[mapId] : null;
  if (texture) {
    try {
      const png = textureToRgbaPng(texture);
      const view = writer.writeBytes(png);
      writer.align(4);
      const imageIndex = images.length;
      images.push({
        mimeType: 'image/png',
        bufferView: null,
        byteOffset: view.byteOffset,
        byteLength: view.byteLength,
        extras: { studioTextureId: mapId },
      });
      material.pbrMetallicRoughness.baseColorTexture = { index: imageIndex };
    } catch {
      material.extras.studioSkippedTextureId = mapId;
    }
  }
  if (values.emissive) material.emissiveFactor = color3(values.emissive, [0, 0, 0]);
  if (opacity < 1 || values.transparent === true) {
    material.alphaMode = 'BLEND';
    material.doubleSided = values.side === 'double';
  } else if (values.side === 'double') {
    material.doubleSided = true;
  }
  return material;
}

function splitPrimitives(mesh) {
  const triangleCount = mesh.indices.length / 3;
  const slots = mesh.triangleMaterialIndices;
  if (!Array.isArray(slots) || slots.length !== triangleCount) {
    return [{ indices: mesh.indices, materialSlot: 0 }];
  }
  const groups = new Map();
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const slot = Number.isInteger(slots[triangle]) ? slots[triangle] : 0;
    if (!groups.has(slot)) groups.set(slot, []);
    const index = triangle * 3;
    groups.get(slot).push(mesh.indices[index], mesh.indices[index + 1], mesh.indices[index + 2]);
  }
  return [...groups.entries()].map(([materialSlot, indices]) => ({ materialSlot, indices }));
}

function addAccessor(gltf, writer, values, { type, min, max }) {
  const view = type === 'SCALAR' ? writer.writeIndices(values) : writer.writeFloat32(values);
  const bufferViewIndex = gltf.bufferViews.length;
  gltf.bufferViews.push({
    buffer: 0,
    byteOffset: view.byteOffset,
    byteLength: view.byteLength,
  });
  const accessor = {
    bufferView: bufferViewIndex,
    componentType: view.componentType ?? COMPONENT_FLOAT,
    count: type === 'SCALAR' ? values.length : values.length / (type === 'VEC2' ? 2 : 3),
    type,
  };
  if (min) accessor.min = min;
  if (max) accessor.max = max;
  gltf.accessors.push(accessor);
  return gltf.accessors.length - 1;
}

function buildCamera(entity) {
  const values = entity.components?.camera ?? {};
  if (entity.kind === 'orthographicCamera') {
    const height = finiteNumber(values.height, 10);
    const aspect = finiteNumber(values.aspect, 1);
    return {
      name: entity.name,
      type: 'orthographic',
      extras: { studioEntityId: entity.id },
      orthographic: {
        xmag: finiteNumber(values.right ?? values.left, (height * aspect) * 0.5),
        ymag: finiteNumber(values.top ?? values.bottom, height * 0.5),
        znear: finiteNumber(values.near, 0.05),
        zfar: finiteNumber(values.far, 2000),
      },
    };
  }
  const fovDegrees = finiteNumber(values.fov, 46);
  return {
    name: entity.name,
    type: 'perspective',
    extras: { studioEntityId: entity.id },
    perspective: {
      yfov: (fovDegrees * Math.PI) / 180,
      znear: finiteNumber(values.near, 0.05),
      ...(Number.isFinite(values.far) ? { zfar: values.far } : {}),
      ...(Number.isFinite(values.aspect) ? { aspectRatio: values.aspect } : {}),
    },
  };
}

function buildLight(entity) {
  const values = entity.components?.light ?? {};
  const type = entity.kind === 'directionalLight'
    ? 'directional'
    : entity.kind === 'spotLight'
      ? 'spot'
      : 'point';
  const light = {
    name: entity.name,
    type,
    color: color3(values.color, [1, 1, 1]),
    intensity: finiteNumber(values.intensity, 1),
    extras: { studioEntityId: entity.id, studioKind: entity.kind },
  };
  if (type !== 'directional' && Number.isFinite(values.distance) && values.distance > 0) {
    light.range = values.distance;
  }
  if (type === 'spot') {
    const outer = finiteNumber(values.angle, Math.PI / 6);
    light.spot = {
      outerConeAngle: outer,
      innerConeAngle: finiteNumber(values.penumbra, 0) > 0
        ? outer * (1 - Math.min(1, values.penumbra))
        : outer * 0.8,
    };
  }
  return light;
}

/**
 * Compile an authored scene or entity subtree into a Three.js-loadable glTF 2.0
 * document. Units stay metres. Procedural primitives need a `tessellate`
 * callback (usually Runtime `createGeometry`) or they are reported as skipped.
 */
export function exportSceneInterchange(document, {
  sceneId = document.activeSceneId,
  entityId = null,
  format = 'glb',
  tessellate = null,
} = {}) {
  if (!isPlainRecord(document)) throw new StudioError('invalid_project', 'A project document is required.');
  if (!SCENE_EXPORT_FORMATS.includes(format)) {
    throw new StudioError('invalid_export_format', `Unsupported interchange format ${format}.`);
  }
  const scene = document.scenes?.[sceneId];
  if (!scene) throw new StudioError('scene_not_found', `Scene ${sceneId} does not exist.`, { sceneId });
  const include = collectSubtreeIds(scene, entityId);
  const roots = entityId ? [entityId] : [...(scene.rootEntityIds ?? [])].filter(id => include.has(id));
  const writer = new BinaryWriter();
  const gltf = {
    asset: {
      version: '2.0',
      generator: 'ThreeBrowser Studio',
    },
    extras: {
      studioProjectId: document.projectId,
      studioSceneId: scene.id,
      ...(entityId ? { studioRootEntityId: entityId } : {}),
    },
    scene: 0,
    scenes: [{ name: scene.name, nodes: [] }],
    nodes: [],
    meshes: [],
    materials: [],
    accessors: [],
    bufferViews: [],
    buffers: [{ byteLength: 0 }],
  };
  const images = [];
  const cameras = [];
  const lights = [];
  const skipped = [];
  const materialIndexById = new Map();
  const nodeIndexById = new Map();

  const materialIndex = (materialId) => {
    const key = materialId ?? '__fallback__';
    if (materialIndexById.has(key)) return materialIndexById.get(key);
    const index = gltf.materials.length;
    gltf.materials.push(buildMaterial(document, materialId, images, writer));
    materialIndexById.set(key, index);
    return index;
  };

  const addMesh = (entity, indexed, geometryId) => {
    const materialIds = entity.components?.mesh?.materialIds
      ?? (entity.components?.mesh?.materialId ? [entity.components.mesh.materialId] : []);
    const primitives = splitPrimitives(indexed).map((group) => {
      const bounds = minMax3(indexed.positions);
      const attributes = {
        POSITION: addAccessor(gltf, writer, indexed.positions, {
          type: 'VEC3', min: bounds.min, max: bounds.max,
        }),
      };
      if (indexed.normals) {
        attributes.NORMAL = addAccessor(gltf, writer, indexed.normals, { type: 'VEC3' });
      }
      if (Array.isArray(indexed.uvs) && indexed.uvs.length === (indexed.positions.length / 3) * 2) {
        attributes.TEXCOORD_0 = addAccessor(gltf, writer, indexed.uvs, { type: 'VEC2' });
      }
      return {
        attributes,
        indices: addAccessor(gltf, writer, group.indices, { type: 'SCALAR' }),
        material: materialIndex(materialIds[group.materialSlot] ?? materialIds[0] ?? null),
      };
    });
    const index = gltf.meshes.length;
    gltf.meshes.push({
      name: entity.name,
      primitives,
      extras: { studioEntityId: entity.id, studioGeometryId: geometryId },
    });
    return index;
  };

  const visit = (id) => {
    if (nodeIndexById.has(id)) return nodeIndexById.get(id);
    const entity = scene.entities[id];
    if (!entity || !include.has(id)) return null;
    const childIndices = asArray(entity.children)
      .filter(childId => include.has(childId))
      .map(visit)
      .filter(index => index !== null);
    const node = {
      name: entity.name,
      extras: {
        studioEntityId: entity.id,
        studioKind: entity.kind,
        ...(entity.visible === false ? { studioVisible: false } : {}),
      },
    };
    const transform = entity.transform ?? {};
    const position = transform.position ?? [0, 0, 0];
    const rotation = transform.rotation ?? [0, 0, 0];
    const scale = transform.scale ?? [1, 1, 1];
    if (!position.every(value => nearlyEqual(value, 0))) node.translation = [...position];
    if (!rotation.every(value => nearlyEqual(value, 0))) node.rotation = eulerXyzToQuaternion(rotation);
    if (!scale.every(value => nearlyEqual(value, 1))) node.scale = [...scale];
    if (childIndices.length > 0) node.children = childIndices;

    if (MESH_KINDS.has(entity.kind)) {
      const resolved = resolveIndexedMesh(document, entity, { tessellate });
      if (resolved.skipped) skipped.push(resolved.skipped);
      else node.mesh = addMesh(entity, resolved.mesh, resolved.geometryId);
    } else if (CAMERA_KINDS.has(entity.kind)) {
      node.camera = cameras.length;
      cameras.push(buildCamera(entity));
    } else if (LIGHT_KINDS.has(entity.kind)) {
      node.extensions = { KHR_lights_punctual: { light: lights.length } };
      lights.push(buildLight(entity));
    } else if (entity.kind?.endsWith('Light')) {
      skipped.push({ entityId: entity.id, reason: 'light-not-in-gltf-punctual', kind: entity.kind });
    }

    const index = gltf.nodes.length;
    gltf.nodes.push(node);
    nodeIndexById.set(id, index);
    return index;
  };

  gltf.scenes[0].nodes = roots.map(visit).filter(index => index !== null);
  if (cameras.length > 0) gltf.cameras = cameras;
  if (lights.length > 0) {
    gltf.extensionsUsed = ['KHR_lights_punctual'];
    gltf.extensions = { KHR_lights_punctual: { lights } };
  }
  if (images.length > 0) {
    gltf.images = images.map((image) => {
      const bufferView = gltf.bufferViews.length;
      gltf.bufferViews.push({
        buffer: 0,
        byteOffset: image.byteOffset,
        byteLength: image.byteLength,
      });
      return { mimeType: image.mimeType, bufferView, extras: image.extras };
    });
    gltf.textures = images.map((_, index) => ({ source: index }));
  }
  if (gltf.meshes.length === 0) delete gltf.meshes;
  if (gltf.materials.length === 0) delete gltf.materials;
  const binary = writer.concat();
  gltf.buffers[0].byteLength = binary.byteLength;
  if (binary.byteLength === 0) delete gltf.buffers;
  if (gltf.accessors.length === 0) {
    delete gltf.accessors;
    delete gltf.bufferViews;
  }

  const bytes = format === 'glb'
    ? encodeGlb(gltf, binary)
    : Buffer.from(JSON.stringify({
      ...gltf,
      buffers: [{
        byteLength: binary.byteLength,
        uri: `data:application/octet-stream;base64,${Buffer.from(binary).toString('base64')}`,
      }],
    }), 'utf8');

  return {
    format,
    mimeType: format === 'glb' ? 'model/gltf-binary' : 'model/gltf+json',
    bytes,
    json: gltf,
    skipped,
    stats: {
      nodes: gltf.nodes.length,
      meshes: gltf.meshes?.length ?? 0,
      materials: gltf.materials?.length ?? 0,
      cameras: cameras.length,
      lights: lights.length,
      skipped: skipped.length,
      byteLength: bytes.byteLength,
    },
  };
}
