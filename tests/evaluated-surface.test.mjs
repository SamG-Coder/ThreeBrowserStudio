import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvaluatedSurface, inspectSurfaceAnchorHealth } from '../src/plainform/index.mjs';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const coarse = {
  kind: 'indexedMesh',
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  indices: [0, 1, 2, 0, 2, 3],
};
const refined = {
  kind: 'indexedMesh',
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0.5, 0.5, 0],
  indices: [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4],
};

test('evaluated surfaces provide deterministic UV anchors, tangent frames, and ancestry health', () => {
  const surface = createEvaluatedSurface({ recipe: coarse, matrix: identity, entityId: 'entity/panel' });
  const [projected] = surface.projectAnchors([[0.25, 0.4, 0.2]]);
  assert.equal(projected.parametric.kind, 'surfaceUv');
  assert.ok(projected.parametric.uv.every(Number.isFinite));
  assert.equal(projected.health.status, 'projected');
  assert.equal(projected.surface.id, 'entity/panel');
  assert.ok(Math.abs(Math.hypot(...projected.tangentFrame.normal) - 1) < 1e-9);

  const persisted = JSON.parse(JSON.stringify({
    seedPoint: [0.25, 0.4, 0.2], projectedPoint: projected.point, normal: projected.normal,
    parametric: projected.parametric, surface: projected.surface,
  }));
  assert.equal(surface.resolveAnchor(persisted).health.status, 'exact');
  const regenerated = createEvaluatedSurface({ recipe: refined, matrix: identity, entityId: 'entity/panel' });
  const remapped = regenerated.resolveAnchor(persisted);
  assert.equal(remapped.health.status, 'remapped');
  assert.ok(Math.hypot(...remapped.point.map((value, axis) => value - projected.point[axis])) < 1e-9);
  assert.deepEqual(inspectSurfaceAnchorHealth({ recipe: refined, matrix: identity, entityId: 'entity/panel', anchors: [persisted] }), [remapped.health]);
});

test('evaluated-surface fallback is bounded and reports broken anchors instead of silently drifting', () => {
  const surface = createEvaluatedSurface({ recipe: coarse, matrix: identity, entityId: 'entity/panel' });
  const result = surface.resolveAnchor({ seedPoint: [10, 10, 10] }, { projectionTolerance: 0.1 });
  assert.equal(result.health.status, 'broken');
  assert.equal(result.health.reason, 'projection_tolerance_exceeded');
  assert.ok(result.health.distance > 0.1);
});
