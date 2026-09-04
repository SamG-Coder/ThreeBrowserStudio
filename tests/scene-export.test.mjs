import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProjectDocument,
  eulerXyzToQuaternion,
  exportSceneInterchange,
  readGlbJson,
} from '../src/core/index.mjs';

function triangleProject() {
  return createProjectDocument({
    projectId: 'project/export',
    name: 'Export Fixture',
    scenes: [{
      id: 'scene/main',
      name: 'Main Scene',
      rootEntityIds: ['entity/world', 'entity/camera', 'entity/sun'],
      entities: {
        'entity/world': {
          id: 'entity/world',
          kind: 'group',
          name: 'World',
          children: ['entity/body', 'entity/wheel', 'entity/orphan-box'],
        },
        'entity/body': {
          id: 'entity/body',
          kind: 'mesh',
          name: 'Body',
          parentId: 'entity/world',
          transform: { position: [1, 0, 0], rotation: [0, 0.5, 0], scale: [1, 1, 1] },
          components: {
            mesh: { geometryId: 'geometry/tri', materialId: 'material/paint' },
          },
        },
        'entity/wheel': {
          id: 'entity/wheel',
          kind: 'mesh',
          name: 'Wheel',
          parentId: 'entity/world',
          transform: { position: [0, -0.2, 0] },
          components: {
            mesh: { geometryId: 'geometry/tri', materialId: 'material/paint' },
          },
        },
        'entity/camera': {
          id: 'entity/camera',
          kind: 'perspectiveCamera',
          name: 'Shot',
          transform: { position: [2, 1, 3] },
          components: { camera: { fov: 43, near: 0.05, far: 80 } },
        },
        'entity/sun': {
          id: 'entity/sun',
          kind: 'directionalLight',
          name: 'Sun',
          components: { light: { color: [1, 0.9, 0.7], intensity: 3.2 } },
        },
        'entity/orphan-box': {
          id: 'entity/orphan-box',
          kind: 'mesh',
          name: 'Box',
          parentId: 'entity/world',
          components: { mesh: { geometryId: 'geometry/box', materialId: 'material/paint' } },
        },
      },
    }],
    resources: {
      geometries: {
        'geometry/tri': {
          id: 'geometry/tri',
          kind: 'geometry',
          recipe: {
            kind: 'indexedMesh',
            positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            indices: [0, 1, 2],
          },
        },
        'geometry/box': {
          id: 'geometry/box',
          kind: 'geometry',
          recipe: { kind: 'box', width: 1, height: 1, depth: 1 },
        },
      },
      materials: {
        'material/paint': {
          id: 'material/paint',
          kind: 'material',
          name: 'Paint',
          recipe: {
            kind: 'physical',
            baseColor: [0.8, 0.1, 0.12],
            roughness: 0.28,
            metalness: 0.15,
          },
        },
      },
    },
  });
}

test('euler XYZ identity is a unit quaternion', () => {
  const [x, y, z, w] = eulerXyzToQuaternion([0, 0, 0]);
  assert.equal(x, 0);
  assert.equal(y, 0);
  assert.equal(z, 0);
  assert.equal(w, 1);
});

test('euler XYZ export preserves a compound X/Z rotation', () => {
  const quaternion = eulerXyzToQuaternion([Math.PI / 2, 0, -Math.PI / 2]);
  const expected = [0.5, 0.5, -0.5, 0.5];
  quaternion.forEach((component, index) => {
    assert.ok(Math.abs(component - expected[index]) < 1e-12);
  });
});

test('scene export writes a GLB with hierarchy, PBR, camera, and light', () => {
  const document = triangleProject();
  const exported = exportSceneInterchange(document, { format: 'glb' });
  assert.equal(exported.format, 'glb');
  assert.equal(exported.mimeType, 'model/gltf-binary');
  assert.equal(exported.stats.meshes, 2);
  assert.equal(exported.stats.cameras, 1);
  assert.equal(exported.stats.lights, 1);
  assert.equal(exported.skipped.some(item => item.entityId === 'entity/orphan-box'), true);

  const json = readGlbJson(exported.bytes);
  assert.equal(json.asset.version, '2.0');
  assert.equal(json.extras.studioProjectId, 'project/export');
  const body = json.nodes.find(node => node.extras.studioEntityId === 'entity/body');
  assert.deepEqual(body.translation, [1, 0, 0]);
  assert.ok(body.rotation);
  const paint = json.materials.find(material => material.extras.studioMaterialId === 'material/paint');
  assert.deepEqual(paint.pbrMetallicRoughness.baseColorFactor.slice(0, 3), [0.8, 0.1, 0.12]);
  assert.equal(paint.pbrMetallicRoughness.roughnessFactor, 0.28);
  assert.equal(json.cameras[0].perspective.yfov, (43 * Math.PI) / 180);
  assert.equal(json.extensions.KHR_lights_punctual.lights[0].type, 'directional');
});

test('scene export preserves every material color format accepted by Studio', () => {
  const cases = [
    { value: 0x256b32, expected: [37 / 255, 107 / 255, 50 / 255] },
    { value: '#7a4e2c', expected: [122 / 255, 78 / 255, 44 / 255] },
    { value: 'rgb(20, 110, 45)', expected: [20 / 255, 110 / 255, 45 / 255] },
    { value: 'hsl(120, 50%, 40%)', expected: [0.2, 0.6, 0.2] },
  ];
  for (const { value, expected } of cases) {
    const document = triangleProject();
    document.resources.materials['material/paint'].recipe.baseColor = value;
    const json = readGlbJson(exportSceneInterchange(document, { format: 'glb' }).bytes);
    const paint = json.materials.find(material => material.extras.studioMaterialId === 'material/paint');
    const actual = paint.pbrMetallicRoughness.baseColorFactor.slice(0, 3);
    actual.forEach((component, index) => assert.ok(Math.abs(component - expected[index]) < 1e-9));
  }
});

test('entity subtree export omits siblings and scene roots outside the group', () => {
  const document = triangleProject();
  const exported = exportSceneInterchange(document, { entityId: 'entity/world', format: 'gltf' });
  assert.equal(exported.format, 'gltf');
  const ids = exported.json.nodes.map(node => node.extras.studioEntityId);
  assert.deepEqual(new Set(ids), new Set(['entity/world', 'entity/body', 'entity/wheel', 'entity/orphan-box']));
  assert.equal(exported.json.cameras, undefined);
  assert.equal(exported.json.extras.studioRootEntityId, 'entity/world');
  const parsed = JSON.parse(Buffer.from(exported.bytes).toString('utf8'));
  assert.match(parsed.buffers[0].uri, /^data:application\/octet-stream;base64,/);
});

function glbFloatAttribute(bytes, json, accessorId) {
  const buffer = Buffer.from(bytes);
  const accessor = json.accessors[accessorId];
  assert.equal(accessor.componentType, 5126);
  const view = json.bufferViews[accessor.bufferView];
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type];
  const start = 28 + buffer.readUInt32LE(12) + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return Array.from({ length: accessor.count * components }, (_, index) => buffer.readFloatLE(start + index * 4));
}

test('GLB exports editable shells and subdivision without opening UV/material seams', () => {
  const document = triangleProject();
  document.resources.geometries['geometry/tri'].recipe = {
    kind: 'editableMesh', positions: [-1,-1,0, 0,-1,0, 0,1,0, -1,1,0, 1,-1,0, 1,1,0],
    faceOffsets: [0,4,8], cornerVertexIndices: [0,1,2,3, 1,4,5,2],
    uvLayers: { paint: [0,0,1,0,1,1,0,1, 10,0,11,0,11,1,10,1] }, activeUvLayer: 'paint',
    colorLayers: { tint: [...Array.from({length:4}, () => [1,0,0,1]).flat(), ...Array.from({length:4}, () => [0,0,1,1]).flat()] },
    activeColorLayer: 'tint', faceMaterialIndices: [0,1],
  };
  document.resources.materials['material/lining'] = { id: 'material/lining', kind: 'material', recipe: { kind: 'physical', baseColor: [0,0,1] } };
  const body = document.scenes['scene/main'].entities['entity/body'];
  body.components.mesh = { geometryId: 'geometry/tri', materialIds: ['material/paint','material/lining'] };
  body.components.modifiers = [
    { id: 'modifier/shell', type: 'solidify', thickness: 0.2 },
    { id: 'modifier/subdivision', type: 'subdivision', scheme: 'simple', levels: 1 },
  ];
  const snapshot = structuredClone(document);
  for (const finalNormals of [false, true]) {
    const candidate = structuredClone(document);
    if (finalNormals) candidate.scenes['scene/main'].entities['entity/body'].components.modifiers.push({ id: 'modifier/normals', type: 'weightedNormal' });
    const exported = exportSceneInterchange(candidate, { entityId: 'entity/body', format: 'glb' });
    const json = readGlbJson(exported.bytes);
    const primitives = json.meshes[0].primitives;
    assert.equal(primitives.length, 2);
    assert.deepEqual(primitives.map(p => json.accessors[p.indices].count), [120,120], '80 triangles total, with no extra UV seam walls');
    assert.deepEqual(primitives.map(p => json.materials[p.material].extras.studioMaterialId), ['material/paint','material/lining']);
    const positions = glbFloatAttribute(exported.bytes, json, primitives[0].attributes.POSITION);
    assert.ok(positions.filter((_, i) => i % 3 === 2).every(z => Math.abs(z) <= 0.100001));
    assert.ok(positions.some((z, i) => i % 3 === 2 && z > 0.099));
    assert.ok(positions.some((z, i) => i % 3 === 2 && z < -0.099));
    const uvs = glbFloatAttribute(exported.bytes, json, primitives[0].attributes.TEXCOORD_0);
    assert.ok(uvs.includes(11), 'separate paint UV island survives export');
    const colors = glbFloatAttribute(exported.bytes, json, primitives[0].attributes.COLOR_0);
    assert.ok(colors.some((v, i) => i % 4 === 0 && v === 1));
    assert.ok(colors.some((v, i) => i % 4 === 2 && v === 1));
  }
  assert.deepEqual(document, snapshot);
});

test('indexed export propagates material provenance through topology changes', () => {
  const document = triangleProject();
  document.resources.geometries['geometry/tri'].recipe = {
    kind: 'indexedMesh', positions: [0,0,0,1,0,0,1,1,0,0,1,0], indices: [0,1,2,0,2,3], triangleMaterialIndices: [0,1],
  };
  document.resources.materials['material/lining'] = { id: 'material/lining', kind: 'material', recipe: { kind: 'physical', baseColor: [0,0,1] } };
  const body = document.scenes['scene/main'].entities['entity/body'];
  body.components.mesh = { geometryId: 'geometry/tri', materialIds: ['material/paint','material/lining'] };
  body.components.modifiers = [{ id: 'modifier/subdivision', type: 'subdivision', scheme: 'simple', levels: 1 }];
  const json = readGlbJson(exportSceneInterchange(document, { entityId: 'entity/body', format: 'glb' }).bytes);
  assert.deepEqual(json.meshes[0].primitives.map(p => json.accessors[p.indices].count), [12,12]);
});
