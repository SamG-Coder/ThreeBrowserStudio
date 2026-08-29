export const BLENDER_MODIFIER_INVENTORY_VERSION = 1;

export const BLENDER_MODIFIER_EXECUTION_STATUSES = Object.freeze([
  'live-runtime',
  'live-geometry',
  'bake-required',
  'planned',
  'not-applicable',
]);

export const BLENDER_MODIFIER_CATEGORIES = Object.freeze([
  'modify',
  'generate',
  'deform',
  'simulate',
]);

export const BLENDER_MODIFIER_SOURCES = Object.freeze({
  blenderVersion: '5.2 LTS',
  modifierMenuSource: 'https://projects.blender.org/blender/blender/src/branch/blender-v5.2-release/scripts/startup/bl_ui/properties_data_modifier.py',
  modifierTypeEnum: 'https://docs.blender.org/api/5.2/bpy_types_enum_items/object_modifier_type_items.html',
  modifierRna: 'https://docs.blender.org/api/5.2/bpy.types.Modifier.html',
  modifierOperator: 'https://docs.blender.org/api/5.2/bpy.ops.object.html#bpy.ops.object.modifier_add',
  modifierManual: 'https://docs.blender.org/manual/en/5.2/modeling/modifiers/introduction.html',
});

const STATUS_SET = new Set(BLENDER_MODIFIER_EXECUTION_STATUSES);
const CATEGORY_SET = new Set(BLENDER_MODIFIER_CATEGORIES);
const EXPECTED_MODIFIER_COUNT = 83;
const MAX_QUERY_RESULTS = 200;
const DEFAULT_QUERY_RESULTS = 32;
const MODIFIER_ADD_OPERATOR = 'bpy.ops.object.modifier_add';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

const STATUS_NOTES = Object.freeze({
  'live-runtime': 'Studio evaluates this modifier non-destructively in authored stack order.',
  'live-geometry': 'Studio evaluates equivalent geometry semantics through a live geometry resource.',
  'bake-required': 'Bake the evaluated Blender result before import; Studio preserves the modifier as an explicit bake boundary.',
  planned: 'The Blender operation is catalogued, but Studio has no live evaluator for it yet.',
  'not-applicable': 'Studio has no Grease Pencil stroke/layer object model, so this modifier is not applicable to current Studio entities.',
});

// Blender 5.2's complete Object Modifier Type Items enum. Each tuple is:
// [operator type, RNA subclass, manual category, label, purpose, Studio status, optional Studio note].
// The API calls the final enum section "Physics"; Blender's modifier manual calls
// the corresponding Add Modifier category "Simulate", which is the normalized
// category exposed by this inventory.
const modifierRows = [
  // Modify
  ['GREASE_PENCIL_VERTEX_WEIGHT_PROXIMITY', 'GreasePencilWeightProximityModifier', 'modify', 'Vertex Weight Proximity', 'Generate stroke-point weights from distance to another object.', 'not-applicable'],
  ['DATA_TRANSFER', 'DataTransferModifier', 'modify', 'Data Transfer', 'Transfer mesh data such as vertex groups, UV maps, colors, and custom normals.', 'bake-required'],
  ['MESH_CACHE', 'MeshCacheModifier', 'modify', 'Mesh Cache', 'Deform a mesh from an external frame-by-frame vertex cache.', 'bake-required'],
  ['MESH_SEQUENCE_CACHE', 'MeshSequenceCacheModifier', 'modify', 'Mesh Sequence Cache', 'Deform mesh or curve geometry from an external Alembic cache.', 'bake-required'],
  ['NORMAL_EDIT', 'NormalEditModifier', 'modify', 'Normal Edit', 'Change the direction of surface normals.', 'bake-required'],
  ['WEIGHTED_NORMAL', 'WeightedNormalModifier', 'modify', 'Weighted Normal', 'Recalculate surface normals with weighted face influence.', 'live-geometry', 'Studio evaluates area, corner-angle, or combined weighting on indexed meshes; sharp-edge and face-strength options remain a bake boundary.'],
  ['UV_PROJECT', 'UVProjectModifier', 'modify', 'UV Project', 'Project UV coordinates from one or more projector objects.', 'bake-required'],
  ['UV_WARP', 'UVWarpModifier', 'modify', 'UV Warp', 'Transform UV coordinates from the relative transforms of two objects.', 'bake-required'],
  ['VERTEX_WEIGHT_EDIT', 'VertexWeightEditModifier', 'modify', 'Vertex Weight Edit', 'Edit the weights of one vertex group procedurally.', 'bake-required'],
  ['VERTEX_WEIGHT_MIX', 'VertexWeightMixModifier', 'modify', 'Vertex Weight Mix', 'Mix weights from two vertex groups.', 'bake-required'],
  ['VERTEX_WEIGHT_PROXIMITY', 'VertexWeightProximityModifier', 'modify', 'Vertex Weight Proximity', 'Set vertex-group weights from distance to target geometry.', 'bake-required'],
  ['GREASE_PENCIL_COLOR', 'GreasePencilColorModifier', 'modify', 'Hue/Saturation', 'Adjust hue, saturation, and value of Grease Pencil strokes.', 'not-applicable'],
  ['GREASE_PENCIL_TINT', 'GreasePencilTintModifier', 'modify', 'Tint', 'Tint Grease Pencil stroke colors.', 'not-applicable'],
  ['GREASE_PENCIL_OPACITY', 'GreasePencilOpacityModifier', 'modify', 'Opacity', 'Change Grease Pencil stroke opacity.', 'not-applicable'],
  ['GREASE_PENCIL_VERTEX_WEIGHT_ANGLE', 'GreasePencilWeightAngleModifier', 'modify', 'Vertex Weight Angle', 'Generate stroke-point weights from stroke angle.', 'not-applicable'],
  ['GREASE_PENCIL_TIME', 'GreasePencilTimeModifier', 'modify', 'Time Offset', 'Offset Grease Pencil keyframes in time.', 'not-applicable'],
  ['GREASE_PENCIL_TEXTURE', 'GreasePencilTextureModifier', 'modify', 'Texture Mapping', 'Change Grease Pencil stroke UV texture values.', 'not-applicable'],

  // Generate
  ['ARRAY', 'ArrayModifier', 'generate', 'Array', 'Create repeated copies with deterministic offsets.', 'live-runtime', 'Studio evaluates bounded count and offset settings as non-destructive instance matrices.'],
  ['BEVEL', 'BevelModifier', 'generate', 'Bevel', 'Add geometry that creates sloped corners on edges or vertices.', 'bake-required'],
  ['BOOLEAN', 'BooleanModifier', 'generate', 'Boolean', 'Combine, intersect, or subtract geometry using another shape.', 'bake-required'],
  ['BUILD', 'BuildModifier', 'generate', 'Build', 'Reveal or hide mesh faces sequentially over time.', 'bake-required'],
  ['DECIMATE', 'DecimateModifier', 'generate', 'Decimate', 'Reduce mesh density while approximating the original shape.', 'live-geometry', 'Studio evaluates the bounded deterministic collapse subset with a ratio or exact triangle target.'],
  ['EDGE_SPLIT', 'EdgeSplitModifier', 'generate', 'Edge Split', 'Split joined faces along selected or sharp edges.', 'live-geometry', 'Studio evaluates angle-based edge splitting; named sharp-edge attributes are not yet an input.'],
  ['NODES', 'NodesModifier', 'generate', 'Geometry Nodes', 'Evaluate a geometry node group as a modifier.', 'planned', 'A typed procedural geometry graph domain and evaluator are planned; the current shader, texture, and blueprint graph domains do not execute Geometry Nodes. Bundled modifier assets also resolve to this RNA type.'],
  ['MASK', 'MaskModifier', 'generate', 'Mask', 'Hide vertices dynamically from a vertex group or armature.', 'bake-required'],
  ['MIRROR', 'MirrorModifier', 'generate', 'Mirror', 'Mirror geometry across local axes or a mirror object.', 'live-runtime', 'Studio evaluates the supported single-axis mirror subset as non-destructive instance matrices.'],
  ['MESH_TO_VOLUME', 'MeshToVolumeModifier', 'generate', 'Mesh to Volume', 'Convert mesh geometry into a volume grid.', 'bake-required'],
  ['MULTIRES', 'MultiresModifier', 'generate', 'Multiresolution', 'Maintain editable mesh subdivision levels for multiresolution sculpting.', 'bake-required'],
  ['REMESH', 'RemeshModifier', 'generate', 'Remesh', 'Generate new topology from the current shape.', 'bake-required'],
  ['SCREW', 'ScrewModifier', 'generate', 'Screw', 'Lathe a profile around an axis with optional screw translation.', 'bake-required'],
  ['SKIN', 'SkinModifier', 'generate', 'Skin', 'Create a solid branching surface from vertices and edges.', 'bake-required'],
  ['SOLIDIFY', 'SolidifyModifier', 'generate', 'Solidify', 'Give a surface thickness.', 'live-geometry', 'Studio evaluates bounded thickness and offset on indexed meshes; vertex-group controls require baking.'],
  ['SUBSURF', 'SubsurfModifier', 'generate', 'Subdivision Surface', 'Subdivide faces for a denser, smoother surface.', 'live-geometry', 'Studio evaluates one to six bounded simple or Loop-style triangle subdivision levels.'],
  ['TRIANGULATE', 'TriangulateModifier', 'generate', 'Triangulate', 'Convert polygons to triangles.', 'live-geometry', 'Studio preserves this explicit stack step; canonical indexed meshes are already triangulated.'],
  ['VOLUME_TO_MESH', 'VolumeToMeshModifier', 'generate', 'Volume to Mesh', 'Extract a mesh surface from a volume grid.', 'bake-required'],
  ['WELD', 'WeldModifier', 'generate', 'Weld', 'Merge groups of vertices within a distance threshold.', 'live-geometry', 'Studio welds positional duplicates while preserving UV and color seams.'],
  ['WIREFRAME', 'WireframeModifier', 'generate', 'Wireframe', 'Replace faces with thickened edge geometry.', 'bake-required'],
  ['GREASE_PENCIL_ARRAY', 'GreasePencilArrayModifier', 'generate', 'Array', 'Duplicate Grease Pencil strokes into an array.', 'not-applicable'],
  ['GREASE_PENCIL_BUILD', 'GreasePencilBuildModifier', 'generate', 'Build', 'Animate Grease Pencil strokes appearing or disappearing.', 'not-applicable'],
  ['GREASE_PENCIL_LENGTH', 'GreasePencilLengthModifier', 'generate', 'Length', 'Extend or shorten Grease Pencil strokes.', 'not-applicable'],
  ['LINEART', 'GreasePencilLineartModifier', 'generate', 'Line Art', 'Generate Grease Pencil line art from scene geometry.', 'not-applicable'],
  ['GREASE_PENCIL_MIRROR', 'GreasePencilMirrorModifier', 'generate', 'Mirror', 'Duplicate Grease Pencil strokes across mirror axes.', 'not-applicable'],
  ['GREASE_PENCIL_MULTIPLY', 'GreasePencilMultiplyModifier', 'generate', 'Multiple Strokes', 'Generate multiple strokes around each source stroke.', 'not-applicable'],
  ['GREASE_PENCIL_SIMPLIFY', 'GreasePencilSimplifyModifier', 'generate', 'Simplify', 'Reduce the number of Grease Pencil stroke points.', 'not-applicable'],
  ['GREASE_PENCIL_SUBDIV', 'GreasePencilSubdivModifier', 'generate', 'Subdivide', 'Subdivide Grease Pencil strokes with additional points.', 'not-applicable'],
  ['GREASE_PENCIL_ENVELOPE', 'GreasePencilEnvelopeModifier', 'generate', 'Envelope', 'Generate envelope shapes around Grease Pencil strokes.', 'not-applicable'],
  ['GREASE_PENCIL_OUTLINE', 'GreasePencilOutlineModifier', 'generate', 'Outline', 'Convert Grease Pencil strokes to outlines.', 'not-applicable'],

  // Deform
  ['ARMATURE', 'ArmatureModifier', 'deform', 'Armature', 'Deform geometry using an armature object.', 'bake-required'],
  ['CAST', 'CastModifier', 'deform', 'Cast', 'Shift geometry toward a primitive shape.', 'bake-required'],
  ['CURVE', 'CurveModifier', 'deform', 'Curve', 'Bend geometry along a curve object.', 'bake-required'],
  ['DISPLACE', 'DisplaceModifier', 'deform', 'Displace', 'Offset vertices using texture values.', 'live-geometry', 'Studio evaluates deterministic inline constant, wave, or seeded-noise sources in local space; texture and vertex-group inputs require baking.'],
  ['HOOK', 'HookModifier', 'deform', 'Hook', 'Deform selected points using another object.', 'bake-required'],
  ['LAPLACIANDEFORM', 'LaplacianDeformModifier', 'deform', 'Laplacian Deform', 'Deform a surface from a set of anchored vertices.', 'bake-required'],
  ['LATTICE', 'LatticeModifier', 'deform', 'Lattice', 'Deform geometry with a lattice object.', 'bake-required'],
  ['MESH_DEFORM', 'MeshDeformModifier', 'deform', 'Mesh Deform', 'Deform geometry using another mesh as a cage.', 'bake-required'],
  ['SHRINKWRAP', 'ShrinkwrapModifier', 'deform', 'Shrinkwrap', 'Project geometry onto target geometry.', 'bake-required'],
  ['SIMPLE_DEFORM', 'SimpleDeformModifier', 'deform', 'Simple Deform', 'Twist, bend, taper, or stretch geometry.', 'bake-required'],
  ['SMOOTH', 'SmoothModifier', 'deform', 'Smooth', 'Relax vertex positions to flatten angles between faces.', 'live-geometry', 'Studio evaluates bounded whole-mesh Laplacian smoothing with optional boundary preservation.'],
  ['CORRECTIVE_SMOOTH', 'CorrectiveSmoothModifier', 'deform', 'Smooth Corrective', 'Smooth deformations while preserving volume.', 'bake-required'],
  ['LAPLACIANSMOOTH', 'LaplacianSmoothModifier', 'deform', 'Smooth Laplacian', 'Reduce surface noise while preserving overall shape.', 'bake-required'],
  ['SURFACE_DEFORM', 'SurfaceDeformModifier', 'deform', 'Surface Deform', 'Transfer deformation from another mesh surface.', 'bake-required'],
  ['WARP', 'WarpModifier', 'deform', 'Warp', 'Warp geometry between two object transforms.', 'bake-required'],
  ['WAVE', 'WaveModifier', 'deform', 'Wave', 'Add animated ripple-like deformation.', 'bake-required'],
  ['VOLUME_DISPLACE', 'VolumeDisplaceModifier', 'deform', 'Volume Displace', 'Deform a volume using noise or vector fields.', 'bake-required'],
  ['GREASE_PENCIL_HOOK', 'GreasePencilHookModifier', 'deform', 'Hook', 'Deform Grease Pencil points using objects.', 'not-applicable'],
  ['GREASE_PENCIL_NOISE', 'GreasePencilNoiseModifier', 'deform', 'Noise', 'Add procedural wobble to Grease Pencil strokes.', 'not-applicable'],
  ['GREASE_PENCIL_OFFSET', 'GreasePencilOffsetModifier', 'deform', 'Offset', 'Change Grease Pencil stroke location, rotation, or scale.', 'not-applicable'],
  ['GREASE_PENCIL_SMOOTH', 'GreasePencilSmoothModifier', 'deform', 'Smooth', 'Smooth Grease Pencil strokes.', 'not-applicable'],
  ['GREASE_PENCIL_THICKNESS', 'GreasePencilThickModifierData', 'deform', 'Thickness', 'Change Grease Pencil stroke thickness.', 'not-applicable'],
  ['GREASE_PENCIL_LATTICE', 'GreasePencilLatticeModifier', 'deform', 'Lattice', 'Deform Grease Pencil strokes with a lattice object.', 'not-applicable'],
  ['GREASE_PENCIL_DASH', 'GreasePencilDashModifierData', 'deform', 'Dot Dash', 'Generate dot-dash styled Grease Pencil strokes.', 'not-applicable'],
  ['GREASE_PENCIL_ARMATURE', 'GreasePencilArmatureModifier', 'deform', 'Armature', 'Deform Grease Pencil points using an armature.', 'not-applicable'],
  ['GREASE_PENCIL_SHRINKWRAP', 'GreasePencilShrinkwrapModifier', 'deform', 'Shrinkwrap', 'Project Grease Pencil strokes onto target geometry.', 'not-applicable'],

  // Simulate (named "Physics" by the API enum)
  ['CLOTH', 'ClothModifier', 'simulate', 'Cloth', 'Mark the stack position and evaluated input for cloth simulation.', 'planned'],
  ['COLLISION', 'CollisionModifier', 'simulate', 'Collision', 'Choose the evaluated collision surface used by physics solvers.', 'planned'],
  ['DYNAMIC_PAINT', 'DynamicPaintModifier', 'simulate', 'Dynamic Paint', 'Evaluate canvas and brush interactions into color, image, or displacement data.', 'planned'],
  ['EXPLODE', 'ExplodeModifier', 'simulate', 'Explode', 'Break mesh faces apart and drive them with particles.', 'planned'],
  ['FLUID', 'FluidModifier', 'simulate', 'Fluid', 'Mark and evaluate geometry for liquid, fire, smoke, or gas simulation.', 'planned'],
  ['OCEAN', 'OceanModifier', 'simulate', 'Ocean', 'Generate an animated ocean surface.', 'live-geometry', 'Studio evaluates a bounded deterministic Phillips/Gerstner displacement subset on existing local-XY geometry. Generated grids, alternate spectra, caches, foam, and spray remain bake boundaries; timeline-driven oceans are excluded from the static RTX triangle scene.'],
  ['PARTICLE_INSTANCE', 'ParticleInstanceModifier', 'simulate', 'Particle Instance', 'Duplicate geometry at particle locations.', 'planned'],
  ['PARTICLE_SYSTEM', 'ParticleSystemModifier', 'simulate', 'Particle System', 'Mark the stack position and evaluated emitter input for particles.', 'planned'],
  ['SOFT_BODY', 'SoftBodyModifier', 'simulate', 'Soft Body', 'Simulate deformable soft-body geometry.', 'planned'],
  ['SURFACE', 'SurfaceModifier', 'simulate', 'Surface', 'Mark the evaluated surface used by legacy particle interaction.', 'planned'],
];

function modifierEntry([
  typeIdentifier,
  rnaType,
  category,
  label,
  purpose,
  status,
  studioNotes = STATUS_NOTES[status],
]) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(typeIdentifier)) {
    throw new TypeError(`Invalid Blender modifier type identifier: ${typeIdentifier}`);
  }
  if (!/^[A-Z][A-Za-z0-9]+$/.test(rnaType)) {
    throw new TypeError(`Invalid Blender modifier RNA type: ${rnaType}`);
  }
  if (!CATEGORY_SET.has(category)) {
    throw new TypeError(`Invalid Blender modifier category: ${category}`);
  }
  if (!STATUS_SET.has(status)) {
    throw new TypeError(`Invalid Blender modifier execution status: ${status}`);
  }
  const id = `blender/modifier/${typeIdentifier.toLowerCase().replaceAll('_', '-')}`;
  return deepFreeze({
    id,
    label,
    category,
    purpose,
    status,
    rnaType,
    rnaIdentifier: `bpy.types.${rnaType}`,
    operatorIdentifier: MODIFIER_ADD_OPERATOR,
    operatorType: typeIdentifier,
    studioNotes,
    officialUrls: [
      BLENDER_MODIFIER_SOURCES.modifierTypeEnum,
      `https://docs.blender.org/api/5.2/bpy.types.${rnaType}.html`,
    ],
  });
}

if (modifierRows.length !== EXPECTED_MODIFIER_COUNT) {
  throw new TypeError(`Expected ${EXPECTED_MODIFIER_COUNT} Blender 5.2 modifier types, received ${modifierRows.length}`);
}

const entries = modifierRows.map(modifierEntry);
const typeIdentifiers = new Set();
const ids = new Set();
for (const entry of entries) {
  if (typeIdentifiers.has(entry.operatorType)) {
    throw new TypeError(`Duplicate Blender modifier operator type: ${entry.operatorType}`);
  }
  if (ids.has(entry.id)) throw new TypeError(`Duplicate Blender modifier ID: ${entry.id}`);
  typeIdentifiers.add(entry.operatorType);
  ids.add(entry.id);
}

const liveRuntimeTypes = entries
  .filter((entry) => entry.status === 'live-runtime')
  .map((entry) => entry.operatorType)
  .sort();
if (liveRuntimeTypes.join(',') !== 'ARRAY,MIRROR') {
  throw new TypeError(`Unexpected live Blender modifier set: ${liveRuntimeTypes.join(',')}`);
}

export const BLENDER_LIVE_GEOMETRY_MODIFIER_TYPES = Object.freeze([
  'DECIMATE', 'DISPLACE', 'EDGE_SPLIT', 'OCEAN', 'SMOOTH', 'SOLIDIFY', 'SUBSURF',
  'TRIANGULATE', 'WEIGHTED_NORMAL', 'WELD',
]);
const liveGeometryTypes = entries
  .filter((entry) => entry.status === 'live-geometry')
  .map((entry) => entry.operatorType)
  .sort();
if (liveGeometryTypes.join(',') !== BLENDER_LIVE_GEOMETRY_MODIFIER_TYPES.join(',')) {
  throw new TypeError(`Unexpected live Blender geometry-modifier set: ${liveGeometryTypes.join(',')}`);
}

const entryMap = Object.freeze(Object.fromEntries(entries.map((entry) => [entry.operatorType, entry])));

export const BLENDER_MODIFIER_INVENTORY = deepFreeze({
  version: BLENDER_MODIFIER_INVENTORY_VERSION,
  blenderVersion: BLENDER_MODIFIER_SOURCES.blenderVersion,
  scope: 'The complete Blender 5.2 Object Modifier Type Items enum and its direct bpy.types.Modifier RNA subclasses.',
  statuses: BLENDER_MODIFIER_EXECUTION_STATUSES,
  categories: BLENDER_MODIFIER_CATEGORIES,
  sources: BLENDER_MODIFIER_SOURCES,
  entries,
  byType: entryMap,
});

function buildSummary() {
  const byStatus = Object.fromEntries(BLENDER_MODIFIER_EXECUTION_STATUSES.map((status) => [status, 0]));
  const byCategory = Object.fromEntries(BLENDER_MODIFIER_CATEGORIES.map((category) => [category, 0]));
  for (const entry of entries) {
    byStatus[entry.status] += 1;
    byCategory[entry.category] += 1;
  }
  return deepFreeze({
    version: BLENDER_MODIFIER_INVENTORY_VERSION,
    blenderVersion: BLENDER_MODIFIER_SOURCES.blenderVersion,
    total: entries.length,
    byStatus,
    byCategory,
  });
}

export const BLENDER_MODIFIER_INVENTORY_SUMMARY = buildSummary();

export function summarizeBlenderModifierInventory() {
  return BLENDER_MODIFIER_INVENTORY_SUMMARY;
}

function normalizeLimit(limit) {
  if (!Number.isInteger(limit)) return DEFAULT_QUERY_RESULTS;
  return Math.max(1, Math.min(MAX_QUERY_RESULTS, limit));
}

function searchText(entry) {
  return [
    entry.id,
    entry.label,
    entry.category,
    entry.purpose,
    entry.status,
    entry.rnaType,
    entry.rnaIdentifier,
    entry.operatorIdentifier,
    entry.operatorType,
    entry.studioNotes,
  ].join(' ').toLowerCase();
}

export function queryBlenderModifierInventory({ search, status, category, limit } = {}) {
  if (status !== undefined && !STATUS_SET.has(status)) {
    throw new TypeError(`Unknown Blender modifier execution status: ${status}`);
  }
  if (category !== undefined && !CATEGORY_SET.has(category)) {
    throw new TypeError(`Unknown Blender modifier category: ${category}`);
  }
  const normalizedSearch = search === undefined ? '' : String(search).trim().toLowerCase().slice(0, 256);
  const matches = entries
    .filter((entry) => status === undefined || entry.status === status)
    .filter((entry) => category === undefined || entry.category === category)
    .filter((entry) => !normalizedSearch || searchText(entry).includes(normalizedSearch))
    .sort((left, right) => left.operatorType.localeCompare(right.operatorType));
  const returnedEntries = matches.slice(0, normalizeLimit(limit));
  return {
    version: BLENDER_MODIFIER_INVENTORY_VERSION,
    blenderVersion: BLENDER_MODIFIER_SOURCES.blenderVersion,
    total: entries.length,
    matched: matches.length,
    returned: returnedEntries.length,
    summary: BLENDER_MODIFIER_INVENTORY_SUMMARY,
    entries: returnedEntries,
  };
}
