// Compatibility metadata of public Blender RNA/API identifiers and functional
// menu placement. The linked GPL-2.0-or-later Python file was consulted as a
// behavioural inventory; no Blender Python implementation is included here.
const OFFICIAL_MENU_SOURCE =
  'https://projects.blender.org/blender/blender/src/branch/blender-v5.2-release/scripts/startup/bl_ui/node_add_menu_shader.py';
const OFFICIAL_API_SOURCE =
  'https://docs.blender.org/api/5.2/bpy.types.ShaderNode.html';
const OFFICIAL_API_DIRECT_SUBCLASS_COUNT = 100;

const CATEGORIES = Object.freeze({
  inputConstant: [
    'FunctionNodeInputBool', 'ShaderNodeRGB', 'FunctionNodeInputInt',
    'FunctionNodeInputMenu', 'ShaderNodeValue', 'FunctionNodeInputVector',
  ],
  input: [
    'ShaderNodeAmbientOcclusion', 'ShaderNodeAttribute', 'ShaderNodeBevel',
    'ShaderNodeCameraData', 'ShaderNodeVertexColor', 'ShaderNodeHairInfo',
    'ShaderNodeFresnel', 'ShaderNodeNewGeometry', 'ShaderNodeLayerWeight',
    'ShaderNodeLightPath', 'ShaderNodeObjectInfo', 'ShaderNodeParticleInfo',
    'ShaderNodePointInfo', 'ShaderNodeRaycast', 'ShaderNodeTangent',
    'ShaderNodeTexCoord', 'ShaderNodeUVAlongStroke', 'ShaderNodeUVMap',
    'ShaderNodeVolumeInfo', 'ShaderNodeWireframe',
  ],
  output: [
    'ShaderNodeOutputAOV', 'ShaderNodeOutputLight', 'ShaderNodeOutputLineStyle',
    'ShaderNodeOutputMaterial', 'ShaderNodeOutputWorld',
  ],
  shader: [
    'ShaderNodeAddShader', 'ShaderNodeMixShader', 'ShaderNodeBackground',
    'ShaderNodeBsdfDiffuse', 'ShaderNodeEmission', 'ShaderNodeBsdfGlass',
    'ShaderNodeBsdfAnisotropic', 'ShaderNodeBsdfHair', 'ShaderNodeHoldout',
    'ShaderNodeBsdfMetallic', 'ShaderNodeBsdfPrincipled',
    'ShaderNodeBsdfHairPrincipled', 'ShaderNodeBsdfRayPortal',
    'ShaderNodeBsdfRefraction', 'ShaderNodeBsdfSheen', 'ShaderNodeEeveeSpecular',
    'ShaderNodeSubsurfaceScattering', 'ShaderNodeBsdfToon',
    'ShaderNodeBsdfTranslucent', 'ShaderNodeBsdfTransparent',
    'ShaderNodeVolumePrincipled', 'ShaderNodeVolumeAbsorption',
    'ShaderNodeVolumeScatter', 'ShaderNodeVolumeCoefficients',
  ],
  displacement: [
    'ShaderNodeBump', 'ShaderNodeDisplacement', 'ShaderNodeNormalMap',
    'ShaderNodeVectorDisplacement',
  ],
  color: [
    'ShaderNodeBlackbody', 'ShaderNodeBrightContrast', 'ShaderNodeValToRGB',
    'ShaderNodeGamma', 'ShaderNodeHueSaturation', 'ShaderNodeInvert',
    'ShaderNodeLightFalloff', 'ShaderNodeMix', 'ShaderNodeRGBCurve',
    'ShaderNodeWavelength', 'ShaderNodeCombineColor', 'ShaderNodeSeparateColor',
    'ShaderNodeRGBToBW', 'ShaderNodeShaderToRGB',
  ],
  texture: [
    'ShaderNodeTexBrick', 'ShaderNodeTexChecker', 'ShaderNodeTexEnvironment',
    'ShaderNodeTexGabor', 'ShaderNodeTexGradient', 'ShaderNodeTexIES',
    'ShaderNodeTexImage', 'ShaderNodeTexMagic', 'ShaderNodeTexNoise',
    'ShaderNodeTexSky', 'ShaderNodeTexVoronoi', 'ShaderNodeTexWave',
    'ShaderNodeTexWhiteNoise',
  ],
  utilitiesVector: [
    'ShaderNodeCombineXYZ', 'ShaderNodeMapRange', 'ShaderNodeMix',
    'ShaderNodeSeparateXYZ', 'ShaderNodeMapping', 'ShaderNodeNormal',
    'ShaderNodeRadialTiling', 'ShaderNodeVectorCurve', 'ShaderNodeVectorMath',
    'ShaderNodeVectorRotate', 'ShaderNodeVectorTransform',
  ],
  utilitiesMath: [
    'ShaderNodeClamp', 'ShaderNodeFloatCurve', 'ShaderNodeMapRange',
    'ShaderNodeMath', 'ShaderNodeMix',
  ],
  utilities: [
    'GeometryNodeRepeatInput', 'GeometryNodeRepeatOutput', 'NodeImplicitConversion',
    'NodeClosureInput', 'NodeClosureOutput', 'NodeEvaluateClosure',
    'NodeCombineBundle', 'NodeSeparateBundle', 'NodeJoinBundle',
    'GeometryNodeMenuSwitch', 'ShaderNodeScript',
  ],
  group: ['NodeGroupInput', 'NodeGroupOutput', 'ShaderNodeGroup'],
  layout: ['NodeFrame', 'NodeReroute'],
  // Registered RNA classes which exist in the 5.2 Python API but are not
  // ordinary entries in Blender's Shader Editor Add menu.
  apiOnly: ['ShaderNodeCustomGroup', 'ShaderNodeSqueeze'],
});

const LIVE_TSL_IDS = new Set([
  'NodeReroute',
  'FunctionNodeInputInt', 'FunctionNodeInputVector',
  'ShaderNodeRGB', 'ShaderNodeValue', 'ShaderNodeAttribute',
  'ShaderNodeCameraData', 'ShaderNodeVertexColor', 'ShaderNodeFresnel', 'ShaderNodeLayerWeight',
  'ShaderNodeTexCoord', 'ShaderNodeOutputMaterial', 'ShaderNodeBsdfPrincipled',
  'ShaderNodeBump', 'ShaderNodeDisplacement', 'ShaderNodeNormal', 'ShaderNodeNormalMap',
  'ShaderNodeVectorDisplacement', 'ShaderNodeVectorRotate', 'ShaderNodeBrightContrast',
  'ShaderNodeValToRGB', 'ShaderNodeGamma', 'ShaderNodeHueSaturation',
  'ShaderNodeInvert', 'ShaderNodeMix', 'ShaderNodeRGBToBW', 'ShaderNodeCombineColor',
  'ShaderNodeSeparateColor', 'ShaderNodeTexNoise', 'ShaderNodeTexVoronoi',
  'ShaderNodeTexWave', 'ShaderNodeTexChecker', 'ShaderNodeTexGradient',
  'ShaderNodeTexWhiteNoise', 'ShaderNodeTexMagic', 'ShaderNodeTexBrick',
  'ShaderNodeCombineXYZ', 'ShaderNodeSeparateXYZ',
  'ShaderNodeMapping', 'ShaderNodeVectorMath', 'ShaderNodeClamp',
  'ShaderNodeMapRange', 'ShaderNodeMath',
]);

const CONTEXT_RESTRICTIONS = Object.freeze({
  ShaderNodeBevel: ['cycles'],
  ShaderNodeScript: ['cycles'],
  ShaderNodeShaderToRGB: ['eevee'],
  ShaderNodeEeveeSpecular: ['eevee'],
  ShaderNodeOutputLight: ['light', 'cycles'],
  ShaderNodeOutputWorld: ['world'],
  ShaderNodeOutputLineStyle: ['freestyle'],
  ShaderNodeUVAlongStroke: ['freestyle'],
});

const byId = new Map();
for (const [category, ids] of Object.entries(CATEGORIES)) {
  for (const id of ids) {
    const existing = byId.get(id);
    if (existing) {
      existing.categories.push(category);
      continue;
    }
    byId.set(id, {
      id,
      categories: [category],
      status: LIVE_TSL_IDS.has(id)
        ? 'live-tsl'
        : ['NodeFrame', 'NodeReroute'].includes(id)
          ? 'layout-only'
          : category === 'apiOnly'
            ? 'api-only'
            : 'catalogued',
      contexts: CONTEXT_RESTRICTIONS[id] ?? ['material', 'world'],
      blenderVersions: ['4.5', '5.2'],
      officialSource: category === 'apiOnly' ? OFFICIAL_API_SOURCE : OFFICIAL_MENU_SOURCE,
    });
  }
}

for (const entry of [
  { id: 'ShaderNodeMixRGB', replacement: 'ShaderNodeMix', note: 'Mix (Legacy); current Mix Color uses ShaderNodeMix with RGBA data type.' },
  { id: 'ShaderNodeBsdfGlossy', replacement: 'ShaderNodeBsdfAnisotropic', note: 'Legacy RNA/menu alias for Glossy BSDF.' },
  { id: 'ShaderNodeTexMusgrave', replacement: 'ShaderNodeTexNoise', note: 'Removed; migrate deliberately to Noise Texture.' },
]) {
  byId.set(entry.id, {
    ...entry,
    categories: ['legacyImport'],
    status: entry.id === 'ShaderNodeMixRGB' ? 'live-tsl' : 'migration-required',
    contexts: ['material', 'world'],
    blenderVersions: ['legacy'],
    officialSource: OFFICIAL_MENU_SOURCE,
  });
}

export const BLENDER_SHADER_NODE_INVENTORY = Object.freeze(
  [...byId.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(entry => Object.freeze({
      ...entry,
      categories: Object.freeze(entry.categories),
      contexts: Object.freeze(entry.contexts),
      blenderVersions: Object.freeze(entry.blenderVersions),
    })),
);

export const BLENDER_SHADER_NODE_INVENTORY_SUMMARY = Object.freeze({
  blenderVersion: '5.2',
  total: BLENDER_SHADER_NODE_INVENTORY.length,
  apiDirectSubclasses: OFFICIAL_API_DIRECT_SUBCLASS_COUNT,
  currentMenu: BLENDER_SHADER_NODE_INVENTORY.filter(entry => !entry.categories.includes('legacyImport') && !entry.categories.includes('apiOnly')).length,
  liveTsl: BLENDER_SHADER_NODE_INVENTORY.filter(entry => entry.status === 'live-tsl').length,
  layoutOnly: BLENDER_SHADER_NODE_INVENTORY.filter(entry => entry.status === 'layout-only').length,
  apiOnly: BLENDER_SHADER_NODE_INVENTORY.filter(entry => entry.status === 'api-only').length,
  catalogued: BLENDER_SHADER_NODE_INVENTORY.filter(entry => entry.status === 'catalogued').length,
  migrationRequired: BLENDER_SHADER_NODE_INVENTORY.filter(entry => entry.status === 'migration-required').length,
  officialSource: OFFICIAL_MENU_SOURCE,
  officialApiSource: OFFICIAL_API_SOURCE,
});

export function queryBlenderShaderNodeInventory({ search = '', status, category, limit = 200 } = {}) {
  const needle = String(search).trim().toLowerCase();
  const boundedLimit = Math.max(1, Math.min(200, Number.isSafeInteger(limit) ? limit : 200));
  const nodes = BLENDER_SHADER_NODE_INVENTORY
    .filter(entry => !status || entry.status === status)
    .filter(entry => !category || entry.categories.includes(category))
    .filter(entry => !needle || `${entry.id} ${entry.categories.join(' ')} ${entry.note ?? ''} ${entry.replacement ?? ''}`.toLowerCase().includes(needle))
    .slice(0, boundedLimit);
  return { ...BLENDER_SHADER_NODE_INVENTORY_SUMMARY, returned: nodes.length, nodes };
}
