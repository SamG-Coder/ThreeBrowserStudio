import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateEditableMeshModifierStack } from '../src/core/editable-mesh-modifiers.mjs';
import { triangulateEditableMesh } from '../src/core/editable-mesh.mjs';
import { analyzeViewportModifierStack } from '../src/core/modifier-stack.mjs';

const panel = () => ({ kind: 'editableMesh', positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
  faceOffsets: [0, 4], cornerVertexIndices: [0, 1, 2, 3],
  uvLayers: { body: [0, 0, 1, 0, 1, 1, 0, 1], lightmap: [0, 0, 0.5, 0, 0.5, 0.5, 0, 0.5] },
  activeUvLayer: 'body', colorLayers: { tint: [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1] },
  activeColorLayer: 'tint', faceMaterialIndices: [2], sharpEdges: [[0, 1]], edgeCreases: [[1, 2, 0.6]] });
const evaluate = (mesh, type, props = {}, options = {}) => evaluateEditableMeshModifierStack(mesh,
  [{ id: `modifier/${type}`, type, ...props }], options).recipe;
const edgeKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;
function edgeUses(mesh) {
  const edges = new Map();
  for (let f = 0; f < mesh.faceOffsets.length - 1; f += 1) {
    const face = mesh.cornerVertexIndices.slice(mesh.faceOffsets[f], mesh.faceOffsets[f + 1]);
    face.forEach((a, i) => {
      const b = face[(i + 1) % face.length]; const key = edgeKey(a, b);
      if (!edges.has(key)) edges.set(key, []); edges.get(key).push([a, b]);
    });
  }
  return edges;
}
function assertClosed(mesh) {
  for (const uses of edgeUses(mesh).values()) {
    assert.equal(uses.length, 2); assert.deepEqual(uses[0], [...uses[1]].reverse());
  }
}
const cube = () => ({ kind: 'editableMesh', positions: [-1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1, -1,-1,1, 1,-1,1, 1,1,1, -1,1,1],
  faceOffsets: [0,4,8,12,16,20,24], cornerVertexIndices: [0,3,2,1, 4,5,6,7, 0,1,5,4, 3,7,6,2, 0,4,7,3, 1,2,6,5] });

test('solidify closes an open panel with shared geometric vertices and outward consistent walls', () => {
  const source = panel(); const snapshot = structuredClone(source);
  const result = evaluate(source, 'solidify', { thickness: 0.2 });
  assert.equal(result.positions.length / 3, 8);
  assert.equal(result.faceOffsets.length - 1, 6);
  assert.equal(triangulateEditableMesh(result).recipe.indices.length / 3, 12);
  assertClosed(result);
  assert.deepEqual(result.positions.filter((_, i) => i % 3 === 2), [0.1,0.1,0.1,0.1,-0.1,-0.1,-0.1,-0.1]);
  assert.deepEqual(result.uvLayers.body.slice(0, 8), source.uvLayers.body);
  assert.deepEqual(result.uvLayers.body.slice(8, 16), [0,1,1,1,1,0,0,0]);
  assert.deepEqual(result.uvLayers.body.slice(16, 24), [0,0,2,0,2,0.2,0,0.2], 'rims receive nondegenerate strip UVs');
  assert.deepEqual(result.faceMaterialIndices, [2,2,2,2,2,2]);
  assert.deepEqual(result.edgeCreases, [[1,2,0.6],[5,6,0.6]]);
  assert.equal(result.colorLayers.tint.length, result.cornerVertexIndices.length * 4);
  assert.equal(result.activeColorLayer, 'tint'); assert.equal(result.activeUvLayer, 'body');
  assert.deepEqual(source, snapshot);
});

test('negative thickness and offset retain closed shell winding and pinned source side', () => {
  const shell = evaluate(panel(), 'solidify', { thickness: -0.25, offset: -1 });
  assertClosed(shell);
  assert.deepEqual(shell.positions.filter((_, i) => i % 3 === 2), [0,0,0,0,0.25,0.25,0.25,0.25]);
  const compiled = triangulateEditableMesh(shell);
  assert.ok(compiled.recipe.normals[2] < 0, 'lower skin points away from shell interior');
});

test('Loop subdivision creates curvature while simple subdivision only splits faces', () => {
  const source = cube();
  const simple = evaluate(source, 'subdivision', { levels: 1, scheme: 'simple' });
  const smooth = evaluate(source, 'subdivision', { levels: 1, scheme: 'loop' });
  assert.deepEqual(simple.positions.slice(0, 24), source.positions);
  assert.ok(smooth.positions.slice(0, 24).every(value => Math.abs(value) < 1));
  assert.equal(smooth.faceOffsets.length - 1, 48);
  assertClosed(smooth);
});

test('authored sharp edges and full creases preserve cube corners through repeated levels', () => {
  const source = cube();
  source.sharpEdges = [...edgeUses(source).values()].map(uses => uses[0]);
  const sharp = evaluate(source, 'subdivision', { levels: 2 });
  assert.deepEqual(sharp.positions.slice(0, 24), source.positions);
  assert.equal(sharp.sharpEdges.length, 48);
  const creasedSource = { ...cube(), edgeCreases: source.sharpEdges.map(([a,b]) => [a,b,1]) };
  const creased = evaluate(creasedSource, 'subdivision', { levels: 2 });
  assert.deepEqual(creased.positions, sharp.positions);
  assert.equal(creased.edgeCreases.length, 48);
  assert.ok(creased.edgeCreases.every(tuple => tuple[2] === 1));
  assertClosed(creased);
});

test('partial crease weights blend smoothly and persist with exact authored weight', () => {
  const source = cube();
  const edges = [...edgeUses(source).values()].map(uses => uses[0]);
  const smooth = evaluate(source, 'subdivision');
  const partial = evaluate({ ...source, edgeCreases: edges.map(([a,b]) => [a,b,0.5]) }, 'subdivision');
  assert.ok(Math.abs(partial.positions[0]) > Math.abs(smooth.positions[0]));
  assert.ok(Math.abs(partial.positions[0]) < 1);
  assert.ok(partial.edgeCreases.every(tuple => tuple[2] === 0.5));
});

test('subdivision preserves UV/color seams and materials without splitting the shared geometric edge', () => {
  const source = { kind: 'editableMesh', positions: [-1,-1,0, 0,-1,0, 0,1,0, -1,1,0, 1,-1,0, 1,1,0],
    faceOffsets: [0,4,8], cornerVertexIndices: [0,1,2,3, 1,4,5,2],
    uvLayers: { paint: [0,0,1,0,1,1,0,1, 10,0,11,0,11,1,10,1] }, activeUvLayer: 'paint',
    colorLayers: { tint: [...Array.from({length:4}, () => [1,0,0,1]).flat(), ...Array.from({length:4}, () => [0,0,1,1]).flat()] },
    activeColorLayer: 'tint', faceMaterialIndices: [0,1] };
  const result = evaluate(source, 'subdivision', { scheme: 'simple' });
  const midpoint = Array.from({length: result.positions.length / 3}, (_, i) => i)
    .filter(i => result.positions.slice(i * 3, i * 3 + 3).every(v => v === 0));
  assert.equal(midpoint.length, 1, 'one geometric vertex at the material/UV seam');
  const uvValues = new Set(); const colors = new Set();
  result.cornerVertexIndices.forEach((v, i) => { if (v === midpoint[0]) {
    uvValues.add(result.uvLayers.paint.slice(i * 2, i * 2 + 2).join(','));
    colors.add(result.colorLayers.tint.slice(i * 4, i * 4 + 4).join(','));
  } });
  assert.deepEqual([...uvValues].sort(), ['1,0.5','10,0.5']);
  assert.deepEqual([...colors].sort(), ['0,0,1,1','1,0,0,1']);
  const compiled = triangulateEditableMesh(result);
  assert.equal(compiled.triangleMaterialIndices.filter(v => v === 0).length, 8);
  assert.equal(compiled.triangleMaterialIndices.filter(v => v === 1).length, 8);
  const shell = evaluate(result, 'solidify', { thickness: 0.1 });
  assertClosed(shell);
  assert.equal(shell.faceOffsets.length - 1, 44, 'internal UV seam does not generate walls');
});

test('topology modifiers reject non-manifold edges, winding conflicts, and bow-tie vertices', () => {
  const badMeshes = [
    { kind: 'editableMesh', positions: [0,0,0,1,0,0,0,1,0,0,-1,0,0,0,1], faceOffsets: [0,3,6,9], cornerVertexIndices: [0,1,2,1,0,3,0,1,4] },
    { kind: 'editableMesh', positions: [0,0,0,1,0,0,0,1,0,0,-1,0], faceOffsets: [0,3,6], cornerVertexIndices: [0,1,2,0,1,3] },
    { kind: 'editableMesh', positions: [0,0,0,1,0,0,0,1,0,-1,0,0,0,-1,0], faceOffsets: [0,3,6], cornerVertexIndices: [0,1,2,0,3,4] },
  ];
  for (const mesh of badMeshes) for (const type of ['solidify','subdivision']) assert.throws(() => evaluate(mesh, type), { code: 'editable_modifier_non_manifold' });
});

test('topology modifiers preflight bounded geometric and seam-expanded outputs', () => {
  for (const type of ['solidify','subdivision']) {
    assert.throws(() => evaluate(panel(), type, {}, { maxOutputTriangles: 3 }), { code: 'geometry_modifier_budget_exceeded' });
    assert.throws(() => evaluate(panel(), type, {}, { maxOutputVertices: 4 }), { code: 'geometry_modifier_budget_exceeded' });
  }
  assert.throws(() => evaluate(panel(), 'subdivision', { levels: 7 }), { code: 'invalid_geometry_modifier' });
  assert.throws(() => evaluate(panel(), 'solidify', { thickness: 0 }), { code: 'invalid_geometry_modifier' });
  assert.throws(() => evaluate(panel(), 'subdivision', {}, { maxOutputVertices: Infinity }), { code: 'invalid_geometry_modifier_budget' });
});

test('editable stack supports shell, subdivision, and deformation before a render seam boundary', () => {
  const stack = [
    { id: 'modifier/shell', type: 'solidify', thickness: 0.2 },
    { id: 'modifier/subd', type: 'subdivision', scheme: 'simple' },
    { id: 'modifier/deform', type: 'simpleDeform', mode: 'twist', axis: 'z', factor: 0.1 },
  ];
  const result = evaluateEditableMeshModifierStack(panel(), stack);
  assertClosed(result.recipe);
  assert.deepEqual(result.applied.map(m => m.id), stack.map(m => m.id));
  const entity = { id: 'entity/panel', components: { modifiers: stack } };
  assert.equal(analyzeViewportModifierStack(entity, { sourceKind: 'editableMesh' }).status, 'live');
  entity.components.modifiers = [{ id: 'modifier/split', type: 'edgeSplit' }, ...stack];
  const blocked = analyzeViewportModifierStack(entity, { sourceKind: 'editableMesh' });
  assert.equal(blocked.blocked.reasonCode, 'runtime_editable_topology_after_render_boundary');
  assert.deepEqual(blocked.geometryModifiers.map(m => m.id), ['modifier/split']);
});
