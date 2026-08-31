import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { contentHash } from '../src/core/index.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function loadExchangeFactory() {
  try {
    return (await import('../src/runtime/project-artifact-exchange.mjs')).createProjectArtifactExchange;
  } catch {
    return undefined;
  }
}

test('JSON artifact import and guarded export preserve formatting outside the authored value', async (t) => {
  const createProjectArtifactExchange = await loadExchangeFactory();
  assert.equal(typeof createProjectArtifactExchange, 'function');
  const root = await mkdtemp(path.join(tmpdir(), 'three-studio-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'examples'));
  const reference = 'examples/hero-chamber.labyrinth.json';
  const filePath = path.join(root, ...reference.split('/'));
  const original = '{\n  "schemaVersion": "0.1.0",\n  "poses": [\n    {\n      "id": "split-link",\n      "position": [6, 0, 0]\n    }\n  ],\n  "validation": {\n    "maxModules": 32\n  }\n}\n';
  await writeFile(filePath, original);

  const exchange = createProjectArtifactExchange({ repositoryRoot: root });
  const imported = await exchange.importArtifact({
    reference,
    artifactId: 'artifact/hero-chamber',
    name: 'Hero Chamber',
    schemaId: 'project-labyrinth/labyrinth-spec@0.1.0',
    expectedFileSha256: sha256(original),
  });
  assert.equal(imported.fileSha256, sha256(original));
  assert.equal(imported.artifact.document.poses[0].position[0], 6);
  assert.equal(imported.artifact.metadata.importedFrom, reference);

  const roundTrip = await exchange.exportArtifact({
    reference,
    artifact: imported.artifact,
    expectedArtifactHash: contentHash(imported.artifact),
    expectedFileSha256: sha256(original),
  });
  assert.equal(await readFile(filePath, 'utf8'), original);
  assert.equal(roundTrip.changed, false);

  const edited = structuredClone(imported.artifact);
  edited.document.poses[0].position[0] = 7;
  const exported = await exchange.exportArtifact({
    reference,
    artifact: edited,
    expectedArtifactHash: contentHash(edited),
    expectedFileSha256: roundTrip.fileSha256,
  });
  const expected = original.replace('[6, 0, 0]', '[7, 0, 0]');
  assert.equal(await readFile(filePath, 'utf8'), expected);
  assert.equal(exported.fileSha256, sha256(expected));
  assert.equal(exported.changed, true);
});

test('JSON artifact exchange rejects traversal, stale destination bytes, and junction escapes', async (t) => {
  const createProjectArtifactExchange = await loadExchangeFactory();
  assert.equal(typeof createProjectArtifactExchange, 'function');
  const root = await mkdtemp(path.join(tmpdir(), 'three-studio-artifact-root-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'three-studio-artifact-outside-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  await writeFile(path.join(root, 'artifact.json'), '{"safe":true}\n');
  await writeFile(path.join(outside, 'escaped.json'), '{"escaped":true}\n');
  await symlink(outside, path.join(root, 'linked'), 'junction');
  const exchange = createProjectArtifactExchange({ repositoryRoot: root });

  await assert.rejects(() => exchange.importArtifact({
    reference: '../artifact.json', artifactId: 'artifact/test', schemaId: 'test/schema@1',
    expectedFileSha256: sha256('{"safe":true}\n'),
  }), error => error.code === 'artifact_path_invalid');
  await assert.rejects(() => exchange.importArtifact({
    reference: 'linked/escaped.json', artifactId: 'artifact/test', schemaId: 'test/schema@1',
    expectedFileSha256: sha256('{"escaped":true}\n'),
  }), error => error.code === 'artifact_path_reparse');

  const artifact = {
    id: 'artifact/test', kind: 'jsonArtifact', name: 'test', mediaType: 'application/json',
    schemaId: 'test/schema@1', document: { safe: false }, metadata: {},
  };
  await assert.rejects(() => exchange.exportArtifact({
    reference: 'artifact.json', artifact, expectedArtifactHash: contentHash(artifact),
    expectedFileSha256: '0'.repeat(64),
  }), error => error.code === 'artifact_file_hash_mismatch');
  assert.equal(await readFile(path.join(root, 'artifact.json'), 'utf8'), '{"safe":true}\n');
});
