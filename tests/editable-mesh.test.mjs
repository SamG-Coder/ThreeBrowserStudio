import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyEditableMeshEdit,
  applyEditableMeshEdits,
  bevelEditableMeshEdges,
  deleteEditableMeshFaces,
  editableMeshTopologyHash,
  extrudeEditableMeshFaces,
  insetEditableMeshFaces,
  mergeEditableMeshVertices,
  normalizeEditableMeshRecipe,
  proportionalMoveEditableMeshVertices,
  smoothEditableMeshVertices,
  subdivideEditableMeshFaces,
  triangulateEditableMesh,
} from '../src/core/editable-mesh.mjs';

test('editable mesh proportional move supports compact smooth influence fields', () => {
  const result = proportionalMoveEditableMeshVertices(quad(), {
    center: [0, 0, 0], radius: 2.1, offset: [0, 0, 2], falloff: 'smooth',
  });
  assert.equal(result.positions[2], 2);
  assert.ok(result.positions[5] > 0 && result.positions[5] < 2);
});

function quad() {
  return {
    kind: 'editableMesh',
    positions: [
      0, 0, 0,
      2, 0, 0,
      2, 2, 0,
      0, 2, 0,
    ],
    faceOffsets: [0, 4],
    cornerVertexIndices: [0, 1, 2, 3],
    uvLayers: {
      UVMap: [0, 0, 1, 0, 1, 1, 0, 1],
    },
    colorLayers: {
      Color: [
        1, 0, 0, 1,
        0, 1, 0, 1,
        0, 0, 1, 1,
        1, 1, 1, 1,
      ],
    },
    faceMaterialIndices: [2],
    sharpEdges: [[1, 0]],
    edgeCreases: [[2, 3, 0.75]],
  };
}

function assertClose(actual, expected, epsilon = 1e-12) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) <= epsilon, `${value} != ${expected[index]} at ${index}`);
  });
}

test('normalizeEditableMeshRecipe canonicalizes optional fields, layers, and edge order', () => {
  const source = quad();
  source.uvLayers = { z: source.uvLayers.UVMap, a: source.uvLayers.UVMap };
  source.activeUvLayer = 'a';
  const result = normalizeEditableMeshRecipe(source);

  assert.deepEqual(Object.keys(result.uvLayers), ['a', 'z']);
  assert.equal(result.activeUvLayer, 'a');
  assert.equal(result.activeColorLayer, 'Color');
  assert.deepEqual(result.sharpEdges, [[0, 1]]);
  assert.deepEqual(result.edgeCreases, [[2, 3, 0.75]]);
  assert.deepEqual(normalizeEditableMeshRecipe({
    kind: 'editableMesh',
    positions: [],
    faceOffsets: [0],
    cornerVertexIndices: [],
  }), {
    kind: 'editableMesh',
    positions: [],
    faceOffsets: [0],
    cornerVertexIndices: [],
    uvLayers: {},
    colorLayers: {},
    activeUvLayer: null,
    activeColorLayer: null,
    faceMaterialIndices: [],
    sharpEdges: [],
    edgeCreases: [],
  });
  assert.notEqual(result.positions, source.positions);
});

test('editable mesh validation rejects unknown fields, repeated face vertices, bad layers, and non-edges', () => {
  assert.throws(() => normalizeEditableMeshRecipe({ ...quad(), mystery: true }), /mystery is not supported/);
  assert.throws(
    () => normalizeEditableMeshRecipe({ ...quad(), cornerVertexIndices: [0, 1, 2, 1] }),
    /repeats vertex 1/,
  );
  assert.throws(
    () => normalizeEditableMeshRecipe({ ...quad(), uvLayers: { UVMap: [0, 0] } }),
    /exactly 8/,
  );
  assert.throws(
    () => normalizeEditableMeshRecipe({ ...quad(), colorLayers: { Color: new Array(16).fill(2) } }),
    /0 to 1/,
  );
  assert.throws(
    () => normalizeEditableMeshRecipe({ ...quad(), sharpEdges: [[0, 2]] }),
    /does not reference a mesh edge/,
  );
});

test('topology hashes guard connectivity without changing for positions or corner attributes', () => {
  const source = quad();
  const hash = editableMeshTopologyHash(source);
  const moved = structuredClone(source);
  moved.positions[0] = 0.25;
  moved.uvLayers.UVMap[0] = 0.5;
  assert.equal(editableMeshTopologyHash(moved), hash);

  const reversed = structuredClone(source);
  reversed.cornerVertexIndices = [0, 3, 2, 1];
  reversed.sharpEdges = [];
  reversed.edgeCreases = [];
  assert.notEqual(editableMeshTopologyHash(reversed), hash);
});

test('triangulateEditableMesh ear-clips concave n-gons and preserves seams and provenance', () => {
  const mesh = {
    kind: 'editableMesh',
    positions: [
      0, 0, 0,
      2, 0, 0,
      2, 2, 0,
      1, 1, 0,
      0, 2, 0,
    ],
    faceOffsets: [0, 5],
    cornerVertexIndices: [0, 1, 2, 3, 4],
    uvLayers: { UVMap: [0, 0, 1, 0, 1, 1, 0.5, 0.5, 0, 1] },
    colorLayers: { Color: new Array(20).fill(0.5) },
    faceMaterialIndices: [7],
  };
  const result = triangulateEditableMesh(mesh);

  assert.equal(result.recipe.kind, 'indexedMesh');
  assert.equal(result.recipe.indices.length, 9);
  assert.equal(result.recipe.positions.length, 27);
  assert.equal(result.recipe.normals.length, 27);
  assert.equal(result.recipe.uvs.length, 18);
  assert.equal(result.recipe.colors.length, 36);
  assert.deepEqual(result.triangleFaceIndices, [0, 0, 0]);
  assert.deepEqual(result.triangleMaterialIndices, [7, 7, 7]);
  assert.equal(result.sourceCornerIndices.length, 9);
  assert.equal(result.topologyHash, editableMeshTopologyHash(mesh));
});

test('triangulation emits smooth corner normals while sharp edges split smoothing islands', () => {
  const source = {
    kind: 'editableMesh',
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
    faceOffsets: [0, 3, 6],
    cornerVertexIndices: [0, 1, 2, 1, 0, 3],
  };
  const smooth = triangulateEditableMesh(source).recipe.normals;
  assert.ok(smooth[1] > 0 && smooth[2] > 0, 'shared corner blends the two face normals');
  assertClose(smooth.slice(6, 9), [0, 0, 1]);

  const sharp = triangulateEditableMesh({ ...source, sharpEdges: [[0, 1]] }).recipe.normals;
  assertClose(sharp.slice(0, 3), [0, 0, 1]);
  assertClose(sharp.slice(9, 12), [0, 1, 0]);
});

test('editable meshes bound per-face arity and triangulation work explicitly', () => {
  const cornerCount = 4_097;
  const positions = [];
  for (let index = 0; index < cornerCount; index += 1) {
    const angle = index / cornerCount * Math.PI * 2;
    positions.push(Math.cos(angle), Math.sin(angle), 0);
  }
  assert.throws(() => normalizeEditableMeshRecipe({
    kind: 'editableMesh',
    positions,
    faceOffsets: [0, cornerCount],
    cornerVertexIndices: Array.from({ length: cornerCount }, (_, index) => index),
  }), /4096-corner per-face budget/);
  assert.throws(
    () => triangulateEditableMesh(quad(), { triangulationWorkBudget: 1 }),
    /work budget/,
  );
  assert.throws(() => triangulateEditableMesh(quad(), { guessedLayer: 'UVMap' }), /guessedLayer is not supported/);
});

test('serial transform edits preserve topology and per-corner attributes without mutating input', () => {
  const source = quad();
  const snapshot = structuredClone(source);
  const result = applyEditableMeshEdits(source, [
    { type: 'moveVertices', vertexIndices: [0, 1], offset: [0, 0, 1] },
    { type: 'scaleVertices', vertexIndices: [0, 1], scale: 2 },
    { type: 'rotateVertices', vertexIndices: [0, 1], rotation: [0, 0, Math.PI / 2], pivot: [0, 0, 0] },
  ]);

  assert.deepEqual(source, snapshot);
  assertClose(result.positions.slice(0, 6), [0, -1, 1, 0, 3, 1]);
  assert.deepEqual(result.uvLayers.UVMap, source.uvLayers.UVMap);
  assert.equal(editableMeshTopologyHash(result), editableMeshTopologyHash(source));
});

test('smoothEditableMeshVertices is simultaneous and can preserve polygon boundaries', () => {
  const mesh = {
    kind: 'editableMesh',
    positions: [
      -1, -1, 0,
      1, -1, 0,
      1, 1, 0,
      -1, 1, 0,
      0.5, 0, 0,
    ],
    faceOffsets: [0, 3, 6, 9, 12],
    cornerVertexIndices: [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4],
  };
  const result = smoothEditableMeshVertices(mesh, {
    selection: 'all',
    iterations: 2,
    factor: 0.5,
    preserveBoundary: true,
  });
  assert.deepEqual(result.positions.slice(0, 12), mesh.positions.slice(0, 12));
  assertClose(result.positions.slice(12), [0.125, 0, 0]);
});

test('subdivideEditableMeshFaces adds a center fan and interpolates every corner layer', () => {
  const result = subdivideEditableMeshFaces(quad(), { faceIndices: [0] });
  assert.equal(result.positions.length / 3, 5);
  assert.deepEqual(result.faceOffsets, [0, 3, 6, 9, 12]);
  assert.deepEqual(result.faceMaterialIndices, [2, 2, 2, 2]);
  assert.equal(result.uvLayers.UVMap.length, 24);
  assert.equal(result.colorLayers.Color.length, 48);
  assertClose(result.positions.slice(-3), [1, 1, 0]);
});

test('insetEditableMeshFaces creates one inner polygon and a ring of quads', () => {
  const result = insetEditableMeshFaces(quad(), { selection: 'all', factor: 0.25 });
  assert.equal(result.positions.length / 3, 8);
  assert.deepEqual(result.faceOffsets, [0, 4, 8, 12, 16, 20]);
  assert.deepEqual(result.faceMaterialIndices, [2, 2, 2, 2, 2]);
  assertClose(result.positions.slice(12, 15), [0.25, 0.25, 0]);
  assert.equal(result.uvLayers.UVMap.length, 40);
  assert.equal(result.colorLayers.Color.length, 80);
  assert.throws(() => insetEditableMeshFaces(quad(), { faceIndices: [0], thickness: 0.2 }), /dimensionless factor/);
});

test('extrudeEditableMeshFaces makes a top and side ring with material provenance', () => {
  const result = extrudeEditableMeshFaces(quad(), {
    faceIndices: [0],
    distance: 2,
    sideMaterialIndex: 4,
  });
  assert.equal(result.positions.length / 3, 8);
  assert.deepEqual(result.faceOffsets, [0, 4, 8, 12, 16, 20]);
  assert.deepEqual(result.faceMaterialIndices, [2, 4, 4, 4, 4]);
  assertClose(result.positions.slice(12, 15), [0, 0, 2]);
  assert.equal(result.uvLayers.UVMap.length, 40);
  assert.deepEqual(result.sharpEdges, [[0, 1], [4, 5]]);
  assert.deepEqual(result.edgeCreases, [[2, 3, 0.75], [6, 7, 0.75]]);
  assert.throws(
    () => extrudeEditableMeshFaces(quad(), { faceIndices: [0], mode: 'region' }),
    /only mode 'individual'/,
  );
});

test('deleteEditableMeshFaces removes vanished edge annotations and allows an empty intermediate mesh', () => {
  const result = deleteEditableMeshFaces(quad(), { faceIndices: [0] });
  assert.deepEqual(result.faceOffsets, [0]);
  assert.deepEqual(result.cornerVertexIndices, []);
  assert.deepEqual(result.faceMaterialIndices, []);
  assert.deepEqual(result.sharpEdges, []);
  assert.deepEqual(result.edgeCreases, []);
  assert.deepEqual(result.uvLayers, { UVMap: [] });
  assert.deepEqual(result.colorLayers, { Color: [] });
});

test('mergeEditableMeshVertices drops collapsed faces, compacts vertices, and keeps corner seams', () => {
  const mesh = {
    ...quad(),
    faceOffsets: [0, 3, 6],
    cornerVertexIndices: [0, 1, 2, 0, 2, 3],
    uvLayers: { UVMap: [0, 0, 1, 0, 1, 1, 0.25, 0.25, 1, 1, 0, 1] },
    colorLayers: { Color: new Array(24).fill(0.5) },
    faceMaterialIndices: [2, 3],
    sharpEdges: [[0, 1]],
    edgeCreases: [[2, 3, 0.75]],
  };
  const result = mergeEditableMeshVertices(mesh, { vertexIndices: [0, 1], position: 'average' });
  assert.deepEqual(result.faceOffsets, [0, 3]);
  assert.deepEqual(result.cornerVertexIndices, [0, 1, 2]);
  assert.deepEqual(result.faceMaterialIndices, [3]);
  assertClose(result.positions.slice(0, 3), [1, 0, 0]);
  assert.equal(result.uvLayers.UVMap.length, 6);
  assert.equal(result.colorLayers.Color.length, 12);
  assert.deepEqual(result.edgeCreases, [[1, 2, 0.75]]);
  assert.throws(
    () => mergeEditableMeshVertices(mesh, { vertexIndices: [0, 1], tolerance: 0.01 }),
    /exact vertexIndices set/,
  );
});

test('mergeEditableMeshVertices collapses adjacent n-gon corners without deleting the valid face', () => {
  const merged = mergeEditableMeshVertices(quad(), { vertexIndices: [0, 1], position: 'average' });
  assert.deepEqual(merged.faceOffsets, [0, 3]);
  assert.deepEqual(merged.cornerVertexIndices, [0, 1, 2]);
  assert.deepEqual(merged.faceMaterialIndices, [2]);
  assertClose(merged.positions, [1, 0, 0, 2, 2, 0, 0, 2, 0]);
  assert.deepEqual(merged.uvLayers.UVMap, [0, 0, 1, 1, 0, 1]);
  assert.deepEqual(merged.colorLayers.Color.slice(0, 4), [1, 0, 0, 1]);
  assert.deepEqual(merged.edgeCreases, [[1, 2, 0.75]]);

  const targetSecond = mergeEditableMeshVertices(quad(), {
    vertexIndices: [0, 1],
    targetVertexIndex: 1,
    position: 'target',
  });
  assert.deepEqual(targetSecond.faceOffsets, [0, 3]);
  assert.deepEqual(targetSecond.uvLayers.UVMap.slice(0, 2), [1, 0]);
  assert.deepEqual(targetSecond.colorLayers.Color.slice(0, 4), [0, 1, 0, 1]);
});

test('bevelEditableMeshEdges patches closed cube endpoint fans without cracks', () => {
  const cubeFaces = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  const mesh = {
    kind: 'editableMesh',
    positions: [
      -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
      -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
    ],
    faceOffsets: [0, 4, 8, 12, 16, 20, 24],
    cornerVertexIndices: cubeFaces.flat(),
    uvLayers: {
      UVMap: cubeFaces.flatMap(() => [0, 0, 1, 0, 1, 1, 0, 1]),
    },
    colorLayers: {
      Color: cubeFaces.flatMap((_, faceIndex) => (
        Array.from({ length: 4 }, () => [faceIndex / 5, 0.5, 1 - faceIndex / 5, 1]).flat()
      )),
    },
    faceMaterialIndices: [0, 1, 2, 3, 4, 5],
    sharpEdges: [[4, 5]],
    edgeCreases: [[4, 7, 0.6]],
  };
  const result = bevelEditableMeshEdges(mesh, { edges: [[4, 5]], factor: 0.2, materialIndex: 9 });

  assert.equal(result.positions.length / 3, 10);
  assert.equal(result.faceOffsets.length - 1, 7);
  assert.equal(result.cornerVertexIndices.length, 30);
  assert.deepEqual(result.faceMaterialIndices, [0, 1, 2, 3, 4, 5, 9]);
  assert.equal(result.uvLayers.UVMap.length, result.cornerVertexIndices.length * 2);
  assert.equal(result.colorLayers.Color.length, result.cornerVertexIndices.length * 4);
  assert.equal(result.sharpEdges.length, 2);
  assert.equal(result.edgeCreases.length, 1);

  const edgeUses = new Map();
  for (let faceIndex = 0; faceIndex < result.faceOffsets.length - 1; faceIndex += 1) {
    const start = result.faceOffsets[faceIndex];
    const end = result.faceOffsets[faceIndex + 1];
    for (let corner = start; corner < end; corner += 1) {
      const first = result.cornerVertexIndices[corner];
      const second = result.cornerVertexIndices[corner + 1 === end ? start : corner + 1];
      const key = first < second ? `${first}:${second}` : `${second}:${first}`;
      edgeUses.set(key, (edgeUses.get(key) ?? 0) + 1);
    }
  }
  assert.equal([...edgeUses.values()].filter(count => count === 1).length, 0);
  assert.equal([...edgeUses.values()].every(count => count === 2), true);

  const open = {
    kind: 'editableMesh',
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
    faceOffsets: [0, 3, 6],
    cornerVertexIndices: [0, 1, 2, 1, 0, 3],
  };
  assert.throws(
    () => bevelEditableMeshEdges(open, { edges: [[0, 1]], factor: 0.2 }),
    error => error?.code === 'bevel_endpoint_fan_unsupported',
  );
  assert.throws(() => bevelEditableMeshEdges(quad(), { edges: [[0, 1]], factor: 0.1 }), /exactly two incident faces/);
  assert.throws(() => bevelEditableMeshEdges(mesh, { edges: [[0, 1]], width: 0.1 }), /relative factor/);
});

test('generic edit dispatcher rejects unknown commands and bounds command batches', () => {
  const hash = editableMeshTopologyHash(quad());
  const guarded = applyEditableMeshEdit(quad(), {
    type: 'moveVertices',
    vertexIndices: [0],
    offset: [0, 0, 1],
    expectedTopologyHash: hash,
  });
  assert.equal(editableMeshTopologyHash(guarded), hash);
  const recalculated = applyEditableMeshEdit(quad(), { type: 'recalculateNormals' });
  assert.equal(editableMeshTopologyHash(recalculated), hash);
  assert.deepEqual(recalculated.positions, quad().positions);
  assert.throws(
    () => applyEditableMeshEdit(quad(), {
      type: 'moveVertices',
      vertexIndices: [0],
      offset: [0, 0, 1],
      expectedTopologyHash: '0'.repeat(64),
    }),
    /topology changed/,
  );
  assert.throws(() => applyEditableMeshEdit(quad(), { type: 'voxelRemesh' }), /Unsupported editable mesh edit/);
  assert.throws(() => applyEditableMeshEdits(quad(), []), /non-empty array/);
  assert.throws(
    () => applyEditableMeshEdits(quad(), new Array(257).fill({ type: 'deleteFaces', faceIndices: [0] })),
    /more than 256/,
  );
  assert.throws(
    () => triangulateEditableMesh({
      kind: 'editableMesh',
      positions: [],
      faceOffsets: [0],
      cornerVertexIndices: [],
    }),
    /cannot be compiled/,
  );
});
