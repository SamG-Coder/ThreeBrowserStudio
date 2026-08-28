// Adaptation attribution: “Rainy Window (Chapter 6+)” by Simon Thommes,
// copyright Blender Foundation, CC BY 4.0. Re-expressed as independently
// written typed ThreeBrowser operations, procedural shader graphs, geometry,
// lighting, and animation. No Blender source file or tutorial media is bundled.
export const BLENDER_RAINY_WINDOW_SOURCE =
  'https://studio.blender.org/training/procedural-shading/5f5263c76a8a7b3ac5015588/';
export const BLENDER_RAINY_WINDOW_LICENSE = 'https://creativecommons.org/licenses/by/4.0/';
export const BLENDER_RAINY_WINDOW_AUTHOR = 'Simon Thommes';

export const BLENDER_RAINY_WINDOW_WOOD_GRAPH_ID = 'graph/rainy-window/aged-wood';
export const BLENDER_RAINY_WINDOW_GLASS_GRAPH_ID = 'graph/rainy-window/rain-glass';
export const BLENDER_RAINY_WINDOW_ACTION_ID = 'animation/rainy-window/showcase';

const transform = (position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) => ({
  position, rotation, scale,
});

const resource = (resourceType, value) => ({ op: 'resource.create', resourceType, resource: value });
const entity = value => ({ op: 'entity.create', sceneId: 'scene/main', entity: value });

const mesh = ({ id, name, parentId, geometryId, materialId, position, rotation, scale, castShadow = true, receiveShadow = true }) => entity({
  id, kind: 'mesh', name, parentId,
  transform: transform(position, rotation, scale),
  components: {
    mesh: { geometryId, materialIds: [materialId], castShadow, receiveShadow },
  },
});

function frame(label, position, dimensions, color) {
  return {
    id: `frame/${label.toLowerCase().replaceAll(' ', '-')}`,
    type: 'NodeFrame',
    params: { labelSize: 20, shrink: true, text: label },
    layout: { position, dimensions, label, color },
  };
}

export function buildRainyWindowWoodGraph() {
  return {
    formatVersion: 1,
    id: BLENDER_RAINY_WINDOW_WOOD_GRAPH_ID,
    domain: 'shader',
    nodes: [
      frame('Warped Grain', [-1080, 280], [760, 420], [0.22, 0.105, 0.035]),
      frame('Surface Wear', [-1080, -220], [760, 390], [0.12, 0.08, 0.045]),
      { id: 'coordinate', type: 'ShaderNodeTexCoord', params: { fromInstancer: false }, layout: { position: [-1320, 60], width: 180, label: 'Generated' } },
      {
        id: 'mapping', type: 'ShaderNodeMapping', params: { vectorType: 'POINT' },
        inputs: { location: [0.13, -0.08, 0.04], rotation: [0.08, 0.02, -0.04], scale: [2.2, 8.5, 2.4] },
        layout: { position: [-1020, 430], width: 220, label: 'Grain Direction', parentFrameId: 'frame/warped-grain' },
      },
      {
        id: 'grain-noise', type: 'ShaderNodeTexNoise',
        params: { dimensions: '3D', noiseType: 'FBM', normalize: true, seed: 1947 },
        inputs: { scale: 2.7, detail: 6, roughness: 0.72, lacunarity: 2.1, distortion: 1.4 },
        layout: { position: [-760, 460], width: 220, label: 'Knotted Warp', parentFrameId: 'frame/warped-grain' },
      },
      {
        id: 'grain-wave', type: 'ShaderNodeTexWave',
        params: { waveType: 'BANDS', bandsDirection: 'Y', ringsDirection: 'X', profile: 'SIN', seed: 8128 },
        inputs: { scale: 2.8, distortion: 2.4, detail: 5, detailScale: 2.8, detailRoughness: 0.68, phaseOffset: 0.32 },
        layout: { position: [-760, 250], width: 220, label: 'Long Grain', parentFrameId: 'frame/warped-grain' },
      },
      {
        id: 'grain-combine', type: 'ShaderNodeMix',
        params: { valueType: 'float', blendMode: 'MIX', clampFactor: true, clampResult: true },
        inputs: { factor: 0.44 },
        layout: { position: [-500, 370], width: 220, label: 'Warp Grain', parentFrameId: 'frame/warped-grain' },
      },
      {
        id: 'wood-palette', type: 'ShaderNodeValToRGB',
        params: {
          interpolation: 'EASE', colorMode: 'RGB', hueInterpolation: 'NEAR',
          stops: [
            { position: 0, color: [0.01, 0.006, 0.003, 1] },
            { position: 0.2, color: [0.027, 0.014, 0.006, 1] },
            { position: 0.48, color: [0.07, 0.034, 0.013, 1] },
            { position: 0.7, color: [0.15, 0.075, 0.027, 1] },
            { position: 0.89, color: [0.055, 0.028, 0.011, 1] },
            { position: 1, color: [0.22, 0.12, 0.045, 1] },
          ],
        },
        layout: { position: [-245, 370], width: 280, label: 'Aged Timber', parentFrameId: 'frame/warped-grain' },
      },
      {
        id: 'wear-cells', type: 'ShaderNodeTexVoronoi',
        params: { dimensions: '3D', feature: 'DISTANCE_TO_EDGE', distanceMetric: 'EUCLIDEAN', normalize: true, seed: 2718 },
        inputs: { scale: 24, randomness: 0.78 },
        layout: { position: [-790, -90], width: 220, label: 'Pores', parentFrameId: 'frame/surface-wear' },
      },
      {
        id: 'roughness', type: 'ShaderNodeMapRange', params: { interpolationType: 'SMOOTHERSTEP', clamp: true },
        inputs: { fromMin: 0, fromMax: 0.4, toMin: 0.34, toMax: 0.88 },
        layout: { position: [-520, -90], width: 220, label: 'Weathered Roughness', parentFrameId: 'frame/surface-wear' },
      },
      {
        id: 'grain-bump', type: 'ShaderNodeBump', params: { invert: false }, inputs: { strength: 0.24, distance: 0.055 },
        layout: { position: [-250, -120], width: 210, label: 'Carved Grain', parentFrameId: 'frame/surface-wear' },
      },
      {
        id: 'principled', type: 'ShaderNodeBsdfPrincipled', params: { distribution: 'MULTI_GGX', subsurfaceMethod: 'RANDOM_WALK' },
        inputs: { metallic: 0.02, ior: 1.46, coatWeight: 0.14, coatRoughness: 0.25, specularIorLevel: 0.4, emissionStrength: 0 },
        layout: { position: [160, 130], width: 280, label: 'Rain-darkened Wood' },
      },
      { id: 'output', type: 'ShaderNodeOutputMaterial', params: { target: 'ALL' }, layout: { position: [520, 150], width: 200, label: 'Material Output' } },
    ],
    edges: [
      { from: { nodeId: 'coordinate', port: 'generated' }, to: { nodeId: 'mapping', port: 'vector' } },
      { from: { nodeId: 'mapping', port: 'vector' }, to: { nodeId: 'grain-noise', port: 'vector' } },
      { from: { nodeId: 'mapping', port: 'vector' }, to: { nodeId: 'grain-wave', port: 'vector' } },
      { from: { nodeId: 'mapping', port: 'vector' }, to: { nodeId: 'wear-cells', port: 'vector' } },
      { from: { nodeId: 'grain-noise', port: 'factor' }, to: { nodeId: 'grain-combine', port: 'a' } },
      { from: { nodeId: 'grain-wave', port: 'factor' }, to: { nodeId: 'grain-combine', port: 'b' } },
      { from: { nodeId: 'grain-combine', port: 'result' }, to: { nodeId: 'wood-palette', port: 'factor' } },
      { from: { nodeId: 'wear-cells', port: 'distance' }, to: { nodeId: 'roughness', port: 'value' } },
      { from: { nodeId: 'grain-combine', port: 'result' }, to: { nodeId: 'grain-bump', port: 'height' } },
      { from: { nodeId: 'wood-palette', port: 'color' }, to: { nodeId: 'principled', port: 'baseColor' } },
      { from: { nodeId: 'roughness', port: 'result' }, to: { nodeId: 'principled', port: 'roughness' } },
      { from: { nodeId: 'grain-bump', port: 'normal' }, to: { nodeId: 'principled', port: 'normal' } },
      { from: { nodeId: 'principled', port: 'surface' }, to: { nodeId: 'output', port: 'surface' } },
    ],
    outputs: { surface: { nodeId: 'output', port: 'surface' } },
  };
}

export function buildRainyWindowGlassGraph() {
  return {
    formatVersion: 1,
    id: BLENDER_RAINY_WINDOW_GLASS_GRAPH_ID,
    domain: 'shader',
    nodes: [
      frame('Droplet Field', [-1180, 360], [850, 430], [0.03, 0.16, 0.25]),
      frame('Gravity Trails', [-1180, -120], [850, 380], [0.04, 0.11, 0.2]),
      frame('Wet Surface', [-230, 30], [620, 460], [0.02, 0.2, 0.28]),
      { id: 'coordinate', type: 'ShaderNodeTexCoord', params: { fromInstancer: false }, layout: { position: [-1400, 90], width: 180, label: 'Generated' } },
      {
        id: 'mapping', type: 'ShaderNodeMapping', params: { vectorType: 'POINT' },
        inputs: { location: [0.07, -0.12, 0], rotation: [0, 0, 0.035], scale: [1, 1.18, 1] },
        layout: { position: [-1120, 470], width: 220, label: 'Pane Coordinates', parentFrameId: 'frame/droplet-field' },
      },
      {
        id: 'large-drops', type: 'ShaderNodeTexVoronoi',
        params: { dimensions: '2D', feature: 'F1', distanceMetric: 'EUCLIDEAN', normalize: true, seed: 4069 },
        inputs: { scale: 11, randomness: 0.92 },
        layout: { position: [-850, 520], width: 220, label: 'Large Beads', parentFrameId: 'frame/droplet-field' },
      },
      {
        id: 'large-mask', type: 'ShaderNodeMapRange', params: { interpolationType: 'SMOOTHERSTEP', clamp: true },
        inputs: { fromMin: 0, fromMax: 0.24, toMin: 1, toMax: 0 },
        layout: { position: [-590, 520], width: 220, label: 'Bead Profile', parentFrameId: 'frame/droplet-field' },
      },
      {
        id: 'small-drops', type: 'ShaderNodeTexVoronoi',
        params: { dimensions: '2D', feature: 'F1', distanceMetric: 'EUCLIDEAN', normalize: true, seed: 7057 },
        inputs: { scale: 34, randomness: 0.76 },
        layout: { position: [-850, 310], width: 220, label: 'Fine Beads', parentFrameId: 'frame/droplet-field' },
      },
      {
        id: 'small-mask', type: 'ShaderNodeMapRange', params: { interpolationType: 'SMOOTHSTEP', clamp: true },
        inputs: { fromMin: 0, fromMax: 0.14, toMin: 1, toMax: 0 },
        layout: { position: [-590, 310], width: 220, label: 'Micro Bead Profile', parentFrameId: 'frame/droplet-field' },
      },
      {
        id: 'beads', type: 'ShaderNodeMix', params: { valueType: 'float', blendMode: 'ADD', clampFactor: true, clampResult: true },
        inputs: { factor: 1 }, layout: { position: [-340, 430], width: 220, label: 'Combine Beads', parentFrameId: 'frame/droplet-field' },
      },
      {
        id: 'trail-wave', type: 'ShaderNodeTexWave',
        params: { waveType: 'BANDS', bandsDirection: 'X', ringsDirection: 'Z', profile: 'SIN', seed: 9311 },
        inputs: { scale: 12, distortion: 4.8, detail: 5, detailScale: 3.1, detailRoughness: 0.74, phaseOffset: 0.18 },
        layout: { position: [-880, 40], width: 220, label: 'Vertical Channels', parentFrameId: 'frame/gravity-trails' },
      },
      {
        id: 'trail-noise', type: 'ShaderNodeTexNoise',
        params: { dimensions: '2D', noiseType: 'FBM', normalize: true, seed: 1201 },
        inputs: { scale: 5.5, detail: 7, roughness: 0.78, lacunarity: 2.2, distortion: 1.25 },
        layout: { position: [-880, -155], width: 220, label: 'Broken Flow', parentFrameId: 'frame/gravity-trails' },
      },
      {
        id: 'trails', type: 'ShaderNodeMix', params: { valueType: 'float', blendMode: 'MULTIPLY', clampFactor: true, clampResult: true },
        inputs: { factor: 1 }, layout: { position: [-610, -45], width: 220, label: 'Rivulet Mask', parentFrameId: 'frame/gravity-trails' },
      },
      {
        id: 'rain-height', type: 'ShaderNodeMix', params: { valueType: 'float', blendMode: 'ADD', clampFactor: true, clampResult: true },
        inputs: { factor: 0.62 }, layout: { position: [-300, 60], width: 220, label: 'Rain Height', parentFrameId: 'frame/wet-surface' },
      },
      {
        id: 'rain-bump', type: 'ShaderNodeBump', params: { invert: false }, inputs: { strength: 0.72, distance: 0.095 },
        layout: { position: [-45, 80], width: 220, label: 'Droplet Normals', parentFrameId: 'frame/wet-surface' },
      },
      {
        id: 'rain-roughness', type: 'ShaderNodeMapRange', params: { interpolationType: 'SMOOTHERSTEP', clamp: true },
        inputs: { fromMin: 0, fromMax: 1, toMin: 0.19, toMax: 0.035 },
        layout: { position: [-45, 290], width: 220, label: 'Wet Roughness', parentFrameId: 'frame/wet-surface' },
      },
      { id: 'glass-tint', type: 'ShaderNodeRGB', params: { value: [0.04, 0.1, 0.16, 1] }, layout: { position: [-20, 500], width: 180, label: 'Storm Tint' } },
      {
        id: 'principled', type: 'ShaderNodeBsdfPrincipled', params: { distribution: 'MULTI_GGX', subsurfaceMethod: 'RANDOM_WALK' },
        inputs: {
          metallic: 0, ior: 1.45, transmissionWeight: 0.94, alpha: 0.38,
          coatWeight: 0.86, coatRoughness: 0.045, specularIorLevel: 0.52,
          emissionColor: [0.01, 0.025, 0.045, 1], emissionStrength: 0.18,
        },
        layout: { position: [420, 170], width: 290, label: 'Rain Glass' },
      },
      { id: 'output', type: 'ShaderNodeOutputMaterial', params: { target: 'ALL' }, layout: { position: [780, 190], width: 200, label: 'Material Output' } },
    ],
    edges: [
      { from: { nodeId: 'coordinate', port: 'generated' }, to: { nodeId: 'mapping', port: 'vector' } },
      { from: { nodeId: 'mapping', port: 'vector' }, to: { nodeId: 'large-drops', port: 'vector' } },
      { from: { nodeId: 'mapping', port: 'vector' }, to: { nodeId: 'small-drops', port: 'vector' } },
      { from: { nodeId: 'mapping', port: 'vector' }, to: { nodeId: 'trail-wave', port: 'vector' } },
      { from: { nodeId: 'mapping', port: 'vector' }, to: { nodeId: 'trail-noise', port: 'vector' } },
      { from: { nodeId: 'large-drops', port: 'distance' }, to: { nodeId: 'large-mask', port: 'value' } },
      { from: { nodeId: 'small-drops', port: 'distance' }, to: { nodeId: 'small-mask', port: 'value' } },
      { from: { nodeId: 'large-mask', port: 'result' }, to: { nodeId: 'beads', port: 'a' } },
      { from: { nodeId: 'small-mask', port: 'result' }, to: { nodeId: 'beads', port: 'b' } },
      { from: { nodeId: 'trail-wave', port: 'factor' }, to: { nodeId: 'trails', port: 'a' } },
      { from: { nodeId: 'trail-noise', port: 'factor' }, to: { nodeId: 'trails', port: 'b' } },
      { from: { nodeId: 'beads', port: 'result' }, to: { nodeId: 'rain-height', port: 'a' } },
      { from: { nodeId: 'trails', port: 'result' }, to: { nodeId: 'rain-height', port: 'b' } },
      { from: { nodeId: 'rain-height', port: 'result' }, to: { nodeId: 'rain-bump', port: 'height' } },
      { from: { nodeId: 'rain-height', port: 'result' }, to: { nodeId: 'rain-roughness', port: 'value' } },
      { from: { nodeId: 'glass-tint', port: 'color' }, to: { nodeId: 'principled', port: 'baseColor' } },
      { from: { nodeId: 'rain-roughness', port: 'result' }, to: { nodeId: 'principled', port: 'roughness' } },
      { from: { nodeId: 'rain-bump', port: 'normal' }, to: { nodeId: 'principled', port: 'normal' } },
      { from: { nodeId: 'principled', port: 'surface' }, to: { nodeId: 'output', port: 'surface' } },
    ],
    outputs: { surface: { nodeId: 'output', port: 'surface' } },
  };
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function panePoint(random, index) {
  const pane = index % 4;
  const left = pane % 2 === 0;
  const upper = pane > 1;
  const x = left ? -2.72 + random() * 2.35 : 0.37 + random() * 2.35;
  const y = upper ? 3.72 + random() * 2.48 : 0.62 + random() * 2.48;
  return [x, y];
}

export function buildRainyWindowOperations() {
  const woodGraph = buildRainyWindowWoodGraph();
  const glassGraph = buildRainyWindowGlassGraph();
  const sourceMetadata = {
    source: BLENDER_RAINY_WINDOW_SOURCE,
    author: BLENDER_RAINY_WINDOW_AUTHOR,
    license: 'CC BY 4.0',
    licenseUrl: BLENDER_RAINY_WINDOW_LICENSE,
    adaptation: 'Rebuilt as typed ThreeBrowser geometry, Blender-shaped shader graphs, lighting, and animation.',
  };

  const geometries = [
    ['frame-rail', { kind: 'box', width: 0.56, height: 6.9, depth: 0.5, widthSegments: 4, heightSegments: 12, depthSegments: 3 }],
    ['inner-rail', { kind: 'box', width: 0.24, height: 5.9, depth: 0.31, widthSegments: 3, heightSegments: 10, depthSegments: 2 }],
    ['trim', { kind: 'box', width: 0.1, height: 6.25, depth: 0.11, widthSegments: 2, heightSegments: 10, depthSegments: 2 }],
    ['sill', { kind: 'box', width: 7.5, height: 0.38, depth: 1.25, widthSegments: 8, heightSegments: 2, depthSegments: 4 }],
    ['glass', { kind: 'plane', width: 5.9, height: 5.9, widthSegments: 1, heightSegments: 1 }],
    ['outside', { kind: 'plane', width: 11, height: 8.5, widthSegments: 1, heightSegments: 1 }],
    ['droplet', { kind: 'sphere', radius: 0.066, widthSegments: 24, heightSegments: 16 }],
    ['rivulet', { kind: 'tube', radius: 0.018, radialSegments: 8, tubularSegments: 32, curveType: 'centripetal', points: [[0, -0.34, 0], [-0.025, -0.12, 0], [0.018, 0.12, 0], [-0.012, 0.34, 0]] }],
    ['bokeh', { kind: 'sphere', radius: 0.11, widthSegments: 24, heightSegments: 16 }],
    ['branch-a', { kind: 'tube', radius: 0.055, radialSegments: 9, tubularSegments: 96, curveType: 'centripetal', points: [[-3.8, -1.1, 0], [-2.8, -0.2, 0.05], [-2, 1.15, 0.12], [-0.8, 2.1, 0.08], [0.4, 3.15, 0.18], [1.55, 3.8, 0.12]] }],
    ['branch-b', { kind: 'tube', radius: 0.04, radialSegments: 8, tubularSegments: 80, curveType: 'centripetal', points: [[-0.5, -0.8, 0], [0.2, 0.2, 0.06], [1.1, 1, 0.03], [2, 1.45, 0.08], [3.2, 2.2, 0.04]] }],
  ].map(([id, recipe]) => resource('geometries', {
    id: `geometry/rainy-window/${id}`, kind: 'geometry', name: id, recipe,
  }));

  const graphs = [
    resource('graphs', { id: woodGraph.id, kind: 'graph', name: 'Aged Rain-darkened Wood', graph: woodGraph, metadata: sourceMetadata }),
    resource('graphs', { id: glassGraph.id, kind: 'graph', name: 'Procedural Rain Glass', graph: glassGraph, metadata: sourceMetadata }),
  ];

  const materials = [
    resource('materials', {
      id: 'material/rainy-window/wood', kind: 'physical', name: 'Aged Procedural Timber', graphId: woodGraph.id,
      baseColor: [0.075, 0.035, 0.012], metalness: 0.02, roughness: 0.68, clearcoat: 0.08, clearcoatRoughness: 0.3,
    }),
    resource('materials', {
      id: 'material/rainy-window/glass', kind: 'physical', name: 'Procedural Rain Glass', graphId: glassGraph.id,
      baseColor: [0.04, 0.1, 0.16], metalness: 0, roughness: 0.085, transmission: 0.94, thickness: 0.055,
      ior: 1.45, opacity: 0.38, transparent: true, side: 'double', clearcoat: 0.82, clearcoatRoughness: 0.035,
    }),
    resource('materials', {
      id: 'material/rainy-window/mist', kind: 'basic', name: 'Cold Condensation Veil',
      baseColor: [0.08, 0.18, 0.3], opacity: 0.2, transparent: true, side: 'double',
    }),
    resource('materials', {
      id: 'material/rainy-window/water', kind: 'physical', name: 'Raised Water Beads',
      baseColor: [0.06, 0.22, 0.36], metalness: 0, roughness: 0.02, transmission: 0.92, thickness: 0.035,
      ior: 1.33, opacity: 0.56, transparent: true, clearcoat: 1, clearcoatRoughness: 0.015,
    }),
    resource('materials', {
      id: 'material/rainy-window/night', kind: 'standard', name: 'Storm Night',
      baseColor: [0.028, 0.065, 0.14], emissive: [0.005, 0.018, 0.045], emissiveIntensity: 0.7,
      metalness: 0.06, roughness: 0.86, side: 'double',
    }),
    resource('materials', { id: 'material/rainy-window/branch', kind: 'standard', name: 'Wet Branch Silhouette', baseColor: [0.006, 0.009, 0.012], metalness: 0, roughness: 0.95 }),
    resource('materials', { id: 'material/rainy-window/bokeh-amber', kind: 'physical', name: 'Amber Bokeh', baseColor: [0.42, 0.095, 0.018], emissive: [0.6, 0.05, 0.004], emissiveIntensity: 2.4, roughness: 0.18 }),
    resource('materials', { id: 'material/rainy-window/bokeh-cyan', kind: 'physical', name: 'Cyan Bokeh', baseColor: [0.012, 0.18, 0.32], emissive: [0.004, 0.16, 0.48], emissiveIntensity: 2.1, roughness: 0.16 }),
    resource('materials', { id: 'material/rainy-window/bokeh-rose', kind: 'physical', name: 'Rose Bokeh', baseColor: [0.32, 0.018, 0.065], emissive: [0.48, 0.004, 0.055], emissiveIntensity: 2.2, roughness: 0.16 }),
    resource('materials', { id: 'material/rainy-window/iron', kind: 'physical', name: 'Wet Iron Trim', baseColor: [0.018, 0.026, 0.035], metalness: 0.84, roughness: 0.28, clearcoat: 0.32, clearcoatRoughness: 0.16 }),
  ];

  const animation = resource('animations', {
    id: BLENDER_RAINY_WINDOW_ACTION_ID, kind: 'animation', name: 'Rainy Window Showcase',
    formatVersion: 1, enabled: true, autoplay: true, fps: 24,
    frameStart: 0, frameEnd: 672, loop: 'once', speed: 1,
    metadata: sourceMetadata,
    tracks: [
      {
        targetId: 'entity/rainy-window/camera', property: 'transform.position', interpolation: 'bezier',
        keyframes: [
          { frame: 0, value: [4.2, 4.6, 15.5] },
          { frame: 108, value: [2.8, 4.15, 12.6] },
          { frame: 240, value: [0.3, 3.8, 9.5] },
          { frame: 390, value: [-3.1, 4.05, 11.8] },
          { frame: 528, value: [-0.5, 3.55, 8.7] },
          { frame: 672, value: [3.8, 4.5, 14.5] },
        ],
      },
      {
        targetId: 'entity/rainy-window/rain-a', property: 'transform.position', interpolation: 'smooth',
        keyframes: [{ frame: 0, value: [0, 0.18, 0] }, { frame: 220, value: [0, -0.18, 0] }, { frame: 480, value: [0, -0.72, 0] }, { frame: 672, value: [0, -1.1, 0] }],
      },
      {
        targetId: 'entity/rainy-window/rain-b', property: 'transform.position', interpolation: 'smooth',
        keyframes: [{ frame: 0, value: [0, 0.42, 0] }, { frame: 280, value: [0, 0, 0] }, { frame: 672, value: [0, -1, 0] }],
      },
      {
        targetId: 'entity/rainy-window/rain-c', property: 'transform.position', interpolation: 'smooth',
        keyframes: [{ frame: 0, value: [0, 0.68, 0] }, { frame: 160, value: [0, 0.38, 0] }, { frame: 460, value: [0, -0.2, 0] }, { frame: 672, value: [0, -0.8, 0] }],
      },
      {
        targetId: 'entity/rainy-window/bokeh', property: 'transform.rotation', interpolation: 'smooth',
        keyframes: [{ frame: 0, value: [0, -0.08, 0] }, { frame: 336, value: [0.03, 0.08, -0.02] }, { frame: 672, value: [0, -0.08, 0] }],
      },
    ],
  });

  const objects = [
    entity({
      id: 'entity/rainy-window/showcase', kind: 'group', name: 'Rainy Window — Blender Tutorial Translation',
      tags: ['tutorial', 'showcase', 'cc-by'], components: { animation: { actionId: BLENDER_RAINY_WINDOW_ACTION_ID } },
    }),
    entity({ id: 'entity/rainy-window/frame', kind: 'group', name: 'Aged Four-pane Frame', parentId: 'entity/rainy-window/showcase' }),
    entity({ id: 'entity/rainy-window/outside', kind: 'group', name: 'Storm Exterior', parentId: 'entity/rainy-window/showcase' }),
    entity({ id: 'entity/rainy-window/bokeh', kind: 'group', name: 'Distant Defocused Lights', parentId: 'entity/rainy-window/outside' }),
    entity({ id: 'entity/rainy-window/rain-a', kind: 'group', name: 'Rain Layer A', parentId: 'entity/rainy-window/showcase', transform: transform([0, 0.22, 0]) }),
    entity({ id: 'entity/rainy-window/rain-b', kind: 'group', name: 'Rain Layer B', parentId: 'entity/rainy-window/showcase', transform: transform([0, 0.22, 0]) }),
    entity({ id: 'entity/rainy-window/rain-c', kind: 'group', name: 'Rain Layer C', parentId: 'entity/rainy-window/showcase', transform: transform([0, 0.22, 0]) }),
    mesh({ id: 'entity/rainy-window/outer-left', name: 'Outer Frame Left', parentId: 'entity/rainy-window/frame', geometryId: 'geometry/rainy-window/frame-rail', materialId: 'material/rainy-window/wood', position: [-3.18, 3.45, 0.23] }),
    mesh({ id: 'entity/rainy-window/outer-right', name: 'Outer Frame Right', parentId: 'entity/rainy-window/frame', geometryId: 'geometry/rainy-window/frame-rail', materialId: 'material/rainy-window/wood', position: [3.18, 3.45, 0.23] }),
    mesh({ id: 'entity/rainy-window/outer-top', name: 'Outer Frame Top', parentId: 'entity/rainy-window/frame', geometryId: 'geometry/rainy-window/frame-rail', materialId: 'material/rainy-window/wood', position: [0, 6.63, 0.23], rotation: [0, 0, Math.PI / 2] }),
    mesh({ id: 'entity/rainy-window/outer-bottom', name: 'Outer Frame Bottom', parentId: 'entity/rainy-window/frame', geometryId: 'geometry/rainy-window/frame-rail', materialId: 'material/rainy-window/wood', position: [0, 0.27, 0.23], rotation: [0, 0, Math.PI / 2] }),
    mesh({ id: 'entity/rainy-window/mullion-vertical', name: 'Vertical Mullion', parentId: 'entity/rainy-window/frame', geometryId: 'geometry/rainy-window/inner-rail', materialId: 'material/rainy-window/wood', position: [0, 3.45, 0.29] }),
    mesh({ id: 'entity/rainy-window/mullion-horizontal', name: 'Horizontal Mullion', parentId: 'entity/rainy-window/frame', geometryId: 'geometry/rainy-window/inner-rail', materialId: 'material/rainy-window/wood', position: [0, 3.45, 0.29], rotation: [0, 0, Math.PI / 2] }),
    mesh({ id: 'entity/rainy-window/trim-left', name: 'Iron Trim Left', parentId: 'entity/rainy-window/frame', geometryId: 'geometry/rainy-window/trim', materialId: 'material/rainy-window/iron', position: [-2.87, 3.45, 0.52], castShadow: false }),
    mesh({ id: 'entity/rainy-window/trim-right', name: 'Iron Trim Right', parentId: 'entity/rainy-window/frame', geometryId: 'geometry/rainy-window/trim', materialId: 'material/rainy-window/iron', position: [2.87, 3.45, 0.52], castShadow: false }),
    mesh({ id: 'entity/rainy-window/trim-top', name: 'Iron Trim Top', parentId: 'entity/rainy-window/frame', geometryId: 'geometry/rainy-window/trim', materialId: 'material/rainy-window/iron', position: [0, 6.32, 0.52], rotation: [0, 0, Math.PI / 2], castShadow: false }),
    mesh({ id: 'entity/rainy-window/trim-bottom', name: 'Iron Trim Bottom', parentId: 'entity/rainy-window/frame', geometryId: 'geometry/rainy-window/trim', materialId: 'material/rainy-window/iron', position: [0, 0.58, 0.52], rotation: [0, 0, Math.PI / 2], castShadow: false }),
    mesh({ id: 'entity/rainy-window/sill', name: 'Deep Weathered Sill', parentId: 'entity/rainy-window/frame', geometryId: 'geometry/rainy-window/sill', materialId: 'material/rainy-window/wood', position: [0, -0.03, 0.26] }),
    mesh({ id: 'entity/rainy-window/glass', name: 'Procedural Rain Glass', parentId: 'entity/rainy-window/showcase', geometryId: 'geometry/rainy-window/glass', materialId: 'material/rainy-window/glass', position: [0, 3.45, 0.03], castShadow: false, receiveShadow: true }),
    mesh({ id: 'entity/rainy-window/mist', name: 'Cold Condensation Veil', parentId: 'entity/rainy-window/showcase', geometryId: 'geometry/rainy-window/glass', materialId: 'material/rainy-window/mist', position: [0, 3.45, 0.055], castShadow: false, receiveShadow: false }),
    mesh({ id: 'entity/rainy-window/night', name: 'Night Beyond the Glass', parentId: 'entity/rainy-window/outside', geometryId: 'geometry/rainy-window/outside', materialId: 'material/rainy-window/night', position: [0, 3.5, -4.2], castShadow: false, receiveShadow: false }),
    mesh({ id: 'entity/rainy-window/branch-a', name: 'Branch Silhouette A', parentId: 'entity/rainy-window/outside', geometryId: 'geometry/rainy-window/branch-a', materialId: 'material/rainy-window/branch', position: [-0.3, 1.2, -2.4], castShadow: false, receiveShadow: false }),
    mesh({ id: 'entity/rainy-window/branch-b', name: 'Branch Silhouette B', parentId: 'entity/rainy-window/outside', geometryId: 'geometry/rainy-window/branch-b', materialId: 'material/rainy-window/branch', position: [-0.8, 2.2, -2.65], castShadow: false, receiveShadow: false }),
  ];

  const bokeh = [
    [-2.45, 5.3, -3.3, 1.15, 'amber'], [-1.45, 1.35, -3, 0.62, 'cyan'],
    [2.1, 5.7, -3.15, 0.82, 'rose'], [2.55, 2.05, -2.9, 1.28, 'amber'],
    [0.95, 4.7, -3.45, 0.48, 'cyan'], [-2.2, 2.8, -3.25, 0.4, 'rose'],
    [1.75, 3.45, -3.5, 0.35, 'cyan'], [-0.85, 5.85, -3.15, 0.32, 'amber'],
    [0.3, 1.1, -3.25, 0.56, 'rose'],
  ].map(([x, y, z, size, colour], index) => mesh({
    id: `entity/rainy-window/bokeh-${String(index + 1).padStart(2, '0')}`,
    name: `Distant ${colour} light ${index + 1}`,
    parentId: 'entity/rainy-window/bokeh', geometryId: 'geometry/rainy-window/bokeh',
    materialId: `material/rainy-window/bokeh-${colour}`, position: [x, y, z], scale: [size, size, size],
    castShadow: false, receiveShadow: false,
  }));

  const random = lcg(0x5241494e);
  const droplets = Array.from({ length: 36 }, (_, index) => {
    const [x, y] = panePoint(random, index);
    const group = ['a', 'b', 'c'][index % 3];
    const width = 0.48 + random() * 0.62;
    const height = 0.8 + random() * 1.35;
    const depth = 0.2 + random() * 0.16;
    return mesh({
      id: `entity/rainy-window/droplet-${String(index + 1).padStart(2, '0')}`,
      name: `Water bead ${index + 1}`, parentId: `entity/rainy-window/rain-${group}`,
      geometryId: 'geometry/rainy-window/droplet', materialId: 'material/rainy-window/water',
      position: [x, y, 0.18 + random() * 0.018], rotation: [0, 0, (random() - 0.5) * 0.22],
      scale: [width, height, depth], castShadow: false, receiveShadow: true,
    });
  });

  const rivulets = Array.from({ length: 12 }, (_, index) => {
    const [x, y] = panePoint(random, index + 5);
    const group = ['c', 'a', 'b'][index % 3];
    return mesh({
      id: `entity/rainy-window/rivulet-${String(index + 1).padStart(2, '0')}`,
      name: `Gravity rivulet ${index + 1}`, parentId: `entity/rainy-window/rain-${group}`,
      geometryId: 'geometry/rainy-window/rivulet', materialId: 'material/rainy-window/water',
      position: [x, y, 0.175], rotation: [0, 0, (random() - 0.5) * 0.09],
      scale: [0.46 + random() * 0.38, 0.85 + random() * 2.1, 0.24 + random() * 0.12],
      castShadow: false, receiveShadow: true,
    });
  });

  const cameraAndLights = [
    entity({ id: 'entity/rainy-window/aim', kind: 'empty', name: 'Window Focus', parentId: 'entity/rainy-window/showcase', transform: transform([0, 3.35, 0.1]) }),
    entity({
      id: 'entity/rainy-window/camera', kind: 'perspectiveCamera', name: 'Rainy Window Camera', parentId: 'entity/rainy-window/showcase',
      transform: transform([8.4, 5.3, 13.8]),
      components: {
        camera: { fov: 38, near: 0.05, far: 100 },
        constraints: [{ id: 'constraint/rainy-window/camera-aim', type: 'lookAt', targetId: 'entity/rainy-window/aim' }],
      },
    }),
    entity({
      id: 'entity/rainy-window/key', kind: 'spotLight', name: 'Cold Storm Key', parentId: 'entity/rainy-window/showcase', transform: transform([-5.8, 8.5, 7.8]),
      components: {
        light: { color: [0.24, 0.44, 0.72], intensity: 420, distance: 35, decay: 2, angle: 0.72, penumbra: 0.72, castShadow: true, shadowMapSize: 2048, targetId: 'entity/rainy-window/aim' },
        constraints: [{ id: 'constraint/rainy-window/key-aim', type: 'lookAt', targetId: 'entity/rainy-window/aim' }],
      },
    }),
    entity({
      id: 'entity/rainy-window/warm-rim', kind: 'spotLight', name: 'Warm Interior Rim', parentId: 'entity/rainy-window/showcase', transform: transform([5.5, 6.8, 5.2]),
      components: {
        light: { color: [0.8, 0.3, 0.1], intensity: 300, distance: 28, decay: 2, angle: 0.66, penumbra: 0.68, castShadow: false, targetId: 'entity/rainy-window/aim' },
        constraints: [{ id: 'constraint/rainy-window/rim-aim', type: 'lookAt', targetId: 'entity/rainy-window/aim' }],
      },
    }),
    entity({
      id: 'entity/rainy-window/backlight', kind: 'pointLight', name: 'Rain Backlight', parentId: 'entity/rainy-window/outside', transform: transform([-1.8, 4.6, -1.4]),
      components: { light: { color: [0.06, 0.32, 0.68], intensity: 60, distance: 16, decay: 2, castShadow: false } },
    }),
    entity({
      id: 'entity/rainy-window/ambient', kind: 'hemisphereLight', name: 'Night Fill', parentId: 'entity/rainy-window/showcase', transform: transform([0, 10, 0]),
      components: { light: { color: [0.08, 0.17, 0.32], groundColor: [0.026, 0.011, 0.006], intensity: 0.85, castShadow: false } },
    }),
  ];

  return [
    { op: 'scene.patch', sceneId: 'scene/main', patch: { name: 'Blender Procedural Shading — Rainy Window' } },
    {
      op: 'scene.settings.patch', sceneId: 'scene/main', patch: {
        background: { mode: 'color', color: [0.0015, 0.0035, 0.009], colorSpace: 'linear-srgb' },
        fog: { mode: 'linear', color: [0.003, 0.008, 0.018], near: 16, far: 42 },
        timeline: { frameStart: 0, frameEnd: 672, currentFrame: 0, framesPerSecond: 24 },
      },
    },
    ...geometries,
    ...graphs,
    ...materials,
    animation,
    ...objects,
    ...bokeh,
    ...droplets,
    ...rivulets,
    ...cameraAndLights,
    { op: 'scene.setActiveCamera', sceneId: 'scene/main', cameraId: 'entity/rainy-window/camera' },
  ];
}

export function summarizeRainyWindowOperations(operations = buildRainyWindowOperations()) {
  return Object.freeze({
    operations: operations.length,
    resources: operations.filter(operation => operation.op === 'resource.create').length,
    entities: operations.filter(operation => operation.op === 'entity.create').length,
    graphs: operations.filter(operation => operation.resourceType === 'graphs').length,
    rainMeshes: operations.filter(operation => operation.entity?.id?.includes('/droplet-') || operation.entity?.id?.includes('/rivulet-')).length,
    officialSource: BLENDER_RAINY_WINDOW_SOURCE,
  });
}
