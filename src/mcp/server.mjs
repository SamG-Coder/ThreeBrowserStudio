import { pathToFileURL } from 'node:url';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import {
  LiveBridgeClient,
  MAX_MESSAGE_BYTES,
  assertLiveSessionIdentity,
  defaultSessionMarkerPath,
  readSessionMarker,
} from '../bridge/index.mjs';
import { createThreeStudioMcpServer } from './tools.mjs';

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

export async function runThreeStudioMcp({ argv = process.argv.slice(2), env = process.env, stderr = process.stderr } = {}) {
  const connection = await resolveLiveConnectionOptions({ argv, env });
  const client = new LiveBridgeClient(connection);
  try {
    await client.connect();
    const ping = await client.ping({ timeoutMs: 5_000 });
    if (connection.sessionId !== undefined || connection.pid !== undefined) {
      assertLiveSessionIdentity(connection, ping);
    }
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }

  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: MAX_MESSAGE_BYTES,
  });
  const handle = serveStdio(
    () => createThreeStudioMcpServer({ dispatch: client }),
    {
      transport,
      onerror(error) {
        stderr.write(`[three-studio MCP] ${error.message}\n`);
      },
    },
  );

  const close = async () => {
    await handle.close();
    await client.close();
  };
  return { client, handle, close };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runThreeStudioMcp().catch((error) => {
    process.stderr.write(`[three-studio MCP] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
