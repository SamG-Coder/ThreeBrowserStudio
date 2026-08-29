import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AuthoringKernel,
  createProjectDocument,
} from '../src/core/index.mjs';
import {
  GEOMETRY_EDIT_COMMAND_TYPES,
  MAX_GEOMETRY_EDIT_COMMANDS,
  MAX_GEOMETRY_EDIT_VERTEX_SELECTION,
  applySchema,
} from '../src/mcp/index.mjs';

const TRIANGLE_RECIPE = Object.freeze({
  kind: 'explicit',
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  indices: [0, 1, 2],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 0, 1],
});

function kernelWithGeometry(resource = {
  id: 'geometry/editable',
  recipe: TRIANGLE_RECIPE,
}) {
  let transaction = 0;
  return new AuthoringKernel(createProjectDocument({
    projectId: 'project/geometry-edit',
    timestamp: '2026-08-29T00:00:00.000Z',
    resources: { geometries: [resource] },
  }), {
    transactionIdFactory: prefix => `${prefix}/geometry-${++transaction}`,
    clock: () => Date.UTC(2026, 7, 29, 0, 0, transaction),
  });
}

function applyRequest(overrides = {}) {
  return {
    protocolVersion: 'three-studio/1',
    projectId: 'project/geometry-edit',
    baseRevision: 0,
    idempotencyKey: 'geometry-edit-0001',
    label: 'Edit indexed geometry',
    operations: [{
      type: 'geometry.edit',
      resourceId: 'geometry/editable',
      edits: [{ type: 'move', vertexIndices: [1], offset: [1, 0, 0] }],
    }],
    ...overrides,
  };
}

function mcpRequest(edits, expectedTopologyHash) {
  return {
    protocolVersion: 'three-studio/1',
    sessionId: 'live-session',
    projectId: 'project/geometry-edit',
    baseRevision: 0,
    idempotencyKey: 'geometry-edit-schema-0001',
    label: 'Edit indexed geometry',
    operations: [{
      op: 'geometry.edit',
      resourceId: 'geometry/editable',
      edits,
      ...(expectedTopologyHash ? { expectedTopologyHash } : {}),
    }],
  };
}

test('geometry.edit resolves transaction aliases and applies ordered edits to a canonical recipe', async () => {
  const kernel = new AuthoringKernel(createProjectDocument({
    projectId: 'project/geometry-edit',
    timestamp: '2026-08-29T00:00:00.000Z',
  }));
  const result = await kernel.apply(applyRequest({
    operations: [
      {
        type: 'resource.create',
        resourceType: 'geometry',
        alias: '$editable',
        resource: { id: 'geometry/aliased', recipe: TRIANGLE_RECIPE },
      },
      {
        type: 'geometry.edit',
        resourceId: '$editable',
        edits: [
          { type: 'move', vertexIndices: [1], offset: [1, 0, 0] },
          { type: 'scale', vertexIndices: [1], scale: 0.5, pivot: [0, 0, 0] },
          { type: 'recalculateNormals' },
        ],
      },
    ],
  }));

  const geometry = kernel.document.resources.geometries['geometry/aliased'];
  assert.equal(result.revision, 1);
  assert.equal(result.resolvedIds.$editable, 'geometry/aliased');
  assert.deepEqual(result.invalidations, ['geometries', 'geometry', 'persistence', 'renderer', 'rtxTopology']);
  assert.equal(geometry.kind, 'geometry');
  assert.equal(geometry.recipe.kind, 'indexedMesh');
  assert.deepEqual(geometry.recipe.positions, [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual(geometry.recipe.normals, [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  assert.deepEqual(geometry.recipe.uvs, TRIANGLE_RECIPE.uvs);
  assert.deepEqual(kernel.history({ includeOperations: true })[0].forwardOperations[1], {
    type: 'geometry.edit',
    resourceId: 'geometry/aliased',
    edits: [
      { type: 'move', vertexIndices: [1], offset: [1, 0, 0] },
      { type: 'scale', vertexIndices: [1], scale: 0.5, pivot: [0, 0, 0] },
      { type: 'recalculateNormals' },
    ],
  });
});

test('resource create and patch reject malformed indexed topology before commit', async () => {
  const kernel = new AuthoringKernel(createProjectDocument({
    projectId: 'project/geometry-edit',
    timestamp: '2026-08-29T00:00:00.000Z',
  }));
  await assert.rejects(kernel.apply(applyRequest({
    idempotencyKey: 'geometry-create-invalid-0001',
    operations: [{
      type: 'resource.create',
      resourceType: 'geometry',
      resource: {
        id: 'geometry/invalid',
        recipe: {
          kind: 'indexedMesh',
          positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          indices: [0, 1, 9],
        },
      },
    }],
  })), error => error.code === 'invalid_geometry_resource');
  assert.equal(kernel.revision, 0);

  await kernel.apply(applyRequest({
    idempotencyKey: 'geometry-create-valid-0001',
    operations: [{
      type: 'resource.create',
      resourceType: 'geometry',
      resource: { id: 'geometry/valid', recipe: TRIANGLE_RECIPE },
    }],
  }));
  await assert.rejects(kernel.apply(applyRequest({
    baseRevision: 1,
    idempotencyKey: 'geometry-patch-invalid-0001',
    operations: [{
      type: 'resource.patch',
      resourceType: 'geometry',
      resourceId: 'geometry/valid',
      patch: { recipe: { uvs: [0, 0] } },
    }],
  })), error => error.code === 'invalid_geometry_resource');
  assert.equal(kernel.revision, 1);
});

test('geometry.edit supports dry-run, idempotency, undo, and redo through resource history', async () => {
  const kernel = kernelWithGeometry();
  const original = structuredClone(kernel.document.resources.geometries['geometry/editable']);
  const request = applyRequest({ dryRun: true });
  const dryRun = await kernel.apply(request);
  assert.equal(dryRun.dryRun, true);
  assert.equal(kernel.revision, 0);
  assert.deepEqual(kernel.document.resources.geometries['geometry/editable'], original);

  const committedRequest = { ...request, dryRun: false };
  const committed = await kernel.apply(committedRequest);
  const repeated = await kernel.apply(committedRequest);
  assert.deepEqual(repeated, committed);
  assert.equal(kernel.revision, 1);
  assert.deepEqual(
    kernel.document.resources.geometries['geometry/editable'].recipe.positions,
    [0, 0, 0, 2, 0, 0, 0, 1, 0],
  );

  await kernel.undo({
    baseRevision: 1,
    idempotencyKey: 'geometry-edit-undo-0001',
    label: 'Undo indexed geometry edit',
  });
  assert.deepEqual(kernel.document.resources.geometries['geometry/editable'], original);

  await kernel.redo({
    baseRevision: 2,
    idempotencyKey: 'geometry-edit-redo-0001',
    label: 'Redo indexed geometry edit',
  });
  assert.deepEqual(
    kernel.document.resources.geometries['geometry/editable'].recipe.positions,
    [0, 0, 0, 2, 0, 0, 0, 1, 0],
  );
});

test('geometry.edit canonicalizes a direct explicit type and rejects invalid targets and commands atomically', async () => {
  const direct = kernelWithGeometry({
    id: 'geometry/editable',
    type: 'explicit',
    positions: TRIANGLE_RECIPE.positions,
    indices: TRIANGLE_RECIPE.indices,
    uvs: TRIANGLE_RECIPE.uvs,
  });
  await direct.apply(applyRequest());
  assert.equal(direct.document.resources.geometries['geometry/editable'].recipe.kind, 'indexedMesh');
  assert.deepEqual(direct.document.resources.geometries['geometry/editable'].recipe.uvs, TRIANGLE_RECIPE.uvs);

  const procedural = kernelWithGeometry({ id: 'geometry/editable', recipe: { kind: 'box' } });
  await assert.rejects(
    procedural.apply(applyRequest()),
    error => error.code === 'invalid_geometry_edit_target',
  );
  assert.equal(procedural.revision, 0);

  const strict = kernelWithGeometry();
  await assert.rejects(strict.apply(applyRequest({
    operations: [{
      type: 'geometry.edit',
      resourceId: 'geometry/editable',
      edits: [{ type: 'move', vertexIndices: [0], offset: [1, 0, 0], typo: true }],
    }],
  })), error => error.code === 'unknown_property');
  assert.equal(strict.revision, 0);

  await assert.rejects(strict.apply(applyRequest({
    idempotencyKey: 'geometry-edit-bad-index',
    operations: [{
      type: 'geometry.edit',
      resourceId: 'geometry/editable',
      edits: [{ type: 'move', vertexIndices: [3], offset: [1, 0, 0] }],
    }],
  })), error => error.code === 'invalid_geometry_edit');
  assert.equal(strict.revision, 0);

  await assert.rejects(strict.apply(applyRequest({
    idempotencyKey: 'geometry-edit-ambiguous-selection',
    operations: [{
      type: 'geometry.edit',
      resourceId: 'geometry/editable',
      edits: [{ type: 'move', vertexIndices: [0], selection: 'all', offset: [1, 0, 0] }],
    }],
  })), error => error.code === 'invalid_geometry_edit');
  assert.equal(strict.revision, 0);

  await assert.rejects(strict.apply(applyRequest({
    idempotencyKey: 'geometry-edit-too-many',
    operations: [{
      type: 'geometry.edit',
      resourceId: 'geometry/editable',
      edits: Array.from({ length: MAX_GEOMETRY_EDIT_COMMANDS + 1 }, () => ({ type: 'triangulate' })),
    }],
  })), error => error.code === 'geometry_edit_limit');
  assert.equal(strict.revision, 0);
});

test('geometry.edit preserves direct indexed triangle material slots during canonicalization', async () => {
  const kernel = kernelWithGeometry({
    id: 'geometry/editable',
    type: 'indexedMesh',
    positions: TRIANGLE_RECIPE.positions,
    indices: TRIANGLE_RECIPE.indices,
    triangleMaterialIndices: [7],
  });
  await kernel.apply(applyRequest());
  assert.deepEqual(
    kernel.document.resources.geometries['geometry/editable'].recipe.triangleMaterialIndices,
    [7],
  );
});

test('MCP geometry.edit exposes every strict bounded command shape', () => {
  const edits = [
    { type: 'move', selection: 'all', offset: [1, 2, 3] },
    { type: 'scale', vertexIndices: [0, 1], scale: [2, 1, 0.5] },
    { type: 'rotate', vertexIndices: [1], rotation: [0, Math.PI / 2, 0], pivot: [0, 0, 0] },
    { type: 'rotate', vertexIndices: [2], axis: [0, 1, 0], angle: Math.PI },
    { type: 'smooth', iterations: 3, factor: 0.25, preserveBoundary: true },
    { type: 'recalculateNormals' },
    { type: 'weld', tolerance: 1e-5 },
    { type: 'triangulate' },
    { type: 'subdivideFaces', faceIndices: [0] },
    { type: 'insetFaces', selection: 'all', factor: 0.2 },
    { type: 'extrudeFaces', faceIndices: [0], mode: 'individual', distance: 0.25, sideMaterialIndex: 1 },
    { type: 'bevelEdges', edges: [[0, 1]], factor: 0.1, materialIndex: 2 },
    { type: 'deleteFaces', faceIndices: [1] },
    { type: 'mergeVertices', vertexIndices: [0, 1], targetVertexIndex: 0, position: 'average' },
  ];
  assert.equal(applySchema.safeParse(mcpRequest(edits, 'a'.repeat(64))).success, true);
  assert.deepEqual(GEOMETRY_EDIT_COMMAND_TYPES, [
    'move', 'scale', 'rotate', 'smooth', 'recalculateNormals', 'weld', 'triangulate',
    'subdivideFaces', 'insetFaces', 'extrudeFaces', 'bevelEdges', 'deleteFaces', 'mergeVertices',
  ]);

  const parseEdit = edit => applySchema.safeParse(mcpRequest([edit])).success;
  assert.equal(parseEdit({ type: 'move', vertexIndices: [0, 0], offset: [1, 0, 0] }), false);
  assert.equal(parseEdit({ type: 'move', selection: 'all', vertexIndices: [0], offset: [1, 0, 0] }), false);
  assert.equal(parseEdit({ type: 'move', selection: 'visible', offset: [1, 0, 0] }), false);
  assert.equal(parseEdit({ type: 'move', vertexIndices: [1_000_000], offset: [1, 0, 0] }), false);
  assert.equal(parseEdit({ type: 'move', vertexIndices: [0], offset: [1_000_001, 0, 0] }), false);
  assert.equal(parseEdit({ type: 'rotate', vertexIndices: [0], rotation: [0, 0, 1], axis: [0, 0, 1], angle: 1 }), false);
  assert.equal(parseEdit({ type: 'rotate', vertexIndices: [0], axis: [0, 0, 0], angle: 1 }), false);
  assert.equal(parseEdit({ type: 'smooth', factor: 1.1 }), false);
  assert.equal(parseEdit({ type: 'weld', tolerance: 1e-10 }), false);
  assert.equal(parseEdit({ type: 'triangulate', typo: true }), false);
  assert.equal(parseEdit({ type: 'subdivideFaces', faceIndices: [0], selection: 'all' }), false);
  assert.equal(parseEdit({ type: 'insetFaces', faceIndices: [0], factor: 1 }), false);
  assert.equal(parseEdit({ type: 'extrudeFaces', faceIndices: [0], offset: [0, 1, 0], distance: 1 }), false);
  assert.equal(parseEdit({ type: 'bevelEdges', edges: [[0, 0]], factor: 0.1 }), false);
  assert.equal(parseEdit({ type: 'deleteFaces' }), false);
  assert.equal(parseEdit({ type: 'mergeVertices', vertexIndices: [0, 1], position: 'centroid' }), false);
  assert.equal(applySchema.safeParse(mcpRequest([{ type: 'subdivideFaces', faceIndices: [0] }], 'bad')).success, false);
  assert.equal(applySchema.safeParse(mcpRequest([])).success, false);
  assert.equal(applySchema.safeParse(mcpRequest(
    Array.from({ length: MAX_GEOMETRY_EDIT_COMMANDS + 1 }, () => ({ type: 'triangulate' })),
  )).success, false);
  assert.equal(MAX_GEOMETRY_EDIT_VERTEX_SELECTION, 20_000);
});

test('checked-in geometry.edit schema mirrors MCP command names and bounds', async () => {
  const contract = JSON.parse(await readFile(new URL('../schemas/tools-v1.schema.json', import.meta.url), 'utf8'));
  const editSchemas = contract.$defs.geometryEditCommand.oneOf;
  assert.deepEqual([...new Set(editSchemas.map(schema => schema.properties.type.const))], GEOMETRY_EDIT_COMMAND_TYPES);
  assert.equal(contract.$defs.geometryVertexIndices.maxItems, MAX_GEOMETRY_EDIT_VERTEX_SELECTION);
  assert.equal(contract.$defs.geometryVertexIndices.uniqueItems, true);
  assert.equal(contract.$defs.operation.properties.edits.maxItems, MAX_GEOMETRY_EDIT_COMMANDS);
  assert.deepEqual(contract.$defs.operation.allOf.at(-1).then.propertyNames.enum, ['op', 'resourceId', 'edits', 'expectedTopologyHash']);
  assert.equal(editSchemas.every(schema => schema.additionalProperties === false), true);
});
