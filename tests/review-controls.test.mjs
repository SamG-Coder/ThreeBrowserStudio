import assert from 'node:assert/strict';
import test from 'node:test';

import { applyLookDelta, flyBasis, flyStep } from '../src/viewport/review-fly.mjs';

test('dragging right looks right instead of orbiting the opposite way', () => {
  const before = flyBasis(0, 0).forward;
  const next = applyLookDelta(0, 0, 80, 0);
  const after = flyBasis(next.yaw, next.pitch).forward;
  assert.ok(after.x > before.x + 0.05, 'look should yaw right when the pointer moves right');
});

test('Space flies up and Ctrl flies down', () => {
  const up = flyStep(new Set(['Space']), 1, { yaw: 0, pitch: 0 });
  const down = flyStep(new Set(['Down']), 1, { yaw: 0, pitch: 0 });
  assert.ok(up.y > 1, 'Space must raise the review camera');
  assert.ok(down.y < -1, 'Ctrl must lower the review camera');
  assert.equal(up.x, 0);
  assert.equal(down.x, 0);
});
