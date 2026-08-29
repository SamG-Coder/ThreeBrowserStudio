import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { sha256HexUtf8 } from '../src/core/sha256.mjs';
import { contentHash } from '../src/core/util.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('hash and image-texture helpers no longer import Node builtins', async () => {
  for (const relative of ['src/core/util.mjs', 'src/core/image-texture.mjs', 'src/core/project-pack.mjs']) {
    const source = await readFile(path.join(root, relative), 'utf8');
    assert.doesNotMatch(source, /from ['"]node:/);
  }
});

test('portable SHA-256 matches Node crypto for UTF-8 strings', () => {
  for (const text of ['', 'abc', 'ThreeBrowser Studio', 'café \u{1F3AF}', '{"kind":"ThreeStudioProject"}']) {
    assert.equal(sha256HexUtf8(text), createHash('sha256').update(text).digest('hex'));
  }
});

test('contentHash still uses SHA-256 of the canonical JSON', () => {
  const value = { b: 2, a: [1, 3] };
  assert.equal(contentHash(value), createHash('sha256').update('{"a":[1,3],"b":2}').digest('hex'));
});
