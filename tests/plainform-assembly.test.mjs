import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectDocument } from '../src/core/documents.mjs';
import {
  composeTransformMatrix, multiplyTransformMatrices, transformPointByMatrix,
} from '../src/core/transform-math.mjs';
import { operationSchema } from '../src/mcp/tool-schemas.mjs';
import { PlainformCompiler, parsePlainformProgram } from '../src/plainform/index.mjs';
import { compileAnimationAction, evaluateAnimationAction } from '../src/runtime/animation-runtime.mjs';

function projectFixture() {
  return createProjectDocument({
    projectId: 'project/plainform-assembly',
    resources: {
      geometries: [{ id: 'geometry/leaf', recipe: { kind: 'box' } }],
      materials: [{ id: 'material/leaf', recipe: { kind: 'physical', color: '#4f7a3a' } }],
    },
    scenes: [{
      id: 'scene/main', rootEntityIds: ['entity/tree'],
      entities: [{
        id: 'entity/tree', kind: 'group', name: 'Tree',
        children: ['entity/leaf-a', 'entity/leaf-b'],
      }, {
        id: 'entity/leaf-a', kind: 'mesh', name: 'Leaf A', parentId: 'entity/tree', tags: ['leaf'],
        transform: { position: [0, 1, 0] },
        components: { mesh: { geometryId: 'geometry/leaf', materialId: 'material/leaf' } },
      }, {
        id: 'entity/leaf-b', kind: 'mesh', name: 'Leaf B', parentId: 'entity/tree', tags: ['leaf'],
        transform: { position: [1, 1, 0] },
        components: { mesh: { geometryId: 'geometry/leaf', materialId: 'material/leaf' } },
      }],
    }],
  });
}

function emptyProject() {
  return createProjectDocument({
    projectId: 'project/plainform-assembly-empty',
    scenes: [{ id: 'scene/main', rootEntityIds: [], entities: [] }],
  });
}

function entitiesOf(compiled) {
  return compiled.operations
    .filter(operation => operation.op === 'entity.createMany')
    .flatMap(operation => operation.items.map(item => item.entity));
}

function rootOf(compiled) {
  return compiled.operations.find(operation => operation.op === 'entity.create')?.entity;
}

function worldOf(root, entity, ancestors = []) {
  const chain = [...ancestors, entity];
  return chain.reduce(
    (matrix, node) => multiplyTransformMatrices(matrix, composeTransformMatrix(node.transform ?? {})),
    composeTransformMatrix(root.transform),
  );
}

test('typed assembly AST covers continue, group, parent, torus, and lathe', () => {
  const ast = parsePlainformProgram([
    'Continue the design entity/jeep using the right-up-forward design frame.',
    'Create a group called Front Hub with id entity/hub-fl, centred at [82 centimetres left, 42 centimetres up, 1.23 metres forward].',
    'Put Front Left Tire under Front Hub, keeping world pose.',
    'Create a torus called Wheel Rim with id entity/rim, with ring radius 18 centimetres and tube radius 16 millimetres, centred at [0 metres right, 42 centimetres up, 1.23 metres forward], aligned along the right axis.',
    'Lathe profile tire section around the right axis as a solid called Tire with id entity/tire.',
  ].join('\n'));
  assert.equal(ast.dialect, 'design');
  assert.deepEqual(ast.statements.map(statement => statement.kind), [
    'design.continue',
    'assembly.createGroup',
    'assembly.parentWorldPose',
    'primitive.createTorus',
    'primitive.latheProfile',
  ]);
});

test('Design Plainform empty group world centre matches authored right-up-forward point', () => {
  const compiled = new PlainformCompiler().compile(`
Design a vehicle called Assembly Rig with id entity/assembly-rig using the right-up-forward design frame.
Create a group called Front Hub with id entity/hub-fl, centred at [82 centimetres left, 42 centimetres up, 1.23 metres forward].
`, { project: emptyProject() });
  assert.ok(compiled.operations.every(operation => operationSchema.safeParse(operation).success));
  const root = rootOf(compiled);
  const hub = entitiesOf(compiled).find(entity => entity.id === 'entity/hub-fl');
  assert.equal(hub.kind, 'group');
  assert.equal(hub.parentId, root.id);
  const world = transformPointByMatrix(worldOf(root, hub), [0, 0, 0]).map(value => Math.round(value * 1e9) / 1e9);
  assert.deepEqual(world, [-0.82, 0.42, 1.23]);
});

test('parenting keeping world pose does not move generated children', () => {
  const compiled = new PlainformCompiler().compile(`
Design a vehicle called Assembly Rig with id entity/assembly-rig using the right-up-forward design frame.
Create a group called Front Hub with id entity/hub-fl, centred at [82 centimetres left, 42 centimetres up, 1.23 metres forward].
Create a cylinder called Front Left Tire with id entity/tire-fl, with radius 42 centimetres and height 27 centimetres, centred at [82 centimetres left, 42 centimetres up, 1.23 metres forward], aligned along the right axis.
Put Front Left Tire under Front Hub, keeping world pose.
`, { project: emptyProject() });
  const root = rootOf(compiled);
  const hub = entitiesOf(compiled).find(entity => entity.id === 'entity/hub-fl');
  const tire = entitiesOf(compiled).find(entity => entity.id === 'entity/tire-fl');
  assert.equal(tire.parentId, 'entity/hub-fl');
  const tireWorld = transformPointByMatrix(worldOf(root, tire, [hub]), [0, 0, 0]).map(value => Math.round(value * 1e9) / 1e9);
  assert.deepEqual(tireWorld, [-0.82, 0.42, 1.23]);
});

test('parenting without keeping world pose fails when the child would jump', () => {
  assert.throws(
    () => new PlainformCompiler().compile(`
Design a vehicle called Assembly Rig with id entity/assembly-rig using the right-up-forward design frame.
Create a group called Front Hub with id entity/hub-fl, centred at [82 centimetres left, 42 centimetres up, 1.23 metres forward].
Create a cylinder called Front Left Tire with id entity/tire-fl, with radius 42 centimetres and height 27 centimetres, centred at [82 centimetres left, 42 centimetres up, 1.23 metres forward], aligned along the right axis.
Put Front Left Tire under Front Hub.
`, { project: emptyProject() }),
    error => error.code === 'plainform_parent_world_pose_required',
  );
});

test('Continue the design appends children to the existing root', () => {
  const compiler = new PlainformCompiler();
  const first = compiler.compile(`
Design a vehicle called Trail Jeep with id entity/jeep using the right-up-forward design frame.
Create a box called Body with id entity/jeep-body, with width 1 metre, height 1 metre, and depth 2 metres, centred at [0 metres right, 1 metre up, 0 metres forward].
`, { project: emptyProject() });
  const root = rootOf(first);
  const body = entitiesOf(first).find(entity => entity.id === 'entity/jeep-body');
  const document = createProjectDocument({
    projectId: 'project/plainform-continue',
    scenes: [{
      id: 'scene/main',
      rootEntityIds: [root.id],
      entities: [{ ...root, children: [body.id] }, body],
    }],
  });
  const continued = compiler.compile(`
Continue the design entity/jeep using the right-up-forward design frame.
Create a group called Front Axle with id entity/front-axle, centred at [0 metres right, 42 centimetres up, 1.23 metres forward].
`, { project: document });
  assert.equal(continued.design.rootId, 'entity/jeep');
  assert.ok(!continued.operations.some(operation => operation.op === 'entity.create' && operation.entity?.id === 'entity/jeep'));
  const axle = entitiesOf(continued).find(entity => entity.id === 'entity/front-axle');
  assert.equal(axle.parentId, 'entity/jeep');
  assert.throws(
    () => compiler.compile(`
Continue the design entity/jeep using the legacy-xz-y design frame.
Create a group called Spare with id entity/spare-pivot, centred at [0 metres, 1 metre, 0 metres].
`, { project: document }),
    error => error.code === 'plainform_continue_frame_mismatch',
  );
});

test('Continue reuses occupied unit geometries instead of colliding', () => {
  const compiler = new PlainformCompiler();
  const first = compiler.compile(`
Design a vehicle called Trail Jeep with id entity/jeep using the right-up-forward design frame.
Create a cylinder called Marker with id entity/marker, with radius 10 centimetres and height 20 centimetres, centred at [0 metres right, 50 centimetres up, 0 metres forward].
`, { project: emptyProject() });
  const root = rootOf(first);
  const marker = entitiesOf(first).find(entity => entity.id === 'entity/marker');
  const cylinderId = marker.components.mesh.geometryId;
  const document = createProjectDocument({
    projectId: 'project/plainform-continue-units',
    resources: {
      geometries: [{ id: cylinderId, recipe: { kind: 'cylinder', radiusTop: 1, radiusBottom: 1, height: 1, radialSegments: 32 } }],
    },
    scenes: [{
      id: 'scene/main',
      rootEntityIds: [root.id],
      entities: [{ ...root, children: [marker.id] }, marker],
    }],
  });
  const continued = compiler.compile(`
Continue the design entity/jeep using the right-up-forward design frame.
Create a cylinder called Lamp with id entity/lamp, with radius 9 centimetres and height 8 centimetres, centred at [50 centimetres left, 84 centimetres up, 1.94 metres forward], aligned along the forward axis.
`, { project: document });
  assert.equal(entitiesOf(continued).find(entity => entity.id === 'entity/lamp').components.mesh.geometryId, cylinderId);
  assert.ok(!(continued.operations.find(operation => operation.op === 'resource.createMany')?.items ?? [])
    .some(item => item.resource.id === cylinderId));
});

test('torus and lathe lower to recipes aligned on the requested axis', () => {
  const compiled = new PlainformCompiler().compile(`
Design a vehicle called Round Parts with id entity/round-parts using the right-up-forward design frame.
Create a symmetric smooth profile called tire section through [20 centimetres right, 13 centimetres up], [42 centimetres right, 4 centimetres up], [42 centimetres right, 4 centimetres down], [20 centimetres right, 13 centimetres down].
Create a torus called Wheel Rim with id entity/rim, with ring radius 18 centimetres and tube radius 16 millimetres, centred at [0 metres right, 42 centimetres up, 0 metres forward], aligned along the right axis.
Lathe profile tire section around the right axis as a solid called Tire with id entity/tire, centred at [82 centimetres left, 42 centimetres up, 1.23 metres forward].
`, { project: emptyProject() });
  const resources = compiled.operations.find(operation => operation.op === 'resource.createMany').items.map(item => item.resource);
  const torus = resources.find(resource => resource.recipe.kind === 'torus');
  const lathe = resources.find(resource => resource.recipe.kind === 'lathe');
  assert.equal(torus.recipe.radius, 0.18);
  assert.equal(torus.recipe.tube, 0.016);
  assert.ok(lathe.recipe.points.length >= 4);
  const root = rootOf(compiled);
  const rim = entitiesOf(compiled).find(entity => entity.id === 'entity/rim');
  const rimWorld = worldOf(root, rim);
  assert.deepEqual(transformPointByMatrix(rimWorld, [0, 0, 0]).map(value => Math.round(value * 1e9) / 1e9), [0, 0.42, 0]);
});

test('a four-wheel two-axle fixture exposes world-identity knuckle yaw and spin roll', () => {
  const compiled = new PlainformCompiler().compile(`
Design a vehicle called Rig with id entity/rig using the right-up-forward design frame.
Create a group called Front Axle with id entity/front-axle, centred at [0 metres right, 42 centimetres up, 1.23 metres forward].
Create a group called Rear Axle with id entity/rear-axle, centred at [0 metres right, 42 centimetres up, 1.23 metres backward].
Create a group called Front Left Knuckle with id entity/knuckle-fl, centred at [82 centimetres left, 42 centimetres up, 1.23 metres forward].
Create a group called Front Right Knuckle with id entity/knuckle-fr, centred at [82 centimetres right, 42 centimetres up, 1.23 metres forward].
Create a group called Front Left Spin with id entity/spin-fl, centred at [82 centimetres left, 42 centimetres up, 1.23 metres forward].
Create a group called Rear Left Hub with id entity/hub-rl, centred at [82 centimetres left, 42 centimetres up, 1.23 metres backward].
Put Front Left Knuckle and Front Right Knuckle under Front Axle, keeping world pose.
Put Front Left Spin under Front Left Knuckle, keeping world pose.
Put Rear Left Hub under Rear Axle, keeping world pose.
`, { project: emptyProject() });
  const root = rootOf(compiled);
  const byId = Object.fromEntries(entitiesOf(compiled).map(entity => [entity.id, entity]));
  assert.equal(byId['entity/knuckle-fl'].parentId, 'entity/front-axle');
  assert.equal(byId['entity/spin-fl'].parentId, 'entity/knuckle-fl');
  assert.equal(byId['entity/hub-rl'].parentId, 'entity/rear-axle');
  const knuckleLocal = byId['entity/knuckle-fl'].transform.rotation.map(value => Math.round(value * 1e6) / 1e6);
  const spinLocal = byId['entity/spin-fl'].transform.rotation.map(value => Math.round(value * 1e6) / 1e6);
  assert.deepEqual(knuckleLocal, [0, 0, 0]);
  assert.deepEqual(spinLocal, [0, 0, 0]);
  const action = compileAnimationAction({
    id: 'animation/rig/steer-and-roll',
    kind: 'animation',
    fps: 24,
    frameStart: 0,
    frameEnd: 24,
    tracks: [
      { targetId: 'entity/knuckle-fl', property: 'transform.rotation', interpolation: 'linear', keyframes: [{ frame: 0, value: [0, 0, 0] }, { frame: 24, value: [0, 0.4, 0] }] },
      { targetId: 'entity/knuckle-fr', property: 'transform.rotation', interpolation: 'linear', keyframes: [{ frame: 0, value: [0, 0, 0] }, { frame: 24, value: [0, 0.4, 0] }] },
      { targetId: 'entity/spin-fl', property: 'transform.rotation', interpolation: 'linear', keyframes: [{ frame: 0, value: [0, 0, 0] }, { frame: 24, value: [6.283185307179586, 0, 0] }] },
      { targetId: 'entity/hub-rl', property: 'transform.rotation', interpolation: 'linear', keyframes: [{ frame: 0, value: [0, 0, 0] }, { frame: 24, value: [6.283185307179586, 0, 0] }] },
    ],
  }, { knownTargetIds: ['entity/knuckle-fl', 'entity/knuckle-fr', 'entity/spin-fl', 'entity/hub-rl'] });
  const rest = evaluateAnimationAction(action, 0);
  const steered = evaluateAnimationAction(action, 1);
  const sample = (evaluation, id) => evaluation.samples.find(entry => entry.targetId === id).value;
  assert.deepEqual(sample(rest, 'entity/knuckle-fl'), [0, 0, 0]);
  assert.deepEqual(sample(steered, 'entity/knuckle-fl'), [0, 0.4, 0]);
  assert.deepEqual(sample(steered, 'entity/knuckle-fr'), [0, 0.4, 0]);
  assert.ok(Math.abs(sample(steered, 'entity/spin-fl')[0] - Math.PI * 2) < 1e-9);
  assert.equal(sample(steered, 'entity/spin-fl')[1], 0);
  assert.ok(Math.abs(sample(steered, 'entity/hub-rl')[0] - Math.PI * 2) < 1e-9);
  assert.ok(root);
});

test('Object grouping accepts an authored world centre', () => {
  const compiled = new PlainformCompiler().compile(`
Find every visible mesh beneath entity/tree that is tagged "leaf".
Call them the canopy leaves.
Put the canopy leaves into a group called "Canopy" with id entity/tree/canopy, centred at [0 metres, 2 metres, 0 metres].
`, { project: projectFixture() });
  const group = compiled.operations.find(operation => operation.op === 'entity.group');
  assert.equal(group.group.id, 'entity/tree/canopy');
  assert.deepEqual(group.group.transform.position, [0, 2, 0]);
});
