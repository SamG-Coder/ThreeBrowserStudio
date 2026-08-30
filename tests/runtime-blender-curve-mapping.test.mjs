import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURVE_BEZIER_SAMPLES,
  CURVE_POINT_LIMIT,
  CURVE_TABLE_SIZE,
  FLOAT_CURVE_CHANNELS,
  RGB_CURVE_CHANNELS,
  VECTOR_CURVE_CHANNELS,
  compileCurveMapping,
  createFloatCurveMapping,
  createRgbCurveMapping,
  createVectorCurveMapping,
  evaluateCurveTable,
  evaluateFloatCurveMapping,
  evaluateRgbCurveMapping,
  evaluateVectorCurveMapping,
} from '../src/runtime/blender-curve-mapping.mjs';

const closeTo = (actual, expected, tolerance = 1e-5) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}.`,
  );
};

function point(x, y, handleType = 'VECTOR') {
  return { location: [x, y], handleType };
}

test('constructs fresh canonical identity mappings for Float, Vector, and RGB curves', () => {
  const scalar = createFloatCurveMapping();
  const vector = createVectorCurveMapping();
  const rgb = createRgbCurveMapping();

  assert.deepEqual(scalar, {
    extend: 'EXTRAPOLATED',
    clip: { enabled: true, min: [0, 0], max: [1, 1] },
    curves: { value: [point(0, 0, 'AUTO'), point(1, 1, 'AUTO')] },
  });
  assert.deepEqual(vector.clip, { enabled: true, min: [-1, -1], max: [1, 1] });
  assert.deepEqual(Object.keys(vector.curves), VECTOR_CURVE_CHANNELS);
  assert.deepEqual(Object.keys(rgb.curves), RGB_CURVE_CHANNELS);
  scalar.curves.value[0].location[0] = 42;
  assert.equal(createFloatCurveMapping().curves.value[0].location[0], 0);
});

test('compiles exact table/sample sizes and four-wide R, RGB, and RGBA packing', () => {
  assert.equal(CURVE_TABLE_SIZE, 257);
  assert.equal(CURVE_BEZIER_SAMPLES, 32);
  assert.equal(CURVE_POINT_LIMIT, 32);

  const variants = [
    [createFloatCurveMapping(), FLOAT_CURVE_CHANNELS, 'R'],
    [createVectorCurveMapping(), VECTOR_CURVE_CHANNELS, 'RGB'],
    [createRgbCurveMapping(), RGB_CURVE_CHANNELS, 'RGBA'],
  ];
  for (const [mapping, names, format] of variants) {
    const compiled = compileCurveMapping(mapping, names);
    assert.equal(compiled.tableSize, 257);
    assert.equal(compiled.bezierSamples, 32);
    assert.equal(compiled.packed.format, format);
    assert.equal(compiled.packed.width, 257);
    assert.equal(compiled.packed.componentCount, 4);
    assert.equal(compiled.packed.channelCount, names.length);
    assert.deepEqual(compiled.packed.channels, names);
    assert.equal(compiled.packed.data.length, 257 * 4);
    for (const name of names) assert.equal(compiled.channels[name].table.length, 257);
    for (let row = 0; row < 257; row += 1) {
      for (let lane = 0; lane < names.length; lane += 1) {
        assert.equal(
          compiled.packed.data[(row * 4) + lane],
          compiled.channels[names[lane]].table[row],
        );
      }
      for (let lane = names.length; lane < 4; lane += 1) {
        assert.equal(compiled.packed.data[(row * 4) + lane], 0);
      }
    }
  }
});

test('identity defaults evaluate inside and outside their native ranges', () => {
  const scalar = compileCurveMapping(createFloatCurveMapping(), FLOAT_CURVE_CHANNELS);
  const vector = compileCurveMapping(createVectorCurveMapping(), VECTOR_CURVE_CHANNELS);
  const rgb = compileCurveMapping(createRgbCurveMapping(), RGB_CURVE_CHANNELS);

  for (const value of [-2, -0.25, 0, 0.125, 0.5, 1, 1.75, 3]) {
    closeTo(evaluateFloatCurveMapping(scalar, value), value, 2e-5);
  }
  assert.deepEqual(
    evaluateVectorCurveMapping(vector, [-2, 0.25, 3]).map(value => Number(value.toFixed(5))),
    [-2, 0.25, 3],
  );
  const color = evaluateRgbCurveMapping(rgb, [-0.5, 0.25, 1.5, 0.37]);
  color.slice(0, 3).forEach((value, index) => closeTo(value, [-0.5, 0.25, 1.5][index], 3e-5));
  assert.equal(color[3], 0.37);
});

test('VECTOR handles produce piecewise linear curves and raw factor mixing', () => {
  const mapping = createFloatCurveMapping();
  mapping.curves.value = [point(0, 0), point(0.5, 1), point(1, 0)];
  const compiled = compileCurveMapping(mapping, FLOAT_CURVE_CHANNELS);

  closeTo(evaluateCurveTable(compiled.channels.value, 0.25), 0.5, 2e-4);
  closeTo(evaluateCurveTable(compiled.channels.value, 0.75), 0.5, 2e-4);
  closeTo(evaluateFloatCurveMapping(compiled, 0.25, 0), 0.25);
  closeTo(evaluateFloatCurveMapping(compiled, 0.25, 2), 0.75, 4e-4);
});

test('AUTO_CLAMPED prevents overshoot at extrema while AUTO remains smooth', () => {
  const auto = createFloatCurveMapping();
  auto.curves.value = [
    point(0, 0, 'AUTO'),
    point(0.2, 1, 'AUTO'),
    point(1, 0.65, 'AUTO'),
  ];
  const clamped = structuredClone(auto);
  clamped.curves.value[1].handleType = 'AUTO_CLAMPED';
  const autoCurve = compileCurveMapping(auto, FLOAT_CURVE_CHANNELS).channels.value;
  const clampedCurve = compileCurveMapping(clamped, FLOAT_CURVE_CHANNELS).channels.value;

  assert.ok(Math.max(...autoCurve.table) > 1.001);
  assert.ok(Math.max(...clampedCurve.table) <= 1.00001);
  closeTo(evaluateCurveTable(clampedCurve, 0.2), 1, 2e-3);
});

test('HORIZONTAL and EXTRAPOLATED modes carry normalized endpoint slopes without post-clipping', () => {
  const extrapolated = createFloatCurveMapping();
  extrapolated.clip.max = [1, 2];
  extrapolated.curves.value = [point(0, 0), point(1, 2)];
  const horizontal = structuredClone(extrapolated);
  horizontal.extend = 'HORIZONTAL';

  const linearCurve = compileCurveMapping(extrapolated, FLOAT_CURVE_CHANNELS).channels.value;
  const flatCurve = compileCurveMapping(horizontal, FLOAT_CURVE_CHANNELS).channels.value;
  closeTo(linearCurve.startSlope, 2);
  closeTo(linearCurve.endSlope, 2);
  closeTo(evaluateCurveTable(linearCurve, -0.5), -1);
  closeTo(evaluateCurveTable(linearCurve, 1.5), 3);
  assert.equal(flatCurve.startSlope, 0);
  assert.equal(flatCurve.endSlope, 0);
  closeTo(evaluateCurveTable(flatCurve, -0.5), 0);
  closeTo(evaluateCurveTable(flatCurve, 1.5), 2);
});

test('RGB evaluates Combined first, then channels, and preserves alpha through raw mixing', () => {
  const mapping = createRgbCurveMapping();
  mapping.clip.max = [1, 2];
  mapping.curves.combined = [point(0, 0), point(1, 0.5)];
  mapping.curves.red = [point(0, 0), point(1, 2)];
  mapping.curves.green = [point(0, 0), point(1, 1)];
  mapping.curves.blue = [point(0, 1), point(1, 0)];
  const compiled = compileCurveMapping(mapping, RGB_CURVE_CHANNELS);

  const mapped = evaluateRgbCurveMapping(compiled, [0.8, 0.4, 0.2, 0.3]);
  closeTo(mapped[0], 0.8, 3e-4); // 0.8 -> Combined 0.4 -> Red 0.8.
  closeTo(mapped[1], 0.2, 3e-4); // 0.4 -> Combined 0.2 -> Green 0.2.
  closeTo(mapped[2], 0.9, 3e-4); // 0.2 -> Combined 0.1 -> Blue 0.9.
  assert.equal(mapped[3], 0.3);

  const overMixed = evaluateRgbCurveMapping(compiled, [0.8, 0.4, 0.2, 0.3], 2);
  closeTo(overMixed[1], 0, 5e-4);
  closeTo(overMixed[2], 1.6, 5e-4);
  assert.equal(overMixed[3], 0.3);
});

test('rejects malformed channels before allocating runtime tables', () => {
  const mapping = createFloatCurveMapping();
  mapping.curves.value = [point(0, 0), point(0, 1)];
  assert.throws(
    () => compileCurveMapping(mapping, FLOAT_CURVE_CHANNELS),
    /point x locations must be unique/,
  );
  mapping.curves.value = Array.from({ length: CURVE_POINT_LIMIT + 1 }, (_, index) => point(index, index));
  assert.throws(
    () => compileCurveMapping(mapping, FLOAT_CURVE_CHANNELS),
    /between 2 and 32 points/,
  );
});
