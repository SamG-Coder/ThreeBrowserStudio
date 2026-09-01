import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument } from '../src/core/documents.mjs';
import { createBrowserStudioSession } from '../src/browser/browser-studio-session.mjs';

function compiled(revision) {
  return {
    revision,
    objects: new Map(),
    animationRuntime: { actions: new Map(), pause() {} },
    timelineGeometryModifierIds: [],
    timelineGeometrySampleCount: 0,
    animationStates() { return []; },
    setAnimationTime(value) { this.time = value; },
    advanceAnimation(delta) { this.time = (this.time ?? 0) + delta; },
  };
}

function fakePreview(initial) {
  let document = initial;
  let live = compiled(initial.revision);
  const swaps = [];
  return {
    get document() { return document; },
    get compiled() { return live; },
    async show(next) { document = next; live = compiled(next.revision); swaps.push(next.revision); },
    async prepare(next) {
      const candidate = compiled(next.revision);
      let consumed = false;
      return {
        async show() {
          assert.equal(consumed, false);
          consumed = true;
          document = next;
          live = candidate;
          swaps.push(next.revision);
        },
        dispose() { consumed = true; },
      };
    },
    swaps,
  };
}

test('browser session dispatches the nine-tool authoring core and swaps after commit', async () => {
  const project = createProjectDocument({
    projectId: 'project/browser-session',
    scenes: [{ id: 'scene/main', entities: [{ id: 'entity/player', kind: 'gameObject', name: 'Player' }] }],
  });
  const preview = fakePreview(project);
  const viewport = { setControllerState() {}, setExplorerOutline() {} };
  const session = await createBrowserStudioSession({ project, preview, viewport });
  const status = await session.dispatch('three_studio_status');
  assert.equal(status.capabilities.browserKernel, true);

  const applied = await session.dispatch('three_studio_apply', {
    baseRevision: 0,
    label: 'Attach browser collider',
    idempotencyKey: 'browser-component-0001',
    operations: [{
      op: 'entity.component.attach', entityId: 'entity/player', component: 'collider',
      value: { enabled: true, shape: 'box', size: [1, 1, 1] },
    }],
  });
  assert.equal(applied.revision, 1);
  assert.deepEqual(preview.swaps, [0, 1]);
  assert.equal(session.document.scenes['scene/main'].entities['entity/player'].components.collider.shape, 'box');

  const validation = await session.dispatch('three_studio_validate');
  assert.equal(validation.valid, true);
  const history = await session.dispatch('three_studio_history', { action: 'list' });
  assert.equal(history.entries.length, 1);
  session.dispose();
});

test('browser Play has explicit controls and Escape restores Author mode', async () => {
  const project = createProjectDocument({ projectId: 'project/browser-play' });
  const session = await createBrowserStudioSession({ project, preview: fakePreview(project), viewport: { setControllerState() {}, setExplorerOutline() {} } });
  session.enterPlay();
  assert.equal(session.mode, 'play');
  session.update(1 / 60);
  const result = session.controllerKeyDown('Escape');
  assert.equal(result.handled, true);
  assert.equal(session.mode, 'author');
  session.dispose();
});
