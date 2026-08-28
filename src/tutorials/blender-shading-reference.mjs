// Adaptation attribution: “Shading Watering Can” and “Materials & Shader
// Editor” by Beau Gerbrands, copyright Blender Foundation, CC BY 4.0.
// Re-expressed as an independently written ThreeBrowser shader graph with
// changed values, branches, stable IDs, and node layout.
export const BLENDER_SHADING_REFERENCE_SOURCE =
  'https://studio.blender.org/training/blender-fundamentals-45-lts/blender_4-5_lts_shading_watering_can/';

export const BLENDER_PROCEDURAL_SHADING_SOURCE =
  'https://studio.blender.org/training/blender-fundamentals-45-lts/blender_4-5_lts_materials_shader_editor/';

export const BLENDER_WATERING_CAN_SHADER_GRAPH_ID = 'graph/modeling-reference/patina-paint';

/**
 * A Blender-RNA-shaped procedural material: Generated -> Mapping feeds Noise,
 * Voronoi and Wave branches; Color Ramp, Map Range and Linear Light build the
 * PBR maps; Bump and Principled BSDF terminate at Material Output.
 */
export function buildBlenderWateringCanShaderGraph() {
  return {
    formatVersion: 1,
    id: BLENDER_WATERING_CAN_SHADER_GRAPH_ID,
    domain: 'shader',
    nodes: [
      {
        id: 'frame/base-color', type: 'NodeFrame',
        params: { labelSize: 20, shrink: true, text: 'Generated-coordinate pigment gradient' },
        layout: { position: [-1040, 360], dimensions: [500, 360], label: 'Base Color', color: [0.12, 0.28, 0.2] },
      },
      {
        id: 'frame/roughness', type: 'NodeFrame',
        params: { labelSize: 20, shrink: true, text: 'Procedural surface imperfections' },
        layout: { position: [-1040, -80], dimensions: [500, 330], label: 'Roughness', color: [0.18, 0.22, 0.3] },
      },
      {
        id: 'frame/normal', type: 'NodeFrame',
        params: { labelSize: 20, shrink: true, text: 'Layered hammered and rolled-metal bump' },
        layout: { position: [-460, -300], dimensions: [650, 350], label: 'Normal Detail', color: [0.3, 0.18, 0.12] },
      },
      {
        id: 'texture-coordinate', type: 'ShaderNodeTexCoord', params: { fromInstancer: false },
        layout: { position: [-1280, 80], width: 180, label: 'Coordinates' },
      },
      {
        id: 'mapping', type: 'ShaderNodeMapping', params: { vectorType: 'POINT' },
        inputs: { location: [0.11, -0.07, 0.03], rotation: [0.08, -0.12, 0.04], scale: [0.72, 1.15, 0.72] },
        layout: { position: [-980, 300], width: 220, label: 'Patina Mapping', parentFrameId: 'frame/base-color' },
      },
      {
        id: 'paint-noise', type: 'ShaderNodeTexNoise',
        params: { dimensions: '3D', noiseType: 'FBM', normalize: true, seed: 2718 },
        inputs: { scale: 2.8, detail: 5, roughness: 0.66, lacunarity: 2.1, distortion: 0.34 },
        layout: { position: [-740, 300], width: 220, label: 'Pigment Noise', parentFrameId: 'frame/base-color' },
      },
      {
        id: 'paint-ramp', type: 'ShaderNodeValToRGB',
        params: {
          interpolation: 'EASE', colorMode: 'RGB', hueInterpolation: 'NEAR',
          stops: [
            { position: 0, color: [0.018, 0.055, 0.046, 1] },
            { position: 0.29, color: [0.035, 0.19, 0.14, 1] },
            { position: 0.58, color: [0.12, 0.48, 0.34, 1] },
            { position: 0.78, color: [0.44, 0.19, 0.055, 1] },
            { position: 1, color: [0.72, 0.35, 0.09, 1] },
          ],
        },
        layout: { position: [-490, 300], width: 280, label: 'Patina Palette', parentFrameId: 'frame/base-color' },
      },
      {
        id: 'hammered-cells', type: 'ShaderNodeTexVoronoi',
        params: { dimensions: '3D', feature: 'DISTANCE_TO_EDGE', distanceMetric: 'EUCLIDEAN', normalize: true, seed: 1618 },
        inputs: { scale: 18, randomness: 0.88 },
        layout: { position: [-960, -20], width: 220, label: 'Hammered Cells', parentFrameId: 'frame/roughness' },
      },
      {
        id: 'roughness-range', type: 'ShaderNodeMapRange',
        params: { interpolationType: 'SMOOTHSTEP', clamp: true },
        inputs: { fromMin: 0, fromMax: 0.42, toMin: 0.24, toMax: 0.82 },
        layout: { position: [-700, -20], width: 220, label: 'Shine Range', parentFrameId: 'frame/roughness' },
      },
      {
        id: 'rolled-metal-wave', type: 'ShaderNodeTexWave',
        params: { waveType: 'BANDS', bandsDirection: 'Y', ringsDirection: 'X', profile: 'SIN', seed: 3141 },
        inputs: { scale: 22, distortion: 2.1, detail: 3, detailScale: 4.2, detailRoughness: 0.58, phaseOffset: 0.7 },
        layout: { position: [-420, -240], width: 220, label: 'Rolled Metal', parentFrameId: 'frame/normal' },
      },
      {
        id: 'height-linear-light', type: 'ShaderNodeMix',
        params: { valueType: 'float', blendMode: 'LINEAR_LIGHT', clampFactor: true, clampResult: true },
        inputs: { factor: 0.42 },
        layout: { position: [-160, -220], width: 220, label: 'Layer Height', parentFrameId: 'frame/normal' },
      },
      {
        id: 'height-reroute', type: 'NodeReroute', params: { valueType: 'float' },
        layout: { position: [60, -210], width: 80, label: 'Height', parentFrameId: 'frame/normal' },
      },
      {
        id: 'micro-bump', type: 'ShaderNodeBump', params: { invert: false },
        inputs: { strength: 0.24, distance: 0.085 },
        layout: { position: [160, -200], width: 200, label: 'Micro Bump', parentFrameId: 'frame/normal' },
      },
      {
        id: 'principled', type: 'ShaderNodeBsdfPrincipled',
        params: { distribution: 'MULTI_GGX', subsurfaceMethod: 'RANDOM_WALK' },
        inputs: {
          metallic: 0.74,
          ior: 1.46,
          coatWeight: 0.18,
          coatRoughness: 0.22,
          specularIorLevel: 0.48,
          emissionStrength: 0,
        },
        layout: { position: [300, 80], width: 260, label: 'Watering Can Surface' },
      },
      {
        id: 'material-output', type: 'ShaderNodeOutputMaterial', params: { target: 'ALL' },
        layout: { position: [620, 100], width: 200, label: 'Material Output' },
      },
    ],
    edges: [
      { from: { nodeId: 'texture-coordinate', port: 'generated' }, to: { nodeId: 'mapping', port: 'vector' } },
      { from: { nodeId: 'mapping', port: 'vector' }, to: { nodeId: 'paint-noise', port: 'vector' } },
      { from: { nodeId: 'mapping', port: 'vector' }, to: { nodeId: 'hammered-cells', port: 'vector' } },
      { from: { nodeId: 'mapping', port: 'vector' }, to: { nodeId: 'rolled-metal-wave', port: 'vector' } },
      { from: { nodeId: 'paint-noise', port: 'factor' }, to: { nodeId: 'paint-ramp', port: 'factor' } },
      { from: { nodeId: 'hammered-cells', port: 'distance' }, to: { nodeId: 'roughness-range', port: 'value' } },
      { from: { nodeId: 'paint-noise', port: 'factor' }, to: { nodeId: 'height-linear-light', port: 'a' } },
      { from: { nodeId: 'rolled-metal-wave', port: 'factor' }, to: { nodeId: 'height-linear-light', port: 'b' } },
      { from: { nodeId: 'height-linear-light', port: 'result' }, to: { nodeId: 'height-reroute', port: 'input' } },
      { from: { nodeId: 'height-reroute', port: 'output' }, to: { nodeId: 'micro-bump', port: 'height' } },
      { from: { nodeId: 'paint-ramp', port: 'color' }, to: { nodeId: 'principled', port: 'baseColor' } },
      { from: { nodeId: 'roughness-range', port: 'result' }, to: { nodeId: 'principled', port: 'roughness' } },
      { from: { nodeId: 'micro-bump', port: 'normal' }, to: { nodeId: 'principled', port: 'normal' } },
      { from: { nodeId: 'principled', port: 'surface' }, to: { nodeId: 'material-output', port: 'surface' } },
    ],
    outputs: { surface: { nodeId: 'material-output', port: 'surface' } },
  };
}

export function buildBlenderShadingReferenceOperations({ update = false } = {}) {
  const graph = buildBlenderWateringCanShaderGraph();
  const graphResource = {
    id: graph.id,
    kind: 'graph',
    name: 'Blender Patina Paint — Procedural PBR',
    graph,
    metadata: {
      source: BLENDER_SHADING_REFERENCE_SOURCE,
      translatedFrom: 'Blender shader-node workflow',
    },
  };
  return [
    update ? {
      op: 'resource.patch', resourceType: 'graphs', resourceId: graph.id,
      patch: {
        name: graphResource.name,
        graph: graphResource.graph,
        metadata: graphResource.metadata,
      },
    } : {
      op: 'resource.create', resourceType: 'graphs',
      resource: graphResource,
    },
    {
      op: 'resource.patch', resourceType: 'materials',
      resourceId: 'material/modeling-reference/clay',
      patch: {
        name: 'Procedural Patina Watering Can',
        kind: 'physical',
        graphId: graph.id,
        baseColor: [0.08, 0.34, 0.22],
        metalness: 0.7,
        roughness: 0.48,
        clearcoat: 0.15,
        clearcoatRoughness: 0.22,
      },
    },
  ];
}
