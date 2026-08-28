import {
  BLENDER_MODIFIER_EXECUTION_STATUSES,
  BLENDER_MODIFIER_INVENTORY_SUMMARY,
  queryBlenderModifierInventory,
} from './modifier-inventory.mjs';

export const BLENDER_CATALOG_VERSION = 1;

export const BLENDER_COMPATIBILITY_STATUSES = Object.freeze([
  'implemented',
  'partial',
  'planned',
  'bake-required',
  'not-applicable',
]);

const STATUS_SET = new Set(BLENDER_COMPATIBILITY_STATUSES);
const MODIFIER_STATUS_SET = new Set(BLENDER_MODIFIER_EXECUTION_STATUSES);
const MAX_QUERY_RESULTS = 64;
const DEFAULT_QUERY_RESULTS = 32;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

function capability({
  id,
  domain,
  label,
  status,
  canonicalRepresentation,
  mcpWorkflow,
  runtimeNotes,
  supportedSubset = [],
  unsupportedSubset = [],
  officialUrls,
}) {
  if (!/^blender\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new TypeError(`Invalid Blender catalog ID: ${id}`);
  }
  if (!/^[a-z][A-Za-z0-9]*$/.test(domain)) {
    throw new TypeError(`Invalid Blender catalog domain: ${domain}`);
  }
  if (!STATUS_SET.has(status)) {
    throw new TypeError(`Invalid Blender compatibility status: ${status}`);
  }
  if (!Array.isArray(officialUrls) || officialUrls.length === 0) {
    throw new TypeError(`${id} requires at least one official Blender URL`);
  }
  for (const officialUrl of officialUrls) {
    const parsed = new URL(officialUrl);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'docs.blender.org') {
      throw new TypeError(`${id} contains a non-Blender documentation URL`);
    }
  }
  return deepFreeze({
    id,
    domain,
    label,
    status,
    canonicalRepresentation,
    mcpWorkflow: [...mcpWorkflow],
    runtimeNotes,
    supportedSubset: [...supportedSubset],
    unsupportedSubset: [...unsupportedSubset],
    officialUrls: [...officialUrls],
  });
}

const entries = [
  capability({
    id: 'blender/data-blocks',
    domain: 'dataBlocks',
    label: 'Data-blocks',
    status: 'partial',
    canonicalRepresentation: 'Stable-ID project, scene, resource, graph, animation, prefab, asset, and script documents.',
    mcpWorkflow: ['three_studio_inspect', 'three_studio_apply: resource.create|resource.patch|resource.delete'],
    runtimeNotes: 'Resources are canonical authored data and compiled Three.js objects are disposable products. Studio does not emulate Blender ID user counting or every ID type.',
    supportedSubset: ['stable IDs', 'typed resource tables', 'shared geometry/material references', 'create/patch/delete', 'reference validation'],
    unsupportedSubset: ['generic Blender ID API', 'user counts and fake users', 'library overrides', 'custom properties on every ID type'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/files/data_blocks.html'],
  }),
  capability({
    id: 'blender/scenes',
    domain: 'scenes',
    label: 'Scenes',
    status: 'partial',
    canonicalRepresentation: 'Project.scenes keyed by stable scene ID, sceneOrder, activeSceneId, scene settings, and entity roots.',
    mcpWorkflow: ['three_studio_apply: scene.create|scene.patch|scene.delete|scene.setActive', 'three_studio_project: save'],
    runtimeNotes: 'Multiple scenes are authored, but the lean native viewport compiles and captures only the active scene.',
    supportedSubset: ['multiple named scenes', 'active scene', 'ordered scenes', 'scene settings', 'atomic scene mutations'],
    unsupportedSubset: ['linked scene copies', 'full scene copies', 'background scenes', 'per-scene view layers', 'cross-scene object linking'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/scene_layout/scene/introduction.html'],
  }),
  capability({
    id: 'blender/collections',
    domain: 'collections',
    label: 'Collections',
    status: 'planned',
    canonicalRepresentation: 'Future stable collection documents with independent hierarchy and many-to-many entity membership.',
    mcpWorkflow: ['three_studio_apply: future collection operations', 'Until then use group entities only for transform hierarchy.'],
    runtimeNotes: 'Group entities are transform parents, not Blender-style collections; they cannot represent independent or overlapping membership.',
    supportedSubset: ['hierarchical grouping through parented group entities'],
    unsupportedSubset: ['many-to-many membership', 'nested collection data', 'collection instances', 'collection visibility and render flags'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/scene_layout/collections/introduction.html'],
  }),
  capability({
    id: 'blender/view-layers',
    domain: 'viewLayers',
    label: 'View Layers',
    status: 'planned',
    canonicalRepresentation: 'Future scene-owned view-layer documents referencing collection inclusion, overrides, and render passes.',
    mcpWorkflow: ['three_studio_apply: future view-layer operations', 'three_studio_render: future named layer/pass capture'],
    runtimeNotes: 'The renderer currently exposes one compiled active-scene view and one beauty pass.',
    supportedSubset: ['entity visibility in the single active compiled view'],
    unsupportedSubset: ['layer collections', 'holdouts', 'indirect-only collections', 'material overrides', 'separate render layers'],
    officialUrls: ['https://docs.blender.org/manual/en/4.5/scene_layout/view_layers/introduction.html'],
  }),
  capability({
    id: 'blender/objects',
    domain: 'objects',
    label: 'Objects',
    status: 'partial',
    canonicalRepresentation: 'Scene entity documents with stable ID, kind, name, hierarchy, visibility, transform, components, tags, scripts, and metadata.',
    mcpWorkflow: ['three_studio_apply: entity.create|entity.patch|entity.duplicate|entity.reparent|entity.delete', 'three_studio_inspect: scene|entity'],
    runtimeNotes: 'Entities are the Blender Object analogue; exact IDs replace selection-dependent UI context.',
    supportedSubset: ['mesh and group entities', 'cameras', 'lights', 'empties', 'hierarchy', 'duplication', 'visibility'],
    unsupportedSubset: ['all Blender object types', 'object modes', 'selection state', 'per-object viewport display controls', 'library overrides'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/scene_layout/object/introduction.html'],
  }),
  capability({
    id: 'blender/object-data',
    domain: 'objectData',
    label: 'Object Data',
    status: 'partial',
    canonicalRepresentation: 'Entity components reference reusable geometry, material, texture, animation, prefab, audio, and asset resource IDs.',
    mcpWorkflow: ['three_studio_apply: resource.create then entity.create|entity.patch', 'three_studio_inspect: references|resources'],
    runtimeNotes: 'Object/resource separation supports linked geometry and materials, while several Blender object-data kinds have no Studio compiler.',
    supportedSubset: ['shared mesh geometry', 'shared material resources', 'camera/light data in components', 'reference integrity'],
    unsupportedSubset: ['armature data', 'curve/surface/font data', 'volume data', 'lattice data', 'make-single-user operator'],
    officialUrls: [
      'https://docs.blender.org/manual/en/latest/scene_layout/object/introduction.html',
      'https://docs.blender.org/manual/en/latest/scene_layout/object/types.html',
    ],
  }),
  capability({
    id: 'blender/transforms',
    domain: 'transforms',
    label: 'Transforms',
    status: 'partial',
    canonicalRepresentation: 'Entity.transform contains local position, Euler rotation in radians, and non-zero scale vectors.',
    mcpWorkflow: ['three_studio_apply: entity.patch', 'three_studio_apply: entity.reparent'],
    runtimeNotes: 'The compiler applies local TRS through the canonical parent hierarchy.',
    supportedSubset: ['local translation', 'Euler rotation', 'scale', 'parent transforms', 'exact numeric layout'],
    unsupportedSubset: ['quaternions', 'delta transforms', 'parent inverse', 'apply/freeze transforms', 'transform orientations', 'snapping and proportional editing'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/scene_layout/object/editing/transform/introduction.html'],
  }),
  capability({
    id: 'blender/mesh-editing',
    domain: 'meshEditing',
    label: 'Mesh Editing',
    status: 'partial',
    canonicalRepresentation: 'Geometry resource recipes or explicit indexed meshes with positions, normals, UVs, colors, and indices.',
    mcpWorkflow: ['three_studio_apply: resource.create|resource.patch', 'three_studio_apply: entity.create with components.mesh'],
    runtimeNotes: 'Primitive recipes and complete explicit buffers are supported; there is no stateful Edit Mode or topology-operator layer.',
    supportedSubset: ['box', 'plane', 'sphere', 'capsule', 'circle', 'cone', 'cylinder', 'torus', 'torus knot', 'lathe', 'tube along a Catmull-Rom path', '2D shape with holes', 'extrude with bevel', 'explicit indexed mesh', 'computed normals'],
    unsupportedSubset: ['vertex/edge/face selection', 'topology extrusion operator', 'inset', 'loop cut', 'bevel operator', 'merge/dissolve', 'shape keys', 'sculpt topology'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/modeling/meshes/editing/introduction.html'],
  }),
  capability({
    id: 'blender/modifiers',
    domain: 'modifiers',
    label: 'Modifiers',
    status: 'partial',
    canonicalRepresentation: 'Entity.components.modifiers is an ordered, stable-ID stack; supported entries lower non-destructively to instance matrices and other entries remain explicit bake boundaries.',
    mcpWorkflow: ['three_studio_apply: entity.create|entity.patch components.modifiers', 'three_studio_validate', 'Bake unsupported geometry-changing modifiers to indexedMesh.'],
    runtimeNotes: 'Array and mirror execute in authored order without mutating base geometry. Blender 5.2\'s complete 83-type RNA inventory is queryable here; every other type has an explicit non-live classification.',
    supportedSubset: ['ordered stack up to 64 entries', 'stable modifier IDs', 'enable and viewport/render flags', 'array count/offset up to bounded limits', 'single-axis mirror', 'non-destructive base geometry', 'complete Blender 5.2 Object Modifier Type Items inventory'],
    unsupportedSubset: ['live evaluation outside Array/Mirror', 'apply-to-base operation', 'edit cage', 'modifier object references', 'Grease Pencil stroke/layer object model', 'physics solvers'],
    officialUrls: [
      'https://docs.blender.org/manual/en/5.2/modeling/modifiers/introduction.html',
      'https://docs.blender.org/api/5.2/bpy_types_enum_items/object_modifier_type_items.html',
    ],
  }),
  capability({
    id: 'blender/constraints',
    domain: 'constraints',
    label: 'Constraints',
    status: 'partial',
    canonicalRepresentation: 'Entity.components.constraints is an ordered, stable-ID stack with exact target IDs and bounded influence.',
    mcpWorkflow: ['three_studio_apply: entity.create|entity.patch components.constraints', 'three_studio_validate', 'Bake unsupported solver results to transforms.'],
    runtimeNotes: 'The deterministic WebGPU object evaluator applies supported constraints in authored order; unsupported kinds are preserved with a bake-required diagnostic.',
    supportedSubset: ['lookAt', 'trackTo', 'copyLocation', 'copyRotation', 'copyScale', 'limitLocation', 'target reference validation', 'influence', 'ordered stack up to 64 entries'],
    unsupportedSubset: ['coordinate-space selection', 'axis remapping beyond the lean track-to behavior', 'constraint influence animation in the live app', 'IK and bone constraints', 'full Blender constraint set'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/animation/constraints/introduction.html'],
  }),
  capability({
    id: 'blender/materials',
    domain: 'materials',
    label: 'Materials',
    status: 'partial',
    canonicalRepresentation: 'Material resources use basic, standard, physical, or toon recipes with linear color and bounded scalar parameters.',
    mcpWorkflow: ['three_studio_apply: resource.create materials', 'three_studio_apply: entity.create|entity.patch materialIds'],
    runtimeNotes: 'The WebGPU compiler supports one material per mesh and compiles the supported typed graph subset to Three.js TSL NodeMaterials.',
    supportedSubset: ['base color', 'roughness', 'metalness', 'emissive', 'opacity', 'clearcoat', 'transmission', 'toon/basic/standard/physical families', 'Blender-shaped live shader graphs'],
    unsupportedSubset: ['multiple material slots', 'volume materials', 'true geometric material displacement', 'image texture binding'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/render/materials/introduction.html'],
  }),
  capability({
    id: 'blender/shader-nodes',
    domain: 'shaderNodes',
    label: 'Shader Nodes',
    status: 'partial',
    canonicalRepresentation: 'Versioned typed shader graph documents validated against the curated Studio graph catalog.',
    mcpWorkflow: ['three_studio_inspect: graphCatalog domain shader', 'three_studio_apply: resource.create graphs', 'three_studio_validate'],
    runtimeNotes: 'Blender RNA aliases, typed socket values, and links compile through the supported TSL/WebGPU subset. The full official node inventory is discoverable and unsupported nodes fail candidate compilation explicitly.',
    supportedSubset: ['typed sockets and per-node defaults', 'Blender RNA aliases', 'coordinates and mapping', 'procedural Noise/Voronoi/Wave', 'color ramps and utility math', 'Bump/Normal Map', 'Principled BSDF to Material Output', 'direct TSL/WebGPU compilation'],
    unsupportedSubset: ['full Cycles/EEVEE closure parity', 'volumes', 'OSL', 'raw WGSL/GLSL/TSL', 'catalogued nodes without a live compiler'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/render/shader_nodes/introduction.html'],
  }),
  capability({
    id: 'blender/textures',
    domain: 'textures',
    label: 'Textures',
    status: 'partial',
    canonicalRepresentation: 'Texture and asset resources plus versioned typed texture graphs with explicit color-space declarations.',
    mcpWorkflow: ['three_studio_inspect: graphCatalog domain texture', 'three_studio_apply: resource.create textures|assets|graphs', 'three_studio_validate'],
    runtimeNotes: 'Procedural texture graphs compile to live TSL where supported and can be deterministically CPU-evaluated into typed albedo, roughness, normal, and height maps.',
    supportedSubset: ['sRGB/non-color declarations', 'UV and generated coordinates', 'checker/gradient/noise/Voronoi/Wave/ramp/math evaluation', 'bounded deterministic CPU bake', 'live procedural TSL'],
    unsupportedSubset: ['image decoding and GPU binding through MCP', 'UDIM', 'texture painting', 'file-producing bake jobs'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/render/shader_nodes/textures/index.html'],
  }),
  capability({
    id: 'blender/lights',
    domain: 'lights',
    label: 'Lights',
    status: 'partial',
    canonicalRepresentation: 'Directional, point, spot, and ambient light entities with typed component parameters and transforms.',
    mcpWorkflow: ['three_studio_apply: entity.create kind directionalLight|pointLight|spotLight|ambientLight', 'three_studio_render'],
    runtimeNotes: 'Lights compile to external Three.js WebGPU objects; authored shadow settings are intentionally bounded.',
    supportedSubset: ['directional', 'point', 'spot', 'ambient', 'color', 'intensity', 'cast shadow', 'position and direction through transforms'],
    unsupportedSubset: ['area lights', 'light node trees', 'IES profiles', 'light linking', 'Cycles-specific sampling controls'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/render/lights/light_object.html'],
  }),
  capability({
    id: 'blender/cameras',
    domain: 'cameras',
    label: 'Cameras',
    status: 'partial',
    canonicalRepresentation: 'Perspective or orthographic camera entities plus scene activeCameraId and transient review/render camera state.',
    mcpWorkflow: ['three_studio_apply: entity.create camera', 'three_studio_apply: scene.setActiveCamera', 'three_studio_render: cameraId|frame'],
    runtimeNotes: 'GPU evidence can use an authored camera or clone the review camera without mutating authored state.',
    supportedSubset: ['perspective camera', 'orthographic camera', 'near/far planes', 'field of view or ortho bounds', 'active camera', 'framed evidence'],
    unsupportedSubset: ['lens shift', 'depth of field', 'panoramic cameras', 'camera background images', 'stereoscopy'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/render/cameras.html'],
  }),
  capability({
    id: 'blender/world',
    domain: 'world',
    label: 'World Environment',
    status: 'partial',
    canonicalRepresentation: 'Scene settings for background color, environment reference, and fog.',
    mcpWorkflow: ['three_studio_apply: scene.settings.patch', 'three_studio_render'],
    runtimeNotes: 'Solid background and fog compile today; node-based worlds and image-based lighting are not yet compiled.',
    supportedSubset: ['linear background color', 'scene fog document', 'environment resource reference validation'],
    unsupportedSubset: ['world shader graph', 'HDRI image-based lighting', 'sky models', 'world volume shader', 'light probes'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/render/lights/world.html'],
  }),
  capability({
    id: 'blender/actions',
    domain: 'actions',
    label: 'Actions',
    status: 'partial',
    canonicalRepresentation: 'Versioned animation/action resources contain reusable typed tracks bound to exact entity IDs and canonical property paths.',
    mcpWorkflow: ['three_studio_apply: resource.create|resource.patch animations', 'three_studio_validate', 'three_studio_play: enter|pause|resume|seek|step', 'three_studio_render: timelineFrame'],
    runtimeNotes: 'Actions compile, validate, sample, and apply through a deterministic runtime wired to native Play and exact-frame evidence capture.',
    supportedSubset: ['reusable action resources', 'stable target bindings', 'frame- or seconds-based ranges', 'once/repeat/pingpong loops', 'speed and autoplay state', 'deterministic sampling', 'Play transport', 'exact-frame beauty rendering'],
    unsupportedSubset: ['action slots', 'channel bags', 'layered action blending', 'NLA integration', 'MCP playback controls per action'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/animation/actions.html'],
  }),
  capability({
    id: 'blender/keyframes',
    domain: 'keyframes',
    label: 'Keyframes',
    status: 'partial',
    canonicalRepresentation: 'Animation tracks carry property paths and ordered keyframes (or flat times/values), normalized to seconds with typed values and interpolation.',
    mcpWorkflow: ['three_studio_apply: resource.create|resource.patch animations with tracks', 'three_studio_validate', 'three_studio_play: seek|step', 'three_studio_render: timelineFrame'],
    runtimeNotes: 'The evaluator supports pure sampling, native Play transport, deterministic seek/step, and temporary exact-frame renders without canonical mutation.',
    supportedSubset: ['position/rotation/scale tracks', 'visibility tracks', 'constant/linear/smooth/Bezier interpolation', 'explicit tangents', 'frame-to-seconds conversion', 'bounded binary-search sampling', 'native viewport playback'],
    unsupportedSubset: ['interactive key insertion/deletion operators', 'Graph Editor handle UI', 'keying sets', 'arbitrary property paths'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/animation/keyframes/introduction.html'],
  }),
  capability({
    id: 'blender/drivers',
    domain: 'drivers',
    label: 'Drivers',
    status: 'planned',
    canonicalRepresentation: 'Future bounded dependency expressions or blueprint nodes with explicit stable-ID inputs and typed outputs.',
    mcpWorkflow: ['three_studio_apply: future graph resource and target binding', 'three_studio_validate: dependency-cycle and budget checks'],
    runtimeNotes: 'Arbitrary Python expressions are outside the agent-safe authoring boundary.',
    supportedSubset: [],
    unsupportedSubset: ['driver variables', 'scripted expressions', 'dependency graph evaluation', 'property path drivers', 'custom driver functions'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/animation/drivers/index.html'],
  }),
  capability({
    id: 'blender/nonlinear-animation',
    domain: 'nla',
    label: 'Nonlinear Animation',
    status: 'planned',
    canonicalRepresentation: 'Future ordered animation tracks and strips referencing reusable animation resources.',
    mcpWorkflow: ['three_studio_apply: future NLA track/strip operations', 'three_studio_play: future evaluated playback'],
    runtimeNotes: 'The deterministic action evaluator exists, but there is no track/strip mixer or NLA document layer yet.',
    supportedSubset: [],
    unsupportedSubset: ['tracks', 'strips', 'transitions', 'strip time remapping', 'influence blending', 'tweak mode'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/editors/nla/introduction.html'],
  }),
  capability({
    id: 'blender/geometry-nodes',
    domain: 'geometryNodes',
    label: 'Geometry Nodes',
    status: 'bake-required',
    canonicalRepresentation: 'Evaluated geometry must currently be baked to explicit/indexed geometry; a typed procedural geometry graph domain is planned.',
    mcpWorkflow: ['Bake or realize evaluated instances externally.', 'three_studio_apply: resource.create indexedMesh'],
    runtimeNotes: 'Shader, texture, and blueprint graph catalogs do not imply a Geometry Nodes evaluator.',
    supportedSubset: ['baked static mesh output'],
    unsupportedSubset: ['geometry sockets', 'fields', 'zones', 'instances', 'attribute capture', 'node-group modifiers', 'simulation nodes'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/modeling/geometry_nodes/introduction.html'],
  }),
  capability({
    id: 'blender/compositor',
    domain: 'compositor',
    label: 'Compositor',
    status: 'planned',
    canonicalRepresentation: 'Future versioned compositor graph resources consuming explicit render passes and producing bounded image outputs.',
    mcpWorkflow: ['three_studio_render: future diagnostic/render passes', 'three_studio_job: future offline compositor job'],
    runtimeNotes: 'Only direct WebGPU beauty evidence is available; no post-render graph is evaluated.',
    supportedSubset: [],
    unsupportedSubset: ['compositor nodes', 'render-layer inputs', 'AOVs', 'cryptomatte', 'file outputs', 'viewport compositor'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/compositing/introduction.html'],
  }),
  capability({
    id: 'blender/rendering',
    domain: 'rendering',
    label: 'Rendering',
    status: 'partial',
    canonicalRepresentation: 'External Three.js WebGPU renderer plus revision-bound evidence metadata and project render settings.',
    mcpWorkflow: ['three_studio_status', 'three_studio_render: beauty with authored camera or exact framing', 'three_studio_inspect: latestEvidence'],
    runtimeNotes: 'The persistent native viewport uses WebGPU with shadows. Evidence capture is explicit and offscreen; RTX, animation, and diagnostic passes are capability-gated.',
    supportedSubset: ['WebGPU beauty pass', 'native live viewport', 'shadows', 'offscreen PNG evidence', 'perspective and orthographic capture', 'exact revision metadata'],
    unsupportedSubset: ['Cycles', 'Eevee parity', 'RTX path tracing', 'AOV/render passes', 'render animation', 'distributed render', 'denoising'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/render/introduction.html'],
  }),
  capability({
    id: 'blender/assets',
    domain: 'assets',
    label: 'Assets',
    status: 'partial',
    canonicalRepresentation: 'Stable asset and prefab resource documents with project-relative metadata and validated references.',
    mcpWorkflow: ['three_studio_apply: resource.create assets|prefabs', 'three_studio_inspect: resources|references'],
    runtimeNotes: 'The document model reserves reusable assets and prefabs, but browsing, loading, thumbnails, catalogs, and instantiation are not live pipelines yet.',
    supportedSubset: ['asset metadata storage', 'prefab metadata storage', 'stable project-relative references'],
    unsupportedSubset: ['asset browser', 'asset catalogs', 'preview generation', 'drag/drop', 'remote libraries', 'prefab instantiation runtime'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/files/asset_libraries/index.html'],
  }),
  capability({
    id: 'blender/link-append',
    domain: 'linkAppend',
    label: 'Link and Append',
    status: 'planned',
    canonicalRepresentation: 'Future explicit dependency records for immutable linked packages and content-copied appended resources.',
    mcpWorkflow: ['three_studio_job: future import/link job', 'three_studio_apply: future dependency attachment transaction'],
    runtimeNotes: 'Project open is not Blender library linking; Studio currently keeps one project root and does not load .blend libraries.',
    supportedSubset: [],
    unsupportedSubset: ['.blend link', '.blend append', 'reload/relocate', 'make local', 'library overrides', 'cross-project dependency graph'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/files/linked_libraries/link_append.html'],
  }),
  capability({
    id: 'blender/scripting',
    domain: 'scripting',
    label: 'Scripting',
    status: 'partial',
    canonicalRepresentation: 'Project-relative JavaScript modules represented by script documents with hashes, declared trust, and exposed functions.',
    mcpWorkflow: ['Project code is authored through the separate trusted-code path, not ordinary scene mutations.', 'three_studio_validate'],
    runtimeNotes: 'The parser/store enforces module boundaries, but scripts are not MCP-exposed or executed and behaviorRuntime is false.',
    supportedSubset: ['JavaScript module parsing', 'relative import checks', 'static exposed-function metadata', 'agent-safe versus trusted-project policy'],
    unsupportedSubset: ['script execution', 'Python/bpy compatibility', 'console', 'arbitrary eval', 'ordinary-MCP code injection'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/advanced/scripting/introduction.html'],
  }),
  capability({
    id: 'blender/operators',
    domain: 'operators',
    label: 'Operators',
    status: 'partial',
    canonicalRepresentation: 'Strict typed operations collected into one revision-checked, idempotent, atomic changeset.',
    mcpWorkflow: ['three_studio_apply with baseRevision, idempotencyKey, label, and typed operations', 'three_studio_history: undo|redo'],
    runtimeNotes: 'Studio operators are context-free and exact-ID based, intentionally avoiding Blender UI-area and selection context.',
    supportedSubset: ['14 scene/entity/resource operations', 'atomic batches', 'dry run', 'inverse history', 'undo/redo as new revisions', 'whole-project validation'],
    unsupportedSubset: ['bpy.ops compatibility', 'selection-context operators', 'macro recording', 'modal operators', 'mesh edit operators'],
    officialUrls: ['https://docs.blender.org/api/current/bpy.ops.html'],
  }),
  capability({
    id: 'blender/physics',
    domain: 'physics',
    label: 'Physics and Simulation',
    status: 'planned',
    canonicalRepresentation: 'Future typed physics components, deterministic simulation settings, and cache/bake artifacts.',
    mcpWorkflow: ['three_studio_apply: future physics components', 'three_studio_job: future bake', 'three_studio_play: future fixed-step simulation'],
    runtimeNotes: 'Play evaluates Actions only; no physics world is created.',
    supportedSubset: [],
    unsupportedSubset: ['rigid body', 'soft body', 'cloth', 'fluid', 'collision', 'force fields', 'simulation cache and bake'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/physics/index.html'],
  }),
  capability({
    id: 'blender/persistence',
    domain: 'persistence',
    label: 'Project Persistence',
    status: 'implemented',
    canonicalRepresentation: 'Versioned project manifest plus immutable content-hashed scene/resource blobs, recovery journal, and named atomic saves.',
    mcpWorkflow: ['three_studio_project: list|create|open|save', 'three_studio_status', 'three_studio_validate'],
    runtimeNotes: 'Studio uses its own lean project format rather than .blend. Manifest-last replacement and recovery protect canonical authored state.',
    supportedSubset: ['project create/open/save/list', 'named atomic save', 'content hashes', 'last-project restore', 'recovery journal', 'saved revision tracking'],
    unsupportedSubset: ['.blend read/write', 'pack external data', 'incremental .blend versions', 'Blender startup/recovery file compatibility'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/files/blend/open_save.html'],
  }),
  capability({
    id: 'blender/curves-surfaces-text',
    domain: 'curvesSurfacesText',
    label: 'Curves, Surfaces, and Text',
    status: 'partial',
    canonicalRepresentation: 'Geometry recipes preserve bounded lathe profiles, Catmull-Rom tube paths, planar shapes/holes, and extrusions; other evaluated results use explicit meshes.',
    mcpWorkflow: ['three_studio_apply: resource.create geometries with lathe|tube|shape|extrude recipe', 'For unsupported curve/surface/text semantics, convert externally to indexedMesh.'],
    runtimeNotes: 'Useful parametric curve-derived geometry compiles natively, but Studio does not model Blender spline, NURBS, or font data-block semantics.',
    supportedSubset: ['lathe profiles', 'open/closed Catmull-Rom tube paths', 'planar contours and holes', 'extrusion depth and bevel', 'baked static mesh result'],
    unsupportedSubset: ['general editable spline data and handle modes', 'NURBS patches', 'arbitrary bevel profiles', 'text/font layout', 'live object-data conversion'],
    officialUrls: [
      'https://docs.blender.org/manual/en/latest/modeling/curves/introduction.html',
      'https://docs.blender.org/manual/en/latest/modeling/surfaces/introduction.html',
      'https://docs.blender.org/manual/en/latest/modeling/texts/introduction.html',
    ],
  }),
  capability({
    id: 'blender/rigging',
    domain: 'rigging',
    label: 'Rigging',
    status: 'planned',
    canonicalRepresentation: 'Future armature, bone hierarchy, skin weights, pose, and animation-binding resources.',
    mcpWorkflow: ['three_studio_apply: future rig and skin operations', 'three_studio_play: future animation evaluation'],
    runtimeNotes: 'Static evaluated skinned geometry may be baked externally, but Studio cannot currently preserve or play a rig.',
    supportedSubset: [],
    unsupportedSubset: ['armatures', 'bones', 'weight painting', 'skinning', 'pose mode', 'IK', 'retargeting'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/animation/armatures/introduction.html'],
  }),
  capability({
    id: 'blender/sculpting',
    domain: 'sculpting',
    label: 'Sculpting',
    status: 'bake-required',
    canonicalRepresentation: 'Sculpt output must be reduced and exported as an explicit mesh, with surface detail baked into future texture assets where needed.',
    mcpWorkflow: ['Sculpt/retopologize/bake externally.', 'three_studio_apply: resource.create indexedMesh'],
    runtimeNotes: 'The LLM-first runtime has no interactive brush engine or dynamic topology.',
    supportedSubset: ['baked sculpt mesh result'],
    unsupportedSubset: ['brushes', 'dyntopo', 'multires sculpt', 'face sets', 'voxel remesh', 'sculpt masks'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/sculpt_paint/sculpting/introduction/index.html'],
  }),
  capability({
    id: 'blender/uv-editing',
    domain: 'uvEditing',
    label: 'UV Editing',
    status: 'partial',
    canonicalRepresentation: 'Explicit geometry resources may carry one UV attribute array aligned to vertex positions.',
    mcpWorkflow: ['three_studio_apply: resource.create|resource.patch indexedMesh with uvs'],
    runtimeNotes: 'UV coordinates persist and compile, but texture maps do not yet bind and there is no unwrapping operator.',
    supportedSubset: ['single UV attribute import', 'UV buffer validation by vertex count'],
    unsupportedSubset: ['unwrap', 'seams', 'multiple UV maps', 'UV islands', 'packing', 'live UV editing'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/modeling/meshes/uv/unwrapping/introduction.html'],
  }),
  capability({
    id: 'blender/grease-pencil',
    domain: 'greasePencil',
    label: 'Grease Pencil',
    status: 'bake-required',
    canonicalRepresentation: 'Evaluated strokes must be converted to line or mesh entities; native Grease Pencil layer/frame data is not represented.',
    mcpWorkflow: ['Bake strokes to curves/meshes externally.', 'three_studio_apply: resource.create plus entity.create'],
    runtimeNotes: 'Studio exposes a line entity kind but does not compile Blender Grease Pencil semantics.',
    supportedSubset: ['baked line or mesh result where compatible'],
    unsupportedSubset: ['draw mode', 'stroke layers', 'frames', 'onion skinning', 'Grease Pencil modifiers', 'materials and fills'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/grease_pencil/introduction.html'],
  }),
  capability({
    id: 'blender/color-management',
    domain: 'colorManagement',
    label: 'Color Management',
    status: 'partial',
    canonicalRepresentation: 'Project workingColorSpace plus explicit linear-sRGB authored colors and sRGB/non-color texture declarations.',
    mcpWorkflow: ['three_studio_apply: project/resource fields through supported typed operations', 'three_studio_render'],
    runtimeNotes: 'Linear authoring avoids accidental double conversion, but Blender view transforms and display controls are not reproduced.',
    supportedSubset: ['linear-sRGB working colors', 'sRGB/non-color texture intent', 'WebGPU output'],
    unsupportedSubset: ['AgX/Filmic parity', 'OCIO configuration', 'look and exposure controls', 'per-view display transforms'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/render/color_management/index.html'],
  }),
  capability({
    id: 'blender/instancing',
    domain: 'instancing',
    label: 'Duplication and Instancing',
    status: 'partial',
    canonicalRepresentation: 'Duplicated entities can share immutable geometry and material resource IDs; instancedMesh is a reserved entity kind.',
    mcpWorkflow: ['three_studio_apply: entity.duplicate', 'three_studio_apply: entity.create with shared resource IDs'],
    runtimeNotes: 'Shared object data works, but production multi-instance compilation and collection/geometry-node instancing are not exposed.',
    supportedSubset: ['linked geometry/material reuse', 'entity duplication', 'stable independent transforms'],
    unsupportedSubset: ['collection instances', 'face/vertex instancing', 'Geometry Nodes instances', 'make instances real', 'multi-instance draw authoring'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/scene_layout/object/properties/instancing/index.html'],
  }),
  capability({
    id: 'blender/workspaces-editors',
    domain: 'workspacesEditors',
    label: 'Workspaces and Editors',
    status: 'not-applicable',
    canonicalRepresentation: 'MCP tools are the editor; the persistent native window is a shared viewport rather than a panel-based desktop workspace.',
    mcpWorkflow: ['Use the nine coarse three_studio_* MCP tools.', 'Observe results in the native WebGPU viewport and evidence captures.'],
    runtimeNotes: 'This is an intentional product-shape difference, not a missing conventional UI implementation.',
    supportedSubset: ['live native viewport', 'LLM-first inspection and mutation', 'render evidence'],
    unsupportedSubset: ['Blender workspaces', 'Outliner UI', 'Properties editor', 'Dope Sheet UI', 'Graph Editor UI', 'custom screen layouts'],
    officialUrls: ['https://docs.blender.org/manual/en/latest/interface/window_system/workspaces.html'],
  }),
];

const domains = new Set();
const ids = new Set();
for (const entry of entries) {
  if (domains.has(entry.domain)) throw new TypeError(`Duplicate Blender catalog domain: ${entry.domain}`);
  if (ids.has(entry.id)) throw new TypeError(`Duplicate Blender catalog ID: ${entry.id}`);
  domains.add(entry.domain);
  ids.add(entry.id);
}

const entryMap = Object.freeze(Object.fromEntries(entries.map((entry) => [entry.domain, entry])));

export const BLENDER_CATALOG = deepFreeze({
  version: BLENDER_CATALOG_VERSION,
  statuses: BLENDER_COMPATIBILITY_STATUSES,
  entries: entryMap,
});

function buildSummary() {
  const byStatus = Object.fromEntries(BLENDER_COMPATIBILITY_STATUSES.map((status) => [status, 0]));
  for (const entry of entries) byStatus[entry.status] += 1;
  return deepFreeze({
    version: BLENDER_CATALOG_VERSION,
    total: entries.length,
    byStatus,
    domains: [...domains].sort(),
  });
}

export const BLENDER_CATALOG_SUMMARY = buildSummary();

export function summarizeBlenderCatalog() {
  return BLENDER_CATALOG_SUMMARY;
}

function normalizeLimit(limit) {
  if (!Number.isInteger(limit)) return DEFAULT_QUERY_RESULTS;
  return Math.max(1, Math.min(MAX_QUERY_RESULTS, limit));
}

function searchText(entry) {
  return [
    entry.id,
    entry.domain,
    entry.label,
    entry.status,
    entry.canonicalRepresentation,
    ...entry.mcpWorkflow,
    entry.runtimeNotes,
    ...entry.supportedSubset,
    ...entry.unsupportedSubset,
  ].join(' ').toLowerCase();
}

export function queryBlenderCatalog({ domain, search, status, limit } = {}) {
  const normalizedDomain = domain === undefined ? '' : String(domain).trim().toLowerCase();
  const modifierDomainRequested = normalizedDomain === 'modifiers' || normalizedDomain === 'blender/modifiers';
  const modifierStatusRequested = modifierDomainRequested && MODIFIER_STATUS_SET.has(status);
  if (status !== undefined && !STATUS_SET.has(status) && !modifierStatusRequested) {
    throw new TypeError(`Unknown Blender compatibility status: ${status}`);
  }
  const normalizedSearch = search === undefined ? '' : String(search).trim().toLowerCase().slice(0, 256);
  const matches = entries
    .filter((entry) => !normalizedDomain || entry.domain.toLowerCase() === normalizedDomain || entry.id.toLowerCase() === normalizedDomain)
    .filter((entry) => status === undefined || modifierStatusRequested || entry.status === status)
    .filter((entry) => modifierDomainRequested || !normalizedSearch || searchText(entry).includes(normalizedSearch))
    .sort((left, right) => left.domain.localeCompare(right.domain));
  const returnedEntries = matches.slice(0, normalizeLimit(limit));
  const result = {
    version: BLENDER_CATALOG_VERSION,
    total: entries.length,
    matched: matches.length,
    returned: returnedEntries.length,
    entries: returnedEntries,
  };
  if (modifierDomainRequested && (status === undefined || modifierStatusRequested || returnedEntries.length > 0)) {
    result.modifierInventorySummary = BLENDER_MODIFIER_INVENTORY_SUMMARY;
    result.modifierInventory = queryBlenderModifierInventory({
      search: normalizedSearch,
      status: modifierStatusRequested ? status : undefined,
      limit,
    });
  }
  return result;
}
