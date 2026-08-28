import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyOperations,
  buildProjectIndex,
  createProjectDocument,
  validateProjectDocument,
} from '../src/core/index.mjs';
import { applySchema } from '../src/mcp/tool-schemas.mjs';
import { validateAnimationResource } from '../src/runtime/animation-runtime.mjs';
import {
  BLENDER_FUNDAMENTALS_SOURCES,
  buildBlenderFundamentalsOperations,
  summarizeBlenderFundamentalsOperations,
} from '../src/tutorials/blender-fundamentals.mjs';
import { buildBlenderModelingReferenceOperations } from '../src/tutorials/blender-modeling-reference.mjs';

test('official Blender Fundamentals workflow is one valid atomic MCP changeset', () => {
  const project = createProjectDocument({ projectId: 'project/blender-fundamentals' });
  const operations = buildBlenderFundamentalsOperations();
  const parsed = applySchema.safeParse({
    protocolVersion: 'three-studio/1',
    sessionId: 'tutorial-session',
    projectId: project.projectId,
    baseRevision: 0,
    idempotencyKey: 'tutorial-apply:test',
    label: 'Translate Blender Fundamentals through MCP',
    operations,
  });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));

  const result = applyOperations(project, operations);
  const validation = validateProjectDocument(result.document);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  const summary = summarizeBlenderFundamentalsOperations(operations);
  assert.deepEqual(summary, {
    operations: 39,
    resources: 17,
    entities: 19,
    modifiers: 3,
    constraints: 4,
    officialSources: 5,
  });
  assert.ok(BLENDER_FUNDAMENTALS_SOURCES.every(url => new URL(url).hostname === 'studio.blender.org'));
});

test('tutorial preserves reusable data, ordered stacks, constraints, and Action bindings', () => {
  const project = applyOperations(
    createProjectDocument({ projectId: 'project/blender-fundamentals' }),
    buildBlenderFundamentalsOperations(),
  ).document;
  const scene = project.scenes['scene/main'];
  const index = buildProjectIndex(project);

  assert.equal(scene.settings.activeCameraId, 'entity/fundamentals/camera');
  assert.deepEqual(scene.settings.timeline, {
    frameStart: 1,
    frameEnd: 48,
    currentFrame: 1,
    framesPerSecond: 24,
  });
  assert.deepEqual(scene.entities['entity/fundamentals/badge'].components.modifiers.map(item => item.type), ['mirror']);
  assert.deepEqual(scene.entities['entity/fundamentals/rivets'].components.modifiers.map(item => item.type), ['array']);
  assert.equal(scene.entities['entity/fundamentals/camera'].components.constraints[0].type, 'lookAt');
  assert.equal(index.getReferencesTo('geometry/fundamentals/can-body')[0].sourceId, 'entity/fundamentals/can-body');
  assert.equal(index.getReferencesTo('animation/fundamentals/ball-bounce')[0].sourceId, 'entity/fundamentals/ball');

  const action = project.resources.animations['animation/fundamentals/ball-bounce'];
  const animation = validateAnimationResource(action, { knownTargetIds: Object.keys(scene.entities) });
  assert.equal(animation.valid, true, JSON.stringify(animation.diagnostics));
  assert.equal(animation.action.duration, 2);
  assert.deepEqual(animation.action.tracks[0].times, [0, 0.5, 1, 1.5, 2]);
});

test('isolated Blender modeling reference is a valid, directly comparable scene', () => {
  const project = createProjectDocument({ projectId: 'project/blender-modeling-reference' });
  const operations = buildBlenderModelingReferenceOperations();
  const parsed = applySchema.safeParse({
    protocolVersion: 'three-studio/1',
    sessionId: 'tutorial-session',
    projectId: project.projectId,
    baseRevision: 0,
    idempotencyKey: 'modeling-reference-apply:test',
    label: 'Build isolated Blender modeling reference',
    operations,
  });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));

  const result = applyOperations(project, operations);
  const validation = validateProjectDocument(result.document);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  const scene = result.document.scenes['scene/main'];
  assert.equal(scene.settings.activeCameraId, 'entity/modeling-reference/camera');
  assert.equal(scene.entities['entity/modeling-reference/ball'], undefined);
  assert.equal(scene.entities['entity/modeling-reference/body'].parentId, 'entity/modeling-reference/can');
  assert.equal(result.document.resources.geometries['geometry/modeling-reference/handle'].recipe.kind, 'tube');
  assert.equal(result.document.resources.geometries['geometry/modeling-reference/body'].recipe.kind, 'lathe');
});
