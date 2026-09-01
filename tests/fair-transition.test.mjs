import assert from 'node:assert/strict';
import test from 'node:test';
import { solveFairTransition } from '../src/plainform/index.mjs';

const rail = (name, y, count) => ({
  name,
  points: Array.from({ length: count }, (_, index) => [index / (count - 1), y, 0]),
  normals: Array.from({ length: count }, () => [0, 0, 1]),
});

test('fair transition deterministically resamples unequal loops and proves bounded G1 continuity', () => {
  const options = { first: rail('first', 0, 3), second: rail('second', 1, 5), continuity: 'tangent', sourceTangency: true };
  const first = solveFairTransition(options); const second = solveFairTransition(options);
  assert.deepEqual(first, second);
  assert.equal(first.profileResolution, 5);
  assert.equal(first.evidence.requested, 'G1');
  assert.equal(first.evidence.achieved, 'G1');
  assert.equal(first.evidence.maximumBoundaryDeviation, 0);
  assert.ok(first.evidence.maximumTangentError <= 1e-6);
  assert.ok(first.evidence.minimumArea > 0);
  assert.equal(first.evidence.invertedCellCount, 0);
});

test('curvature requests report the honest bounded-G1 approximation and budgets fail closed', () => {
  const result = solveFairTransition({ first: rail('first', 0, 2), second: rail('second', 1, 2), continuity: 'curvature', sourceTangency: true });
  assert.equal(result.evidence.requested, 'G2');
  assert.equal(result.evidence.achieved, 'boundedG1');
  assert.match(result.evidence.diagnostic, /source curvature tensors/u);
  assert.throws(() => solveFairTransition({ first: rail('first', 0, 2), second: rail('second', 1, 2), iterationBudget: 0 }), error => error.code === 'plainform_transition_budget_invalid');
});
