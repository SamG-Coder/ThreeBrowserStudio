import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { StudioError } from '../core/errors.mjs';

const FIXED_CLI = ['tools', 'rehearsal-sidecar', 'src', 'cli.mjs'];
const REFERENCE_PATTERN = /^(?![A-Za-z]:)(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const MAX_PROTOCOL_BYTES = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const ENVIRONMENT_ALLOWLIST = new Set([
  'appdata', 'comspec', 'localappdata', 'path', 'pathext', 'programdata', 'programfiles',
  'programfiles(x86)', 'programw6432', 'systemdrive', 'systemroot', 'temp', 'tmp', 'userprofile', 'windir',
]);

function minimalEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment ?? {}).filter(([key]) => ENVIRONMENT_ALLOWLIST.has(key.toLowerCase())));
}

async function resolveFixedCli(repositoryRoot) {
  if (typeof repositoryRoot !== 'string' || repositoryRoot.trim() === '') {
    throw new StudioError('rehearsal_not_configured', 'Rehearsal jobs require THREE_STUDIO_REHEARSAL_ROOT.');
  }
  const supplied = path.resolve(repositoryRoot);
  const parsed = path.parse(supplied);
  let current = parsed.root;
  for (const segment of path.relative(parsed.root, supplied).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (!info?.isDirectory()) throw new StudioError('rehearsal_root_invalid', 'Configured rehearsal root must be a real directory.');
    if (info.isSymbolicLink()) throw new StudioError('rehearsal_root_reparse', 'Configured rehearsal root must not traverse a reparse point.');
  }
  const root = await realpath(supplied);
  current = root;
  for (const segment of FIXED_CLI) {
    current = path.join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (!info) throw new StudioError('rehearsal_cli_missing', 'The fixed rehearsal sidecar entrypoint was not found.');
    if (info.isSymbolicLink()) throw new StudioError('rehearsal_cli_reparse', 'The fixed rehearsal entrypoint must not traverse a reparse point.');
  }
  if (!(await stat(current)).isFile()) throw new StudioError('rehearsal_cli_missing', 'The fixed rehearsal sidecar entrypoint is not a regular file.');
  return { root, cli: await realpath(current) };
}

function cloneEvidence(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function summarizeTerminal(terminal, progressEvents) {
  if (terminal?.error) {
    throw new StudioError('rehearsal_failed', 'The fixed rehearsal sidecar rejected the run.', {
      sidecarCode: terminal.error.code,
      bundle: cloneEvidence(terminal.error.data?.bundle),
    });
  }
  const result = terminal?.result;
  const manifest = result?.bundle?.manifest;
  if (!result || typeof result.runId !== 'string' || !Number.isInteger(result.exitCode)
      || typeof result.reason !== 'string' || !/^[a-f0-9]{64}$/u.test(result.bundle?.bundleId ?? '')
      || !manifest || !['passed', 'failed'].includes(manifest.outcome)) {
    throw new StudioError('rehearsal_protocol_invalid', 'The fixed rehearsal sidecar returned an invalid terminal result.');
  }
  const summary = {
    runId: result.runId,
    exitCode: result.exitCode,
    reason: result.reason,
    bundle: {
      bundleId: result.bundle.bundleId,
      outcome: manifest.outcome,
      git: cloneEvidence(manifest.git),
      source: cloneEvidence(manifest.source),
      stateDigest: cloneEvidence(manifest.stateDigest),
      assertions: cloneEvidence(manifest.assertions ?? []),
      captures: cloneEvidence(manifest.captures ?? []),
    },
    progressEvents,
  };
  if (result.exitCode !== 0 || manifest.outcome !== 'passed') {
    throw new StudioError('rehearsal_failed', 'The authoritative rehearsal did not pass.', summary);
  }
  return summary;
}

export function createRehearsalSidecarClient({
  repositoryRoot,
  nodeExecutable = process.execPath,
  environment = process.env,
  spawnProcess = spawn,
  shutdownGraceMs = 2_000,
} = {}) {
  return Object.freeze({
    configured: typeof repositoryRoot === 'string' && repositoryRoot.trim() !== '',
    async run({ runSpecReference, signal, timeoutMs = 115_000 } = {}) {
      if (typeof runSpecReference !== 'string' || !REFERENCE_PATTERN.test(runSpecReference)) {
        throw new StudioError('rehearsal_run_spec_invalid', 'Rehearsal jobs accept only a normalized repository-relative run-spec reference.');
      }
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 240_000) {
        throw new StudioError('rehearsal_timeout_invalid', 'Rehearsal client timeout must be from 1 to 240000 milliseconds.');
      }
      if (signal?.aborted) throw new StudioError('rehearsal_cancelled', 'Rehearsal request was cancelled before launch.');
      const { root, cli } = await resolveFixedCli(repositoryRoot);
      const child = spawnProcess(nodeExecutable, [cli], {
        cwd: root,
        env: minimalEnvironment(environment),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const requestId = `studio-${randomUUID()}`;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let buffer = '';
      let progressEvents = 0;
      let settled = false;
      let settleTerminal;
      let rejectTerminal;
      const terminalPromise = new Promise((resolve, reject) => {
        settleTerminal = resolve;
        rejectTerminal = reject;
      });
      const closePromise = new Promise(resolve => child.once('close', resolve));
      const fail = error => {
        if (settled) return;
        settled = true;
        rejectTerminal(error);
      };
      child.once('error', error => fail(new StudioError('rehearsal_launch_failed', `The fixed rehearsal sidecar did not launch: ${error.message}`)));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > MAX_PROTOCOL_BYTES) {
          fail(new StudioError('rehearsal_protocol_too_large', 'Rehearsal protocol output exceeded its byte limit.'));
          child.stdin.end();
          return;
        }
        buffer += chunk;
        const lines = buffer.split(/\r?\n/u);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line === '') continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            fail(new StudioError('rehearsal_protocol_invalid', 'Rehearsal sidecar emitted non-JSON protocol output.'));
            child.stdin.end();
            return;
          }
          if (message.method === 'progress') progressEvents += 1;
          if (message.id === requestId && !settled) {
            settled = true;
            settleTerminal(message);
          }
        }
      });
      child.stderr.on('data', chunk => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_DIAGNOSTIC_BYTES) {
          fail(new StudioError('rehearsal_diagnostics_too_large', 'Rehearsal diagnostic output exceeded its byte limit.'));
          child.stdin.end();
        }
      });
      child.once('close', code => {
        if (!settled) fail(new StudioError('rehearsal_protocol_closed', `Rehearsal sidecar closed before a terminal response (exit ${code}).`));
      });
      const terminate = error => {
        fail(error);
        child.stdin.end();
        const force = setTimeout(() => child.kill(), shutdownGraceMs);
        force.unref?.();
      };
      const abort = () => terminate(new StudioError('rehearsal_cancelled', 'Rehearsal request was cancelled.'));
      signal?.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(() => terminate(new StudioError('rehearsal_timeout', 'Rehearsal request exceeded the Studio client timeout.')), timeoutMs);
      timeout.unref?.();
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: requestId, method: 'run', params: { runSpecReference },
      })}\n`);
      try {
        const terminal = await terminalPromise;
        child.stdin.end();
        await closePromise;
        return summarizeTerminal(terminal, progressEvents);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        if (!child.stdin.destroyed) child.stdin.end();
        await closePromise;
      }
    },
  });
}
