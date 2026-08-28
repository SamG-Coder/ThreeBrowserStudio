import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { canonicalGraphString, validateGraph } from '../src/graphs/index.mjs';
import { compileShaderGraph } from '../src/runtime/shader-graph-compiler.mjs';

function layoutGraph() {
  return {
    formatVersion: 1,
    id: 'shader/layout-contract',
    domain: 'shader',
    nodes: [
      {
        id: 'frame/paint',
        type: 'NodeFrame',
        params: {},
        layout: {
          position: [-420, 180],
          dimensions: [520, 310],
          label: 'Weathered paint',
          collapsed: false,
          color: [0.12, 0.28, 0.16],
        },
      },
      {
        id: 'paint/base',
        type: 'constant.color',
        params: { value: [0.08, 0.31, 0.12] },
        layout: {
          position: [-310, 90],
          width: 188,
          label: 'Base pigment',
          parentFrameId: 'frame/paint',
          collapsed: true,
        },
      },
    ],
    edges: [],
    outputs: { baseColor: { nodeId: 'paint/base', port: 'value' } },
  };
}

test('generic Blender-style node layout is bounded, canonical, and runtime-inert', () => {
  const validation = validateGraph(layoutGraph());
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.deepEqual(validation.warnings, []);

  const frame = validation.graph.nodes.find((node) => node.id === 'frame/paint');
  const child = validation.graph.nodes.find((node) => node.id === 'paint/base');
  assert.deepEqual(frame.layout, {
    collapsed: false,
    color: [0.12, 0.28, 0.16],
    dimensions: [520, 310],
    label: 'Weathered paint',
    position: [-420, 180],
    width: 520,
  });
  assert.deepEqual(child.layout, {
    collapsed: true,
    dimensions: [188, 100],
    label: 'Base pigment',
    parentFrameId: 'frame/paint',
    position: [-310, 90],
    width: 188,
  });

  const reordered = layoutGraph();
  reordered.nodes.reverse();
  reordered.nodes[0].layout = {
    collapsed: true,
    parentFrameId: 'frame/paint',
    label: 'Base pigment',
    width: 188,
    position: [-310, 90],
  };
  assert.equal(canonicalGraphString(reordered), canonicalGraphString(layoutGraph()));

  const TSL = { vec3: (...values) => ({ kind: 'vec3', values }) };
  const compilation = compileShaderGraph({ TSL, graph: layoutGraph() });
  assert.equal(compilation.nodesCompiled, 1, 'layout-only nodes are not lowered into runtime shader work');
  assert.deepEqual(compilation.outputs.baseColor, { kind: 'vec3', values: [0.08, 0.31, 0.12] });
});

test('node layout rejects unknown fields and every out-of-bounds authored value', () => {
  const graph = layoutGraph();
  graph.nodes[1].layout = {
    position: [1_000_001, 0],
    dimensions: [100, -1],
    width: 8193,
    label: 'x'.repeat(257),
    parentFrameId: 'not a stable id',
    collapsed: 'yes',
    color: [0, 1.01, 0],
    rotation: 0,
  };
  const validation = validateGraph(graph);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((entry) => entry.code === 'unknown_property' && entry.path.endsWith('/layout/rotation')));
  for (const field of ['position', 'dimensions', 'width', 'label', 'parentFrameId', 'collapsed', 'color']) {
    assert.ok(
      validation.errors.some((entry) => entry.code === 'invalid_node_layout' && entry.path.endsWith(`/layout/${field}`)),
      `missing bounded layout diagnostic for ${field}`,
    );
  }
});

test('frame parents must exist, target NodeFrame, and remain acyclic', () => {
  const graph = layoutGraph();
  graph.nodes = [
    {
      id: 'frame/a',
      type: 'NodeFrame',
      params: {},
      layout: { parentFrameId: 'frame/b' },
    },
    {
      id: 'frame/b',
      type: 'NodeFrame',
      params: {},
      layout: { parentFrameId: 'frame/a' },
    },
    {
      id: 'paint/base',
      type: 'constant.color',
      params: { value: [0.08, 0.31, 0.12] },
    },
    {
      id: 'paint/not-a-frame-child',
      type: 'constant.float',
      params: { value: 0.5 },
      layout: { parentFrameId: 'paint/base' },
    },
    {
      id: 'paint/missing-frame-child',
      type: 'constant.float',
      params: { value: 0.7 },
      layout: { parentFrameId: 'frame/missing' },
    },
  ];
  const validation = validateGraph(graph);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((entry) => entry.code === 'layout_parent_cycle' && entry.cycle.includes('frame/a') && entry.cycle.includes('frame/b')));
  assert.ok(validation.errors.some((entry) => entry.code === 'layout_parent_not_frame' && entry.nodeId === 'paint/not-a-frame-child'));
  assert.ok(validation.errors.some((entry) => entry.code === 'missing_layout_parent' && entry.nodeId === 'paint/missing-frame-child'));
});

test('checked-in graph schema mirrors strict node layout fields and bounds', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/graphs.schema.json', import.meta.url), 'utf8'));
  const layout = schema.$defs.nodeLayout;
  assert.equal(schema.$defs.node.properties.layout.$ref, '#/$defs/nodeLayout');
  assert.equal(layout.additionalProperties, false);
  assert.deepEqual(Object.keys(layout.properties).sort(), [
    'collapsed', 'color', 'dimensions', 'label', 'parentFrameId', 'position', 'width',
  ]);
  assert.equal(layout.properties.position.prefixItems[0].minimum, -1_000_000);
  assert.equal(layout.properties.dimensions.prefixItems[0].maximum, 8192);
  assert.equal(layout.properties.width.maximum, 8192);
  assert.equal(layout.properties.label.maxLength, 256);
  assert.equal(layout.properties.color.maxItems, 3);
});
