const ALL_OBJECT_KINDS = Object.freeze([
  'group', 'empty', 'gameObject', 'mesh', 'instancedMesh',
  'perspectiveCamera', 'orthographicCamera',
]);

const entry = (id, label, description, defaults, options = {}) => Object.freeze({
  id,
  label,
  description,
  defaults: Object.freeze(structuredClone(defaults)),
  compatibleKinds: Object.freeze([...(options.compatibleKinds ?? ALL_OBJECT_KINDS)]),
  runtime: options.runtime !== false,
  requires: Object.freeze([...(options.requires ?? [])]),
});

/** Browser-safe catalog shared by MCP, the component composer, and local AI. */
export const ENTITY_COMPONENT_CATALOG = Object.freeze([
  entry('rigidBody', 'Rigid Body', 'Adds bounded dynamic, kinematic, or static body motion.', {
    enabled: true,
    bodyType: 'dynamic',
    mass: 1,
    gravityScale: 1,
    linearDamping: 0.05,
    angularDamping: 0.05,
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    freezePosition: [false, false, false],
    freezeRotation: [false, false, false],
    alignToSurface: false,
    surfaceAlignSpeed: 8,
    maxSurfaceTilt: 0.785398,
  }),
  entry('collider', 'Collider', 'Adds bounded box collision and trigger events.', {
    enabled: true,
    shape: 'box',
    size: [1, 1, 1],
    radius: 0.5,
    slopeAxis: 'x',
    offset: [0, 0, 0],
    friction: 0.5,
    restitution: 0,
    isTrigger: false,
    layer: 0,
    mask: 1,
  }),
  entry('animation', 'Animation', 'Connects an object to authored Action playback.', {
    enabled: true,
  }),
  entry('audio', 'Audio', 'Connects an object to an authored audio resource.', {
    enabled: true,
    volume: 1,
    loop: false,
  }, { runtime: true, requires: ['audio-resource'], compatibleKinds: [...ALL_OBJECT_KINDS, 'audioSource'] }),
  entry('logic', 'Logic', 'Runs bounded GameMaker-style blueprint events and actions.', {
    enabled: true,
    graphIds: [],
  }, { requires: ['blueprint-graph'] }),
  entry('camera', 'Camera', 'Configures an authored perspective or orthographic camera.', {
    fov: 46,
    near: 0.05,
    far: 2000,
  }, { compatibleKinds: ['perspectiveCamera', 'orthographicCamera'] }),
]);

export const ENTITY_COMPONENT_IDS = Object.freeze(ENTITY_COMPONENT_CATALOG.map(item => item.id));

export function getEntityComponentDefinition(componentId) {
  return ENTITY_COMPONENT_CATALOG.find(item => item.id === componentId) ?? null;
}

export function queryEntityComponentCatalog({ entityKind, installed = [] } = {}) {
  const present = new Set(installed);
  return Object.freeze(ENTITY_COMPONENT_CATALOG.map(item => Object.freeze({
    ...item,
    defaults: structuredClone(item.defaults),
    compatible: !entityKind || item.compatibleKinds.includes(entityKind),
    installed: present.has(item.id),
  })));
}
