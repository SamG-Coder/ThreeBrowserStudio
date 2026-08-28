export const RTX_SCENE_LIMITS = Object.freeze({
  maxObjects: 20_000,
  maxTriangles: 2_000_000,
  maxVertices: 6_000_000,
  maxPointSpotLights: 8,
  maxInstancesPerMesh: 8_192,
  maxDiagnostics: 2_048,
});

export const RTX_LIGHT_TYPES = Object.freeze({ point: 0, spot: 1 });

const IDENTITY_MATRIX = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);
const DEFAULT_SURFACE = Object.freeze([0.65, 0.65, 0.65, 0.5]);
const DEFAULT_RADIANCE = Object.freeze([0, 0, 0, 0]);
const OPTION_KEYS = new Set(Object.keys(RTX_SCENE_LIMITS));

export class RtxSceneValidationError extends TypeError {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RtxSceneValidationError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new RtxSceneValidationError(code, message, details);
}

function finiteArray(value, length, label) {
  const source = value?.elements ?? value?.array ?? value;
  if (!source || typeof source.length !== 'number' || source.length < length) return null;
  const result = Array.from({ length }, (_, index) => Number(source[index]));
  return result.every(Number.isFinite) ? result : null;
}

function matrixElements(value, { identity = false } = {}) {
  return finiteArray(value, 16, 'matrix') ?? (identity ? [...IDENTITY_MATRIX] : null);
}

function multiplyMatrices(left, right) {
  const output = Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let index = 0; index < 4; index += 1) {
        output[column * 4 + row] += left[index * 4 + row] * right[column * 4 + index];
      }
    }
  }
  return output;
}

function transformPoint(matrix, x, y, z) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function worldPosition(object) {
  const matrix = matrixElements(object?.matrixWorld, { identity: object?.matrixWorld == null });
  return matrix ? [matrix[12], matrix[13], matrix[14]] : null;
}

function objectId(object, fallback) {
  return object?.userData?.studioEntityId
    ?? object?.name
    ?? object?.uuid
    ?? `compiled-object/${fallback}`;
}

function isMesh(object) {
  return object?.isMesh === true || object?.isInstancedMesh === true;
}

function isSupportedLight(object) {
  return object?.isDirectionalLight === true
    || object?.isPointLight === true
    || object?.isSpotLight === true;
}

function addDiagnostic(context, code, object, message, details = {}) {
  context.skipped += 1;
  context.skipCounts.set(code, (context.skipCounts.get(code) ?? 0) + 1);
  if (context.diagnostics.length >= context.limits.maxDiagnostics) {
    context.diagnosticsTruncated += 1;
    return;
  }
  context.diagnostics.push({
    severity: 'warning',
    code,
    objectId: objectId(object, context.objectsVisited),
    message,
    ...(Object.keys(details).length ? { details } : {}),
  });
}

function normalizeLimit(value, key, maximum) {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail('invalid_rtx_collector_option', `${key} must be an integer from 0 to ${maximum}.`, { key, value });
  }
  return value;
}

function normalizeOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail('invalid_rtx_collector_options', 'RTX collector options must be an object.');
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) fail('invalid_rtx_collector_option', `Unknown RTX collector option ${key}.`, { key });
  }
  return Object.fromEntries(Object.entries(RTX_SCENE_LIMITS).map(([key, maximum]) => [
    key,
    normalizeLimit(options[key], key, maximum),
  ]));
}

function positionAttributeData(attribute) {
  if (!attribute || !Number.isSafeInteger(attribute.count) || attribute.count < 1) return null;
  const positions = new Float64Array(attribute.count * 3);
  if (typeof attribute.getX === 'function'
      && typeof attribute.getY === 'function'
      && typeof attribute.getZ === 'function') {
    for (let index = 0; index < attribute.count; index += 1) {
      positions[index * 3] = Number(attribute.getX(index));
      positions[index * 3 + 1] = Number(attribute.getY(index));
      positions[index * 3 + 2] = Number(attribute.getZ(index));
    }
  } else {
    const source = attribute.array;
    const itemSize = Number(attribute.itemSize ?? 3);
    if (!source || !Number.isSafeInteger(itemSize) || itemSize < 3
        || source.length < attribute.count * itemSize) return null;
    for (let index = 0; index < attribute.count; index += 1) {
      positions[index * 3] = Number(source[index * itemSize]);
      positions[index * 3 + 1] = Number(source[index * itemSize + 1]);
      positions[index * 3 + 2] = Number(source[index * itemSize + 2]);
    }
  }
  return positions.every(Number.isFinite) ? positions : null;
}

function indexData(index, vertexCount) {
  if (index == null) {
    if ((vertexCount % 3) !== 0) return null;
    return Uint32Array.from({ length: vertexCount }, (_, value) => value);
  }
  const count = Number(index.count ?? index.array?.length ?? index.length);
  if (!Number.isSafeInteger(count) || count < 3 || (count % 3) !== 0) return null;
  const source = index.array ?? index;
  const values = new Uint32Array(count);
  for (let offset = 0; offset < count; offset += 1) {
    const original = typeof index.getX === 'function' ? Number(index.getX(offset)) : Number(source?.[offset]);
    if (!Number.isSafeInteger(original) || original < 0 || original >= vertexCount) return null;
    values[offset] = original;
  }
  return values;
}

function drawRange(geometry, indexCount) {
  const start = Number(geometry?.drawRange?.start ?? 0);
  const authoredCount = geometry?.drawRange?.count;
  const count = authoredCount === undefined || authoredCount === Infinity
    ? indexCount - start
    : Number(authoredCount);
  if (!Number.isSafeInteger(start) || start < 0 || start > indexCount
      || !Number.isSafeInteger(count) || count < 0) return null;
  const end = Math.min(indexCount, start + count);
  if ((start % 3) !== 0 || (end % 3) !== 0) return null;
  return { start, end };
}

function colorValues(color, fallback) {
  if (color == null) return [...fallback].slice(0, 3);
  const fromArray = finiteArray(color, 3, 'color');
  if (fromArray) return fromArray;
  const values = [Number(color.r), Number(color.g), Number(color.b)];
  return values.every(Number.isFinite) ? values : null;
}

function materialForTriangle(material, geometry, indexOffset) {
  if (!Array.isArray(material)) return { material: material ?? null, materialIndex: 0 };
  const matches = (geometry.groups ?? []).filter(group => {
    const start = Number(group?.start);
    const count = Number(group?.count);
    return Number.isSafeInteger(start) && Number.isSafeInteger(count)
      && indexOffset >= start && indexOffset + 3 <= start + count;
  });
  if (matches.length !== 1) return { invalid: true };
  const materialIndex = Number(matches[0].materialIndex ?? 0);
  if (!Number.isSafeInteger(materialIndex) || materialIndex < 0 || materialIndex >= material.length) {
    return { invalid: true };
  }
  return { material: material[materialIndex] ?? null, materialIndex };
}

function materialRecord(material) {
  if (material?.visible === false) return { skip: 'rtx_material_hidden', message: 'Material is not visible.' };
  if (material?.rtxIgnore === true || material?.userData?.rtxIgnore === true) {
    return { skip: 'rtx_ignored', message: 'Material is marked userData.rtxIgnore.' };
  }
  const opacity = Number(material?.opacity ?? 1);
  if (!Number.isFinite(opacity)) return { skip: 'rtx_invalid_material', message: 'Material opacity is not finite.' };
  if (material?.transparent === true || opacity < 1) {
    return { skip: 'rtx_transparent_material', message: 'Transparent material is excluded from the static RTX scene.' };
  }
  const transmission = Number(material?.transmission ?? 0);
  if (!Number.isFinite(transmission)) return { skip: 'rtx_invalid_material', message: 'Material transmission is not finite.' };
  if (transmission > 0 || material?.transmissionNode != null) {
    return { skip: 'rtx_transmissive_material', message: 'Transmissive material is excluded from the static RTX scene.' };
  }
  if (Number(material?.alphaTest ?? 0) > 0) {
    return { skip: 'rtx_alpha_cutout_unsupported', message: 'Alpha-cutout material cannot be represented by opaque RTX triangles.' };
  }

  const albedo = colorValues(material?.color, DEFAULT_SURFACE);
  const emissive = colorValues(material?.emissive, DEFAULT_RADIANCE);
  const roughness = Number(material?.roughness ?? DEFAULT_SURFACE[3]);
  const emissiveIntensity = Number(material?.emissiveIntensity ?? 1);
  const radiance = emissive?.map(value => value * emissiveIntensity);
  if (!albedo || !emissive || albedo.some(value => value < 0 || !Number.isFinite(Math.fround(value)))
      || emissive.some(value => value < 0) || radiance?.some(value => !Number.isFinite(Math.fround(value)))
      || !Number.isFinite(roughness) || roughness < 0 || roughness > 1
      || !Number.isFinite(emissiveIntensity) || emissiveIntensity < 0) {
    return { skip: 'rtx_invalid_material', message: 'RTX material values must be finite and inside the native surface ranges.' };
  }
  return {
    surface: [albedo[0], albedo[1], albedo[2], roughness],
    radiance: [
      radiance[0],
      radiance[1],
      radiance[2],
      0,
    ],
  };
}

function meshTemplate(object, context) {
  const geometry = object.geometry;
  if (!geometry || geometry.rtxIgnore === true || geometry.userData?.rtxIgnore === true) {
    addDiagnostic(context, 'rtx_missing_or_ignored_geometry', object, 'Mesh geometry is missing or marked rtxIgnore.');
    return null;
  }
  const positions = positionAttributeData(geometry.attributes?.position);
  if (!positions) {
    addDiagnostic(context, 'rtx_invalid_positions', object, 'Mesh position attribute is missing, non-finite, or malformed.');
    return null;
  }
  const indices = indexData(geometry.index, positions.length / 3);
  if (!indices) {
    addDiagnostic(context, 'rtx_invalid_indices', object, 'Mesh indices must form valid indexed triangles.');
    return null;
  }
  const range = drawRange(geometry, indices.length);
  if (!range) {
    addDiagnostic(context, 'rtx_invalid_draw_range', object, 'Mesh drawRange must cover complete indexed triangles.');
    return null;
  }

  const records = [];
  const materialDiagnostics = new Set();
  for (let offset = range.start; offset < range.end; offset += 3) {
    const resolved = materialForTriangle(object.material, geometry, offset);
    if (resolved.invalid) {
      if (!materialDiagnostics.has('rtx_material_group_ambiguous')) {
        addDiagnostic(context, 'rtx_material_group_ambiguous', object, 'Multi-material triangle has no single valid geometry group.');
        materialDiagnostics.add('rtx_material_group_ambiguous');
      }
      continue;
    }
    const material = materialRecord(resolved.material);
    if (material.skip) {
      const key = `${material.skip}:${resolved.materialIndex}`;
      if (!materialDiagnostics.has(key)) {
        addDiagnostic(context, material.skip, object, material.message, { materialIndex: resolved.materialIndex });
        materialDiagnostics.add(key);
      }
      continue;
    }
    records.push({
      indices: [indices[offset], indices[offset + 1], indices[offset + 2]],
      radiance: material.radiance,
      surface: material.surface,
    });
  }
  if (records.length === 0) {
    addDiagnostic(context, 'rtx_no_opaque_triangles', object, 'Mesh has no eligible opaque RTX triangles.');
    return null;
  }
  return { positions, records, vertexCount: positions.length / 3 };
}

function instanceMatrices(object, context) {
  const world = matrixElements(object.matrixWorld, { identity: object.matrixWorld == null });
  if (!world) {
    addDiagnostic(context, 'rtx_invalid_world_matrix', object, 'Mesh matrixWorld must contain 16 finite values.');
    return [];
  }
  if (!object.isInstancedMesh) return [world];
  const count = Number(object.count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    addDiagnostic(context, 'rtx_invalid_instance_count', object, 'InstancedMesh count must be a non-negative integer.');
    return [];
  }
  if (count === 0) {
    addDiagnostic(context, 'rtx_inactive_instances', object, 'InstancedMesh has no active instances.');
    return [];
  }
  const included = Math.min(count, context.limits.maxInstancesPerMesh);
  if (included < count) {
    addDiagnostic(
      context,
      'rtx_instance_budget_exceeded',
      object,
      `InstancedMesh exceeds the ${context.limits.maxInstancesPerMesh}-instance collector cap.`,
      { requested: count, included },
    );
  }
  const source = object.instanceMatrix?.array;
  if (!source || source.length < count * 16) {
    addDiagnostic(context, 'rtx_invalid_instance_matrices', object, 'InstancedMesh requires tightly packed finite 4x4 instance matrices.');
    return [];
  }
  const matrices = [];
  for (let index = 0; index < included; index += 1) {
    const local = Array.from({ length: 16 }, (_, component) => Number(source[index * 16 + component]));
    if (!local.every(Number.isFinite)) {
      addDiagnostic(context, 'rtx_invalid_instance_matrix', object, `Instance ${index} contains a non-finite transform.`, { index });
      continue;
    }
    matrices.push(multiplyMatrices(world, local));
  }
  return matrices;
}

function appendMesh(object, context) {
  context.meshesSeen += 1;
  if (object.isSkinnedMesh === true || object.isBatchedMesh === true) {
    addDiagnostic(context, 'rtx_deformed_mesh_unsupported', object, 'Skinned and batched meshes require a future dynamic RTX path.');
    return;
  }
  const template = meshTemplate(object, context);
  if (!template) return;
  let matrices = instanceMatrices(object, context);
  if (matrices.length === 0) return;

  const remainingTriangles = context.limits.maxTriangles - context.triangleCount;
  const remainingVertices = context.limits.maxVertices - context.vertexCount;
  const byTriangles = Math.floor(remainingTriangles / template.records.length);
  const byVertices = Math.floor(remainingVertices / template.vertexCount);
  const includeCount = Math.min(matrices.length, byTriangles, byVertices);
  if (includeCount < matrices.length) {
    const code = byTriangles <= byVertices ? 'rtx_triangle_budget_exceeded' : 'rtx_vertex_budget_exceeded';
    addDiagnostic(context, code, object, 'Mesh instances were truncated by the deterministic RTX scene budget.', {
      requestedInstances: matrices.length,
      includedInstances: includeCount,
    });
    matrices = matrices.slice(0, includeCount);
  }
  if (matrices.length === 0) return;

  let appendedInstances = 0;
  for (const matrix of matrices) {
    const transformed = new Float32Array(template.positions.length);
    let valid = true;
    for (let offset = 0; offset < template.positions.length; offset += 3) {
      const point = transformPoint(
        matrix,
        template.positions[offset],
        template.positions[offset + 1],
        template.positions[offset + 2],
      );
      if (!point.every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value)))) {
        valid = false;
        break;
      }
      transformed.set(point, offset);
    }
    if (!valid) {
      addDiagnostic(context, 'rtx_nonfinite_world_position', object, 'World transform produced non-finite RTX positions.');
      continue;
    }
    const vertexBase = context.vertexCount;
    context.positions.push(...transformed);
    for (const record of template.records) {
      context.indices.push(
        vertexBase + record.indices[0],
        vertexBase + record.indices[1],
        vertexBase + record.indices[2],
      );
      context.radiance.push(...record.radiance);
      context.surface.push(...record.surface);
    }
    context.vertexCount += template.vertexCount;
    context.triangleCount += template.records.length;
    appendedInstances += 1;
  }
  if (appendedInstances > 0) {
    context.meshesIncluded += 1;
    context.instancesIncluded += appendedInstances;
  }
}

function normalizedDirection(from, to) {
  if (!from || !to) return null;
  const vector = [from[0] - to[0], from[1] - to[1], from[2] - to[2]];
  if (!vector.every(Number.isFinite)) return null;
  const length = Math.hypot(...vector);
  if (!Number.isFinite(length) || length <= 1e-6) return null;
  const direction = vector.map(value => value / length);
  return direction.every(value => Number.isFinite(Math.fround(value))) ? direction : null;
}

function lightColor(object) {
  const color = colorValues(object.color, [1, 1, 1]);
  const intensity = Number(object.intensity ?? 1);
  if (!color || color.some(value => value < 0 || !Number.isFinite(Math.fround(value)))
      || !Number.isFinite(intensity) || !Number.isFinite(Math.fround(intensity)) || intensity < 0) return null;
  return { color, intensity };
}

function appendDirectionalLight(object, context) {
  const values = lightColor(object);
  if (!values) {
    addDiagnostic(context, 'rtx_invalid_light', object, 'Directional light color and intensity must be finite and non-negative.');
    return;
  }
  if (values.intensity === 0) {
    addDiagnostic(context, 'rtx_inactive_light', object, 'Zero-intensity directional light was omitted.');
    return;
  }
  if (context.directionalLight) {
    addDiagnostic(context, 'rtx_directional_light_limit', object, 'Native ray lighting accepts one directional light per frame.');
    return;
  }
  const direction = normalizedDirection(worldPosition(object), worldPosition(object.target));
  if (!direction) {
    addDiagnostic(context, 'rtx_invalid_light_direction', object, 'Directional light position and target must define a non-zero direction.');
    return;
  }
  context.directionalLight = Object.freeze({
    directionalLightDirection: new Float32Array(direction),
    directionalLightIntensity: values.intensity,
    sourceId: objectId(object, context.objectsVisited),
  });
}

function pointSpotDescriptor(object, context) {
  const values = lightColor(object);
  if (!values) return { error: 'Light color and intensity must be finite and non-negative.' };
  if (values.intensity === 0) return { inactive: true };
  const position = worldPosition(object);
  const range = Number(object.distance ?? 0);
  const decay = Number(object.decay ?? 2);
  if (!position || !position.every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value)))
      || !Number.isFinite(range) || !Number.isFinite(Math.fround(range)) || range < 0
      || !Number.isFinite(decay) || !Number.isFinite(Math.fround(decay)) || decay < 0) {
    return { error: 'Point/spot position, range, and decay must satisfy the native light ranges.' };
  }
  if (object.isPointLight === true) {
    return {
      sourceId: objectId(object, context.objectsVisited),
      kind: 'point',
      position,
      range,
      direction: [0, 0, 0],
      outerCos: -1,
      color: values.color,
      intensity: values.intensity,
      innerCos: 1,
      type: RTX_LIGHT_TYPES.point,
      decay,
      reserved: 0,
    };
  }
  const angle = Number(object.angle ?? Math.PI / 3);
  const penumbra = Number(object.penumbra ?? 0);
  const direction = normalizedDirection(worldPosition(object.target), position);
  if (!direction || !Number.isFinite(angle) || angle <= 0 || angle > Math.PI / 2
      || !Number.isFinite(penumbra) || penumbra < 0 || penumbra > 1) {
    return { error: 'Spot lights require a non-zero target direction, angle in (0, pi/2], and penumbra in [0, 1].' };
  }
  return {
    sourceId: objectId(object, context.objectsVisited),
    kind: 'spot',
    position,
    range,
    direction,
    outerCos: Math.cos(angle),
    color: values.color,
    intensity: values.intensity,
    innerCos: Math.cos(angle * (1 - penumbra)),
    type: RTX_LIGHT_TYPES.spot,
    decay,
    reserved: 0,
  };
}

function appendPointSpotLight(object, context) {
  if (context.lightDescriptors.length >= context.limits.maxPointSpotLights) {
    addDiagnostic(context, 'rtx_light_budget_exceeded', object, `Native static RTX lights are capped at ${context.limits.maxPointSpotLights}.`);
    return;
  }
  const descriptor = pointSpotDescriptor(object, context);
  if (descriptor.error) {
    addDiagnostic(context, 'rtx_invalid_light', object, descriptor.error);
    return;
  }
  if (descriptor.inactive) {
    addDiagnostic(context, 'rtx_inactive_light', object, 'Zero-intensity light was omitted.');
    return;
  }
  context.lightDescriptors.push(Object.freeze({
    ...descriptor,
    position: Object.freeze([...descriptor.position]),
    direction: Object.freeze([...descriptor.direction]),
    color: Object.freeze([...descriptor.color]),
  }));
  context.lights.push(
    ...descriptor.position, descriptor.range,
    ...descriptor.direction, descriptor.outerCos,
    ...descriptor.color, descriptor.intensity,
    descriptor.innerCos, descriptor.type, descriptor.decay, descriptor.reserved,
  );
}

function appendLight(object, context) {
  context.lightsSeen += 1;
  if (object.isDirectionalLight === true) appendDirectionalLight(object, context);
  else appendPointSpotLight(object, context);
}

function typedPayload(context) {
  return {
    positions: new Float32Array(context.positions),
    indices: new Uint32Array(context.indices),
    triangleRadiance: new Float32Array(context.radiance),
    triangleSurface: new Float32Array(context.surface),
    lights: new Float32Array(context.lights),
  };
}

export function validateRtxScenePayload(payload, { allowEmpty = false } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('invalid_rtx_scene', 'RTX scene payload must be an object.');
  }
  const positions = payload.positions;
  const indices = payload.indices;
  const radiance = payload.triangleRadiance;
  const surface = payload.triangleSurface;
  const lights = payload.lights;
  if (!(positions instanceof Float32Array) || (positions.length % 3) !== 0
      || (!allowEmpty && positions.length === 0) || positions.some(value => !Number.isFinite(value))) {
    fail('invalid_rtx_positions', 'positions must be a non-empty finite Float32Array of world-space xyz triples.');
  }
  const vertexCount = positions.length / 3;
  if (!(indices instanceof Uint32Array) || (indices.length % 3) !== 0
      || (!allowEmpty && indices.length === 0)) {
    fail('invalid_rtx_indices', 'indices must be a non-empty Uint32Array triangle list.');
  }
  for (let offset = 0; offset < indices.length; offset += 1) {
    if (indices[offset] >= vertexCount) {
      fail('invalid_rtx_indices', `indices[${offset}] does not reference a collected position.`, { offset });
    }
  }
  const triangleCount = indices.length / 3;
  if (vertexCount > RTX_SCENE_LIMITS.maxVertices || triangleCount > RTX_SCENE_LIMITS.maxTriangles) {
    fail('rtx_scene_budget_exceeded', 'RTX scene payload exceeds Studio static scene limits.', { vertexCount, triangleCount });
  }
  if (!(radiance instanceof Float32Array) || radiance.length !== triangleCount * 4
      || radiance.some(value => !Number.isFinite(value) || value < 0)) {
    fail('invalid_rtx_triangle_radiance', 'triangleRadiance must contain one finite non-negative HDR vec4 per triangle.');
  }
  if (!(surface instanceof Float32Array) || surface.length !== triangleCount * 4) {
    fail('invalid_rtx_triangle_surface', 'triangleSurface must contain one albedo/roughness vec4 per triangle.');
  }
  for (let offset = 0; offset < surface.length; offset += 4) {
    if (!Number.isFinite(surface[offset]) || surface[offset] < 0
        || !Number.isFinite(surface[offset + 1]) || surface[offset + 1] < 0
        || !Number.isFinite(surface[offset + 2]) || surface[offset + 2] < 0
        || !Number.isFinite(surface[offset + 3]) || surface[offset + 3] < 0 || surface[offset + 3] > 1) {
      fail('invalid_rtx_triangle_surface', 'triangleSurface RGB must be finite/non-negative and roughness must be in [0, 1].');
    }
  }
  if (!(lights instanceof Float32Array) || (lights.length % 16) !== 0
      || lights.length > RTX_SCENE_LIMITS.maxPointSpotLights * 16
      || lights.some(value => !Number.isFinite(value))) {
    fail('invalid_rtx_lights', 'lights must contain zero to eight finite packed 4xvec4 records.');
  }
  for (let offset = 0; offset < lights.length; offset += 16) {
    const range = lights[offset + 3];
    const direction = lights.subarray(offset + 4, offset + 7);
    const outerCos = lights[offset + 7];
    const intensity = lights[offset + 11];
    const innerCos = lights[offset + 12];
    const type = lights[offset + 13];
    const decay = lights[offset + 14];
    if (range < 0 || outerCos < -1 || outerCos > 1
        || lights[offset + 8] < 0 || lights[offset + 9] < 0 || lights[offset + 10] < 0
        || intensity < 0 || innerCos < -1 || innerCos > 1
        || !Number.isInteger(type) || ![RTX_LIGHT_TYPES.point, RTX_LIGHT_TYPES.spot].includes(type)
        || decay < 0 || (type === RTX_LIGHT_TYPES.spot && (Math.hypot(...direction) <= 1e-6 || innerCos < outerCos))) {
      fail('invalid_rtx_lights', 'Packed lights do not satisfy the native point/spot record contract.', { lightIndex: offset / 16 });
    }
  }
  return Object.freeze({ vertexCount, triangleCount, lightCount: lights.length / 16 });
}

export function collectRtxScene(root, options = {}) {
  if (!root || typeof root !== 'object') fail('invalid_rtx_root', 'RTX collector requires a compiled scene root object.');
  const limits = normalizeOptions(options);
  const context = {
    limits,
    diagnostics: [],
    diagnosticsTruncated: 0,
    skipCounts: new Map(),
    skipped: 0,
    objectsVisited: 0,
    meshesSeen: 0,
    meshesIncluded: 0,
    instancesIncluded: 0,
    lightsSeen: 0,
    vertexCount: 0,
    triangleCount: 0,
    positions: [],
    indices: [],
    radiance: [],
    surface: [],
    lights: [],
    lightDescriptors: [],
    directionalLight: null,
  };
  const stack = [{ object: root, visible: true, ignored: false }];
  const visited = new Set();
  while (stack.length > 0) {
    const entry = stack.pop();
    const object = entry.object;
    if (!object || typeof object !== 'object') continue;
    if (visited.has(object)) {
      addDiagnostic(context, 'rtx_scene_cycle', object, 'Compiled scene cycle was skipped.');
      continue;
    }
    if (context.objectsVisited >= limits.maxObjects) {
      addDiagnostic(context, 'rtx_object_budget_exceeded', object, `Compiled scene traversal stopped at ${limits.maxObjects} objects.`);
      break;
    }
    visited.add(object);
    context.objectsVisited += 1;
    const visible = entry.visible && object.visible !== false;
    const ignored = entry.ignored || object.rtxIgnore === true || object.userData?.rtxIgnore === true;
    if (!visible) {
      if (isMesh(object) || object.isLight === true) addDiagnostic(context, 'rtx_hidden', object, 'Hidden object subtree was excluded from RTX.');
      continue;
    }
    if (ignored) {
      addDiagnostic(context, 'rtx_ignored', object, 'Object subtree is marked userData.rtxIgnore.');
      continue;
    }
    if (isMesh(object)) appendMesh(object, context);
    else if (isSupportedLight(object)) appendLight(object, context);
    else if (object.isLight === true) {
      addDiagnostic(context, 'rtx_unsupported_light', object, 'Only directional, point, and spot lights have native RTX descriptors.');
    }
    const children = Array.isArray(object.children) ? object.children : [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ object: children[index], visible, ignored });
    }
  }
  if (context.diagnosticsTruncated > 0) {
    context.diagnostics.push({
      severity: 'warning',
      code: 'rtx_diagnostics_truncated',
      objectId: objectId(root, 0),
      message: `${context.diagnosticsTruncated} additional RTX diagnostics were omitted.`,
    });
  }
  const payload = typedPayload(context);
  const registrable = payload.indices.length > 0;
  if (registrable) validateRtxScenePayload(payload);
  else context.diagnostics.push({
    severity: 'warning',
    code: 'rtx_scene_empty',
    objectId: objectId(root, 0),
    message: 'No eligible opaque triangles were collected; registerStaticScene must not be called.',
  });
  const skipCounts = Object.fromEntries([...context.skipCounts.entries()].sort(([left], [right]) => left.localeCompare(right)));
  return Object.freeze({
    ...payload,
    directionalLight: context.directionalLight,
    lightDescriptors: Object.freeze([...context.lightDescriptors]),
    registrable,
    diagnostics: Object.freeze(context.diagnostics.map(item => Object.freeze(item))),
    stats: Object.freeze({
      objectsVisited: context.objectsVisited,
      meshesSeen: context.meshesSeen,
      meshesIncluded: context.meshesIncluded,
      instancesIncluded: context.instancesIncluded,
      lightsSeen: context.lightsSeen,
      vertexCount: payload.positions.length / 3,
      triangleCount: payload.indices.length / 3,
      pointSpotLightCount: payload.lights.length / 16,
      directionalLightCount: context.directionalLight ? 1 : 0,
      skipped: context.skipped,
      skipCounts: Object.freeze(skipCounts),
    }),
  });
}

export function rtxRegistrationPayload(collection) {
  validateRtxScenePayload(collection);
  return Object.freeze({
    positions: collection.positions,
    indices: collection.indices,
    triangleRadiance: collection.triangleRadiance,
    triangleSurface: collection.triangleSurface,
    lights: collection.lights,
  });
}
