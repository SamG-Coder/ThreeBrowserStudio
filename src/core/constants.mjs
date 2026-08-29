export const PROTOCOL_VERSION = 'three-studio/1';
export const FORMAT_VERSION = 1;

export const MAX_OPERATIONS_PER_TRANSACTION = 128;
export const MAX_CONTROL_REQUEST_BYTES = 1024 * 1024;
export const MAX_INSPECT_RESPONSE_BYTES = 512 * 1024;
export const MAX_AUTHORED_ENTITIES = 20_000;

export const ENTITY_KINDS = Object.freeze([
  'scene',
  'group',
  'mesh',
  'instancedMesh',
  'perspectiveCamera',
  'orthographicCamera',
  'directionalLight',
  'pointLight',
  'spotLight',
  'ambientLight',
  'areaLight',
  'hemisphereLight',
  'sprite',
  'line',
  'points',
  'audioSource',
  'empty',
  'gameObject',
]);

export const CAMERA_KINDS = Object.freeze([
  'perspectiveCamera',
  'orthographicCamera',
]);

export const RESOURCE_TYPES = Object.freeze([
  'geometries',
  'materials',
  'textures',
  'graphs',
  'animations',
  'prefabs',
  'audio',
  'assets',
]);

export const INVALIDATION_SCOPES = Object.freeze([
  'document',
  'sceneGraph',
  'transforms',
  'geometry',
  'materials',
  'textures',
  'graphs',
  'animations',
  'scripts',
  'renderer',
  'rtxTopology',
  'rtxTransforms',
  'selection',
  'persistence',
]);
