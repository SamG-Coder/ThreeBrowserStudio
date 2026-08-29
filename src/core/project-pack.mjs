import { PROTOCOL_VERSION } from './constants.mjs';
import { createProjectDocument, normalizeProjectDocument } from './documents.mjs';
import { StudioError } from './errors.mjs';
import { normalizeStableId } from './ids.mjs';
import { isPlainRecord, nowIso } from './util.mjs';

export const PROJECT_PACK_KIND = 'ThreeStudioProjectPack';
export const PROJECT_PACK_FORMAT_VERSION = 1;
export const MAX_PROJECT_PACK_BYTES = 32 * 1024 * 1024;

function forceAgentSafeDocument(document) {
  const scripts = {};
  for (const [id, script] of Object.entries(document?.scripts ?? {})) {
    scripts[id] = {
      ...script,
      trustLevel: script?.trustLevel === 'trusted-project' ? 'agent-safe' : script?.trustLevel,
    };
  }
  return {
    ...document,
    scriptTrustPolicy: 'agent-safe',
    scripts,
  };
}

function importedDocument(document) {
  return normalizeProjectDocument(forceAgentSafeDocument(document));
}

export function projectPackSlug(name) {
  const slug = normalizeStableId(name).replace(/-+$/g, '').slice(0, 48).replace(/-+$/g, '');
  return slug || 'project';
}

export function projectPackFileName(document) {
  return `three-studio-${projectPackSlug(document?.name)}.json`;
}

export function projectImportFolderName(name, { clock } = {}) {
  const stamp = nowIso(clock).slice(0, 19).replace(/[-:T]/g, '');
  return `${projectPackSlug(name)}-${stamp}`;
}

export function createBrowserPreviewDocument() {
  return createProjectDocument({
    name: 'Browser preview',
    projectId: 'project/browser-preview',
  });
}

export function createProjectPack(document, { clock } = {}) {
  const normalized = importedDocument(document);
  return {
    kind: PROJECT_PACK_KIND,
    protocolVersion: PROTOCOL_VERSION,
    formatVersion: PROJECT_PACK_FORMAT_VERSION,
    exportedAt: nowIso(clock),
    document: normalized,
  };
}

function extractImportedDocument(parsed) {
  if (!isPlainRecord(parsed)) {
    throw new StudioError('pack_invalid', 'Project pack must be a JSON object.');
  }
  if (parsed.kind === PROJECT_PACK_KIND) {
    if (parsed.protocolVersion !== PROTOCOL_VERSION) {
      throw new StudioError('protocol_mismatch', `Expected ${PROTOCOL_VERSION}.`);
    }
    if (parsed.formatVersion !== PROJECT_PACK_FORMAT_VERSION) {
      throw new StudioError('pack_format_unsupported', `Expected pack format ${PROJECT_PACK_FORMAT_VERSION}.`);
    }
    if (!isPlainRecord(parsed.document)) {
      throw new StudioError('pack_missing_document', 'Project pack is missing its document.');
    }
    return importedDocument(parsed.document);
  }
  if (parsed.kind === 'ThreeStudioProject') return importedDocument(parsed);
  throw new StudioError('pack_invalid_kind', 'Expected a ThreeStudioProject or ThreeStudioProjectPack.');
}

export function parseProjectPack(input, { maxBytes = MAX_PROJECT_PACK_BYTES } = {}) {
  if (typeof input === 'string') {
    const bytes = new TextEncoder().encode(input).byteLength;
    if (bytes > maxBytes) {
      throw new StudioError('pack_too_large', `Project pack exceeds ${maxBytes} bytes.`, {
        byteCount: bytes,
        maximum: maxBytes,
      });
    }
    let parsed;
    try {
      parsed = JSON.parse(input);
    } catch (error) {
      throw new StudioError('pack_invalid_json', 'Project pack is not valid JSON.', { cause: error });
    }
    return extractImportedDocument(parsed);
  }
  return extractImportedDocument(input);
}
