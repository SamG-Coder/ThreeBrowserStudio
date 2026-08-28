import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  LiveBridgeClient,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  RpcError,
  assertLiveSessionIdentity,
  createLiveBridgeServer,
  createSessionCredentials,
  createSessionMarker,
  defaultSessionMarkerPath,
  readSessionMarker,
  safeError,
  writeSessionMarker,
} from '../src/bridge/index.mjs';
import { resolveLiveConnectionOptions } from '../src/mcp/server.mjs';

const execFileAsync = promisify(execFile);

async function fixture(t, dispatch, options = {}) {
  const credentials = createSessionCredentials();
  const server = await createLiveBridgeServer({ credentials, dispatch, ...options });
  const client = new LiveBridgeClient({ ...credentials, timeoutMs: 1_000 });
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });
  return { credentials, server, client };
}

test('authenticated NDJSON RPC correlates concurrent requests and has a built-in ping', async (t) => {
  const seen = [];
  const { client } = await fixture(t, async (method, params, context) => {
    seen.push({ method, id: context.id, sessionId: context.sessionId });
    await new Promise((resolve) => setTimeout(resolve, params.delay));
    return { value: params.value };
  });

  const [slow, fast] = await Promise.all([
    client.request('echo', { value: 'slow', delay: 20 }),
    client.request('echo', { value: 'fast', delay: 1 }),
  ]);
  assert.deepEqual(slow, { value: 'slow' });
  assert.deepEqual(fast, { value: 'fast' });
  assert.equal(new Set(seen.map(({ id }) => id)).size, 2);

  const ping = await client.ping();
  assert.equal(ping.protocolVersion, PROTOCOL_VERSION);
  assert.equal(typeof ping.pid, 'number');
});

test('wrong ownership token is rejected with a typed error', async (t) => {
  const { credentials } = await fixture(t, async () => ({ shouldNotRun: true }));
  const badClient = new LiveBridgeClient({
    ...credentials,
    token: 'x'.repeat(43),
    timeoutMs: 500,
  });
  t.after(() => badClient.close().catch(() => {}));
  await assert.rejects(
    badClient.request('secret', {}),
    (error) => error instanceof RpcError && error.code === 'authentication_failed',
  );
});

test('control messages are capped at one MiB before transport', async (t) => {
  const { client } = await fixture(t, async () => ({}));
  await assert.rejects(
    client.request('echo', { blob: 'x'.repeat(MAX_MESSAGE_BYTES) }),
    (error) => error instanceof RpcError && error.code === 'message_too_large',
  );
});

test('server-side dispatch timeout is explicit and aborts the dispatch signal', async (t) => {
  let aborted = false;
  const { client } = await fixture(t, async (_method, _params, context) => {
    context.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    return new Promise(() => {});
  }, { requestTimeoutMs: 30 });

  await assert.rejects(
    client.request('hang', {}, { timeoutMs: 500 }),
    (error) => error instanceof RpcError && error.code === 'timeout',
  );
  assert.equal(aborted, true);
});

test('domain error codes and compact conflict data survive the thin bridge', async (t) => {
  const { client } = await fixture(t, async () => {
    const error = new Error('Base revision is stale.');
    error.code = 'revision_conflict';
    error.data = { currentRevision: 9, changedIds: ['courtyard/door'] };
    throw error;
  });
  await assert.rejects(client.request('three_studio_apply', {}), (error) => {
    assert.equal(error.code, 'revision_conflict');
    assert.deepEqual(error.data, { currentRevision: 9, changedIds: ['courtyard/door'] });
    return true;
  });
});

test('Studio-style details survive as redacted bridge error data', () => {
  const error = Object.assign(new Error('Candidate failed'), {
    code: 'runtime_compile_failed',
    details: {
      diagnostics: [{ code: 'unsupported_kind', message: 'No sprite compiler' }],
      cause: new Error('private stack'),
      token: 'secret',
    },
  });
  assert.deepEqual(safeError(error), {
    code: 'runtime_compile_failed',
    message: 'Candidate failed',
    data: { diagnostics: [{ code: 'unsupported_kind', message: 'No sprite compiler' }] },
  });
});

test('closing the live server rejects pending client work', async (t) => {
  const { server, client } = await fixture(t, () => new Promise(() => {}), { requestTimeoutMs: 2_000 });
  const pending = client.request('hang', {}, { timeoutMs: 2_000 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await server.close();
  await assert.rejects(pending, (error) => error instanceof RpcError && error.code === 'connection_closed');
});

test('session marker is strict, atomic, and contains the live ownership data', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'three-studio-marker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const markerPath = path.join(directory, '.studio', 'live.json');
  const credentials = createSessionCredentials();
  const marker = createSessionMarker({
    credentials,
    projectPath: path.join(directory, 'project'),
    projectId: 'project/test',
    revision: 7,
    viewportReady: true,
  });
  await writeSessionMarker(markerPath, marker);
  assert.deepEqual(await readSessionMarker(markerPath), marker);
  const persisted = JSON.parse(await readFile(markerPath, 'utf8'));
  assert.equal(persisted.token, credentials.token);
  assert.equal(persisted.pipePath, credentials.pipePath);
  assert.equal(persisted.revision, 7);
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'),
      [path.dirname(markerPath)],
      { encoding: 'utf8', windowsHide: true, shell: false },
    );
    assert.doesNotMatch(stdout, /\(I\)/, 'marker directory must not retain inherited ACL entries');
    assert.equal((stdout.match(/\(OI\)\(CI\)\(F\)/g) ?? []).length, 3);
  }
});

test('session markers reject stale and implausibly future heartbeats', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'three-studio-stale-marker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const markerPath = path.join(directory, '.studio', 'live.json');
  const now = Date.now();
  const stale = createSessionMarker({ heartbeat: new Date(now - 30_001).toISOString() });
  await writeSessionMarker(markerPath, stale);
  await assert.rejects(
    readSessionMarker(markerPath, { now }),
    (error) => error instanceof RpcError && error.code === 'stale_session',
  );

  const future = createSessionMarker({ heartbeat: new Date(now + 30_001).toISOString() });
  await writeSessionMarker(markerPath, future);
  await assert.rejects(
    readSessionMarker(markerPath, { now }),
    (error) => error instanceof RpcError && error.code === 'stale_session',
  );
});

test('ping identity must exactly match the marker session and process', () => {
  const marker = createSessionMarker();
  const ping = {
    protocolVersion: marker.protocolVersion,
    sessionId: marker.sessionId,
    pid: marker.pid,
    heartbeat: new Date().toISOString(),
  };
  assert.equal(assertLiveSessionIdentity(marker, ping), ping);
  assert.throws(
    () => assertLiveSessionIdentity(marker, { ...ping, sessionId: 'different-session' }),
    (error) => error instanceof RpcError && error.code === 'session_mismatch',
  );
  assert.throws(
    () => assertLiveSessionIdentity(marker, { ...ping, pid: marker.pid + 1 }),
    (error) => error instanceof RpcError && error.code === 'session_mismatch',
  );
});

test('MCP connection discovery defaults to the per-user fresh marker', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'three-studio-default-marker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = process.platform === 'win32'
    ? { LOCALAPPDATA: directory }
    : { XDG_RUNTIME_DIR: directory };
  const markerPath = defaultSessionMarkerPath({ env });
  const marker = createSessionMarker();
  await writeSessionMarker(markerPath, marker);
  const connection = await resolveLiveConnectionOptions({ env });
  assert.equal(connection.sessionId, marker.sessionId);
  assert.equal(connection.pid, marker.pid);
  assert.equal(connection.pipePath, marker.pipePath);
});

test('unauthenticated sockets are closed after the pre-authentication deadline', async (t) => {
  const { credentials } = await fixture(t, async () => ({}), { preAuthTimeoutMs: 25 });
  const socket = net.createConnection(credentials.pipePath);
  const closed = once(socket, 'close');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  await closed;
  assert.equal(socket.destroyed, true);
});

test('the bridge refuses sockets beyond its total connection cap', async (t) => {
  const { credentials } = await fixture(t, async () => ({}), {
    maxSockets: 1,
    preAuthTimeoutMs: 1_000,
  });
  const first = net.createConnection(credentials.pipePath);
  await once(first, 'connect');
  const second = net.createConnection(credentials.pipePath);
  const secondClosed = once(second, 'close');
  t.after(() => {
    first.destroy();
    second.destroy();
  });
  await secondClosed;
  assert.equal(first.destroyed, false);
  assert.equal(second.destroyed, true);
});

test('each authenticated socket has a bounded number of active requests', async (t) => {
  let release;
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const { client } = await fixture(t, async (method) => {
    if (method === 'hold') {
      started();
      return held;
    }
    return { unexpected: true };
  }, { maxPendingRequests: 1 });

  const first = client.request('hold', {});
  await didStart;
  await assert.rejects(
    client.request('second', {}),
    (error) => error instanceof RpcError && error.code === 'resource_exhausted',
  );
  release({ released: true });
  assert.deepEqual(await first, { released: true });
});
