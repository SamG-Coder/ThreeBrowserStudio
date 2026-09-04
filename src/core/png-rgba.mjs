import { inflateSync, deflateSync } from 'node:zlib';
import { StudioError } from './errors.mjs';

const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);
export const PNG_RGBA_LIMITS = Object.freeze({
  maxDimension: 2048,
  maxPixels: 2048 * 2048,
});

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  return upDistance <= upLeftDistance ? up : upLeft;
}

function readChunk(buffer, offset) {
  if (offset + 12 > buffer.length) {
    throw new StudioError('png_invalid', 'PNG chunk header is truncated.');
  }
  const length = buffer.readUInt32BE(offset);
  if (offset + 12 + length > buffer.length) {
    throw new StudioError('png_invalid', 'PNG chunk body is truncated.');
  }
  const type = buffer.toString('ascii', offset + 4, offset + 8);
  const body = buffer.subarray(offset + 8, offset + 8 + length);
  const expected = buffer.readUInt32BE(offset + 8 + length);
  const actual = crc32(buffer.subarray(offset + 4, offset + 8 + length));
  if (expected !== actual) {
    throw new StudioError('png_invalid', `PNG chunk ${type} failed CRC.`);
  }
  return { type, body, next: offset + 12 + length };
}

function unfilter(raw, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(height * stride);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source];
    source += 1;
    if (source + stride > raw.length) {
      throw new StudioError('png_invalid', 'PNG scanline is truncated.');
    }
    const dest = y * stride;
    const previous = y === 0 ? null : pixels.subarray(dest - stride, dest);
    for (let index = 0; index < stride; index += 1) {
      const sample = raw[source + index];
      const left = index >= bytesPerPixel ? pixels[dest + index - bytesPerPixel] : 0;
      const up = previous ? previous[index] : 0;
      const upLeft = previous && index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
      let value = sample;
      if (filter === 1) value = (sample + left) & 255;
      else if (filter === 2) value = (sample + up) & 255;
      else if (filter === 3) value = (sample + ((left + up) >> 1)) & 255;
      else if (filter === 4) value = (sample + paeth(left, up, upLeft)) & 255;
      else if (filter !== 0) {
        throw new StudioError('png_unsupported', `PNG filter ${filter} is not supported.`);
      }
      pixels[dest + index] = value;
    }
    source += stride;
  }
  return pixels;
}

function toRgba(pixels, width, height, colorType) {
  if (colorType === 6) return Buffer.from(pixels);
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const source = index * 3;
    const dest = index * 4;
    rgba[dest] = pixels[source];
    rgba[dest + 1] = pixels[source + 1];
    rgba[dest + 2] = pixels[source + 2];
    rgba[dest + 3] = 255;
  }
  return rgba;
}

/**
 * Decode an 8-bit non-interlaced RGB or RGBA PNG into tightly packed RGBA8.
 * Studio beauty captures are canvas PNG; this stays dependency-free.
 */
export function decodePngRgba(buffer) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw new StudioError('png_invalid', 'PNG input must be a byte buffer.');
  }
  const bytes = Buffer.from(buffer);
  if (bytes.length < 8 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    throw new StudioError('png_invalid', 'Input is not a PNG.');
  }
  const chunks = [];
  let offset = 8;
  while (offset < bytes.length) {
    const chunk = readChunk(bytes, offset);
    chunks.push(chunk);
    offset = chunk.next;
    if (chunk.type === 'IEND') break;
  }
  const ihdr = chunks.find(chunk => chunk.type === 'IHDR')?.body;
  if (!ihdr || ihdr.length < 13) throw new StudioError('png_invalid', 'PNG is missing IHDR.');
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new StudioError('png_invalid', 'PNG dimensions are invalid.');
  }
  if (width > PNG_RGBA_LIMITS.maxDimension || height > PNG_RGBA_LIMITS.maxDimension
    || width * height > PNG_RGBA_LIMITS.maxPixels) {
    throw new StudioError('png_budget_exceeded', `PNG exceeds ${PNG_RGBA_LIMITS.maxDimension}px evidence budget.`);
  }
  if (bitDepth !== 8) throw new StudioError('png_unsupported', 'Only 8-bit PNG evidence is supported.');
  if (interlace !== 0) throw new StudioError('png_unsupported', 'Interlaced PNG evidence is not supported.');
  if (colorType !== 2 && colorType !== 6) {
    throw new StudioError('png_unsupported', 'Only RGB or RGBA PNG evidence is supported.');
  }
  const idat = Buffer.concat(chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.body));
  if (idat.length === 0) throw new StudioError('png_invalid', 'PNG is missing IDAT.');
  let raw;
  try {
    raw = inflateSync(idat, { maxOutputLength: height * (1 + width * (colorType === 6 ? 4 : 3)) });
  } catch {
    throw new StudioError('png_invalid', 'PNG IDAT could not be inflated.');
  }
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  if (raw.length !== height * (1 + width * bytesPerPixel)) {
    throw new StudioError('png_invalid', 'PNG decompressed scanline length does not match IHDR.');
  }
  const pixels = unfilter(raw, width, height, bytesPerPixel);
  return {
    width,
    height,
    rgba: toRgba(pixels, width, height, colorType),
  };
}

function chunk(type, body) {
  const typeBytes = Buffer.from(type, 'ascii');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  const crcSource = Buffer.concat([typeBytes, body]);
  const footer = Buffer.alloc(4);
  footer.writeUInt32BE(crc32(crcSource), 0);
  return Buffer.concat([header, crcSource, footer]);
}

/** Encode tightly packed RGBA8 into a non-interlaced 8-bit PNG. Used by tests. */
export function encodePngRgba(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new StudioError('png_invalid', 'PNG dimensions are invalid.');
  }
  const expected = width * height * 4;
  if (!Buffer.isBuffer(rgba) && !(rgba instanceof Uint8Array)) {
    throw new StudioError('png_invalid', 'PNG pixels must be a byte buffer.');
  }
  if (rgba.length !== expected) {
    throw new StudioError('png_invalid', `RGBA buffer must contain exactly ${expected} bytes.`);
  }
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
