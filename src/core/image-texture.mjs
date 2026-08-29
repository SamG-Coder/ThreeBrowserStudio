import { StudioError } from './errors.mjs';
import { isPlainRecord } from './util.mjs';

const BASE64_CHUNK = 0x8000;

function decodeCanonicalBase64(data) {
  if (typeof globalThis.atob !== 'function') {
    throw new TypeError('Base64 decoding is unavailable');
  }
  const binary = globalThis.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeCanonicalBase64(bytes) {
  if (typeof globalThis.btoa !== 'function') {
    throw new TypeError('Base64 encoding is unavailable');
  }
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return globalThis.btoa(binary);
}

function utf8ByteLength(text) {
  return new TextEncoder().encode(text).byteLength;
}

function rgbaTextureByteLength(width, height, generateMipmaps) {
  let levelWidth = width;
  let levelHeight = height;
  let pixels = 0;
  do {
    pixels += levelWidth * levelHeight;
    if (!generateMipmaps || (levelWidth === 1 && levelHeight === 1)) break;
    levelWidth = Math.max(1, Math.floor(levelWidth / 2));
    levelHeight = Math.max(1, Math.floor(levelHeight / 2));
  } while (true);
  return pixels * 4;
}

export const DATA_TEXTURE_LIMITS = Object.freeze({
  maxDimension: 512,
  maxPixels: 512 * 512,
  maxNumericBytes: 65_536,
  maxEncodedBytes: 700_000,
  maxBaseLevelGpuBytes: 512 * 512 * 4,
  maxGpuBytes: rgbaTextureByteLength(512, 512, true),
  maxAnisotropy: 16,
  maxProjectDecodedBytes: 16 * 1024 * 1024,
  maxProjectSerializedBytes: 8 * 1024 * 1024,
  maxNameLength: 160,
  maxDiagnostics: 64,
});

export const DATA_TEXTURE_CHANNELS = Object.freeze([1, 2, 3, 4]);
export const DATA_TEXTURE_COLOR_SPACES = Object.freeze(['srgb', 'linear', 'none']);
export const DATA_TEXTURE_WRAP_MODES = Object.freeze(['clamp', 'repeat', 'mirror']);
export const DATA_TEXTURE_MIN_FILTERS = Object.freeze([
  'nearest',
  'linear',
  'nearestMipmapNearest',
  'nearestMipmapLinear',
  'linearMipmapNearest',
  'linearMipmapLinear',
]);
export const DATA_TEXTURE_MAG_FILTERS = Object.freeze(['nearest', 'linear']);

export const DATA_TEXTURE_RECIPE_KEYS = Object.freeze([
  'kind', 'name', 'width', 'height', 'channels', 'pixels', 'data', 'colorSpace',
  'wrapS', 'wrapT', 'minFilter', 'magFilter', 'anisotropy', 'flipY', 'generateMipmaps',
]);
const RESOURCE_KEYS = new Set(DATA_TEXTURE_RECIPE_KEYS);
const DEFAULTS = Object.freeze({
  colorSpace: 'srgb',
  wrapS: 'clamp',
  wrapT: 'clamp',
  minFilter: 'linearMipmapLinear',
  magFilter: 'linear',
  anisotropy: 4,
  flipY: false,
  generateMipmaps: true,
});
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function diagnostic(code, message, path, details = undefined) {
  return Object.freeze({
    severity: 'error', code, message, path,
    ...(details === undefined ? {} : { details }),
  });
}

function pushDiagnostic(diagnostics, value) {
  if (diagnostics.length < DATA_TEXTURE_LIMITS.maxDiagnostics) diagnostics.push(value);
}

function enumDiagnostic(diagnostics, value, allowed, key) {
  if (allowed.includes(value)) return;
  pushDiagnostic(diagnostics, diagnostic(
    'data_texture_invalid_enum',
    `${key} must be one of: ${allowed.join(', ')}.`,
    `/${key}`,
    { value, allowed },
  ));
}

function validateDimension(diagnostics, value, key) {
  if (Number.isInteger(value) && value >= 1 && value <= DATA_TEXTURE_LIMITS.maxDimension) return true;
  pushDiagnostic(diagnostics, diagnostic(
    'data_texture_invalid_dimension',
    `${key} must be an integer between 1 and ${DATA_TEXTURE_LIMITS.maxDimension}.`,
    `/${key}`,
    { value, minimum: 1, maximum: DATA_TEXTURE_LIMITS.maxDimension },
  ));
  return false;
}

function canonicalResource(resource) {
  return Object.freeze({
    kind: 'dataTexture',
    ...(resource.name === undefined ? {} : { name: resource.name }),
    width: resource.width,
    height: resource.height,
    channels: resource.channels,
    ...(resource.pixels === undefined
      ? { data: resource.data }
      : { pixels: Object.freeze(resource.pixels.map(value => Object.is(value, -0) ? 0 : value)) }),
    colorSpace: resource.colorSpace ?? DEFAULTS.colorSpace,
    wrapS: resource.wrapS ?? DEFAULTS.wrapS,
    wrapT: resource.wrapT ?? DEFAULTS.wrapT,
    minFilter: resource.minFilter ?? DEFAULTS.minFilter,
    magFilter: resource.magFilter ?? DEFAULTS.magFilter,
    anisotropy: resource.anisotropy ?? DEFAULTS.anisotropy,
    flipY: resource.flipY ?? DEFAULTS.flipY,
    generateMipmaps: resource.generateMipmaps ?? DEFAULTS.generateMipmaps,
  });
}

function expectedByteLength(resource) {
  return Number.isInteger(resource.width) && Number.isInteger(resource.height)
    && DATA_TEXTURE_CHANNELS.includes(resource.channels)
    ? resource.width * resource.height * resource.channels
    : null;
}

function validateBase64(diagnostics, data, expectedLength) {
  if (typeof data !== 'string' || data.length === 0 || !BASE64_PATTERN.test(data)) {
    pushDiagnostic(diagnostics, diagnostic(
      'data_texture_invalid_base64',
      'data must be one canonical padded base64 string without a data-URI prefix or whitespace.',
      '/data',
    ));
    return;
  }
  const maxCharacters = Math.ceil(DATA_TEXTURE_LIMITS.maxEncodedBytes / 3) * 4;
  if (data.length > maxCharacters) {
    pushDiagnostic(diagnostics, diagnostic(
      'data_texture_byte_budget_exceeded',
      `Decoded data cannot exceed ${DATA_TEXTURE_LIMITS.maxEncodedBytes} bytes.`,
      '/data',
      { encodedCharacters: data.length, maximumEncodedCharacters: maxCharacters },
    ));
    return;
  }
  const bytes = decodeCanonicalBase64(data);
  if (encodeCanonicalBase64(bytes) !== data) {
    pushDiagnostic(diagnostics, diagnostic(
      'data_texture_invalid_base64',
      'data must use canonical padded base64 encoding.',
      '/data',
    ));
    return;
  }
  if (bytes.length > DATA_TEXTURE_LIMITS.maxEncodedBytes) {
    pushDiagnostic(diagnostics, diagnostic(
      'data_texture_byte_budget_exceeded',
      `Decoded data cannot exceed ${DATA_TEXTURE_LIMITS.maxEncodedBytes} bytes.`,
      '/data',
      { byteCount: bytes.length, maximum: DATA_TEXTURE_LIMITS.maxEncodedBytes },
    ));
  }
  if (expectedLength !== null && bytes.length !== expectedLength) {
    pushDiagnostic(diagnostics, diagnostic(
      'data_texture_pixel_length_mismatch',
      `Decoded data must contain exactly ${expectedLength} bytes.`,
      '/data',
      { actualLength: bytes.length, expectedLength },
    ));
  }
}

/** Validate one JSON-safe inline byte texture resource. */
export function validateDataTextureResource(resource) {
  const diagnostics = [];
  if (!isPlainRecord(resource)) {
    diagnostics.push(diagnostic('data_texture_invalid_resource', 'Data texture resource must be a plain object.', '/'));
    const frozen = Object.freeze(diagnostics);
    return Object.freeze({ valid: false, resource: null, diagnostics: frozen, errors: frozen });
  }
  for (const key of Object.keys(resource)) {
    if (!RESOURCE_KEYS.has(key)) pushDiagnostic(diagnostics, diagnostic(
      'data_texture_unknown_property', `Unknown data texture property "${key}".`, `/${key}`,
    ));
  }
  if (resource.kind !== 'dataTexture') pushDiagnostic(diagnostics, diagnostic(
    'data_texture_invalid_kind', 'kind must be dataTexture.', '/kind', { value: resource.kind },
  ));
  if (resource.name !== undefined
      && (typeof resource.name !== 'string' || resource.name.length < 1
        || resource.name.length > DATA_TEXTURE_LIMITS.maxNameLength)) {
    pushDiagnostic(diagnostics, diagnostic(
      'data_texture_invalid_name',
      `name must contain 1 to ${DATA_TEXTURE_LIMITS.maxNameLength} characters.`,
      '/name',
    ));
  }
  const widthValid = validateDimension(diagnostics, resource.width, 'width');
  const heightValid = validateDimension(diagnostics, resource.height, 'height');
  const channelsValid = DATA_TEXTURE_CHANNELS.includes(resource.channels);
  if (!channelsValid) pushDiagnostic(diagnostics, diagnostic(
    'data_texture_invalid_channels',
    `channels must be one of: ${DATA_TEXTURE_CHANNELS.join(', ')}.`,
    '/channels',
    { value: resource.channels },
  ));
  if (widthValid && heightValid) {
    const pixelCount = resource.width * resource.height;
    if (pixelCount > DATA_TEXTURE_LIMITS.maxPixels) pushDiagnostic(diagnostics, diagnostic(
      'data_texture_pixel_budget_exceeded',
      `Texture exceeds the ${DATA_TEXTURE_LIMITS.maxPixels} pixel budget.`,
      '/width',
      { pixelCount, maximum: DATA_TEXTURE_LIMITS.maxPixels },
    ));
    if (pixelCount * 4 > DATA_TEXTURE_LIMITS.maxBaseLevelGpuBytes) pushDiagnostic(diagnostics, diagnostic(
      'data_texture_gpu_budget_exceeded',
      `Expanded RGBA base level exceeds the ${DATA_TEXTURE_LIMITS.maxBaseLevelGpuBytes} byte GPU budget.`,
      '/width',
      { gpuBytes: pixelCount * 4, maximum: DATA_TEXTURE_LIMITS.maxBaseLevelGpuBytes },
    ));
    const gpuBytes = rgbaTextureByteLength(
      resource.width,
      resource.height,
      resource.generateMipmaps ?? DEFAULTS.generateMipmaps,
    );
    if (gpuBytes > DATA_TEXTURE_LIMITS.maxGpuBytes) pushDiagnostic(diagnostics, diagnostic(
      'data_texture_gpu_budget_exceeded',
      `Expanded RGBA texture and mip chain exceed the ${DATA_TEXTURE_LIMITS.maxGpuBytes} byte GPU budget.`,
      '/generateMipmaps',
      { gpuBytes, maximum: DATA_TEXTURE_LIMITS.maxGpuBytes },
    ));
  }
  const hasPixels = resource.pixels !== undefined;
  const hasData = resource.data !== undefined;
  if (hasPixels === hasData) pushDiagnostic(diagnostics, diagnostic(
    'data_texture_ambiguous_source',
    'Provide exactly one of pixels or data.',
    hasPixels ? '/pixels' : '/',
  ));
  const expectedLength = expectedByteLength(resource);
  if (hasPixels) {
    if (!Array.isArray(resource.pixels)) {
      pushDiagnostic(diagnostics, diagnostic('data_texture_invalid_pixels', 'pixels must be a plain JSON array of byte values.', '/pixels'));
    } else {
      if (resource.pixels.length > DATA_TEXTURE_LIMITS.maxNumericBytes) pushDiagnostic(diagnostics, diagnostic(
        'data_texture_numeric_budget_exceeded',
        `Numeric pixels cannot exceed ${DATA_TEXTURE_LIMITS.maxNumericBytes} bytes; use canonical base64 data for larger textures.`,
        '/pixels',
        { byteCount: resource.pixels.length, maximum: DATA_TEXTURE_LIMITS.maxNumericBytes },
      ));
      if (expectedLength !== null && resource.pixels.length !== expectedLength) pushDiagnostic(diagnostics, diagnostic(
        'data_texture_pixel_length_mismatch',
        `pixels must contain exactly ${expectedLength} byte values.`,
        '/pixels',
        { actualLength: resource.pixels.length, expectedLength },
      ));
      if (resource.pixels.length <= DATA_TEXTURE_LIMITS.maxNumericBytes) {
        for (let index = 0; index < resource.pixels.length; index += 1) {
          const value = resource.pixels[index];
          if (!Number.isInteger(value) || value < 0 || value > 255) {
            pushDiagnostic(diagnostics, diagnostic(
              'data_texture_invalid_byte', 'Pixel values must be finite integers between 0 and 255.', `/pixels/${index}`, { value },
            ));
            if (diagnostics.length >= DATA_TEXTURE_LIMITS.maxDiagnostics) break;
          }
        }
      }
    }
  }
  if (hasData) validateBase64(diagnostics, resource.data, expectedLength);

  enumDiagnostic(diagnostics, resource.colorSpace === undefined ? DEFAULTS.colorSpace : resource.colorSpace, DATA_TEXTURE_COLOR_SPACES, 'colorSpace');
  enumDiagnostic(diagnostics, resource.wrapS === undefined ? DEFAULTS.wrapS : resource.wrapS, DATA_TEXTURE_WRAP_MODES, 'wrapS');
  enumDiagnostic(diagnostics, resource.wrapT === undefined ? DEFAULTS.wrapT : resource.wrapT, DATA_TEXTURE_WRAP_MODES, 'wrapT');
  enumDiagnostic(diagnostics, resource.minFilter === undefined ? DEFAULTS.minFilter : resource.minFilter, DATA_TEXTURE_MIN_FILTERS, 'minFilter');
  enumDiagnostic(diagnostics, resource.magFilter === undefined ? DEFAULTS.magFilter : resource.magFilter, DATA_TEXTURE_MAG_FILTERS, 'magFilter');
  const anisotropy = resource.anisotropy ?? DEFAULTS.anisotropy;
  if (!Number.isInteger(anisotropy) || anisotropy < 1 || anisotropy > DATA_TEXTURE_LIMITS.maxAnisotropy) {
    pushDiagnostic(diagnostics, diagnostic(
      'data_texture_invalid_anisotropy',
      `anisotropy must be an integer between 1 and ${DATA_TEXTURE_LIMITS.maxAnisotropy}.`,
      '/anisotropy',
      { value: anisotropy, minimum: 1, maximum: DATA_TEXTURE_LIMITS.maxAnisotropy },
    ));
  }
  for (const key of ['flipY', 'generateMipmaps']) {
    const value = resource[key] === undefined ? DEFAULTS[key] : resource[key];
    if (typeof value !== 'boolean') pushDiagnostic(diagnostics, diagnostic(
      'data_texture_invalid_boolean', `${key} must be boolean.`, `/${key}`, { value },
    ));
  }
  const minFilter = resource.minFilter ?? DEFAULTS.minFilter;
  const generateMipmaps = resource.generateMipmaps ?? DEFAULTS.generateMipmaps;
  if (minFilter.includes('Mipmap') && generateMipmaps !== true) pushDiagnostic(diagnostics, diagnostic(
    'data_texture_mipmap_filter_without_mipmaps',
    `${minFilter} requires generateMipmaps: true.`,
    '/minFilter',
  ));
  const valid = diagnostics.length === 0;
  const frozenDiagnostics = Object.freeze(diagnostics);
  return Object.freeze({
    valid,
    resource: valid ? canonicalResource(resource) : null,
    diagnostics: frozenDiagnostics,
    errors: frozenDiagnostics,
  });
}

export function normalizeDataTextureResource(resource) {
  const validation = validateDataTextureResource(resource);
  if (validation.valid) return validation.resource;
  throw new StudioError(
    'invalid_data_texture_resource',
    validation.diagnostics[0]?.message ?? 'Data texture resource is invalid.',
    { diagnostics: validation.diagnostics },
  );
}

export function decodeDataTexturePixels(resource) {
  const canonical = normalizeDataTextureResource(resource?.recipe ?? resource?.parameters ?? resource);
  return canonical.pixels === undefined
    ? decodeCanonicalBase64(canonical.data)
    : Uint8Array.from(canonical.pixels);
}

export function dataTextureDecodedByteLength(resource) {
  const canonical = normalizeDataTextureResource(resource?.recipe ?? resource?.parameters ?? resource);
  return canonical.width * canonical.height * canonical.channels;
}

export function dataTextureSerializedByteLength(resource) {
  const canonical = normalizeDataTextureResource(resource?.recipe ?? resource?.parameters ?? resource);
  return utf8ByteLength(JSON.stringify(canonical));
}

export function dataTextureGpuByteLength(resource) {
  const canonical = normalizeDataTextureResource(resource?.recipe ?? resource?.parameters ?? resource);
  return rgbaTextureByteLength(canonical.width, canonical.height, canonical.generateMipmaps);
}
