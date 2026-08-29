import assert from 'node:assert/strict';
import test from 'node:test';

import { GraphValidationError, validateGraph } from '../src/graphs/index.mjs';
import { createMaterial } from '../src/runtime/resource-factories.mjs';
import {
  ShaderGraphCompileError,
  compileShaderGraph,
  isCompiledSurface,
} from '../src/runtime/shader-graph-compiler.mjs';

class FakeNode {
  constructor(operation, arguments_ = []) {
    this.operation = operation;
    this.arguments = arguments_;
  }

  mul(value) { return new FakeNode('mul', [this, value]); }
  add(value) { return new FakeNode('add', [this, value]); }
  sub(value) { return new FakeNode('sub', [this, value]); }
  div(value) { return new FakeNode('div', [this, value]); }
  saturate() { return new FakeNode('saturate', [this]); }
  normalize() { return new FakeNode('normalize', [this]); }
}

const FAKE_TSL = Object.freeze({
  float: (value) => new FakeNode('float', [value]),
  vec2: (...values) => new FakeNode('vec2', values),
  vec3: (...values) => new FakeNode('vec3', values),
  vec4: (...values) => new FakeNode('vec4', values),
  normalLocal: new FakeNode('normalLocal'),
  positionLocal: new FakeNode('positionLocal'),
});

class FakePhysicalNodeMaterial {
  iorNode = null;
  clearcoatNode = null;
  clearcoatRoughnessNode = null;
  transmissionNode = null;
  sheenNode = null;
  sheenRoughnessNode = null;
  sheenColorNode = null;
  sheen = 0;

  constructor(values) {
    this.constructorValues = values;
  }
}

const FAKE_THREE = Object.freeze({
  Color: class {
    setRGB(...values) { this.values = values; return this; }
    set(value) { this.value = value; return this; }
  },
  MeshPhysicalNodeMaterial: FakePhysicalNodeMaterial,
  MeshStandardNodeMaterial: class {},
  FrontSide: 0,
  BackSide: 1,
  DoubleSide: 2,
});

function blenderSurfaceGraph() {
  return {
    formatVersion: 1,
    id: 'shader/blender-socket-surface',
    domain: 'shader',
    nodes: [
      {
        id: 'principled',
        type: 'ShaderNodeBsdfPrincipled',
        params: {},
        inputs: {
          baseColor: [0.04, 0.24, 0.08, 1],
          metallic: 0.18,
          roughness: 0.31,
          alpha: 0.92,
          emissionColor: [0.01, 0.03, 0.01, 1],
          emissionStrength: 0.25,
        },
      },
      { id: 'material-output', type: 'ShaderNodeOutputMaterial', params: {} },
    ],
    edges: [
      {
        from: { nodeId: 'principled', port: 'surface' },
        to: { nodeId: 'material-output', port: 'surface' },
      },
    ],
    outputs: { surface: { nodeId: 'material-output', port: 'surface' } },
  };
}

test('Blender RNA nodes retain per-socket defaults and validate a Material Output surface', () => {
  const validation = validateGraph(blenderSurfaceGraph());
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));

  const principled = validation.graph.nodes.find((node) => node.id === 'principled');
  assert.deepEqual(principled.inputs.baseColor, [0.04, 0.24, 0.08, 1]);
  assert.equal(principled.inputs.roughness, 0.31);
  assert.equal(principled.inputs.ior, 1.5, 'unspecified Blender socket defaults are made canonical');
  assert.equal(principled.inputs.coatRoughness, 0.03);
  assert.deepEqual(validation.graph.outputs.surface, { nodeId: 'material-output', port: 'surface' });
});

test('Blender Principled-to-Material-Output flow compiles to a live surface contract', () => {
  const compilation = compileShaderGraph({ TSL: FAKE_TSL, graph: blenderSurfaceGraph() });

  assert.equal(compilation.mode, 'tsl-webgpu');
  assert.equal(compilation.graphId, 'shader/blender-socket-surface');
  assert.equal(compilation.nodesCompiled, 2);
  assert.deepEqual(compilation.outputNames, ['surface']);
  assert.deepEqual(compilation.features, { transparent: true, transmission: false, sheen: false });
  assert.equal(isCompiledSurface(compilation.outputs.surface), true);
  assert.deepEqual(compilation.outputs.baseColor.arguments, [0.04, 0.24, 0.08, 1]);
  assert.deepEqual(compilation.outputs.roughness.arguments, [0.31]);
  assert.deepEqual(compilation.outputs.metalness.arguments, [0.18]);
  assert.deepEqual(compilation.outputs.opacity.arguments, [0.92]);
  assert.equal(compilation.outputs.emissive.operation, 'mul');
});

test('createMaterial resolves graphId and binds compiled Blender surface channels', () => {
  const graph = blenderSurfaceGraph();
  const material = createMaterial(FAKE_THREE, {
    id: 'material/blender-paint',
    kind: 'material',
    materialKind: 'physical',
    graphId: graph.id,
    parameters: { side: 'double' },
  }, {
    TSL: FAKE_TSL,
    graphs: { [graph.id]: { id: graph.id, kind: 'graph', graph } },
  });

  assert.equal(material instanceof FakePhysicalNodeMaterial, true);
  assert.deepEqual(material.colorNode.arguments, [0.04, 0.24, 0.08, 1]);
  assert.deepEqual(material.roughnessNode.arguments, [0.31]);
  assert.deepEqual(material.metalnessNode.arguments, [0.18]);
  assert.equal(material.emissiveNode.operation, 'mul');
  assert.equal(material.side, FAKE_THREE.DoubleSide);
  assert.equal(material.userData.studioGraphId, graph.id);
  assert.equal(material.userData.studioGraphCompilation, 'tsl-webgpu');
  assert.equal(material.userData.studioGraphNodesCompiled, 2);
  assert.equal(material.transparent, true);
  assert.equal(material.transmissionNode, null, 'default zero transmission must not start a transmission pass');
  assert.equal(material.sheenNode, null, 'default zero sheen must not start a sheen lobe');
  assert.equal(material.sheen, 0);

  assert.throws(
    () => createMaterial(FAKE_THREE, { id: 'material/missing', kind: 'material', graphId: 'shader/missing' }, { TSL: FAKE_TSL, graphs: {} }),
    /references missing graph shader\/missing/,
  );
});

test('authored Principled sheen sockets compile onto the physical NodeMaterial', () => {
  const graph = blenderSurfaceGraph();
  graph.id = 'shader/blender-sheen-surface';
  graph.nodes[0].inputs.sheenWeight = 0.38;
  graph.nodes[0].inputs.sheenRoughness = 0.42;
  graph.nodes[0].inputs.sheenTint = [0.72, 0.08, 0.16, 1];

  const compilation = compileShaderGraph({ TSL: FAKE_TSL, graph });
  assert.deepEqual(compilation.features, { transparent: true, transmission: false, sheen: true });
  assert.deepEqual(compilation.outputs.sheen.arguments, [0.38]);
  assert.deepEqual(compilation.outputs.sheenRoughness.arguments, [0.42]);
  assert.deepEqual(compilation.outputs.sheenColor.arguments, [0.72, 0.08, 0.16, 1]);

  const material = createMaterial(FAKE_THREE, {
    id: 'material/velvet',
    kind: 'material',
    materialKind: 'physical',
    graphId: graph.id,
  }, {
    TSL: FAKE_TSL,
    graphs: { [graph.id]: { id: graph.id, kind: 'graph', graph } },
  });
  assert.deepEqual(material.sheenNode.arguments, [0.38]);
  assert.deepEqual(material.sheenRoughnessNode.arguments, [0.42]);
  assert.deepEqual(material.sheenColorNode.arguments, [0.72, 0.08, 0.16, 1]);
  assert.equal(material.sheen, 1);
});

test('unsupported Blender nodes and modes fail explicitly instead of flattening', () => {
  const unsupportedNode = {
    formatVersion: 1,
    id: 'shader/unsafe-script',
    domain: 'shader',
    nodes: [{ id: 'script', type: 'ShaderNodeScript', params: {} }],
    edges: [],
    outputs: { roughness: { nodeId: 'script', port: 'value' } },
  };
  assert.throws(
    () => compileShaderGraph({ TSL: FAKE_TSL, graph: unsupportedNode }),
    (error) => error instanceof GraphValidationError
      && error.diagnostics.some((entry) => entry.code === 'unknown_node_type' && entry.nodeId === 'script'),
  );

  const unsupportedMode = {
    formatVersion: 1,
    id: 'shader/unsupported-noise-mode',
    domain: 'shader',
    nodes: [{
      id: 'noise',
      type: 'ShaderNodeTexNoise',
      params: { dimensions: '4D' },
    }],
    edges: [],
    outputs: { roughness: { nodeId: 'noise', port: 'factor' } },
  };
  assert.throws(
    () => compileShaderGraph({ TSL: FAKE_TSL, graph: unsupportedMode }),
    (error) => error instanceof ShaderGraphCompileError
      && error.code === 'shader_node_mode_unsupported'
      && error.details.nodeId === 'noise'
      && /4D noise/.test(error.message),
  );
});
