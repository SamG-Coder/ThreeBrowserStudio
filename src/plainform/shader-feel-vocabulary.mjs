const FEELS = Object.freeze([
  { terms: ['soaking wet', 'rain soaked', 'wet', 'damp', 'dewy', 'slick'], inputs: { roughness: 0.12, coatWeight: 0.72, coatRoughness: 0.08 }, color: '#24362f' },
  { terms: ['mirror polished', 'high gloss', 'glossy', 'polished', 'shiny'], inputs: { roughness: 0.1, coatWeight: 0.6, coatRoughness: 0.04 } },
  { terms: ['matte', 'flat', 'chalky', 'powdery', 'dusty'], inputs: { roughness: 0.88, coatWeight: 0.02 }, color: '#a89f8d' },
  { terms: ['rough', 'coarse', 'rugged', 'craggy', 'pitted'], inputs: { roughness: 0.86 } },
  { terms: ['smooth', 'softly polished', 'satin'], inputs: { roughness: 0.28, coatWeight: 0.22 } },
  { terms: ['metallic', 'metal', 'steel', 'chrome'], inputs: { metallic: 0.9, roughness: 0.24 }, color: '#9da7ad' },
  { terms: ['brushed metal', 'brushed'], inputs: { metallic: 0.88, roughness: 0.42, anisotropic: 0.68 }, color: '#92999c' },
  { terms: ['rusty', 'rusted', 'oxidised', 'oxidized'], inputs: { metallic: 0.34, roughness: 0.82 }, color: '#8a3f20' },
  { terms: ['glass', 'glassy', 'transparent', 'crystalline'], inputs: { roughness: 0.08, transmissionWeight: 0.94, ior: 1.46, alpha: 0.42 }, color: '#d9f4f2' },
  { terms: ['frosted glass', 'frosted', 'milky translucent'], inputs: { roughness: 0.48, transmissionWeight: 0.78, ior: 1.44, alpha: 0.64 }, color: '#dce7e3' },
  { terms: ['waxy', 'skin like', 'skin-like', 'fleshy'], inputs: { roughness: 0.48, subsurfaceWeight: 0.24, subsurfaceScale: 0.08 }, color: '#b97867' },
  { terms: ['velvety', 'velvet', 'fuzzy', 'soft'], inputs: { roughness: 0.72, sheenWeight: 0.62, sheenRoughness: 0.64 } },
  { terms: ['silky', 'silk'], inputs: { roughness: 0.3, sheenWeight: 0.52, sheenRoughness: 0.28, anisotropic: 0.3 } },
  { terms: ['iridescent', 'pearlescent', 'opal', 'oil slick'], inputs: { roughness: 0.2, coatWeight: 0.54, thinFilmThickness: 420, thinFilmIor: 1.46 }, color: '#8db7b5' },
  { terms: ['glowing', 'luminous', 'emissive'], inputs: { emissionStrength: 1.8 }, emission: '#ffd58a' },
  { terms: ['neon', 'electric'], inputs: { roughness: 0.2, emissionStrength: 4.2 }, color: '#16d8ff', emission: '#16d8ff' },
  { terms: ['bioluminescent', 'magical glow'], inputs: { roughness: 0.5, emissionStrength: 2.6 }, color: '#16493f', emission: '#54ffc5' },
  { terms: ['ember', 'smouldering', 'smoldering'], inputs: { roughness: 0.72, emissionStrength: 2.2 }, color: '#3b1409', emission: '#ff6a18' },
  { terms: ['mossy', 'moss covered', 'moss-covered'], inputs: { roughness: 0.92, sheenWeight: 0.08 }, color: '#385c28' },
  { terms: ['bark like', 'bark-like', 'woody', 'wooden'], inputs: { roughness: 0.8 }, color: '#5a3420' },
  { terms: ['stone like', 'stone-like', 'stony', 'granite'], inputs: { roughness: 0.78, specularIorLevel: 0.32 }, color: '#77756e' },
  { terms: ['clay', 'earthen', 'terracotta'], inputs: { roughness: 0.84 }, color: '#a65332' },
  { terms: ['ceramic', 'porcelain', 'glazed'], inputs: { roughness: 0.18, coatWeight: 0.68, coatRoughness: 0.08 }, color: '#d8d1c2' },
  { terms: ['aged', 'ancient', 'weathered', 'worn', 'distressed'], inputs: { roughness: 0.76, coatWeight: 0.06 }, color: '#625342' },
  { terms: ['organic', 'natural', 'earthy'], inputs: { roughness: 0.7 }, color: '#62563a' },
  { terms: ['dreamy', 'whimsical', 'ghibli like', 'ghibli-style', 'storybook'], inputs: { roughness: 0.62, sheenWeight: 0.12 }, color: '#789463' },
  { terms: ['hand painted', 'hand-painted', 'painterly', 'gouache'], inputs: { roughness: 0.74, coatWeight: 0.03 }, color: '#8e7b5a' },
  { terms: ['warm'], color: '#a86038', emission: '#ffb36b' },
  { terms: ['cool', 'cold'], color: '#527a8f', emission: '#78c8e8' },
  { terms: ['dark', 'moody'], color: '#222631' },
  { terms: ['bright', 'sunny'], color: '#d8b85a' },
]);

const INTENSIFIERS = Object.freeze({
  barely: 0.25,
  slightly: 0.4,
  subtly: 0.45,
  softly: 0.55,
  moderately: 0.75,
  very: 1,
  deeply: 1,
  strongly: 1,
  extremely: 1.2,
});

function hexColor(value) {
  const match = String(value).match(/^#([0-9a-f]{6})$/iu);
  if (!match) return null;
  const numeric = Number.parseInt(match[1], 16);
  return [((numeric >> 16) & 255) / 255, ((numeric >> 8) & 255) / 255, (numeric & 255) / 255, 1];
}

function mix(left, right, amount) {
  return left.map((value, index) => value + (right[index] - value) * Math.min(1, amount));
}

export function interpretShaderFeel(source, initial = {}) {
  let remaining = ` ${String(source).toLowerCase().replace(/[_/]+/gu, ' ').replace(/[^a-z0-9 -]+/gu, ' ')} `;
  const inputs = { ...initial };
  let baseColor = initial.baseColor ?? [0.8, 0.8, 0.8, 1];
  let emissionColor = initial.emissionColor ?? [1, 1, 1, 1];
  const descriptors = [];
  for (const entry of FEELS) {
    for (const term of [...entry.terms].sort((a, b) => b.length - a.length)) {
      const expression = new RegExp(`\\b(?:(barely|slightly|subtly|softly|moderately|very|deeply|strongly|extremely)\\s+)?${term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'iu');
      const match = remaining.match(expression);
      if (!match) continue;
      const amount = INTENSIFIERS[match[1]?.toLowerCase()] ?? 0.82;
      for (const [key, target] of Object.entries(entry.inputs ?? {})) {
        const current = Number(inputs[key] ?? (key === 'roughness' ? 0.5 : 0));
        inputs[key] = current + (target - current) * Math.min(1, amount);
      }
      if (entry.color) baseColor = mix(baseColor, hexColor(entry.color), amount);
      if (entry.emission) emissionColor = mix(emissionColor, hexColor(entry.emission), amount);
      descriptors.push(term);
      remaining = remaining.replace(expression, ' ');
      break;
    }
  }
  const ignored = new Set(['and', 'with', 'a', 'an', 'the', 'feel', 'feeling', 'surface', 'material', 'shader', 'look', 'looking', 'style', 'styled', 'but', 'also']);
  const openDescriptors = remaining.trim().split(/\s+/u).filter(word => word && !ignored.has(word));
  return Object.freeze({
    inputs: Object.freeze({ ...inputs, baseColor, emissionColor }),
    descriptors: Object.freeze(descriptors),
    openDescriptors: Object.freeze(openDescriptors),
  });
}

export const SHADER_FEEL_VOCABULARY = FEELS;
