import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('strict disk-manifest schema matches the saved starter manifest envelope', async () => {
  const schema = JSON.parse(await readFile(new URL('schemas/project-manifest-v1.schema.json', root), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('templates/starter-project/project.threestudio.json', root), 'utf8'));

  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(manifest).sort(), [...schema.required].sort());
  assert.equal(schema.properties.kind.const, manifest.kind);
  assert.equal(schema.properties.protocolVersion.const, manifest.protocolVersion);
  assert.equal(schema.properties.formatVersion.const, manifest.formatVersion);

  const resourceTypes = ['geometries', 'materials', 'textures', 'graphs', 'animations', 'prefabs', 'audio', 'assets'];
  assert.deepEqual(schema.properties.resourceIndex.required, resourceTypes);
  assert.deepEqual(Object.keys(manifest.resourceIndex).sort(), [...resourceTypes].sort());
  assert.equal(schema.properties.resourceIndex.additionalProperties, false);
  assert.equal(schema.$defs.sceneIndexEntry.additionalProperties, false);
  assert.equal(schema.$defs.resourceIndexEntry.additionalProperties, false);
  assert.equal(schema.$defs.script.additionalProperties, false);

  for (const item of manifest.sceneIndex) {
    assert.match(item.id, new RegExp(schema.$defs.stableId.pattern));
    assert.match(item.hash, new RegExp(schema.$defs.hash.pattern));
    assert.match(item.path, new RegExp(schema.$defs.sceneIndexEntry.properties.path.allOf[1].pattern));
  }
  for (const item of Object.values(manifest.resourceIndex)) {
    assert.match(item.hash, new RegExp(schema.$defs.hash.pattern));
    assert.match(item.path, new RegExp(schema.$defs.resourceIndexEntry.properties.path.allOf[1].pattern));
    assert.ok(Number.isInteger(item.count) && item.count >= 0);
  }
});
