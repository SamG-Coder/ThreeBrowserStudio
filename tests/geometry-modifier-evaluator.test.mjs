import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyGeometryModifier,
  evaluateGeometryModifierStack,
  GEOMETRY_MODIFIER_LIMITS,
  GEOMETRY_MODIFIER_TYPES,
} from '../src/core/geometry-modifier-evaluator.mjs';

function triangleRecipe() {
  return {
    kind: 'indexedMesh',
    positions: [
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
    ],
    indices: [0, 1, 2],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 0, 1],
    colors: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    computeNormals: true,
  };
}

function foldedRecipe() {
  return {
    kind: 'indexedMesh',
    positions: [
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 2,
    ],
    indices: [0, 1, 2, 0, 3, 1],
  };
}

function assertClose(actual, expected, epsilon = 1e-10) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    assert.ok(
      Math.abs(value - expected[index]) <= epsilon,
      `${value} != ${expected[index]} at index ${index}`,
    );
  });
}

test('modifier evaluator exposes a bounded deterministic geometry subset', () => {
  assert.deepEqual(GEOMETRY_MODIFIER_TYPES, [
    'triangulate',
    'weld',
    'smooth',
    'weightedNormal',
    'edgeSplit',
    'solidify',
    'subdivision',
    'decimate',
    'displace',
    'ocean',
  ]);
  assert.equal(GEOMETRY_MODIFIER_LIMITS.maxModifiers, 64);
  assert.equal(GEOMETRY_MODIFIER_LIMITS.maxSubdivisionLevels, 6);
  assert.equal(GEOMETRY_MODIFIER_LIMITS.maxOutputVertices, 1_000_000);
  assert.equal(GEOMETRY_MODIFIER_LIMITS.maxOceanWaveCount, 32);
  assert.equal(GEOMETRY_MODIFIER_LIMITS.maxOceanTimelineSamples, 131_072);
  assert.equal(GEOMETRY_MODIFIER_LIMITS.maxOceanSamples, 8_000_000);
});

test('ordered stacks honor viewport and render flags without mutating authored data', () => {
  const recipe = triangleRecipe();
  const modifiers = [
    {
      id: 'modifier/viewport-displace',
      type: 'displace',
      showRender: false,
      direction: 'z',
      strength: 1,
      midlevel: 0,
      source: { type: 'constant', value: 1 },
    },
    {
      id: 'modifier/render-displace',
      type: 'displace',
      enabledViewport: false,
      direction: 'z',
      strength: 2,
      midlevel: 0,
      source: { type: 'constant', value: 1 },
    },
    {
      id: 'modifier/disabled',
      type: 'triangulate',
      enabled: false,
    },
  ];
  const snapshot = structuredClone({ recipe, modifiers });

  const viewport = evaluateGeometryModifierStack(recipe, modifiers, { target: 'viewport' });
  const render = evaluateGeometryModifierStack(recipe, modifiers, { target: 'render' });

  assert.deepEqual(viewport.applied.map(entry => entry.id), ['modifier/viewport-displace']);
  assert.deepEqual(render.applied.map(entry => entry.id), ['modifier/render-displace']);
  assert.deepEqual(viewport.recipe.positions.filter((_, index) => index % 3 === 2), [1, 1, 1]);
  assert.deepEqual(render.recipe.positions.filter((_, index) => index % 3 === 2), [2, 2, 2]);
  assert.deepEqual(viewport.skipped.map(entry => entry.reason), ['viewport-disabled', 'disabled']);
  assert.deepEqual(render.skipped.map(entry => entry.reason), ['render-disabled', 'disabled']);
  assert.deepEqual({ recipe, modifiers }, snapshot);
});

test('simple subdivision shares edge midpoints and interpolates vertex attributes', () => {
  const result = applyGeometryModifier(triangleRecipe(), {
    id: 'modifier/subdivision',
    type: 'subdivision',
    scheme: 'simple',
    levels: 1,
  });

  assert.equal(result.positions.length / 3, 6);
  assert.equal(result.indices.length / 3, 4);
  assert.equal(result.uvs.length, 12);
  assert.equal(result.colors.length, 18);
  assert.deepEqual(result.positions.slice(9), [0.5, 0, 0, 0.5, 0.5, 0, 0, 0.5, 0]);
  assert.deepEqual(result.uvs.slice(6), [0.5, 0, 0.5, 0.5, 0, 0.5]);
  assert.deepEqual(result.indices, [
    0, 3, 5,
    3, 1, 4,
    5, 4, 2,
    3, 4, 5,
  ]);
});

test('Loop subdivision smooths old vertices and keeps a shared manifold midpoint', () => {
  const result = applyGeometryModifier(foldedRecipe(), {
    id: 'modifier/loop',
    type: 'subsurf',
    scheme: 'loop',
    levels: 1,
  });

  assert.equal(result.positions.length / 3, 9);
  assert.equal(result.indices.length / 3, 8);
  assert.ok(result.normals.every(Number.isFinite));
  assert.notDeepEqual(result.positions.slice(0, 12), foldedRecipe().positions);
});

test('solidify creates outer and inner shells plus boundary walls', () => {
  const result = applyGeometryModifier(triangleRecipe(), {
    id: 'modifier/solidify',
    type: 'solidify',
    thickness: 2,
    offset: 0,
  });

  assert.equal(result.positions.length / 3, 6);
  assert.equal(result.indices.length / 3, 8);
  assert.deepEqual(result.positions.filter((_, index) => index % 3 === 2), [1, 1, 1, -1, -1, -1]);
  assert.deepEqual(result.uvs, [...triangleRecipe().uvs, ...triangleRecipe().uvs]);
  assert.ok(result.normals.every(Number.isFinite));
});

test('weighted normals use deterministic face influence and reject unavailable sharp data', () => {
  const result = applyGeometryModifier(foldedRecipe(), {
    id: 'modifier/weighted-normal',
    type: 'weighted_normal',
    weighting: 'area',
  });

  assertClose(result.normals.slice(0, 3), [0, 2 / Math.sqrt(5), 1 / Math.sqrt(5)]);
  assertClose(result.normals.slice(6, 9), [0, 0, 1]);
  assert.throws(
    () => applyGeometryModifier(foldedRecipe(), {
      id: 'modifier/weighted-sharp',
      type: 'weightedNormal',
      keepSharp: true,
    }),
    error => error.code === 'geometry_modifier_attribute_unsupported',
  );
});

test('edge split duplicates vertices only across creases above the angle threshold', () => {
  const split = applyGeometryModifier(foldedRecipe(), {
    id: 'modifier/edge-split',
    type: 'edgeSplit',
    splitAngle: Math.PI / 4,
  });
  const joined = applyGeometryModifier(foldedRecipe(), {
    id: 'modifier/edge-joined',
    type: 'edge_split',
    splitAngle: Math.PI,
  });

  assert.equal(split.positions.length / 3, 6);
  assert.equal(joined.positions.length / 3, 4);
  assert.deepEqual(split.indices, [0, 2, 4, 1, 5, 3]);
  assertClose(split.normals.slice(0, 3), [0, 0, 1]);
  assertClose(split.normals.slice(3, 6), [0, 1, 0]);
});

test('decimate collapses shortest edges deterministically and retains canonical attributes', () => {
  const quad = {
    kind: 'indexedMesh',
    positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
    indices: [0, 1, 2, 0, 2, 3],
    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  };
  const modifier = {
    id: 'modifier/decimate',
    type: 'decimate',
    targetTriangles: 1,
  };
  const first = applyGeometryModifier(quad, modifier);
  const second = applyGeometryModifier(quad, modifier);

  assert.deepEqual(first, second);
  assert.equal(first.indices.length / 3, 1);
  assert.equal(first.positions.length / 3, 3);
  assert.equal(first.uvs.length, 6);
  assert.equal(first.normals.length, 9);
});

test('noise displacement is seeded, reproducible, and changes with its seed', () => {
  const modifier = seed => ({
    id: `modifier/noise-${seed}`,
    type: 'displace',
    direction: 'normal',
    strength: 0.2,
    source: {
      type: 'noise',
      seed,
      frequency: 2.25,
      octaves: 3,
      persistence: 0.6,
      lacunarity: 2,
    },
  });
  const first = applyGeometryModifier(triangleRecipe(), modifier(7));
  const repeated = applyGeometryModifier(triangleRecipe(), modifier(7));
  const different = applyGeometryModifier(triangleRecipe(), modifier(8));

  assert.deepEqual(first, repeated);
  assert.notDeepEqual(first.positions, different.positions);
  assert.ok(first.positions.every(Number.isFinite));
});

test('ocean displacement is seeded, timeline-driven, topology-preserving, and locally choppy', () => {
  const source = triangleRecipe();
  const modifier = {
    id: 'modifier/ocean',
    type: 'ocean',
    mode: 'displace',
    seed: 73,
    time: 1,
    timelineScale: 1.5,
    spatialSize: 12,
    waveScaleMin: 0.25,
    waveScale: 0.8,
    windVelocity: 24,
    waveDirection: Math.PI / 5,
    waveAlignment: 0.65,
    choppiness: 1.4,
    damping: 0.4,
    depth: 80,
    waveCount: 12,
  };
  const snapshot = structuredClone({ source, modifier });
  const first = applyGeometryModifier(source, modifier, { timeSeconds: 0 });
  const repeated = applyGeometryModifier(source, modifier, { timeSeconds: 0 });
  const later = applyGeometryModifier(source, modifier, { timeSeconds: 1.25 });
  const otherSeed = applyGeometryModifier(source, { ...modifier, seed: 74 }, { timeSeconds: 0 });

  assert.deepEqual(first, repeated);
  assert.notDeepEqual(first.positions, later.positions);
  assert.notDeepEqual(first.positions, otherSeed.positions);
  assert.deepEqual(first.indices, source.indices);
  assert.deepEqual(first.uvs, source.uvs);
  assert.deepEqual(first.colors, source.colors);
  assert.ok(first.positions.some((value, index) => value !== source.positions[index]));
  assert.ok(first.positions.filter((_, index) => index % 3 === 2).some(value => Math.abs(value) > 1e-6));
  assert.ok(first.normals.every(Number.isFinite));
  assert.deepEqual({ source, modifier }, snapshot);
});

test('ocean displacement fails closed outside its strict live subset', () => {
  assert.throws(
    () => applyGeometryModifier(triangleRecipe(), {
      id: 'modifier/ocean-generate', type: 'ocean', mode: 'generate',
    }),
    error => error.code === 'geometry_modifier_mode_unsupported',
  );
  assert.throws(
    () => applyGeometryModifier(triangleRecipe(), {
      id: 'modifier/ocean-range', type: 'ocean', mode: 'displace',
      spatialSize: 1, waveScaleMin: 2,
    }),
    error => error.code === 'invalid_geometry_modifier',
  );
  assert.throws(
    () => applyGeometryModifier(triangleRecipe(), {
      id: 'modifier/ocean-dense', type: 'ocean', mode: 'displace', waveCount: 33,
    }),
    error => error.code === 'invalid_geometry_modifier',
  );
  const sampleLimited = triangleRecipe();
  sampleLimited.positions = new Array(((GEOMETRY_MODIFIER_LIMITS.maxOceanSamples / 32) + 1) * 3).fill(0);
  delete sampleLimited.normals;
  delete sampleLimited.uvs;
  delete sampleLimited.colors;
  assert.throws(
    () => applyGeometryModifier(sampleLimited, {
      id: 'modifier/ocean-sample-budget', type: 'ocean', mode: 'displace',
      waveCount: 32, timelineScale: 0,
    }),
    error => error.code === 'geometry_modifier_complexity_limit'
      && error.details.limit === GEOMETRY_MODIFIER_LIMITS.maxOceanSamples,
  );
  const timelineLimited = triangleRecipe();
  timelineLimited.positions = new Array(((GEOMETRY_MODIFIER_LIMITS.maxOceanTimelineSamples / 32) + 1) * 3).fill(0);
  delete timelineLimited.normals;
  delete timelineLimited.uvs;
  delete timelineLimited.colors;
  assert.throws(
    () => applyGeometryModifier(timelineLimited, {
      id: 'modifier/ocean-timeline-budget', type: 'ocean', mode: 'displace', waveCount: 32,
    }),
    error => error.code === 'geometry_modifier_complexity_limit'
      && error.details.limit === GEOMETRY_MODIFIER_LIMITS.maxOceanTimelineSamples
      && error.details.timelineDriven === true,
  );
});

test('recalculateNormals false preserves valid authored normals and never triggers deferred recomputation', () => {
  const authored = triangleRecipe();
  authored.normals = [0, 0, 1, 0, 0, 1, 0, 0, 1];
  authored.computeNormals = true;
  const displaced = applyGeometryModifier(authored, {
    id: 'modifier/displace-with-authored-normals',
    type: 'displace',
    direction: 'z',
    strength: 0.25,
    recalculateNormals: false,
  });
  assert.deepEqual(displaced.normals, authored.normals);
  assert.equal(displaced.computeNormals, false);

  const subdivided = applyGeometryModifier(authored, {
    id: 'modifier/subdivide-without-normals',
    type: 'subdivision',
    levels: 1,
    recalculateNormals: false,
  });
  assert.equal(subdivided.normals, undefined);
  assert.equal(subdivided.computeNormals, false);
});

test('topology modifiers preserve exact multi-material provenance or fail closed', () => {
  const folded = {
    ...foldedRecipe(),
    triangleMaterialIndices: [2, 5],
  };
  const subdivided = applyGeometryModifier(folded, {
    id: 'modifier/subdivision-materials',
    type: 'subdivision',
    scheme: 'simple',
    levels: 1,
  });
  assert.deepEqual(subdivided.triangleMaterialIndices, [
    2, 2, 2, 2,
    5, 5, 5, 5,
  ]);

  const solidified = applyGeometryModifier(folded, {
    id: 'modifier/solidify-materials',
    type: 'solidify',
    thickness: 0.1,
  });
  assert.equal(solidified.triangleMaterialIndices.length, solidified.indices.length / 3);
  assert.deepEqual(solidified.triangleMaterialIndices.slice(0, 4), [2, 2, 5, 5]);

  const quad = {
    kind: 'indexedMesh',
    positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
    indices: [0, 1, 2, 0, 2, 3],
    triangleMaterialIndices: [2, 5],
  };
  assert.throws(
    () => applyGeometryModifier(quad, {
      id: 'modifier/decimate-materials',
      type: 'decimate',
      targetTriangles: 1,
    }),
    error => error.code === 'geometry_modifier_material_groups_unsupported',
  );
});

test('unsupported policy, exact IDs, and topology budgets fail explicitly', () => {
  const unsupported = { id: 'modifier/bevel', type: 'bevel', width: 0.1 };
  assert.throws(
    () => evaluateGeometryModifierStack(triangleRecipe(), [unsupported]),
    error => error.code === 'unsupported_geometry_modifier'
      && error.details.modifierId === 'modifier/bevel',
  );

  const skipped = evaluateGeometryModifierStack(
    triangleRecipe(),
    [
      unsupported,
      {
        id: 'modifier/downstream-displace',
        type: 'displace',
        direction: 'z',
        strength: 10,
        midlevel: 0,
        source: { type: 'constant', value: 1 },
      },
    ],
    { unsupported: 'skip' },
  );
  assert.equal(skipped.diagnostics[0].code, 'geometry_modifier_bake_boundary');
  assert.deepEqual(skipped.skipped, [{
    id: 'modifier/bevel',
    type: 'bevel',
    reason: 'unsupported',
  }]);
  assert.deepEqual(skipped.blocked, [{
    id: 'modifier/downstream-displace',
    type: 'displace',
    reason: 'after-bake-boundary',
    boundaryModifierId: 'modifier/bevel',
  }]);
  assert.deepEqual(skipped.applied, []);
  assert.deepEqual(skipped.recipe.positions, triangleRecipe().positions);

  assert.throws(
    () => evaluateGeometryModifierStack(triangleRecipe(), [
      { id: 'modifier/same', type: 'triangulate' },
      { id: 'modifier/same', type: 'triangulate' },
    ]),
    error => error.code === 'duplicate_geometry_modifier_id',
  );
  assert.throws(
    () => applyGeometryModifier(triangleRecipe(), {
      id: 'modifier/too-dense',
      type: 'subdivision',
      scheme: 'simple',
      levels: 1,
    }, { maxOutputTriangles: 3 }),
    error => error.code === 'geometry_modifier_budget_exceeded'
      && error.details.requested.triangles === 4,
  );
});
