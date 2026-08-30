import { MAX_PROJECT_PACK_BYTES, parseProjectPack } from '../core/project-pack.mjs';
import { StudioError } from '../core/errors.mjs';

export const STARTER_PROJECT_SCENE_PARAMETER = 'starter-project-scene';

const GITHUB_HOST = 'github.com';
const GITHUB_RAW_HOST = 'raw.githubusercontent.com';
const MAX_STARTER_PROJECT_URL_LENGTH = 4096;
const DEFAULT_STARTER_PROJECT_FETCH_TIMEOUT_MS = 20_000;
const STARTER_PROJECT_OWNER = 'SamG-Coder';
const STARTER_PROJECT_REPOSITORY = 'ThreeBrowserStudio';
const STARTER_PROJECT_DIRECTORY = 'templates/starter-project/scenes/';

function starterSceneError(code, message, data = {}) {
  return new StudioError(code, message, data);
}

function validateStarterProjectPath({ owner, repository, revision, fileParts, url }) {
  const filePath = fileParts.join('/');
  if (!owner || !repository || !revision || !filePath) {
    throw starterSceneError('starter_project_url_path', 'The GitHub starter-project-scene file path is incomplete.');
  }
  if (owner.toLowerCase() !== STARTER_PROJECT_OWNER.toLowerCase()
    || repository.toLowerCase() !== STARTER_PROJECT_REPOSITORY.toLowerCase()
    || !filePath.startsWith(STARTER_PROJECT_DIRECTORY)) {
    throw starterSceneError(
      'starter_project_url_path',
      `starter-project-scene must be a published ${STARTER_PROJECT_DIRECTORY} file from ${STARTER_PROJECT_OWNER}/${STARTER_PROJECT_REPOSITORY}.`,
      { path: url.pathname },
    );
  }
  if (!filePath.toLowerCase().endsWith('.json')) {
    throw starterSceneError('starter_project_url_path', 'starter-project-scene must point to a JSON file.');
  }
  return filePath;
}

function splitRevisionAndStarterPath(parts, url) {
  const fileStart = parts.findIndex((_, index) => parts.slice(index).join('/').startsWith(STARTER_PROJECT_DIRECTORY));
  if (fileStart <= 0) {
    throw starterSceneError('starter_project_url_path', 'The GitHub starter-project-scene file path is incomplete.', {
      path: url.pathname,
    });
  }
  return {
    revision: parts.slice(0, fileStart).join('/'),
    fileParts: parts.slice(fileStart),
  };
}

async function readResponseTextWithinLimit(response, { maxBytes, signal }) {
  const declaredBytes = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    throw starterSceneError('pack_too_large', `Project pack exceeds ${maxBytes} bytes.`, {
      byteCount: declaredBytes,
      maximum: maxBytes,
    });
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    const byteCount = new TextEncoder().encode(text).byteLength;
    if (byteCount > maxBytes) {
      throw starterSceneError('pack_too_large', `Project pack exceeds ${maxBytes} bytes.`, {
        byteCount,
        maximum: maxBytes,
      });
    }
    return text;
  }

  const decoder = new TextDecoder();
  const textParts = [];
  let byteCount = 0;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > maxBytes) {
        await reader.cancel('Project pack is too large.');
        throw starterSceneError('pack_too_large', `Project pack exceeds ${maxBytes} bytes.`, {
          byteCount,
          maximum: maxBytes,
        });
      }
      textParts.push(decoder.decode(value, { stream: true }));
    }
    textParts.push(decoder.decode());
    return textParts.join('');
  } finally {
    reader.releaseLock?.();
  }
}

/** Convert a public GitHub file page into a CORS-readable raw-content URL. */
export function resolveStarterProjectSceneUrl(value) {
  const source = String(value ?? '').trim();
  if (!source) return null;
  if (source.length > MAX_STARTER_PROJECT_URL_LENGTH) {
    throw starterSceneError('starter_project_url_too_long', 'The starter-project-scene URL is too long.');
  }

  let url;
  try {
    url = new URL(source);
  } catch (cause) {
    throw starterSceneError('starter_project_url_invalid', 'starter-project-scene must be an absolute GitHub URL.', { cause });
  }
  if (url.protocol !== 'https:') {
    throw starterSceneError('starter_project_url_insecure', 'starter-project-scene must use HTTPS.');
  }
  if (url.username || url.password) {
    throw starterSceneError('starter_project_url_credentials', 'starter-project-scene must not contain credentials.');
  }
  if (url.port || url.search) {
    throw starterSceneError('starter_project_url_invalid', 'starter-project-scene must not contain a port or query string.');
  }
  url.hash = '';

  const host = url.hostname.toLowerCase();
  if (host === GITHUB_RAW_HOST) {
    const [owner, repository, ...revisionAndFile] = url.pathname.split('/').filter(Boolean);
    const { revision, fileParts } = splitRevisionAndStarterPath(revisionAndFile, url);
    validateStarterProjectPath({ owner, repository, revision, fileParts, url });
    return url.href;
  }
  if (host !== GITHUB_HOST) {
    throw starterSceneError(
      'starter_project_url_host',
      'starter-project-scene must use github.com or raw.githubusercontent.com.',
      { host },
    );
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 5 || !['blob', 'raw'].includes(parts[2])) {
    throw starterSceneError(
      'starter_project_url_path',
      'Use a GitHub file link containing /blob/ or /raw/.',
      { path: url.pathname },
    );
  }
  const [owner, repository, , ...revisionAndFile] = parts;
  const { revision, fileParts } = splitRevisionAndStarterPath(revisionAndFile, url);
  const filePath = validateStarterProjectPath({ owner, repository, revision, fileParts, url });
  return new URL(`/${owner}/${repository}/${revision}/${filePath}`, `https://${GITHUB_RAW_HOST}`).href;
}

export function starterProjectSceneUrlFromLocation(location = globalThis.location) {
  const search = String(location?.search ?? '');
  if (!search) return null;
  return resolveStarterProjectSceneUrl(new URLSearchParams(search).get(STARTER_PROJECT_SCENE_PARAMETER));
}

/** Fetch and validate a canonical project/project-pack selected by the page URL. */
export async function loadStarterProjectSceneFromLocation({
  location = globalThis.location,
  fetch: fetchImpl = globalThis.fetch,
  maxBytes = MAX_PROJECT_PACK_BYTES,
  signal = null,
  timeoutMs = DEFAULT_STARTER_PROJECT_FETCH_TIMEOUT_MS,
} = {}) {
  const sourceUrl = starterProjectSceneUrlFromLocation(location);
  if (!sourceUrl) return null;
  if (typeof fetchImpl !== 'function') {
    throw starterSceneError('starter_project_fetch_unavailable', 'This browser cannot fetch the starter project.');
  }

  const abortController = new AbortController();
  let timedOut = false;
  const forwardAbort = () => abortController.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener?.('abort', forwardAbort, { once: true });
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      abortController.abort(new DOMException('The starter project download timed out.', 'TimeoutError'));
    }, timeoutMs)
    : null;

  try {
    const response = await fetchImpl(sourceUrl, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: abortController.signal,
      headers: { Accept: 'application/json, text/plain;q=0.9' },
    });
    if (!response?.ok) {
      throw starterSceneError(
        'starter_project_fetch_failed',
        `GitHub returned HTTP ${response?.status ?? 'unknown'} for the starter project.`,
        { sourceUrl, status: response?.status ?? null },
      );
    }

    const text = await readResponseTextWithinLimit(response, {
      maxBytes,
      signal: abortController.signal,
    });
    return Object.freeze({
      sourceUrl,
      document: parseProjectPack(text, { maxBytes }),
    });
  } catch (cause) {
    if (cause instanceof StudioError) throw cause;
    const aborted = abortController.signal.aborted;
    throw starterSceneError(
      timedOut ? 'starter_project_fetch_timeout' : aborted ? 'starter_project_fetch_aborted' : 'starter_project_fetch_failed',
      timedOut
        ? 'The starter project download from GitHub timed out.'
        : aborted
          ? 'The starter project download was cancelled.'
          : 'Could not download the starter project from GitHub.',
      { sourceUrl, cause },
    );
  } finally {
    if (timeout !== null) clearTimeout(timeout);
    signal?.removeEventListener?.('abort', forwardAbort);
  }
}

/** Compile a selected remote starter and always fall back to the bundled document on failure. */
export async function showStarterProjectFromLocation({
  preview,
  fallbackDocument,
  onRemoteError = null,
  ...loadOptions
} = {}) {
  if (!preview || typeof preview.show !== 'function') {
    throw starterSceneError('starter_project_preview_invalid', 'A live project preview is required.');
  }

  try {
    const loaded = await loadStarterProjectSceneFromLocation(loadOptions);
    if (loaded) {
      await preview.show(loaded.document);
      return Object.freeze({ ...loaded, error: null });
    }
  } catch (error) {
    onRemoteError?.(error);
    await preview.show(fallbackDocument);
    return Object.freeze({ sourceUrl: null, document: fallbackDocument, error });
  }

  await preview.show(fallbackDocument);
  return Object.freeze({ sourceUrl: null, document: fallbackDocument, error: null });
}
