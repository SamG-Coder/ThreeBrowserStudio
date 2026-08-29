import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createStudioCommandTelemetry,
  isStudioLiveFeedMethod,
  sanitizeLiveFeedText,
  summarizeStudioCommand,
} from '../src/runtime/mcp-live-feed-telemetry.mjs';

test('live-feed filtering includes real Studio tools but excludes bridge ping and arbitrary methods', () => {
  assert.equal(isStudioLiveFeedMethod('three_studio_status'), true);
  assert.equal(isStudioLiveFeedMethod('three_studio_apply'), true);
  assert.equal(isStudioLiveFeedMethod('ping'), false);
  assert.equal(isStudioLiveFeedMethod('three_studio_ping'), false);
  assert.equal(isStudioLiveFeedMethod('three_studio_apply_fake'), false);
  assert.equal(isStudioLiveFeedMethod('other_tool'), false);
});

test('summaries use only compact allowlisted facts and sanitize control, bidi, and markup text', () => {
  assert.equal(summarizeStudioCommand('three_studio_project', {
    action: 'open', path: 'C:\\private\\world', projectId: 'project/secret',
  }), 'Open project');
  assert.equal(summarizeStudioCommand('three_studio_apply', {
    dryRun: true,
    label: '<script>token-123</script>',
    idempotencyKey: 'never-display-this',
    operations: [
      { op: 'entity.patch', entityId: 'entity/private', patch: { token: 'secret' } },
      { op: 'resource.create', resource: { data: 'base64-secret' } },
    ],
  }), 'Dry-run 2 operations');
  assert.equal(summarizeStudioCommand('three_studio_validate', {
    checks: ['graphs', 'references', '<unsafe>', 'graphs'],
  }), 'Validate graphs, references');
  assert.equal(sanitizeLiveFeedText(' <b>ok</b>\u0000\u202etxt& '), '‹b›ok‹/b› txt＆');
  assert.equal(summarizeStudioCommand('three_studio_inspect', { query: 'resourceDigest' }), 'Inspect resource digest');
  assert.equal(summarizeStudioCommand('three_studio_inspect', { query: 'meshElements' }), 'Inspect exact mesh elements');
  assert.equal(summarizeStudioCommand('three_studio_inspect', { query: 'graphDigest' }), 'Inspect graph digest');
  assert.equal(summarizeStudioCommand('three_studio_inspect', { query: 'rtxDigest' }), 'Inspect RTX digest');
  assert.equal(summarizeStudioCommand('three_studio_inspect', { query: 'beautyDigest' }), 'Inspect beauty evidence pixels');
  assert.equal(summarizeStudioCommand('three_studio_inspect', { query: 'projectVisibility' }), 'Inspect camera projection visibility');
});

test('one telemetry entry advances started to completed without retaining raw request or result data', () => {
  let milliseconds = Date.UTC(2026, 7, 29, 1, 2, 3, 4);
  const events = [];
  const telemetry = createStudioCommandTelemetry({ now: () => milliseconds });
  telemetry.subscribe((snapshot, event) => events.push({ snapshot, event }));

  const lifecycle = telemetry.begin('three_studio_apply', {
    sessionId: 'session-private',
    projectId: 'project/private',
    idempotencyKey: 'private-idempotency',
    baseRevision: 7,
    label: '<img src=x onerror=token>',
    selector: { ids: ['entity/private'] },
    operations: [{ op: 'entity.patch', patch: { token: 'request-secret' } }],
  });
  assert.ok(lifecycle);
  assert.equal(telemetry.snapshot().length, 1);
  const started = telemetry.snapshot()[0];
  assert.equal(started.id, lifecycle.id);
  assert.equal(started.timestamp, '01:02:03.004');
  assert.equal(started.stage, 'started');
  assert.equal(started.revision, 7);
  assert.equal(started.summary, 'Apply 1 operation');

  milliseconds += 1_234;
  lifecycle.complete({
    revision: 8,
    evidence: [{ path: 'C:\\private\\frame.png', data: 'base64-result-secret' }],
    sessionId: 'result-session-private',
    stack: 'result-stack-private',
  });
  const completed = telemetry.snapshot()[0];
  assert.equal(completed.id, started.id);
  assert.equal(completed.stage, 'completed');
  assert.equal(completed.elapsedMs, 1_234);
  assert.equal(completed.revision, 8);
  assert.equal(telemetry.snapshot().length, 1);
  assert.equal(events.at(-1).event.entry.id, started.id);

  const serialized = JSON.stringify(events);
  for (const secret of [
    'session-private', 'project/private', 'private-idempotency', 'entity/private',
    'request-secret', 'frame.png', 'base64-result-secret', 'result-stack-private', '<img',
  ]) assert.equal(serialized.includes(secret), false, `telemetry leaked ${secret}`);
});

test('failed lifecycle entries do not retain error messages, stacks, paths, or tokens', () => {
  let milliseconds = 10_000;
  const telemetry = createStudioCommandTelemetry({ now: () => milliseconds });
  const lifecycle = telemetry.begin('three_studio_render', { width: 1280, height: 720 });
  const error = new Error('token=private at C:\\private\\render.mjs');
  error.stack = 'private-stack';
  milliseconds += 50;
  lifecycle.fail(error);
  const entry = telemetry.snapshot()[0];
  assert.equal(entry.stage, 'failed');
  assert.equal(entry.elapsedMs, 50);
  assert.equal(entry.summary, 'Render beauty 1280×720');
  const serialized = JSON.stringify(entry);
  assert.doesNotMatch(serialized, /private|token|render\.mjs/i);
});

test('completed history is bounded while every active command is retained', () => {
  let milliseconds = 1_000;
  const telemetry = createStudioCommandTelemetry({ now: () => milliseconds, historyLimit: 2 });
  const active = telemetry.begin('three_studio_status', {});
  for (let index = 0; index < 3; index += 1) {
    const lifecycle = telemetry.begin('three_studio_validate', {});
    milliseconds += 10;
    lifecycle.complete({ revision: index });
  }
  const whileActive = telemetry.snapshot();
  assert.equal(whileActive.length, 3);
  assert.ok(whileActive.some(entry => entry.id === active.id && entry.stage === 'started'));
  assert.equal(whileActive.filter(entry => entry.stage === 'completed').length, 2);

  milliseconds += 10;
  active.complete({ revision: 4 });
  assert.equal(telemetry.snapshot().length, 2);
  assert.ok(telemetry.snapshot().some(entry => entry.id === active.id));
});

test('subscriber failures are isolated and track preserves dispatch results and failures', async () => {
  const sinkErrors = [];
  const telemetry = createStudioCommandTelemetry({
    onSinkError: error => sinkErrors.push(error.message),
  });
  telemetry.subscribe(() => { throw new Error('broken display sink'); });

  const result = await telemetry.track('three_studio_status', {}, async () => ({ success: true, revision: 9 }));
  assert.deepEqual(result, { success: true, revision: 9 });
  assert.equal(telemetry.snapshot()[0].stage, 'completed');
  assert.ok(sinkErrors.length >= 2);

  const failure = new Error('dispatch failure with token-private');
  await assert.rejects(
    telemetry.track('three_studio_validate', {}, async () => { throw failure; }),
    error => error === failure,
  );
  assert.equal(telemetry.snapshot().at(-1).stage, 'failed');
  assert.doesNotMatch(JSON.stringify(telemetry.snapshot()), /token-private/);
});
