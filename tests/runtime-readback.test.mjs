import assert from 'node:assert/strict';
import test from 'node:test';
import { unpadWebGpuReadbackRows } from '../src/viewport/readback-layout.mjs';

test('WebGPU readback rows are unpadded without copying padding into pixels', () => {
  const width = 3;
  const height = 3;
  const packedRowBytes = width * 4;
  const paddedRowBytes = 256;
  const readback = new Uint8Array(paddedRowBytes * (height - 1) + packedRowBytes).fill(255);
  const expected = [];
  for (let row = 0; row < height; row += 1) {
    const values = Array.from({ length: packedRowBytes }, (_, column) => row * 32 + column);
    readback.set(values, row * paddedRowBytes);
    expected.push(...values);
  }

  assert.deepEqual([...unpadWebGpuReadbackRows(readback, width, height)], expected);
});

test('readback helper accepts packed and fully padded layouts', () => {
  const packed = Uint8Array.from({ length: 16 }, (_, index) => index);
  assert.equal(unpadWebGpuReadbackRows(packed, 2, 2).buffer, packed.buffer);

  const fullyPadded = new Uint8Array(512);
  fullyPadded.set([1, 2, 3, 4, 5, 6, 7, 8], 0);
  fullyPadded.set([9, 10, 11, 12, 13, 14, 15, 16], 256);
  assert.deepEqual(
    [...unpadWebGpuReadbackRows(fullyPadded, 2, 2)],
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  );
});
test('readback helper rejects ambiguous buffer lengths', () => {
  assert.throws(
    () => unpadWebGpuReadbackRows(new Uint8Array(15), 2, 2),
    /Unexpected readback byte length/,
  );
});
