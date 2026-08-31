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
