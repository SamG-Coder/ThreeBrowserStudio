import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectWorkspaceActions } from '../src/viewport/project-workspace-actions.mjs';

function nativeFixture() {
  const calls = [];
  const application = {
    status() {
      return {
        sessionId: 'session/live',
        projectId: 'project/live',
        projectName: 'Live Project',
        activeSceneId: 'scene/main',
        revision: 7,
      };
    },
    async dispatch(tool, params) {
      calls.push({ tool, params });
      if (tool === 'three_studio_inspect') {
        return {
          success: true,
          revision: 7,
          scene: { id: 'scene/main', name: 'Main Scene', sceneHash: 'sha256:verified-scene' },
        };
      }
      return { success: true };
    },
  };
  return { application, calls };
}

test('native workspace toolbar uses project actions for new and save', async () => {
  const { application, calls } = nativeFixture();
  const actions = createProjectWorkspaceActions({ application, native: true, clock: () => 1234 });
  assert.equal(await actions.run('new-starter'), 'Started Starter Project.');
  assert.equal(await actions.run('save'), 'Saved Live Project.');
  assert.equal(calls[0].tool, 'three_studio_project');
  assert.equal(calls[0].params.action, 'create');
  assert.equal(calls[0].params.template, 'starter');
  assert.equal(calls[0].params.path, 'starter-ya');
  assert.equal(calls[1].tool, 'three_studio_project');
  assert.equal(calls[1].params.action, 'save');
  assert.equal(calls[1].params.projectId, 'project/live');
  assert.equal(calls[1].params.baseRevision, 7);
});

test('clear scene reads the digest then applies one hash-guarded MCP mutation', async () => {
  const { application, calls } = nativeFixture();
  const actions = createProjectWorkspaceActions({ application, native: true });
  assert.equal(await actions.run('clear-scene'), 'Cleared Main Scene.');
  assert.equal(calls[0].tool, 'three_studio_inspect');
  assert.equal(calls[0].params.query, 'sceneDigest');
  assert.equal(calls[1].tool, 'three_studio_apply');
  assert.equal(calls[1].params.baseRevision, 7);
  assert.deepEqual(calls[1].params.operations, [{
    op: 'scene.clear',
    sceneId: 'scene/main',
    expectedSceneHash: 'sha256:verified-scene',
  }]);
});

test('browser workspace creates canonical blank and starter documents and downloads on save', async () => {
  const imported = [];
  const application = {
    status() { return { projectId: 'project/browser', activeSceneId: 'scene/main', revision: 0 }; },
    async importProjectDocument(document) { imported.push(document); },
  };
  let exports = 0;
  const actions = createProjectWorkspaceActions({
    application,
    native: false,
    clock: () => 1234,
    exportProject() { exports += 1; return 'Downloaded project pack.'; },
  });
  assert.equal(await actions.run('new-blank'), 'Started Untitled Project.');
  assert.equal(imported[0].projectId, 'project/untitled-ya');
  assert.equal(Object.keys(imported[0].scenes['scene/main'].entities).length, 0);
  assert.equal(await actions.run('new-starter'), 'Started Starter Project.');
  assert.equal(imported[1].projectId, 'project/starter-ya');
  assert.ok(Object.keys(imported[1].scenes[imported[1].activeSceneId].entities).length > 0);
  assert.equal(await actions.run('save'), 'Downloaded project pack.');
  assert.equal(await actions.run('save-as'), 'Downloaded project pack.');
  assert.equal(exports, 2);
});
