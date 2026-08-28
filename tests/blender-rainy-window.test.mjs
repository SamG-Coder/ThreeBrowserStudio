import assert from 'node:assert/strict';
import test from 'node:test';

import { applyOperations, createProjectDocument, validateProjectDocument } from '../src/core/index.mjs';
import { validateGraph } from '../src/graphs/index.mjs';
import { applySchema } from '../src/mcp/tool-schemas.mjs';
import { validateAnimationResource } from '../src/runtime/animation-runtime.mjs';
import {
  BLENDER_RAINY_WINDOW_ACTION_ID,
  BLENDER_RAINY_WINDOW_AUTHOR,
  BLENDER_RAINY_WINDOW_SOURCE,
  buildRainyWindowGlassGraph,
  buildRainyWindowOperations,
  buildRainyWindowWoodGraph,
  summarizeRainyWindowOperations,
} from '../src/tutorials/blender-rainy-window.mjs';
import {
  buildRainyWindowLiveStages,
  summarizeRainyWindowLiveStages,
} from '../src/tutorials/blender-rainy-window-live.mjs';

test('Rainy Window translates two complex Blender shader flows without unsupported nodes', () => {
  for (const graph of [buildRainyWindowWoodGraph(), buildRainyWindowGlassGraph()]) {
    const validation = validateGraph(graph);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
    assert.equal(graph.outputs.surface.nodeId, 'output');
  }
  const rain = buildRainyWindowGlassGraph();
  for (const type of [
    'ShaderNodeTexCoord', 'ShaderNodeMapping', 'ShaderNodeTexNoise',
    'ShaderNodeTexVoronoi', 'ShaderNodeTexWave', 'ShaderNodeMapRange',
    'ShaderNodeMix', 'ShaderNodeBump', 'ShaderNodeBsdfPrincipled',
    'ShaderNodeOutputMaterial', 'NodeFrame',
  ]) assert.ok(rain.nodes.some(node => node.type === type), `missing ${type}`);
});

test('Rainy Window is one bounded, valid, attributable MCP changeset', () => {
  const project = createProjectDocument({ projectId: 'project/blender-rainy-window' });
  const operations = buildRainyWindowOperations();
  const parsed = applySchema.safeParse({
    protocolVersion: 'three-studio/1', sessionId: 'rainy-window-test',
    projectId: project.projectId, baseRevision: 0,
    idempotencyKey: 'rainy-window-apply:test',
    label: 'Translate the Blender Studio Rainy Window tutorial', operations,
  });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  assert.ok(operations.length <= 128);

  const document = applyOperations(project, operations).document;
  const validation = validateProjectDocument(document);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  assert.equal(document.scenes['scene/main'].settings.activeCameraId, 'entity/rainy-window/camera');
  assert.equal(document.resources.materials['material/rainy-window/glass'].graphId, 'graph/rainy-window/rain-glass');
  assert.equal(new URL(BLENDER_RAINY_WINDOW_SOURCE).hostname, 'studio.blender.org');
  assert.equal(BLENDER_RAINY_WINDOW_AUTHOR, 'Simon Thommes');

  const summary = summarizeRainyWindowOperations(operations);
  assert.equal(summary.graphs, 2);
  assert.equal(summary.rainMeshes, 48);
});

test('Rainy Window has a validated 28-second camera and rain Action', () => {
  const document = applyOperations(
    createProjectDocument({ projectId: 'project/blender-rainy-window' }),
    buildRainyWindowOperations(),
  ).document;
  const scene = document.scenes['scene/main'];
  const animation = validateAnimationResource(document.resources.animations[BLENDER_RAINY_WINDOW_ACTION_ID], {
    knownTargetIds: Object.keys(scene.entities),
  });
  assert.equal(animation.valid, true, JSON.stringify(animation.diagnostics));
  assert.equal(animation.action.duration, 28);
  assert.equal(animation.action.tracks.length, 5);
});

test('Rainy Window live plan remains valid while it visibly assembles the final scene', () => {
  const stages = buildRainyWindowLiveStages();
  let document = createProjectDocument({ projectId: 'project/blender-rainy-window-live' });
  const oneShot = applyOperations(
    createProjectDocument({ projectId: 'project/blender-rainy-window-live' }),
    buildRainyWindowOperations(),
  ).document;
  for (const stage of stages) {
    assert.ok(stage.operations.length > 0, `${stage.id} must contain operations`);
    document = applyOperations(document, stage.operations).document;
    const validation = validateProjectDocument(document);
    assert.equal(validation.valid, true, `${stage.id}: ${JSON.stringify(validation.diagnostics)}`);
  }

  const scene = document.scenes['scene/main'];
  assert.equal(scene.settings.activeCameraId, 'entity/rainy-window/camera');
  assert.equal(document.resources.materials['material/rainy-window/wood'].graphId, 'graph/rainy-window/aged-wood');
  assert.equal(document.resources.materials['material/rainy-window/glass'].graphId, 'graph/rainy-window/rain-glass');
  assert.equal(scene.entities['entity/rainy-window/showcase'].components.animation.actionId, BLENDER_RAINY_WINDOW_ACTION_ID);
  assert.equal(Object.keys(scene.entities).length, 86);
  assert.deepEqual(scene.rootEntityIds, oneShot.scenes['scene/main'].rootEntityIds);
  for (const [id, entity] of Object.entries(scene.entities)) {
    assert.deepEqual(entity.children, oneShot.scenes['scene/main'].entities[id].children, `${id} child order changed`);
  }

  const summary = summarizeRainyWindowLiveStages(stages);
  assert.equal(summary.stages, 11);
  assert.equal(summary.visibleStages, 9);
  assert.equal(stages.at(-1).id, 'animation');
});
