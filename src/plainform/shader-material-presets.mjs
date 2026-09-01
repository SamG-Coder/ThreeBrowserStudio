export const SHADER_MATERIAL_PRESETS = Object.freeze([
  Object.freeze({
    id: 'rugged-bark', name: 'Rugged Bark', aliases: Object.freeze(['bark', 'weathered bark']),
    nodes: Object.freeze([
      Object.freeze({ id: 'plainform-bark-ridges', role: 'Ridges', type: 'blender.noiseTexture', params: Object.freeze({ dimensions: '3D', noiseType: 'RIDGED_MULTIFRACTAL', normalize: true, seed: 37 }), inputs: Object.freeze({ scale: 8.3333333333, detail: 5, roughness: 0.68 }) }),
    ]),
    edges: Object.freeze([
      Object.freeze({ fromRole: 'Ridges', fromPort: 'factor', toRole: 'Principled Surface', toPort: 'roughness' }),
    ]),
    exposedParameters: Object.freeze([
      Object.freeze({ name: 'Bark Age', role: 'Ridges', input: 'detail' }),
    ]),
  }),
]);

export function findShaderMaterialPreset(value) {
  const key = String(value).trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '');
  return SHADER_MATERIAL_PRESETS.find(preset => preset.id === key || preset.aliases.some(alias => alias.replace(/[^a-z0-9]+/gu, '-') === key));
}
