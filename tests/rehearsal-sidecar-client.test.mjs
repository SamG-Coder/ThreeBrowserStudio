import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function loadClientFactory() {
  try {
    return (await import('../src/runtime/rehearsal-sidecar-client.mjs')).createRehearsalSidecarClient;
  } catch {
    return undefined;
  }
}

async function fixtureRepository(t, source) {
  const root = await mkdtemp(path.join(tmpdir(), 'three-studio-rehearsal-client-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'tools', 'rehearsal-sidecar', 'src');
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, 'cli.mjs'), source);
  return root;
}

test('fixed rehearsal client returns only verified bundle evidence and a minimal environment', async (t) => {
  const createRehearsalSidecarClient = await loadClientFactory();
  assert.equal(typeof createRehearsalSidecarClient, 'function');
  const root = await fixtureRepository(t, `
    import { createInterface } from 'node:readline';
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.once('line', line => {
      const request = JSON.parse(line);
      if (process.cwd() !== ${JSON.stringify('__ROOT__')}.replace('__ROOT__', process.cwd())) process.exit(8);
      if (process.env.SECRET_TOKEN !== undefined) process.exit(9);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'progress', params: { event: { type: 'started' } } }) + '\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
        runId: 'run-verified', exitCode: 0, reason: 'completed', stagingDirectory: 'PRIVATE',
        unityResult: { status: 'passed', passed: true },
        bundle: { bundleId: 'a'.repeat(64), bundleDirectory: 'PRIVATE', manifest: {
          outcome: 'passed', git: { commit: 'b'.repeat(40), dirty: false },
          source: { path: 'examples/hero.json', sha256: 'c'.repeat(64) },
          stateDigest: { algorithm: 'SHA-256', digest: 'd'.repeat(64) },
          assertions: [{ id: 'game.assertion', owner: 'game', passed: true }],
          captures: [{ path: 'captures/tick-0.png', sha256: 'e'.repeat(64), requestedAuthoritativeTick: 0, presentedAuthoritativeTick: 0 }]
        } }
      } }) + '\\n');
    });
  `);
  const client = createRehearsalSidecarClient({
    repositoryRoot: root,
    environment: { ...process.env, SECRET_TOKEN: 'must-not-cross-boundary' },
  });
  const result = await client.run({ runSpecReference: 'run-specs/p1-hero-chamber.run.json', timeoutMs: 5_000 });
  assert.deepEqual(result, {
    runId: 'run-verified',
    exitCode: 0,
    reason: 'completed',
    bundle: {
      bundleId: 'a'.repeat(64),
      outcome: 'passed',
      git: { commit: 'b'.repeat(40), dirty: false },
      source: { path: 'examples/hero.json', sha256: 'c'.repeat(64) },
      stateDigest: { algorithm: 'SHA-256', digest: 'd'.repeat(64) },
      assertions: [{ id: 'game.assertion', owner: 'game', passed: true }],
      captures: [{ path: 'captures/tick-0.png', sha256: 'e'.repeat(64), requestedAuthoritativeTick: 0, presentedAuthoritativeTick: 0 }],
    },
    progressEvents: 1,
  });
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('fixed rehearsal client rejects traversal before launch and closes on cancellation', async (t) => {
  const createRehearsalSidecarClient = await loadClientFactory();
  assert.equal(typeof createRehearsalSidecarClient, 'function');
  const root = await fixtureRepository(t, `
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    process.stdin.resume();
    process.stdin.once('end', async () => {
      await writeFile(path.join(process.cwd(), 'cancelled.txt'), 'closed');
    });
  `);
  const client = createRehearsalSidecarClient({ repositoryRoot: root });
  await assert.rejects(
    () => client.run({ runSpecReference: '../escape.json', timeoutMs: 100 }),
    error => error.code === 'rehearsal_run_spec_invalid',
  );
  const controller = new AbortController();
  const pending = client.run({
    runSpecReference: 'run-specs/p1-hero-chamber.run.json',
    signal: controller.signal,
    timeoutMs: 5_000,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, error => error.code === 'rehearsal_cancelled');
  assert.equal(await readFile(path.join(root, 'cancelled.txt'), 'utf8'), 'closed');
});
