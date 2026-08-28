import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AtomicProjectStore,
  AuthoringKernel,
  StudioError,
  createProjectDocument,
  resolveInsideProject,
} from '../src/core/index.mjs';

async function temporaryProject(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'three-studio-core-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('named save writes split project files and reloads the exact document', async (t) => {
  const root = await temporaryProject(t);
  const store = new AtomicProjectStore(root);
  const project = createProjectDocument({
    projectId: 'project/persisted',
    name: 'Persisted Project',
    timestamp: '2026-08-28T00:00:00.000Z',
    resources: { geometries: [{ id: 'geometry/box', kind: 'box' }] },
  });
  const saved = await store.save(project);
  assert.equal(saved.document.savedRevision, 0);
  const manifest = JSON.parse(await readFile(path.join(root, 'project.threestudio.json'), 'utf8'));
  assert.equal(manifest.kind, 'ThreeStudioProjectManifest');
  assert.equal(manifest.sceneIndex.length, 1);
  const loaded = await store.load();
  assert.equal(loaded.recovered, false);
  assert.equal(loaded.dirty, false);
  assert.deepEqual(loaded.document, saved.document);
});

test('a newer recovery revision is restored dirty without replacing named save', async (t) => {
  const root = await temporaryProject(t);
  const store = new AtomicProjectStore(root);
  const project = createProjectDocument({ projectId: 'project/recovery' });
  await store.save(project);
  let sequence = 0;
  const kernel = new AuthoringKernel(project, {
    store,
    transactionIdFactory: () => `tx/recovery-${++sequence}`,
    clock: () => 0,
  });
  await kernel.apply({
    label: 'Add recovered scene',
    baseRevision: 0,
    idempotencyKey: 'idempotency-recovery-1',
    operations: [{ type: 'scene.create', scene: { id: 'scene/recovered' } }],
  });
  const loaded = await store.load();
  assert.equal(loaded.recovered, true);
  assert.equal(loaded.dirty, true);
  assert.equal(loaded.document.revision, 1);
  assert.equal(loaded.namedDocument.revision, 0);
  assert.equal(loaded.document.scenes['scene/recovered'].id, 'scene/recovered');
  assert.equal(loaded.journal.length, 1);
});

test('opening a kernel restores idempotency and history from disk', async (t) => {
  const root = await temporaryProject(t);
  const store = new AtomicProjectStore(root);
  const project = createProjectDocument({ projectId: 'project/reopen' });
  await store.save(project);
  const firstKernel = new AuthoringKernel(project, {
    store,
    transactionIdFactory: () => 'tx/original',
    clock: () => 0,
  });
  const applyRequest = {
    label: 'Add scene',
    baseRevision: 0,
    idempotencyKey: 'idempotency-reopen-1',
    operations: [{ type: 'scene.create', scene: { id: 'scene/second' } }],
  };
  const first = await firstKernel.apply(applyRequest);
  const { kernel: reopened } = await AuthoringKernel.open(root, {
    transactionIdFactory: () => 'tx/next',
    clock: () => 1,
  });
  const repeated = await reopened.apply(applyRequest);
  assert.deepEqual(repeated, first);
  assert.equal(reopened.status().undoAvailable, true);
});

test('project path resolver rejects traversal and absolute paths', async (t) => {
  const root = await temporaryProject(t);
  assert.throws(() => resolveInsideProject(root, '../escape.json'), (error) => error instanceof StudioError && error.code === 'project_path_escape');
  assert.throws(() => resolveInsideProject(root, path.resolve(root, 'absolute.json')), (error) => error.code === 'invalid_project_path');
  assert.equal(resolveInsideProject(root, 'scenes/main.scene.json'), path.join(root, 'scenes', 'main.scene.json'));
});

test('persistence failure never advances the in-memory revision', async () => {
  const project = createProjectDocument({ projectId: 'project/failing-store' });
  const kernel = new AuthoringKernel(project, {
    store: { writeRecovery: async () => { throw new Error('disk full'); } },
    transactionIdFactory: () => 'tx/failure',
    clock: () => 0,
  });
  await assert.rejects(kernel.apply({
    label: 'Cannot persist',
    baseRevision: 0,
    idempotencyKey: 'idempotency-disk-full',
    operations: [{ type: 'scene.create', scene: { id: 'scene/not-committed' } }],
  }), /disk full/);
  assert.equal(kernel.revision, 0);
  assert.equal(kernel.document.scenes['scene/not-committed'], undefined);
});

test('named save publishes immutable blobs before the manifest commit point', async (t) => {
  const root = await temporaryProject(t);
  const initialStore = new AtomicProjectStore(root);
  const initial = await initialStore.save(createProjectDocument({ projectId: 'project/atomic-save', name: 'Before' }));
  const manifestBefore = await readFile(path.join(root, 'project.threestudio.json'), 'utf8');
  const next = structuredClone(initial.document);
  next.name = 'After';
  const failingStore = new AtomicProjectStore(root, {
    faultInjector(point) {
      if (point === 'save.beforeManifestPublish') throw new Error('simulated crash before manifest');
    },
  });
  await assert.rejects(failingStore.save(next), /simulated crash/);
  assert.equal(await readFile(path.join(root, 'project.threestudio.json'), 'utf8'), manifestBefore);
  const reopened = await initialStore.load();
  assert.equal(reopened.document.name, 'Before');
  assert.equal(reopened.dirty, false);
});

test('post-manifest failure is a committed named save with a warning', async (t) => {
  const root = await temporaryProject(t);
  const initialStore = new AtomicProjectStore(root);
  const initial = await initialStore.save(createProjectDocument({ projectId: 'project/post-save', name: 'Before' }));
  const next = structuredClone(initial.document);
  next.name = 'After';
  const store = new AtomicProjectStore(root, {
    faultInjector(point) {
      if (point === 'save.afterManifestPublish') throw new Error('recovery mirror unavailable');
    },
  });
  const saved = await store.save(next);
  assert.equal(saved.warnings[0].code, 'post_save_recovery_deferred');
  const reopened = await initialStore.load();
  assert.equal(reopened.namedDocument.name, 'After');
});

test('successful named saves remove only superseded manifest blobs', async (t) => {
  const root = await temporaryProject(t);
  const store = new AtomicProjectStore(root);
  const first = await store.save(createProjectDocument({ projectId: 'project/blob-cleanup', name: 'Before' }));
  const oldScenePath = path.join(root, first.manifest.sceneIndex[0].path);
  const next = structuredClone(first.document);
  next.scenes[next.activeSceneId].name = 'Changed scene';
  const second = await store.save(next);
  assert.notEqual(second.manifest.sceneIndex[0].path, first.manifest.sceneIndex[0].path);
  await assert.rejects(readFile(oldScenePath), error => error.code === 'ENOENT');
  assert.equal(JSON.parse(await readFile(path.join(root, second.manifest.sceneIndex[0].path), 'utf8')).name, 'Changed scene');
});

test('failure before recovery publication leaves authoring state uncommitted', async (t) => {
  const root = await temporaryProject(t);
  const initialStore = new AtomicProjectStore(root);
  const project = createProjectDocument({ projectId: 'project/recovery-before' });
  await initialStore.save(project);
  const store = new AtomicProjectStore(root, {
    faultInjector(point) {
      if (point === 'apply.beforeRecoveryPublish') throw new Error('recovery unavailable');
    },
  });
  const kernel = new AuthoringKernel(project, { store, transactionIdFactory: () => 'tx/before', clock: () => 0 });
  await assert.rejects(kernel.apply({
    label: 'Must not commit',
    baseRevision: 0,
    idempotencyKey: 'recovery-before-1',
    operations: [{ type: 'scene.create', scene: { id: 'scene/rejected' } }],
  }), /recovery unavailable/);
  assert.equal(kernel.revision, 0);
  const reopened = await initialStore.load();
  assert.equal(reopened.document.revision, 0);
  assert.equal(reopened.journal.length, 0);
});

test('recovery publication commits even when journal repair is deferred', async (t) => {
  const root = await temporaryProject(t);
  const initialStore = new AtomicProjectStore(root);
  const project = createProjectDocument({ projectId: 'project/deferred-journal' });
  await initialStore.save(project);
  const store = new AtomicProjectStore(root, {
    faultInjector(point) {
      if (point === 'apply.afterRecoveryPublish.beforeJournalAppend') throw new Error('journal unavailable');
    },
  });
  const request = {
    label: 'Durable recovery commit',
    baseRevision: 0,
    idempotencyKey: 'deferred-journal-1',
    operations: [{ type: 'scene.create', scene: { id: 'scene/durable' } }],
  };
  const kernel = new AuthoringKernel(project, { store, transactionIdFactory: () => 'tx/deferred', clock: () => 0 });
  const response = await kernel.apply(request);
  assert.equal(response.revision, 1);
  assert.equal(response.warnings[0].code, 'journal_deferred');
  assert.equal((await store.readJournal()).length, 0);
  const { kernel: reopened, journal } = await AuthoringKernel.open(root);
  assert.equal(reopened.revision, 1);
  assert.equal(journal.filter((entry) => entry.transactionId === 'tx/deferred').length, 1);
  const repeated = await reopened.apply(request);
  assert.equal(repeated.transactionId, 'tx/deferred');
});

test('a deferred journal entry must flush before the next recovery commit', async (t) => {
  const root = await temporaryProject(t);
  const initialStore = new AtomicProjectStore(root);
  const project = createProjectDocument({ projectId: 'project/deferred-preflight' });
  await initialStore.save(project);
  let firstCommit = true;
  let blockJournal = true;
  let sequence = 0;
  const store = new AtomicProjectStore(root, {
    faultInjector(point) {
      if (point === 'apply.afterRecoveryPublish.beforeJournalAppend' && firstCommit) {
        firstCommit = false;
        throw new Error('defer first journal append');
      }
      if (point === 'journal.beforePublish' && blockJournal) throw new Error('journal still unavailable');
    },
  });
  const kernel = new AuthoringKernel(project, {
    store,
    transactionIdFactory: () => `tx/preflight-${++sequence}`,
    clock: () => sequence,
  });
  await kernel.apply({
    label: 'First commit',
    baseRevision: 0,
    idempotencyKey: 'deferred-preflight-1',
    operations: [{ type: 'scene.create', scene: { id: 'scene/first' } }],
  });
  const second = {
    label: 'Second commit',
    baseRevision: 1,
    idempotencyKey: 'deferred-preflight-2',
    operations: [{ type: 'scene.create', scene: { id: 'scene/second' } }],
  };
  await assert.rejects(kernel.apply(second), /journal still unavailable/);
  assert.equal(kernel.revision, 1);
  const recoveryAtOne = await initialStore.load();
  assert.equal(recoveryAtOne.document.revision, 1);
  blockJournal = false;
  const committed = await kernel.apply(second);
  assert.equal(committed.revision, 2);
  const journal = await store.readJournal();
  assert.deepEqual(journal.map((entry) => entry.revision), [1, 2]);
});
