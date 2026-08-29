import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BLENDER_SHADER_NODE_INVENTORY_SUMMARY,
  GRAPH_CATALOGS,
  isCompiledShaderNodeType,
  queryBlenderShaderNodeInventory,
  queryGraphCatalog,
  validateGraph,
} from '../src/graphs/index.mjs';
import {
  BLENDER_SHADER_NODE_ALIASES,
  compileShaderGraph,
} from '../src/runtime/shader-graph-compiler.mjs';

class EvalNode {
  constructor(value) { this.value = value; }
  get xyz() {
    return new EvalNode(Array.isArray(this.value) ? this.value.slice(0, 3) : [this.value, this.value, this.value]);
  }
}

function raw(value) {
  return value instanceof EvalNode ? value.value : value;
}

function vector(length, values) {
  const flattened = values.flatMap(value => Array.isArray(raw(value)) ? raw(value) : [raw(value)]);
  return new EvalNode(flattened.length === 1 ? Array(length).fill(flattened[0]) : flattened.slice(0, length));
}

const EVAL_TSL = Object.freeze({
  float: value => new EvalNode(raw(value)),
  vec2: (...values) => vector(2, values),
  vec3: (...values) => vector(3, values),
  vec4: (...values) => vector(4, values),
  dot: (left, right) => new EvalNode(raw(left).reduce(
    (sum, value, index) => sum + value * raw(right)[index],
    0,
  )),
});

function textureSettings() {
  return {
    seed: 0,
    resolution: [16, 16],
    wrapS: 'clamp',
    wrapT: 'clamp',
    minFilter: 'linear',
    magFilter: 'linear',
    mode: 'interactive',
  };
}

function vectorGraph(dimensions) {
  return {
    formatVersion: 1,
    id: `texture/vector-input-${dimensions}d`,
    domain: 'texture',
    nodes: [{
      id: 'vector',
      type: 'FunctionNodeInputVector',
      params: { dimensions, value: [1, 2, 3, 4] },
    }],
    edges: [],
    outputs: { data: { nodeId: 'vector', port: 'Vector', colorSpace: 'none' } },
    settings: textureSettings(),
  };
}

test('Vector Input and RGB to BW expose exact Blender aliases and live inventory status', () => {
  for (const domain of ['shader', 'texture']) {
    const vectorNode = GRAPH_CATALOGS[domain].nodes.FunctionNodeInputVector;
    const rgbToBw = GRAPH_CATALOGS[domain].nodes.ShaderNodeRGBToBW;
    assert.equal(vectorNode.canonicalType, 'blender.inputVector');
    assert.equal(vectorNode.outputs.vector.blenderName, 'Vector');
    assert.equal(vectorNode.params.dimensions.default, 3);
    assert.equal(vectorNode.params.value.length, 4);
    assert.equal(rgbToBw.canonicalType, 'blender.rgbToBw');
    assert.deepEqual(rgbToBw.inputs.color.default, [0.5, 0.5, 0.5, 1]);
    assert.equal(rgbToBw.outputs.value.blenderName, 'Val');
  }

  assert.equal(BLENDER_SHADER_NODE_ALIASES.FunctionNodeInputVector, 'blender.inputVector');
  assert.equal(BLENDER_SHADER_NODE_ALIASES.ShaderNodeRGBToBW, 'blender.rgbToBw');
  assert.equal(isCompiledShaderNodeType('shader', 'FunctionNodeInputVector'), true);
  assert.equal(isCompiledShaderNodeType('shader', 'ShaderNodeRGBToBW'), true);
  assert.equal(BLENDER_SHADER_NODE_INVENTORY_SUMMARY.liveTsl, 38);
  assert.equal(BLENDER_SHADER_NODE_INVENTORY_SUMMARY.catalogued, 77);
  assert.deepEqual(
    queryBlenderShaderNodeInventory({ status: 'live-tsl' }).nodes
      .filter(node => ['FunctionNodeInputVector', 'ShaderNodeRGBToBW'].includes(node.id))
      .map(node => node.id),
    ['FunctionNodeInputVector', 'ShaderNodeRGBToBW'],
  );

  const queried = queryGraphCatalog('shader', {
    types: ['FunctionNodeInputVector', 'ShaderNodeRGBToBW'],
  });
  assert.equal(queried.returned, 2);
  assert.deepEqual(queried.nodes.map(node => node.type), [
    'FunctionNodeInputVector',
    'ShaderNodeRGBToBW',
  ]);
});

test('Vector Input resolves and compiles every authored Blender dimension', () => {
  for (const dimensions of [2, 3, 4]) {
    const graph = vectorGraph(dimensions);
    const validation = validateGraph(graph);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
    const output = raw(compileShaderGraph({ TSL: EVAL_TSL, graph }).outputs.data);
    assert.deepEqual(output, [1, 2, 3, 4].slice(0, dimensions));
  }

  const invalidDimensions = vectorGraph(5);
  assert.ok(validateGraph(invalidDimensions).errors.some(error => (
    error.code === 'invalid_parameter' && error.path === '/nodes/0/params/dimensions'
  )));

  const wrongShaderOutput = vectorGraph(2);
  wrongShaderOutput.id = 'shader/vector-input-wrong-output';
  wrongShaderOutput.domain = 'shader';
  wrongShaderOutput.outputs = { positionOffset: { nodeId: 'vector', port: 'Vector' } };
  delete wrongShaderOutput.settings;
  assert.ok(validateGraph(wrongShaderOutput).errors.some(error => error.code === 'graph_output_type_mismatch'));
});

test('RGB to BW compiles linear-sRGB luminance and ignores alpha', () => {
  const evaluate = color => {
    const graph = {
      formatVersion: 1,
      id: 'shader/rgb-to-bw',
      domain: 'shader',
      nodes: [{ id: 'convert', type: 'ShaderNodeRGBToBW', params: {}, inputs: { Color: color } }],
      edges: [],
      outputs: { roughness: { nodeId: 'convert', port: 'Val' } },
    };
    const validation = validateGraph(graph);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
    return raw(compileShaderGraph({ TSL: EVAL_TSL, graph }).outputs.roughness);
  };

  assert.ok(Math.abs(evaluate([1, 0, 0, 0]) - 0.2126) < 1e-12);
  assert.ok(Math.abs(evaluate([0, 1, 0, 1]) - 0.7152) < 1e-12);
  assert.ok(Math.abs(evaluate([0.5, 0.5, 0.5, 0.2]) - 0.5) < 1e-12);
});
