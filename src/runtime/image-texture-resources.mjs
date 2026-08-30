import {
  decodeDataTexturePixels,
  dataTextureGpuByteLength,
  normalizeDataTextureResource,
} from '../core/image-texture.mjs';

const WRAP_CONSTANTS = Object.freeze({
  clamp: 'ClampToEdgeWrapping', repeat: 'RepeatWrapping', mirror: 'MirroredRepeatWrapping',
});
const FILTER_CONSTANTS = Object.freeze({
  nearest: 'NearestFilter',
  linear: 'LinearFilter',
  nearestMipmapNearest: 'NearestMipmapNearestFilter',
  nearestMipmapLinear: 'NearestMipmapLinearFilter',
  linearMipmapNearest: 'LinearMipmapNearestFilter',
  linearMipmapLinear: 'LinearMipmapLinearFilter',
});
const COLOR_SPACE_CONSTANTS = Object.freeze({
  srgb: 'SRGBColorSpace', linear: 'LinearSRGBColorSpace', none: 'NoColorSpace',
});

function threeConstant(THREE, name) {
  if (THREE?.[name] !== undefined) return THREE[name];
  const error = new Error(`Three.js runtime does not expose ${name}.`);
  error.code = 'data_texture_runtime_constant_missing';
  error.details = { constant: name };
  throw error;
}

function expandRgba(bytes, channels) {
  if (channels === 4) return bytes;
  const pixelCount = bytes.length / channels;
  const output = new Uint8Array(pixelCount * 4);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const source = pixel * channels;
    const target = pixel * 4;
    if (channels === 1) {
      output[target] = bytes[source];
      output[target + 1] = bytes[source];
      output[target + 2] = bytes[source];
      output[target + 3] = 255;
    } else if (channels === 2) {
      output[target] = bytes[source];
      output[target + 1] = bytes[source];
      output[target + 2] = bytes[source];
      output[target + 3] = bytes[source + 1];
    } else {
      output[target] = bytes[source];
      output[target + 1] = bytes[source + 1];
      output[target + 2] = bytes[source + 2];
      output[target + 3] = 255;
    }
  }
  return output;
}

/** Lower one validated resource into a caller-owned RGBA8 Three DataTexture. */
export function createDataTexture({ THREE, resource }) {
  if (typeof THREE?.DataTexture !== 'function') {
    const error = new Error('Three.js runtime does not expose DataTexture.');
    error.code = 'data_texture_runtime_unavailable';
    throw error;
  }
  const authored = resource?.recipe ?? resource?.parameters ?? resource;
  const canonical = normalizeDataTextureResource(authored);
  const bytes = expandRgba(decodeDataTexturePixels(canonical), canonical.channels);
  // Resolve the complete runtime contract before allocating GPU-owned state.
  // If this Three build is missing a required constant, candidate compilation
  // must fail without leaving an unreachable DataTexture behind.
  const rgbaFormat = threeConstant(THREE, 'RGBAFormat');
  const unsignedByteType = threeConstant(THREE, 'UnsignedByteType');
  const wrapS = threeConstant(THREE, WRAP_CONSTANTS[canonical.wrapS]);
  const wrapT = threeConstant(THREE, WRAP_CONSTANTS[canonical.wrapT]);
  const minFilter = threeConstant(THREE, FILTER_CONSTANTS[canonical.minFilter]);
  const magFilter = threeConstant(THREE, FILTER_CONSTANTS[canonical.magFilter]);
  const colorSpace = threeConstant(THREE, COLOR_SPACE_CONSTANTS[canonical.colorSpace]);
  const texture = new THREE.DataTexture(
    bytes,
    canonical.width,
    canonical.height,
    rgbaFormat,
    unsignedByteType,
  );
  texture.name = resource?.name ?? canonical.name ?? 'Studio data texture';
  texture.wrapS = wrapS;
  texture.wrapT = wrapT;
  texture.minFilter = minFilter;
  texture.magFilter = magFilter;
  texture.anisotropy = canonical.anisotropy;
  // Studio currently lowers exactly one active UV layer. Pin every raster map,
  // including AO, to Three's channel-0 `uv` attribute instead of relying on a
  // runtime default that could change independently of the project contract.
  texture.channel = 0;
  texture.flipY = canonical.flipY;
  texture.generateMipmaps = canonical.generateMipmaps;
  texture.unpackAlignment = 1;
  texture.colorSpace = colorSpace;
  texture.userData = {
    ...(texture.userData ?? {}),
    studioResourceId: resource?.id ?? null,
    studioSourceChannels: canonical.channels,
    studioColorSpace: canonical.colorSpace,
    studioWrapS: canonical.wrapS,
    studioWrapT: canonical.wrapT,
    studioMinFilter: canonical.minFilter,
    studioMagFilter: canonical.magFilter,
    studioGenerateMipmaps: canonical.generateMipmaps,
    studioDecodedBytes: canonical.width * canonical.height * canonical.channels,
    studioGpuBytes: dataTextureGpuByteLength(canonical),
  };
  texture.needsUpdate = true;
  return texture;
}
