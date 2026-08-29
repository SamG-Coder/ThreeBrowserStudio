import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveMcpDispatch } from '../src/mcp/index.mjs';
import { TOOL_CONTRACT } from '../src/mcp/tool-schemas.mjs';
import { computeToolContractHash } from '../src/mcp/tool-schemas.mjs';
import { RpcError } from '../src/bridge/protocol.mjs';

const LIVE_CONNECTION = {
  protocolVersion: 'three-studio/1',
  sessionId: 'live-session',
  pid: 7,
  pipePath: '\\\\.\\pipe\\three-studio-test',
  token: 'a'.repeat(32),
  revision: 0,
  heartbeat: '2026-08-29T16:00:00.000Z',
};

const LIVE_PING = {
  protocolVersion: LIVE_CONNECTION.protocolVersion,
  sessionId: LIVE_CONNECTION.sessionId,
  pid: LIVE_CONNECTION.pid,
  heartbeat: LIVE_CONNECTION.heartbeat,
  serverInfo: { toolContract: TOOL_CONTRACT },
};

function fakeClient({ ping = LIVE_PING, request } = {}) {
  const calls = { connect: 0, ping: 0, request: 0, close: 0 };
  return {
    calls,
    async connect() {
      calls.connect += 1;
      return this;
    },
    async ping() {
      calls.ping += 1;
      return ping;
    },
    async request(method, params) {
      calls.request += 1;
      if (request) return request(method, params);
      return { success: true, method };
    },
    async close() {
      calls.close += 1;
    },
  };
}

test('live MCP dispatch completes without connecting until the first tool call', async () => {
  let factoryCalls = 0;
  const client = fakeClient();
  const live = createLiveMcpDispatch({
    resolveConnection: async () => LIVE_CONNECTION,
    clientFactory() {
      factoryCalls += 1;
      return client;
    },
  });
  assert.equal(factoryCalls, 0);
  const result = await live.dispatch('three_studio_status', {});
  assert.equal(factoryCalls, 1);
  assert.equal(client.calls.connect, 1);
  assert.equal(client.calls.ping, 1);
  assert.equal(client.calls.request, 1);
  assert.equal(result.method, 'three_studio_status');
});

test('live MCP dispatch leaves the stdio server alive when no viewport marker exists', async () => {
  const live = createLiveMcpDispatch({
    resolveConnection: async () => {
      throw new Error('No live Studio session was specified. Start Studio.');
    },
    clientFactory() {
      throw new Error('clientFactory must not run without a connection.');
    },
  });
  await assert.rejects(
    () => live.dispatch('three_studio_status', {}),
    /No live Studio session/,
  );
});

test('live MCP dispatch reconnects once after a dropped live bridge', async () => {
  const first = fakeClient({
    request() {
      throw new RpcError('connection_closed', 'Studio live bridge closed.');
    },
  });
  const second = fakeClient();
  const clients = [first, second];
  const live = createLiveMcpDispatch({
    resolveConnection: async () => LIVE_CONNECTION,
    clientFactory() {
      return clients.shift();
    },
  });
  const result = await live.dispatch('three_studio_inspect', { query: 'sceneDigest' });
  assert.equal(first.calls.request, 1);
  assert.equal(first.calls.close, 1);
  assert.equal(second.calls.connect, 1);
  assert.equal(result.method, 'three_studio_inspect');
});

test('live MCP dispatch rejects a stale native tool contract before forwarding calls', async () => {
  const client = fakeClient({
    ping: {
      ...LIVE_PING,
      serverInfo: { toolContract: { ...TOOL_CONTRACT, hash: '0'.repeat(64) } },
    },
  });
  const live = createLiveMcpDispatch({
    resolveConnection: async () => LIVE_CONNECTION,
    clientFactory: () => client,
  });
  await assert.rejects(
    () => live.dispatch('three_studio_status', {}),
    error => error instanceof RpcError
      && error.code === 'tool_contract_mismatch'
      && error.data.actualHash === '0'.repeat(64),
  );
  assert.equal(client.calls.request, 0);
  assert.equal(client.calls.close, 1);
});

test('live MCP dispatch rejects a stale marker contract before connecting', async () => {
  let factoryCalls = 0;
  const live = createLiveMcpDispatch({
    resolveConnection: async () => ({ ...LIVE_CONNECTION, toolContractHash: 'f'.repeat(64) }),
    clientFactory() {
      factoryCalls += 1;
      return fakeClient();
    },
  });
  await assert.rejects(
    () => live.dispatch('three_studio_status', {}),
    error => error instanceof RpcError && error.code === 'tool_contract_mismatch',
  );
  assert.equal(factoryCalls, 0);
});

test('live MCP dispatch refreshes a newer native contract without restarting the adapter', async () => {
  const refreshed = structuredClone(TOOL_CONTRACT);
  refreshed.contractVersion = 'three-studio-tools/future-test';
  refreshed.inputSchemas.three_studio_status.properties.contractProbe = { type: 'boolean' };
  refreshed.hash = computeToolContractHash(refreshed);
  const client = fakeClient({
    ping: {
      ...LIVE_PING,
      serverInfo: { toolContract: refreshed },
    },
  });
  const synchronized = [];
  const live = createLiveMcpDispatch({
    resolveConnection: async () => ({ ...LIVE_CONNECTION, toolContractHash: refreshed.hash }),
    clientFactory: () => client,
    onToolContract(contract) {
      synchronized.push(contract.hash);
    },
  });

  const result = await live.dispatch('three_studio_status', {});
  assert.equal(result.method, 'three_studio_status');
  assert.deepEqual(synchronized, [refreshed.hash]);
  assert.equal(client.calls.request, 1);
});
