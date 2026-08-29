import { pathToFileURL } from 'node:url';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import {
  LiveBridgeClient,
  MAX_MESSAGE_BYTES,
  RpcError,
  assertLiveSessionIdentity,
  defaultSessionMarkerPath,
  readSessionMarker,
} from '../bridge/index.mjs';
import { createThreeStudioMcpServer, synchronizeThreeStudioToolContract } from './tools.mjs';
import { TOOL_CONTRACT } from './tool-schemas.mjs';

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--marker' || argument === '--pipe' || argument === '--token') {
      if (!argv[index + 1]) throw new Error(`${argument} requires a value.`);
      values[argument.slice(2)] = argv[++index];
    } else {
      throw new Error(`Unknown MCP argument: ${argument}.`);
    }
  }
  return values;
}

export async function resolveLiveConnectionOptions({ argv = [], env = process.env } = {}) {
  const cli = parseArguments(argv);
  const configuredPipe = cli.pipe ?? env.THREE_STUDIO_PIPE;
  const configuredToken = cli.token ?? env.THREE_STUDIO_TOKEN;
  let markerPath = cli.marker ?? env.THREE_STUDIO_SESSION_MARKER;
  if (!markerPath && !configuredPipe && !configuredToken) {
    markerPath = defaultSessionMarkerPath({ env });
  } else if (!markerPath && (!configuredPipe || !configuredToken)) {
    throw new Error('A direct live connection requires both THREE_STUDIO_PIPE and THREE_STUDIO_TOKEN.');
  }
  let marker = {};
  if (markerPath) marker = await readSessionMarker(markerPath);
  const pipePath = configuredPipe ?? marker.pipePath;
  const token = configuredToken ?? marker.token;
  if (!pipePath || !token) {
    throw new Error('No live Studio session was specified. Start Studio, set THREE_STUDIO_SESSION_MARKER, or set both THREE_STUDIO_PIPE and THREE_STUDIO_TOKEN.');
  }
  return {
    ...marker,
    pipePath,
    token,
  };
}

function isRetryableLiveDisconnect(error) {
  const code = error?.code;
  return code === 'connection_closed' || code === 'timeout' || code === 'session_mismatch';
}

async function assertToolContract(ping, onToolContract) {
  const actual = ping?.serverInfo?.toolContract;
  if (actual?.hash === TOOL_CONTRACT.hash) {
    if (onToolContract) await onToolContract(actual);
    return actual;
  }
  if (onToolContract && actual?.inputSchemas) {
    await onToolContract(actual);
    return actual;
  }
  throw new RpcError(
    'tool_contract_mismatch',
    'The native Studio and this MCP adapter expose different tool contracts. Restart or reconnect the MCP client so it rediscovers Studio tools.',
    {
      expectedHash: TOOL_CONTRACT.hash,
      actualHash: actual?.hash ?? null,
      expectedVersion: TOOL_CONTRACT.contractVersion,
      actualVersion: actual?.contractVersion ?? null,
    },
  );
}

export function createLiveMcpDispatch({
  argv = [],
  env = process.env,
  resolveConnection = resolveLiveConnectionOptions,
  clientFactory = (connection) => new LiveBridgeClient(connection),
  assertIdentity = assertLiveSessionIdentity,
  onToolContract,
} = {}) {
  let client;
  let connecting;

  const resetClient = async () => {
    const current = client;
    client = undefined;
    connecting = undefined;
    if (current) await current.close().catch(() => {});
  };

  const ensureClient = async () => {
    if (client) return client;
    if (connecting) return connecting;
    connecting = (async () => {
      const connection = await resolveConnection({ argv, env });
      const next = clientFactory(connection);
      try {
        await next.connect();
        const ping = await next.ping({ timeoutMs: 5_000 });
        if (connection.sessionId !== undefined || connection.pid !== undefined) {
          assertIdentity(connection, ping);
        }
        await assertToolContract(ping, onToolContract);
        client = next;
        return next;
      } catch (error) {
        await next.close().catch(() => {});
        throw error;
      }
    })().finally(() => {
      connecting = undefined;
    });
    try {
      return await connecting;
    } catch (error) {
      await resetClient();
      throw error;
    }
  };

  const dispatch = async (method, params = {}, context = {}) => {
    try {
      const live = await ensureClient();
      return await live.request(method, params, { signal: context.signal });
    } catch (error) {
      if (!isRetryableLiveDisconnect(error)) throw error;
      await resetClient();
      const live = await ensureClient();
      return live.request(method, params, { signal: context.signal });
    }
  };

  return { dispatch, ensureClient, close: resetClient };
}

/** Keeps the latest verified native contract while preserving fresh SDK server instances. */
export function createSynchronizedMcpServerFactory({ dispatch } = {}) {
  let currentServer;
  let latestContract;
  return {
    create() {
      const server = createThreeStudioMcpServer({ dispatch });
      if (latestContract) synchronizeThreeStudioToolContract(server, latestContract);
      currentServer = server;
      return server;
    },
    synchronize(contract) {
      latestContract = contract;
      if (!currentServer) return { changed: false, deferred: true, hash: contract.hash };
      return synchronizeThreeStudioToolContract(currentServer, contract);
    },
  };
}

export async function runThreeStudioMcp({ argv = process.argv.slice(2), env = process.env, stderr = process.stderr } = {}) {
  let serverFactory;
  const live = createLiveMcpDispatch({
    argv,
    env,
    onToolContract(contract) {
      if (!serverFactory) throw new RpcError('tool_contract_mismatch', 'The MCP server is not ready to refresh its live tool contract.');
      return serverFactory.synchronize(contract);
    },
  });
  serverFactory = createSynchronizedMcpServerFactory({ dispatch: live.dispatch });
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: MAX_MESSAGE_BYTES,
  });
  const handle = serveStdio(
    () => serverFactory.create(),
    {
      transport,
      onerror(error) {
        stderr.write(`[three-studio MCP] ${error.message}\n`);
      },
    },
  );
  live.ensureClient().catch((error) => {
    stderr.write(`[three-studio MCP] waiting for native viewport: ${error.message}\n`);
  });

  const close = async () => {
    await handle.close();
    await live.close();
  };
  return { handle, close };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runThreeStudioMcp().catch((error) => {
    process.stderr.write(`[three-studio MCP] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
