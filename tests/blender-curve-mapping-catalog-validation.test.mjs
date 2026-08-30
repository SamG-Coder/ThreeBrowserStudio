import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BLENDER_SHADER_NODE_INVENTORY,
  GRAPH_CATALOGS,
  GRAPH_LIMITS,
  queryGraphCatalog,
  validateGraph,
} from '../src/graphs/index.mjs';

const CURVE_NODES = [
  ['blender.floatCurve', 'ShaderNodeFloatCurve'],
  ['blender.rgbCurve', 'ShaderNodeRGBCurve'],
  ['blender.vectorCurve', 'ShaderNodeVectorCurve'],
];

function identityMapping(channels, minimum = 0, maximum = 1) {
  return {
    extend: 'EXTRAPOLATED',
    clip: { enabled: true, min: [minimum, minimum], max: [maximum, maximum] },
    curves: Object.fromEntries(channels.map((channel) => [channel, [
      { location: [minimum, minimum], handleType: 'AUTO' },
      { location: [maximum, maximum], handleType: 'AUTO' },
    ]])),
  };
}

function floatCurveGraph(mapping = undefined) {
  return {
    formatVersion: 1,
    id: 'shader/float-curve-validation',
    domain: 'shader',
    nodes: [{
      id: 'curve',
      type: 'ShaderNodeFloatCurve',
      params: mapping === undefined ? {} : { mapping },
    }],
    edges: [],
    outputs: { roughness: { nodeId: 'curve', port: 'Value' } },
  };
}

test('CurveMapping nodes expose canonical types, Blender aliases, sockets, and identity defaults', () => {
  for (const domain of ['shader', 'texture']) {
    for (const [canonicalType, blenderId] of CURVE_NODES) {
      const canonical = GRAPH_CATALOGS[domain].nodes[canonicalType];
      const alias = GRAPH_CATALOGS[domain].nodes[blenderId];
      assert.ok(canonical, `missing ${domain} node ${canonicalType}`);
      assert.ok(alias, `missing ${domain} alias ${blenderId}`);
      assert.equal(canonical.blenderId, blenderId);
      assert.equal(alias.canonicalType, canonicalType);
      assert.equal(canonical.params.mapping.type, 'curveMapping');
      assert.deepEqual(canonical.params.mapping.extendValues, ['EXTRAPOLATED', 'HORIZONTAL']);
      assert.deepEqual(canonical.params.mapping.handleTypes, ['AUTO', 'AUTO_CLAMPED', 'VECTOR']);
      assert.ok(Object.isFrozen(canonical.params.mapping.default));
    }
  }

  const floatCurve = GRAPH_CATALOGS.shader.nodes['blender.floatCurve'];
  assert.deepEqual(floatCurve.params.mapping.channels, ['value']);
  assert.equal(floatCurve.inputs.factor.blenderName, 'Factor');
  assert.equal(floatCurve.inputs.factor.default, 1);
  assert.equal(floatCurve.inputs.value.default, 1);
  assert.equal(floatCurve.outputs.value.blenderName, 'Value');
  assert.deepEqual(floatCurve.params.mapping.default, identityMapping(['value']));

  const rgbCurve = GRAPH_CATALOGS.shader.nodes['blender.rgbCurve'];
  assert.deepEqual(rgbCurve.params.mapping.channels, ['red', 'green', 'blue', 'combined']);
  assert.equal(rgbCurve.inputs.factor.blenderName, 'Factor');
  assert.equal(rgbCurve.inputs.factor.blenderIdentifier, 'Fac');
  assert.deepEqual(rgbCurve.inputs.factor.aliases, ['Factor']);
  assert.deepEqual(rgbCurve.inputs.color.default, [1, 1, 1, 1]);
  assert.equal(rgbCurve.outputs.color.type, 'color');
  assert.deepEqual(rgbCurve.params.mapping.default, identityMapping(['red', 'green', 'blue', 'combined']));

  const vectorCurve = GRAPH_CATALOGS.shader.nodes['blender.vectorCurve'];
  assert.deepEqual(vectorCurve.params.mapping.channels, ['x', 'y', 'z']);
  assert.deepEqual(vectorCurve.inputs.vector.default, [0, 0, 0]);
  assert.deepEqual(vectorCurve.params.mapping.default, identityMapping(['x', 'y', 'z'], -1, 1));

  const queried = queryGraphCatalog('shader', { types: CURVE_NODES.map(([, blenderId]) => blenderId) });
  assert.equal(queried.returned, 3);
  for (const entry of queried.nodes) {
    assert.equal(entry.parameterMetadata.mapping.type, 'curveMapping');
    assert.ok(entry.parameterMetadata.mapping.channels.length >= 1);
    assert.deepEqual(entry.parameterMetadata.mapping.extendValues, ['EXTRAPOLATED', 'HORIZONTAL']);
    assert.deepEqual(entry.parameterMetadata.mapping.handleTypes, ['AUTO', 'AUTO_CLAMPED', 'VECTOR']);
    assert.equal(entry.parameterMetadata.mapping.minItems, 2);
    assert.equal(entry.parameterMetadata.mapping.maxItems, 32);
    assert.equal(entry.parameterMetadata.mapping.min, -100);
    assert.equal(entry.parameterMetadata.mapping.max, 100);
  }
});

test('CurveMapping defaults and authored values canonicalize for every channel family', () => {
  const authoredFloatMapping = {
    extend: 'HORIZONTAL',
    clip: { enabled: true, min: [-2, -2], max: [2, 2] },
    curves: {
      value: [
        { location: [-2, -1], handleType: 'VECTOR' },
        { location: [0, 0.25], handleType: 'AUTO_CLAMPED' },
        { location: [2, 1], handleType: 'AUTO' },
      ],
    },
  };
  const validation = validateGraph({
    formatVersion: 1,
    id: 'shader/all-curve-mappings',
    domain: 'shader',
    nodes: [
      { id: 'float', type: 'ShaderNodeFloatCurve', params: { mapping: authoredFloatMapping }, inputs: { Factor: 0.25, Value: 0.75 } },
      { id: 'rgb', type: 'blender.rgbCurve', params: {} },
      { id: 'vector', type: 'ShaderNodeVectorCurve', params: {} },
    ],
    edges: [],
    outputs: {
      roughness: { nodeId: 'float', port: 'Value' },
      baseColor: { nodeId: 'rgb', port: 'Color' },
      normal: { nodeId: 'vector', port: 'Vector' },
    },
  });

  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const nodes = Object.fromEntries(validation.graph.nodes.map((node) => [node.id, node]));
  assert.deepEqual(nodes.float.params.mapping, authoredFloatMapping);
  assert.deepEqual(nodes.rgb.params.mapping.curves.combined, [
    { handleType: 'AUTO', location: [0, 0] },
    { handleType: 'AUTO', location: [1, 1] },
  ]);
  assert.deepEqual(nodes.vector.params.mapping.clip, { enabled: true, max: [1, 1], min: [-1, -1] });
  assert.equal(nodes.float.inputs.factor, 0.25);
  assert.equal(nodes.float.inputs.value, 0.75);
});

test('CurveMapping validation enforces exact shape, bounds, f32 ordering, handles, and clipping', () => {
  const invalidMappings = [];
  const addInvalid = (mutate) => {
    const mapping = identityMapping(['value']);
    mutate(mapping);
    invalidMappings.push(mapping);
  };

  addInvalid((mapping) => { mapping.extra = true; });
  addInvalid((mapping) => { delete mapping.extend; });
  addInvalid((mapping) => { mapping.extend = 'CYCLIC'; });
  addInvalid((mapping) => { mapping.clip.extra = true; });
  addInvalid((mapping) => { delete mapping.clip.enabled; });
  addInvalid((mapping) => { mapping.clip.min = [-101, 0]; });
  addInvalid((mapping) => {
    mapping.clip.enabled = false;
    mapping.clip.min = [1, 0];
    mapping.clip.max = [1 + Number.EPSILON, 1];
  });
  addInvalid((mapping) => { mapping.curves.other = mapping.curves.value; });
  addInvalid((mapping) => { delete mapping.curves.value; });
  addInvalid((mapping) => { mapping.curves.value = mapping.curves.value.slice(0, 1); });
  addInvalid((mapping) => {
    mapping.curves.value = Array.from({ length: 33 }, (_, index) => ({
      location: [index / 32, index / 32],
      handleType: 'AUTO',
    }));
  });
  addInvalid((mapping) => { mapping.curves.value[0].extra = true; });
  addInvalid((mapping) => { mapping.curves.value[0].location = [-100.01, 0]; });
  addInvalid((mapping) => { mapping.curves.value[0].handleType = 'ALIGNED'; });
  addInvalid((mapping) => {
    mapping.curves.value = [
      { location: [0, 0], handleType: 'AUTO' },
      { location: [Number.MIN_VALUE, 0.5], handleType: 'AUTO' },
      { location: [1, 1], handleType: 'AUTO' },
    ];
  });
  addInvalid((mapping) => { mapping.curves.value[0].location = [0, -0.01]; });

  for (const mapping of invalidMappings) {
    const validation = validateGraph(floatCurveGraph(mapping));
    assert.equal(validation.valid, false, `unexpectedly accepted ${JSON.stringify(mapping)}`);
    assert.ok(validation.errors.some((entry) => entry.code === 'invalid_parameter'));
  }

  const unclipped = identityMapping(['value']);
  unclipped.clip.enabled = false;
  unclipped.curves.value = [
    { location: [-100, -100], handleType: 'VECTOR' },
    { location: [100, 100], handleType: 'AUTO_CLAMPED' },
  ];
  assert.equal(validateGraph(floatCurveGraph(unclipped)).valid, true);
});

test('CurveMapping node budget combines canonical and Blender aliases at twelve per graph', () => {
  assert.equal(GRAPH_LIMITS.maxCurveMappings, 12);
  const types = ['blender.floatCurve', 'ShaderNodeRGBCurve', 'blender.vectorCurve'];
  const graphWithCount = (count) => ({
    formatVersion: 1,
    id: `shader/curve-budget-${count}`,
    domain: 'shader',
    nodes: Array.from({ length: count }, (_, index) => ({
      id: `curve-${index}`,
      type: types[index % types.length],
      params: {},
    })),
    edges: [],
    outputs: { roughness: { nodeId: 'curve-0', port: 'value' } },
  });

  assert.equal(validateGraph(graphWithCount(12)).valid, true);
  const overflow = validateGraph(graphWithCount(13));
  assert.equal(overflow.valid, false);
  assert.ok(overflow.errors.some((entry) => entry.code === 'curve_mapping_limit_exceeded'));
});

test('Blender CurveMapping inventory entries are promoted to live TSL', () => {
  for (const [, blenderId] of CURVE_NODES) {
    const inventory = BLENDER_SHADER_NODE_INVENTORY.find((entry) => entry.id === blenderId);
    assert.ok(inventory, `missing inventory entry ${blenderId}`);
    assert.equal(inventory.status, 'live-tsl');
  }
});
