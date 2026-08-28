import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GraphValidationError,
  assertValidGraph,
  validateGraph,
} from '../src/graphs/index.mjs';

function textureSettings(overrides = {}) {
  return {
    seed: 42,
    resolution: [1024, 1024],
    wrapS: 'repeat',
    wrapT: 'repeat',
    minFilter: 'linearMipmapLinear',
    magFilter: 'linear',
    mode: 'interactive',
    ...overrides,
  };
}

test('validates and normalizes a typed shader DAG', () => {
  const graph = {
    formatVersion: 1,
    id: 'shader/ripple',
    domain: 'shader',
    nodes: [
      { id: 'uv', type: 'input.uv', params: {} },
      { id: 'noise', type: 'noise.fbm', params: { seed: 7, octaves: 3 } },
      { id: 'ramp', type: 'ramp.color', params: { stops: [
        { position: 0, color: [0.02, 0.1, 0.12] },
        { position: 1, color: [0.3, 0.65, 0.7] },
      ] } },
    ],
    edges: [
      { from: { nodeId: 'uv', port: 'uv' }, to: { nodeId: 'noise', port: 'coordinate' } },
      { from: { nodeId: 'noise', port: 'value' }, to: { nodeId: 'ramp', port: 'value' } },
    ],
    outputs: { baseColor: { nodeId: 'ramp', port: 'color' } },
  };
  const validation = validateGraph(graph);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(validation.metrics.depth, 3);
  assert.equal(validation.graph.nodes.find((entry) => entry.id === 'noise').params.lacunarity, 2);
  assert.equal(validation.graph.nodes.find((entry) => entry.id === 'noise').params.gain, 0.5);
});

test('enforces typed ports and shader output stages', () => {
  const graph = {
    formatVersion: 1,
    id: 'shader/bad-stage',
    domain: 'shader',
    nodes: [
      { id: 'view', type: 'input.viewDirection', params: {} },
      { id: 'amount', type: 'constant.float', params: { value: 0.5 } },
    ],
    edges: [
      { from: { nodeId: 'view', port: 'direction' }, to: { nodeId: 'amount', port: 'no-such-input' } },
    ],
    outputs: { positionOffset: { nodeId: 'view', port: 'direction' } },
  };
  const validation = validateGraph(graph);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((entry) => entry.code === 'missing_input_port'));
  assert.ok(validation.errors.some((entry) => entry.code === 'shader_stage_mismatch'));
});

test('texture graphs require deterministic settings, legal colour spaces, and resolution limits', () => {
  const graph = {
    formatVersion: 1,
    id: 'texture/moss',
    domain: 'texture',
    nodes: [
      { id: 'uv', type: 'uv', params: {} },
      { id: 'noise', type: 'fbm', params: { seed: 9 } },
      { id: 'ramp', type: 'colorRamp', params: { stops: [
        { position: 0, color: [0.05, 0.08, 0.02] },
        { position: 1, color: [0.4, 0.6, 0.12] },
      ] } },
    ],
    edges: [
      { from: { nodeId: 'uv', port: 'uv' }, to: { nodeId: 'noise', port: 'coordinate' } },
      { from: { nodeId: 'noise', port: 'value' }, to: { nodeId: 'ramp', port: 'value' } },
    ],
    outputs: { albedo: { nodeId: 'ramp', port: 'color', colorSpace: 'srgb' } },
    settings: textureSettings(),
  };
  assert.equal(validateGraph(graph).valid, true);

  graph.outputs.albedo.colorSpace = 'none';
  graph.settings.resolution = [4096, 4096];
  const invalid = validateGraph(graph);
  assert.ok(invalid.errors.some((entry) => entry.code === 'color_space_mismatch'));
  assert.ok(invalid.errors.some((entry) => entry.code === 'texture_resolution_exceeded'));
});

test('blueprints have typed execution/data edges and event-root reachability', () => {
  const graph = {
    formatVersion: 1,
    id: 'blueprint/reveal-door',
    domain: 'blueprint',
    nodes: [
      { id: 'start', type: 'event.onStart', params: {} },
      { id: 'door', type: 'entity.reference', params: { entityId: 'courtyard/door' } },
      { id: 'visible', type: 'value.constant', params: { valueType: 'boolean', value: true } },
      { id: 'show', type: 'visibility.set', params: {} },
    ],
    edges: [
      { from: { nodeId: 'start', port: 'out' }, to: { nodeId: 'show', port: 'in' } },
      { from: { nodeId: 'door', port: 'entity' }, to: { nodeId: 'show', port: 'entity' } },
      { from: { nodeId: 'visible', port: 'value' }, to: { nodeId: 'show', port: 'visible' } },
    ],
    outputs: {},
  };
  const validation = validateGraph(graph);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(validation.warnings.length, 0);

  graph.edges[2] = { from: { nodeId: 'door', port: 'entity' }, to: { nodeId: 'show', port: 'visible' } };
  assert.ok(validateGraph(graph).errors.some((entry) => entry.code === 'port_type_mismatch'));
});

test('all graph domains reject cycles, excessive depth, and cost budgets', () => {
  const cycle = {
    formatVersion: 1,
    id: 'shader/cycle',
    domain: 'shader',
    nodes: [
      { id: 'a', type: 'math.add', params: { valueType: 'float' } },
      { id: 'b', type: 'math.add', params: { valueType: 'float' } },
    ],
    edges: [
      { from: { nodeId: 'a', port: 'value' }, to: { nodeId: 'b', port: 'a' } },
      { from: { nodeId: 'a', port: 'value' }, to: { nodeId: 'b', port: 'b' } },
      { from: { nodeId: 'b', port: 'value' }, to: { nodeId: 'a', port: 'a' } },
      { from: { nodeId: 'b', port: 'value' }, to: { nodeId: 'a', port: 'b' } },
    ],
    outputs: { roughness: { nodeId: 'a', port: 'value' } },
  };
  assert.ok(validateGraph(cycle).errors.some((entry) => entry.code === 'graph_cycle'));

  const valid = {
    formatVersion: 1,
    id: 'shader/cost',
    domain: 'shader',
    nodes: [{ id: 'color', type: 'constant.color', params: { value: [1, 1, 1] } }],
    edges: [],
    outputs: { baseColor: { nodeId: 'color', port: 'value' } },
  };
  assert.ok(validateGraph(valid, { limits: { maxDepth: 0, maxShaderCost: 0 } }).errors.some((entry) => entry.code === 'graph_depth_exceeded'));
  assert.ok(validateGraph(valid, { limits: { maxDepth: 0, maxShaderCost: 0 } }).errors.some((entry) => entry.code === 'graph_budget_exceeded'));
});

test('assertValidGraph throws typed diagnostics and unreachable blueprint nodes are reported', () => {
  const graph = {
    formatVersion: 1,
    id: 'blueprint/orphan',
    domain: 'blueprint',
    nodes: [
      { id: 'start', type: 'event.onStart', params: {} },
      { id: 'orphan', type: 'entity.reference', params: { entityId: 'world/orphan' } },
    ],
    edges: [],
    outputs: {},
  };
  const validation = validateGraph(graph);
  assert.equal(validation.valid, true);
  assert.ok(validation.warnings.some((entry) => entry.code === 'unreachable_node' && entry.nodeId === 'orphan'));

  assert.throws(
    () => assertValidGraph({ ...graph, domain: 'javascript' }),
    (error) => error instanceof GraphValidationError && error.code === 'graph_invalid',
  );
});
