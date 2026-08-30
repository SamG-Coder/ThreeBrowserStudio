import { StudioError } from '../core/errors.mjs';

export const MATERIAL_LOOK_RECIPES = Object.freeze({
  automotivePaint: Object.freeze({ kind: 'physical', color: '#8a1018', roughness: 0.22, metalness: 0.16, clearcoat: 1, clearcoatRoughness: 0.055 }),
  rubber: Object.freeze({ kind: 'physical', color: '#111316', roughness: 0.78, metalness: 0, clearcoat: 0.04, clearcoatRoughness: 0.7 }),
  brushedMetal: Object.freeze({ kind: 'physical', color: '#8c939b', roughness: 0.3, metalness: 1, anisotropy: 0.72 }),
  glass: Object.freeze({ kind: 'physical', color: '#dcecff', roughness: 0.055, metalness: 0, transmission: 1, opacity: 1, ior: 1.5, thickness: 0.08 }),
  emissiveLens: Object.freeze({ kind: 'physical', color: '#4a0802', roughness: 0.2, metalness: 0, clearcoat: 0.65, clearcoatRoughness: 0.08, emissive: '#ff3b08', emissiveIntensity: 4 }),
  fabric: Object.freeze({ kind: 'physical', color: '#30343a', roughness: 0.9, metalness: 0, sheen: 0.7, sheenRoughness: 0.72, sheenColor: '#657080' }),
  organicSkin: Object.freeze({ kind: 'physical', color: '#8e1522', roughness: 0.36, metalness: 0, clearcoat: 0.38, clearcoatRoughness: 0.2, sheen: 0.08, sheenRoughness: 0.6 }),
});

export const MATERIAL_LOOK_OVERRIDE_KEYS = Object.freeze([
  'roughness', 'metalness', 'clearcoat', 'clearcoatRoughness',
  'transmission', 'opacity', 'emissiveIntensity', 'anisotropy',
]);

export const MATERIAL_LOOK_NOTES = Object.freeze({
  automotivePaint: 'Physical clearcoat. Override color for a new paint.',
  rubber: 'High-roughness dielectric. Good for tires, grips, and dark interiors.',
  brushedMetal: 'Fully metallic with anisotropy. Override color for chrome versus steel.',
  glass: 'Default transmission is 1. Raster WebGPU windows need transmission 0 and opacity below 1.',
  emissiveLens: 'Default emissive is amber #ff3b08 at intensity 4. Override emissive and emissiveIntensity for white lamps.',
  fabric: 'Sheen-based cloth. Override color and roughness.',
  organicSkin: 'Sheen plus light clearcoat. Override color for flesh or fruit.',
});

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function lookDisplayName(look) {
  return look.replace(/([A-Z])/gu, ' $1').replace(/^./u, value => value.toUpperCase());
}

function lookResourceEnvelope(recipe, operation) {
  const envelope = {};
  if (operation.opacity !== undefined && Number.isFinite(recipe.opacity) && recipe.opacity < 1) {
    envelope.opacity = recipe.opacity;
    envelope.transparent = true;
  }
  if (operation.transmission !== undefined) envelope.transmission = recipe.transmission;
  return envelope;
}

export function queryLookCatalog({ search, look, limit = 50 } = {}) {
  const needle = String(search ?? '').trim().toLowerCase();
  const all = Object.entries(MATERIAL_LOOK_RECIPES).map(([id, recipe]) => Object.freeze({
    look: id,
    recipe: { ...recipe },
    overrideKeys: Object.freeze([...MATERIAL_LOOK_OVERRIDE_KEYS, 'color', 'emissive']),
    rasterNotes: MATERIAL_LOOK_NOTES[id],
  }));
  const matched = all.filter(entry => (
    (!look || entry.look === look)
    && (!needle || `${entry.look} ${entry.rasterNotes} ${Object.keys(entry.recipe).join(' ')}`.toLowerCase().includes(needle))
  ));
  const entries = matched.slice(0, Math.max(1, Math.min(200, limit)));
  return Object.freeze({
    version: 1,
    total: all.length,
    matched: matched.length,
    returned: entries.length,
    entries,
  });
}

export function materialLookResource(operation, existing = undefined) {
  const look = operation.look ?? existing?.metadata?.studioLook;
  if (operation.look && !MATERIAL_LOOK_RECIPES[operation.look]) {
    throw new StudioError('material_look_unsupported', `Material look ${operation.look} is not supported.`, {
      look: operation.look,
      looks: Object.keys(MATERIAL_LOOK_RECIPES),
    });
  }
  const baseRecipe = operation.look
    ? MATERIAL_LOOK_RECIPES[operation.look]
    : existing?.recipe;
  if (!isRecord(baseRecipe) || !baseRecipe.kind) {
    throw new StudioError(
      'material_look_unsupported',
      'Material look patch requires an existing recipe or an explicit look.',
      { materialId: operation.materialId ?? null, look: look ?? null },
    );
  }
  const recipe = { ...baseRecipe };
  for (const key of MATERIAL_LOOK_OVERRIDE_KEYS) {
    if (operation[key] !== undefined) recipe[key] = operation[key];
  }
  if (operation.color !== undefined) recipe.color = operation.color;
  if (operation.emissive !== undefined) recipe.emissive = operation.emissive;
  const metadata = { ...(existing?.metadata ?? {}) };
  if (look) metadata.studioLook = look;
  return {
    id: operation.materialId,
    name: operation.name ?? existing?.name ?? (look ? lookDisplayName(look) : operation.materialId),
    recipe,
    metadata,
    ...lookResourceEnvelope(recipe, operation),
  };
}
