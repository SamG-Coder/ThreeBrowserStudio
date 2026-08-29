import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LiveBridgeClient, RpcError } from '../src/bridge/index.mjs';
import {
  AtomicProjectStore,
  MAX_INSPECT_RESPONSE_BYTES,
  contentHash,
  createProjectDocument,
  createResourceDocument,
  hashExactEntitySet,
} from '../src/core/index.mjs';
import { LAYOUT_PATTERN_MODES } from '../src/core/layout-patterns.mjs';
import { TOOL_CONTRACT, TOOL_CONTRACT_SUMMARY } from '../src/mcp/tool-schemas.mjs';
import { StudioApplication, buildResourceDigest } from '../src/runtime/studio-application.mjs';

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
  const ping = await client.ping();
  assert.deepEqual(ping.serverInfo.toolContract, TOOL_CONTRACT);
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

test('resource digest exposes bounded topology summaries, filters, references, and pagination', async (t) => {
  const { application } = await applicationFixture(t);
  const positions = [
    -2, -1, -3,
    4, -1, -3,
    4, 5, 6,
    -2, 5, 6,
  ];
  const graphId = 'graph/resource-digest-surface';
  const created = await application.dispatch('three_studio_apply', {
    protocolVersion: 'three-studio/1',
    sessionId: application.sessionId,
    projectId: 'project/active',
    baseRevision: 0,
    idempotencyKey: 'resource-digest-create-0001',
    label: 'Create resources for bounded digest inspection',
    operations: [
      {
        op: 'resource.create',
        resourceType: 'geometry',
        resource: {
          id: 'geometry/resource-digest-hero',
          kind: 'geometry',
          name: 'Snow Hero Mesh',
          tags: ['hero', 'snow'],
          metadata: { samples: Array.from({ length: 40 }, (_, index) => index) },
          recipe: {
            kind: 'indexedMesh',
            positions,
            indices: [0, 1, 2, 0, 2, 3],
            normals: new Array(12).fill(1),
            uvs: [0, 0, 1, 0, 1, 1, 0, 1],
            colors: new Array(16).fill(0.5),
            computeNormals: false,
          },
        },
      },
      {
        op: 'resource.create',
        resourceType: 'graph',
        resource: {
          id: graphId,
          kind: 'graph',
          name: 'Digest Surface',
          graph: {
            formatVersion: 1,
            id: graphId,
            domain: 'shader',
            nodes: [{ id: 'color', type: 'constant.color', params: { value: [0.2, 0.3, 0.4] } }],
            edges: [],
            outputs: { baseColor: { nodeId: 'color', port: 'value' } },
          },
        },
      },
      {
        op: 'resource.create',
        resourceType: 'material',
        resource: {
          id: 'material/resource-digest-hero',
          kind: 'material',
          name: 'Hero Material',
          graphId,
          roughness: 0.72,
        },
      },
      {
        op: 'resource.create',
        resourceType: 'asset',
        resource: {
          id: 'asset/resource-digest-reference',
          kind: 'asset',
          name: 'Reference Asset',
        },
      },
    ],
  });
  assert.equal(created.success, true);

  const geometryPage = await application.dispatch('three_studio_inspect', {
    sessionId: application.sessionId,
    projectId: 'project/active',
    query: 'resourceDigest',
    selector: {
      ids: ['geometry/resource-digest-hero'],
      name: 'HERO',
      kind: 'geometry',
      tag: 'snow',
    },
    include: ['summary', 'components', 'bounds', 'references'],
    limit: 1,
  });
  assert.equal(geometryPage.success, true);
  assert.equal(geometryPage.revision, 1);
  assert.equal(geometryPage.resourceCount, 4);
  assert.equal(geometryPage.selectedResourceCount, 1);
  assert.equal(geometryPage.nextCursor, null);
  assert.equal(geometryPage.resources.length, 1);
  const geometry = geometryPage.resources[0];
  assert.deepEqual({
    id: geometry.id,
    resourceType: geometry.resourceType,
    recipeKind: geometry.recipeKind,
    vertexCount: geometry.vertexCount,
    indexCount: geometry.indexCount,
    triangleCount: geometry.triangleCount,
    hasNormals: geometry.hasNormals,
    hasUVs: geometry.hasUVs,
    hasColors: geometry.hasColors,
    computeNormals: geometry.computeNormals,
    localBounds: geometry.localBounds,
  }, {
    id: 'geometry/resource-digest-hero',
    resourceType: 'geometries',
    recipeKind: 'indexedMesh',
    vertexCount: 4,
    indexCount: 6,
    triangleCount: 2,
    hasNormals: true,
    hasUVs: true,
    hasColors: true,
    computeNormals: false,
    localBounds: { min: [-2, -1, -3], max: [4, 5, 6] },
  });
  assert.equal(geometry.resourceHash, contentHash(
    application.kernel.document.resources.geometries['geometry/resource-digest-hero'],
  ));
  assert.deepEqual(geometry.components.recipe.positions, { length: 12, itemSize: 3 });
  assert.deepEqual(geometry.components.recipe.indices, { length: 6, itemSize: 1 });
  assert.deepEqual(geometry.components.recipe.normals, { length: 12, itemSize: 3 });
  assert.deepEqual(geometry.components.recipe.uvs, { length: 8, itemSize: 2 });
  assert.deepEqual(geometry.components.recipe.colors, { length: 16, itemSize: 4 });
  assert.deepEqual(geometry.components.metadata.samples, { length: 40, itemSize: 1 });
  assert.equal(Array.isArray(geometry.components.recipe.positions), false);
  assert.equal(Array.isArray(geometry.components.recipe.indices), false);
  assert.equal(JSON.stringify(geometry.components).includes(JSON.stringify(positions)), false);
  assert.equal(geometry.referenceCount, 0);
  assert.deepEqual(geometry.referencesTo, []);

  const firstPage = await application.dispatch('three_studio_inspect', {
    sessionId: application.sessionId,
    projectId: 'project/active',
    query: 'resourceDigest',
    limit: 2,
  });
  assert.deepEqual(firstPage.resources.map(resource => resource.id), [
    'asset/resource-digest-reference',
    'geometry/resource-digest-hero',
  ]);
  assert.equal(firstPage.nextCursor, '2');
  assert.equal(Object.hasOwn(firstPage.resources[1], 'localBounds'), false);
  const secondPage = await application.dispatch('three_studio_inspect', {
    sessionId: application.sessionId,
    projectId: 'project/active',
    query: 'resourceDigest',
    cursor: firstPage.nextCursor,
    limit: 2,
    include: ['summary', 'references'],
  });
  assert.deepEqual(secondPage.resources.map(resource => resource.id), [
    'graph/resource-digest-surface',
    'material/resource-digest-hero',
  ]);
  assert.equal(secondPage.nextCursor, null);
  assert.equal(secondPage.resources[0].referenceCount, 1);
  assert.deepEqual(secondPage.resources[0].referencesTo, [{
    kind: 'materialGraph',
    sourceId: 'material/resource-digest-hero',
  }]);
});

test('resource digest enforces one total response budget across a maximum-size page', () => {
  const document = createProjectDocument({ projectId: 'project/resource-budget', name: 'Resource budget' });
  const metadata = Object.fromEntries(Array.from(
    { length: 160 },
    (_, index) => [`field_${String(index).padStart(3, '0')}`, 'x'.repeat(256)],
  ));
  for (let index = 0; index < 200; index += 1) {
    const id = `asset/budget-${String(index).padStart(3, '0')}`;
    document.resources.assets[id] = createResourceDocument('assets', {
      id,
      kind: 'asset',
      name: `Budget asset ${index}`,
      metadata,
    });
  }

  const digest = buildResourceDigest(document, { include: ['components'], limit: 200 });
  const serializedBytes = new TextEncoder().encode(JSON.stringify(digest)).byteLength;
  assert.ok(digest.resources.length > 0 && digest.resources.length < 200);
  assert.equal(digest.nextCursor, String(digest.resources.length));
  assert.equal(digest.responseByteBudget, MAX_INSPECT_RESPONSE_BYTES);
  assert.ok(serializedBytes <= MAX_INSPECT_RESPONSE_BYTES);

  const next = buildResourceDigest(document, {
    include: ['components'],
    cursor: digest.nextCursor,
    limit: 200,
  });
  assert.ok(next.resources.length > 0);
  assert.equal(next.resources[0].id, `asset/budget-${String(digest.resources.length).padStart(3, '0')}`);
});

test('meshElements returns exact hash-guarded authored topology pages', async (t) => {
  const { application } = await applicationFixture(t);
  await application.dispatch('three_studio_apply', {
    protocolVersion: 'three-studio/1',
    sessionId: application.sessionId,
    projectId: 'project/active',
    baseRevision: 0,
    idempotencyKey: 'mesh-elements-create-0001',
    label: 'Create exact inspectable mesh',
    operations: [{
      op: 'resource.create',
      resourceType: 'geometry',
      resource: {
        id: 'geometry/mesh-elements',
        kind: 'geometry',
        name: 'Inspectable quad',
        recipe: {
          kind: 'indexedMesh',
          positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
          indices: [0, 1, 2, 0, 2, 3],
          uvs: [0, 0, 1, 0, 1, 1, 0, 1],
        },
      },
    }],
  });
  const first = await application.dispatch('three_studio_inspect', {
    sessionId: application.sessionId,
    projectId: 'project/active',
    query: 'meshElements',
    selector: { ids: ['geometry/mesh-elements'] },
    element: 'faces',
    limit: 1,
  });
  assert.equal(first.success, true);
  assert.equal(first.revision, 1);
  assert.equal(first.elements.length, 1);
  assert.deepEqual(first.elements[0].vertices, [0, 1, 2]);
  assert.match(first.resourceHash, /^[a-f0-9]{64}$/);
  assert.match(first.topologyHash, /^[a-f0-9]{64}$/);
  assert.match(first.nextCursor, /^[a-f0-9]{64}\.[a-f0-9]{64}\.1$/);
  const second = await application.dispatch('three_studio_inspect', {
    sessionId: application.sessionId,
    projectId: 'project/active',
    query: 'meshElements',
    selector: { ids: ['geometry/mesh-elements'] },
    element: 'faces',
    cursor: first.nextCursor,
    limit: 1,
  });
  assert.deepEqual(second.elements[0].vertices, [0, 2, 3]);
  assert.equal(second.nextCursor, null);
});

test('graphDigest and rtxDigest expose exact authoring and runtime diagnostics', async (t) => {
  const { application, viewport } = await applicationFixture(t);
  await application.dispatch('three_studio_apply', {
    protocolVersion: 'three-studio/1',
    sessionId: application.sessionId,
    projectId: 'project/active',
    baseRevision: 0,
    idempotencyKey: 'graph-digest-create-0001',
    label: 'Create inspectable graph',
    operations: [{
      op: 'resource.create',
      resourceType: 'graph',
      resource: {
        id: 'graph/inspectable',
        kind: 'graph',
        name: 'Inspectable graph',
        graph: {
          formatVersion: 1,
          id: 'graph/inspectable',
          domain: 'shader',
          nodes: [{ id: 'color', type: 'constant.color', params: { value: [0.2, 0.4, 0.6] } }],
          edges: [],
          outputs: { baseColor: { nodeId: 'color', port: 'value' } },
        },
      },
    }],
  });
  const graph = await application.dispatch('three_studio_inspect', {
    sessionId: application.sessionId,
    projectId: 'project/active',
    query: 'graphDigest',
    selector: { ids: ['graph/inspectable'] },
    limit: 1,
  });
  assert.equal(graph.success, true);
  assert.equal(graph.validation.valid, true);
  assert.equal(graph.nodes[0].id, 'color');
  assert.match(graph.resourceHash, /^[a-f0-9]{64}$/);
  assert.match(graph.graphHash, /^[a-f0-9]{64}$/);

  viewport.getRtxStatus = () => ({ supported: true, requested: false, active: false });
  viewport.getRtxDigest = () => ({
    status: viewport.getRtxStatus(),
    collection: {
      current: false,
      skipCounts: { rtx_transparent: 2 },
      diagnostics: [{ code: 'rtx_transparent', objectId: 'entity/glass' }],
    },
  });
  const rtx = await application.dispatch('three_studio_inspect', {
    sessionId: application.sessionId,
    projectId: 'project/active',
    query: 'rtxDigest',
  });
  assert.equal(rtx.success, true);
  assert.match(rtx.authoredHash, /^[a-f0-9]{64}$/);
  assert.equal(rtx.effective.collection.skipCounts.rtx_transparent, 2);
  assert.equal(rtx.limits.maxTriangles, 2_000_000);
});

test('resource digest compacts a pathological first resource before bridge serialization', () => {
  const document = createProjectDocument({ projectId: 'project/resource-pathological', name: 'Pathological resource' });
  const id = 'asset/pathological-tag';
  document.resources.assets[id] = createResourceDocument('assets', {
    id,
    kind: 'asset',
    name: 'Pathological tag',
    tags: ['z'.repeat(1_000_000)],
  });
  const digest = buildResourceDigest(document, { include: ['summary'], limit: 200 });
  const serializedBytes = new TextEncoder().encode(JSON.stringify(digest)).byteLength;
  assert.equal(digest.resources.length, 1);
  assert.ok(digest.resources[0].tags[0].length <= 120);
  assert.ok(serializedBytes <= MAX_INSPECT_RESPONSE_BYTES);
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
  assert.equal(status.capabilities.layoutGenerators, true);
  assert.deepEqual(status.capabilities.layoutPatterns, [...LAYOUT_PATTERN_MODES]);
  assert.equal(status.capabilities.modifierRuntime.includes('pattern'), true);
  assert.equal(status.capabilities.implementedOperations.includes('layout.pattern'), true);
  assert.equal(status.capabilities.geometryEditing, true);
  assert.deepEqual(status.capabilities.geometryEditCommands, [
    'move', 'scale', 'rotate', 'smooth', 'recalculateNormals', 'weld', 'triangulate',
  ]);
  assert.equal(status.capabilities.maxGeometryEditCommands, 64);
  assert.equal(status.capabilities.implementedOperations.includes('geometry.edit'), true);
  assert.deepEqual(status.capabilities.toolContract, TOOL_CONTRACT_SUMMARY);
  assert.equal(Object.hasOwn(status.capabilities.toolContract, 'inputSchemas'), false);
  assert.deepEqual(viewport.scene.children, [liveRoot]);
  assert.equal(liveRoot.parent, viewport.scene);
});

test('live collection inspection returns guarded membership and exact entity-set hashes', async (t) => {
  const { application } = await applicationFixture(t);
  await application.dispatch('three_studio_apply', {
    protocolVersion: 'three-studio/1',
    sessionId: application.sessionId,
    projectId: 'project/active',
    baseRevision: 0,
    idempotencyKey: 'collection-inspection-create-0001',
    label: 'Create an exact organizational collection',
    operations: [
      { op: 'entity.create', sceneId: 'scene/main', entity: { id: 'entity/tree', name: 'Tree' } },
      { op: 'entity.create', sceneId: 'scene/main', entity: { id: 'entity/road', name: 'Road' } },
      {
        op: 'collection.create', sceneId: 'scene/main',
        collection: { id: 'collection/environment', name: 'Environment', entityIds: ['entity/tree'] },
      },
    ],
  });

  const result = await application.dispatch('three_studio_inspect', {
    sessionId: application.sessionId,
    projectId: 'project/active',
    sceneId: 'scene/main',
    query: 'selector',
    selector: { collectionId: 'collection/environment' },
    include: ['summary', 'tree'],
  });
  assert.equal(result.success, true);
  assert.equal(result.scene.collectionCount, 1);
  assert.deepEqual(result.scene.rootCollectionIds, ['collection/environment']);
  assert.equal(result.scene.selectedEntityCount, 1);
  assert.equal(result.scene.selectionHash, hashExactEntitySet(application.kernel.document, ['entity/tree']));
  assert.equal(result.collection.membershipHash, contentHash(['entity/tree']));
  assert.match(result.collection.subtreeHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.entities.map(entity => entity.id), ['entity/tree']);
});
