import assert from 'node:assert/strict';
import test from 'node:test';

import {
  blendBlenderValues,
  combineBlenderColor,
  hslToRgb,
  hsvToRgb,
  mixBlenderValues,
  rgbToHsl,
  rgbToHsv,
  sampleBlenderColorRamp,
  separateBlenderColor,
} from '../src/runtime/procedural-texture-color.mjs';

function close(actual, expected, epsilon = 1e-7) {
  if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length);
    expected.forEach((value, index) => assert.ok(
      Math.abs(actual[index] - value) <= epsilon,
      `${actual[index]} != ${value} at ${index}`,
    ));
  } else assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

test('CPU Blender colour conversions round-trip RGB, HSV, and HSL', () => {
  const samples = [
    [1, 0, 0],
    [0, 1, 1],
    [0.1, 0.35, 0.9],
    [0.5, 0.5, 0.5],
  ];
  for (const sample of samples) {
    close(hsvToRgb(rgbToHsv(sample)), sample);
    close(hslToRgb(rgbToHsl(sample)), sample);
  }
});

test('CPU Separate and Combine Color support all catalogued modes and alpha', () => {
  close(Object.values(separateBlenderColor([0, 1, 1, 0.4], 'HSV')), [0.5, 1, 1, 0.4]);
  close(Object.values(separateBlenderColor([0.5, 0.5, 0.5, 0.7], 'HSL')), [0, 0, 0.5, 0.7]);
  close(combineBlenderColor(1 / 3, 1, 1, 0.4, 'HSV'), [0, 1, 0, 0.4]);
  close(combineBlenderColor(2 / 3, 1, 0.5, 0.7, 'HSL'), [0, 0, 1, 0.7]);
});

test('CPU Color Ramp implements hue direction, splines, alpha, and duplicate stops', () => {
  const hueStops = [
    { position: 0, color: [1, 0, 0.3, 0.2] },
    { position: 1, color: [1, 0.3, 0, 0.8] },
  ];
  close(sampleBlenderColorRamp(hueStops, 0.5, 'LINEAR', 'HSV', 'NEAR'), [1, 0, 0, 0.5]);
  close(sampleBlenderColorRamp(hueStops, 0.5, 'LINEAR', 'HSV', 'FAR'), [0, 1, 1, 0.5]);
  close(
    sampleBlenderColorRamp(hueStops, 0.5, 'B_SPLINE', 'HSV', 'NEAR'),
    sampleBlenderColorRamp(hueStops, 0.5, 'LINEAR', 'HSV', 'NEAR'),
  );

  const stops = [
    { position: 0, color: [1, 0, 0, 1] },
    { position: 0.33, color: [0, 1, 0, 0.8] },
    { position: 0.66, color: [0, 0, 1, 0.4] },
    { position: 1, color: [1, 1, 1, 0] },
  ];
  close(sampleBlenderColorRamp(stops, 0.33, 'CARDINAL'), [0, 1, 0, 0.8]);
  const spline = sampleBlenderColorRamp(stops, 0.5, 'B_SPLINE');
  assert.ok(spline[3] > 0.4 && spline[3] < 0.8);

  const duplicate = [
    { position: 0, color: [1, 0, 0, 1] },
    { position: 0.5, color: [0, 1, 0, 1] },
    { position: 0.5, color: [0, 0, 1, 1] },
    { position: 1, color: [1, 1, 1, 1] },
  ];
  close(sampleBlenderColorRamp(duplicate, 0.5, 'LINEAR'), [0, 0, 1, 1]);
});

test('CPU Mix implements every catalogued component and colour-transfer mode', () => {
  const componentModes = [
    'MIX', 'DARKEN', 'MULTIPLY', 'BURN', 'LIGHTEN', 'SCREEN', 'DODGE', 'ADD',
    'OVERLAY', 'SOFT_LIGHT', 'LINEAR_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'SUBTRACT',
    'DIVIDE',
  ];
  for (const mode of componentModes) {
    const value = blendBlenderValues([0.25, 0.5, 0.75, 1], [0.8, 0.4, 0.2, 0.5], mode, 'color');
    assert.equal(value.length, 4, mode);
    assert.ok(value.every(Number.isFinite), mode);
  }
  close(blendBlenderValues([1, 0, 0], [0, 1, 0], 'HUE', 'color'), [0, 1, 0]);
  close(blendBlenderValues([1, 0, 0], [0.5, 0.5, 0.5], 'HUE', 'color'), [1, 0, 0]);
  close(blendBlenderValues([1, 0, 0], [0.5, 0.5, 0.5], 'SATURATION', 'color'), [1, 1, 1]);
  close(blendBlenderValues([0.25, 0.25, 0.25], [0, 0, 1], 'COLOR', 'color'), [0, 0, 0.25]);
  close(blendBlenderValues([1, 0, 0], [0, 0, 0], 'VALUE', 'color'), [0, 0, 0]);
  close(mixBlenderValues([0, 0, 0], [1, 0.5, 0.25], 0.25, 'MIX', 'color'), [0.25, 0.125, 0.0625]);
});

test('CPU colour helpers reject modes instead of silently falling back', () => {
  assert.throws(() => separateBlenderColor([1, 0, 0], 'YUV'), /Unsupported/);
  assert.throws(() => combineBlenderColor(1, 0, 0, 1, 'YUV'), /Unsupported/);
  assert.throws(() => blendBlenderValues([1, 0, 0], [0, 1, 0], 'VIVID_LIGHT'), /Unsupported/);
  assert.throws(() => sampleBlenderColorRamp([
    { position: 0, color: [0, 0, 0, 1] },
    { position: 1, color: [1, 1, 1, 1] },
  ], 0.5, 'CUBIC'), /Unsupported/);
});
