import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AuthoringKernel,
  buildMeshElements,
  createProjectDocument,
  createResourceDocument,
  editableMeshTopologyHash,
} from '../src/core/index.mjs';

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

test('geometry resources canonicalize direct and parameters editable meshes into one recipe envelope', () => {
  const direct = createResourceDocument('geometry', {
    id: 'geometry/direct-editable',
    type: 'editableMesh',
    ...editableQuad(),
  });
  assert.equal(direct.kind, 'geometry');
  assert.equal(direct.type, undefined);
  assert.equal(direct.recipe.kind, 'editableMesh');
  assert.equal(direct.recipe.activeUvLayer, 'UVMap');
  assert.equal(direct.recipe.activeColorLayer, 'Color');
  assert.equal(direct.positions, undefined);

  const parameters = createResourceDocument('geometries', {
    id: 'geometry/parameter-editable',
    parameters: editableQuad(),
  });
  assert.equal(parameters.parameters, undefined);
  assert.deepEqual(parameters.recipe, direct.recipe);

  const ambiguous = editableQuad();
  ambiguous.uvLayers = { A: ambiguous.uvLayers.UVMap, B: ambiguous.uvLayers.UVMap };
  assert.throws(
    () => createResourceDocument('geometry', { id: 'geometry/ambiguous', recipe: ambiguous }),
    error => error?.code === 'invalid_geometry_resource' && /activeUvLayer is required/.test(error.message),
  );
});

test('geometry.edit requires and honors one exact topology guard for an ordered editable batch', async () => {
  const recipe = editableQuad();
  const topologyHash = editableMeshTopologyHash(recipe);
  const kernel = new AuthoringKernel(createProjectDocument({
    projectId: 'project/editable-integration',
    timestamp: '2026-08-29T00:00:00.000Z',
    resources: { geometries: [{ id: 'geometry/quad', recipe }] },
  }));
  const request = (idempotencyKey, expectedTopologyHash) => ({
    protocolVersion: 'three-studio/1',
    projectId: 'project/editable-integration',
    baseRevision: 0,
    idempotencyKey,
    label: 'Edit exact polygon topology',
    operations: [{
      type: 'geometry.edit',
      resourceId: 'geometry/quad',
      ...(expectedTopologyHash === undefined ? {} : { expectedTopologyHash }),
      edits: [
        { type: 'move', vertexIndices: [0, 1], offset: [0, 0, 0.25] },
        { type: 'insetFaces', faceIndices: [0], factor: 0.25 },
      ],
    }],
  });

  await assert.rejects(
    kernel.apply(request('editable-missing-guard', undefined)),
    error => error?.code === 'geometry_topology_guard_required',
  );
  await assert.rejects(
    kernel.apply(request('editable-malformed-guard', 'NOT-A-HASH')),
    error => error?.code === 'invalid_geometry_edit',
  );
  await assert.rejects(
    kernel.apply(request('editable-stale-guard', '0'.repeat(64))),
    error => error?.code === 'geometry_topology_changed',
  );
  const result = await kernel.apply(request('editable-correct-guard', topologyHash));
  const edited = kernel.document.resources.geometries['geometry/quad'].recipe;
  assert.equal(result.revision, 1);
  assert.equal(edited.kind, 'editableMesh');
  assert.equal(edited.faceOffsets.length - 1, 5);
  assert.equal(edited.cornerVertexIndices.length, 20);
  assert.equal(edited.activeUvLayer, 'UVMap');
  assert.notEqual(editableMeshTopologyHash(edited), topologyHash);
});

test('meshElements inspects authored polygons, face corners, annotations, and material slots exactly', () => {
  const resource = createResourceDocument('geometry', {
    id: 'geometry/inspect-editable',
    recipe: editableQuad(),
  });
  const facePage = buildMeshElements(resource, { element: 'faces', limit: 10 });
  assert.equal(facePage.recipeKind, 'editableMesh');
  assert.equal(facePage.topologyKind, 'polygons');
  assert.equal(facePage.faceCount, 1);
  assert.equal(facePage.cornerCount, 4);
  assert.equal(facePage.activeUvLayer, 'UVMap');
  assert.deepEqual(facePage.elements[0].vertices, [0, 1, 2, 3]);
  assert.equal(facePage.elements[0].materialIndex, 3);
  assert.deepEqual(facePage.elements[0].corners[2].uvLayers.UVMap, [1, 1]);
  assert.deepEqual(facePage.elements[0].corners[2].colorLayers.Color, [0.5, 0.5, 0.5, 0.5]);

  const edgePage = buildMeshElements(resource, { element: 'edges', limit: 10 });
  assert.equal(edgePage.edgeCount, 4);
  assert.equal(edgePage.elements.find(edge => edge.vertices.join(':') === '0:1').sharp, true);
  assert.equal(edgePage.elements.find(edge => edge.vertices.join(':') === '2:3').crease, 0.75);
  assert.equal(edgePage.elements.every(edge => edge.boundary), true);

  const corners = buildMeshElements(resource, { element: 'corners', limit: 10 });
  assert.deepEqual(corners.elements.map(corner => corner.faceCorner), [0, 1, 2, 3]);
  assert.equal(corners.topologyHash, editableMeshTopologyHash(resource.recipe));
});
