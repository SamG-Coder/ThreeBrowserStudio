import assert from 'node:assert/strict';
import test from 'node:test';
import { generateMountainPineSkeleton } from '../src/plainform/index.mjs';

test('mountain-pine skeleton is seeded, bounded, hierarchical, and byte deterministic', () => {
  const options = { name: 'Mountain Pine', height: 18, age: 70, seed: 1847, envelope: 9, sparseNorth: true };
  const first = generateMountainPineSkeleton(options); const second = generateMountainPineSkeleton(options);
  assert.deepEqual(first, second);
  assert.equal(first.paths[0].semanticId, 'trunk');
  assert.equal(first.paths[0].entityId, 'entity/mountain-pine/trunk');
  assert.ok(first.paths.some(path => path.semanticId === 'tier.04.branch.02'));
  assert.ok(first.paths.some(path => path.parentSemanticId === 'tier.04.branch.02'));
  assert.ok(first.paths.filter(path => path.order > 0).every(path => path.collar.continuity === 'boundedG1'));
  assert.ok(first.paths.length <= 4_096);
  assert.ok(first.report.estimatedTriangles > 0);
  assert.equal(first.report.deterministic, true);
  assert.notDeepEqual(generateMountainPineSkeleton({ ...options, seed: 1848 }).paths, first.paths);
});

test('surviving botanical semantic IDs remain stable across height regeneration', () => {
  const shorter = generateMountainPineSkeleton({ name: 'Pine', height: 18, age: 70, seed: 9 });
  const taller = generateMountainPineSkeleton({ name: 'Pine', height: 20, age: 70, seed: 9 });
  const tallerIds = new Set(taller.paths.map(path => path.semanticId));
  assert.ok(shorter.paths.slice(0, 20).every(path => tallerIds.has(path.semanticId)));
  assert.throws(() => generateMountainPineSkeleton({ name: 'Bad', height: 18, age: 70, seed: 1.5 }), error => error.code === 'plainform_botanical_parameters');
});
