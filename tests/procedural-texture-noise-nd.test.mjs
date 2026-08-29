import assert from 'node:assert/strict';
import test from 'node:test';

import {
  blenderNoiseND,
  blenderVoronoiND,
  gradientNoiseND,
  MAX_CPU_VORONOI_CANDIDATE_VISITS,
} from '../src/runtime/procedural-texture-noise-nd.mjs';

test('N-D gradient noise is deterministic and responds to every coordinate', () => {
  const coordinate = [0.17, -0.38, 1.2, 7.4];
  const first = gradientNoiseND(coordinate, 42);
  assert.equal(first, gradientNoiseND(coordinate, 42));
  assert.notEqual(first, gradientNoiseND(coordinate, 43));
  for (let index = 0; index < coordinate.length; index += 1) {
    const changed = [...coordinate];
    changed[index] += 0.31;
    assert.notEqual(first, gradientNoiseND(changed, 42), `coordinate ${index}`);
  }
});

test('CPU Blender Noise executes every dimension and fractal mode', () => {
  const modes = ['FBM', 'MULTIFRACTAL', 'HYBRID_MULTIFRACTAL', 'RIDGED_MULTIFRACTAL', 'HETERO_TERRAIN'];
  const dimensions = ['1D', '2D', '3D', '4D'];
  const values = [];
  for (const noiseType of modes) {
    for (const dimension of dimensions) {
      const options = {
        dimensions: dimension,
        noiseType,
        w: 0.37,
        scale: 3.2,
        detail: 5,
        roughness: 0.61,
        lacunarity: 2.1,
        offset: 0.25,
        gain: 0.8,
        distortion: 0.3,
        normalize: true,
        seed: 81,
      };
      const first = blenderNoiseND([0.2, 0.4, 0.7], options);
      const second = blenderNoiseND([0.2, 0.4, 0.7], options);
      assert.deepEqual(first, second, `${noiseType} ${dimension}`);
      assert.ok(Number.isFinite(first.factor), `${noiseType} ${dimension}`);
      assert.ok(first.factor >= 0 && first.factor <= 1, `${noiseType} ${dimension}`);
      assert.ok(first.color.every(value => value >= 0 && value <= 1), `${noiseType} ${dimension}`);
      values.push(first.factor);
    }
  }
  assert.ok(new Set(values.map(value => value.toFixed(8))).size > modes.length);
});

test('CPU Blender Voronoi executes every dimension, metric, and feature', () => {
  const metrics = ['EUCLIDEAN', 'MANHATTAN', 'CHEBYCHEV', 'MINKOWSKI'];
  const features = ['F1', 'F2', 'SMOOTH_F1', 'DISTANCE_TO_EDGE', 'N_SPHERE_RADIUS'];
  for (const dimensions of ['1D', '2D', '3D', '4D']) {
    for (const feature of features) {
      for (const distanceMetric of metrics) {
        const value = blenderVoronoiND([0.17, -0.2, 0.71], {
          dimensions,
          w: 0.43,
          scale: 2.7,
          detail: 0,
          roughness: 0.5,
          lacunarity: 2,
          smoothness: 0.7,
          exponent: 1.7,
          randomness: 0.83,
          feature,
          distanceMetric,
          normalize: true,
          seed: 19,
        });
        assert.ok(Number.isFinite(value.distance), `${dimensions} ${feature} ${distanceMetric}`);
        assert.ok(Number.isFinite(value.radius), `${dimensions} ${feature} ${distanceMetric}`);
        assert.equal(value.position.length, 3);
        assert.equal(value.color.length, 3);
      }
    }
  }
});

test('CPU Blender Voronoi applies fractal detail and exact candidate budgets', () => {
  const baseOptions = {
    dimensions: '3D', feature: 'F1', distanceMetric: 'EUCLIDEAN', seed: 4,
    scale: 5, roughness: 0.55, lacunarity: 2.2, randomness: 1,
  };
  const base = blenderVoronoiND([0.2, 0.3, 0.4], { ...baseOptions, detail: 0 });
  const fractal = blenderVoronoiND([0.2, 0.3, 0.4], { ...baseOptions, detail: 3 });
  assert.notEqual(base.distance, fractal.distance);
  assert.equal(base.candidateVisits, 27);
  assert.equal(fractal.candidateVisits, 108);

  assert.throws(
    () => blenderVoronoiND([0.2, 0.3, 0.4], {
      ...baseOptions,
      dimensions: '4D',
      feature: 'SMOOTH_F1',
      detail: 7,
      maxCandidateVisits: MAX_CPU_VORONOI_CANDIDATE_VISITS,
    }),
    error => error.code === 'procedural_node_budget_exceeded'
      && error.details.candidateVisits === 5000
      && error.details.limit === 2500,
  );
});
