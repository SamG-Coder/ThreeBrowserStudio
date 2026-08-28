// Adaptation attribution: “Modeling the Watering Can” by Beau Gerbrands,
// copyright Blender Foundation, CC BY 4.0. Re-expressed as independently
// written procedural ThreeBrowser geometry with changed topology and values.
export const BLENDER_MODELING_REFERENCE_SOURCE =
  'https://studio.blender.org/training/blender-fundamentals-45-lts/blender_4-5_lts_modeling-the-watering-can/';

const transform = (position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) => ({
  position, rotation, scale,
});

const resource = (resourceType, value) => ({
  op: 'resource.create',
  resourceType,
  resource: value,
});

const entity = value => ({
  op: 'entity.create',
  sceneId: 'scene/main',
  entity: value,
});

/**
 * A dedicated one-shot recreation of the Blender Fundamentals watering-can
 * modeling endpoint. It deliberately excludes the unrelated lighting and
 * bouncing-ball lessons so the captured silhouette can be compared directly.
 */
export function buildBlenderModelingReferenceOperations() {
  const geometries = [
    resource('geometries', {
      id: 'geometry/modeling-reference/floor', kind: 'geometry', name: 'Viewport Floor',
      recipe: { kind: 'plane', width: 12, height: 8, widthSegments: 1, heightSegments: 1 },
    }),
    resource('geometries', {
      id: 'geometry/modeling-reference/body', kind: 'geometry', name: 'Tapered Watering Can Body',
      recipe: {
        kind: 'lathe', segments: 128,
        points: [
          [0, 0.06], [0.58, 0.06], [0.72, 0.08], [0.8, 0.15], [0.84, 0.24],
          [0.8, 0.32], [0.72, 0.38], [0.65, 0.42], [0.58, 1.87], [0.6, 1.96],
          [0.66, 2.02], [0.67, 2.1], [0.64, 2.16], [0.59, 2.2], [0.58, 2.3],
          [0.53, 2.42], [0.43, 2.53], [0.3, 2.62], [0.15, 2.68], [0, 2.7],
        ],
      },
    }),
    resource('geometries', {
      id: 'geometry/modeling-reference/handle', kind: 'geometry', name: 'Oversized Rear Handle',
      recipe: {
        kind: 'tube', radius: 0.085, radialSegments: 12, tubularSegments: 192,
        curveType: 'catmullrom', tension: 0.42,
        points: [
          [0.2, 0.37, -0.16], [1.05, 0.36, -0.16], [1.95, 0.4, -0.16],
          [2.7, 0.7, -0.16], [3.2, 1.25, -0.16], [3.45, 2, -0.16],
          [3.48, 2.8, -0.16], [3.2, 3.58, -0.16], [2.65, 4.24, -0.16],
          [1.9, 4.68, -0.16], [1.05, 4.8, -0.16], [0.25, 4.55, -0.16],
          [-0.35, 3.98, -0.16], [-0.55, 3.25, -0.16], [-0.52, 2.4, -0.16],
          [-0.48, 2.05, -0.16],
        ],
      },
    }),
    resource('geometries', {
      id: 'geometry/modeling-reference/spout', kind: 'geometry', name: 'Thin Rising Spout',
      recipe: {
        kind: 'tube', radius: 0.085, radialSegments: 12, tubularSegments: 112,
        curveType: 'catmullrom', tension: 0.42,
        points: [
          [-0.85, 0.38, -0.12], [-1.25, 0.38, -0.12], [-1.68, 0.5, -0.12],
          [-1.94, 0.78, -0.12], [-2.05, 1.2, -0.12], [-2.05, 1.7, -0.12],
          [-2.18, 2.1, -0.12], [-2.48, 2.43, -0.12], [-2.88, 2.57, -0.12],
          [-3.18, 2.59, -0.12],
        ],
      },
    }),
    resource('geometries', {
      id: 'geometry/modeling-reference/ring', kind: 'geometry', name: 'Body Edge Ring',
      recipe: { kind: 'torus', radius: 0.62, tube: 0.035, radialSegments: 12, tubularSegments: 96 },
    }),
  ];

  const materials = [
    resource('materials', {
      id: 'material/modeling-reference/clay', kind: 'physical', name: 'Blender Solid View Clay',
      baseColor: [0.46, 0.41, 0.35], metalness: 0, roughness: 0.72,
      clearcoat: 0.05, clearcoatRoughness: 0.7,
    }),
    resource('materials', {
      id: 'material/modeling-reference/floor', kind: 'standard', name: 'Viewport Ground',
      baseColor: [0.042, 0.042, 0.042], metalness: 0, roughness: 1, side: 'double',
    }),
  ];

  const mesh = geometryId => ({
    geometryId,
    materialIds: ['material/modeling-reference/clay'],
    castShadow: true,
    receiveShadow: true,
  });

  const entities = [
    entity({
      id: 'entity/modeling-reference/stage', kind: 'group', name: 'Blender Modeling Reference',
      tags: ['tutorial', 'comparison'],
    }),
    entity({
      id: 'entity/modeling-reference/floor', kind: 'mesh', name: 'Viewport Floor',
      parentId: 'entity/modeling-reference/stage',
      transform: transform([0.2, -0.01, 0], [-Math.PI / 2, 0, 0]),
      components: {
        mesh: {
          geometryId: 'geometry/modeling-reference/floor',
          materialIds: ['material/modeling-reference/floor'],
          castShadow: false,
          receiveShadow: true,
        },
      },
    }),
    entity({
      id: 'entity/modeling-reference/can', kind: 'group', name: 'GEO-watering_can',
      parentId: 'entity/modeling-reference/stage', tags: ['hero', 'tutorial'],
    }),
    entity({
      id: 'entity/modeling-reference/handle', kind: 'mesh', name: 'Rear Handle',
      parentId: 'entity/modeling-reference/can',
      components: { mesh: mesh('geometry/modeling-reference/handle') },
    }),
    entity({
      id: 'entity/modeling-reference/spout', kind: 'mesh', name: 'Spout',
      parentId: 'entity/modeling-reference/can',
      components: { mesh: mesh('geometry/modeling-reference/spout') },
    }),
    entity({
      id: 'entity/modeling-reference/body', kind: 'mesh', name: 'Watering Can Body',
      parentId: 'entity/modeling-reference/can',
      transform: transform([-0.35, 0, 0.08]),
      components: { mesh: mesh('geometry/modeling-reference/body') },
    }),
    entity({
      id: 'entity/modeling-reference/shoulder-ring', kind: 'mesh', name: 'Shoulder Ring',
      parentId: 'entity/modeling-reference/can',
      transform: transform([-0.35, 2.1, 0.09], [Math.PI / 2, 0, 0]),
      components: { mesh: mesh('geometry/modeling-reference/ring') },
    }),
    entity({
      id: 'entity/modeling-reference/base-ring', kind: 'mesh', name: 'Base Ring',
      parentId: 'entity/modeling-reference/can',
      transform: transform([-0.35, 0.19, 0.09], [Math.PI / 2, 0, 0], [1.24, 1.24, 1.24]),
      components: { mesh: mesh('geometry/modeling-reference/ring') },
    }),
    entity({
      id: 'entity/modeling-reference/aim', kind: 'empty', name: 'Modeling Composition Target',
      transform: transform([0.15, 2.55, 0]),
    }),
    entity({
      id: 'entity/modeling-reference/key', kind: 'spotLight', name: 'Viewport Key',
      transform: transform([-4.8, 6.4, 5.4]),
      components: {
        light: {
          color: [1, 0.78, 0.58], intensity: 360, distance: 30, decay: 2,
          angle: 0.78, penumbra: 0.82, castShadow: true,
          shadowMapSize: 2048, shadowNormalBias: 0.02,
          targetId: 'entity/modeling-reference/aim',
        },
        constraints: [{
          id: 'constraint/modeling-reference/key-aim', type: 'lookAt',
          targetId: 'entity/modeling-reference/aim',
        }],
      },
    }),
    entity({
      id: 'entity/modeling-reference/fill', kind: 'hemisphereLight', name: 'Viewport Fill',
      transform: transform([0, 8, 0]),
      components: {
        light: {
          color: [0.5, 0.58, 0.7], groundColor: [0.12, 0.1, 0.08],
          intensity: 0.95, castShadow: false,
        },
      },
    }),
    entity({
      id: 'entity/modeling-reference/rim', kind: 'spotLight', name: 'Soft Cool Fill',
      transform: transform([5.2, 4.1, 5.8]),
      components: {
        light: {
          color: [0.38, 0.55, 1], intensity: 145, distance: 30, decay: 2,
          angle: 0.95, penumbra: 0.9, castShadow: false,
          targetId: 'entity/modeling-reference/aim',
        },
        constraints: [{
          id: 'constraint/modeling-reference/rim-aim', type: 'lookAt',
          targetId: 'entity/modeling-reference/aim',
        }],
      },
    }),
    entity({
      id: 'entity/modeling-reference/camera', kind: 'orthographicCamera', name: 'Modeling Match Camera',
      transform: transform([0.15, 2.55, 10]),
      components: {
        camera: { height: 6.2, near: 0.05, far: 50 },
        constraints: [{
          id: 'constraint/modeling-reference/camera-aim', type: 'lookAt',
          targetId: 'entity/modeling-reference/aim',
        }],
      },
    }),
  ];

  return [
    { op: 'scene.patch', sceneId: 'scene/main', patch: { name: 'Blender Modeling — Watering Can Match' } },
    {
      op: 'scene.settings.patch', sceneId: 'scene/main', patch: {
        background: { mode: 'color', color: [0.04, 0.04, 0.04], colorSpace: 'linear-srgb' },
      },
    },
    ...geometries,
    ...materials,
    ...entities,
    {
      op: 'scene.setActiveCamera', sceneId: 'scene/main',
      cameraId: 'entity/modeling-reference/camera',
    },
  ];
}
