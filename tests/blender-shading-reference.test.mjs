import assert from 'node:assert/strict';
import test from 'node:test';

import { validateGraph } from '../src/graphs/index.mjs';
import {
  BLENDER_SHADING_REFERENCE_SOURCE,
  buildBlenderShadingReferenceOperations,
  buildBlenderWateringCanShaderGraph,
} from '../src/tutorials/blender-shading-reference.mjs';

test('watering-can shading reference is a valid Blender-shaped surface graph', () => {
  const graph = buildBlenderWateringCanShaderGraph();
  const validation = validateGraph(graph);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(graph.outputs.surface.nodeId, 'material-output');
  for (const type of [
    'ShaderNodeTexCoord', 'ShaderNodeMapping', 'ShaderNodeTexNoise',
    'ShaderNodeTexVoronoi', 'ShaderNodeTexWave', 'ShaderNodeValToRGB',
    'ShaderNodeMapRange', 'ShaderNodeMix', 'ShaderNodeBump',
    'ShaderNodeBsdfPrincipled', 'ShaderNodeOutputMaterial', 'NodeFrame', 'NodeReroute',
  ]) assert.ok(graph.nodes.some((node) => node.type === type), `missing ${type}`);
  assert.ok(graph.nodes.some((node) => node.layout?.parentFrameId === 'frame/normal'));
  assert.match(BLENDER_SHADING_REFERENCE_SOURCE, /shading_watering_can/);
});

test('watering-can shading reference supports first-create and verified update workflows', () => {
  const create = buildBlenderShadingReferenceOperations();
  assert.equal(create[0].op, 'resource.create');
  assert.equal(create[0].resourceType, 'graphs');

  const update = buildBlenderShadingReferenceOperations({ update: true });
  assert.equal(update[0].op, 'resource.patch');
  assert.equal(update[0].resourceType, 'graphs');
  assert.equal(update[0].resourceId, create[0].resource.id);
  assert.equal(update[0].patch.graph.id, create[0].resource.graph.id);
});
