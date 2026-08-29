import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EDITABLE_MESH_ATTRIBUTE_COMMAND_TYPES,
  EDITABLE_MESH_ATTRIBUTE_LIMITS,
  applyEditableMeshAttributeEdit,
  applyEditableMeshAttributeEdits,
} from '../src/core/editable-mesh-attributes.mjs';
import { editableMeshTopologyHash } from '../src/core/editable-mesh.mjs';

function seamMesh() {
  return {
    kind: 'editableMesh',
    positions: [
      0, 0, 1,
      2, 0, 2,
      2, 2, 3,
      0, 2, 4,
    ],
    faceOffsets: [0, 3, 6],
    cornerVertexIndices: [0, 1, 2, 0, 2, 3],
    uvLayers: {
      UVMap: [0, 0, 1, 0, 1, 1, 0.25, 0.25, 0.75, 0.75, 0, 1],
    },
    colorLayers: {
      Color: [
        1, 0, 0, 1,
        0, 1, 0, 1,
        0, 0, 1, 1,
        1, 1, 0, 1,
        0, 1, 1, 1,
        1, 0, 1, 1,
      ],
    },
    faceMaterialIndices: [2, 3],
    sharpEdges: [[0, 1]],
    edgeCreases: [[2, 3, 0.75]],
  };
}

function assertClose(actual, expected, epsilon = 1e-12) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) <= epsilon, `${value} != ${expected[index]} at ${index}`);
  });
}

test('attribute command catalog and limits are immutable integration contracts', () => {
  assert.equal(Object.isFrozen(EDITABLE_MESH_ATTRIBUTE_COMMAND_TYPES), true);
  assert.equal(Object.isFrozen(EDITABLE_MESH_ATTRIBUTE_LIMITS), true);
  assert.deepEqual(EDITABLE_MESH_ATTRIBUTE_COMMAND_TYPES, [
    'createUvLayer',
    'deleteUvLayer',
    'renameUvLayer',
    'setActiveUvLayer',
    'setCornerUvs',
    'transformUvs',
    'projectUvs',
    'createColorLayer',
    'deleteColorLayer',
    'renameColorLayer',
    'setActiveColorLayer',
    'setCornerColors',
    'assignFaceMaterials',
    'setSharpEdges',
    'setEdgeCreases',
    'removeEdgeCreases',
  ]);
  assert.equal(EDITABLE_MESH_ATTRIBUTE_LIMITS.maxCommands, 256);
  assert.equal(EDITABLE_MESH_ATTRIBUTE_LIMITS.maxLayersPerDomain, 32);
  assert.equal(EDITABLE_MESH_ATTRIBUTE_LIMITS.maxMaterialSlots, 256);
});

test('UV layer lifecycle preserves data, active state, topology, and source immutability', () => {
  const source = seamMesh();
  const snapshot = structuredClone(source);
  const hash = editableMeshTopologyHash(source);
  const created = applyEditableMeshAttributeEdit(source, {
    type: 'createUvLayer',
    name: 'Lightmap',
    fill: [0.25, 0.75],
    setActive: true,
    expectedTopologyHash: hash,
  });

  assert.deepEqual(source, snapshot);
  assert.equal(created.activeUvLayer, 'Lightmap');
  assert.deepEqual(created.uvLayers.Lightmap, new Array(6).fill([0.25, 0.75]).flat());
  assert.deepEqual(created.uvLayers.UVMap, source.uvLayers.UVMap);
  assert.deepEqual(created.colorLayers, source.colorLayers);
  assert.equal(editableMeshTopologyHash(created), hash);

  const renamed = applyEditableMeshAttributeEdit(created, {
    type: 'renameUvLayer',
    name: 'Lightmap',
    newName: 'Baked',
  });
  assert.equal(renamed.activeUvLayer, 'Baked');
  assert.equal(Object.hasOwn(renamed.uvLayers, 'Lightmap'), false);
  assert.deepEqual(renamed.uvLayers.Baked, created.uvLayers.Lightmap);

  assert.throws(() => applyEditableMeshAttributeEdit(renamed, {
    type: 'deleteUvLayer',
    name: 'Baked',
  }), /nextActiveLayer is required/);
  const deleted = applyEditableMeshAttributeEdit(renamed, {
    type: 'deleteUvLayer',
    name: 'Baked',
    nextActiveLayer: 'UVMap',
  });
  assert.deepEqual(Object.keys(deleted.uvLayers), ['UVMap']);
  assert.equal(deleted.activeUvLayer, 'UVMap');
  const empty = applyEditableMeshAttributeEdit(deleted, { type: 'deleteUvLayer', name: 'UVMap' });
  assert.deepEqual(empty.uvLayers, {});
  assert.equal(empty.activeUvLayer, null);
});

test('UV creation accepts exact flattened values, chooses the first active layer, and enforces layer budgets', () => {
  const withoutUvs = { ...seamMesh(), uvLayers: {}, activeUvLayer: null };
  const exact = Array.from({ length: 12 }, (_, index) => index / 10);
  const result = applyEditableMeshAttributeEdit(withoutUvs, {
    type: 'createUvLayer',
    name: 'Exact',
    values: exact,
  });
  assert.deepEqual(result.uvLayers.Exact, exact);
  assert.equal(result.activeUvLayer, 'Exact');
  assert.throws(() => applyEditableMeshAttributeEdit(withoutUvs, {
    type: 'createUvLayer',
    name: 'Bad',
    fill: [0, 0],
    values: exact,
  }), /either fill or values/);
  assert.throws(() => applyEditableMeshAttributeEdit(withoutUvs, {
    type: 'createUvLayer',
    name: 'Bad',
    values: [0, 0],
  }), /exactly 12/);

  const full = {
    ...seamMesh(),
    uvLayers: Object.fromEntries(Array.from(
      { length: EDITABLE_MESH_ATTRIBUTE_LIMITS.maxLayersPerDomain },
      (_, index) => [`uv${index}`, new Array(12).fill(0)],
    )),
    activeUvLayer: 'uv0',
  };
  assert.throws(() => applyEditableMeshAttributeEdit(full, {
    type: 'createUvLayer',
    name: 'overflow',
  }), /cannot contain more than 32 layers/);
});

test('exact corner UV writes preserve seams and transforms honor scale, pivot, rotation, and translation', () => {
  const source = seamMesh();
  const written = applyEditableMeshAttributeEdit(source, {
    type: 'setCornerUvs',
    layer: 'UVMap',
    cornerIndices: [3, 0],
    values: [0.9, 0.8, 0.1, 0.2],
  });
  assertClose(written.uvLayers.UVMap.slice(0, 2), [0.1, 0.2]);
  assertClose(written.uvLayers.UVMap.slice(6, 8), [0.9, 0.8]);
  assertClose(written.uvLayers.UVMap.slice(2, 6), source.uvLayers.UVMap.slice(2, 6));

  const transformed = applyEditableMeshAttributeEdit(source, {
    type: 'transformUvs',
    layer: 'UVMap',
    cornerIndices: [1],
    scale: [2, 1],
    rotation: Math.PI / 2,
    pivot: [0, 0],
    translation: [1, 2],
  });
  assertClose(transformed.uvLayers.UVMap.slice(2, 4), [1, 4]);
  assertClose(transformed.uvLayers.UVMap.slice(0, 2), [0, 0]);
  assert.deepEqual(transformed.positions, source.positions);
  assert.deepEqual(transformed.faceMaterialIndices, source.faceMaterialIndices);
});

test('planar projection writes selected corners from exact position axes', () => {
  const source = seamMesh();
  const yz = applyEditableMeshAttributeEdit(source, {
    type: 'projectUvs',
    layer: 'UVMap',
    cornerIndices: [0, 2, 5],
    axis: 'yz',
    scale: [2, 0.5],
    offset: [1, -1],
  });
  assertClose(yz.uvLayers.UVMap.slice(0, 2), [1, -0.5]);
  assertClose(yz.uvLayers.UVMap.slice(4, 6), [5, 0.5]);
  assertClose(yz.uvLayers.UVMap.slice(10, 12), [5, 1]);
  assertClose(yz.uvLayers.UVMap.slice(2, 4), source.uvLayers.UVMap.slice(2, 4));

  const xy = applyEditableMeshAttributeEdit(source, {
    type: 'projectUvs',
    layer: 'UVMap',
    cornerIndices: 'all',
    axis: 'xy',
  });
  assertClose(xy.uvLayers.UVMap, [0, 0, 2, 0, 2, 2, 0, 0, 2, 2, 0, 2]);
  assert.throws(() => applyEditableMeshAttributeEdit(source, {
    type: 'projectUvs',
    layer: 'UVMap',
    cornerIndices: 'all',
    axis: 'screen',
  }), /axis must be/);
});

test('color layer lifecycle and exact RGBA writes remain independent from UV attributes', () => {
  const source = seamMesh();
  const created = applyEditableMeshAttributeEdit(source, {
    type: 'createColorLayer',
    name: 'AO',
    fill: [0.2, 0.3, 0.4, 0.5],
    setActive: true,
  });
  assert.equal(created.activeColorLayer, 'AO');
  assert.deepEqual(created.colorLayers.AO, new Array(6).fill([0.2, 0.3, 0.4, 0.5]).flat());
  assert.deepEqual(created.uvLayers, source.uvLayers);

  const written = applyEditableMeshAttributeEdit(created, {
    type: 'setCornerColors',
    layer: 'AO',
    cornerIndices: [5, 1],
    values: [1, 0, 0.25, 1, 0, 0.5, 1, 0.75],
  });
  assertClose(written.colorLayers.AO.slice(20, 24), [1, 0, 0.25, 1]);
  assertClose(written.colorLayers.AO.slice(4, 8), [0, 0.5, 1, 0.75]);

  const renamed = applyEditableMeshAttributeEdit(written, {
    type: 'renameColorLayer',
    name: 'AO',
    newName: 'Ambient Occlusion',
  });
  assert.equal(renamed.activeColorLayer, 'Ambient Occlusion');
  const deactivated = applyEditableMeshAttributeEdit(renamed, {
    type: 'setActiveColorLayer',
    name: null,
  });
  assert.equal(deactivated.activeColorLayer, null);
  const removed = applyEditableMeshAttributeEdit(deactivated, {
    type: 'deleteColorLayer',
    name: 'Ambient Occlusion',
  });
  assert.deepEqual(Object.keys(removed.colorLayers), ['Color']);
  assert.equal(removed.activeColorLayer, null);
});

test('face material assignment is exact, ordered, bounded, and topology preserving', () => {
  const source = seamMesh();
  const hash = editableMeshTopologyHash(source);
  const result = applyEditableMeshAttributeEdit(source, {
    type: 'assignFaceMaterials',
    faceIndices: [1, 0],
    materialIndices: [255, 7],
  });
  assert.deepEqual(result.faceMaterialIndices, [7, 255]);
  assert.equal(editableMeshTopologyHash(result), hash);
  assert.deepEqual(result.uvLayers, source.uvLayers);
  const scalar = applyEditableMeshAttributeEdit(source, {
    type: 'assignFaceMaterials',
    faceIndices: 'all',
    materialIndex: 5,
  });
  assert.deepEqual(scalar.faceMaterialIndices, [5, 5]);
  assert.throws(() => applyEditableMeshAttributeEdit(source, {
    type: 'assignFaceMaterials',
    faceIndices: [0],
    materialIndices: [256],
  }), /0 to 255/);
  assert.throws(() => applyEditableMeshAttributeEdit(source, {
    type: 'assignFaceMaterials',
    faceIndices: [0, 1],
    materialIndices: [4],
  }), /exactly 2/);
  assert.throws(() => applyEditableMeshAttributeEdit(source, {
    type: 'assignFaceMaterials',
    faceIndices: [0],
    materialIndex: 4,
    materialIndices: [4],
  }), /exactly one/);
});

test('sharp edge and crease edits canonicalize pairs, update exact selections, and preserve other annotations', () => {
  const source = seamMesh();
  const sharpened = applyEditableMeshAttributeEdit(source, {
    type: 'setSharpEdges',
    edges: [[2, 1], [3, 0]],
    sharp: true,
  });
  assert.deepEqual(sharpened.sharpEdges, [[0, 1], [0, 3], [1, 2]]);
  const softened = applyEditableMeshAttributeEdit(sharpened, {
    type: 'setSharpEdges',
    edges: [[1, 0], [0, 3]],
    sharp: false,
  });
  assert.deepEqual(softened.sharpEdges, [[1, 2]]);

  const creased = applyEditableMeshAttributeEdit(source, {
    type: 'setEdgeCreases',
    edges: [[1, 2], [3, 2]],
    weight: 0.4,
  });
  assert.deepEqual(creased.edgeCreases, [[1, 2, 0.4], [2, 3, 0.4]]);
  const removed = applyEditableMeshAttributeEdit(creased, {
    type: 'removeEdgeCreases',
    edges: [[2, 1]],
  });
  assert.deepEqual(removed.edgeCreases, [[2, 3, 0.4]]);

  const allSharp = applyEditableMeshAttributeEdit(source, {
    type: 'setSharpEdges', edges: 'all', sharp: true,
  });
  assert.deepEqual(allSharp.sharpEdges, [[0, 1], [0, 2], [0, 3], [1, 2], [2, 3]]);
  const allSoft = applyEditableMeshAttributeEdit(allSharp, {
    type: 'setSharpEdges', edges: 'all', sharp: false,
  });
  assert.deepEqual(allSoft.sharpEdges, []);
  const allCreased = applyEditableMeshAttributeEdit(source, {
    type: 'setEdgeCreases', edges: 'all', weight: 0.2,
  });
  assert.deepEqual(allCreased.edgeCreases, [
    [0, 1, 0.2], [0, 2, 0.2], [0, 3, 0.2], [1, 2, 0.2], [2, 3, 0.2],
  ]);
  assert.deepEqual(applyEditableMeshAttributeEdit(allCreased, {
    type: 'removeEdgeCreases', edges: 'all',
  }).edgeCreases, []);
  assert.deepEqual(removed.colorLayers, source.colorLayers);
});

test('strict dispatcher rejects unknown fields, missing layers, invalid selections, non-finite values, and stale topology', () => {
  const source = seamMesh();
  assert.throws(() => applyEditableMeshAttributeEdit(source, {
    type: 'setCornerUvs',
    layer: 'UVMap',
    cornerIndices: [0],
    values: [0, 0],
    guessed: true,
  }), /guessed is not supported/);
  assert.throws(() => applyEditableMeshAttributeEdit(source, {
    type: 'setCornerUvs',
    layer: 'Missing',
    cornerIndices: [0],
    values: [0, 0],
  }), /unknown layer Missing/);
  assert.throws(() => applyEditableMeshAttributeEdit(source, {
    type: 'setCornerUvs',
    layer: 'UVMap',
    cornerIndices: [1, 1],
    values: [0, 0, 1, 1],
  }), /duplicate index 1/);
  assert.throws(() => applyEditableMeshAttributeEdit(source, {
    type: 'setCornerColors',
    layer: 'Color',
    cornerIndices: [6],
    values: [0, 0, 0, 1],
  }), /0 to 5/);
  assert.throws(() => applyEditableMeshAttributeEdit(source, {
    type: 'transformUvs',
    layer: 'UVMap',
    cornerIndices: [0],
  }), /requires translation/);
  assert.throws(() => applyEditableMeshAttributeEdit(source, {
    type: 'transformUvs',
    layer: 'UVMap',
    cornerIndices: [0],
    rotation: Number.NaN,
  }), /JSON-compatible|finite/);
  assert.throws(() => applyEditableMeshAttributeEdit(source, {
    type: 'setSharpEdges',
    edges: [[1, 3]],
    sharp: true,
  }), /does not reference a mesh edge/);
  assert.throws(() => applyEditableMeshAttributeEdit(source, {
    type: 'setEdgeCreases',
    edges: [[0, 1], [1, 0]],
    weight: 0.5,
  }), /duplicate edge 0:1/);
  assert.throws(() => applyEditableMeshAttributeEdit(source, {
    type: 'assignFaceMaterials',
    faceIndices: [],
    materialIndices: [],
  }), /non-empty array/);
  assert.throws(() => applyEditableMeshAttributeEdit(source, {
    type: 'setActiveUvLayer',
    name: 'Missing',
  }), /unknown layer Missing/);
  assert.throws(() => applyEditableMeshAttributeEdit(source, {
    type: 'setActiveUvLayer',
    name: 'UVMap',
    expectedTopologyHash: '0'.repeat(64),
  }), /topology changed/);
  assert.throws(() => applyEditableMeshAttributeEdit(source, { type: 'voxelPaint' }), /Unsupported/);
});

test('bounded command batches compose serially without mutating their input', () => {
  const source = seamMesh();
  const snapshot = structuredClone(source);
  const result = applyEditableMeshAttributeEdits(source, [
    { type: 'createUvLayer', name: 'Detail', fill: [0, 0], setActive: true },
    { type: 'projectUvs', layer: 'Detail', cornerIndices: 'all', axis: 'xz', scale: 0.5 },
    { type: 'createColorLayer', name: 'Mask' },
    { type: 'assignFaceMaterials', faceIndices: 'all', materialIndices: [8, 9] },
    { type: 'setEdgeCreases', edges: [[0, 1]], weight: 0.9 },
  ]);
  assert.deepEqual(source, snapshot);
  assert.equal(result.activeUvLayer, 'Detail');
  assertClose(result.uvLayers.Detail, [0, 0.5, 1, 1, 1, 1.5, 0, 0.5, 1, 1.5, 0, 2]);
  assert.deepEqual(result.faceMaterialIndices, [8, 9]);
  assert.deepEqual(result.edgeCreases, [[0, 1, 0.9], [2, 3, 0.75]]);
  assert.throws(() => applyEditableMeshAttributeEdits(source, []), /non-empty array/);
  assert.throws(() => applyEditableMeshAttributeEdits(
    source,
    new Array(EDITABLE_MESH_ATTRIBUTE_LIMITS.maxCommands + 1).fill({ type: 'setActiveUvLayer', name: null }),
  ), /more than 256/);
});
