import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStroke,
  paintDataTextureStroke,
  paintEditableMeshColorStroke,
  sculptIndexedMeshWithStroke,
  strokeInstanceTransforms,
} from '../src/core/stroke-authoring.mjs';
import { decodeDataTexturePixels } from '../src/core/image-texture.mjs';
import { createProjectDocument } from '../src/core/documents.mjs';
import { translateToolOperation } from '../src/runtime/studio-application.mjs';
import { applySchema } from '../src/mcp/tool-schemas.mjs';

const localStroke = {
  space: 'local',
  defaultRadius: 1.2,
  points: [
    { position: [-1, 0, 0], pressure: 0.5 },
    { position: [1, 0, 0], pressure: 1, color: [1, 0, 0, 1] },
  ],
};

test('stroke normalization is bounded, strict, and preserves expressive per-point controls', () => {
  const stroke = normalizeStroke(localStroke);
  assert.equal(stroke.points.length, 2);
  assert.equal(stroke.points[0].radius, 1.2);
  assert.equal(stroke.points[1].pressure, 1);
  assert.deepEqual(stroke.points[1].color, [1, 0, 0, 1]);
  assert.throws(() => normalizeStroke({ ...localStroke, typo: true }), /unknown property/);
  assert.throws(() => normalizeStroke({ ...localStroke, points: [] }), /1 to/);
});

test('sculpt strokes deform a whole influence path rather than requiring vertex lists', () => {
  const mesh = {
    kind: 'indexedMesh',
    positions: [-1, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
  };
  const result = sculptIndexedMeshWithStroke(mesh, { stroke: localStroke, brush: 'draw', amount: 0.5 });
  assert.ok(result.positions[2] > 0);
  assert.ok(result.positions[5] > 0);
  assert.deepEqual(mesh.positions, [-1, 0, 0, 1, 0, 0, 0, 1, 0]);
});

test('attribute strokes paint editable-mesh color layers with falloff', () => {
  const recipe = {
    kind: 'editableMesh',
    positions: [-1, 0, 0, 1, 0, 0, 0, 1, 0],
    faceOffsets: [0, 3],
    cornerVertexIndices: [0, 1, 2],
    colorLayers: { mask: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
    activeColorLayer: 'mask',
  };
  const result = paintEditableMeshColorStroke(recipe, {
    stroke: localStroke,
    layer: 'mask',
    color: [1, 0.5, 0, 1],
    opacity: 1,
  });
  assert.ok(result.colorLayers.mask[0] > 0);
  assert.equal(recipe.colorLayers.mask[0], 0);
});

test('UV strokes paint exact texture channels and retain canonical base64 storage', () => {
  const texture = {
    kind: 'dataTexture', width: 4, height: 4, channels: 4,
    pixels: new Array(4 * 4 * 4).fill(0), colorSpace: 'srgb',
  };
  const painted = paintDataTextureStroke(texture, {
    space: 'uv', defaultRadius: 0.3,
    points: [{ position: [0.5, 0.5, 0], color: [1, 0, 0, 1] }],
  }, { channel: 'r' });
  assert.equal(typeof painted.data, 'string');
  const bytes = decodeDataTexturePixels(painted);
  assert.ok(bytes.some((value, index) => index % 4 === 0 && value > 0));
  assert.equal(bytes.some((value, index) => index % 4 !== 0 && value > 0), false);
});

test('stroke scatter produces deterministic heterogeneous transforms', () => {
  const first = strokeInstanceTransforms(localStroke, {
    spacing: 0.25, seed: 42, jitter: 0.02, orientation: 'tangent',
    scaleMin: [0.5, 0.5, 0.5], scaleMax: [1.5, 2, 1],
  });
  const second = strokeInstanceTransforms(localStroke, {
    spacing: 0.25, seed: 42, jitter: 0.02, orientation: 'tangent',
    scaleMin: [0.5, 0.5, 0.5], scaleMax: [1.5, 2, 1],
  });
  assert.deepEqual(first, second);
  assert.ok(first.length > 2);
  assert.notDeepEqual(first[0].scale, first[1].scale);
});

test('stroke.apply lowers curve, scatter, and persistent stroke assets to canonical operations', () => {
  const project = createProjectDocument({
    projectId: 'project/strokes',
    resources: {
      geometries: [{ id: 'geometry/source', recipe: { kind: 'box' } }],
      materials: [{ id: 'material/line', recipe: { kind: 'standard' } }],
    },
    scenes: [{
      id: 'scene/main', rootEntityIds: ['entity/source'],
      entities: [{
        id: 'entity/source', kind: 'mesh',
        components: { mesh: { geometryId: 'geometry/source', materialId: 'material/line' } },
      }],
    }],
  });
  const curve = translateToolOperation({
    op: 'stroke.apply', stroke: localStroke, storeAsAssetId: 'asset/stroke/path',
    target: {
      kind: 'curve', sceneId: 'scene/main', geometryId: 'geometry/stroke/path',
      entityId: 'entity/stroke/path', materialId: 'material/line', radius: 0.05, radialSegments: 6,
    },
  }, project);
  assert.deepEqual(curve.map(operation => operation.type), ['resource.create', 'resource.create', 'entity.create']);
  assert.equal(curve[0].resource.kind, 'stroke');
  assert.equal(curve[1].resource.recipe.kind, 'tube');

  const scatter = translateToolOperation({
    op: 'stroke.apply', stroke: localStroke,
    target: { kind: 'scatter', entityId: 'entity/source', spacing: 0.5, seed: 2 },
  }, project);
  assert.equal(scatter[0].type, 'entity.patch');
  assert.equal(scatter[0].patch.kind, 'instancedMesh');
  assert.ok(scatter[0].patch.components.mesh.instances.length > 1);
});

test('stroke.apply is strict at the MCP boundary and provisions a missing paint layer', () => {
  const request = {
    protocolVersion: 'three-studio/1', sessionId: 'session-strokes', projectId: 'project/strokes',
    baseRevision: 0, idempotencyKey: 'stroke-apply-001', label: 'Paint one expressive path',
    operations: [{
      op: 'stroke.apply', stroke: localStroke,
      target: { kind: 'attribute', entityId: 'entity/paint', expectedTopologyHash: 'a'.repeat(64), layer: 'paint' },
    }],
  };
  assert.equal(applySchema.safeParse(request).success, true);
  assert.equal(applySchema.safeParse({
    ...request,
    operations: [{ ...request.operations[0], strokeId: 'asset/stroke/also-set' }],
  }).success, false);

  const project = createProjectDocument({
    projectId: 'project/strokes',
    resources: {
      geometries: [{ id: 'geometry/paint', recipe: {
        kind: 'editableMesh', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        faceOffsets: [0, 3], cornerVertexIndices: [0, 1, 2],
      } }],
      materials: [{ id: 'material/paint', recipe: { kind: 'standard' } }],
    },
    scenes: [{
      id: 'scene/main', rootEntityIds: ['entity/paint'],
      entities: [{ id: 'entity/paint', kind: 'mesh', components: { mesh: {
        geometryId: 'geometry/paint', materialId: 'material/paint',
      } } }],
    }],
  });
  const [edit] = translateToolOperation(request.operations[0], project);
  assert.deepEqual(edit.edits.map(command => command.type), ['createColorLayer', 'paintColorStroke']);
});
