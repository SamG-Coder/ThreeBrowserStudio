import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('Windows folder launcher is portable, guarded, and failure-visible', async () => {
  const source = await readFile(path.join(root, 'Launch ThreeBrowser Studio.cmd'), 'utf8');
  const attributes = await readFile(path.join(root, '.gitattributes'), 'utf8');

  assert.match(source, /pushd "%~dp0"/i);
  assert.match(source, /process\.versions\.node/);
  assert.match(source, />= 24/);
  assert.match(source, /call npm ci/i);
  assert.match(source, /node "scripts\\launch\.mjs" %\*/i);
  assert.match(source, /if not "%EXIT_CODE%"=="0"/i);
  assert.match(source, /pause/i);
  assert.doesNotMatch(source, /[A-Z]:\\/);
  assert.match(attributes, /^\*\.cmd text eol=crlf$/m);
});

test('package exposes a short terminal start alias', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.start, 'node scripts/launch.mjs');
  assert.equal(packageJson.scripts.launch, 'node scripts/launch.mjs');
});
