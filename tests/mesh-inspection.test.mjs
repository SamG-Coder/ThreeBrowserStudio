import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMeshElements, buildMeshSelection, contentHash } from '../src/core/index.mjs';

const resource = {
  id: 'geometry/quad',
  kind: 'geometry',
  name: 'Quad',
  recipe: {
    kind: 'indexedMesh',
    positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
    indices: [0, 1, 2, 0, 2, 3],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  },
};

test('mesh inspection pages exact vertices with adjacency and stable guards', () => {
  const first = buildMeshElements(resource, { element: 'vertices', limit: 2 });
  assert.equal(first.resourceHash, contentHash(resource));
  assert.equal(first.vertexCount, 4);
  assert.equal(first.triangleCount, 2);
  assert.equal(first.total, 4);
  assert.equal(first.nextCursor, `${first.resourceHash}.${first.topologyHash}.vertices.2`);
  assert.deepEqual(first.elements[0], {
    index: 0,
    position: [0, 0, 0],
    normal: [0, 0, 1],
    uv: [0, 0],
    adjacentVertexCount: 3,
    adjacentVertices: [1, 2, 3],
    incidentFaceCount: 2,
    incidentFaces: [0, 1],
    boundary: true,
    truncatedAdjacency: false,
  });
  const second = buildMeshElements(resource, { element: 'vertices', cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(second.elements.map(item => item.index), [2, 3]);
  assert.equal(second.topologyHash, first.topologyHash);
  assert.equal(second.nextCursor, null);
});

test('mesh inspection exposes unique edges, face corners, and exact corner attributes', () => {
  const edges = buildMeshElements(resource, { element: 'edges', limit: 20 });
  assert.equal(edges.edgeCount, 5);
  assert.equal(edges.elements.filter(edge => edge.boundary).length, 4);
  assert.deepEqual(edges.elements.find(edge => edge.vertices.join(':') === '0:2').incidentFaces, [0, 1]);
  const faces = buildMeshElements(resource, { element: 'faces', limit: 1 });
  assert.deepEqual(faces.elements[0].vertices, [0, 1, 2]);
  assert.deepEqual(faces.elements[0].corners[2].uv, [1, 1]);
  const firstCorners = buildMeshElements(resource, { element: 'corners', limit: 4 });
  const corners = buildMeshElements(resource, { element: 'corners', cursor: firstCorners.nextCursor, limit: 2 });
  assert.deepEqual(corners.elements.map(item => [item.faceIndex, item.faceCorner, item.vertexIndex]), [
    [1, 1, 2], [1, 2, 3],
  ]);
});

test('indexed face inspection exposes exact triangle material slots', () => {
  const resource = {
    id: 'geometry/material-slots',
    recipe: {
      kind: 'indexedMesh',
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      triangleMaterialIndices: [7],
    },
  };
  const page = buildMeshElements(resource, { element: 'faces', limit: 10 });
  assert.equal(page.elements[0].materialIndex, 7);
  assert.deepEqual(page.attributes.triangleMaterialIndex, { itemSize: 1, count: 1, domain: 'face' });
});

test('mesh inspection obeys a total response byte budget', () => {
  const page = buildMeshElements(resource, {
    element: 'faces',
    limit: 2,
    responseByteBudget: 850,
  });
  assert.ok(new TextEncoder().encode(JSON.stringify(page)).byteLength <= 850);
  assert.equal(page.truncatedByByteBudget, true);
  assert.equal(page.nextCursor, `${page.resourceHash}.${page.topologyHash}.faces.${page.elements.length}`);
});

test('mesh cursors are exact guards and cannot cross a mesh edit', () => {
  const first = buildMeshElements(resource, { element: 'vertices', limit: 1 });
  const edited = structuredClone(resource);
  edited.recipe.positions[0] = 0.25;
  assert.throws(
    () => buildMeshElements(edited, { element: 'vertices', cursor: first.nextCursor, limit: 1 }),
    error => error?.code === 'inspect_cursor_stale',
  );
  assert.throws(
    () => buildMeshElements(resource, { element: 'vertices', cursor: 'not-a-cursor', limit: 1 }),
    error => error?.code === 'inspect_cursor_invalid',
  );
  assert.throws(
    () => buildMeshElements(resource, { element: 'faces', cursor: first.nextCursor, limit: 1 }),
    error => error?.code === 'inspect_cursor_mismatch',
  );
});

test('direct legacy indexed and explicit resources remain exactly inspectable', () => {
  for (const type of ['indexedMesh', 'explicit']) {
    const direct = {
      id: `geometry/direct-${type}`,
      kind: 'geometry',
      type,
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      triangleMaterialIndices: [3],
    };
    const page = buildMeshElements(direct, { element: 'faces' });
    assert.equal(page.recipeKind, type);
    assert.equal(page.elements[0].materialIndex, 3);
  }
});

function gridResource() {
  const positions = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) positions.push(x, y, 0);
  }
  const indices = [
    0, 1, 4, 0, 4, 3,
    1, 2, 5, 1, 5, 4,
    3, 4, 7, 3, 7, 6,
    4, 5, 8, 4, 8, 7,
  ];
  return {
    id: 'geometry/grid',
    kind: 'geometry',
    recipe: { kind: 'indexedMesh', positions, indices },
  };
}

test('mesh filters page interiors without walking the whole mesh and guard the cursor', () => {
  const resource = gridResource();
  const interior = buildMeshElements(resource, {
    element: 'vertices',
    meshFilter: { yMin: 0.5, yMax: 1.5, boundary: false },
    limit: 10,
  });
  assert.deepEqual(interior.elements.map(item => item.index), [4]);
  assert.equal(interior.matchedCount, 1);
  assert.equal(interior.nextCursor, null);
  assert.match(interior.filterHash, /^[a-f0-9]{64}$/);

  const high = buildMeshElements(resource, {
    element: 'vertices',
    meshFilter: { yMin: 1.5 },
    limit: 1,
  });
  assert.deepEqual(high.elements.map(item => item.index), [6]);
  assert.match(high.nextCursor, new RegExp(`^${high.resourceHash}\\.${high.topologyHash}\\.vertices\\.${high.filterHash}\\.1$`));
  const highNext = buildMeshElements(resource, {
    element: 'vertices',
    meshFilter: { yMin: 1.5 },
    cursor: high.nextCursor,
    limit: 10,
  });
  assert.deepEqual(highNext.elements.map(item => item.index), [7, 8]);

  const isolated = buildMeshElements(resource, {
    element: 'vertices',
    meshFilter: { notAdjacentTo: [0] },
  });
  assert.ok(!isolated.elements.some(item => [0, 1, 3, 4].includes(item.index)));
  assert.deepEqual(isolated.elements.map(item => item.index), [2, 5, 6, 7, 8]);

  const first = buildMeshElements(resource, { element: 'vertices', meshFilter: { yMin: 1.5 }, limit: 1 });
  assert.throws(
    () => buildMeshElements(resource, { element: 'vertices', cursor: first.nextCursor, limit: 1 }),
    error => error?.code === 'inspect_cursor_mismatch',
  );
  assert.throws(
    () => buildMeshElements(resource, {
      element: 'vertices',
      meshFilter: { yMin: 0 },
      cursor: first.nextCursor,
      limit: 1,
    }),
    error => error?.code === 'inspect_cursor_mismatch',
  );
});

test('mesh selection returns compact exact indices for spatial, normal, and material criteria', () => {
  const selected = buildMeshSelection({
    ...resource,
    recipe: { ...resource.recipe, triangleMaterialIndices: [2, 5] },
  }, {
    element: 'faces',
    meshFilter: {
      center: [0.25, 0.25, 0],
      radius: 0.75,
      normal: [0, 0, 1],
      minNormalDot: 0.99,
      materialIndex: 2,
    },
  });
  assert.deepEqual(selected.indices, [0]);
  assert.equal(selected.matchedCount, 1);
  assert.match(selected.selectionHash, /^[a-f0-9]{64}$/u);
  assert.notEqual(selected.selectionHash, buildMeshSelection(resource, {
    element: 'faces', meshFilter: { materialIndex: 0 },
  }).selectionHash);
});

test('mesh inspection rejects procedural recipes instead of inspecting compiled approximations', () => {
  assert.throws(
    () => buildMeshElements({ id: 'geometry/sphere', recipe: { kind: 'sphere' } }),
    error => error?.code === 'mesh_elements_unavailable',
  );
});
