import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PAGES_ASSET_STAMP, bustRelativeModuleImports, preparePages } from '../scripts/prepare-pages.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('pages artifact keeps the browser shell and does not replace site-entry', async () => {
  const output = path.join(await mkdtemp(path.join(os.tmpdir(), 'three-studio-pages-')), 'dist-pages');
  await preparePages({ outputDirectory: output });
  const html = await readFile(path.join(output, 'index.html'), 'utf8');
  assert.match(html, /three@0\.184\.0/);
  assert.match(html, /pages\/browser-entry\.mjs/);
  const entry = await readFile(path.join(output, 'pages', 'browser-entry.mjs'), 'utf8');
  assert.match(entry, /__THREE_STUDIO_BROWSER_PREVIEW__/);
  assert.match(entry, /src\/viewport\/main\.mjs/);
  assert.doesNotMatch(entry, /BROWSER_PREVIEW_FLAG/);
  assert.match(await readFile(path.join(root, 'site-entry.mjs'), 'utf8'), /src\/viewport\/main\.mjs/);
  const main = await readFile(path.join(output, 'src', 'viewport', 'main.mjs'), 'utf8');
  assert.match(main, /detectStudioHost/);
  assert.match(main, new RegExp(`mcp-live-feed-webgpu-hud\\.mjs\\?v=${PAGES_ASSET_STAMP}`));
  assert.match(html, new RegExp(`browser-entry\\.mjs\\?v=${PAGES_ASSET_STAMP}`));
  assert.doesNotMatch(main, /^import .*studio-application/m);
  assert.doesNotMatch(main, /^import .*system-typeface/m);
  assert.match(
    bustRelativeModuleImports("import { x } from './foo.mjs';", 'n'),
    /foo\.mjs\?v=n/,
  );
});
