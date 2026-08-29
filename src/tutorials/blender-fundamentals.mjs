// Adaptation attribution: Blender Fundamentals 4.5 LTS lessons by Beau
// Gerbrands, plus the Keyframes lesson by Rik Schutte; copyright Blender
// Foundation, CC BY 4.0. Re-expressed as independently written typed MCP
// operations with changed geometry, values, staging, IDs, and graph structure.
export const BLENDER_FUNDAMENTALS_SOURCES = Object.freeze([
  'https://studio.blender.org/training/blender-fundamentals-45-lts/',
  'https://studio.blender.org/training/blender-fundamentals-45-lts/blender_4-5_lts_modeling-the-watering-can/',
  'https://studio.blender.org/training/blender-fundamentals-45-lts/blender_4-5_lts_light-types/',
  'https://studio.blender.org/training/blender-fundamentals-45-lts/blender_4-5_lts_camera-settings/',
  'https://studio.blender.org/training/blender-fundamentals-45-lts/blender-5-2-keyframes/',
]);

const transform = (position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) => ({
  position, rotation, scale,
});

const resource = (resourceType, value) => ({
  op: 'resource.create',
  resourceType,
  resource: value,
});

const entity = (value) => ({
  op: 'entity.create',
  sceneId: 'scene/main',
  entity: value,
});

/**
 * An exact stable-ID translation of Blender Fundamentals' watering-can,
 * three-point-lighting, camera, and bouncing-ball lessons. UI context and Edit
 * Mode are intentionally lowered to explicit resources and atomic operations.
 */
export function buildBlenderFundamentalsOperations() {
  const geometry = [
    resource('geometries', {
      id: 'geometry/fundamentals/floor', kind: 'geometry', name: 'Photo Studio Floor',
      recipe: { kind: 'plane', width: 14, height: 11, widthSegments: 1, heightSegments: 1 },
    }),
    resource('geometries', {
      id: 'geometry/fundamentals/backdrop', kind: 'geometry', name: 'Photo Studio Backdrop',
      recipe: { kind: 'plane', width: 14, height: 8, widthSegments: 1, heightSegments: 1 },
    }),
    resource('geometries', {
      id: 'geometry/fundamentals/can-body', kind: 'geometry', name: 'Lathed Watering Can Body',
      recipe: {
        kind: 'lathe', segments: 64,
        points: [[0.12, -1.05], [0.72, -1.05], [0.94, -0.86], [1.03, -0.55], [1.03, 0.48], [0.93, 0.75], [0.76, 0.94], [0.7, 1.04], [0.14, 1.04]],
      },
    }),
    resource('geometries', {
      id: 'geometry/fundamentals/handle', kind: 'geometry', name: 'Curved Handle',
      recipe: {
        kind: 'tube', radius: 0.115, radialSegments: 12, tubularSegments: 96,
        points: [[-0.76, 0.55, 0.25], [-1.35, 1.12, 0.3], [-1.3, 2.32, 0.28], [-0.72, 3.08, 0.24], [0, 3.35, 0.22], [0.72, 3.08, 0.24], [1.3, 2.32, 0.28], [1.35, 1.12, 0.3], [0.76, 0.55, 0.25]],
      },
    }),
    resource('geometries', {
      id: 'geometry/fundamentals/spout', kind: 'geometry', name: 'Curved Spout',
      recipe: {
        kind: 'tube', radius: 0.24, radialSegments: 16, tubularSegments: 72,
        points: [[0.82, 1.0, 0], [1.35, 1.15, 0], [1.95, 1.55, 0], [2.58, 2.18, 0]],
      },
    }),
    resource('geometries', {
      id: 'geometry/fundamentals/rim', kind: 'geometry', name: 'Top Rim',
      recipe: { kind: 'torus', radius: 0.72, tube: 0.075, radialSegments: 16, tubularSegments: 64 },
    }),
    resource('geometries', {
      id: 'geometry/fundamentals/rose', kind: 'geometry', name: 'Spout Rose',
      recipe: { kind: 'cylinder', radiusTop: 0.48, radiusBottom: 0.34, height: 0.28, radialSegments: 48 },
    }),
    resource('geometries', {
      id: 'geometry/fundamentals/rivet', kind: 'geometry', name: 'Rivet',
      recipe: { kind: 'sphere', radius: 0.075, widthSegments: 20, heightSegments: 12 },
    }),
    resource('geometries', {
      id: 'geometry/fundamentals/badge-half', kind: 'geometry', name: 'Mirrored Badge Half',
      recipe: {
        kind: 'extrude', depth: 0.09, bevelEnabled: true, bevelSize: 0.035, bevelThickness: 0.035, bevelSegments: 3,
        points: [[0.02, -0.42], [0.43, -0.18], [0.34, 0.28], [0.06, 0.5]],
      },
    }),
    resource('geometries', {
      id: 'geometry/fundamentals/ball', kind: 'geometry', name: 'Animation Ball',
      recipe: { kind: 'sphere', radius: 0.42, widthSegments: 40, heightSegments: 24 },
    }),
    resource('geometries', {
      id: 'geometry/fundamentals/pedestal', kind: 'geometry', name: 'Ball Pedestal',
      recipe: { kind: 'cylinder', radiusTop: 0.82, radiusBottom: 0.94, height: 0.35, radialSegments: 48 },
    }),
  ];

  const materials = [
    resource('materials', {
      id: 'material/fundamentals/red-metal', kind: 'physical', name: 'MetalSubject',
      baseColor: [0.78, 0.055, 0.025], metalness: 0.55, roughness: 0.28, clearcoat: 0.35, clearcoatRoughness: 0.18,
    }),
    resource('materials', {
      id: 'material/fundamentals/brass', kind: 'physical', name: 'Warm Brass Details',
      baseColor: [0.9, 0.43, 0.07], metalness: 0.55, roughness: 0.3,
    }),
    resource('materials', {
      id: 'material/fundamentals/matte', kind: 'standard', name: 'MatteBackdrop',
      baseColor: [0.28, 0.34, 0.42], metalness: 0, roughness: 0.86, side: 'double',
    }),
    resource('materials', {
      id: 'material/fundamentals/dark', kind: 'standard', name: 'Dark Openings',
      baseColor: [0.015, 0.02, 0.025], metalness: 0.1, roughness: 0.38,
    }),
    resource('materials', {
      id: 'material/fundamentals/ball-blue', kind: 'physical', name: 'Animation Ball Blue',
      baseColor: [0.025, 0.28, 1], metalness: 0.05, roughness: 0.22, clearcoat: 0.42,
    }),
  ];

  const animation = resource('animations', {
    id: 'animation/fundamentals/ball-bounce', kind: 'animation', name: 'Ball Bounce Action',
    formatVersion: 1, enabled: true, autoplay: true, fps: 24,
    frameStart: 0, frameEnd: 48, loop: 'repeat', speed: 1,
    metadata: { tutorial: 'Blender Fundamentals 4.5 LTS — Keyframes' },
    tracks: [{
      targetId: 'entity/fundamentals/ball',
      property: 'transform.position',
      interpolation: 'bezier',
      keyframes: [
        { frame: 0, value: [-3.2, 0.68, 0] },
        { frame: 12, value: [-3.2, 3.35, 0] },
        { frame: 24, value: [-3.2, 0.68, 0] },
        { frame: 36, value: [-3.2, 3.35, 0] },
        { frame: 48, value: [-3.2, 0.68, 0] },
      ],
    }],
  });

  const objects = [
    entity({ id: 'entity/fundamentals/photo-studio', kind: 'group', name: 'Photo Studio', tags: ['collection', 'tutorial'] }),
    entity({
      id: 'entity/fundamentals/floor', kind: 'mesh', name: 'Platform', parentId: 'entity/fundamentals/photo-studio',
      transform: transform([0, 0, 0], [-Math.PI / 2, 0, 0]),
      components: { mesh: { geometryId: 'geometry/fundamentals/floor', materialIds: ['material/fundamentals/matte'], receiveShadow: true, castShadow: false } },
    }),
    entity({
      id: 'entity/fundamentals/backdrop', kind: 'mesh', name: 'Limbo Backdrop', parentId: 'entity/fundamentals/photo-studio',
      transform: transform([0, 4, -5.1]),
      components: {
        mesh: { geometryId: 'geometry/fundamentals/backdrop', materialIds: ['material/fundamentals/matte'], receiveShadow: true, castShadow: false },
        modifiers: [{
          id: 'modifier/fundamentals/backdrop-bevel',
          type: 'bakeBoundary',
          operatorType: 'BEVEL',
          parameters: { width: 0.2, segments: 12 },
          enabled: true,
        }],
      },
    }),
    entity({ id: 'entity/fundamentals/watering-can', kind: 'group', name: 'watering_can', tags: ['collection', 'hero', 'tutorial'] }),
    entity({
      id: 'entity/fundamentals/can-body', kind: 'mesh', name: 'GEO-watering_can', parentId: 'entity/fundamentals/watering-can',
      transform: transform([-0.2, 1.12, 0]),
      components: { mesh: { geometryId: 'geometry/fundamentals/can-body', materialIds: ['material/fundamentals/red-metal'], castShadow: true, receiveShadow: true } },
    }),
    entity({
      id: 'entity/fundamentals/handle', kind: 'mesh', name: 'Handle Curve', parentId: 'entity/fundamentals/watering-can',
      transform: transform([-0.2, 0, 0.18]),
      components: { mesh: { geometryId: 'geometry/fundamentals/handle', materialIds: ['material/fundamentals/red-metal'], castShadow: true, receiveShadow: true } },
    }),
    entity({
      id: 'entity/fundamentals/spout', kind: 'mesh', name: 'Spout Curve', parentId: 'entity/fundamentals/watering-can',
      transform: transform([-0.2, 0, 0]),
      components: { mesh: { geometryId: 'geometry/fundamentals/spout', materialIds: ['material/fundamentals/red-metal'], castShadow: true, receiveShadow: true } },
    }),
    entity({
      id: 'entity/fundamentals/rim', kind: 'mesh', name: 'Opening Rim', parentId: 'entity/fundamentals/watering-can',
      transform: transform([-0.2, 2.18, 0], [Math.PI / 2, 0, 0]),
      components: { mesh: { geometryId: 'geometry/fundamentals/rim', materialIds: ['material/fundamentals/brass'], castShadow: true, receiveShadow: true } },
    }),
    entity({
      id: 'entity/fundamentals/rose', kind: 'mesh', name: 'Spout Rose', parentId: 'entity/fundamentals/watering-can',
      transform: transform([2.5, 2.18, 0], [0, 0, -0.76]),
      components: { mesh: { geometryId: 'geometry/fundamentals/rose', materialIds: ['material/fundamentals/brass'], castShadow: true, receiveShadow: true } },
    }),
    entity({
      id: 'entity/fundamentals/rivets', kind: 'mesh', name: 'Array Rivets', parentId: 'entity/fundamentals/watering-can',
      transform: transform([-0.98, 0.72, 0.72]),
      components: {
        mesh: { geometryId: 'geometry/fundamentals/rivet', materialIds: ['material/fundamentals/brass'], castShadow: true, receiveShadow: true },
        modifiers: [{ id: 'modifier/fundamentals/rivet-array', type: 'array', count: 2, offset: [0, 1.3, 0], enabled: true }],
      },
    }),
    entity({
      id: 'entity/fundamentals/badge', kind: 'mesh', name: 'Mirror Badge', parentId: 'entity/fundamentals/watering-can',
      transform: transform([-0.2, 1.15, 1.02]),
      components: {
        mesh: { geometryId: 'geometry/fundamentals/badge-half', materialIds: ['material/fundamentals/brass'], castShadow: true, receiveShadow: true },
        modifiers: [{ id: 'modifier/fundamentals/badge-mirror', type: 'mirror', axis: 'x', enabled: true }],
      },
    }),
    entity({
      id: 'entity/fundamentals/pedestal', kind: 'mesh', name: 'Ball Pedestal', parentId: 'entity/fundamentals/photo-studio',
      transform: transform([-3.2, 0.18, 0]),
      components: { mesh: { geometryId: 'geometry/fundamentals/pedestal', materialIds: ['material/fundamentals/dark'], castShadow: true, receiveShadow: true } },
    }),
    entity({
      id: 'entity/fundamentals/ball', kind: 'mesh', name: 'Ball', parentId: 'entity/fundamentals/photo-studio',
      transform: transform([-3.2, 0.68, 0]),
      components: {
        mesh: { geometryId: 'geometry/fundamentals/ball', materialIds: ['material/fundamentals/ball-blue'], castShadow: true, receiveShadow: true },
        animation: { actionId: 'animation/fundamentals/ball-bounce' },
      },
    }),
    entity({ id: 'entity/fundamentals/aim', kind: 'empty', name: 'Composition Target', transform: transform([-0.25, 1.45, 0]) }),
    entity({
      id: 'entity/fundamentals/key', kind: 'spotLight', name: 'Key Light', transform: transform([-4.8, 6.4, 5.4]),
      components: {
        light: { color: [1, 0.53, 0.32], intensity: 480, distance: 30, decay: 2, angle: 0.72, penumbra: 0.62, castShadow: true, shadowMapSize: 2048, targetId: 'entity/fundamentals/aim' },
        constraints: [{ id: 'constraint/fundamentals/key-aim', type: 'lookAt', targetId: 'entity/fundamentals/aim' }],
      },
    }),
    entity({
      id: 'entity/fundamentals/fill', kind: 'spotLight', name: 'Fill Light', transform: transform([5.2, 4.1, 5.8]),
      components: {
        light: { color: [0.28, 0.5, 1], intensity: 240, distance: 30, decay: 2, angle: 0.88, penumbra: 0.78, castShadow: false, targetId: 'entity/fundamentals/aim' },
        constraints: [{ id: 'constraint/fundamentals/fill-aim', type: 'lookAt', targetId: 'entity/fundamentals/aim' }],
      },
    }),
    entity({
      id: 'entity/fundamentals/rim-light', kind: 'spotLight', name: 'Rim Light', transform: transform([0.2, 6.8, -4.2]),
      components: {
        light: { color: [0.55, 0.7, 1], intensity: 360, distance: 26, decay: 2, angle: 0.66, penumbra: 0.58, castShadow: true, shadowMapSize: 1024, targetId: 'entity/fundamentals/aim' },
        constraints: [{ id: 'constraint/fundamentals/rim-aim', type: 'lookAt', targetId: 'entity/fundamentals/aim' }],
      },
    }),
    entity({
      id: 'entity/fundamentals/ambient', kind: 'hemisphereLight', name: 'World Fill',
      transform: transform([0, 10, 0]),
      components: { light: { color: [0.55, 0.68, 1], groundColor: [0.24, 0.12, 0.08], intensity: 0.65, castShadow: false } },
    }),
    entity({
      id: 'entity/fundamentals/camera', kind: 'perspectiveCamera', name: 'ShotCamera', transform: transform([8.4, 5.5, 10.8]),
      components: {
        camera: { focalLength: 52, fov: 43, near: 0.05, far: 160 },
        constraints: [{ id: 'constraint/fundamentals/camera-aim', type: 'lookAt', targetId: 'entity/fundamentals/aim' }],
      },
    }),
  ];

  return [
    { op: 'scene.patch', sceneId: 'scene/main', patch: { name: 'Blender Fundamentals — Watering Can' } },
    {
      op: 'scene.settings.patch', sceneId: 'scene/main', patch: {
        background: { mode: 'color', color: [0.035, 0.05, 0.09], colorSpace: 'linear-srgb' },
        fog: { mode: 'linear', color: [0.035, 0.05, 0.09], near: 20, far: 70 },
        timeline: { frameStart: 1, frameEnd: 48, currentFrame: 1, framesPerSecond: 24 },
      },
    },
    ...geometry,
    ...materials,
    animation,
    ...objects,
    { op: 'scene.setActiveCamera', sceneId: 'scene/main', cameraId: 'entity/fundamentals/camera' },
  ];
}

export function summarizeBlenderFundamentalsOperations(operations = buildBlenderFundamentalsOperations()) {
  return Object.freeze({
    operations: operations.length,
    resources: operations.filter(operation => operation.op === 'resource.create').length,
    entities: operations.filter(operation => operation.op === 'entity.create').length,
    modifiers: operations
      .filter(operation => operation.op === 'entity.create')
      .flatMap(operation => operation.entity.components?.modifiers ?? []).length,
    constraints: operations
      .filter(operation => operation.op === 'entity.create')
      .flatMap(operation => operation.entity.components?.constraints ?? []).length,
    officialSources: BLENDER_FUNDAMENTALS_SOURCES.length,
  });
}
