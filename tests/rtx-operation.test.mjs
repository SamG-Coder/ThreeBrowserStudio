import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthoringKernel,
  DEFAULT_RTX_SETTINGS,
  StudioError,
  createProjectDocument,
} from '../src/core/index.mjs';
import { applySchema } from '../src/mcp/tool-schemas.mjs';

function createKernel() {
  let sequence = 0;
  return new AuthoringKernel(createProjectDocument({
    projectId: 'project/rtx-operation',
    timestamp: '2026-08-29T00:00:00.000Z',
  }), { transactionIdFactory: prefix => `${prefix}/rtx-${++sequence}` });
}

function request(baseRevision, key, patch) {
  return {
    protocolVersion: 'three-studio/1',
    projectId: 'project/rtx-operation',
    baseRevision,
    idempotencyKey: key,
    label: 'Configure native RTX lighting',
    operations: [{ type: 'scene.rtx.patch', sceneId: 'scene/main', patch }],
  };
}

test('scene.rtx.patch normalizes a reversible canonical master and lighting configuration', async () => {
  const kernel = createKernel();
  const result = await kernel.apply(request(0, 'rtx-operation-apply-0001', {
    enabled: true,
    shadows: true,
    ambientOcclusion: false,
    directionalSampleCount: 4,
    shadowStrength: 0.75,
  }));
  assert.equal(result.revision, 1);
  assert.equal(result.invalidations.includes('rtxTopology'), true);
  assert.deepEqual(kernel.document.scenes['scene/main'].settings.rtx, {
    enabled: true,
    ...DEFAULT_RTX_SETTINGS,
    shadows: true,
    ambientOcclusion: false,
    directionalSampleCount: 4,
    shadowStrength: 0.75,
  });

  await kernel.undo({
    protocolVersion: 'three-studio/1', projectId: kernel.projectId,
    baseRevision: 1, idempotencyKey: 'rtx-operation-undo-0002', label: 'Undo RTX settings',
  });
  assert.equal(Object.hasOwn(kernel.document.scenes['scene/main'].settings, 'rtx'), false);
});

test('RTX operation and MCP schema reject ambiguous or unsafe settings atomically', async () => {
  const kernel = createKernel();
  await assert.rejects(
    kernel.apply(request(0, 'rtx-operation-invalid-0001', { enabled: true, rayBias: 5, maxDistance: 1 })),
    error => error instanceof StudioError && error.code === 'invalid_rtx_setting',
  );
  assert.equal(kernel.revision, 0);

  const parsed = applySchema.parse({
    protocolVersion: 'three-studio/1', sessionId: 'session/rtx',
    projectId: 'project/rtx-operation', baseRevision: 0,
    idempotencyKey: 'rtx-operation-schema-0002', label: 'Enable RTX',
    operations: [{
      op: 'scene.rtx.patch', sceneId: 'scene/main',
      patch: { enabled: true, lighting: true, shadows: true, ambientOcclusion: true },
    }],
  });
  assert.equal(parsed.operations[0].patch.enabled, true);
  assert.throws(() => applySchema.parse({
    protocolVersion: 'three-studio/1', sessionId: 'session/rtx',
    projectId: 'project/rtx-operation', baseRevision: 0,
    idempotencyKey: 'rtx-operation-schema-0003', label: 'Invalid RTX',
    operations: [{ op: 'scene.rtx.patch', sceneId: 'scene/main', patch: {} }],
  }));
  assert.throws(() => applySchema.parse({
    protocolVersion: 'three-studio/1', sessionId: 'session/rtx',
    projectId: 'project/rtx-operation', baseRevision: 0,
    idempotencyKey: 'rtx-operation-schema-0004', label: 'Invalid RTX',
    operations: [{ op: 'scene.rtx.patch', sceneId: 'scene/main', patch: { enabled: true, reflections: true } }],
  }));
});
