import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LiveBridgeClient, RpcError } from '../src/bridge/index.mjs';
import {
  AtomicProjectStore,
  MAX_INSPECT_RESPONSE_BYTES,
  StudioError,
  contentHash,
  createProjectDocument,
  createResourceDocument,
  encodePngRgba,
  hashExactEntitySet,
} from '../src/core/index.mjs';
import { LAYOUT_PATTERN_MODES } from '../src/core/layout-patterns.mjs';
import { TOOL_CONTRACT, TOOL_CONTRACT_SUMMARY } from '../src/mcp/tool-schemas.mjs';
import { createProjectPack, parseProjectPack } from '../src/core/project-pack.mjs';
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
  class Disposable {
    constructor() { this.userData = {}; this.disposeCount = 0; }
    dispose() { this.disposeCount += 1; }
  }
  class Mesh extends Group {
    constructor(geometry, material) {
      super();
      this.geometry = geometry;
      this.material = material;
      this.isMesh = true;
    }
  }
  class PerspectiveCamera extends Group {
    constructor(fov = 46, aspect = 16 / 9, near = 0.05, far = 2000) {
      super();
      this.isCamera = true;
      this.isPerspectiveCamera = true;
      this.fov = fov;
      this.aspect = aspect;
      this.near = near;
      this.far = far;
    }

    updateProjectionMatrix() {}
  }
  class BufferAttribute {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.count = array.length / itemSize; }
    getX(index) { return this.array[index * this.itemSize]; }
    getY(index) { return this.array[index * this.itemSize + 1]; }
    getZ(index) { return this.array[index * this.itemSize + 2]; }
  }
  class BufferGeometry extends Disposable {
    constructor() { super(); this.attributes = {}; this.groups = []; this.index = null; }
    setAttribute(name, value) { this.attributes[name] = value; return this; }
    getAttribute(name) { return this.attributes[name]; }
    setIndex(value) { this.index = value; return this; }
    getIndex() { return this.index ? { count: this.index.length, getX: index => this.index[index] } : null; }
    computeVertexNormals() { this.attributes.normal = { count: this.attributes.position?.count ?? 0 }; }
    computeBoundingBox() {}
    computeBoundingSphere() {}
  }
  return {
    groups,
    Group: class extends Group {
      constructor() {
        super();
        groups.push(this);
      }
    },
    Color,
    Matrix4: class {
      makeTranslation() { return this; }
      makeScale() { return this; }
      clone() { return new this.constructor(); }
      multiply() { return this; }
    },
    Mesh,
    PerspectiveCamera,
    BufferGeometry,
    Float32BufferAttribute: BufferAttribute,
    BoxGeometry: class extends Disposable {},
    MeshStandardNodeMaterial: class extends Disposable {},
    FrontSide: 0,
    BackSide: 1,
    DoubleSide: 2,
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
    outlines: [],
    viewMode: 'follow-shot',
    authoredCamera: camera,
    setRenderCamera(next) {
      this.authoredCamera = next;
      this.renderCamera = next;
    },
    setAuthoredCamera(next) {
      this.authoredCamera = next;
      if (this.viewMode === 'follow-shot') this.renderCamera = next ?? this.camera;
    },
    followShot() {
      this.viewMode = 'follow-shot';
      this.renderCamera = this.authoredCamera ?? this.camera;
    },
    enterReview() {
      this.viewMode = 'review';
      this.renderCamera = this.camera;
    },
    setTitle(title) {
      this.titles.push(structuredClone(title));
    },
    setExplorerOutline(outline) {
      this.outlines.push(outline);
    },
  };
  return viewport;
}

async function saveProject(projectRoot, document) {
  await new AtomicProjectStore(projectRoot).save(document);
}

async function applicationFixture(t, { document } = {}) {
  const studioRoot = await mkdtemp(path.join(os.tmpdir(), 'three-studio-app-boundary-'));
  const activeRoot = path.join(studioRoot, 'projects', 'active');
  await saveProject(activeRoot, document ?? createProjectDocument({
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

test('native Studio publishes the stable ownership marker without tool-contract extensions', async (t) => {
  const { application } = await applicationFixture(t);
  const marker = JSON.parse(await readFile(application.markerPath, 'utf8'));

  assert.deepEqual(Object.keys(marker).sort(), [
    'heartbeat',
    'pid',
    'pipePath',
    'projectId',
    'projectPath',
    'protocolVersion',
    'revision',
    'sessionId',
    'token',
    'viewportReady',
  ]);
  assert.equal(Object.hasOwn(marker, 'toolContractHash'), false);

  const client = await LiveBridgeClient.fromMarker(application.markerPath, { timeoutMs: 1_000 });
  t.after(() => client.close());
  const ping = await client.ping();
  assert.equal(ping.sessionId, marker.sessionId);
  assert.equal(ping.pid, marker.pid);
  assert.deepEqual(ping.serverInfo.toolContract, TOOL_CONTRACT);
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
  assert.match(first.nextCursor, /^[a-f0-9]{64}\.[a-f0-9]{64}\.faces\.1$/);
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

test('modifierDigest exposes the exact contextual viewport boundary without blocking authoring', async (t) => {
  const { application } = await applicationFixture(t);
  const created = await application.dispatch('three_studio_apply', {
    protocolVersion: 'three-studio/1',
    sessionId: application.sessionId,
    projectId: 'project/active',
    baseRevision: 0,
    idempotencyKey: 'modifier-digest-boundary-0001',
    label: 'Author an explicit modifier bake boundary',
    operations: [
      { op: 'resource.create', resourceType: 'geometry', resource: {
        id: 'geometry/wall', kind: 'box', width: 2, height: 2, depth: 0.2,
      } },
      { op: 'resource.create', resourceType: 'material', resource: {
        id: 'material/stone', kind: 'standard', color: '#777777',
      } },
      { op: 'entity.create', sceneId: 'scene/main', entity: {
        id: 'entity/wall', kind: 'mesh',
        components: {
          mesh: { geometryId: 'geometry/wall', materialIds: ['material/stone'] },
          modifiers: [{
            id: 'modifier/bevel', type: 'bakeBoundary', operatorType: 'BEVEL',
            parameters: { width: 0.05, segments: 3 },
          }],
        },
      } },
    ],
  });
  assert.equal(created.success, true);
  const digest = await application.dispatch('three_studio_inspect', {
    sessionId: application.sessionId,
    projectId: 'project/active',
    query: 'modifierDigest',
    selector: { ids: ['entity/wall'] },
  });
  assert.equal(digest.sourceGeometryId, 'geometry/wall');
  assert.equal(digest.sourceRecipeKind, 'box');
  assert.equal(digest.viewportEvaluation.status, 'partial-preview');
  assert.equal(digest.viewportEvaluation.blocked.reasonCode, 'runtime_modifier_bake_required');
  assert.equal(digest.modifiers[0].viewport.status, 'blocked');
  assert.equal(digest.modifiers[0].viewport.reasonCode, 'runtime_modifier_bake_required');
});

test('format-v1 legacy modifier projects open as an explicitly partial preview', async (t) => {
  const document = createProjectDocument({
    projectId: 'project/active',
    resources: {
      geometries: [{ id: 'geometry/legacy', kind: 'box' }],
      materials: [{ id: 'material/legacy', kind: 'standard' }],
    },
    scenes: [{
      id: 'scene/main',
      entities: [{
        id: 'entity/legacy', kind: 'mesh',
        components: {
          mesh: { geometryId: 'geometry/legacy', materialIds: ['material/legacy'] },
          modifiers: [{ id: 'modifier/legacy-bevel', type: 'bevel', width: 0.1 }],
        },
      }],
    }],
  });
  const { application } = await applicationFixture(t, { document });
  const digest = await application.dispatch('three_studio_inspect', {
    sessionId: application.sessionId,
    projectId: 'project/active',
    query: 'modifierDigest',
    selector: { ids: ['entity/legacy'] },
  });
  assert.equal(digest.modifiers[0].legacyUnknown, true);
  assert.equal(digest.viewportEvaluation.status, 'partial-preview');
  assert.equal(digest.viewportEvaluation.blocked.modifierId, 'modifier/legacy-bevel');
  assert.equal(application.kernel.document.projectId, 'project/active');
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

test('high-level resources may depend on resources created earlier in the same atomic apply', async (t) => {
  const { application } = await applicationFixture(t);
  const result = await application.dispatch('three_studio_apply', {
    protocolVersion: 'three-studio/1', sessionId: application.sessionId,
    projectId: 'project/active', baseRevision: 0,
    idempotencyKey: 'same-apply-material-variant-0001', label: 'Create base and inherited material',
    operations: [
      { op: 'resource.create', resourceType: 'materials', resource: {
        id: 'material/base', recipe: { kind: 'physical', color: '#334455', roughness: 0.5 },
      } },
      { op: 'material.variant.create', baseMaterialId: 'material/base', materialId: 'material/variant', patch: {
        recipe: { roughness: 0.1, metalness: 0.8 },
      } },
    ],
  });
  assert.equal(result.success, true);
  assert.equal(result.revision, 1);
  assert.deepEqual(application.kernel.document.resources.materials['material/variant'].recipe, {
    kind: 'physical', color: '#334455', roughness: 0.1, metalness: 0.8,
  });
});

test('geometry.realize turns a procedural resource into editable vertices in the same apply', async (t) => {
  const { application } = await applicationFixture(t);
  const result = await application.dispatch('three_studio_apply', {
    protocolVersion: 'three-studio/1',
    sessionId: application.sessionId,
    projectId: 'project/active',
    baseRevision: 0,
    idempotencyKey: 'realize-loft-geometry-0001',
    label: 'Create and realize a loft',
    operations: [
      { op: 'resource.create', resourceType: 'geometries', resource: {
        id: 'geometry/realized-loft',
        recipe: {
          kind: 'loft',
          sections: [
            [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]],
            [[-0.5, -0.5, 1], [0.5, -0.5, 1], [0.5, 0.5, 1], [-0.5, 0.5, 1]],
          ],
        },
      } },
      { op: 'geometry.loft.edit', resourceId: 'geometry/realized-loft', changes: [
        { type: 'patch', sectionId: 'section/1', patch: { transform: { translation: [0, 0, 1] } } },
      ] },
      { op: 'geometry.realize', resourceId: 'geometry/realized-loft' },
    ],
  });
  assert.equal(result.success, true);
  const recipe = application.kernel.document.resources.geometries['geometry/realized-loft'].recipe;
  assert.equal(recipe.kind, 'editableMesh');
  assert.equal(recipe.positions.length, 24);
  assert.ok(recipe.uvLayers.UVMap.length > 0);
  assert.deepEqual(result.authoring.authoredOperationTypes, [
    { type: 'geometry.loft.edit', count: 1 },
    { type: 'geometry.realize', count: 1 },
    { type: 'resource.create', count: 1 },
  ]);
  assert.deepEqual(result.authoring.loweredOperationTypes, [
    { type: 'resource.create', count: 1 },
    { type: 'resource.patch', count: 2 },
  ]);
});

test('dry-run apply retains one guarded candidate and promotes it without a second compile', async (t) => {
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
  assert.equal(result.authoring.authoredOperationCount, 1);
  assert.equal(result.authoring.loweredOperationCount, 1);
  assert.deepEqual(result.authoring.authoredOperationTypes, [{ type: 'entity.create', count: 1 }]);
  assert.deepEqual(result.authoring.loweredOperationTypes, [{ type: 'entity.create', count: 1 }]);
  assert.equal(result.authoring.compileCount, 1);
  assert.equal(result.authoring.promotedCandidate, false);
  assert.match(result.candidateToken, /^[a-f0-9]{64}$/u);
  assert.ok(result.authoring.timingsMs.total >= result.authoring.timingsMs.compile);
  assert.equal(application.kernel.revision, 0);
  assert.equal(application.kernel.document.scenes['scene/main'].entities['entity/preview'], undefined);
  assert.deepEqual(viewport.scene.children, [liveRoot]);
  assert.equal(viewport.titles.length, titleCountBefore);
  assert.equal(THREE.groups.length, groupCountBefore + 2, 'candidate root and entity should be compiled');
  assert.equal(THREE.groups.at(-2).clearCount, 0, 'candidate remains available for guarded promotion');

  const promoted = await application.dispatch('three_studio_apply', {
    protocolVersion: 'three-studio/1',
    sessionId: application.sessionId,
    projectId: 'project/active',
    baseRevision: 0,
    idempotencyKey: 'promote-entity-0001',
    label: 'Promote the previewed entity',
    candidateToken: result.candidateToken,
    operations: [{
      op: 'entity.create',
      sceneId: 'scene/main',
      entity: { id: 'entity/preview', kind: 'group', name: 'Preview' },
    }],
  });
  assert.equal(promoted.success, true);
  assert.equal(promoted.revision, 1);
  assert.equal(promoted.authoring.compileCount, 0);
  assert.equal(promoted.authoring.promotedCandidate, true);
  assert.equal(THREE.groups.length, groupCountBefore + 2, 'promotion reuses the compiled candidate');
  assert.ok(application.kernel.document.scenes['scene/main'].entities['entity/preview']);

  await assert.rejects(application.dispatch('three_studio_apply', {
    protocolVersion: 'three-studio/1',
    sessionId: application.sessionId,
    projectId: 'project/active',
    baseRevision: 1,
    idempotencyKey: 'stale-promote-entity-0001',
    label: 'Reject stale candidate reuse',
    candidateToken: result.candidateToken,
    operations: [{ op: 'entity.patch', entityId: 'entity/preview', patch: { name: 'Changed' } }],
  }), rejectsWithCode('candidate_token_mismatch'));
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
  assert.ok(viewport.outlines.at(-1)?.entities['entity/background-swap']);
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
  assert.equal(status.viewport.viewMode, 'follow-shot');
  assert.equal(status.capabilities.viewportReviewMode, true);
  assert.equal(status.capabilities.overlayInvalidation, true);
  assert.equal(status.capabilities.layoutGenerators, true);
  assert.deepEqual(status.capabilities.layoutPatterns, [...LAYOUT_PATTERN_MODES]);
  assert.equal(status.capabilities.modifierRuntime.includes('pattern'), true);
  assert.equal(status.capabilities.geometryModifierRuntime.includes('subdivision'), true);
  assert.equal(status.capabilities.geometryModifierRuntime.includes('ocean'), true);
  assert.equal(status.capabilities.timelineGeometryRuntime, true);
  assert.deepEqual(status.capabilities.timelineGeometryModifierTypes, ['ocean']);
  assert.equal(status.capabilities.timelineGeometryMaxSamples, 131_072);
  assert.equal(status.capabilities.dynamicRtxGeometry, 'excluded-from-static-scene');
  assert.equal(status.capabilities.modifierAuthoring.exactStackHashGuards, true);
  assert.equal(status.capabilities.modifierAuthoring.atomicStackEditing, true);
  assert.equal(status.capabilities.modifierAuthoring.renderEnableFlag, 'authored-only-no-render-parity-claim');
  assert.equal(status.capabilities.implementedOperations.includes('layout.pattern'), true);
  assert.equal(status.capabilities.implementedOperations.includes('modifier.stack.edit'), true);
  assert.equal(status.capabilities.geometryEditing, true);
  assert.deepEqual(status.capabilities.geometryEditCommands, [
    'move', 'proportionalMove', 'sculptStroke', 'transformRegion', 'scale', 'rotate', 'smooth', 'recalculateNormals', 'weld', 'triangulate',
    'subdivideFaces', 'insetFaces', 'extrudeFaces', 'bevelEdges', 'deleteFaces', 'mergeVertices',
    'createUvLayer', 'deleteUvLayer', 'renameUvLayer', 'setActiveUvLayer', 'setCornerUvs',
    'transformUvs', 'projectUvs', 'createColorLayer', 'deleteColorLayer', 'renameColorLayer',
    'setActiveColorLayer', 'setCornerColors', 'assignFaceMaterials', 'setSharpEdges',
    'setEdgeCreases', 'removeEdgeCreases', 'paintColorStroke',
  ]);
  assert.equal(status.capabilities.geometryRecipes.includes('editableMesh'), true);
  assert.equal(status.capabilities.editableMesh.topologyHashGuards, true);
  assert.equal(status.capabilities.maxGeometryEditCommands, 64);
  assert.equal(status.capabilities.implementedOperations.includes('geometry.edit'), true);
  const materialControls = status.capabilities.imageTextures.materialControls;
  assert.deepEqual(materialControls.scalarRanges, {
    metalness: [0, 1],
    roughness: [0, 1],
    opacity: [0, 1],
    alphaTest: [0, 1],
    clearcoat: [0, 1],
    clearcoatRoughness: [0, 1],
    transmission: [0, 1],
    sheen: [0, 1],
    sheenRoughness: [0, 1],
    specularIntensity: [0, 1],
    anisotropy: [0, 1],
    iridescence: [0, 1],
    thickness: [0, 1_000_000],
    emissiveIntensity: [0, 1_000_000],
    ior: [1, 3],
    aoMapIntensity: [0, 1],
    bumpScale: [-1_000, 1_000],
    displacementScale: [-100_000, 100_000],
    displacementBias: [-100_000, 100_000],
  });
  assert.deepEqual(materialControls.vector2Ranges, {
    normalScale: [-100, 100],
    clearcoatNormalScale: [-100, 100],
  });
  assert.deepEqual(materialControls.booleans, ['vertexColors']);
  assert.deepEqual(materialControls.colors, [
    'baseColor', 'color', 'emissive', 'sheenColor', 'specularColor',
  ]);
  assert.deepEqual(materialControls.colorValueFormats, [
    'linear-rgb-array', 'numeric-color', 'css-color-subset',
  ]);
  assert.deepEqual(materialControls.colorValueLimits, {
    linearRgbArrayLength: [3, 4],
    linearRgbComponent: [0, 1_000_000],
    optionalAlpha: { range: [0, 1], behavior: 'ignored-use-opacity' },
    numericColor: [0, 0xffffff],
    cssColorStringLength: [1, 128],
    cssColorSyntax: [
      '#rgb', '#rrggbb', 'rgb(integer 0..255)', 'rgb(integer 0%..100%)',
      'hsl(unsigned degrees,unsigned 0%..100%,unsigned 0%..100%)', 'basic-name',
    ],
    cssColorNames: [
      'aqua', 'black', 'blue', 'fuchsia', 'gray', 'green', 'grey', 'lime',
      'maroon', 'navy', 'olive', 'orange', 'purple', 'red', 'silver', 'teal',
      'white', 'yellow',
    ],
  });
  assert.deepEqual(materialControls.mapAwareNeutralDefaults, {
    map: { color: [1, 1, 1] },
    normalMap: { normalScale: [1, 1] },
    roughnessMap: { roughness: 1 },
    metalnessMap: { metalness: 1 },
    emissiveMap: { emissive: [1, 1, 1], emissiveIntensity: 1 },
    alphaMap: { opacity: 1 },
    aoMap: { aoMapIntensity: 1 },
    bumpMap: { bumpScale: 1 },
    displacementMap: { displacementScale: 1, displacementBias: 0 },
    clearcoatMap: { clearcoat: 1 },
    clearcoatNormalMap: { clearcoat: 1, clearcoatNormalScale: [1, 1] },
    clearcoatRoughnessMap: { clearcoat: 1, clearcoatRoughness: 1 },
    sheenColorMap: { sheen: 1, sheenColor: [1, 1, 1] },
    sheenRoughnessMap: { sheen: 1, sheenRoughness: 1, sheenColor: [1, 1, 1] },
    transmissionMap: { transmission: 1 },
    thicknessMap: { transmission: 1, thickness: 1 },
    specularColorMap: { specularColor: [1, 1, 1] },
    specularIntensityMap: { specularIntensity: 1 },
    anisotropyMap: { anisotropy: 1 },
    iridescenceMap: { iridescence: 1 },
    iridescenceThicknessMap: { iridescence: 1 },
  });
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

test('new inspect queries and nodeInputs patches work together as an authoring demo', async (t) => {
  const { application, studioRoot } = await applicationFixture(t);
  const created = await application.dispatch('three_studio_apply', {
    protocolVersion: 'three-studio/1',
    sessionId: application.sessionId,
    projectId: 'project/active',
    baseRevision: 0,
    idempotencyKey: 'inspect-tools-demo-0001',
    label: 'Author a camera, group, filtered mesh, and Principled graph',
    operations: [
      {
        op: 'resource.create',
        resourceType: 'geometry',
        resource: {
          id: 'geometry/demo-box',
          kind: 'box',
          width: 0.4,
          height: 0.4,
          depth: 0.4,
        },
      },
      {
        op: 'resource.create',
        resourceType: 'geometry',
        resource: {
          id: 'geometry/demo-grid',
          kind: 'geometry',
          recipe: {
            kind: 'indexedMesh',
            positions: [
              0, 0, 0, 1, 0, 0, 2, 0, 0,
              0, 1, 0, 1, 1, 0, 2, 1, 0,
              0, 2, 0, 1, 2, 0, 2, 2, 0,
            ],
            indices: [
              0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4,
              3, 4, 7, 3, 7, 6, 4, 5, 8, 4, 8, 7,
            ],
          },
        },
      },
      {
        op: 'resource.create',
        resourceType: 'material',
        resource: { id: 'material/demo-cloth', kind: 'standard', color: '#553344' },
      },
      {
        op: 'resource.create',
        resourceType: 'graph',
        resource: {
          id: 'graph/demo-velvet',
          kind: 'graph',
          name: 'Demo velvet',
          graph: {
            formatVersion: 1,
            id: 'graph/demo-velvet',
            domain: 'shader',
            nodes: [
              { id: 'color', type: 'constant.color', params: { value: [0.18, 0.04, 0.07] } },
              {
                id: 'bsdf',
                type: 'blender.principledBSDF',
                params: {},
                inputs: { roughness: 0.72, sheenWeight: 0.45, metallic: 0.05 },
              },
            ],
            edges: [{
              from: { nodeId: 'color', port: 'value' },
              to: { nodeId: 'bsdf', port: 'baseColor' },
            }],
            outputs: { baseColor: { nodeId: 'color', port: 'value' } },
          },
        },
      },
      {
        op: 'entity.create',
        sceneId: 'scene/main',
        entity: {
          id: 'entity/camera',
          kind: 'perspectiveCamera',
          transform: { position: [0, 0, 2] },
          components: { camera: { fov: 46, near: 0.05, far: 100 } },
        },
      },
      { op: 'scene.setActiveCamera', sceneId: 'scene/main', cameraId: 'entity/camera' },
      {
        op: 'entity.create',
        sceneId: 'scene/main',
        entity: {
          id: 'entity/still',
          kind: 'group',
          name: 'Still',
        },
      },
      {
        op: 'entity.create',
        sceneId: 'scene/main',
        entity: {
          id: 'entity/cloth',
          kind: 'mesh',
          parentId: 'entity/still',
          transform: { position: [0, 0, 0] },
          components: { mesh: { geometryId: 'geometry/demo-box', materialIds: ['material/demo-cloth'] } },
        },
      },
      {
        op: 'entity.create',
        sceneId: 'scene/main',
        entity: {
          id: 'entity/offstage',
          kind: 'empty',
          transform: { position: [0, 0, 6] },
        },
      },
    ],
  });
  assert.equal(created.success, true);

  const filtered = await application.dispatch('three_studio_inspect', {
    sessionId: application.sessionId,
    projectId: 'project/active',
    query: 'meshElements',
    selector: { ids: ['geometry/demo-grid'] },
    element: 'vertices',
    meshFilter: { yMin: 0.5, yMax: 1.5, boundary: false },
  });
  assert.deepEqual(filtered.elements.map(item => item.index), [4]);

  const sockets = await application.dispatch('three_studio_inspect', {
    sessionId: application.sessionId,
    projectId: 'project/active',
    query: 'graphDigest',
    selector: { ids: ['graph/demo-velvet'] },
  });
  const bsdf = sockets.nodes.find(node => node.id === 'bsdf');
  assert.equal(bsdf.sockets.find(socket => socket.port === 'roughness').source, 'authored');
  assert.equal(bsdf.sockets.find(socket => socket.port === 'ior').source, 'default');
  const sheenBefore = bsdf.sockets.find(socket => socket.port === 'sheenWeight').value;

  const visibility = await application.dispatch('three_studio_inspect', {
    sessionId: application.sessionId,
    projectId: 'project/active',
    query: 'projectVisibility',
    projection: { entityIds: ['entity/cloth', 'entity/offstage'], width: 1280, height: 720 },
  });
  assert.equal(visibility.points.find(point => point.entityId === 'entity/cloth').visibility, 'on-screen');
  assert.equal(visibility.points.find(point => point.entityId === 'entity/offstage').visibility, 'behind-camera');

  const groupDigest = await application.dispatch('three_studio_inspect', {
    sessionId: application.sessionId,
    projectId: 'project/active',
    query: 'modifierDigest',
    selector: { ids: ['entity/still'] },
  });
  assert.equal(groupDigest.kind, 'group');
  assert.equal(groupDigest.meshCount, 1);
  assert.equal(groupDigest.children[0].entityId, 'entity/cloth');

  const patched = await application.dispatch('three_studio_apply', {
    protocolVersion: 'three-studio/1',
    sessionId: application.sessionId,
    projectId: 'project/active',
    baseRevision: created.revision,
    idempotencyKey: 'inspect-tools-demo-socket-0002',
    label: 'Raise velvet roughness without wiping sheen',
    operations: [{
      op: 'resource.patch',
      resourceType: 'graph',
      resourceId: 'graph/demo-velvet',
      patch: { nodeInputs: { bsdf: { roughness: 0.96 } } },
    }],
  });
  assert.equal(patched.success, true);
  const after = await application.dispatch('three_studio_inspect', {
    sessionId: application.sessionId,
    projectId: 'project/active',
    query: 'graphDigest',
    selector: { ids: ['graph/demo-velvet'] },
  });
  const afterBsdf = after.nodes.find(node => node.id === 'bsdf');
  assert.equal(afterBsdf.sockets.find(socket => socket.port === 'roughness').value, 0.96);
  assert.equal(afterBsdf.sockets.find(socket => socket.port === 'sheenWeight').value, sheenBefore);

  const artifacts = path.join(studioRoot, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  const first = Buffer.alloc(8, 40);
  first[3] = 255; first[7] = 255;
  const second = Buffer.from(first);
  second[0] = 255;
  await writeFile(path.join(artifacts, 'studio-9001.png'), encodePngRgba(2, 1, first));
  await writeFile(path.join(artifacts, 'studio-9002.png'), encodePngRgba(2, 1, second));
  const beauty = await application.dispatch('three_studio_inspect', {
    sessionId: application.sessionId,
    projectId: 'project/active',
    query: 'beautyDigest',
    evidence: {
      path: 'studio-9001.png',
      comparePath: 'studio-9002.png',
      probes: [{ name: 'left', x: 0, y: 0 }],
    },
  });
  assert.equal(beauty.width, 2);
  assert.equal(beauty.compare.changedPixelCount, 1);
  assert.equal(beauty.probes[0].rgba[0], 40);
});

test('host Settings import writes a new managed project and export returns a pack', async (t) => {
  const { application, studioRoot } = await applicationFixture(t);
  const packed = createProjectDocument({
    projectId: 'project/packed',
    name: 'Packed Scene',
    scriptTrustPolicy: 'trusted-project',
  });
  const status = await application.importProjectDocument(createProjectPack(packed));
  assert.equal(status.projectName, 'Packed Scene');
  assert.equal(application.kernel.document.scriptTrustPolicy, 'agent-safe');
  assert.match(application.kernel.store.root.replaceAll('\\', '/'), /\/projects\/imports\/packed-scene-/);
  assert.equal(application.kernel.store.root.startsWith(path.join(studioRoot, 'projects')), true);

  const exported = await application.exportProjectDocument();
  assert.equal(exported.kind, 'ThreeStudioProjectPack');
  assert.equal(exported.document.name, 'Packed Scene');
  assert.equal(parseProjectPack(JSON.stringify(exported)).scriptTrustPolicy, 'agent-safe');
});

test('host Settings applies active-scene RTX controls through the canonical kernel', async (t) => {
  const { application } = await applicationFixture(t);

  const response = await application.patchActiveSceneRtx({
    enabled: true,
    lighting: true,
    shadows: true,
    ambientOcclusion: false,
    directionalSampleCount: 5,
    shadowStrength: 0.72,
  });

  assert.equal(response.success, true);
  assert.equal(response.revision, 1);
  assert.deepEqual(application.getActiveSceneRtxSettings(), {
    enabled: true,
    lighting: true,
    shadows: true,
    ambientOcclusion: false,
    directionalSampleCount: 5,
    directionalAngularRadius: 0.0065,
    shadowStrength: 0.72,
    aoSampleCount: 2,
    aoStrength: 0.22,
    aoRadius: 0.8,
    maxDistance: 10_000,
    rayBias: 0.002,
  });
  const copy = application.getActiveSceneRtxSettings();
  copy.enabled = false;
  assert.equal(application.getActiveSceneRtxSettings().enabled, true);

  await assert.rejects(
    application.patchActiveSceneRtx({ reflections: true }),
    error => error instanceof StudioError && error.code === 'unknown_property',
  );
  assert.equal(application.kernel.revision, 1);
});
