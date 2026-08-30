import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserPreviewDocument, createProjectPack } from '../src/core/project-pack.mjs';
import {
  loadStarterProjectSceneFromLocation,
  resolveStarterProjectSceneUrl,
  showStarterProjectFromLocation,
  starterProjectSceneUrlFromLocation,
} from '../src/browser/starter-project-scene.mjs';

const BLOB_URL = 'https://github.com/SamG-Coder/ThreeBrowserStudio/blob/main/templates/starter-project/scenes/three-studio-crimson-orchard-apple.json';
const RAW_URL = 'https://raw.githubusercontent.com/SamG-Coder/ThreeBrowserStudio/main/templates/starter-project/scenes/three-studio-crimson-orchard-apple.json';

test('starter-project-scene converts GitHub blob links to anonymous raw content', () => {
  assert.equal(resolveStarterProjectSceneUrl(BLOB_URL), RAW_URL);
  assert.equal(resolveStarterProjectSceneUrl(RAW_URL), RAW_URL);
  const refsRawUrl = RAW_URL.replace('/main/', '/refs/heads/main/');
  assert.equal(resolveStarterProjectSceneUrl(refsRawUrl), refsRawUrl);
});

test('starter-project-scene reads an encoded page query parameter', () => {
  assert.equal(starterProjectSceneUrlFromLocation({
    search: `?starter-project-scene=${encodeURIComponent(BLOB_URL)}`,
  }), RAW_URL);
  assert.equal(starterProjectSceneUrlFromLocation({ search: '' }), null);
});

test('starter-project-scene rejects insecure, unrelated, and malformed sources', () => {
  assert.throws(() => resolveStarterProjectSceneUrl('http://github.com/example/repo/blob/main/project.json'), error => (
    error.code === 'starter_project_url_insecure'
  ));
  assert.throws(() => resolveStarterProjectSceneUrl('https://example.com/project.json'), error => (
    error.code === 'starter_project_url_host'
  ));
  assert.throws(() => resolveStarterProjectSceneUrl('https://github.com/example/repo/blob/main/project.json'), error => (
    error.code === 'starter_project_url_path'
  ));
  assert.throws(() => resolveStarterProjectSceneUrl(`${BLOB_URL}?raw=1`), error => (
    error.code === 'starter_project_url_invalid'
  ));
  assert.throws(() => resolveStarterProjectSceneUrl(BLOB_URL.replace('.json', '.txt')), error => (
    error.code === 'starter_project_url_path'
  ));
});

test('starter-project-scene fetches and validates a canonical project pack', async () => {
  const pack = createProjectPack(createBrowserPreviewDocument());
  const requests = [];
  const loaded = await loadStarterProjectSceneFromLocation({
    location: { search: `?starter-project-scene=${encodeURIComponent(BLOB_URL)}` },
    async fetch(url, options) {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async text() { return JSON.stringify(pack); },
      };
    },
  });
  assert.equal(loaded.sourceUrl, RAW_URL);
  assert.equal(loaded.document.name, 'Starter Project');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, RAW_URL);
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.mode, 'cors');
  assert.equal(requests[0].options.referrerPolicy, 'no-referrer');
  assert.equal(requests[0].options.signal instanceof AbortSignal, true);
});

test('starter-project-scene surfaces HTTP and size failures', async () => {
  await assert.rejects(loadStarterProjectSceneFromLocation({
    location: { search: `?starter-project-scene=${encodeURIComponent(BLOB_URL)}` },
    fetch: async () => ({ ok: false, status: 404, headers: { get: () => null } }),
  }), error => error.code === 'starter_project_fetch_failed');

  await assert.rejects(loadStarterProjectSceneFromLocation({
    location: { search: `?starter-project-scene=${encodeURIComponent(BLOB_URL)}` },
    maxBytes: 8,
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: name => name === 'content-length' ? '9' : null },
      text: async () => '{}',
    }),
  }), error => error.code === 'pack_too_large');
});

test('starter-project-scene stops a chunked download at the byte limit', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('12345'));
      controller.enqueue(new TextEncoder().encode('67890'));
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(loadStarterProjectSceneFromLocation({
    location: { search: `?starter-project-scene=${encodeURIComponent(BLOB_URL)}` },
    maxBytes: 8,
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body,
    }),
  }), error => error.code === 'pack_too_large');
  assert.equal(cancelled, true);
});

test('starter-project-scene times out a stalled GitHub request', async () => {
  await assert.rejects(loadStarterProjectSceneFromLocation({
    location: { search: `?starter-project-scene=${encodeURIComponent(BLOB_URL)}` },
    timeoutMs: 5,
    fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  }), error => error.code === 'starter_project_fetch_timeout');
});

test('remote preview compilation failure falls back to the bundled starter', async () => {
  const remoteDocument = createBrowserPreviewDocument();
  remoteDocument.name = 'Remote starter';
  const fallbackDocument = createBrowserPreviewDocument();
  const shown = [];
  const errors = [];
  const result = await showStarterProjectFromLocation({
    preview: {
      async show(document) {
        shown.push(document.name);
        if (document.name === 'Remote starter') throw new Error('GPU compile failed');
      },
    },
    fallbackDocument,
    location: { search: `?starter-project-scene=${encodeURIComponent(BLOB_URL)}` },
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(createProjectPack(remoteDocument)),
    }),
    onRemoteError: error => errors.push(error.message),
  });
  assert.deepEqual(shown, ['Remote starter', 'Starter Project']);
  assert.deepEqual(errors, ['GPU compile failed']);
  assert.equal(result.document, fallbackDocument);
  assert.equal(result.error.message, 'GPU compile failed');
});
