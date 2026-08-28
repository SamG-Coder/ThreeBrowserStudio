import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RTX_LIGHT_TYPES,
  RtxSceneValidationError,
  collectRtxScene,
  rtxRegistrationPayload,
  validateRtxScenePayload,
} from '../src/runtime/rtx-scene-collector.mjs';

const identity = () => [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

function translation(x, y, z) {
  const values = identity();
  values[12] = x;
  values[13] = y;
  values[14] = z;
  return values;
}

function group(name, children = [], options = {}) {
  return {
    name,
    visible: options.visible ?? true,
    userData: options.userData ?? {},
    matrixWorld: { elements: options.matrix ?? identity() },
    children,
  };
}

function geometry({
  positions = [0, 0, 0, 1, 0, 0, 0, 1, 0],
  indices = [0, 1, 2],
  groups = [],
  drawRange,
} = {}) {
  return {
    attributes: {
      position: {
        array: new Float32Array(positions),
        itemSize: 3,
        count: positions.length / 3,
      },
    },
    index: indices === null ? null : { array: new Uint16Array(indices), count: indices.length },
    groups,
    drawRange,
    userData: {},
  };
}

function material(overrides = {}) {
  return {
    color: [0.65, 0.65, 0.65],
    emissive: [0, 0, 0],
    emissiveIntensity: 1,
    roughness: 0.5,
    opacity: 1,
    transparent: false,
    transmission: 0,
    visible: true,
    userData: {},
    ...overrides,
  };
}

function mesh(name, overrides = {}) {
  return {
    name,
    isMesh: true,
    visible: true,
    userData: {},
    children: [],
    geometry: geometry(),
    material: material(),
    matrixWorld: { elements: identity() },
    ...overrides,
  };
}

function target(x, y, z) {
  return group('target', [], { matrix: translation(x, y, z) });
}

const rounded = values => [...values].map(value => Math.round(value * 1e6) / 1e6);

test('collector emits native typed world triangles with per-triangle material records without mutation', () => {
  const subject = mesh('subject', {
    matrixWorld: { elements: translation(10, 2, -3) },
    material: material({
      color: [0.2, 0.3, 0.4],
      roughness: 0.25,
      emissive: [0.1, 0.2, 0.3],
      emissiveIntensity: 4,
    }),
  });
  const beforePositions = [...subject.geometry.attributes.position.array];
  const beforeMatrix = [...subject.matrixWorld.elements];

  const collected = collectRtxScene(group('root', [subject]));

  assert.equal(collected.registrable, true);
  assert.ok(collected.positions instanceof Float32Array);
  assert.ok(collected.indices instanceof Uint32Array);
  assert.ok(collected.triangleRadiance instanceof Float32Array);
  assert.ok(collected.triangleSurface instanceof Float32Array);
  assert.deepEqual([...collected.positions], [10, 2, -3, 11, 2, -3, 10, 3, -3]);
  assert.deepEqual([...collected.indices], [0, 1, 2]);
  assert.deepEqual(rounded(collected.triangleRadiance), [0.4, 0.8, 1.2, 0]);
  assert.deepEqual(rounded(collected.triangleSurface), [0.2, 0.3, 0.4, 0.25]);
  assert.deepEqual(validateRtxScenePayload(collected), { vertexCount: 3, triangleCount: 1, lightCount: 0 });
  assert.deepEqual(Object.keys(rtxRegistrationPayload(collected)), [
    'positions', 'indices', 'triangleRadiance', 'triangleSurface', 'lights',
  ]);
  assert.deepEqual([...subject.geometry.attributes.position.array], beforePositions);
  assert.deepEqual(subject.matrixWorld.elements, beforeMatrix);
});

test('collector flattens InstancedMesh local matrices after the mesh world transform', () => {
  const instanceArray = new Float32Array([
    ...identity(),
    ...translation(0, 2, 0),
  ]);
  const subject = mesh('instances', {
    isInstancedMesh: true,
    count: 2,
    instanceMatrix: { array: instanceArray },
    matrixWorld: { elements: translation(1, 0, 0) },
  });

  const collected = collectRtxScene(group('root', [subject]));
  assert.equal(collected.stats.instancesIncluded, 2);
  assert.deepEqual([...collected.positions], [
    1, 0, 0, 2, 0, 0, 1, 1, 0,
    1, 2, 0, 2, 2, 0, 1, 3, 0,
  ]);
  assert.deepEqual([...collected.indices], [0, 1, 2, 3, 4, 5]);
  assert.deepEqual([...instanceArray], [...identity(), ...translation(0, 2, 0)]);
});

test('collector excludes hidden, ignored, transparent, transmissive, and alpha-cutout geometry with explicit reasons', () => {
  const valid = mesh('valid');
  const ignoredParent = group('ignored-parent', [mesh('ignored-child')], { userData: { rtxIgnore: true } });
  const root = group('root', [
    valid,
    mesh('hidden', { visible: false }),
    ignoredParent,
    mesh('transparent', { material: material({ transparent: true }) }),
    mesh('transmissive', { material: material({ transmission: 0.5 }) }),
    mesh('alpha-cutout', { material: material({ alphaTest: 0.4 }) }),
  ]);

  const collected = collectRtxScene(root);
  const codes = new Set(collected.diagnostics.map(item => item.code));
  assert.equal(collected.stats.meshesIncluded, 1);
  assert.equal(codes.has('rtx_hidden'), true);
  assert.equal(codes.has('rtx_ignored'), true);
  assert.equal(codes.has('rtx_transparent_material'), true);
  assert.equal(codes.has('rtx_transmissive_material'), true);
  assert.equal(codes.has('rtx_alpha_cutout_unsupported'), true);
  assert.equal(collected.diagnostics.some(item => item.objectId === 'ignored-child'), false);
});

test('multi-material geometry keeps only eligible opaque triangle groups', () => {
  const subject = mesh('multi', {
    geometry: geometry({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
      indices: [0, 1, 2, 2, 1, 3],
      groups: [
        { start: 0, count: 3, materialIndex: 0 },
        { start: 3, count: 3, materialIndex: 1 },
      ],
    }),
    material: [material({ color: [1, 0, 0] }), material({ transparent: true })],
  });

  const collected = collectRtxScene(group('root', [subject]));
  assert.equal(collected.stats.triangleCount, 1);
  assert.deepEqual([...collected.indices], [0, 1, 2]);
  assert.deepEqual(rounded(collected.triangleSurface), [1, 0, 0, 0.5]);
  assert.equal(collected.diagnostics.some(item => item.code === 'rtx_transparent_material'), true);
});

test('collector emits one directional frame descriptor and exact packed point/spot records', () => {
  const directional = {
    ...group('sun', [], { matrix: translation(0, 10, 0) }),
    isLight: true,
    isDirectionalLight: true,
    color: [1, 0.9, 0.8],
    intensity: 2,
    target: target(0, 0, 0),
  };
  const point = {
    ...group('point', [], { matrix: translation(1, 2, 3) }),
    isLight: true,
    isPointLight: true,
    color: [0.5, 0.25, 0.1],
    intensity: 4,
    distance: 50,
    decay: 2,
  };
  const spot = {
    ...group('spot', [], { matrix: translation(0, 5, 0) }),
    isLight: true,
    isSpotLight: true,
    color: [0.2, 0.4, 0.6],
    intensity: 3,
    distance: 20,
    decay: 1,
    angle: Math.PI / 3,
    penumbra: 0.5,
    target: target(0, 0, 0),
  };

  const collected = collectRtxScene(group('root', [mesh('subject'), directional, point, spot]));
  assert.deepEqual([...collected.directionalLight.directionalLightDirection], [0, 1, 0]);
  assert.equal(collected.directionalLight.directionalLightIntensity, 2);
  assert.equal(collected.lightDescriptors.length, 2);
  assert.equal(collected.lightDescriptors[0].type, RTX_LIGHT_TYPES.point);
  assert.equal(collected.lightDescriptors[1].type, RTX_LIGHT_TYPES.spot);
  assert.deepEqual(rounded(collected.lights.slice(0, 16)), [
    1, 2, 3, 50,
    0, 0, 0, -1,
    0.5, 0.25, 0.1, 4,
    1, 0, 2, 0,
  ]);
  const spotRecord = rounded(collected.lights.slice(16, 32));
  assert.deepEqual(spotRecord.slice(0, 7), [0, 5, 0, 20, 0, -1, 0]);
  assert.ok(Math.abs(spotRecord[7] - Math.cos(Math.PI / 3)) < 1e-6);
  assert.deepEqual(spotRecord.slice(8, 12), [0.2, 0.4, 0.6, 3]);
  assert.ok(Math.abs(spotRecord[12] - Math.cos(Math.PI / 6)) < 1e-6);
  assert.deepEqual(spotRecord.slice(13), [1, 1, 0]);
});

test('collector applies deterministic triangle, instance, and static-light caps', () => {
  const instances = mesh('instances', {
    isInstancedMesh: true,
    count: 3,
    instanceMatrix: { array: new Float32Array([...identity(), ...translation(2, 0, 0), ...translation(4, 0, 0)]) },
  });
  const point = index => ({
    ...group(`point-${index}`, [], { matrix: translation(index, 2, 0) }),
    isLight: true,
    isPointLight: true,
    color: [1, 1, 1],
    intensity: 1,
  });
  const collected = collectRtxScene(group('root', [instances, point(0), point(1)]), {
    maxTriangles: 2,
    maxVertices: 6,
    maxInstancesPerMesh: 3,
    maxPointSpotLights: 1,
  });
  assert.equal(collected.stats.triangleCount, 2);
  assert.equal(collected.stats.instancesIncluded, 2);
  assert.equal(collected.stats.pointSpotLightCount, 1);
  assert.equal(collected.diagnostics.some(item => item.code === 'rtx_triangle_budget_exceeded'), true);
  assert.equal(collected.diagnostics.some(item => item.code === 'rtx_light_budget_exceeded'), true);
});

test('empty and malformed scenes remain truthful and payload validation is strict', () => {
  const empty = collectRtxScene(group('root'));
  assert.equal(empty.registrable, false);
  assert.ok(empty.positions instanceof Float32Array);
  assert.equal(empty.diagnostics.at(-1).code, 'rtx_scene_empty');
  assert.throws(() => rtxRegistrationPayload(empty), error => (
    error instanceof RtxSceneValidationError && error.code === 'invalid_rtx_positions'
  ));

  const invalid = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 9]),
    triangleRadiance: new Float32Array(4),
    triangleSurface: new Float32Array([1, 1, 1, 0.5]),
    lights: new Float32Array(),
  };
  assert.throws(() => validateRtxScenePayload(invalid), error => error.code === 'invalid_rtx_indices');
  assert.throws(() => collectRtxScene(group('root'), { typo: 1 }), error => error.code === 'invalid_rtx_collector_option');
});
