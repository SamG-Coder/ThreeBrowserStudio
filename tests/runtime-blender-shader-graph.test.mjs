import assert from 'node:assert/strict';
import test from 'node:test';

import { GraphValidationError, validateGraph } from '../src/graphs/index.mjs';
import { createMaterial } from '../src/runtime/resource-factories.mjs';
import {
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
  transformDirection(value) { return new FakeNode('transformDirection', [this, value]); }
  get x() { return new FakeNode('x', [this]); }
  get y() { return new FakeNode('y', [this]); }
  get z() { return new FakeNode('z', [this]); }
  get xy() { return new FakeNode('xy', [this]); }
}

const FAKE_TSL = Object.freeze({
  float: (value) => new FakeNode('float', [value]),
  vec2: (...values) => new FakeNode('vec2', values),
  vec3: (...values) => new FakeNode('vec3', values),
  vec4: (...values) => new FakeNode('vec4', values),
  min: (...values) => new FakeNode('min', values),
  max: (...values) => new FakeNode('max', values),
  mix: (...values) => new FakeNode('mix', values),
  pow: (...values) => new FakeNode('pow', values),
  directionToFaceDirection: (...values) => new FakeNode('directionToFaceDirection', values),
  transformNormalToView: (...values) => new FakeNode('transformNormalToView', values),
  TBNViewMatrix: new FakeNode('TBNViewMatrix'),
  cameraViewMatrix: new FakeNode('cameraViewMatrix'),
  normalViewGeometry: new FakeNode('normalViewGeometry'),
  time: new FakeNode('time'),
  normalLocal: new FakeNode('normalLocal'),
  positionLocal: new FakeNode('positionLocal'),
});

function operations(value, visited = new Set()) {
  if (!(value instanceof FakeNode) || visited.has(value)) return [];
  visited.add(value);
  return [value.operation, ...value.arguments.flatMap(entry => operations(entry, visited))];
}

function operationNodes(value, operation, visited = new Set()) {
  if (!(value instanceof FakeNode) || visited.has(value)) return [];
  visited.add(value);
  return [
    ...(value.operation === operation ? [value] : []),
    ...value.arguments.flatMap(entry => operationNodes(entry, operation, visited)),
  ];
}

test('all catalogued binary math nodes compile to live TSL operations', () => {
  const expectedOperations = {
    add: 'add',
    subtract: 'sub',
    multiply: 'mul',
    divide: 'div',
    min: 'min',
    max: 'max',
    power: 'pow',
  };

  for (const [operation, expectedOperation] of Object.entries(expectedOperations)) {
    const graph = {
      formatVersion: 1,
      id: `shader/math-${operation}`,
      domain: 'shader',
      nodes: [
        { id: 'a', type: 'constant.float', params: { value: 0.75 } },
        { id: 'b', type: 'constant.float', params: { value: 0.25 } },
        { id: 'math', type: `math.${operation}`, params: { valueType: 'float' } },
      ],
      edges: [
        { from: { nodeId: 'a', port: 'value' }, to: { nodeId: 'math', port: 'a' } },
        { from: { nodeId: 'b', port: 'value' }, to: { nodeId: 'math', port: 'b' } },
      ],
      outputs: { roughness: { nodeId: 'math', port: 'value' } },
    };

    const compilation = compileShaderGraph({ TSL: FAKE_TSL, graph });
    assert.equal(compilation.outputs.roughness.operation, expectedOperation, operation);
  }
});

test('Time can drive a live Multiply node for animated shader phase', () => {
  const graph = {
    formatVersion: 1,
    id: 'shader/time-driven-phase',
    domain: 'shader',
    nodes: [
      { id: 'time', type: 'input.time', params: {} },
      { id: 'speed', type: 'constant.float', params: { value: 0.22 } },
      { id: 'phase', type: 'math.multiply', params: { valueType: 'float' } },
    ],
    edges: [
      { from: { nodeId: 'time', port: 'seconds' }, to: { nodeId: 'phase', port: 'a' } },
      { from: { nodeId: 'speed', port: 'value' }, to: { nodeId: 'phase', port: 'b' } },
    ],
    outputs: { roughness: { nodeId: 'phase', port: 'value' } },
  };

  const compilation = compileShaderGraph({ TSL: FAKE_TSL, graph });
  assert.equal(compilation.outputs.roughness.operation, 'mul');
  assert.equal(compilation.outputs.roughness.arguments[0].operation, 'time');
  assert.equal(compilation.outputs.roughness.arguments[1].operation, 'float');
  assert.deepEqual(compilation.outputs.roughness.arguments[1].arguments, [0.22]);
});

test('Normal Map compiles every catalogued space with one decode and the correct view transform', () => {
  const expectedTransform = {
    TANGENT: 'TBNViewMatrix',
    OBJECT: 'transformNormalToView',
    WORLD: 'cameraViewMatrix',
    BLENDER_OBJECT: 'transformNormalToView',
    BLENDER_WORLD: 'cameraViewMatrix',
  };

  for (const [space, transform] of Object.entries(expectedTransform)) {
    const graph = {
      formatVersion: 1,
      id: `shader/normal-map-${space.toLowerCase()}`,
      domain: 'shader',
      nodes: [{
        id: 'normal-map',
        type: 'ShaderNodeNormalMap',
        params: { space },
        inputs: { color: [0.5, 0.5, 1, 1], strength: 1.4 },
      }],
      edges: [],
      outputs: { normal: { nodeId: 'normal-map', port: 'normal' } },
    };

    const result = compileShaderGraph({ TSL: FAKE_TSL, graph }).outputs.normal;
    const trace = operations(result);
    assert.ok(trace.includes(transform), `${space} must use ${transform}`);
    assert.equal(trace.filter(operation => operation === 'sub').length, 1, `${space} decodes once`);
    assert.equal(trace.includes('normalMap'), false, `${space} avoids Three's second decode`);
    if (space.endsWith('OBJECT')) assert.equal(trace.includes('cameraViewMatrix'), false, space);
    if (space.endsWith('WORLD')) assert.equal(trace.includes('transformNormalToView'), false, space);
    if (space.startsWith('BLENDER_')) {
      assert.ok(result.arguments.length > 0, `${space} produces a live expression`);
      assert.ok(
        operationNodes(result, 'vec3').some(node => node.arguments.join(',') === '1,-1,-1'),
        `${space} includes the legacy Y/Z flip`,
      );
    }
  }
});

test('binary math preserves vector and colour types and rejects mixed sockets', () => {
  const vectorGraph = {
    formatVersion: 1,
    id: 'shader/vector-math-add',
    domain: 'shader',
    nodes: [
      { id: 'a', type: 'constant.vec3', params: { value: [1, 2, 3] } },
      { id: 'b', type: 'constant.vec3', params: { value: [4, 5, 6] } },
      { id: 'math', type: 'math.add', params: { valueType: 'vec3' } },
    ],
    edges: [
      { from: { nodeId: 'a', port: 'value' }, to: { nodeId: 'math', port: 'a' } },
      { from: { nodeId: 'b', port: 'value' }, to: { nodeId: 'math', port: 'b' } },
    ],
    outputs: { positionOffset: { nodeId: 'math', port: 'value' } },
  };
  const vectorCompilation = compileShaderGraph({ TSL: FAKE_TSL, graph: vectorGraph });
  assert.equal(vectorCompilation.outputs.positionOffset.operation, 'add');
  assert.equal(vectorCompilation.outputs.positionOffset.arguments[0].operation, 'vec3');
  assert.equal(vectorCompilation.outputs.positionOffset.arguments[1].operation, 'vec3');

  const colorGraph = structuredClone(vectorGraph);
  colorGraph.id = 'shader/colour-math-multiply';
  colorGraph.nodes = [
    { id: 'a', type: 'constant.color', params: { value: [0.2, 0.4, 0.8, 1] } },
    { id: 'b', type: 'constant.color', params: { value: [0.5, 0.75, 1, 1] } },
    { id: 'math', type: 'math.multiply', params: { valueType: 'color' } },
  ];
  colorGraph.outputs = { baseColor: { nodeId: 'math', port: 'value' } };
  const colorCompilation = compileShaderGraph({ TSL: FAKE_TSL, graph: colorGraph });
  assert.equal(colorCompilation.outputs.baseColor.operation, 'mul');
  assert.equal(colorCompilation.outputs.baseColor.arguments[0].operation, 'vec3');
  assert.equal(colorCompilation.outputs.baseColor.arguments[1].operation, 'vec3');

  const invalidGraph = structuredClone(vectorGraph);
  invalidGraph.id = 'shader/mixed-math-types';
  invalidGraph.nodes[0] = { id: 'a', type: 'constant.float', params: { value: 1 } };
  assert.throws(
    () => compileShaderGraph({ TSL: FAKE_TSL, graph: invalidGraph }),
    error => error instanceof GraphValidationError
      && error.diagnostics.some(entry => entry.code === 'port_type_mismatch'),
  );
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
  specularIntensityNode = null;
  specularColorNode = null;
  anisotropyNode = null;
  anisotropyRotationNode = null;
  anisotropy = 0;
  iridescenceNode = null;
  iridescenceIORNode = null;
  iridescenceThicknessNode = null;
  iridescence = 0;
  clearcoatNormalNode = null;

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
  assert.deepEqual(compilation.features, {
    transparent: true,
    transmission: false,
    sheen: false,
    specular: false,
    anisotropy: false,
    iridescence: false,
    subsurface: false,
  });
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
  assert.deepEqual(compilation.features, {
    transparent: true,
    transmission: false,
    sheen: true,
    specular: false,
    anisotropy: false,
    iridescence: false,
    subsurface: false,
  });
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

test('authored Principled subsurface controls compile as an explicit organic-material approximation', () => {
  const graph = blenderSurfaceGraph();
  graph.id = 'shader/blender-subsurface-surface';
  graph.nodes[0].inputs.subsurfaceWeight = 0.22;
  graph.nodes[0].inputs.subsurfaceRadius = [1, 0.32, 0.12];
  graph.nodes[0].inputs.subsurfaceScale = 0.08;
  const compilation = compileShaderGraph({ TSL: FAKE_TSL, graph });
  assert.equal(compilation.features.subsurface, true);
  assert.deepEqual(compilation.outputs.subsurfaceWeight.arguments, [0.22]);
  assert.deepEqual(compilation.outputs.subsurfaceRadius.arguments, [1, 0.32, 0.12]);
  assert.deepEqual(compilation.outputs.subsurfaceScale.arguments, [0.08]);
});

test('authored Principled specular, anisotropy, and thin-film sockets compile live', () => {
  const graph = blenderSurfaceGraph();
  graph.id = 'shader/blender-extra-lobes';
  graph.nodes[0].inputs.specularIorLevel = 0.28;
  graph.nodes[0].inputs.specularTint = [0.2, 0.4, 0.9, 1];
  graph.nodes[0].inputs.anisotropic = 0.55;
  graph.nodes[0].inputs.anisotropicRotation = 0.25;
  graph.nodes[0].inputs.thinFilmThickness = 400;
  graph.nodes[0].inputs.thinFilmIor = 1.45;

  const compilation = compileShaderGraph({ TSL: FAKE_TSL, graph });
  assert.equal(compilation.features.specular, true);
  assert.equal(compilation.features.anisotropy, true);
  assert.equal(compilation.features.iridescence, true);
  assert.deepEqual(compilation.outputs.specularIntensity.arguments, [0.28]);
  assert.deepEqual(compilation.outputs.anisotropy.arguments, [0.55]);
  assert.deepEqual(compilation.outputs.iridescenceThickness.arguments, [400]);

  const material = createMaterial(FAKE_THREE, {
    id: 'material/aniso',
    kind: 'material',
    materialKind: 'physical',
    graphId: graph.id,
  }, {
    TSL: FAKE_TSL,
    graphs: { [graph.id]: { id: graph.id, kind: 'graph', graph } },
  });
  assert.deepEqual(material.specularIntensityNode.arguments, [0.28]);
  assert.deepEqual(material.anisotropyNode.arguments, [0.55]);
  assert.equal(material.anisotropy, 1);
  assert.deepEqual(material.iridescenceThicknessNode.arguments, [400]);
  assert.equal(material.iridescence, 1);
});

test('unsupported Blender nodes and invalid catalog modes fail explicitly instead of flattening', () => {
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

  const invalidMode = {
    formatVersion: 1,
    id: 'shader/invalid-noise-mode',
    domain: 'shader',
    nodes: [{
      id: 'noise',
      type: 'ShaderNodeTexNoise',
      params: { dimensions: '5D' },
    }],
    edges: [],
    outputs: { roughness: { nodeId: 'noise', port: 'factor' } },
  };
  assert.throws(
    () => compileShaderGraph({ TSL: FAKE_TSL, graph: invalidMode }),
    (error) => error instanceof GraphValidationError
      && error.diagnostics.some(entry => entry.path.endsWith('/params/dimensions')),
  );
});
