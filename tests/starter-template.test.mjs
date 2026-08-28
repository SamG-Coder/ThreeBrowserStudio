import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AtomicProjectStore, validateProjectDocument } from '../src/core/index.mjs';
import { normalizeGeometryRecipe } from '../src/runtime/resource-factories.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(repositoryRoot, 'templates', 'starter-project');

async function loadFixtureCopy(t) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'three-studio-starter-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  await cp(fixtureRoot, temporaryRoot, { recursive: true });
  return new AtomicProjectStore(temporaryRoot).load();
}

test('starter project is a canonical loadable project with globally unique stable IDs', async (t) => {
  const { document, recovered, dirty } = await loadFixtureCopy(t);
  const validation = validateProjectDocument(document);

  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics, null, 2));
  assert.equal(recovered, false);
  assert.equal(dirty, false);
  assert.equal(document.activeSceneId, 'scene/starter-stage');
  assert.equal(document.scenes['scene/starter-stage'].settings.activeCameraId, 'entity/starter-stage/camera');
  assert.equal(validation.budgets.entities, 11);

  const allIds = [
    document.projectId,
    ...Object.keys(document.scenes),
    ...Object.values(document.scenes).flatMap((scene) => Object.keys(scene.entities)),
    ...Object.values(document.resources).flatMap((table) => Object.keys(table)),
  ];
  assert.equal(new Set(allIds).size, allIds.length);
});

test('starter project stays asset-free and uses supported procedural resource recipes', async (t) => {
  const { document } = await loadFixtureCopy(t);
  assert.deepEqual(document.scripts, {});
  assert.deepEqual(document.resources.assets, {});
  assert.deepEqual(document.resources.textures, {});
  assert.equal(Object.keys(document.resources.geometries).length, 5);
  assert.equal(Object.keys(document.resources.materials).length, 5);

  const supportedKinds = new Set(['box', 'plane', 'sphere', 'cylinder', 'torusKnot']);
  for (const resource of Object.values(document.resources.geometries)) {
    assert.equal(supportedKinds.has(normalizeGeometryRecipe(resource).kind), true, resource.id);
  }

  const scene = document.scenes[document.activeSceneId];
  const shadowCasters = Object.values(scene.entities)
    .filter((entity) => entity.components.mesh?.castShadow === true);
  const shadowReceivers = Object.values(scene.entities)
    .filter((entity) => entity.components.mesh?.receiveShadow === true);
  const shadowLights = Object.values(scene.entities)
    .filter((entity) => entity.components.light?.castShadow === true);
  assert.equal(shadowCasters.length >= 4, true);
  assert.equal(shadowReceivers.length >= 5, true);
  assert.equal(shadowLights.length, 1);
});
