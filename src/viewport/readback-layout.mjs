const DEFAULT_ROW_ALIGNMENT = 256;

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

/**
 * Removes WebGPU's bytesPerRow padding from a texture readback. Three.js may
 * return either tightly packed pixels or the mapped GPU buffer layout, whose
 * final row is allowed to omit trailing padding.
 */
export function unpadWebGpuReadbackRows(
  pixels,
  width,
  height,
  { bytesPerPixel = 4, rowAlignment = DEFAULT_ROW_ALIGNMENT } = {},
) {
  if (!ArrayBuffer.isView(pixels) || pixels instanceof DataView) {
    throw new TypeError('pixels must be a typed array.');
  }
  const pixelWidth = positiveInteger(width, 'width');
  const pixelHeight = positiveInteger(height, 'height');
  const texelBytes = positiveInteger(bytesPerPixel, 'bytesPerPixel');
  const alignment = positiveInteger(rowAlignment, 'rowAlignment');
  const packedRowBytes = pixelWidth * texelBytes;
  const paddedRowBytes = Math.ceil(packedRowBytes / alignment) * alignment;
  const packedByteLength = packedRowBytes * pixelHeight;
  const shortenedFinalRowByteLength = paddedRowBytes * (pixelHeight - 1) + packedRowBytes;
  const fullyPaddedByteLength = paddedRowBytes * pixelHeight;
  const source = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);

  if (source.byteLength === packedByteLength) {
    return source;
  }
  if (source.byteLength !== shortenedFinalRowByteLength && source.byteLength !== fullyPaddedByteLength) {
    throw new RangeError(
      `Unexpected readback byte length ${source.byteLength}; expected ${packedByteLength}, `
      + `${shortenedFinalRowByteLength}, or ${fullyPaddedByteLength}.`,
    );
  }

  const packed = new Uint8Array(packedByteLength);
  for (let row = 0; row < pixelHeight; row += 1) {
    const sourceOffset = row * paddedRowBytes;
    const destinationOffset = row * packedRowBytes;
    packed.set(source.subarray(sourceOffset, sourceOffset + packedRowBytes), destinationOffset);
  }
  return packed;
}
