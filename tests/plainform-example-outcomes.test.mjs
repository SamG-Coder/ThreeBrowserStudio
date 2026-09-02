import assert from 'node:assert/strict';
import test from 'node:test';

import { AuthoringKernel, createProjectDocument } from '../src/core/index.mjs';
import {
  composeTransformMatrix,
  multiplyTransformMatrices,
  transformPointByMatrix,
} from '../src/core/transform-math.mjs';
import { realizeSurfaceTriangles } from '../src/plainform/constrained-surface.mjs';
import { PlainformCompiler } from '../src/plainform/index.mjs';

function exampleProject() {
  return createProjectDocument({
    projectId: 'project/plainform-examples',
    resources: {
      materials: [{ id: 'material/leaf', recipe: { kind: 'physical', color: '#888888' } }],
    },
    scenes: [{ id: 'scene/main', rootEntityIds: [], entities: [] }],
  });
}

function compileDesign(source) {
  return new PlainformCompiler().compile(source.trim(), { project: exampleProject() });
}

function resourcesOf(compiled) {
  return compiled.operations
    .filter(operation => operation.op === 'resource.createMany')
    .flatMap(operation => operation.items.map(item => item.resource));
}

function rootOf(compiled) {
  return compiled.operations.find(operation => operation.op === 'entity.create')?.entity;
}

function entitiesOf(compiled) {
  return compiled.operations
    .filter(operation => operation.op === 'entity.createMany')
    .flatMap(operation => operation.items.map(item => item.entity));
}

function entityOf(compiled, entityId) {
  const entity = entitiesOf(compiled).find(item => item.id === entityId);
  assert.ok(entity, `missing entity ${entityId}`);
  return entity;
}

function recipeOf(compiled, entityId) {
  const geometryId = entityOf(compiled, entityId).components.mesh.geometryId;
  const resource = resourcesOf(compiled).find(item => item.id === geometryId);
  assert.ok(resource?.recipe, `missing recipe for ${entityId} (${geometryId})`);
  return resource.recipe;
}

function worldMatrixOf(compiled, entityId) {
  const root = rootOf(compiled);
  const entity = entityOf(compiled, entityId);
  const local = composeTransformMatrix(entity.transform ?? {});
  if (!root || entity.parentId !== root.id) return local;
  return multiplyTransformMatrices(composeTransformMatrix(root.transform), local);
}

function realizeEntity(compiled, entityId) {
  return realizeSurfaceTriangles({
    recipe: recipeOf(compiled, entityId),
    matrix: worldMatrixOf(compiled, entityId),
    entityId,
  });
}

function meshFacts(mesh) {
  const counts = new Map();
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const triangle = mesh.indices.slice(offset, offset + 3);
    for (const [from, to] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) {
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const point of mesh.worldPositions) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  }
  const size = max.map((value, axis) => value - min[axis]);
  return {
    vertexCount: mesh.worldPositions.length,
    triangleCount: mesh.indices.length / 3,
    boundaryEdgeCount: [...counts.values()].filter(count => count === 1).length,
    watertight: [...counts.values()].every(count => count === 2),
    min,
    max,
    size,
    center: min.map((value, axis) => (value + max[axis]) / 2),
  };
}

function inspectEntity(compiled, entityId) {
  return {
    entity: entityOf(compiled, entityId),
    recipe: recipeOf(compiled, entityId),
    facts: meshFacts(realizeEntity(compiled, entityId)),
  };
}

function almostEqual(actual, expected, epsilon = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);
}

function throwsCode(source, code) {
  assert.throws(() => compileDesign(source), error => error.code === code);
}

function flattenForKernel(operations) {
  return operations.flatMap((operation) => {
    if (operation.op === 'resource.createMany') {
      return operation.items.map(item => ({
        op: 'resource.create',
        resourceType: item.resourceType,
        resource: item.resource,
      }));
    }
    if (operation.op === 'entity.createMany') {
      return operation.items.map(item => ({
        op: 'entity.create',
        sceneId: operation.sceneId,
        entity: item.entity,
      }));
    }
    return [operation];
  });
}

test('example: semantic-frame box sits on authored world axes, not the private loft basis', () => {
  const compiled = compileDesign(`
Design a block called Semantic Box with id entity/semantic-box using the right-up-forward design frame.
Create a box called Block with id entity/block, with width 40 centimetres, height 20 centimetres, and depth 80 centimetres, centred at [0 metres right, 30 centimetres up, 0 metres forward].
`);
  const root = rootOf(compiled);
  assert.deepEqual(root.transform.rotation, [-Math.PI / 2, 0, 0]);
  const { facts } = inspectEntity(compiled, 'entity/block');
  almostEqual(facts.size[0], 0.4);
  almostEqual(facts.size[1], 0.2);
  almostEqual(facts.size[2], 0.8);
  almostEqual(facts.center[1], 0.3);
  assert.equal(facts.watertight, true);
});

test('example: legacy-frame box keeps an identity root and authored XYZ', () => {
  const compiled = compileDesign(`
Design a block called Legacy Box with id entity/legacy-box.
Create a box called Block with id entity/legacy-block, with width 1 metre, height 2 metres, and depth 3 metres, centred at [1 metre, 2 metres, 3 metres].
`);
  assert.deepEqual(rootOf(compiled).transform.rotation, [0, 0, 0]);
  const { entity, facts } = inspectEntity(compiled, 'entity/legacy-block');
  assert.deepEqual(entity.transform.position, [1, 2, 3]);
  assert.deepEqual(entity.transform.scale, [1, 2, 3]);
  almostEqual(facts.size[0], 1);
  almostEqual(facts.size[1], 2);
  almostEqual(facts.size[2], 3);
  almostEqual(facts.center[1], 2);
});

test('example: Design sphere is a closed full ball with no thetaLength', () => {
  const compiled = compileDesign(`
Design a ball called Full Sphere with id entity/full-sphere.
Create a sphere called Ball with id entity/ball, with radius 50 centimetres, centred at [0, 0, 0].
`);
  const { recipe, facts } = inspectEntity(compiled, 'entity/ball');
  assert.equal(recipe.kind, 'sphere');
  assert.equal(recipe.radius, 0.5);
  assert.equal('thetaLength' in recipe, false);
  almostEqual(facts.size[0], 1, 0.02);
  almostEqual(facts.size[1], 1, 0.02);
  almostEqual(facts.size[2], 1, 0.02);
  assert.ok(facts.boundaryEdgeCount > 0, 'UV-sphere realization keeps a seam, so it is not manifold-watertight');
  assert.equal(facts.watertight, false);
});

test('example: ellipsoid is a scaled closed sphere, not an open bowl', () => {
  const compiled = compileDesign(`
Design a skull called Closed Ellipsoid with id entity/closed-ellipsoid using the right-up-forward design frame.
Create an ellipsoid called Skull with id entity/skull, with width 24 centimetres, height 20 centimetres, and depth 26 centimetres, centred at [0 metres right, 10 centimetres up, 0 metres forward].
`);
  const { entity, recipe, facts } = inspectEntity(compiled, 'entity/skull');
  assert.equal(recipe.kind, 'sphere');
  assert.equal(entity.metadata.plainformDesign.primitive, 'ellipsoid');
  assert.deepEqual(entity.transform.scale, [0.24, 0.2, 0.26]);
  assert.equal(facts.watertight, false);
  almostEqual(facts.size[0], 0.24, 0.01);
  almostEqual(facts.size[1], 0.2, 0.01);
  almostEqual(facts.size[2], 0.26, 0.01);
  almostEqual(facts.center[1], 0.1, 0.01);
});

test('example: lofted smooth profile is a capped watertight solid', () => {
  const compiled = compileDesign(`
Design a hull called Smooth Loft with id entity/smooth-loft using the right-up-forward design frame.
Create a smooth profile called hull section through [0 centimetres right, 12 centimetres up], [9 centimetres right, 0 centimetres up], [0 centimetres right, 12 centimetres down], [-9 centimetres right, 0 centimetres up].
Add a controlled section of hull section at 8 centimetres backward, width 16 centimetres, height 22 centimetres.
Add a controlled section of hull section at 8 centimetres forward, width 16 centimetres, height 22 centimetres.
Loft a watertight solid called Hull with id entity/hull through all sections of hull section.
`);
  const { recipe, facts } = inspectEntity(compiled, 'entity/hull');
  assert.equal(recipe.kind, 'loft');
  assert.equal(recipe.closedProfile, true);
  assert.equal(recipe.capStart, true);
  assert.equal(recipe.capEnd, true);
  assert.equal(facts.watertight, true);
  assert.equal(facts.boundaryEdgeCount, 0);
  assert.ok(facts.size[2] > 0.14, `loft depth ${facts.size[2]} should span the two stations`);
});

test('example: an unsmoothed U-looking profile still lofts closed and capped', () => {
  const compiled = compileDesign(`
Design a bowl attempt called Open Profile Loft with id entity/open-profile-loft using the right-up-forward design frame.
Create a profile called bowl section through [8 centimetres right, 8 centimetres up], [10 centimetres right, 0 centimetres up], [8 centimetres right, 10 centimetres down], [0 centimetres right, 12 centimetres down].
Add a controlled section of bowl section at 6 centimetres backward, width 20 centimetres, height 20 centimetres.
Add a controlled section of bowl section at 6 centimetres forward, width 20 centimetres, height 20 centimetres.
Loft a watertight solid called Fake Bowl with id entity/fake-bowl through all sections of bowl section.
`);
  const { recipe, facts } = inspectEntity(compiled, 'entity/fake-bowl');
  assert.equal(recipe.closedProfile, true);
  assert.equal(recipe.capStart, true);
  assert.equal(recipe.capEnd, true);
  assert.equal(facts.watertight, true);
});

test('example: constrained patch is an open uncapped skin', () => {
  const compiled = compileDesign(`
Design a connector called Patch Study with id entity/patch-study.
Create a box called Roof with id entity/roof, with width 2 metres, height 20 centimetres, and depth 1 metre, centred at [0 metres, 1.5 metres, 0 metres].
Create a box called Cowl with id entity/cowl, with width 2.2 metres, height 20 centimetres, and depth 1 metre, centred at [0 metres, 50 centimetres, -1 metre].
Name a boundary called roof front on Roof through design points [-1 metre, 1.4 metres, -50 centimetres], [0 metres, 1.5 metres, -55 centimetres], [1 metre, 1.4 metres, -50 centimetres].
Name a boundary called cowl rear on Cowl through design points [1.1 metres, 60 centimetres, -50 centimetres], [0 metres, 65 centimetres, -55 centimetres], [-1.1 metres, 60 centimetres, -50 centimetres].
Create a constrained surface patch called Windshield with id entity/windshield between $roof-front and $cowl-rear, with positional continuity.
`);
  const { recipe, facts } = inspectEntity(compiled, 'entity/windshield');
  assert.equal(recipe.kind, 'loft');
  assert.equal(recipe.closedProfile, false);
  assert.equal(recipe.capStart, false);
  assert.equal(recipe.capEnd, false);
  assert.equal(facts.watertight, false);
  assert.ok(facts.boundaryEdgeCount >= 4);
});

test('example: boundary blend is an open fairing, not a CSG weld', () => {
  const compiled = compileDesign(`
Design a fairing called Blend Study with id entity/blend-study.
Create a box called Upper with id entity/upper, with width 2 metres, height 40 centimetres, and depth 1 metre, centred at [0 metres, 60 centimetres, 0 metres].
Create a box called Lower with id entity/lower, with width 2 metres, height 40 centimetres, and depth 1 metre, centred at [0 metres, -60 centimetres, 0 metres].
Create a surface curve called upper rail on Upper through surface points nearest to local points [-80 centimetres, -20 centimetres, 50 centimetres], [0 metres, -20 centimetres, 50 centimetres], [80 centimetres, -20 centimetres, 50 centimetres].
Create a surface curve called lower rail on Lower through surface points nearest to local points [-80 centimetres, 20 centimetres, 50 centimetres], [0 metres, 20 centimetres, 50 centimetres], [80 centimetres, 20 centimetres, 50 centimetres].
Blend $upper-rail into $lower-rail over 25 centimetres as a surface called Fairing Skin with id entity/fairing-skin, with curvature continuity.
`);
  const { recipe, facts } = inspectEntity(compiled, 'entity/fairing-skin');
  assert.equal(recipe.closedProfile, false);
  assert.equal(facts.watertight, false);
  assert.ok(facts.size[1] > 0.5, `blend should span the gap, height was ${facts.size[1]}`);
});

test('example: Open on a box face removes whole front triangles, not a CAD-sized hole', () => {
  const compiled = compileDesign(`
Design a vented panel called Box Open with id entity/box-open.
Create a box called Housing with id entity/housing, with width 2 metres, height 2 metres, and depth 40 centimetres.
Create a closed surface curve called opening on Housing through surface points nearest to local points [-40 centimetres, -40 centimetres, 20 centimetres], [40 centimetres, -40 centimetres, 20 centimetres], [40 centimetres, 40 centimetres, 20 centimetres], [-40 centimetres, 40 centimetres, 20 centimetres].
Imprint $opening into Housing.
Open Housing along $opening.
`);
  const open = rootOf(compiled).metadata.plainformDesign.surfaceDeformations.find(item => item.kind === 'open');
  const { recipe, facts } = inspectEntity(compiled, 'entity/housing');
  assert.equal(recipe.kind, 'indexedMesh');
  assert.equal(facts.watertight, false);
  assert.ok(open.removedTriangleCount >= 1);
  assert.equal(facts.triangleCount, 12 - open.removedTriangleCount);
  almostEqual(facts.size[0], 2, 0.01);
  almostEqual(facts.size[1], 2, 0.01);
  almostEqual(facts.size[2], 0.4, 0.01);
  assert.ok(facts.size[1] > 1.5, 'box Open must keep the panel height, not collapse to a band');
});

test('example: Open on a sphere latitude deletes both poles and leaves a jagged band', () => {
  const compiled = compileDesign(`
Design a study called Sphere Equator Open with id entity/sphere-equator-open.
Create a sphere called Ball with id entity/ball, with radius 50 centimetres, centred at [0, 0, 0].
Create a closed surface curve called rim on Ball through surface points nearest to design points [0 metres, 0 metres, 50 centimetres], [35 centimetres, 0 metres, 35 centimetres], [50 centimetres, 0 metres, 0 metres], [35 centimetres, 0 metres, -35 centimetres], [0 metres, 0 metres, -50 centimetres], [-35 centimetres, 0 metres, -35 centimetres], [-50 centimetres, 0 metres, 0 metres], [-35 centimetres, 0 metres, 35 centimetres].
Imprint $rim into Ball.
Open Ball along $rim.
`);
  const open = rootOf(compiled).metadata.plainformDesign.surfaceDeformations.find(item => item.kind === 'open');
  const { facts } = inspectEntity(compiled, 'entity/ball');
  assert.equal(facts.watertight, false);
  assert.ok(open.boundaryEdgeCount > 60, `expected a tessellation zigzag, got ${open.boundaryEdgeCount} edges`);
  assert.ok(facts.size[1] < 0.75, `remaining Y ${facts.size[1]} is still too tall to be a pole-cut band`);
  assert.ok(facts.min[1] > -0.45, `south pole remains at ${facts.min[1]}`);
  assert.ok(facts.max[1] < 0.45, `north pole remains at ${facts.max[1]}`);
  assert.ok(facts.center[1] < 0.2 && facts.center[1] > -0.2, 'band should sit around the equator');
});

test('example: galea-style Open+Shell on an ellipsoid is a cuff, not a helmet bowl', () => {
  const compiled = compileDesign(`
Design a helmet called Galea Bowl Attempt with id entity/galea-bowl-attempt using the right-up-forward design frame.
Create an ellipsoid called Skull Form with id entity/gallic-bowl/skull, with width 24 centimetres, height 20 centimetres, and depth 26 centimetres, centred at [0 metres right, 10 centimetres up, 0 metres forward], using material material/leaf.
Create a closed surface curve called rim opening on Skull Form through surface points nearest to design points [0 metres right, 6 centimetres up, 12 centimetres forward], [8 centimetres right, 6 centimetres up, 8.5 centimetres forward], [11 centimetres right, 6 centimetres up, 0 metres forward], [8 centimetres right, 6 centimetres up, 8.5 centimetres backward], [0 metres right, 6 centimetres up, 12 centimetres backward], [8 centimetres left, 6 centimetres up, 8.5 centimetres backward], [11 centimetres left, 6 centimetres up, 0 metres forward], [8 centimetres left, 6 centimetres up, 8.5 centimetres forward].
Imprint $rim-opening into Skull Form.
Open Skull Form along $rim-opening.
Shell Skull Form inward by 3 millimetres, leaving $rim-opening open.
`);
  const deformations = rootOf(compiled).metadata.plainformDesign.surfaceDeformations;
  assert.deepEqual(deformations.map(item => item.kind), ['imprint', 'open', 'shell']);
  const { facts } = inspectEntity(compiled, 'entity/gallic-bowl/skull');
  assert.ok(deformations[1].boundaryEdgeCount > 80, `Open edges ${deformations[1].boundaryEdgeCount} should be a zigzag, not a 48-seg latitude`);
  assert.equal(facts.watertight, true, 'Shell stitches every remaining boundary, so the cuff becomes a hollow closed ring');
  assert.ok(facts.size[1] < 0.14, `remaining height ${facts.size[1]} still looks like a dome`);
  assert.ok(facts.max[1] < 0.18, `crown remains at ${facts.max[1]}; a 20 cm ellipsoid centred at 10 cm should reach ~20 cm if the dome survived`);
  assert.ok(facts.min[1] > 0.03, `chin remains at ${facts.min[1]}`);
});

test('example: Imprint alone does not change the sphere mesh', () => {
  const compiled = compileDesign(`
Design a study called Imprint Only with id entity/imprint-only.
Create a sphere called Ball with id entity/ball, with radius 50 centimetres.
Create a closed surface curve called rim on Ball through surface points nearest to design points [0 metres, 0 metres, 50 centimetres], [50 centimetres, 0 metres, 0 metres], [0 metres, 0 metres, -50 centimetres], [-50 centimetres, 0 metres, 0 metres].
Imprint $rim into Ball.
`);
  assert.deepEqual(rootOf(compiled).metadata.plainformDesign.surfaceDeformations.map(item => item.kind), ['imprint']);
  const { recipe, facts } = inspectEntity(compiled, 'entity/ball');
  assert.equal(recipe.kind, 'sphere');
  almostEqual(facts.size[1], 1, 0.02);
});

test('example: Shell after a box Open thickens walls and keeps the hole', () => {
  const compiled = compileDesign(`
Design a vented panel called Boxed Shell with id entity/boxed-shell.
Create a box called Housing with id entity/housing, with width 2 metres, height 2 metres, and depth 40 centimetres.
Create a closed surface curve called opening on Housing through surface points nearest to local points [-40 centimetres, -40 centimetres, 20 centimetres], [40 centimetres, -40 centimetres, 20 centimetres], [40 centimetres, 40 centimetres, 20 centimetres], [-40 centimetres, 40 centimetres, 20 centimetres].
Imprint $opening into Housing.
Open Housing along $opening.
Shell Housing inward by 3 centimetres, leaving $opening open.
`);
  const { facts } = inspectEntity(compiled, 'entity/housing');
  assert.equal(facts.watertight, true, 'Shell always stitches the Open rim to the inner wall; leaving $opening open does not keep mesh-boundary holes');
  assert.equal(facts.boundaryEdgeCount, 0);
  assert.ok(facts.vertexCount >= 16, 'shell should duplicate the opened skin');
  almostEqual(facts.size[0], 2, 0.08);
  almostEqual(facts.size[1], 2, 0.08);
});

test('example: Shell on a closed Design sphere fails at unused pole-seam vertices', () => {
  throwsCode(`
Design a hollow ball called Closed Shell with id entity/closed-shell.
Create a sphere called Ball with id entity/ball, with radius 50 centimetres.
Shell Ball inward by 3 centimetres.
`, 'plainform_shell_degenerate_surface');
});

test('example: sweep follows the guide and is a closed tube solid', () => {
  const compiled = compileDesign(`
Design a rail called Sweep Study with id entity/sweep-study.
Create a rectangular profile called rail section with width 4 centimetres and depth 2 centimetres.
Create a smooth guide curve called rail path through [0 metres, 0 metres, 0 metres], [0 metres, 20 centimetres, 10 centimetres], [0 metres, 40 centimetres, 20 centimetres].
Sweep profile rail section along guide rail path as a solid called Rail with id entity/rail.
`);
  const { recipe, facts, entity } = inspectEntity(compiled, 'entity/rail');
  assert.equal(entity.metadata.plainformDesign.primitive, 'sweep');
  assert.equal(recipe.kind, 'indexedMesh');
  assert.equal(facts.watertight, true);
  assert.ok(facts.size[1] > 0.3, `sweep height ${facts.size[1]} should follow the 40 cm guide`);
});

test('example: extrude compiles to a bevelled recipe that later surface ops cannot realize', () => {
  const compiled = compileDesign(`
Design a splitter called Extrude Study with id entity/extrude-study.
Create a rectangular profile called plate with width 20 centimetres and depth 8 centimetres.
Extrude profile plate by 12 centimetres as a solid called Plate with id entity/plate, centred at [0 metres, 0 metres, 0 metres].
`);
  const recipe = recipeOf(compiled, 'entity/plate');
  assert.equal(recipe.kind, 'extrude');
  assert.equal(recipe.depth, 0.12);
  assert.equal(recipe.bevelEnabled, true);
  assert.throws(
    () => realizeEntity(compiled, 'entity/plate'),
    error => error.code === 'plainform_surface_deformation_unavailable',
  );
});

test('example: mirror copies a sweep across X and reverses it to the other side', () => {
  const compiled = compileDesign(`
Design a pair called Mirror Study with id entity/mirror-study.
Create a rectangular profile called pylon section with width 8 centimetres and depth 4 centimetres.
Create a smooth guide curve called left path through [-30 centimetres, 0 metres, 0 metres], [-35 centimetres, 30 centimetres, 5 centimetres], [-40 centimetres, 60 centimetres, 15 centimetres].
Sweep profile pylon section along guide left path as a solid called Left Pylon with id entity/left-pylon.
Create Right Pylon as the mirror of Left Pylon across the x centre plane with id entity/right-pylon.
`);
  const left = inspectEntity(compiled, 'entity/left-pylon');
  const right = inspectEntity(compiled, 'entity/right-pylon');
  assert.ok(left.facts.center[0] < -0.2);
  assert.ok(right.facts.center[0] > 0.2);
  almostEqual(right.facts.center[0], -left.facts.center[0], 0.02);
  almostEqual(right.facts.center[1], left.facts.center[1], 0.02);
});

test('example: a hanging cheek loft extends down, not out as a fin', () => {
  const compiled = compileDesign(`
Design a plate called Cheek Hang with id entity/cheek-hang using the right-up-forward design frame.
Create a profile called cheek section through [0 centimetres right, 4 centimetres up], [3 centimetres right, 0 centimetres up], [0 centimetres right, 4 centimetres down], [-3 centimetres right, 0 centimetres up].
Add a controlled section of cheek section at 0 centimetres forward, width 8 centimetres, height 10 centimetres, offset laterally by 10 centimetres, offset vertically by -2 centimetres.
Add a controlled section of cheek section at 2 centimetres forward, width 7 centimetres, height 12 centimetres, offset laterally by 11 centimetres, offset vertically by -16 centimetres.
Loft a watertight solid called Right Cheek with id entity/right-cheek through all sections of cheek section.
`);
  const { facts } = inspectEntity(compiled, 'entity/right-cheek');
  assert.ok(facts.center[0] > 0.05, 'cheek should sit on +X');
  assert.ok(facts.min[1] < -0.05, `hanging cheek should drop below the origin, minY=${facts.min[1]}`);
  assert.ok(facts.size[1] > facts.size[0], 'hanging cheek should be taller than it is wide');
});

test('example: a 70 degree yawed cheek loft reads as a side fin', () => {
  const compiled = compileDesign(`
Design a plate called Cheek Fin with id entity/cheek-fin using the right-up-forward design frame.
Create a profile called cheek section through [0 centimetres right, 4 centimetres up], [3 centimetres right, 0 centimetres up], [0 centimetres right, 4 centimetres down], [-3 centimetres right, 0 centimetres up].
Add a controlled section of cheek section at 0 centimetres forward, width 8 centimetres, height 10 centimetres, offset laterally by 10 centimetres, rotated by [0 degrees, 70 degrees, 0 degrees].
Add a controlled section of cheek section at 8 centimetres forward, width 8 centimetres, height 10 centimetres, offset laterally by 10 centimetres, rotated by [0 degrees, 70 degrees, 0 degrees].
Loft a watertight solid called Right Cheek with id entity/right-cheek through all sections of cheek section.
`);
  const { facts } = inspectEntity(compiled, 'entity/right-cheek');
  assert.ok(facts.size[0] > facts.size[1] * 0.8, `yawed cheek became a lateral fin: size=${facts.size.join(',')}`);
});

test('example: cylinder annulus compiles to a same-kind CSG subtract', () => {
  const compiled = compileDesign(`
Design a ring called Annulus Study with id entity/annulus-study.
Create a cylinder called Outer Ring with id entity/outer-ring, with radius 54 centimetres and height 7 centimetres, centred at [0 metres, 0 metres, 0 metres], rotated by [90 degrees, 0 degrees, 0 degrees].
Create a cylinder called Inner Ring with id entity/inner-ring, with radius 47 centimetres and height 10 centimetres, centred at [0 metres, 0 metres, 0 metres], rotated by [90 degrees, 0 degrees, 0 degrees].
Subtract Inner Ring from Outer Ring.
`);
  const recipe = recipeOf(compiled, 'entity/outer-ring');
  assert.equal(recipe.kind, 'csg');
  assert.equal(recipe.operation, 'subtract');
  assert.equal(recipe.operands.length, 2);
  assert.equal(entityOf(compiled, 'entity/inner-ring').visible, false);
});

test('example: mixed boolean kinds on one target are rejected', () => {
  throwsCode(`
Design a bad chain called Mixed Boolean with id entity/mixed-boolean.
Create a box called Body with id entity/body, with width 1 metre, height 1 metre, and depth 1 metre.
Create a box called Cutter with id entity/cutter, with width 20 centimetres, height 20 centimetres, and depth 20 centimetres.
Create a box called Lump with id entity/lump, with width 10 centimetres, height 10 centimetres, and depth 10 centimetres.
Subtract Cutter from Body.
Union Lump with Body.
`, 'plainform_boolean_chain');
});

test('example: Open requires a closed surface curve', () => {
  throwsCode(`
Design a bad opening called Open Curve Opening with id entity/open-curve-opening.
Create a box called Panel with id entity/panel, with width 2 metres, height 2 metres, and depth 20 centimetres.
Create a surface curve called open rail on Panel through surface points nearest to local points [-40 centimetres, 0 metres, 50 centimetres], [40 centimetres, 0 metres, 50 centimetres].
Open Panel along $open-rail.
`, 'plainform_surface_split_not_closed');
});

test('example: Shell cannot leave a curve open until Open has made topology', () => {
  throwsCode(`
Design a bad shell called Shell Without Open with id entity/shell-without-open.
Create a box called Panel with id entity/panel, with width 2 metres, height 2 metres, and depth 20 centimetres.
Create a closed surface curve called opening on Panel through surface points nearest to local points [-40 centimetres, -40 centimetres, 10 centimetres], [40 centimetres, -40 centimetres, 10 centimetres], [40 centimetres, 40 centimetres, 10 centimetres], [-40 centimetres, 40 centimetres, 10 centimetres].
Shell Panel inward by 3 millimetres, leaving $opening open.
`, 'plainform_shell_open_boundary_requires_split');
});

test('example: cylinder aligned along forward points down world +Z', () => {
  const compiled = compileDesign(`
Design a peg called Forward Cylinder with id entity/forward-cylinder using the right-up-forward design frame.
Create a cylinder called Peg with id entity/peg, with radius 2 centimetres and height 20 centimetres, centred at [0 metres right, 10 centimetres up, 0 metres forward], aligned along the forward axis.
`);
  const { facts } = inspectEntity(compiled, 'entity/peg');
  assert.ok(facts.size[2] > facts.size[1], `forward cylinder should be long in Z, size=${facts.size.join(',')}`);
  almostEqual(facts.center[1], 0.1, 0.02);
});

test('example: capsule aligned up lands at the authored world point and cannot be surface-realized', () => {
  const compiled = compileDesign(`
Design a neck called Capsule Study with id entity/capsule-study using the right-up-forward design frame.
Create a capsule called Neck with id entity/neck, with radius 5 centimetres and body length 9 centimetres, centred at [0 metres right, 20 centimetres up, 2 centimetres backward], aligned along the up axis.
`);
  const recipe = recipeOf(compiled, 'entity/neck');
  assert.equal(recipe.kind, 'capsule');
  const world = transformPointByMatrix(worldMatrixOf(compiled, 'entity/neck'), [0, 0, 0]);
  almostEqual(world[1], 0.2, 0.03);
  almostEqual(world[2], -0.02, 0.03);
  assert.throws(
    () => realizeEntity(compiled, 'entity/neck'),
    error => error.code === 'plainform_surface_deformation_unavailable',
  );
});

test('example: raise on a 12-triangle box finds no vertices; a sphere region does move', () => {
  throwsCode(`
Design a panel called Raise Box Failure with id entity/raise-box-failure.
Create a box called Panel with id entity/panel, with width 2 metres, height 2 metres, and depth 20 centimetres.
Create a surface curve called ridge on Panel through surface points nearest to design points [-50 centimetres, 0 metres, 10 centimetres], [0 metres, 0 metres, 10 centimetres], [50 centimetres, 0 metres, 10 centimetres].
Raise the surface along ridge by 8 centimetres with a smooth falloff of 40 centimetres.
`, 'plainform_surface_deformation_empty');

  const compiled = compileDesign(`
Design a panel called Raise Sphere Study with id entity/raise-sphere-study.
Create a sphere called Head with id entity/head, with radius 1 metre.
Name the surface on Head around [0 metres, 0 metres, 1 metre] within 40 centimetres as nose.
Bulge nose by 8 centimetres, falling off smoothly over 30 centimetres.
`);
  const deformation = rootOf(compiled).metadata.plainformDesign.surfaceDeformations[0];
  assert.equal(deformation.kind, 'regionDisplacement');
  assert.ok(deformation.affectedVertexCount > 0);
  const { recipe, facts } = inspectEntity(compiled, 'entity/head');
  assert.equal(recipe.kind, 'indexedMesh');
  assert.ok(facts.size[2] > 2.05, `bulged sphere depth ${facts.size[2]} should exceed the 2 m diameter`);
});

test('example: Split + Call yields two non-overlapping meshes that reassemble the owner', () => {
  const compiled = compileDesign(`
Design a panel called Split Study with id entity/split-study.
Create a box called Housing with id entity/housing, with width 2 metres, height 2 metres, and depth 2 metres.
Create a closed surface curve called front perimeter on Housing through surface points nearest to local points [-50 centimetres, -50 centimetres, 1 metre], [50 centimetres, -50 centimetres, 1 metre], [50 centimetres, 50 centimetres, 1 metre], [-50 centimetres, 50 centimetres, 1 metre].
Split Housing along $front-perimeter.
Call the enclosed surface Front Panel with id entity/front-panel.
`);
  const housing = inspectEntity(compiled, 'entity/housing');
  const panel = inspectEntity(compiled, 'entity/front-panel');
  assert.equal(housing.recipe.kind, 'indexedMesh');
  assert.equal(panel.recipe.kind, 'indexedMesh');
  assert.equal(housing.facts.triangleCount + panel.facts.triangleCount, 12);
  assert.equal(housing.facts.watertight, false);
  assert.equal(panel.facts.watertight, false);
});

test('example: hair card is an open UV strip along the guide', () => {
  const compiled = compileDesign(`
Design a groom called Hair Card Study with id entity/hair-card-study using the right-up-forward design frame.
Create a smooth guide curve called fringe path through [-7 centimetres right, 11 centimetres up, 2 centimetres backward], [-5 centimetres right, 13 centimetres up, 3 centimetres forward], [-4 centimetres right, 8 centimetres up, 10 centimetres forward].
Groom a hair card called Fringe Card with id entity/fringe-card along guide fringe path, with width 3 centimetres, tapering to 10 percent.
`);
  const { recipe, facts } = inspectEntity(compiled, 'entity/fringe-card');
  assert.equal(recipe.kind, 'indexedMesh');
  assert.ok(Array.isArray(recipe.uvs));
  assert.equal(facts.watertight, false);
  assert.ok(facts.boundaryEdgeCount >= 4);
});

test('example: tapered cylinder keeps distinct top and bottom radii', () => {
  const compiled = compileDesign(`
Design a cone called Taper Study with id entity/taper-study using the right-up-forward design frame.
Create a tapered cylinder called Nose with id entity/nose, with bottom radius 4 centimetres, top radius 1 centimetre, and height 10 centimetres, centred at [0 metres right, 0 metres up, 0 metres forward], aligned along the up axis.
`);
  const { recipe, facts } = inspectEntity(compiled, 'entity/nose');
  assert.equal(recipe.kind, 'cylinder');
  almostEqual(recipe.radiusBottom, 0.04);
  almostEqual(recipe.radiusTop, 0.01);
  almostEqual(facts.size[1], 0.1, 0.01);
  assert.ok(facts.size[0] > 0.07 && facts.size[0] < 0.09);
});

test('example: kernel apply commits the box-open mesh so inspect can read indexed triangles', async () => {
  const source = `
Design a vented panel called Kernel Box Open with id entity/kernel-box-open.
Create a box called Housing with id entity/kernel-housing, with width 2 metres, height 2 metres, and depth 40 centimetres.
Create a closed surface curve called opening on Housing through surface points nearest to local points [-40 centimetres, -40 centimetres, 20 centimetres], [40 centimetres, -40 centimetres, 20 centimetres], [40 centimetres, 40 centimetres, 20 centimetres], [-40 centimetres, 40 centimetres, 20 centimetres].
Imprint $opening into Housing.
Open Housing along $opening.
`;
  const compiled = compileDesign(source);
  assert.ok(compiled.operations.some(operation => operation.op === 'entity.createMany'));
  const kernel = new AuthoringKernel(exampleProject());
  const applied = await kernel.apply({
    baseRevision: 0,
    idempotencyKey: 'plainform-example-kernel-box-open',
    label: 'Commit box-open example',
    operations: flattenForKernel(compiled.operations),
  });
  assert.equal(applied.success, true);
  const housing = kernel.document.scenes['scene/main'].entities['entity/kernel-housing'];
  const geometry = kernel.document.resources.geometries[housing.components.mesh.geometryId];
  assert.equal(geometry.recipe.kind, 'indexedMesh');
  assert.ok(geometry.recipe.indices.length < 36);
  assert.equal(kernel.document.revision, 1);
});

test('example: Design lowers entity.createMany, which the kernel rejects until the application flattens it', async () => {
  const compiled = compileDesign(`
Design a block called Create Many with id entity/create-many.
Create a box called Block with id entity/block, with width 1 metre, height 1 metre, and depth 1 metre.
`);
  assert.ok(compiled.operations.some(operation => operation.op === 'entity.createMany'));
  const kernel = new AuthoringKernel(exampleProject());
  await assert.rejects(
    kernel.apply({
      baseRevision: 0,
      idempotencyKey: 'plainform-example-unflattened-create-many',
      label: 'Reject unflattened createMany',
      operations: compiled.operations,
    }),
    error => error.code === 'unknown_operation',
  );
});

test('example: a two-section rectangular loft is a closed tube with end caps', () => {
  const compiled = compileDesign(`
Design a beam called Rect Loft with id entity/rect-loft.
Create a rectangular profile called beam with width 20 centimetres and depth 10 centimetres.
Add a section of the beam at height 0 metres.
Add a section of the beam at height 1 metre.
Loft a watertight solid called Beam with id entity/beam through all sections of the beam.
`);
  const { recipe, facts } = inspectEntity(compiled, 'entity/beam');
  assert.equal(recipe.closedProfile, true);
  assert.equal(recipe.capStart, true);
  assert.equal(recipe.capEnd, true);
  assert.equal(facts.watertight, true);
  almostEqual(facts.size[1], 1, 0.05);
});

test('example: projecting a profile onto a box records a closed curve and does not change pixels', () => {
  const compiled = compileDesign(`
Design a badge called Project Study with id entity/project-study.
Create a box called Housing with id entity/housing, with width 2 metres, height 2 metres, and depth 40 centimetres.
Create a rectangular profile called badge outline with width 20 centimetres and depth 12 centimetres.
Project profile badge outline onto Housing as housing badge, centred at [0 metres, 0 metres, 20 centimetres].
`);
  const { recipe, facts } = inspectEntity(compiled, 'entity/housing');
  assert.equal(recipe.kind, 'box');
  assert.equal(facts.triangleCount, 12);
  const curves = rootOf(compiled).metadata.plainformDesign.surfaceCurves;
  assert.equal(curves.length, 1);
  assert.equal(curves[0].closed, true);
  assert.equal(curves[0].projection.kind, 'profile');
  assert.ok(curves[0].authoredPoints.length >= 4);
  assert.ok(curves[0].anchors.length >= 4);
});

test('example: kernel apply of the sphere-equator Open still stores a band, not a bowl', async () => {
  const compiled = compileDesign(`
Design a study called Kernel Sphere Open with id entity/kernel-sphere-open.
Create a sphere called Ball with id entity/kernel-ball, with radius 50 centimetres.
Create a closed surface curve called rim on Ball through surface points nearest to design points [0 metres, 0 metres, 50 centimetres], [35 centimetres, 0 metres, 35 centimetres], [50 centimetres, 0 metres, 0 metres], [35 centimetres, 0 metres, -35 centimetres], [0 metres, 0 metres, -50 centimetres], [-35 centimetres, 0 metres, -35 centimetres], [-50 centimetres, 0 metres, 0 metres], [-35 centimetres, 0 metres, 35 centimetres].
Imprint $rim into Ball.
Open Ball along $rim.
`);
  const kernel = new AuthoringKernel(exampleProject());
  await kernel.apply({
    baseRevision: 0,
    idempotencyKey: 'plainform-example-kernel-sphere-open',
    label: 'Commit sphere-open example',
    operations: flattenForKernel(compiled.operations),
  });
  const ball = kernel.document.scenes['scene/main'].entities['entity/kernel-ball'];
  const geometry = kernel.document.resources.geometries[ball.components.mesh.geometryId];
  const mesh = realizeSurfaceTriangles({
    recipe: geometry.recipe,
    matrix: composeTransformMatrix(ball.transform),
    entityId: 'entity/kernel-ball',
  });
  const facts = meshFacts(mesh);
  assert.equal(facts.watertight, false);
  assert.ok(facts.size[1] < 0.75);
  assert.ok(facts.min[1] > -0.45);
  assert.ok(facts.max[1] < 0.45);
});
