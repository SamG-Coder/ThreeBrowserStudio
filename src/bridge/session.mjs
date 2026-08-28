import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PROTOCOL_VERSION, RpcError, isPlainObject } from './protocol.mjs';

const MAX_MARKER_BYTES = 64 * 1024;
const execFileAsync = promisify(execFile);
const securedMarkerDirectories = new Set();
let currentWindowsUserSid;

export const DEFAULT_SESSION_MAX_AGE_MS = 30_000;
export const DEFAULT_SESSION_FUTURE_SKEW_MS = 30_000;

export function defaultSessionMarkerPath({
  env = process.env,
  platform = process.platform,
  homeDirectory = os.homedir(),
} = {}) {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(homeDirectory, 'AppData', 'Local');
    return path.join(localAppData, 'ThreeBrowserStudio', 'live-session.json');
  }
  if (platform === 'darwin') {
    return path.join(homeDirectory, 'Library', 'Application Support', 'ThreeBrowserStudio', 'live-session.json');
  }
  const stateRoot = env.XDG_RUNTIME_DIR || env.XDG_STATE_HOME || path.join(homeDirectory, '.local', 'state');
  return path.join(stateRoot, 'threebrowser-studio', 'live-session.json');
}

function windowsSystemTool(filename, env = process.env) {
  const windowsRoot = env.SystemRoot || env.windir || 'C:\\Windows';
  return path.join(windowsRoot, 'System32', filename);
}

async function getCurrentWindowsUserSid(env = process.env) {
  if (currentWindowsUserSid) return currentWindowsUserSid;
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      windowsSystemTool('whoami.exe', env),
      ['/user', '/fo', 'csv', '/nh'],
      { encoding: 'utf8', windowsHide: true, shell: false },
    ));
  } catch (error) {
    throw new RpcError('session_permissions_failed', 'Could not resolve the current Windows user SID.', undefined, { cause: error });
  }
  const match = String(stdout).match(/S-\d(?:-\d+)+/i);
  if (!match) throw new RpcError('session_permissions_failed', 'Could not parse the current Windows user SID.');
  currentWindowsUserSid = match[0];
  return currentWindowsUserSid;
}

export async function secureSessionMarkerDirectory(directory, { env = process.env, platform = process.platform } = {}) {
  const resolved = path.resolve(directory);
  if (securedMarkerDirectories.has(resolved)) return resolved;
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new RpcError('session_permissions_failed', 'The live-session marker directory must be a real directory.');
  }

  if (platform === 'win32') {
    const userSid = await getCurrentWindowsUserSid(env);
    try {
      await execFileAsync(
        windowsSystemTool('icacls.exe', env),
        [
          resolved,
          '/inheritance:r',
          '/grant:r',
          `*${userSid}:(OI)(CI)F`,
          '*S-1-5-18:(OI)(CI)F',
          '*S-1-5-32-544:(OI)(CI)F',
        ],
        { encoding: 'utf8', windowsHide: true, shell: false },
      );
    } catch (error) {
      throw new RpcError('session_permissions_failed', 'Could not secure the live-session marker directory ACL.', undefined, { cause: error });
    }
  } else {
    await chmod(resolved, 0o700);
  }
  securedMarkerDirectories.add(resolved);
  return resolved;
}

export function createPipePath({ pid = process.pid, nonce = randomUUID() } = {}) {
  const safeNonce = String(nonce).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
  if (process.platform === 'win32') return `\\\\.\\pipe\\three-studio-${pid}-${safeNonce}`;
  return path.join(process.env.TMPDIR || process.env.TEMP || '/tmp', `three-studio-${pid}-${safeNonce}.sock`);
}

export function createSessionCredentials(options = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: options.sessionId ?? randomUUID(),
    pipePath: options.pipePath ?? createPipePath(options),
    token: options.token ?? randomBytes(32).toString('base64url'),
  };
}

export function validateSessionMarker(marker) {
  if (!isPlainObject(marker)) throw new RpcError('invalid_message', 'Session marker must be an object.');
  const allowed = new Set([
    'protocolVersion', 'sessionId', 'pid', 'pipePath', 'token', 'projectPath',
    'projectId', 'revision', 'heartbeat', 'viewportReady',
  ]);
  for (const key of Object.keys(marker)) {
    if (!allowed.has(key)) throw new RpcError('invalid_message', `Unexpected session marker field: ${key}.`);
  }
  if (marker.protocolVersion !== PROTOCOL_VERSION) throw new RpcError('protocol_mismatch', `Expected protocol ${PROTOCOL_VERSION}.`);
  if (typeof marker.sessionId !== 'string' || marker.sessionId.length < 1 || marker.sessionId.length > 128) {
    throw new RpcError('invalid_message', 'Session marker has an invalid sessionId.');
  }
  if (!Number.isSafeInteger(marker.pid) || marker.pid < 1) throw new RpcError('invalid_message', 'Session marker has an invalid pid.');
  if (typeof marker.pipePath !== 'string' || marker.pipePath.length < 1 || marker.pipePath.length > 1024) {
    throw new RpcError('invalid_message', 'Session marker has an invalid pipePath.');
  }
  if (typeof marker.token !== 'string' || marker.token.length < 32 || marker.token.length > 256) {
    throw new RpcError('authentication_failed', 'Session marker has an invalid token.');
  }
  if (marker.projectPath !== null && marker.projectPath !== undefined && typeof marker.projectPath !== 'string') {
    throw new RpcError('invalid_message', 'Session marker projectPath must be a string or null.');
  }
  if (marker.projectId !== null && marker.projectId !== undefined && typeof marker.projectId !== 'string') {
    throw new RpcError('invalid_message', 'Session marker projectId must be a string or null.');
  }
  if (!Number.isSafeInteger(marker.revision) || marker.revision < 0) throw new RpcError('invalid_message', 'Session marker has an invalid revision.');
  if (typeof marker.heartbeat !== 'string' || !Number.isFinite(Date.parse(marker.heartbeat))) {
    throw new RpcError('invalid_message', 'Session marker has an invalid heartbeat.');
  }
  if (marker.viewportReady !== undefined && typeof marker.viewportReady !== 'boolean') {
    throw new RpcError('invalid_message', 'Session marker viewportReady must be boolean.');
  }
  return Object.freeze({ ...marker });
}

export function assertSessionMarkerFresh(marker, {
  now = Date.now(),
  maxAgeMs = DEFAULT_SESSION_MAX_AGE_MS,
  maxFutureSkewMs = DEFAULT_SESSION_FUTURE_SKEW_MS,
} = {}) {
  const valid = validateSessionMarker(marker);
  if (!Number.isFinite(now)) throw new TypeError('now must be a finite epoch timestamp.');
  if ((!Number.isFinite(maxAgeMs) && maxAgeMs !== Infinity) || maxAgeMs < 0) {
    throw new RangeError('maxAgeMs must be a non-negative number or Infinity.');
  }
  if (!Number.isFinite(maxFutureSkewMs) || maxFutureSkewMs < 0) {
    throw new RangeError('maxFutureSkewMs must be a non-negative finite number.');
  }
  const heartbeat = Date.parse(valid.heartbeat);
  if (heartbeat > now + maxFutureSkewMs) {
    throw new RpcError('stale_session', 'The live-session marker heartbeat is too far in the future.');
  }
  if (maxAgeMs !== Infinity && now - heartbeat > maxAgeMs) {
    throw new RpcError('stale_session', `The live-session marker is older than ${maxAgeMs}ms.`);
  }
  return valid;
}

export function assertLiveSessionIdentity(expected, ping) {
  const marker = validateSessionMarker(expected);
  if (!isPlainObject(ping) ||
      ping.protocolVersion !== marker.protocolVersion ||
      typeof ping.sessionId !== 'string' ||
      !Number.isSafeInteger(ping.pid) ||
      typeof ping.heartbeat !== 'string' ||
      !Number.isFinite(Date.parse(ping.heartbeat))) {
    throw new RpcError('invalid_message', 'The live bridge returned an invalid ping identity.');
  }
  if (ping.sessionId !== marker.sessionId || ping.pid !== marker.pid) {
    throw new RpcError('session_mismatch', 'The live bridge does not match the session marker identity.');
  }
  return ping;
}

export function createSessionMarker({ credentials, ...state } = {}) {
  const live = credentials ?? createSessionCredentials();
  return validateSessionMarker({
    protocolVersion: PROTOCOL_VERSION,
    sessionId: live.sessionId,
    pid: state.pid ?? process.pid,
    pipePath: live.pipePath,
    token: live.token,
    projectPath: state.projectPath ?? null,
    projectId: state.projectId ?? null,
    revision: state.revision ?? 0,
    heartbeat: state.heartbeat ?? new Date().toISOString(),
    viewportReady: state.viewportReady ?? false,
  });
}

export async function readSessionMarker(markerPath = defaultSessionMarkerPath(), options = {}) {
  const info = await stat(markerPath);
  if (info.size > MAX_MARKER_BYTES) throw new RpcError('message_too_large', 'Session marker is too large.');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(markerPath, 'utf8'));
  } catch (error) {
    throw new RpcError('invalid_message', 'Could not parse the live-session marker.', undefined, { cause: error });
  }
  return assertSessionMarkerFresh(validateSessionMarker(parsed), options);
}

export async function writeSessionMarker(markerPath, marker) {
  const valid = validateSessionMarker(marker);
  const resolved = path.resolve(markerPath);
  const temporary = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
  await secureSessionMarkerDirectory(path.dirname(resolved));
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(valid, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, resolved);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return valid;
}

export async function touchSessionMarker(markerPath, patch = {}) {
  const current = await readSessionMarker(markerPath, { maxAgeMs: Infinity });
  return writeSessionMarker(markerPath, {
    ...current,
    ...patch,
    protocolVersion: PROTOCOL_VERSION,
    sessionId: current.sessionId,
    pipePath: current.pipePath,
    token: current.token,
    pid: current.pid,
    heartbeat: new Date().toISOString(),
  });
}
