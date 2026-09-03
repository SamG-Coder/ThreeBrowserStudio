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
