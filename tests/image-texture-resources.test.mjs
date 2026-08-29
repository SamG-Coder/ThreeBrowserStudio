import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import {
  DATA_TEXTURE_LIMITS,
  dataTextureDecodedByteLength,
  dataTextureGpuByteLength,
  decodeDataTexturePixels,
  normalizeDataTextureResource,
  validateDataTextureResource,
} from '../src/core/image-texture.mjs';
import { createDataTexture } from '../src/runtime/image-texture-resources.mjs';

function resource(overrides = {}) {
  return {
    kind: 'dataTexture',
    width: 2,
    height: 1,
    channels: 4,
    pixels: [255, 32, 0, 255, 4, 8, 16, 128],
    ...overrides,
  };
}

function fakeThree() {
  class DataTexture {
    constructor(...arguments_) {
      this.arguments = arguments_;
      this.needsUpdateWrites = [];
      this.userData = { preexisting: true };
      this.disposeCount = 0;
      DataTexture.instances.push(this);
    }

    dispose() { this.disposeCount += 1; }

    set needsUpdate(value) {
      this.needsUpdateWrites.push(value);
    }

    get needsUpdate() {
      return this.needsUpdateWrites.at(-1);
    }
  }
  DataTexture.instances = [];

  return {
    DataTexture,
    RGBAFormat: 'rgba-format',
    UnsignedByteType: 'unsigned-byte',
    ClampToEdgeWrapping: 'clamp-wrap',
    RepeatWrapping: 'repeat-wrap',
    MirroredRepeatWrapping: 'mirror-wrap',
    NearestFilter: 'nearest-filter',
    LinearFilter: 'linear-filter',
    NearestMipmapNearestFilter: 'nearest-mipmap-nearest-filter',
    NearestMipmapLinearFilter: 'nearest-mipmap-linear-filter',
    LinearMipmapNearestFilter: 'linear-mipmap-nearest-filter',
    LinearMipmapLinearFilter: 'linear-mipmap-linear-filter',
    SRGBColorSpace: 'srgb-space',
    LinearSRGBColorSpace: 'linear-space',
    NoColorSpace: 'no-color-space',
  };
}

test('normalizes a bounded numeric data texture without mutating authored bytes', () => {
  const input = resource({ name: 'Road albedo', pixels: [255, 32, 0, 255, 4, 8, 16, -0] });
  const canonical = normalizeDataTextureResource(input);

  assert.deepEqual(canonical, {
    kind: 'dataTexture',
    name: 'Road albedo',
    width: 2,
    height: 1,
    channels: 4,
    pixels: [255, 32, 0, 255, 4, 8, 16, 0],
    colorSpace: 'srgb',
    wrapS: 'clamp',
    wrapT: 'clamp',
    minFilter: 'linearMipmapLinear',
    magFilter: 'linear',
    anisotropy: 4,
    flipY: false,
    generateMipmaps: true,
  });
  assert.equal(Object.is(input.pixels.at(-1), -0), true);
  assert.equal(Object.isFrozen(canonical), true);
  assert.equal(Object.isFrozen(canonical.pixels), true);
  assert.deepEqual(Array.from(decodeDataTexturePixels(canonical)), canonical.pixels);
  assert.equal(dataTextureDecodedByteLength(canonical), 8);
});

test('accepts only canonical padded base64 with the exact decoded byte count', () => {
  const bytes = Uint8Array.from([5, 10, 20, 255, 40, 80, 160, 128]);
  const data = Buffer.from(bytes).toString('base64');
  const input = resource({ pixels: undefined, data });
  const canonical = normalizeDataTextureResource(input);

  assert.equal(canonical.data, data);
  assert.equal(Object.hasOwn(canonical, 'pixels'), false);
  assert.deepEqual(Array.from(decodeDataTexturePixels(canonical)), Array.from(bytes));
  assert.equal(dataTextureDecodedByteLength({ recipe: canonical }), bytes.length);

  const unpadded = validateDataTextureResource(resource({ pixels: undefined, data: 'AQ' }));
  assert.ok(unpadded.diagnostics.some(entry => entry.code === 'data_texture_invalid_base64'));
  const whitespace = validateDataTextureResource(resource({ pixels: undefined, data: `${data}\n` }));
  assert.ok(whitespace.diagnostics.some(entry => entry.code === 'data_texture_invalid_base64'));
  const short = validateDataTextureResource(resource({ pixels: undefined, data: Buffer.from([1, 2]).toString('base64') }));
  assert.ok(short.diagnostics.some(entry => entry.code === 'data_texture_pixel_length_mismatch'));
});

test('reports exact structural, byte, enum, sampler, and source diagnostics', () => {
  const validation = validateDataTextureResource(resource({
    mystery: true,
    width: 0,
    channels: 3,
    pixels: [0, 1.5, Number.NaN],
    data: 'AAAA',
    colorSpace: 'display-p3',
    wrapT: 'tile',
    minFilter: 'cubic',
    magFilter: 'mipmap',
    flipY: 1,
    generateMipmaps: null,
  }));

  assert.equal(validation.valid, false);
  assert.equal(validation.resource, null);
  const codes = validation.diagnostics.map(entry => entry.code);
  assert.ok(codes.includes('data_texture_unknown_property'));
  assert.ok(codes.includes('data_texture_invalid_dimension'));
  assert.ok(codes.includes('data_texture_invalid_byte'));
  assert.ok(codes.includes('data_texture_invalid_enum'));
  assert.ok(codes.includes('data_texture_invalid_boolean'));
  assert.ok(codes.includes('data_texture_ambiguous_source'));
  assert.ok(validation.diagnostics.every(entry => entry.severity === 'error' && entry.path.startsWith('/')));
});

test('enforces numeric, encoded, dimension, GPU, and mipmap bounds', () => {
  const typed = validateDataTextureResource(resource({ pixels: new Uint8Array(8) }));
  assert.equal(typed.valid, false);
  assert.equal(typed.diagnostics[0].code, 'data_texture_invalid_pixels');

  const numericBytes = new Array(DATA_TEXTURE_LIMITS.maxNumericBytes + 1).fill(0);
  const numeric = validateDataTextureResource(resource({
    width: 257,
    height: 255,
    channels: 1,
    pixels: numericBytes,
  }));
  assert.ok(numeric.diagnostics.some(entry => entry.code === 'data_texture_numeric_budget_exceeded'));
  assert.ok(numeric.diagnostics.some(entry => entry.code === 'data_texture_pixel_length_mismatch'));

  const encodedBytes = Buffer.alloc(DATA_TEXTURE_LIMITS.maxEncodedBytes + 1);
  const encoded = validateDataTextureResource(resource({
    width: 512,
    height: 342,
    channels: 4,
    pixels: undefined,
    data: encodedBytes.toString('base64'),
  }));
  assert.ok(encoded.diagnostics.some(entry => entry.code === 'data_texture_byte_budget_exceeded'));

  const dimensions = validateDataTextureResource(resource({ width: DATA_TEXTURE_LIMITS.maxDimension + 1 }));
  assert.ok(dimensions.diagnostics.some(entry => entry.code === 'data_texture_invalid_dimension'));

  const mipmaps = validateDataTextureResource(resource({
    minFilter: 'linearMipmapLinear', generateMipmaps: false,
  }));
  assert.ok(mipmaps.diagnostics.some(entry => entry.code === 'data_texture_mipmap_filter_without_mipmaps'));
  assert.equal(validateDataTextureResource(resource({
    minFilter: 'linearMipmapLinear', generateMipmaps: true,
  })).valid, true);
});

test('expands every source channel layout into deterministic RGBA8 runtime bytes', () => {
  const THREE = fakeThree();
  const cases = [
    { channels: 1, source: [11], rgba: [11, 11, 11, 255] },
    { channels: 2, source: [12, 34], rgba: [12, 12, 12, 34] },
    { channels: 3, source: [1, 2, 3], rgba: [1, 2, 3, 255] },
    { channels: 4, source: [4, 5, 6, 7], rgba: [4, 5, 6, 7] },
  ];
  for (const { channels, source, rgba } of cases) {
    const texture = createDataTexture({
      THREE,
      resource: {
        id: `texture/channels-${channels}`,
        name: `Channels ${channels}`,
        recipe: resource({
          width: 1,
          height: 1,
          channels,
          pixels: source,
          colorSpace: 'none',
          wrapS: 'repeat',
          wrapT: 'mirror',
          minFilter: 'linearMipmapLinear',
          magFilter: 'nearest',
          flipY: true,
          generateMipmaps: true,
        }),
      },
    });

    assert.ok(texture.arguments[0] instanceof Uint8Array);
    assert.deepEqual(Array.from(texture.arguments[0]), rgba);
    assert.deepEqual(texture.arguments.slice(1), [1, 1, 'rgba-format', 'unsigned-byte']);
    assert.equal(texture.name, `Channels ${channels}`);
    assert.equal(texture.wrapS, 'repeat-wrap');
    assert.equal(texture.wrapT, 'mirror-wrap');
    assert.equal(texture.minFilter, 'linear-mipmap-linear-filter');
    assert.equal(texture.magFilter, 'nearest-filter');
    assert.equal(texture.anisotropy, 4);
    assert.equal(texture.channel, 0);
    assert.equal(texture.flipY, true);
    assert.equal(texture.generateMipmaps, true);
    assert.equal(texture.unpackAlignment, 1);
    assert.equal(texture.colorSpace, 'no-color-space');
    assert.deepEqual(texture.userData, {
      preexisting: true,
      studioResourceId: `texture/channels-${channels}`,
      studioSourceChannels: channels,
      studioColorSpace: 'none',
      studioDecodedBytes: channels,
      studioGpuBytes: 4,
    });
    assert.deepEqual(texture.needsUpdateWrites, [true]);
  }
});

test('mip chains count exact RGBA8 GPU bytes while anisotropy remains sampling-only', () => {
  const pixels = Array.from({ length: 3 * 5 * 4 }, (_, index) => index % 256);
  const withoutMipmaps = resource({
    width: 3, height: 5, channels: 4, pixels,
    minFilter: 'linear', generateMipmaps: false, anisotropy: 1,
  });
  const withMipmaps = resource({
    ...withoutMipmaps,
    minFilter: 'linearMipmapLinear', generateMipmaps: true, anisotropy: 16,
  });
  assert.equal(dataTextureGpuByteLength(withoutMipmaps), 60);
  assert.equal(dataTextureGpuByteLength(withMipmaps), 72);
  assert.equal(dataTextureGpuByteLength({ ...withMipmaps, anisotropy: 1 }), 72);
  assert.ok(DATA_TEXTURE_LIMITS.maxGpuBytes > DATA_TEXTURE_LIMITS.maxBaseLevelGpuBytes);

  const THREE = fakeThree();
  const texture = createDataTexture({ THREE, resource: withMipmaps });
  assert.equal(texture.anisotropy, 16);
  assert.equal(texture.userData.studioGpuBytes, 72);
  for (const anisotropy of [0, 1.5, DATA_TEXTURE_LIMITS.maxAnisotropy + 1]) {
    const validation = validateDataTextureResource(resource({ anisotropy }));
    assert.ok(validation.diagnostics.some(entry => entry.code === 'data_texture_invalid_anisotropy'));
  }
});

test('lowers base64 and all color-space modes through the same RGBA8 path', () => {
  const THREE = fakeThree();
  const spaces = [
    ['srgb', 'srgb-space'],
    ['linear', 'linear-space'],
    ['none', 'no-color-space'],
  ];
  for (const [colorSpace, expected] of spaces) {
    const data = Buffer.from([10, 20, 30]).toString('base64');
    const texture = createDataTexture({
      THREE,
      resource: resource({ width: 1, height: 1, channels: 3, pixels: undefined, data, colorSpace }),
    });
    assert.deepEqual(Array.from(texture.arguments[0]), [10, 20, 30, 255]);
    assert.equal(texture.colorSpace, expected);
  }
});

test('fails deterministically when required Three runtime constants are unavailable', () => {
  const missingFormat = fakeThree();
  delete missingFormat.RGBAFormat;
  assert.throws(
    () => createDataTexture({ THREE: missingFormat, resource: resource() }),
    error => error.code === 'data_texture_runtime_constant_missing'
      && error.details.constant === 'RGBAFormat',
  );

  const missingColorSpace = fakeThree();
  delete missingColorSpace.NoColorSpace;
  assert.throws(
    () => createDataTexture({ THREE: missingColorSpace, resource: resource({ colorSpace: 'none' }) }),
    error => error.code === 'data_texture_runtime_constant_missing'
      && error.details.constant === 'NoColorSpace',
  );
  assert.throws(
    () => createDataTexture({ THREE: {}, resource: resource() }),
    error => error.code === 'data_texture_runtime_unavailable',
  );
});

test('all required runtime constants resolve before any DataTexture allocation', () => {
  const THREE = fakeThree();
  delete THREE.RepeatWrapping;
  assert.throws(
    () => createDataTexture({ THREE, resource: resource({ wrapS: 'repeat' }) }),
    error => error.code === 'data_texture_runtime_constant_missing'
      && error.details.constant === 'RepeatWrapping',
  );
  assert.equal(THREE.DataTexture.instances.length, 0);
});
