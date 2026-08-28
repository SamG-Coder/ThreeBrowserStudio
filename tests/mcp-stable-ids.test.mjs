import assert from 'node:assert/strict';
import test from 'node:test';
import { applySchema } from '../src/mcp/index.mjs';

const base = {
  protocolVersion: 'three-studio/1',
  sessionId: 'session',
  projectId: 'project/live',
  baseRevision: 0,
  idempotencyKey: 'stable-id-test',
  label: 'Check stable IDs',
};

test('MCP mutations enforce the same lowercase semantic IDs as the kernel', () => {
  const valid = applySchema.safeParse({
    ...base,
    operations: [{ op: 'scene.setActive', sceneId: 'scene/river-bank' }],
  });
  assert.equal(valid.success, true);
  const invalid = applySchema.safeParse({
    ...base,
    operations: [{ op: 'scene.setActive', sceneId: 'Scene/River Bank' }],
  });
  assert.equal(invalid.success, false);
});
