import { StudioError } from './errors.mjs';
import { isStableId } from './ids.mjs';
import { isPlainRecord } from './util.mjs';

export const MATERIAL_TEXTURE_BINDINGS = Object.freeze([
  { idKey: 'baseColorMapId', aliases: ['mapId'], property: 'map', colorSpace: 'srgb', colorSpaces: ['srgb', 'linear'], kinds: ['basic', 'standard', 'physical', 'toon'] },
  { idKey: 'normalMapId', property: 'normalMap', colorSpace: 'none', allowedChannels: [3, 4], kinds: ['standard', 'physical', 'toon'] },
  { idKey: 'roughnessMapId', property: 'roughnessMap', colorSpace: 'none', kinds: ['standard', 'physical'] },
  { idKey: 'metalnessMapId', property: 'metalnessMap', colorSpace: 'none', kinds: ['standard', 'physical'] },
  { idKey: 'emissiveMapId', property: 'emissiveMap', colorSpace: 'srgb', colorSpaces: ['srgb', 'linear'], kinds: ['standard', 'physical', 'toon'] },
  { idKey: 'alphaMapId', property: 'alphaMap', colorSpace: 'none', kinds: ['basic', 'standard', 'physical', 'toon'] },
  { idKey: 'aoMapId', property: 'aoMap', colorSpace: 'none', kinds: ['standard', 'physical', 'toon'] },
  { idKey: 'bumpMapId', property: 'bumpMap', colorSpace: 'none', kinds: ['standard', 'physical', 'toon'] },
  { idKey: 'displacementMapId', property: 'displacementMap', colorSpace: 'none', kinds: ['standard', 'physical', 'toon'] },
  { idKey: 'clearcoatMapId', property: 'clearcoatMap', colorSpace: 'none', kinds: ['physical'] },
  { idKey: 'clearcoatNormalMapId', property: 'clearcoatNormalMap', colorSpace: 'none', allowedChannels: [3, 4], kinds: ['physical'] },
  { idKey: 'clearcoatRoughnessMapId', property: 'clearcoatRoughnessMap', colorSpace: 'none', kinds: ['physical'] },
  { idKey: 'sheenColorMapId', property: 'sheenColorMap', colorSpace: 'srgb', colorSpaces: ['srgb', 'linear'], kinds: ['physical'] },
  { idKey: 'sheenRoughnessMapId', property: 'sheenRoughnessMap', colorSpace: 'none', allowedChannels: [2, 4], kinds: ['physical'] },
  { idKey: 'transmissionMapId', property: 'transmissionMap', colorSpace: 'none', kinds: ['physical'] },
  { idKey: 'thicknessMapId', property: 'thicknessMap', colorSpace: 'none', kinds: ['physical'] },
  { idKey: 'specularColorMapId', property: 'specularColorMap', colorSpace: 'srgb', colorSpaces: ['srgb', 'linear'], kinds: ['physical'] },
  { idKey: 'specularIntensityMapId', property: 'specularIntensityMap', colorSpace: 'none', allowedChannels: [2, 4], kinds: ['physical'] },
  { idKey: 'anisotropyMapId', property: 'anisotropyMap', colorSpace: 'none', allowedChannels: [3, 4], kinds: ['physical'] },
  { idKey: 'iridescenceMapId', property: 'iridescenceMap', colorSpace: 'none', kinds: ['physical'] },
  { idKey: 'iridescenceThicknessMapId', property: 'iridescenceThicknessMap', colorSpace: 'none', kinds: ['physical'] },
].map(binding => Object.freeze({
  ...binding,
  aliases: Object.freeze(binding.aliases ?? []),
  allowedChannels: Object.freeze(binding.allowedChannels ?? [1, 2, 3, 4]),
  colorSpaces: Object.freeze(binding.colorSpaces ?? [binding.colorSpace]),
  kinds: Object.freeze(binding.kinds),
})));

export const MATERIAL_TEXTURE_SCALAR_LIMITS = Object.freeze({
  metalness: Object.freeze([0, 1]),
  roughness: Object.freeze([0, 1]),
  opacity: Object.freeze([0, 1]),
  alphaTest: Object.freeze([0, 1]),
  clearcoat: Object.freeze([0, 1]),
  clearcoatRoughness: Object.freeze([0, 1]),
  transmission: Object.freeze([0, 1]),
  sheen: Object.freeze([0, 1]),
  sheenRoughness: Object.freeze([0, 1]),
  specularIntensity: Object.freeze([0, 1]),
  anisotropy: Object.freeze([0, 1]),
  iridescence: Object.freeze([0, 1]),
  thickness: Object.freeze([0, 1_000_000]),
  emissiveIntensity: Object.freeze([0, 1_000_000]),
  ior: Object.freeze([1, 3]),
  aoMapIntensity: Object.freeze([0, 1]),
  bumpScale: Object.freeze([-1_000, 1_000]),
  displacementScale: Object.freeze([-100_000, 100_000]),
  displacementBias: Object.freeze([-100_000, 100_000]),
});

export const MATERIAL_TEXTURE_VECTOR2_LIMITS = Object.freeze({
  normalScale: Object.freeze([-100, 100]),
  clearcoatNormalScale: Object.freeze([-100, 100]),
});

export const MATERIAL_TEXTURE_MAP_AWARE_DEFAULTS = Object.freeze(Object.fromEntries(
  Object.entries({
    map: { color: [1, 1, 1] },
    normalMap: { normalScale: [1, 1] },
    roughnessMap: { roughness: 1 },
    metalnessMap: { metalness: 1 },
    emissiveMap: { emissive: [1, 1, 1], emissiveIntensity: 1 },
    alphaMap: { opacity: 1 },
    aoMap: { aoMapIntensity: 1 },
    bumpMap: { bumpScale: 1 },
    displacementMap: { displacementScale: 1, displacementBias: 0 },
    clearcoatMap: { clearcoat: 1 },
    clearcoatNormalMap: { clearcoat: 1, clearcoatNormalScale: [1, 1] },
    clearcoatRoughnessMap: { clearcoat: 1, clearcoatRoughness: 1 },
    sheenColorMap: { sheen: 1, sheenColor: [1, 1, 1] },
    sheenRoughnessMap: { sheen: 1, sheenRoughness: 1, sheenColor: [1, 1, 1] },
    transmissionMap: { transmission: 1 },
    thicknessMap: { transmission: 1, thickness: 1 },
    specularColorMap: { specularColor: [1, 1, 1] },
    specularIntensityMap: { specularIntensity: 1 },
    anisotropyMap: { anisotropy: 1 },
    iridescenceMap: { iridescence: 1 },
    iridescenceThicknessMap: { iridescence: 1 },
  }).map(([property, defaults]) => [property, Object.freeze(Object.fromEntries(
    Object.entries(defaults).map(([key, value]) => [key, Array.isArray(value) ? Object.freeze(value) : value]),
  ))]),
));

const MATERIAL_COLOR_NAMES = Object.freeze([
  'aqua', 'black', 'blue', 'fuchsia', 'gray', 'green', 'grey', 'lime',
  'maroon', 'navy', 'olive', 'orange', 'purple', 'red', 'silver', 'teal',
  'white', 'yellow',
]);
const MATERIAL_COLOR_NAME_SET = new Set(MATERIAL_COLOR_NAMES);

export const MATERIAL_TEXTURE_CONTROL_CONTRACT = Object.freeze({
  scalarRanges: MATERIAL_TEXTURE_SCALAR_LIMITS,
  vector2Ranges: MATERIAL_TEXTURE_VECTOR2_LIMITS,
  booleans: Object.freeze(['vertexColors']),
  colors: Object.freeze(['baseColor', 'color', 'emissive', 'sheenColor', 'specularColor']),
  colorValueFormats: Object.freeze(['linear-rgb-array', 'numeric-color', 'css-color-subset']),
  colorValueLimits: Object.freeze({
    linearRgbArrayLength: Object.freeze([3, 4]),
    linearRgbComponent: Object.freeze([0, 1_000_000]),
    optionalAlpha: Object.freeze({ range: Object.freeze([0, 1]), behavior: 'ignored-use-opacity' }),
    numericColor: Object.freeze([0, 0xffffff]),
    cssColorStringLength: Object.freeze([1, 128]),
    cssColorSyntax: Object.freeze([
      '#rgb', '#rrggbb', 'rgb(integer 0..255)', 'rgb(integer 0%..100%)',
      'hsl(unsigned degrees,unsigned 0%..100%,unsigned 0%..100%)', 'basic-name',
    ]),
    cssColorNames: MATERIAL_COLOR_NAMES,
  }),
  alphaBehavior: Object.freeze({
    alphaMapWithoutCutoff: 'inferred-blend',
    positiveAlphaTest: 'opaque-cutout',
    explicitTransparent: 'authoritative',
  }),
  mapAwareNeutralDefaults: MATERIAL_TEXTURE_MAP_AWARE_DEFAULTS,
});

function assertBoundedNumber(values, key, minimum, maximum) {
  if (values[key] === undefined) return;
  if (!Number.isFinite(values[key]) || values[key] < minimum || values[key] > maximum) {
    throw new StudioError(
      'invalid_material_texture_control',
      `${key} must be a finite number from ${minimum} to ${maximum}.`,
      { key, value: values[key], minimum, maximum },
    );
  }
}

function assertBoundedVec2(values, key, minimum, maximum) {
  if (values[key] === undefined) return;
  if (!Array.isArray(values[key]) || values[key].length !== 2
      || values[key].some(value => !Number.isFinite(value) || value < minimum || value > maximum)) {
    throw new StudioError(
      'invalid_material_texture_control',
      `${key} must contain exactly two finite numbers from ${minimum} to ${maximum}.`,
      { key, value: values[key], minimum, maximum },
    );
  }
}

function assertColorValue(values, key) {
  if (values[key] === undefined) return;
  const value = values[key];
  const validArray = Array.isArray(value)
    && (value.length === 3 || value.length === 4)
    && value.slice(0, 3).every(component => (
      Number.isFinite(component) && component >= 0 && component <= 1_000_000
    ))
    && (value.length === 3 || (
      Number.isFinite(value[3]) && value[3] >= 0 && value[3] <= 1
    ));
  const validNumber = Number.isInteger(value) && value >= 0 && value <= 0xffffff;
  const validString = isSupportedMaterialColorString(value);
  if (!validArray && !validNumber && !validString) {
    throw new StudioError(
      'invalid_material_texture_control',
      `${key} must be a three/four-component non-negative linear RGB array, a 24-bit numeric color, or a supported CSS color subset string.`,
      { key, value },
    );
  }
}

function isSupportedMaterialColorString(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128
      || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  const normalized = value.toLowerCase();
  if (MATERIAL_COLOR_NAME_SET.has(normalized)) return true;
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/u.test(normalized)) return true;

  const rgb = value.match(/^rgb\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)\s*\)$/u);
  if (rgb) {
    const percent = rgb.slice(1).every(component => /^\d+%$/u.test(component.trim()));
    const numeric = rgb.slice(1).every(component => /^\d+$/u.test(component.trim()));
    if (!percent && !numeric) return false;
    const maximum = percent ? 100 : 255;
    return rgb.slice(1).every(component => {
      const parsed = Number.parseFloat(component);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum;
    });
  }

  const hsl = value.match(/^hsl\(\s*([^,]+)\s*,\s*([^,]+)%\s*,\s*([^,]+)%\s*\)$/u);
  if (!hsl) return false;
  if (!hsl.slice(1).every(component => /^\d*\.?\d+$/u.test(component.trim()))) return false;
  const hue = Number.parseFloat(hsl[1]);
  const saturation = Number.parseFloat(hsl[2]);
  const lightness = Number.parseFloat(hsl[3]);
  return Number.isFinite(hue) && Number.isFinite(saturation) && Number.isFinite(lightness)
    && saturation >= 0 && saturation <= 100 && lightness >= 0 && lightness <= 100;
}

export function assertMaterialTextureControls(resource = {}) {
  const values = materialRecipeValues(resource);
  if (!isPlainRecord(values)) {
    throw new StudioError('invalid_material_recipe', 'Material recipe values must be a plain object.');
  }
  for (const [key, range] of Object.entries(MATERIAL_TEXTURE_SCALAR_LIMITS)) {
    assertBoundedNumber(values, key, ...range);
  }
  for (const [key, range] of Object.entries(MATERIAL_TEXTURE_VECTOR2_LIMITS)) {
    assertBoundedVec2(values, key, ...range);
  }
  for (const key of MATERIAL_TEXTURE_CONTROL_CONTRACT.colors) assertColorValue(values, key);
  if (values.vertexColors !== undefined && typeof values.vertexColors !== 'boolean') {
    throw new StudioError(
      'invalid_material_texture_control',
      'vertexColors must be boolean when provided.',
      { key: 'vertexColors', value: values.vertexColors },
    );
  }
  return values;
}

export const MATERIAL_TEXTURE_ID_KEYS = Object.freeze(MATERIAL_TEXTURE_BINDINGS
  .flatMap(binding => [binding.idKey, ...binding.aliases]));

const GRAPH_OUTPUTS_BY_TEXTURE_PROPERTY = Object.freeze({
  map: Object.freeze(['baseColor', 'albedo']),
  normalMap: Object.freeze(['normal']),
  bumpMap: Object.freeze(['normal', 'height']),
  roughnessMap: Object.freeze(['roughness']),
  metalnessMap: Object.freeze(['metalness']),
  emissiveMap: Object.freeze(['emissive']),
  alphaMap: Object.freeze(['opacity', 'mask', 'alphaTest']),
  displacementMap: Object.freeze(['positionOffset']),
  clearcoatMap: Object.freeze(['clearcoat']),
  clearcoatRoughnessMap: Object.freeze(['clearcoatRoughness']),
  transmissionMap: Object.freeze(['transmission']),
});
const SURFACE_GRAPH_OVERRIDE_PROPERTIES = new Set([
  'map', 'normalMap', 'bumpMap', 'roughnessMap', 'metalnessMap', 'emissiveMap',
  'alphaMap', 'clearcoatMap', 'clearcoatRoughnessMap', 'transmissionMap',
]);

export function materialRecipeValues(resource = {}) {
  return resource?.recipe ?? resource?.parameters ?? resource?.values ?? resource;
}

export function materialRecipeKind(resource = {}) {
  const values = materialRecipeValues(resource);
  return resource?.materialKind
    ?? values?.materialKind
    ?? values?.type
    ?? (values !== resource ? values?.kind : undefined)
    ?? (resource?.kind === 'material' ? 'standard' : resource?.kind)
    ?? 'standard';
}

export function materialTextureReferences(resource = {}) {
  const values = materialRecipeValues(resource);
  const references = [];
  for (const binding of MATERIAL_TEXTURE_BINDINGS) {
    const definitions = [];
    for (const key of [binding.idKey, ...binding.aliases]) {
      if (isPlainRecord(values) && values[key] !== undefined) definitions.push({ key, value: values[key], location: 'recipe' });
      if (values !== resource && resource[key] !== undefined) definitions.push({ key, value: resource[key], location: 'resource' });
    }
    if (definitions.length > 1) {
      throw new StudioError(
        'ambiguous_material_texture',
        `Material ${resource.id ?? '<unnamed>'} defines ${binding.idKey} through multiple canonical or legacy fields.`,
        { materialId: resource.id ?? null, idKey: binding.idKey, definitions },
      );
    }
    if (definitions.length === 0) continue;
    const [{ key: authoredKey, value: textureId }] = definitions;
    if (!isStableId(textureId)) {
      throw new StudioError(
        'invalid_material_texture_reference',
        `Material ${resource.id ?? '<unnamed>'} ${binding.idKey} must be a stable texture ID.`,
        { materialId: resource.id ?? null, idKey: binding.idKey, authoredKey, textureId },
      );
    }
    references.push(Object.freeze({ ...binding, authoredKey, textureId }));
  }
  return Object.freeze(references);
}

export function materialTextureGraphConflicts(resource = {}, graphResource = null) {
  const graph = graphResource?.graph ?? graphResource;
  if (!isPlainRecord(graph) || !isPlainRecord(graph.outputs)) return Object.freeze([]);
  const outputNames = new Set(Object.keys(graph.outputs));
  const conflicts = [];
  for (const reference of materialTextureReferences(resource)) {
    const overlappingOutputs = GRAPH_OUTPUTS_BY_TEXTURE_PROPERTY[reference.property] ?? [];
    const output = outputNames.has('surface') && SURFACE_GRAPH_OVERRIDE_PROPERTIES.has(reference.property)
      ? 'surface'
      : overlappingOutputs.find(name => outputNames.has(name));
    if (output) conflicts.push(Object.freeze({
      idKey: reference.idKey,
      textureId: reference.textureId,
      property: reference.property,
      graphOutput: output,
    }));
  }
  return Object.freeze(conflicts);
}

export function assertMaterialTextureCompatibility(resource = {}) {
  const kind = materialRecipeKind(resource);
  const references = materialTextureReferences(resource);
  for (const reference of references) {
    if (!reference.kinds.includes(kind)) {
      throw new StudioError(
        'material_texture_slot_unsupported',
        `${reference.idKey} is not supported by ${kind} materials.`,
        {
          materialId: resource.id ?? null,
          materialKind: kind,
          idKey: reference.idKey,
          supportedKinds: reference.kinds,
        },
      );
    }
  }
  return kind;
}
