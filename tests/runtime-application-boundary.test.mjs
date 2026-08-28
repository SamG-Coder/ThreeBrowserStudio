import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LiveBridgeClient, RpcError } from '../src/bridge/index.mjs';
import { AtomicProjectStore, createProjectDocument } from '../src/core/index.mjs';
import { StudioApplication } from '../src/runtime/studio-application.mjs';

class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.set(x, y, z);
  }

  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  fromArray([x, y, z]) {
    return this.set(x, y, z);
  }

  toArray() {
    return [this.x, this.y, this.z];
  }
}

class Euler extends Vector3 {}

class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }

  fromArray([x, y, z, w]) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }

  toArray() {
    return [this.x, this.y, this.z, this.w];
  }
}

class Group {
  constructor() {
    this.children = [];
    this.parent = null;
    this.position = new Vector3();
    this.rotation = new Euler();
    this.quaternion = new Quaternion();
    this.scale = new Vector3(1, 1, 1);
    this.userData = {};
    this.clearCount = 0;
  }

  add(child) {
    child.removeFromParent?.();
    child.parent = this;
    this.children.push(child);
    return this;
  }

  removeFromParent() {
    if (!this.parent) return this;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
    return this;
  }

  clear() {
    for (const child of this.children) child.parent = null;
    this.children.length = 0;
    this.clearCount += 1;
    return this;
  }

  updateMatrix() {}
}

class Color {
  setRGB(r, g, b) {
    this.value = [r, g, b];
    return this;
  }

  set(value) {
    this.value = value;
    return this;
  }
}

function fakeThree() {
  const groups = [];
  return {
    groups,
    Group: class extends Group {
      constructor() {
        super();
        groups.push(this);
      }
    },
    Color,
  };
}

function fakeTsl() {
  const nodes = [];
  return {
    nodes,
    color(value) {
      const node = {
        isNode: true,
        value,
        disposeCount: 0,
        dispose() { this.disposeCount += 1; },
      };
      nodes.push(node);
      return node;
    },
  };
}

function fakeViewport() {
  const scene = new Group();
  const camera = new Group();
  camera.isCamera = true;
  camera.updateMatrixWorld = () => {};
  const viewport = {
    scene,
    camera,
    renderCamera: camera,
    controls: {
      target: new Vector3(),
      syncFromCamera() {},
    },
    renderer: {
      domElement: { width: 1280, height: 720 },
      backend: { isWebGPUBackend: true },
      shadowMap: { enabled: true },
      userData: {},
    },
    titles: [],
    setRenderCamera(next) {
      this.renderCamera = next;
    },
    setTitle(title) {
      this.titles.push(structuredClone(title));
    },
  };
  return viewport;
}

async function saveProject(projectRoot, document) {
  await new AtomicProjectStore(projectRoot).save(document);
}

async function applicationFixture(t) {
  const studioRoot = await mkdtemp(path.join(os.tmpdir(), 'three-studio-app-boundary-'));
  const activeRoot = path.join(studioRoot, 'projects', 'active');
  await saveProject(activeRoot, createProjectDocument({
    projectId: 'project/active',
    name: 'Active',
  }));

  const previousStudioRoot = process.env.THREE_STUDIO_ROOT;
  process.env.THREE_STUDIO_ROOT = studioRoot;
  const THREE = fakeThree();
  const TSL = fakeTsl();
  const viewport = fakeViewport();
  const application = new StudioApplication({
    THREE,
    TSL,
    viewport,
    markerPath: path.join(studioRoot, 'session', 'live-session.json'),
  });
  if (previousStudioRoot === undefined) delete process.env.THREE_STUDIO_ROOT;
  else process.env.THREE_STUDIO_ROOT = previousStudioRoot;

  t.after(async () => {
    await application.dispose();
    await rm(studioRoot, { recursive: true, force: true });
  });
  await application.start({ projectPath: activeRoot });
  return { application, activeRoot, studioRoot, THREE, TSL, viewport };
}

function rejectsWithCode(code) {
  return error => {
    assert.equal(error?.code, code);
    return true;
  };
}

test('raw live-bridge dispatch rejects unknown and oversized fields before execution', async (t) => {
  const { application } = await applicationFixture(t);
  const client = await LiveBridgeClient.fromMarker(application.markerPath, { timeoutMs: 1_000 });
  t.after(() => client.close());
  await assert.rejects(
    client.request('three_studio_status', { unexpected: true }),
    error => {
      assert.ok(error instanceof RpcError);
      assert.equal(error?.code, 'invalid_request');
      return true;
    },
  );
  await assert.rejects(
    client.request('three_studio_status', { sessionId: 's'.repeat(129) }),
    error => {
      assert.ok(error instanceof RpcError);
      assert.equal(error?.code, 'invalid_request');
      return true;
    },
  );
});

test('project creation cannot escape the managed root or overwrite a populated directory', async (t) => {
  const { application, studioRoot } = await applicationFixture(t);
  const common = {
    action: 'create',
    sessionId: application.sessionId,
    label: 'Create a managed project',
  };

  await assert.rejects(
    application.dispatch('three_studio_project', {
      ...common,
      path: '../outside',
      idempotencyKey: 'create-escape-0001',
    }),
    rejectsWithCode('project_path_forbidden'),
  );
  await assert.rejects(
    application.dispatch('three_studio_project', {
      ...common,
      path: path.join(studioRoot, 'absolute-outside'),
      idempotencyKey: 'create-escape-0002',
    }),
    rejectsWithCode('project_path_forbidden'),
  );

  const occupiedRoot = path.join(studioRoot, 'projects', 'occupied');
  const sentinelPath = path.join(occupiedRoot, 'keep.txt');
  await mkdir(occupiedRoot, { recursive: true });
  await writeFile(sentinelPath, 'user-owned', 'utf8');
  await assert.rejects(
    application.dispatch('three_studio_project', {
      ...common,
      path: 'occupied',
      idempotencyKey: 'create-occupied-0001',
    }),
    rejectsWithCode('project_destination_not_empty'),
  );
  assert.equal(await readFile(sentinelPath, 'utf8'), 'user-owned');
});

test('project-scoped requests reject a mismatched stable project ID', async (t) => {
  const { application } = await applicationFixture(t);
  await assert.rejects(
    application.dispatch('three_studio_inspect', {
      sessionId: application.sessionId,
      projectId: 'project/not-active',
      query: 'sceneDigest',
    }),
    rejectsWithCode('project_mismatch'),
  );
});

test('live apply canonicalizes and validates an unused flat singular graph resource', async (t) => {
  const { application } = await applicationFixture(t);
  const graphId = 'graph/live-flat-water';
  const created = await application.dispatch('three_studio_apply', {
    protocolVersion: 'three-studio/1',
    sessionId: application.sessionId,
    projectId: 'project/active',
    baseRevision: 0,
    idempotencyKey: 'flat-graph-create-0001',
    label: 'Create an unused flat graph through the live MCP path',
    operations: [{
      op: 'resource.create',
      resourceType: 'graph',
      resource: {
        id: graphId,
        kind: 'graph',
        name: 'Live Flat Water',
        metadata: { regression: true },
        formatVersion: 1,
        domain: 'shader',
        nodes: [{ id: 'color', type: 'constant.color', params: { value: [0.08, 0.2, 0.3] } }],
        edges: [],
        outputs: { baseColor: { nodeId: 'color', port: 'value' } },
      },
    }],
  });
  assert.equal(created.success, true);
  assert.equal(created.revision, 1);
  const resource = application.kernel.document.resources.graphs[graphId];
  assert.equal(resource.name, 'Live Flat Water');
  assert.deepEqual(resource.metadata, { regression: true });
  assert.equal(resource.graph.id, graphId);
  assert.equal(Object.hasOwn(resource, 'nodes'), false);

  await assert.rejects(
    application.dispatch('three_studio_apply', {
      protocolVersion: 'three-studio/1',
      sessionId: application.sessionId,
      projectId: 'project/active',
      baseRevision: 1,
      idempotencyKey: 'flat-graph-patch-0001',
      label: 'Reject an invalid unused graph patch immediately',
      operations: [{
        op: 'resource.patch',
        resourceType: 'graph',
        resourceId: graphId,
        patch: {
          nodes: [{ id: 'unsafe', type: 'rawWgsl', params: {} }],
          outputs: { baseColor: { nodeId: 'unsafe', port: 'value' } },
        },
      }],
    }),
    rejectsWithCode('graph_validation_failed'),
  );
  assert.equal(application.kernel.revision, 1);

  const validation = await application.dispatch('three_studio_validate', {
    sessionId: application.sessionId,
    projectId: 'project/active',
    checks: ['graphs'],
  });
  assert.equal(validation.success, true);
});

test('dry-run apply compiles and disposes its candidate without swapping or mutating the project', async (t) => {
  const { application, THREE, viewport } = await applicationFixture(t);
  const liveRoot = viewport.scene.children[0];
  const groupCountBefore = THREE.groups.length;
  const titleCountBefore = viewport.titles.length;

  const result = await application.dispatch('three_studio_apply', {
    protocolVersion: 'three-studio/1',
    sessionId: application.sessionId,
    projectId: 'project/active',
    baseRevision: 0,
    idempotencyKey: 'dry-run-entity-0001',
    label: 'Preview an entity',
    dryRun: true,
    operations: [{
      op: 'entity.create',
      sceneId: 'scene/main',
      entity: { id: 'entity/preview', kind: 'group', name: 'Preview' },
    }],
  });

  assert.equal(result.success, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.revision, 0);
  assert.equal(result.expectedRevision, 1);
  assert.equal(application.kernel.revision, 0);
  assert.equal(application.kernel.document.scenes['scene/main'].entities['entity/preview'], undefined);
  assert.deepEqual(viewport.scene.children, [liveRoot]);
  assert.equal(viewport.titles.length, titleCountBefore);
  assert.equal(THREE.groups.length, groupCountBefore + 2, 'candidate root and entity should be compiled');
  assert.equal(THREE.groups.at(-2).clearCount, 1, 'dry-run candidate root should be disposed');
});

test('scene swaps retain the authored linear background for the viewport presentation layer', async (t) => {
  const { application, viewport } = await applicationFixture(t);
  const initialBackground = viewport.scene.background;
  assert.equal(viewport.scene.backgroundNode, null);
  assert.deepEqual(initialBackground.value, [0.035, 0.045, 0.06]);

  const result = await application.dispatch('three_studio_apply', {
    protocolVersion: 'three-studio/1',
    sessionId: application.sessionId,
    projectId: 'project/active',
    baseRevision: 0,
    idempotencyKey: 'background-node-swap-0001',
    label: 'Exercise background-node scene swap',
    operations: [{
      op: 'entity.create',
      sceneId: 'scene/main',
      entity: { id: 'entity/background-swap', kind: 'group', name: 'Background swap marker' },
    }],
  });

  assert.equal(result.success, true);
  assert.equal(viewport.scene.backgroundNode, null);
  assert.notEqual(viewport.scene.background, initialBackground);
  assert.deepEqual(viewport.scene.background.value, [0.035, 0.045, 0.06]);
});

test('a project switch compile failure preserves the active project and live scene', async (t) => {
  const { application, studioRoot, viewport } = await applicationFixture(t);
  const liveRoot = viewport.scene.children[0];
  const brokenRoot = path.join(studioRoot, 'projects', 'broken');
  await saveProject(brokenRoot, createProjectDocument({
    projectId: 'project/broken',
    name: 'Broken at Runtime',
    scenes: [{
      id: 'scene/main',
      entities: [{ id: 'entity/sprite', kind: 'sprite' }],
    }],
  }));

  await assert.rejects(
    application.dispatch('three_studio_project', {
      action: 'open',
      sessionId: application.sessionId,
      path: 'broken',
      idempotencyKey: 'open-broken-0001',
      label: 'Open broken project',
    }),
    rejectsWithCode('runtime_compile_failed'),
  );

  const status = application.status();
  assert.equal(status.projectId, 'project/active');
  assert.equal(status.projectPath, path.join(studioRoot, 'projects', 'active'));
  assert.deepEqual(viewport.scene.children, [liveRoot]);
  assert.equal(liveRoot.parent, viewport.scene);
});
