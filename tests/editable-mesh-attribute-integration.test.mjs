import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AuthoringKernel,
  EDITABLE_MESH_ATTRIBUTE_LIMITS,
  createProjectDocument,
  editableMeshTopologyHash,
} from '../src/core/index.mjs';
import { applySchema } from '../src/mcp/index.mjs';

function editableQuad() {
  return {
    kind: 'editableMesh',
    positions: [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0],
    faceOffsets: [0, 4],
    cornerVertexIndices: [0, 1, 2, 3],
    uvLayers: { UVMap: [0, 0, 1, 0, 1, 1, 0, 1] },
    colorLayers: { Color: new Array(16).fill(0.5) },
    faceMaterialIndices: [3],
    sharpEdges: [[0, 1]],
    edgeCreases: [[2, 3, 0.75]],
  };
}

function request(projectId, baseRevision, idempotencyKey, edits, expectedTopologyHash) {
  return {
    protocolVersion: 'three-studio/1',
    projectId,
    baseRevision,
    idempotencyKey,
    label: 'Edit exact mesh attributes',
    operations: [{
      type: 'geometry.edit',
      resourceId: 'geometry/quad',
      edits,
      expectedTopologyHash,
    }],
  };
}

function mcpRequest(edits) {
  return {
    protocolVersion: 'three-studio/1',
    sessionId: 'live-session',
    projectId: 'project/editable-attributes',
    baseRevision: 0,
    idempotencyKey: 'editable-attribute-schema-0001',
    label: 'Edit exact mesh attributes',
    operations: [{
      op: 'geometry.edit',
      resourceId: 'geometry/quad',
      edits,
      expectedTopologyHash: 'a'.repeat(64),
    }],
  };
}

test('kernel composes UV, color, material, sharp-edge, and crease edits without changing topology', async () => {
  const projectId = 'project/editable-attributes';
  const source = editableQuad();
  const topologyHash = editableMeshTopologyHash(source);
  const kernel = new AuthoringKernel(createProjectDocument({
    projectId,
    resources: { geometries: [{ id: 'geometry/quad', recipe: source }] },
  }));
  const edits = [
    { type: 'createUvLayer', name: 'Detail', fill: [0, 0], setActive: true },
    { type: 'projectUvs', layer: 'Detail', cornerIndices: 'all', axis: 'xy', scale: [0.5, 0.25], offset: [0.1, 0.2] },
    { type: 'setCornerUvs', layer: 'Detail', cornerIndices: [0], values: [-1, -1] },
    { type: 'transformUvs', layer: 'Detail', cornerIndices: [1, 2], translation: [0.5, 0.5] },
    { type: 'createColorLayer', name: 'Mask', fill: [0.1, 0.2, 0.3, 1], setActive: true },
    {
      type: 'setCornerColors', layer: 'Mask', cornerIndices: [1, 3],
      values: [1, 0, 0, 1, 0, 1, 0, 1],
    },
    { type: 'assignFaceMaterials', faceIndices: 'all', materialIndex: 7 },
    { type: 'setSharpEdges', edges: 'all', sharp: true },
    { type: 'setEdgeCreases', edges: 'all', weight: 0.4 },
    { type: 'removeEdgeCreases', edges: [[0, 1]] },
  ];

  const result = await kernel.apply(request(
    projectId, 0, 'editable-attribute-apply-0001', edits, topologyHash,
  ));
  const recipe = kernel.document.resources.geometries['geometry/quad'].recipe;
  assert.equal(result.revision, 1);
  assert.equal(editableMeshTopologyHash(recipe), topologyHash);
  assert.equal(recipe.activeUvLayer, 'Detail');
  assert.deepEqual(recipe.uvLayers.Detail, [-1, -1, 1.6, 0.7, 1.6, 1.2, 0.1, 0.7]);
  assert.equal(recipe.activeColorLayer, 'Mask');
  assert.deepEqual(recipe.colorLayers.Mask, [
    0.1, 0.2, 0.3, 1,
    1, 0, 0, 1,
    0.1, 0.2, 0.3, 1,
    0, 1, 0, 1,
  ]);
  assert.deepEqual(recipe.faceMaterialIndices, [7]);
  assert.deepEqual(recipe.sharpEdges, [[0, 1], [0, 3], [1, 2], [2, 3]]);
  assert.deepEqual(recipe.edgeCreases, [[0, 3, 0.4], [1, 2, 0.4], [2, 3, 0.4]]);
  assert.deepEqual(result.invalidations, ['geometry', 'persistence', 'renderer', 'rtxTopology']);

  await kernel.undo({
    baseRevision: 1,
    idempotencyKey: 'editable-attribute-undo-0001',
    label: 'Undo exact mesh attributes',
  });
  assert.deepEqual(kernel.document.resources.geometries['geometry/quad'].recipe, {
    ...source,
    activeUvLayer: 'UVMap',
    activeColorLayer: 'Color',
  });
  await kernel.redo({
    baseRevision: 2,
    idempotencyKey: 'editable-attribute-redo-0001',
    label: 'Redo exact mesh attributes',
  });
  assert.deepEqual(kernel.document.resources.geometries['geometry/quad'].recipe.uvLayers.Detail, recipe.uvLayers.Detail);
});

test('kernel rejects stale topology and mismatched all-selection values atomically', async () => {
  const projectId = 'project/editable-attribute-errors';
  const source = editableQuad();
  const kernel = new AuthoringKernel(createProjectDocument({
    projectId,
    resources: { geometries: [{ id: 'geometry/quad', recipe: source }] },
  }));
  await assert.rejects(kernel.apply(request(
    projectId,
    0,
    'editable-attribute-stale-0001',
    [{ type: 'setCornerUvs', layer: 'UVMap', cornerIndices: 'all', values: [0, 0] }],
    '0'.repeat(64),
  )), error => error?.code === 'geometry_topology_changed');
  await assert.rejects(kernel.apply(request(
    projectId,
    0,
    'editable-attribute-length-0001',
    [{ type: 'setCornerUvs', layer: 'UVMap', cornerIndices: 'all', values: [0, 0] }],
    editableMeshTopologyHash(source),
  )), error => error?.code === 'invalid_geometry_edit' && error.details.editIndex === 0);
  assert.equal(kernel.revision, 0);
  assert.equal(Object.hasOwn(kernel.document.resources.geometries['geometry/quad'].recipe.uvLayers, 'Detail'), false);
});

test('MCP schema accepts every bounded editable attribute command and compact all selections', () => {
  const edits = [
    { type: 'createUvLayer', name: 'Lightmap', fill: [0, 0], setActive: true },
    { type: 'renameUvLayer', name: 'Lightmap', newName: 'Lightmap2' },
    { type: 'setActiveUvLayer', name: 'Lightmap2' },
    { type: 'setCornerUvs', layer: 'Lightmap2', cornerIndices: [0, 3_999_999], values: [0, 0, 1, 1] },
    { type: 'transformUvs', layer: 'Lightmap2', cornerIndices: 'all', rotation: 0.5, pivot: [0.5, 0.5] },
    { type: 'projectUvs', layer: 'Lightmap2', cornerIndices: 'all', axis: 'xz', scale: 0.5 },
    { type: 'deleteUvLayer', name: 'Lightmap2', nextActiveLayer: null },
    { type: 'createColorLayer', name: 'Mask', values: [1, 0, 0, 1] },
    { type: 'renameColorLayer', name: 'Mask', newName: 'Mask2' },
    { type: 'setActiveColorLayer', name: null },
    { type: 'setCornerColors', layer: 'Mask2', cornerIndices: [0], values: [0, 1, 0, 1] },
    { type: 'deleteColorLayer', name: 'Mask2', nextActiveLayer: null },
    { type: 'assignFaceMaterials', faceIndices: 'all', materialIndex: 4 },
    { type: 'assignFaceMaterials', faceIndices: [0, 1], materialIndices: [4, 5] },
    { type: 'setSharpEdges', edges: 'all', sharp: true },
    { type: 'setEdgeCreases', edges: [[0, 1]], weight: 0.75 },
    { type: 'removeEdgeCreases', edges: 'all' },
  ];
  const parsed = applySchema.safeParse(mcpRequest(edits));
  assert.equal(parsed.success, true, parsed.error?.message);
  assert.equal(EDITABLE_MESH_ATTRIBUTE_LIMITS.maxCorners, 4_000_000);
});

test('MCP schema rejects ambiguous values, unknown fields, malformed selections, and pivot-only transforms', () => {
  const parses = edit => applySchema.safeParse(mcpRequest([edit])).success;
  assert.equal(parses({
    type: 'createUvLayer', name: 'UV', fill: [0, 0], values: [0, 0],
  }), false);
  assert.equal(parses({
    type: 'setCornerUvs', layer: 'UV', cornerIndices: [0, 1], values: [0, 0],
  }), false);
  assert.equal(parses({
    type: 'setCornerColors', layer: 'Color', cornerIndices: [0], values: [1, 1, 1, 1, 1, 1, 1, 1],
  }), false);
  assert.equal(parses({
    type: 'transformUvs', layer: 'UV', cornerIndices: 'all', pivot: [0.5, 0.5],
  }), false);
  assert.equal(parses({
    type: 'assignFaceMaterials', faceIndices: [0], materialIndex: 1, materialIndices: [1],
  }), false);
  assert.equal(parses({
    type: 'assignFaceMaterials', faceIndices: [0, 1], materialIndices: [1],
  }), false);
  assert.equal(parses({ type: 'setSharpEdges', edges: [[0, 0]], sharp: true }), false);
  assert.equal(parses({ type: 'setEdgeCreases', edges: 'all', weight: 1.1 }), false);
  assert.equal(parses({ type: 'removeEdgeCreases', edges: [], typo: true }), false);
  assert.equal(parses({
    type: 'setCornerUvs', layer: 'UV', cornerIndices: [EDITABLE_MESH_ATTRIBUTE_LIMITS.maxCorners], values: [0, 0],
  }), false);
});
