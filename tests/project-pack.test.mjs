import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectDocument } from '../src/core/documents.mjs';
import {
  MAX_PROJECT_PACK_BYTES,
  PROJECT_PACK_KIND,
  createBrowserPreviewDocument,
  createProjectPack,
  parseProjectPack,
  projectImportFolderName,
  projectPackFileName,
} from '../src/core/project-pack.mjs';

test('project pack wraps a canonical document and forces agent-safe trust', () => {
  const source = createProjectDocument({
    projectId: 'project/packed',
    name: 'Packed Scene',
    scriptTrustPolicy: 'trusted-project',
    scripts: [{
      id: 'script/setup',
      trustLevel: 'trusted-project',
    }],
  });
  const pack = createProjectPack(source, { clock: () => Date.UTC(2026, 7, 30, 0, 0, 0) });
  assert.equal(pack.kind, PROJECT_PACK_KIND);
  assert.equal(pack.exportedAt, '2026-08-30T00:00:00.000Z');
  assert.equal(pack.document.kind, 'ThreeStudioProject');
  assert.equal(pack.document.scriptTrustPolicy, 'agent-safe');
  assert.equal(pack.document.scripts['script/setup'].trustLevel, 'agent-safe');
  assert.equal(projectPackFileName(pack.document), 'three-studio-packed-scene.json');
  assert.equal(projectImportFolderName(pack.document.name, { clock: () => Date.UTC(2026, 7, 30, 8, 46, 0) }), 'packed-scene-20260830084600');
});

test('parse accepts a pack, a raw project, and rejects invalid payloads', () => {
  const document = createProjectDocument({ projectId: 'project/raw', name: 'Raw' });
  const fromPack = parseProjectPack(createProjectPack(document));
  assert.equal(fromPack.name, 'Raw');
  assert.equal(fromPack.scriptTrustPolicy, 'agent-safe');

  const fromRaw = parseProjectPack(JSON.stringify(document));
  assert.equal(fromRaw.projectId, 'project/raw');

  assert.throws(() => parseProjectPack('{'), error => error.code === 'pack_invalid_json');
  assert.throws(() => parseProjectPack({ kind: 'NotAPack' }), error => error.code === 'pack_invalid_kind');
  assert.throws(
    () => parseProjectPack({ kind: PROJECT_PACK_KIND, protocolVersion: 'nope', formatVersion: 1, document }),
    error => error.code === 'protocol_mismatch',
  );
  assert.throws(
    () => parseProjectPack({ kind: PROJECT_PACK_KIND, protocolVersion: document.protocolVersion, formatVersion: 99, document }),
    error => error.code === 'pack_format_unsupported',
  );
  assert.throws(
    () => parseProjectPack('x'.repeat(MAX_PROJECT_PACK_BYTES + 1)),
    error => error.code === 'pack_too_large',
  );
});

test('browser preview document is a valid starter project', () => {
  const document = createBrowserPreviewDocument();
  assert.equal(document.projectId, 'project/browser-preview');
  assert.equal(document.scriptTrustPolicy, 'agent-safe');
  const pack = createProjectPack(document);
  assert.equal(parseProjectPack(JSON.stringify(pack)).name, 'Browser preview');
});
