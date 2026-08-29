import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IMPORT_PATTERN = /(?:from|import)\s+['"](\.\.?\/[^'"]+\.mjs)(?:\?[^'"]*)?['"]/g;

async function staticLocalImports(entry, seen = new Set()) {
  const file = path.normalize(path.join(root, entry));
  if (seen.has(file)) return seen;
  seen.add(file);
  const source = await readFile(file, 'utf8');
  assert.doesNotMatch(source, /from ['"]node:/, `${entry} must not import Node builtins`);
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const next = path.relative(root, path.resolve(path.dirname(file), match[1])).replaceAll('\\', '/');
    await staticLocalImports(next, seen);
  }
  return seen;
}

test('project transfer modules stay off the Node builtin graph', async () => {
  const seen = await staticLocalImports('src/core/project-pack.mjs');
  await staticLocalImports('src/viewport/project-file-transfer.mjs', seen);
  await staticLocalImports('src/viewport/live-project-preview.mjs', seen);
  assert.ok(seen.size > 8);
});
