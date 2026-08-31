import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectDocument } from '../src/core/documents.mjs';
import {
  composeTransformMatrix, multiplyTransformMatrices, transformPointByMatrix,
} from '../src/core/transform-math.mjs';
import { operationSchema } from '../src/mcp/tool-schemas.mjs';
import {
  DesignExpressionError, PlainformCompiler, PlainformError,
  evaluateDesignExpression, evaluatePlainformMath,
} from '../src/plainform/index.mjs';

function projectFixture() {
  return createProjectDocument({
    projectId: 'project/plainform',
    resources: {
      geometries: [
        { id: 'geometry/leaf', recipe: { kind: 'box' } },
        { id: 'geometry/branch', recipe: { kind: 'cylinder', radiusTop: 0.1, radiusBottom: 0.2, height: 2 } },
        { id: 'geometry/twig', recipe: { kind: 'cylinder', radiusTop: 0.02, radiusBottom: 0.05, height: 1 } },
        { id: 'geometry/trunk', recipe: { kind: 'cylinder', radiusTop: 0.4, radiusBottom: 0.6, height: 4 } },
      ],
      materials: [{ id: 'material/leaf', recipe: { kind: 'physical', color: '#4f7a3a' } }],
    },
    scenes: [{
      id: 'scene/main', rootEntityIds: ['entity/tree'],
      entities: [{
        id: 'entity/tree', kind: 'group', name: 'Tree', children: ['entity/leaf-a', 'entity/leaf-b', 'entity/leaf-duplicate', 'entity/branch', 'entity/trunk'],
      }, {
        id: 'entity/leaf-a', kind: 'mesh', name: 'Leaf A', parentId: 'entity/tree', tags: ['leaf'],
        transform: { position: [0, 1, 0] },
        components: { mesh: { geometryId: 'geometry/leaf', materialId: 'material/leaf' } },
      }, {
        id: 'entity/leaf-b', kind: 'mesh', name: 'Leaf B', parentId: 'entity/tree', tags: ['leaf'],
        transform: { position: [1, 1, 0] },
        components: { mesh: { geometryId: 'geometry/leaf', materialId: 'material/leaf' } },
      }, {
        id: 'entity/leaf-duplicate', kind: 'mesh', name: 'Leaf Duplicate', parentId: 'entity/tree', tags: ['leaf'],
        transform: { position: [0.0005, 1, 0] },
        components: { mesh: { geometryId: 'geometry/leaf', materialId: 'material/leaf' } },
      }, {
        id: 'entity/branch', kind: 'mesh', name: 'Branch', parentId: 'entity/tree', children: ['entity/twig-a'], tags: ['limb'],
        transform: { position: [1, 2, 0] },
        components: { mesh: { geometryId: 'geometry/branch', materialId: 'material/leaf' } },
      }, {
        id: 'entity/twig-a', kind: 'mesh', name: 'Twig A', parentId: 'entity/branch', tags: ['twig'],
        transform: { position: [0, 1, 0] },
        components: { mesh: { geometryId: 'geometry/twig', materialId: 'material/leaf' } },
      }, {
        id: 'entity/trunk', kind: 'mesh', name: 'Trunk', parentId: 'entity/tree', tags: ['centre'],
        transform: { position: [0, 2, 0] },
        components: { mesh: { geometryId: 'geometry/trunk', materialId: 'material/leaf' } },
      }],
    }],
  });
}

test('Plainform mathematical English preserves units, constants, variables, and deterministic noise', () => {
  const variables = new Map([
    ['number', { value: 3, dimension: 'scalar' }],
    ['count', { value: 12, dimension: 'scalar' }],
  ]);
  const angle = evaluatePlainformMath(
    'its number divided by the total number of leaves multiplied by one full turn',
    variables,
  );
  assert.equal(angle.dimension, 'angle');
  assert.ok(Math.abs(angle.value - Math.PI / 2) < 1e-9);
  const radius = evaluatePlainformMath('2 metres plus 30 centimetres');
  assert.deepEqual(radius, { value: 2.3, dimension: 'length' });
  assert.deepEqual(
    evaluatePlainformMath('seeded noise of its number using seed 42', variables),
    evaluatePlainformMath('seeded noise of its number using seed 42', variables),
  );
  assert.throws(
    () => evaluatePlainformMath('2 metres plus 20 degrees'),
    error => error instanceof PlainformError && error.code === 'plainform_dimension_mismatch',
  );
});

test('Design Plainform mathematics supports dimensional algebra, functions, and natural operator chains', () => {
  const variables = new Map([
    ['tower height', { value: 240, dimension: 'length' }],
    ['floor height', { value: 3.75, dimension: 'length' }],
  ]);
  assert.deepEqual(evaluateDesignExpression('floor(tower height / floor height)', variables), {
    value: 64, dimension: 'scalar',
  });
  assert.deepEqual(evaluateDesignExpression('12 metres * 8 metres'), { value: 96, dimension: 'area' });
  assert.deepEqual(evaluateDesignExpression('sqrt(144 square metres)'), {
    value: 12, dimension: 'length',
  });
  assert.deepEqual(evaluateDesignExpression('lerp(38 metres, 32 metres, smoothstep(0, 1, 0.5))'), {
    value: 35, dimension: 'length',
  });
  assert.ok(Math.abs(evaluateDesignExpression('atan2(1 metre, 1 metre)').value - Math.PI / 4) < 1e-12);
  assert.throws(
    () => evaluateDesignExpression('2 metres + 20 degrees'),
    error => error instanceof DesignExpressionError && error.code === 'plainform_dimension_mismatch',
  );
});

test('Design Plainform lowers a bounded mathematical tower to shared geometry and batched entities', () => {
  const compiled = new PlainformCompiler().compile(`
Design a tower called Parametric Tower with id entity/parametric-tower.
Let tower height be 24 metres.
Let floor height be 3 metres.
Let floor count be floor(tower height / floor height).
Let tower width be 12 metres.
Let tower depth be 10 metres.
Create a rectangular profile called floor profile with width tower width and depth tower depth, rounded by 50 centimetres.
For every floor i from 0 through floor count minus 1:
  Let progress be i / (floor count - 1).
  Let height be i * floor height.
  Let plate height be height + 10 centimetres.
  Let twist be 4 degrees * sin(progress * pi * 3).
  Let taper be lerp(1, 0.84, smoothstep(0.15, 1, progress)).
  Add a section of the floor profile at height height, rotated around y by twist, and scaled horizontally by taper.
  Create a floor plate from the floor profile at height plate height, with thickness 20 centimetres, rotated around y by twist, and scaled horizontally by taper.
End.
Add a section of the floor profile at height tower height, rotated around y by 0 degrees, and scaled horizontally by 0.84.
Loft a watertight solid called Tower Envelope with id entity/tower-envelope through all sections of the floor profile.
Ensure the design is exactly tower height high.
Preview these changes.
`, { project: projectFixture() });
  assert.equal(compiled.dialect, 'design');
  assert.equal(compiled.requestedPreview, true);
  assert.deepEqual(compiled.operations.map(operation => operation.op), [
    'resource.createMany', 'entity.create', 'entity.createMany',
  ]);
  assert.ok(compiled.operations.every(operation => operationSchema.safeParse(operation).success));
  assert.deepEqual(compiled.design, {
    rootId: 'entity/parametric-tower', entityCount: 9, resourceCount: 2, variableCount: 5,
  });
  const resources = compiled.operations[0].items;
  assert.equal(resources.find(item => item.resource.recipe.kind === 'loft').resource.recipe.sections.length, 9);
  const entities = compiled.operations[2].items.map(item => item.entity);
  assert.equal(entities.filter(entity => entity.metadata.plainformDesign.primitive === 'box').length, 8);
  assert.equal(entities.at(-1).id, 'entity/tower-envelope');
  assert.equal(new Set(entities.slice(0, 8).map(entity => entity.components.mesh.geometryId)).size, 1);
  assert.notDeepEqual(entities[1].transform.rotation, entities[2].transform.rotation);
});

test('Design Plainform creates exact primitive IDs and rejects unsafe bounds or dimensions', () => {
  const compiled = new PlainformCompiler().compile(`
Design a pavilion called Small Pavilion with id entity/small-pavilion.
Create a box called Podium with id entity/podium, with width 10 metres, height 2 metres, and depth 8 metres, centred at [0, 1 metre, 0].
Create a cylinder called Column with id entity/column, with radius 30 centimetres and height 4 metres, centred at [0, 4 metres, 0].
Ensure every generated object has positive dimensions.
`, { project: projectFixture() });
  assert.deepEqual(compiled.operations[2].items.map(item => item.entity.id), ['entity/podium', 'entity/column']);
  assert.deepEqual(compiled.operations[2].items[1].entity.transform.scale, [0.3, 4, 0.3]);
  assert.throws(
    () => new PlainformCompiler().compile(`
Design a model called Broken with id entity/broken.
Create a box called Invalid, with width 1 metre, height 0 metres, and depth 1 metre.
`, { project: projectFixture() }),
    error => error.code === 'plainform_design_dimension',
  );
  assert.throws(
    () => new PlainformCompiler().compile(`
Design a model called Unbounded with id entity/unbounded.
For every item i from 0 through 500:
  Create a box called Item {i}, with width 1 metre, height 1 metre, and depth 1 metre.
End.
`, { project: projectFixture() }),
    error => error.code === 'plainform_loop_bounds',
  );
});

test('Design Plainform compiles curved symmetric profiles, independent section controls, guides, continuity, and local form modifiers', () => {
  const compiled = new PlainformCompiler().compile(`
Design a manufactured shell called Guided Shell with id entity/guided-shell.
Create a symmetric smooth profile called body section through [0 metres, 45 centimetres], [35 centimetres, 40 centimetres], [55 centimetres, 10 centimetres], [50 centimetres, -35 centimetres], [0 metres, -42 centimetres], mirrored across the z centreline.
Create a guide curve called shoulder line through [42 centimetres, 0 metres, 30 centimetres], [50 centimetres, 1 metre, 34 centimetres], [44 centimetres, 2 metres, 28 centimetres].
Add a controlled section of body section at height 0 metres, width 92 centimetres, depth 84 centimetres, offset by [0 metres, 0 metres, 0 metres], rotated by [0 degrees, 0 degrees, 0 degrees], and scaled locally by [0.8, 1, 0.9].
Add a controlled section of body section at height 1 metre, width 1.10 metres, depth 92 centimetres, offset vertically by 8 centimetres, offset laterally by 5 centimetres.
Add a controlled section of body section at height 2 metres, width 94 centimetres, depth 76 centimetres, offset by [0 metres, 2 centimetres, 0 metres].
Loft a watertight solid called Guided Body with id entity/guided-body through all sections of body section, following shoulder line, with curvature continuity.
Bulge Guided Body outward around [0 metres, 1 metre, 30 centimetres] by 6 centimetres within 70 centimetres.
Offset the surface of Guided Body by 1 centimetre.
Preview these changes.
`, { project: projectFixture() });
  const resource = compiled.operations[0].items.find(item => item.resource.recipe.kind === 'loft').resource;
  assert.equal(resource.recipe.continuity, 'curvature');
  assert.equal(resource.recipe.subdivisions, 3);
  assert.equal(resource.recipe.guideCurves.length, 1);
  assert.equal(resource.recipe.modifiers.length, 2);
  assert.equal(resource.recipe.sections.length, 3);
  assert.notEqual(resource.recipe.sections[0].transform.scale[0], resource.recipe.sections[0].transform.scale[2]);
  assert.deepEqual(resource.recipe.sections[1].transform.translation, [0, 1.08, 0.05]);
  assert.ok(compiled.operations.every(operation => operationSchema.safeParse(operation).success));
});

test('Design Plainform spans generic named boundaries with a constrained open surface patch', () => {
  const compiled = new PlainformCompiler().compile(`
Design a vehicle connector called Boundary Patch with id entity/boundary-patch.
Create a box called Roof with id entity/roof, with width 2 metres, height 20 centimetres, and depth 1 metre, centred at [0 metres, 1.5 metres, 0 metres].
Create a box called Cowl with id entity/cowl, with width 2.2 metres, height 20 centimetres, and depth 1 metre, centred at [0 metres, 50 centimetres, -1 metre].
Name a boundary called roof front on Roof through design points [-1 metre, 1.4 metres, -50 centimetres], [0 metres, 1.5 metres, -55 centimetres], [1 metre, 1.4 metres, -50 centimetres].
Name a boundary called cowl rear on Cowl through design points [1.1 metres, 60 centimetres, -50 centimetres], [0 metres, 65 centimetres, -55 centimetres], [-1.1 metres, 60 centimetres, -50 centimetres].
Create a constrained surface patch called Windshield with id entity/windshield between $roof-front and $cowl-rear, with tangent continuity, using material material/leaf.
`, { project: projectFixture() });
  assert.ok(compiled.operations.every(operation => operationSchema.safeParse(operation).success));
  const patchResource = compiled.operations[0].items.find(item => item.resource.metadata?.plainformDesign?.primitive === 'surfacePatch').resource;
  assert.equal(patchResource.recipe.kind, 'loft');
  assert.equal(patchResource.recipe.closedProfile, false);
  assert.equal(patchResource.recipe.capStart, false);
  assert.equal(patchResource.recipe.capEnd, false);
  assert.equal(patchResource.recipe.continuity, 'tangent');
  assert.equal(patchResource.recipe.subdivisions, 3);
  assert.equal(patchResource.recipe.alignProfile, 'authored');
  assert.deepEqual(patchResource.recipe.sections.map(section => section.id), [
    'boundary/roof-front', 'boundary/cowl-rear',
  ]);
  assert.deepEqual(patchResource.recipe.sections[1].points[0], [-1.1, 0.6, -0.5]);
  const patchEntity = compiled.operations[2].items.map(item => item.entity)
    .find(entity => entity.id === 'entity/windshield');
  assert.deepEqual(patchEntity.components.mesh, {
    geometryId: patchResource.id, materialId: 'material/leaf',
  });
  assert.deepEqual(patchEntity.metadata.plainformDesign.boundaryRefs, [
    { name: 'roof-front', ownerEntityId: 'entity/roof' },
    { name: 'cowl-rear', ownerEntityId: 'entity/cowl' },
  ]);
  const root = compiled.operations[1].entity;
  assert.deepEqual(root.metadata.plainformDesign.boundaries.map(boundary => boundary.name), [
    'roof-front', 'cowl-rear',
  ]);
});

test('Design Plainform transforms local boundary points and rejects invalid named boundary references', () => {
  const compiled = new PlainformCompiler().compile(`
Design a connector called Local Boundary with id entity/local-boundary.
Create a box called Rotated Panel with id entity/rotated-panel, with width 2 metres, height 2 metres, and depth 2 metres, centred at [3 metres, 0 metres, 0 metres], rotated by [0 degrees, 90 degrees, 0 degrees].
Name a boundary called panel edge on Rotated Panel through local points [0 metres, -50 centimetres, -50 centimetres], [0 metres, 0 metres, -50 centimetres], [0 metres, 50 centimetres, -50 centimetres].
Name a boundary called design edge on Rotated Panel through design points [2 metres, -1 metre, 1 metre], [2 metres, 0 metres, 1 metre], [2 metres, 1 metre, 1 metre].
Create a constrained surface patch called Local Patch with id entity/local-patch between $panel-edge and $design-edge.
`, { project: projectFixture() });
  const patchResource = compiled.operations[0].items.find(item => item.resource.metadata?.plainformDesign?.primitive === 'surfacePatch').resource;
  assert.ok(Math.abs(patchResource.recipe.sections[0].points[0][0] - 2) < 1e-9);
  assert.ok(Math.abs(patchResource.recipe.sections[0].points[0][2]) < 1e-9);

  assert.throws(() => new PlainformCompiler().compile(`
Design a connector called Missing Boundary with id entity/missing-boundary.
Create a box called Panel with id entity/panel, with width 1 metre, height 1 metre, and depth 1 metre.
Name a boundary called edge on Panel through design points [0 metres, 0 metres, 0 metres], [0 metres, 1 metre, 0 metres], [0 metres, 2 metres, 0 metres].
Create a constrained surface patch called Broken with id entity/broken-patch between $edge and $absent.
`, { project: projectFixture() }), error => error.code === 'plainform_unknown_boundary');

  assert.throws(() => new PlainformCompiler().compile(`
Design a connector called Short Boundary with id entity/short-boundary.
Create a box called Panel with id entity/panel, with width 1 metre, height 1 metre, and depth 1 metre.
Name a boundary called edge on Panel through design points [0 metres, 0 metres, 0 metres], [0 metres, 1 metre, 0 metres].
`, { project: projectFixture() }), error => error.code === 'plainform_boundary_points');
});

test('Design Plainform anchors boundary samples to source surfaces and derives tangent-plane patch controls', () => {
  const compiled = new PlainformCompiler().compile(`
Design a facial connector called Surface Anchors with id entity/surface-anchors.
Create a cylinder called Brow Shell with id entity/brow-shell, with radius 1 metre and height 40 centimetres, centred at [0 metres, 1 metre, 0 metres].
Create a cylinder called Eye Shell with id entity/eye-shell, with radius 80 centimetres and height 40 centimetres, centred at [0 metres, 0 metres, 0 metres].
Name a surface-anchored boundary called brow rail on Brow Shell through surface points nearest to design points [-40 centimetres, 1 metre, 1.2 metres], [0 metres, 1 metre, 1.2 metres], [40 centimetres, 1 metre, 1.2 metres].
Name a surface-anchored boundary called eye rail on Eye Shell through surface points nearest to design points [-32 centimetres, 0 metres, 1 metre], [0 metres, 0 metres, 1 metre], [32 centimetres, 0 metres, 1 metre].
Create a constrained surface patch called Lid with id entity/lid between $brow-rail and $eye-rail, meeting both owner surfaces tangentially, with curvature continuity.
`, { project: projectFixture() });
  assert.ok(compiled.operations.every(operation => operationSchema.safeParse(operation).success));
  const root = compiled.operations[1].entity;
  assert.deepEqual(root.metadata.plainformDesign.boundaries.map(boundary => boundary.anchorMode), [
    'nearestSurface', 'nearestSurface',
  ]);
  for (const boundary of root.metadata.plainformDesign.boundaries) {
    assert.equal(boundary.anchors.length, 3);
    assert.ok(boundary.anchors.every(anchor => Number.isInteger(anchor.triangleIndex)));
    assert.ok(boundary.anchors.every(anchor => Math.abs(anchor.barycentric.reduce((sum, value) => sum + value, 0) - 1) < 1e-9));
  }
  const patchResource = compiled.operations[0].items
    .find(item => item.resource.metadata?.plainformDesign?.primitive === 'surfacePatch').resource;
  assert.equal(patchResource.metadata.plainformDesign.sourceTangency, true);
  assert.equal(patchResource.recipe.sections.length, 4);
  assert.equal(patchResource.recipe.continuity, 'positional');
  assert.equal(patchResource.recipe.subdivisions, 0);
  const first = patchResource.recipe.sections[0].points[1];
  const firstHandle = patchResource.recipe.sections[1].points[1];
  const normal = root.metadata.plainformDesign.boundaries[0].anchors[1].normal;
  assert.ok(Math.hypot(...firstHandle.map((value, axis) => value - first[axis])) > 0.1);
  assert.ok(Math.abs(firstHandle.reduce((sum, value, axis) => sum + (value - first[axis]) * normal[axis], 0)) < 1e-8);
});

test('Design Plainform projects anchors against a generated curved loft owner', () => {
  const compiled = new PlainformCompiler().compile(`
Design a head study called Loft Surface Owner with id entity/loft-surface-owner.
Create a smooth profile called head section through [-50 centimetres, 0 metres], [-35 centimetres, 35 centimetres], [0 metres, 50 centimetres], [35 centimetres, 35 centimetres], [50 centimetres, 0 metres], [35 centimetres, -35 centimetres], [0 metres, -50 centimetres], [-35 centimetres, -35 centimetres].
Add a controlled section of head section at height 0 metres, width 90 centimetres, depth 90 centimetres.
Add a controlled section of head section at height 1 metre, width 1 metre, depth 1.1 metres.
Add a controlled section of head section at height 2 metres, width 80 centimetres, depth 80 centimetres.
Loft a watertight solid called Head Shell with id entity/head-shell through all sections of head section, with curvature continuity.
Name a surface-anchored boundary called orbital rail on Head Shell through surface points nearest to design points [-25 centimetres, 1.1 metres, 80 centimetres], [0 metres, 1.2 metres, 90 centimetres], [25 centimetres, 1.1 metres, 80 centimetres].
`, { project: projectFixture() });
  const boundary = compiled.operations[1].entity.metadata.plainformDesign.boundaries[0];
  assert.equal(boundary.anchorMode, 'nearestSurface');
  assert.equal(boundary.anchors.length, 3);
  assert.ok(boundary.anchors.every(anchor => anchor.projectedPoint[2] < anchor.seedPoint[2]));
  assert.ok(boundary.anchors.every(anchor => Math.hypot(...anchor.normal) > 0.999));
});

test('Design Plainform creates a four-boundary constrained patch with exact controlled ends', () => {
  const compiled = new PlainformCompiler().compile(`
Design a generic connector called Four Sided Patch with id entity/four-sided-patch.
Create a box called Owner with id entity/owner, with width 4 metres, height 4 metres, and depth 4 metres.
Name a boundary called upper rail on Owner through design points [-1 metre, 1 metre, 0 metres], [0 metres, 1.2 metres, 20 centimetres], [1 metre, 1 metre, 0 metres].
Name a boundary called lower rail on Owner through design points [-1 metre, -1 metre, 0 metres], [0 metres, -1.2 metres, 20 centimetres], [1 metre, -1 metre, 0 metres].
Name a boundary called left end on Owner through design points [-1 metre, 1 metre, 0 metres], [-1.2 metres, 0 metres, 30 centimetres], [-1 metre, -1 metre, 0 metres].
Name a boundary called right end on Owner through design points [1 metre, 1 metre, 0 metres], [1.2 metres, 0 metres, 30 centimetres], [1 metre, -1 metre, 0 metres].
Create a constrained surface patch called Cheek with id entity/cheek between $upper-rail and $lower-rail, bounded by $left-end and $right-end, with curvature continuity.
`, { project: projectFixture() });
  const patchResource = compiled.operations[0].items
    .find(item => item.resource.metadata?.plainformDesign?.primitive === 'surfacePatch').resource;
  assert.equal(patchResource.recipe.sections.length, 5);
  const rounded = point => point.map(value => Number(value.toFixed(9)));
  assert.deepEqual(patchResource.recipe.sections.map(section => rounded(section.points[0])), [
    [-1, 1, 0], [-1.1, 0.5, 0.15], [-1.2, 0, 0.3], [-1.1, -0.5, 0.15], [-1, -1, 0],
  ]);
  assert.deepEqual(patchResource.recipe.sections.map(section => rounded(section.points.at(-1))), [
    [1, 1, 0], [1.1, 0.5, 0.15], [1.2, 0, 0.3], [1.1, -0.5, 0.15], [1, -1, 0],
  ]);
  assert.deepEqual(patchResource.metadata.plainformDesign.boundaryRefs.map(boundary => boundary.name), [
    'upper-rail', 'lower-rail', 'left-end', 'right-end',
  ]);
});

test('Design Plainform rejects surface tangency without anchored normals and mismatched patch corners', () => {
  assert.throws(() => new PlainformCompiler().compile(`
Design a connector called Missing Normals with id entity/missing-normals.
Create a box called Owner with id entity/owner, with width 2 metres, height 2 metres, and depth 2 metres.
Name a boundary called first on Owner through design points [-1 metre, 1 metre, 0 metres], [0 metres, 1 metre, 0 metres], [1 metre, 1 metre, 0 metres].
Name a boundary called second on Owner through design points [-1 metre, -1 metre, 0 metres], [0 metres, -1 metre, 0 metres], [1 metre, -1 metre, 0 metres].
Create a constrained surface patch called Broken with id entity/broken between $first and $second, meeting both owner surfaces tangentially.
`, { project: projectFixture() }), error => error.code === 'plainform_patch_tangency_requires_surface_anchors');

  assert.throws(() => new PlainformCompiler().compile(`
Design a connector called Bad Corners with id entity/bad-corners.
Create a box called Owner with id entity/owner, with width 2 metres, height 2 metres, and depth 2 metres.
Name a boundary called first on Owner through design points [-1 metre, 1 metre, 0 metres], [0 metres, 1 metre, 0 metres], [1 metre, 1 metre, 0 metres].
Name a boundary called second on Owner through design points [-1 metre, -1 metre, 0 metres], [0 metres, -1 metre, 0 metres], [1 metre, -1 metre, 0 metres].
Name a boundary called wrong left on Owner through design points [5 metres, 5 metres, 0 metres], [5 metres, 0 metres, 0 metres], [5 metres, -5 metres, 0 metres].
Name a boundary called wrong right on Owner through design points [6 metres, 5 metres, 0 metres], [6 metres, 0 metres, 0 metres], [6 metres, -5 metres, 0 metres].
Create a constrained surface patch called Broken with id entity/broken between $first and $second, bounded by $wrong-left and $wrong-right.
`, { project: projectFixture() }), error => error.code === 'plainform_patch_corner_mismatch');
});

test('Design Plainform extrudes arbitrary profiles and lowers deterministic boolean subtraction', () => {
  const compiled = new PlainformCompiler().compile(`
Design a bracket called Boolean Bracket with id entity/boolean-bracket.
Create a smooth profile called side plate through [-1 metre, -50 centimetres], [1 metre, -50 centimetres], [1 metre, 50 centimetres], [-1 metre, 50 centimetres].
Extrude profile side plate by 40 centimetres as a solid called Plate with id entity/plate, centred at [0 metres, 0 metres, 0 metres].
Create a cylinder called Clearance with id entity/clearance, with radius 20 centimetres and height 80 centimetres, centred at [0 metres, 0 metres, 0 metres], rotated by [90 degrees, 0 degrees, 0 degrees].
Subtract Clearance from Plate.
`, { project: projectFixture() });
  const resources = compiled.operations[0].items;
  const csg = resources.find(item => item.resource.id.endsWith('/plate')).resource.recipe;
  assert.equal(csg.kind, 'csg');
  assert.equal(csg.operation, 'subtract');
  assert.deepEqual(csg.operands.map(operand => operand.recipe.kind), ['extrude', 'cylinder']);
  const entities = compiled.operations[2].items.map(item => item.entity);
  assert.equal(entities.find(entity => entity.id === 'entity/clearance').visible, false);
  assert.deepEqual(entities.find(entity => entity.id === 'entity/plate').transform, {
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  });
  assert.ok(compiled.operations.every(operation => operationSchema.safeParse(operation).success));
});

test('Design Plainform rejects invalid curved geometry, dimensions, and unsupported cross-solid continuity', () => {
  assert.throws(() => new PlainformCompiler().compile(`
Design a shell called Broken Profile with id entity/broken-profile.
Create a smooth profile called bad through [0 metres, 0 metres], [1 metre, 0 metres].
Extrude profile bad by 1 metre as a solid called Bad with id entity/bad.
`, { project: projectFixture() }), error => error.code === 'plainform_profile_points');
  assert.throws(() => new PlainformCompiler().compile(`
Design a shell called Broken Units with id entity/broken-units.
Create a profile called bad through [0 metres, 0 degrees], [1 metre, 0 metres], [0 metres, 1 metre].
Extrude profile bad by 1 metre as a solid called Bad with id entity/bad.
`, { project: projectFixture() }), error => error.code === 'plainform_dimension_mismatch');
  assert.throws(() => new PlainformCompiler().compile(`
Design a shell called Broken Blend with id entity/broken-blend.
Create a box called Part A with id entity/part-a, with width 1 metre, height 1 metre, and depth 1 metre.
Create a box called Part B with id entity/part-b, with width 1 metre, height 1 metre, and depth 1 metre.
Blend Part A into Part B with curvature continuity.
`, { project: projectFixture() }), error => error.code === 'plainform_continuity_unsupported');
});

test('Design Plainform binds exact scene distance measurements into parametric dimensions', () => {
  const compiled = new PlainformCompiler().compile(`
Design a bridge called Measured Bridge with id entity/measured-bridge.
Let measured span be the distance between entity/leaf-a and entity/leaf-b.
Create a box called Exact Span with id entity/exact-span, with width measured span, height 20 centimetres, and depth 30 centimetres, centred at [50 centimetres, 2 metres, 0].
`, { project: projectFixture() });
  const bridge = compiled.operations[2].items[0].entity;
  assert.equal(bridge.transform.scale[0], 1);
  assert.deepEqual(bridge.metadata.plainformDesign.dimensions, { width: 1, height: 0.2, depth: 0.3 });
  assert.match(compiled.interpretation.join('\n'), /Measured measured span as 1 metres/u);
});

test('Plainform compiles natural selection, grouping, iteration, and mathematical transforms', () => {
  const compiled = new PlainformCompiler().compile(`
Find every visible mesh beneath entity/tree that is tagged "leaf".
Call them the canopy leaves.
Put the canopy leaves into a group called "Canopy" with id entity/tree/canopy.
For each leaf in the canopy leaves.
  Let angle be its number divided by the total number of leaves multiplied by one full turn.
  Move it by [cosine of angle times 20 centimetres, 0, sine of angle times 20 centimetres].
  Rotate it around y by golden angle.
End.
`, { project: projectFixture() });
  assert.equal(compiled.language, 'plainform-v1');
  assert.deepEqual(compiled.aliases['canopy leaves'], [
    'entity/leaf-a', 'entity/leaf-b', 'entity/leaf-duplicate',
  ]);
  assert.equal(compiled.operations[0].op, 'entity.group');
  assert.equal(compiled.operations.filter(operation => operation.op === 'entity.patch').length, 3);
  assert.ok(compiled.operations.every(operation => operationSchema.safeParse(operation).success));
  assert.match(compiled.interpretation.join('\n'), /run 3 instructions for each of 3 entities/u);
});

test('Plainform removes guarded spatial duplicates while keeping the lowest stable ID', () => {
  const compiled = new PlainformCompiler().compile(`
Find every visible mesh beneath entity/tree that is tagged "leaf".
Call them the canopy leaves.
Remove duplicates from the canopy leaves when they use the same geometry and material and are within 1 millimetre of each other, keeping the lowest ID.
`, { project: projectFixture() });
  assert.deepEqual(compiled.operations.map(operation => operation.entityId), ['entity/leaf-duplicate']);
  assert.match(compiled.operations[0].expectedSubtreeHash, /^[a-f0-9]{64}$/u);
  assert.equal(operationSchema.safeParse(compiled.operations[0]).success, true);
});

test('Plainform reconciles an aliased set to an exact count and iterates over generated entities', () => {
  const compiled = new PlainformCompiler().compile(`
Find every visible mesh beneath entity/tree that is tagged "leaf".
Call them the canopy leaves.
Make sure there are exactly five canopy leaves, using entity/leaf-a as the template and keeping the lowest IDs.
For each item in the canopy leaf.
  Set its scale uniformly to 0.8 plus seeded noise of its number using seed 7 times 0.1.
End.
`, { project: projectFixture() });
  const duplicate = compiled.operations.find(operation => operation.op === 'entity.duplicateMany');
  assert.equal(duplicate.items.length, 2);
  assert.deepEqual(duplicate.items.map(item => item.newId), [
    'entity/plainform/canopy-leaves-001', 'entity/plainform/canopy-leaves-002',
  ]);
  assert.equal(compiled.operations.filter(operation => operation.op === 'entity.patch').length, 5);
  assert.ok(compiled.operations.every(operation => operationSchema.safeParse(operation).success));
  assert.match(compiled.interpretation.join('\n'), /exactly 5: create 2, remove 0/u);
});

test('Plainform resolves named context and filters selections by reference distance', () => {
  const compiled = new PlainformCompiler().compile(`
Use entity/leaf-a as the anchor.
Find every visible mesh within 2 millimetres of the anchor whose name contains "Leaf".
Call them nearby forms.
Move each nearby form by [0, 1 centimetre, 0].
`, { project: projectFixture() });
  assert.deepEqual(compiled.aliases['nearby forms'], ['entity/leaf-a', 'entity/leaf-duplicate']);
  assert.equal(compiled.operations[0].op, 'entity.transformMany');
  assert.deepEqual(compiled.operations[0].transform.position, [0, 0.01, 0]);
  assert.match(compiled.interpretation.join('\n'), /use entity\/leaf-a as “anchor”/u);
  assert.equal(operationSchema.safeParse(compiled.operations[0]).success, true);
});

test('Plainform transforms a singular named reference with natural singular or collective wording', () => {
  const compiled = new PlainformCompiler().compile(`
Use entity/leaf-a as the solar module.
Move the solar module by [1 metre, 2 metres, 3 metres].
Rotate each solar module around y by 90 degrees.
Set the scale of the solar module to 1.5.
`, { project: projectFixture() });
  assert.deepEqual(compiled.operations.map(operation => operation.op), [
    'entity.transformMany', 'entity.transformMany', 'entity.transformMany',
  ]);
  assert.ok(compiled.operations.every(operation => operation.entityIds[0] === 'entity/leaf-a'));
  assert.deepEqual(compiled.operations[0].transform.position, [1, 2, 3]);
  assert.ok(Math.abs(compiled.operations[1].transform.rotation[1] - Math.PI / 2) < 1e-12);
  assert.deepEqual(compiled.operations[2].transform.scale, [1.5, 1.5, 1.5]);
  assert.ok(compiled.operations.every(operation => operationSchema.safeParse(operation).success));
});

test('Plainform extends and subtracts named selections without domain-specific nouns', () => {
  const compiled = new PlainformCompiler().compile(`
Find every visible mesh whose name contains "Leaf A".
Call them blocked forms.
Find every visible mesh whose name contains "Leaf".
Call them working forms.
Extend working forms with descendants of entity/branch.
Exclude blocked forms from working forms.
Move each working form by [1 centimetre, 0, 0].
`, { project: projectFixture() });
  assert.deepEqual(compiled.aliases['working forms'], [
    'entity/leaf-b', 'entity/leaf-duplicate', 'entity/twig-a',
  ]);
  assert.deepEqual(compiled.operations[0].entityIds, [
    'entity/leaf-b', 'entity/leaf-duplicate', 'entity/twig-a',
  ]);
  assert.match(compiled.interpretation.join('\n'), /Extended “working forms” with 1 descendants/u);
  assert.match(compiled.interpretation.join('\n'), /Excluded 1 entities/u);
});

test('Plainform accepts the inverse add-to wording for contextual expansion', () => {
  const compiled = new PlainformCompiler().compile(`
Find every visible mesh whose name contains "Leaf A".
Call them working forms.
Add descendants of entity/branch to working forms.
Move each working form by [0, 0, 1 centimetre].
`, { project: projectFixture() });
  assert.deepEqual(compiled.aliases['working forms'], ['entity/leaf-a', 'entity/twig-a']);
  assert.match(compiled.interpretation.join('\n'), /Extended “working forms” with 1 descendants/u);
});

test('Plainform names a canonical prefab with $ context and lays out a centered grid over an object face', () => {
  const compiled = new PlainformCompiler().compile(`
Use entity/leaf-a as the window module.
Use entity/trunk as the tower volume.
Convert the window module into a prefab called $window-bay.
Lay out a 3 by 4 grid of copies of $window-bay over the front face of the tower volume, spaced 50 centimetres horizontally and 1 metre vertically, offset 8 centimetres outward.
`, { project: projectFixture() });
  assert.deepEqual(compiled.operations.map(operation => operation.op), [
    'resource.create', 'entity.patch', 'entity.patch', 'layout.pattern',
  ]);
  assert.equal(compiled.operations[0].resourceType, 'prefabs');
  assert.equal(compiled.operations[0].resource.id, 'prefab/window-bay');
  assert.equal(compiled.operations[0].resource.sourceEntityId, 'entity/leaf-a');
  assert.equal(compiled.operations[1].patch.components.prefab.prefabId, 'prefab/window-bay');
  assert.deepEqual(compiled.operations[3].pattern.counts, [3, 4, 1]);
  assert.deepEqual(compiled.operations[3].pattern.spacing, [0.5, 1, 0]);
  assert.ok(compiled.operations[2].patch.transform.position[0] > -2);
  assert.ok(compiled.operations[2].patch.transform.position[1] > -2);
  assert.ok(compiled.operations[2].patch.transform.position[2] > 0.5);
  assert.ok(compiled.operations.every(operation => operationSchema.safeParse(operation).success));
  assert.deepEqual(compiled.aliases['$window-bay'], ['entity/leaf-a']);
});

test('Plainform centers face grids in the same rotated local basis used by layout.pattern', () => {
  const expectedCentres = {
    front: [0, 2, 0.68],
    back: [0, 2, -0.68],
    left: [-0.68, 2, 0],
    right: [0.68, 2, 0],
    top: [0, 4.08, 0],
    bottom: [0, -0.08, 0],
  };

  for (const [face, expectedCentre] of Object.entries(expectedCentres)) {
    const compiled = new PlainformCompiler().compile(`
Use entity/leaf-a as the panel.
Use entity/trunk as the volume.
Lay out a 3 by 4 grid of copies of the panel over the ${face} face of the volume, spaced 50 centimetres horizontally and 1 metre vertically, offset 8 centimetres outward.
`, { project: projectFixture() });
    const patch = compiled.operations.find(operation => operation.op === 'entity.patch');
    const pattern = compiled.operations.find(operation => operation.op === 'layout.pattern');
    const matrix = composeTransformMatrix(patch.patch.transform);
    const origin = transformPointByMatrix(matrix, [0, 0, 0]);
    const localX = transformPointByMatrix(matrix, [1, 0, 0]).map((value, index) => value - origin[index]);
    const localY = transformPointByMatrix(matrix, [0, 1, 0]).map((value, index) => value - origin[index]);
    const gridCentre = origin.map((value, index) => (
      value
      + localX[index] * (pattern.pattern.counts[0] - 1) * pattern.pattern.spacing[0] * 0.5
      + localY[index] * (pattern.pattern.counts[1] - 1) * pattern.pattern.spacing[1] * 0.5
    ));

    assert.deepEqual(pattern.pattern.counts, [3, 4, 1], `${face} counts`);
    assert.deepEqual(pattern.pattern.spacing, [0.5, 1, 0], `${face} spacing`);
    gridCentre.forEach((value, axis) => {
      assert.ok(Math.abs(value - expectedCentre[axis]) < 1e-9, `${face} centre axis ${axis}: ${value}`);
    });
  }
});

test('Plainform decouples face-grid placement from per-copy orientation', () => {
  const cases = [{
    wording: 'keeping each copy upright',
    expectedRotation: [0, 0, 0],
  }, {
    wording: 'preserving the prefab orientation',
    expectedRotation: [0.2, 0.35, -0.1],
  }, {
    wording: "aligning each copy's local y axis with the face normal",
    expectedAxis: [0, 1, 0],
  }];
  for (const subject of cases) {
    const project = projectFixture();
    project.scenes['scene/main'].entities['entity/leaf-a'].transform.rotation = [0.2, 0.35, -0.1];
    const compiled = new PlainformCompiler().compile(`
Use entity/leaf-a as the module.
Use entity/trunk as the volume.
Lay out a 2 by 2 grid of copies of the module over the top face of the volume, spaced 1 metre horizontally and 1 metre vertically, ${subject.wording}.
`, { project });
    const transform = compiled.operations.find(operation => operation.op === 'entity.patch').patch.transform;
    const pattern = compiled.operations.find(operation => operation.op === 'layout.pattern').pattern;
    assert.ok(Array.isArray(pattern.instanceRotation), subject.wording);
    const effective = multiplyTransformMatrices(
      composeTransformMatrix({ position: [0, 0, 0], rotation: transform.rotation, scale: [1, 1, 1] }),
      composeTransformMatrix({ position: [0, 0, 0], rotation: pattern.instanceRotation, scale: [1, 1, 1] }),
    );
    if (subject.expectedRotation) {
      const expected = composeTransformMatrix({
        position: [0, 0, 0], rotation: subject.expectedRotation, scale: [1, 1, 1],
      });
      effective.forEach((value, index) => assert.ok(
        Math.abs(value - expected[index]) < 1e-9,
        `${subject.wording} matrix ${index}: ${value} != ${expected[index]}`,
      ));
    } else {
      const origin = transformPointByMatrix(effective, [0, 0, 0]);
      const axis = transformPointByMatrix(effective, [0, 1, 0])
        .map((value, index) => value - origin[index]);
      axis.forEach((value, index) => assert.ok(Math.abs(value - subject.expectedAxis[index]) < 1e-9));
    }
  }
});

test('Plainform restores durable $ prefab references from canonical project resources', () => {
  const project = projectFixture();
  project.resources.prefabs['prefab/window-bay'] = {
    id: 'prefab/window-bay', kind: 'prefab', name: 'window bay', sourceEntityId: 'entity/leaf-a',
    sourceSubtreeHash: '0'.repeat(64),
    template: { sceneId: 'scene/main', rootEntityId: 'entity/leaf-a', entities: [] },
    metadata: { plainform: { name: '$window-bay', snapshotHash: '1'.repeat(64) } },
  };
  const compiled = new PlainformCompiler().compile(`
Use entity/trunk as the tower volume.
Lay out a 2 by 2 grid of copies of $window-bay over the front face of the tower volume, spaced 1 metre horizontally and 1 metre vertically, offset 5 centimetres outward.
`, { project });
  assert.deepEqual(compiled.operations.map(operation => operation.op), ['entity.patch', 'layout.pattern']);
  assert.deepEqual(compiled.aliases['$window-bay'], ['entity/leaf-a']);
});

test('Plainform centers and aligns geometry-aware anchors inside relational loops', () => {
  const compiled = new PlainformCompiler().compile(`
Find every visible mesh beneath entity/tree that is tagged "leaf".
Call them the panels.
Use entity/trunk as the tower volume.
For each panel in the panels.
Place it centered on the front face of the tower volume.
Align its bottom with the top of the tower volume.
End.
`, { project: projectFixture() });
  const patches = compiled.operations.filter(operation => operation.op === 'entity.patch');
  assert.equal(patches.length, 3);
  assert.ok(patches.every(operation => operationSchema.safeParse(operation).success));
  assert.ok(patches.every(operation => operation.patch.transform.position[1] > 3));
});

test('Plainform faces away from context, moves in the resulting local frame, and exposes relational math', () => {
  const compiled = new PlainformCompiler().compile(`
Use entity/tree as the centre.
Find every visible mesh whose name contains "Leaf A".
Call them forms.
For each form in the forms.
  Face it away from the centre.
  Move it forward by 10 centimetres in its local frame.
  Let separation be its distance from the centre.
  Set its scale uniformly to separation divided by 2 metres.
End.
`, { project: projectFixture() });
  const patch = compiled.operations[0].patch.transform;
  assert.ok(Math.abs(patch.position[1] - 1.1) < 1e-9);
  assert.ok(Math.abs(patch.scale[0] - 0.5) < 1e-9);
  assert.deepEqual(patch.scale, [patch.scale[0], patch.scale[0], patch.scale[0]]);
  assert.notDeepEqual(patch.rotation, [0, 0, 0]);
  assert.equal(operationSchema.safeParse(compiled.operations[0]).success, true);
});

test('Plainform resolves nearest members and comparative scale against contextual parents', () => {
  const compiled = new PlainformCompiler().compile(`
Find every visible mesh that is tagged "leaf".
Call them targets.
Find every visible mesh that is tagged "twig".
Call them movers.
For each mover in the movers.
  Face it toward the nearest object in targets.
  Move it toward the nearest object in targets by 20 centimetres.
  Make it 25 percent smaller than its parent.
End.
`, { project: projectFixture() });
  const patch = compiled.operations[0].patch.transform;
  assert.deepEqual(patch.scale, [0.75, 0.75, 0.75]);
  assert.notDeepEqual(patch.position, [0, 1, 0]);
  assert.ok(compiled.operations.every(operation => operationSchema.safeParse(operation).success));
});

test('Plainform aligns an explicit growth axis and attaches its base to an analytic surface', () => {
  const compiled = new PlainformCompiler().compile(`
Use entity/trunk as the centre.
Find every visible mesh that is tagged "limb".
Call them primary forms.
Use positive y as the growth axis for primary forms.
For each form in the primary forms.
  Set its position to [1 metre, 2 metres, 0].
  Point its growth axis away from the centre.
  Attach its base to the surface of the centre with an inset of 5 centimetres.
End.
`, { project: projectFixture() });
  const transform = compiled.operations[0].patch.transform;
  assert.ok(transform.position[0] > 1.35 && transform.position[0] < 1.5);
  assert.ok(Math.abs(transform.position[1] - 2) < 1e-9);
  assert.notDeepEqual(transform.rotation, [0, 0, 0]);
  assert.equal(operationSchema.safeParse(compiled.operations[0]).success, true);
});

test('Plainform grows attached child hierarchy with sibling context and inherited taper', () => {
  const compiled = new PlainformCompiler().compile(`
Find every visible mesh that is tagged "limb".
Call them primary forms.
Use positive y as the growth axis for primary forms.
Grow exactly two children from each primary form using entity/twig-a as the template and call them secondary forms.
Use positive y as the growth axis for secondary forms.
Use entity/trunk as the centre.
For each form in the secondary forms.
  Make it 60 percent as long and 40 percent as thick as its parent.
  Set its position to [0, 0, 0].
  Point its growth axis away from the centre.
  Let placement be 30 percent plus its sibling number divided by the total number of siblings times 50 percent.
  Attach its base to its parent at placement from base to tip.
End.
`, { project: projectFixture() });
  const duplicate = compiled.operations[0];
  const patches = compiled.operations.slice(1);
  assert.equal(duplicate.op, 'entity.duplicateMany');
  assert.deepEqual(duplicate.items.map(item => item.parentId), ['entity/branch', 'entity/branch']);
  for (const patch of patches) {
    assert.ok(Math.abs(patch.patch.transform.scale[0] - 1.6) < 1e-9);
    assert.ok(Math.abs(patch.patch.transform.scale[1] - 1.2) < 1e-9);
    assert.ok(Math.abs(patch.patch.transform.scale[2] - 1.6) < 1e-9);
  }
  assert.notDeepEqual(patches[0].patch.transform.position, patches[1].patch.transform.position);
  assert.ok(compiled.operations.every(operation => operationSchema.safeParse(operation).success));
  assert.match(compiled.interpretation.join('\n'), /grow 2 children from each of 1 parents/u);
});

test('Plainform fails closed when a spatial relation names a non-singular selection', () => {
  assert.throws(
    () => new PlainformCompiler().compile(`
Find every visible mesh that is tagged "leaf".
Call them targets.
Find every visible mesh that is tagged "twig".
Call them movers.
For each mover in the movers.
  Face it away from targets.
End.
`, { project: projectFixture() }),
    error => error instanceof PlainformError && error.code === 'plainform_reference_not_singular',
  );
});

test('Plainform fails closed on ambiguous or unsupported natural language', () => {
  assert.throws(
    () => new PlainformCompiler().compile('Make the tree nicer.', { project: projectFixture() }),
    error => error instanceof PlainformError && error.code === 'plainform_unknown_statement'
      && error.details.statement === 1,
  );
});

test('Shader Plainform composes descriptive feel words with typed trigonometric math chains', () => {
  const source = [
    'Create a shader graph called "Living Rain" with id graph/living-rain.',
    'Describe it as very wet, ancient, mossy and softly glowing.',
    'Let slow pulse be sin(time * 2 + cos(time * 0.5)).',
    'Let shaped pulse be smoothstep(0.2, 0.8, slow pulse).',
    'Set roughness to clamp(0.72 + shaped pulse * 0.12, 0, 1).',
    'Set emission strength to saturate(shaped pulse * 2).',
    'Apply it to material/tree-bark.',
  ].join('\n');
  const compiled = new PlainformCompiler().compile(source, { project: projectFixture() });
  assert.equal(compiled.dialect, 'shader');
  assert.equal(compiled.requestedPreview, false);
  assert.deepEqual(compiled.operations.map(operation => operation.op), ['resource.create', 'resource.patch']);
  assert.ok(compiled.operations.every(operation => operationSchema.safeParse(operation).success));
  const graph = compiled.operations[0].resource.graph;
  assert.equal(graph.outputs.surface.nodeId, 'principled-surface');
  assert.ok(graph.nodes.some(node => node.type === 'input.time'));
  assert.ok(graph.nodes.some(node => node.type === 'blender.math' && node.params.operation === 'SINE'));
  assert.ok(graph.nodes.some(node => node.type === 'blender.math' && node.params.operation === 'COSINE'));
  assert.ok(graph.edges.some(edge => edge.to.nodeId === 'principled-surface' && edge.to.port === 'roughness'));
  assert.ok(graph.edges.some(edge => edge.to.nodeId === 'principled-surface' && edge.to.port === 'emissionStrength'));
  assert.ok(compiled.shader.descriptors.includes('wet'));
  assert.ok(compiled.shader.descriptors.includes('mossy'));
  assert.equal(compiled.operations[1].patch.graphId, 'graph/living-rain');
});

test('Shader Plainform accepts mathematician-style English expressions and procedural chains', () => {
  const compiled = new PlainformCompiler().compile([
    'Create a shader graph called Harmonic Stone.',
    'Describe it as weathered, rough and cold.',
    'Let harmonic be the sine of time times 2 plus the cosine of time divided by 3.',
    'Let grain be fbm(harmonic).',
    'Set roughness to remap(grain, 0, 1, 0.55, 0.92).',
  ].join('\n'), { project: projectFixture() });
  const graph = compiled.operations[0].resource.graph;
  assert.ok(graph.nodes.some(node => node.type === 'noise.fbm'));
  assert.ok(graph.nodes.some(node => node.type === 'blender.math' && node.params.operation === 'SINE'));
  assert.ok(graph.nodes.some(node => node.type === 'blender.math' && node.params.operation === 'COSINE'));
  assert.ok(graph.nodes.some(node => node.type === 'blender.math' && node.params.operation === 'DIVIDE'));
  assert.ok(graph.edges.some(edge => edge.to.nodeId === 'principled-surface' && edge.to.port === 'roughness'));
});

test('Shader Plainform preserves open-ended aesthetic language while known terms produce Principled values', () => {
  const compiled = new PlainformCompiler().compile([
    'Create a material graph called Dream Bark.',
    'Make it feel hand-painted, whimsical, velvety and moon-kissed.',
    'Set base color to #526b3f.',
    'Set coat roughness to 0.18.',
  ].join('\n'), { project: projectFixture() });
  const resource = compiled.operations[0].resource;
  const surface = resource.graph.nodes.find(node => node.id === 'principled-surface');
  assert.deepEqual(surface.inputs.baseColor, [82 / 255, 107 / 255, 63 / 255, 1]);
  assert.ok(surface.inputs.sheenWeight > 0);
  assert.ok(resource.metadata.plainform.openDescriptors.includes('moon-kissed'));
  assert.ok(resource.metadata.plainform.descriptors.includes('hand-painted'));
});

test('Shader Plainform accepts the same natural preview request as object Plainform', () => {
  const compiled = new PlainformCompiler().compile([
    'Create a shader graph called Preview Glass.',
    'Set roughness to 0.2.',
    'Preview these changes.',
  ].join('\n'), { project: projectFixture() });
  assert.equal(compiled.dialect, 'shader');
  assert.equal(compiled.requestedPreview, true);
  assert.match(compiled.interpretation.at(-1), /dry-run preview/u);
});

test('Shader Plainform rejects unknown functions and incompatible colour assignments', () => {
  assert.throws(
    () => new PlainformCompiler().compile([
      'Create a shader graph called Unsafe.',
      'Set roughness to mystery(time).',
    ].join('\n'), { project: projectFixture() }),
    error => error.code === 'plainform_shader_unknown_function',
  );
  assert.throws(
    () => new PlainformCompiler().compile([
      'Create a shader graph called Wrong Type.',
      'Set roughness to #ffffff.',
    ].join('\n'), { project: projectFixture() }),
    error => error.code === 'plainform_shader_type_mismatch',
  );
});
