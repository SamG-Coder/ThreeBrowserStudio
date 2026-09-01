import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGeometry,
  createMaterial,
  indexedMeshRecipeFromBufferGeometry,
  normalizeGeometryRecipe,
  realizeGeometryRecipe,
} from '../src/runtime/resource-factories.mjs';

class FakeGeometry {
  constructor(...arguments_) {
    this.arguments = arguments_;
    this.attributes = {};
  }

  getAttribute(name) { return this.attributes[name]; }
  getIndex() {
    if (!this.index) return null;
    return { count: this.index.length, getX: index => this.index[index] };
  }
  computeVertexNormals() { this.attributes.normal = true; this.normalsComputed = true; }
  computeBoundingBox() { this.boundingBoxComputed = true; }
  computeBoundingSphere() { this.boundingSphereComputed = true; }
  setAttribute(name, value) { this.attributes[name] = value; return this; }
  setIndex(value) { this.index = value; return this; }
  dispose() { this.disposeCount = (this.disposeCount ?? 0) + 1; }
}

class FakePath {
  constructor() { this.commands = []; }
  moveTo(x, y) { this.commands.push(['moveTo', x, y]); }
  lineTo(x, y) { this.commands.push(['lineTo', x, y]); }
}

class FakeShape extends FakePath {
  constructor() { super(); this.holes = []; }
}

class FakeCurve {
  constructor(points, closed, curveType, tension) {
    Object.assign(this, { points, closed, curveType, tension });
  }
}

const FAKE_THREE = {
  BufferGeometry: FakeGeometry,
  Float32BufferAttribute: class {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.count = array.length / itemSize; }
    getX(index) { return this.array[index * this.itemSize]; }
    getY(index) { return this.array[index * this.itemSize + 1]; }
    getZ(index) { return this.array[index * this.itemSize + 2]; }
  },
  Vector2: class { constructor(x, y) { Object.assign(this, { x, y }); } },
  Vector3: class { constructor(x, y, z) { Object.assign(this, { x, y, z }); } },
  CatmullRomCurve3: FakeCurve,
  Shape: FakeShape,
  Path: FakePath,
  LatheGeometry: class extends FakeGeometry {},
  TubeGeometry: class extends FakeGeometry {},
  ShapeGeometry: class extends FakeGeometry {},
  ExtrudeGeometry: class extends FakeGeometry {},
};

test('geometry recipes get deterministic defaults', () => {
  assert.deepEqual(normalizeGeometryRecipe({ kind: 'box', width: 4 }), {
    kind: 'box',
    width: 4,
    height: 1,
    depth: 1,
    widthSegments: 1,
    heightSegments: 1,
    depthSegments: 1,
  });
});

test('geometry recipes clamp unsafe segment counts', () => {
  const recipe = normalizeGeometryRecipe({ recipe: { kind: 'sphere', widthSegments: 20000, heightSegments: -1 } });
  assert.equal(recipe.widthSegments, 512);
  assert.equal(recipe.heightSegments, 1);
});

test('aggregate tessellation and readback budgets reject adversarial geometry before allocation', () => {
  assert.throws(
    () => createGeometry(FAKE_THREE, {
      kind: 'box', widthSegments: 512, heightSegments: 512, depthSegments: 512,
    }),
    error => error.code === 'geometry_budget_exceeded'
      && error.details.estimated.vertices > error.details.limits.maxVertices,
  );
  let attributeRead = false;
  assert.throws(
    () => indexedMeshRecipeFromBufferGeometry({
      getAttribute(name) {
        if (name !== 'position') return null;
        return {
          count: 1_000_001,
          getX() { attributeRead = true; return 0; },
        };
      },
      getIndex() { return null; },
    }),
    error => error.code === 'geometry_budget_exceeded',
  );
  assert.equal(attributeRead, false);
});

test('resource recipe takes precedence over resource kind', () => {
  const recipe = normalizeGeometryRecipe({ kind: 'geometry', recipe: { kind: 'torus', radius: 3 } });
  assert.equal(recipe.kind, 'torus');
  assert.equal(recipe.radius, 3);
  assert.equal(recipe.tubularSegments, 48);
});

test('direct legacy indexed and explicit types outrank a generic geometry envelope kind', () => {
  for (const type of ['indexedMesh', 'explicit']) {
    const recipe = normalizeGeometryRecipe({
      id: `geometry/direct-${type}`,
      kind: 'geometry',
      type,
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
    });
    assert.equal(recipe.kind, type);
    assert.deepEqual(recipe.indices, [0, 1, 2]);
  }
});

test('procedural recipe aliases normalize deterministically and clamp tessellation budgets', () => {
  const profile = [[0, -1], [0.5, 0], [0, 1]];
  const lathe = normalizeGeometryRecipe({ kind: 'lathe', profile, segments: 5000 });
  assert.deepEqual(lathe.points, profile);
  assert.notEqual(lathe.points, profile);
  assert.equal(lathe.segments, 256);

  const tube = normalizeGeometryRecipe({
    kind: 'tube',
    path: [[0, 0, 0], [1, 1, 0]],
    tubularSegments: 5000,
    radialSegments: 5000,
  });
  assert.equal(tube.tubularSegments, 512);
  assert.equal(tube.radialSegments, 128);

  const extrude = normalizeGeometryRecipe({
    kind: 'extrude',
    contour: [[0, 0], [1, 0], [0, 1]],
    curveSegments: 5000,
    steps: 5000,
    bevelSegments: 5000,
  });
  assert.equal(extrude.curveSegments, 64);
  assert.equal(extrude.steps, 128);
  assert.equal(extrude.bevelSegments, 16);
});

test('lathe and tube recipes build typed Three.js curves and finalized geometry', () => {
  const lathe = createGeometry(FAKE_THREE, {
    kind: 'lathe',
    points: [[0, -1], [0.75, -0.5], { x: 0.5, y: 1 }],
    segments: 20,
    phiLength: Math.PI,
  });
  assert.deepEqual(lathe.arguments[0].map(({ x, y }) => [x, y]), [[0, -1], [0.75, -0.5], [0.5, 1]]);
  assert.deepEqual(lathe.arguments.slice(1), [20, 0, Math.PI]);
  assert.equal(lathe.normalsComputed, true);
  assert.equal(lathe.boundingBoxComputed, true);
  assert.equal(lathe.boundingSphereComputed, true);

  const tube = createGeometry(FAKE_THREE, {
    kind: 'tube',
    points: [[0, 0, 0], [0.5, 1, 0], [1, 0, 0]],
    closed: true,
    curveType: 'catmullrom',
    tension: 0.25,
    tubularSegments: 40,
    radius: 0.2,
    radialSegments: 7,
  });
  const [curve, tubularSegments, radius, radialSegments, closed] = tube.arguments;
  assert.deepEqual(curve.points.map(({ x, y, z }) => [x, y, z]), [[0, 0, 0], [0.5, 1, 0], [1, 0, 0]]);
  assert.deepEqual([curve.closed, curve.curveType, curve.tension], [true, 'catmullrom', 0.25]);
  assert.deepEqual([tubularSegments, radius, radialSegments, closed], [40, 0.2, 7, true]);
});

test('loft creates one continuous bounded shell across exact equal-size profiles', () => {
  const loft = createGeometry(FAKE_THREE, {
    kind: 'loft',
    sections: [
      [[-1, -0.5, 0], [1, -0.5, 0], [1, 0.5, 0], [-1, 0.5, 0]],
      [[-0.8, -0.4, 1], [0.8, -0.4, 1], [0.8, 0.4, 1], [-0.8, 0.4, 1]],
      [[-0.3, -0.2, 2], [0.3, -0.2, 2], [0.3, 0.2, 2], [-0.3, 0.2, 2]],
    ],
  });
  assert.equal(loft.attributes.position.array.length, 36);
  assert.equal(loft.index.length, 60);
  assert.equal(loft.normalsComputed, true);
  assert.throws(() => createGeometry(FAKE_THREE, {
    kind: 'loft', sections: [[[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]]],
  }), /same number/);
});

test('closed lofts orient their shell outward for either authored profile winding', () => {
  const sections = [
    [[-1, -0.5, 0], [1, -0.5, 0], [1, 0.5, 0], [-1, 0.5, 0]],
    [[-0.8, -0.4, 1], [0.8, -0.4, 1], [0.8, 0.4, 1], [-0.8, 0.4, 1]],
  ];
  const outwardScore = geometry => {
    const positions = geometry.attributes.position.array;
    const indices = geometry.index;
    let score = 0;
    for (let triangle = 0; triangle < 8; triangle += 1) {
      const points = indices.slice(triangle * 3, triangle * 3 + 3).map(index => (
        positions.slice(index * 3, index * 3 + 3)
      ));
      const [a, b, c] = points;
      const ab = b.map((value, axis) => value - a[axis]);
      const ac = c.map((value, axis) => value - a[axis]);
      const normal = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
      ];
      const center = points.reduce(
        (sum, point) => sum.map((value, axis) => value + point[axis] / 3),
        [0, 0, 0],
      );
      score += normal[0] * center[0] + normal[1] * center[1];
    }
    return score;
  };

  const counterClockwise = createGeometry(FAKE_THREE, { kind: 'loft', sections });
  const clockwise = createGeometry(FAKE_THREE, {
    kind: 'loft',
    sections: sections.map(section => [...section].reverse()),
  });
  assert.ok(outwardScore(counterClockwise) > 0);
  assert.ok(outwardScore(clockwise) > 0);
});

test('geometry realization converts a procedural loft into canonical editable topology', () => {
  const recipe = realizeGeometryRecipe(FAKE_THREE, {
    kind: 'loft',
    sections: [
      [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]],
      [[-0.5, -0.5, 1], [0.5, -0.5, 1], [0.5, 0.5, 1], [-0.5, 0.5, 1]],
    ],
  });
  assert.equal(recipe.kind, 'editableMesh');
  assert.equal(recipe.positions.length, 24);
  assert.equal(recipe.faceOffsets.length, 13);
  assert.equal(recipe.cornerVertexIndices.length, 36);
  assert.equal(recipe.faceMaterialIndices.length, 12);
});

test('loft v2 resamples named transformed rings, interpolates sections, and emits UVs', () => {
  const loft = createGeometry(FAKE_THREE, {
    kind: 'loft',
    profileResolution: 8,
    subdivisions: 2,
    alignProfile: 'closest',
    sections: [
      { id: 'section/root', points: [[-1, -1, 0], [1, -1, 0], [0, 1, 0]] },
      {
        id: 'section/crown',
        points: [[-1, -1, 0], [0, -1.4, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]],
        transform: { scale: [0.6, 0.6, 1], rotation: [0, 0, 0.2], translation: [0, 0, 3] },
      },
    ],
  });
  assert.equal(loft.attributes.position.count, 32, 'two authored rings plus two interpolated rings');
  assert.equal(loft.attributes.uv.count, 32);
  assert.equal(loft.index.length, 180);
  assert.ok(Math.max(...loft.attributes.position.array.filter((_, index) => index % 3 === 2)) >= 3);
});

test('dense loft caps add regular concentric topology without changing the default cap path', () => {
  const sections = [
    [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]],
    [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]],
  ];
  const legacy = createGeometry(FAKE_THREE, { kind: 'loft', sections, capStart: true, capEnd: true });
  const dense = createGeometry(FAKE_THREE, { kind: 'loft', sections, capStart: true, capEnd: true, capRings: 2 });
  assert.equal(legacy.attributes.position.count, 8);
  assert.equal(dense.attributes.position.count, 34);
  assert.equal(dense.attributes.uv.count, dense.attributes.position.count);
  assert.equal(dense.index.length / 3, 48);
});

test('guided lofts apply deterministic rails, local form modifiers, and continuity interpolation', () => {
  const baseSections = [
    [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]],
    [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]],
    [[-1, 2, -1], [1, 2, -1], [1, 2, 1], [-1, 2, 1]],
  ];
  const loft = createGeometry(FAKE_THREE, {
    kind: 'loft', sections: baseSections, profileResolution: 4, subdivisions: 2,
    continuity: 'curvature',
    guideCurves: [{ profileIndex: 2, points: [[1, 0, 1], [1.35, 1, 1.2], [1.1, 2, 1]] }],
    modifiers: [{ kind: 'bulge', center: [1.35, 1, 1.2], amount: 0.15, radius: 1 }],
  });
  assert.equal(loft.attributes.position.count, 28);
  const positions = loft.attributes.position.array;
  assert.ok(Math.max(...positions.filter((_, index) => index % 3 === 0)) > 1.35);
  assert.throws(() => createGeometry(FAKE_THREE, {
    kind: 'loft', sections: baseSections, continuity: 'curvature-ish',
  }), /continuity/u);
});

test('CSG recipes deterministically subtract, union, and intersect authored solids', () => {
  const cube = (centreX, size = 2) => {
    const half = size / 2;
    const positions = [
      -half,-half,-half, half,-half,-half, half,half,-half, -half,half,-half,
      -half,-half,half, half,-half,half, half,half,half, -half,half,half,
    ].map((value, index) => index % 3 === 0 ? value + centreX : value);
    return {
      kind: 'explicit', positions,
      indices: [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7],
    };
  };
  for (const operation of ['subtract', 'union', 'intersect']) {
    const geometry = createGeometry(FAKE_THREE, {
      kind: 'csg', operation,
      operands: [{ recipe: cube(0) }, { recipe: cube(0.75) }],
    });
    assert.ok(geometry.attributes.position.count >= 3, operation);
    assert.equal(geometry.attributes.uv.count, geometry.attributes.position.count);
    assert.equal(geometry.normalsComputed, true);
    assert.equal(geometry.boundingBoxComputed, true);
  }
  const faired = createGeometry(FAKE_THREE, {
    kind: 'csg', operation: 'union', operands: [{ recipe: cube(0) }, { recipe: cube(0.75) }],
    fairing: { points: [[0.25, -1, 0], [0.25, 1, 0]], radius: 1, iterations: 2, strength: 0.3, continuity: 'curvature' },
  });
  assert.ok(faired.index.length > 0);
  assert.equal(faired.attributes.uv.count, faired.attributes.position.count);
  assert.throws(() => createGeometry(FAKE_THREE, {
    kind: 'csg', operation: 'xor', operands: [{ recipe: cube(0) }, { recipe: cube(1) }],
  }), /union, subtract, or intersect/u);
});

test('CSG rejects detailed curved loft operands before recursive work can exhaust memory', () => {
  const cube = {
    kind: 'explicit',
    positions: [-1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1, -1,-1,1, 1,-1,1, 1,1,1, -1,1,1],
    indices: [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7],
  };
  const detailedSections = Array.from({ length: 11 }, (_, index) => ({
    points: Array.from({ length: 24 }, (_, pointIndex) => {
      const angle = pointIndex / 24 * Math.PI * 2;
      return [Math.cos(angle), index * 0.3, Math.sin(angle)];
    }),
  }));
  assert.throws(() => createGeometry(FAKE_THREE, {
    kind: 'csg', operation: 'subtract', operands: [
      { recipe: { kind: 'loft', sections: detailedSections, profileResolution: 24, subdivisions: 3 } },
      { recipe: cube },
    ],
  }), /64-triangle curved-surface safety limit/u);
});

test('CSG bounds pathological intermediate BSP splitting below the input triangle limit', () => {
  const profile = [[0, 0.62], [0.52, 0.3], [0.46, -0.42], [0, -0.62], [-0.46, -0.42], [-0.52, 0.3]];
  const section = (height, widthScale, depthScale) => ({
    points: profile.map(([x, z]) => [x * widthScale, height, z * depthScale]),
  });
  const head = {
    kind: 'loft', closedProfile: true, capStart: true, capEnd: true,
    profileResolution: 6, subdivisions: 0, continuity: 'positional',
    sections: [
      section(-0.9, 0.72, 0.7), section(-0.4, 1, 0.92),
      section(0.35, 1.04, 0.98), section(1, 0.78, 0.76),
    ],
  };
  const nose = {
    kind: 'explicit',
    positions: [-0.14,-0.24,-0.21, 0.14,-0.24,-0.21, 0.14,0.24,-0.21, -0.14,0.24,-0.21, -0.14,-0.24,0.21, 0.14,-0.24,0.21, 0.14,0.24,0.21, -0.14,0.24,0.21],
    indices: [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7],
  };
  const started = performance.now();
  const geometry = createGeometry(FAKE_THREE, {
    kind: 'csg', operation: 'union', operands: [
      { recipe: head },
      { recipe: nose, transform: { position: [0, -0.05, 0.48] } },
    ],
  });
  assert.ok(geometry.attributes.position.count >= 3);
  assert.ok(performance.now() - started < 2_000, 'bounded splitter selection must prevent pathological CSG work');
});

test('shape and extrude recipes build contours and holes with bounded options', () => {
  const recipe = {
    points: [[0, 0], [2, 0], [2, 2], [0, 2]],
    holes: [[[0.5, 0.5], [1.5, 0.5], [1, 1.5]]],
  };
  const shape = createGeometry(FAKE_THREE, { kind: 'shape', ...recipe, curveSegments: 8 });
  assert.equal(shape.arguments[0] instanceof FakeShape, true);
  assert.deepEqual(shape.arguments[0].commands, [
    ['moveTo', 0, 0], ['lineTo', 2, 0], ['lineTo', 2, 2], ['lineTo', 0, 2],
  ]);
  assert.deepEqual(shape.arguments[0].holes[0].commands, [
    ['moveTo', 0.5, 0.5], ['lineTo', 1.5, 0.5], ['lineTo', 1, 1.5],
  ]);
  assert.equal(shape.arguments[1], 8);

  const extrude = createGeometry(FAKE_THREE, {
    kind: 'extrude',
    ...recipe,
    depth: 2,
    steps: 4,
    curveSegments: 6,
    bevelEnabled: true,
    bevelThickness: 0.2,
    bevelSize: 0.15,
    bevelOffset: -0.02,
    bevelSegments: 5,
  });
  assert.deepEqual(extrude.arguments[1], {
    curveSegments: 6,
    steps: 4,
    depth: 2,
    bevelEnabled: true,
    bevelThickness: 0.2,
    bevelSize: 0.15,
    bevelOffset: -0.02,
    bevelSegments: 5,
  });
});

test('procedural recipes reject dirty control data and unsupported curve modes', () => {
  assert.throws(
    () => createGeometry(FAKE_THREE, { kind: 'lathe', points: [[-1, 0], [0, 1]] }),
    /radii must be non-negative/,
  );
  assert.throws(
    () => createGeometry(FAKE_THREE, { kind: 'tube', points: [[0, 0, 0], [1, 0, 0]], curveType: 'bezier' }),
    /curveType/,
  );
  assert.throws(
    () => createGeometry(FAKE_THREE, { kind: 'shape', points: [[0, 0], [1, 0], [0, Number.NaN]] }),
    /finite coordinates/,
  );
});

test('unsupported materials, missing graphs, and unavailable texture IDs fail explicitly', () => {
  const THREE = {
    Color: class { setRGB() { return this; } set() { return this; } },
    MeshStandardMaterial: class {},
  };
  assert.throws(() => createMaterial(THREE, { id: 'material/unknown', kind: 'mystery' }), /Unsupported material recipe/);
  assert.throws(() => createMaterial(THREE, { id: 'material/graph', kind: 'standard', graphId: 'graph/pbr' }), /references missing graph graph\/pbr/);
  assert.throws(
    () => createMaterial(THREE, { id: 'material/map', kind: 'standard', mapId: 'texture/albedo' }),
    error => error?.code === 'material_texture_unavailable'
      && error.details.textureId === 'texture/albedo'
      && error.details.idKey === 'baseColorMapId',
  );
});

test('stable texture IDs bind exact material slots, controls, transparency, and diagnostics', () => {
  class FakeColor { setRGB() { return this; } set() { return this; } }
  class FakeVector2 { constructor(x, y) { Object.assign(this, { x, y }); } }
  class FakePhysicalMaterial {
    constructor(parameters) {
      this.parameters = parameters;
      this.aoMapIntensity = 1;
      this.bumpScale = 1;
      this.displacementScale = 1;
      this.displacementBias = 0;
      this.normalScale = null;
      this.userData = { preserved: true };
    }
  }
  const THREE = {
    Color: FakeColor,
    Vector2: FakeVector2,
    MeshPhysicalMaterial: FakePhysicalMaterial,
  };
  const textures = Object.fromEntries([
    'albedo', 'normal', 'roughness', 'ao', 'displacement', 'alpha',
  ].map(name => [`texture/${name}`, { name }]));
  const resolvedIds = [];
  const material = createMaterial(THREE, {
    id: 'material/textured-road',
    name: 'Textured road',
    recipe: {
      type: 'physical',
      baseColorMapId: 'texture/albedo',
      normalMapId: 'texture/normal',
      roughnessMapId: 'texture/roughness',
      aoMapId: 'texture/ao',
      displacementMapId: 'texture/displacement',
      alphaMapId: 'texture/alpha',
      aoMapIntensity: 0.7,
      displacementScale: 0.15,
      displacementBias: -0.02,
      normalScale: [0.8, 0.6],
      vertexColors: true,
    },
  }, {
    textureResolver(textureId) {
      resolvedIds.push(textureId);
      return textures[textureId];
    },
  });

  assert.deepEqual(resolvedIds, [
    'texture/albedo', 'texture/normal', 'texture/roughness',
    'texture/alpha', 'texture/ao', 'texture/displacement',
  ]);
  assert.equal(material.map, textures['texture/albedo']);
  assert.equal(material.normalMap, textures['texture/normal']);
  assert.equal(material.roughnessMap, textures['texture/roughness']);
  assert.equal(material.alphaMap, textures['texture/alpha']);
  assert.equal(material.aoMap, textures['texture/ao']);
  assert.equal(material.displacementMap, textures['texture/displacement']);
  assert.equal(material.aoMapIntensity, 0.7);
  assert.equal(material.displacementScale, 0.15);
  assert.equal(material.displacementBias, -0.02);
  assert.deepEqual(material.normalScale, new FakeVector2(0.8, 0.6));
  assert.equal(material.vertexColors, true);
  assert.equal(material.transparent, true);
  assert.equal(material.depthWrite, false);
  assert.equal(material.needsUpdate, true);
  assert.deepEqual(material.userData.studioTextureBindings, [
    {
      slot: 'map', textureId: 'texture/albedo', colorSpace: 'srgb', preferredColorSpace: 'srgb',
      allowedColorSpaces: ['srgb', 'linear'], allowedChannels: [1, 2, 3, 4],
    },
    {
      slot: 'normalMap', textureId: 'texture/normal', colorSpace: 'none', preferredColorSpace: 'none',
      allowedColorSpaces: ['none'], allowedChannels: [3, 4],
    },
    {
      slot: 'roughnessMap', textureId: 'texture/roughness', colorSpace: 'none', preferredColorSpace: 'none',
      allowedColorSpaces: ['none'], allowedChannels: [1, 2, 3, 4],
    },
    {
      slot: 'alphaMap', textureId: 'texture/alpha', colorSpace: 'none', preferredColorSpace: 'none',
      allowedColorSpaces: ['none'], allowedChannels: [1, 2, 3, 4],
    },
    {
      slot: 'aoMap', textureId: 'texture/ao', colorSpace: 'none', preferredColorSpace: 'none',
      allowedColorSpaces: ['none'], allowedChannels: [1, 2, 3, 4],
    },
    {
      slot: 'displacementMap', textureId: 'texture/displacement', colorSpace: 'none', preferredColorSpace: 'none',
      allowedColorSpaces: ['none'], allowedChannels: [1, 2, 3, 4],
    },
  ]);
  assert.deepEqual(material.userData.studioMapAwareDefaults, {});
});

test('physical texture maps activate neutral scalar and color multipliers by default', () => {
  class FakeColor {
    setRGB(...values) { this.values = values; return this; }
    set(value) { this.value = value; return this; }
  }
  class FakePhysicalMaterial {
    constructor(parameters) {
      this.parameters = parameters;
      this.color = parameters.color;
      this.emissive = new FakeColor().setRGB(0, 0, 0);
      this.sheenColor = new FakeColor().setRGB(0, 0, 0);
      this.specularColor = new FakeColor().setRGB(0, 0, 0);
      this.metalness = 0;
      this.clearcoat = 0;
      this.transmission = 0;
      this.sheen = 0;
      this.anisotropy = 0;
      this.iridescence = 0;
      this.userData = {};
    }
  }
  const THREE = { Color: FakeColor, MeshPhysicalMaterial: FakePhysicalMaterial };
  const colorTexture = { userData: { studioSourceChannels: 4 } };
  const scalarTexture = { userData: { studioSourceChannels: 1 } };
  const anisotropyTexture = { userData: { studioSourceChannels: 3 } };
  const textures = {
    'texture/base': colorTexture,
    'texture/emissive': colorTexture,
    'texture/metalness': scalarTexture,
    'texture/clearcoat': scalarTexture,
    'texture/transmission': scalarTexture,
    'texture/sheen': colorTexture,
    'texture/specular': colorTexture,
    'texture/anisotropy': anisotropyTexture,
    'texture/iridescence': scalarTexture,
  };
  const material = createMaterial(THREE, {
    id: 'material/neutral-maps',
    recipe: {
      kind: 'physical',
      baseColorMapId: 'texture/base',
      emissiveMapId: 'texture/emissive',
      metalnessMapId: 'texture/metalness',
      clearcoatMapId: 'texture/clearcoat',
      transmissionMapId: 'texture/transmission',
      sheenColorMapId: 'texture/sheen',
      specularColorMapId: 'texture/specular',
      anisotropyMapId: 'texture/anisotropy',
      iridescenceMapId: 'texture/iridescence',
    },
  }, { textureResolver: textureId => textures[textureId] });

  assert.deepEqual(material.color.values, [1, 1, 1]);
  assert.deepEqual(material.emissive.values, [1, 1, 1]);
  assert.equal(material.metalness, 1);
  assert.equal(material.clearcoat, 1);
  assert.equal(material.transmission, 1);
  assert.equal(material.sheen, 1);
  assert.equal(material.anisotropy, 1);
  assert.equal(material.iridescence, 1);
  assert.deepEqual(material.sheenColor.values, [1, 1, 1]);
  assert.deepEqual(material.specularColor.values, [1, 1, 1]);
  assert.deepEqual(material.userData.studioMapAwareDefaults, {
    metalness: 1,
    emissive: [1, 1, 1],
    clearcoat: 1,
    transmission: 1,
    sheen: 1,
    sheenColor: [1, 1, 1],
    specularColor: [1, 1, 1],
    anisotropy: 1,
    iridescence: 1,
  });
});

test('alpha maps with an authored cutoff stay opaque and depth-writing', () => {
  class FakeColor { setRGB() { return this; } set() { return this; } }
  class FakeStandardMaterial {
    constructor() { this.alphaTest = 0; this.userData = {}; }
  }
  const alpha = { userData: { studioSourceChannels: 1 } };
  const material = createMaterial({ Color: FakeColor, MeshStandardMaterial: FakeStandardMaterial }, {
    id: 'material/cutout', kind: 'standard',
    alphaMapId: 'texture/alpha', alphaTest: 0.5,
  }, { textureResolver: textureId => textureId === 'texture/alpha' ? alpha : null });
  assert.equal(material.alphaMap, alpha);
  assert.equal(material.alphaTest, 0.5);
  assert.equal(material.transparent, false);
  assert.equal(material.depthWrite, true);
});

test('runtime map binding rejects channel mismatches and direct graph-output conflicts', () => {
  class FakeColor { setRGB() { return this; } set() { return this; } }
  class FakePhysicalMaterial { constructor() { this.userData = {}; } }
  const THREE = { Color: FakeColor, MeshPhysicalMaterial: FakePhysicalMaterial };
  assert.throws(() => createMaterial(THREE, {
    id: 'material/bad-normal', kind: 'physical', normalMapId: 'texture/one-channel',
  }, {
    textureResolver: () => ({ userData: { studioSourceChannels: 1 } }),
  }), error => error?.code === 'material_texture_channel_mismatch'
    && error.details.idKey === 'normalMapId');

  assert.throws(() => createMaterial(THREE, {
    id: 'material/bad-normal-color-space', kind: 'physical', normalMapId: 'texture/srgb-normal',
  }, {
    textureResolver: () => ({
      userData: { studioSourceChannels: 3, studioColorSpace: 'srgb' },
    }),
  }), error => error?.code === 'material_texture_color_space_mismatch'
    && error.details.idKey === 'normalMapId'
    && error.details.sourceColorSpace === 'srgb'
    && error.details.allowedColorSpaces.length === 1
    && error.details.allowedColorSpaces[0] === 'none');

  const linearColorTexture = {
    userData: { studioSourceChannels: 4, studioColorSpace: 'linear' },
  };
  const linearColorMaterial = createMaterial(THREE, {
    id: 'material/linear-base-color', kind: 'physical', baseColorMapId: 'texture/linear-color',
  }, { textureResolver: () => linearColorTexture });
  assert.equal(linearColorMaterial.map, linearColorTexture);

  const graph = {
    id: 'graph/base-color',
    kind: 'graph',
    graph: {
      formatVersion: 1,
      id: 'graph/base-color',
      domain: 'shader',
      nodes: [{ id: 'color', type: 'constant.color', params: { value: [0.2, 0.4, 0.6] } }],
      edges: [],
      outputs: { baseColor: { nodeId: 'color', port: 'value' } },
    },
  };
  assert.throws(() => createMaterial(THREE, {
    id: 'material/graph-conflict', kind: 'physical',
    graphId: 'graph/base-color', baseColorMapId: 'texture/albedo',
  }, {
    TSL: { vec3: (...values) => ({ values }) },
    graphs: { 'graph/base-color': graph },
    textureResolver: () => ({ userData: { studioSourceChannels: 4 } }),
  }), error => error?.code === 'material_texture_graph_conflict'
    && error.details.conflicts[0].graphOutput === 'baseColor');
});

test('an explicit opaque material overrides inferred alpha blending', () => {
  const THREE = {
    Color: class { setRGB() { return this; } set() { return this; } },
    MeshStandardMaterial: class {},
  };
  const opaque = createMaterial(THREE, {
    id: 'material/opaque-paint', kind: 'standard', opacity: 0.5, transparent: false,
  });
  assert.equal(opaque.transparent, false);
  assert.equal(opaque.depthWrite, true);

  const blended = createMaterial(THREE, {
    id: 'material/blended-water', kind: 'standard', opacity: 0.5, transparent: true,
  });
  assert.equal(blended.transparent, true);
  assert.equal(blended.depthWrite, false);
});

test('persisted material recipes preserve the type and color of non-graph materials', () => {
  class FakeColor {
    setRGB(r, g, b) { Object.assign(this, { r, g, b }); return this; }
    set(value) { this.value = value; return this; }
  }
  class FakeBasicMaterial {
    constructor(parameters) { this.parameters = parameters; }
  }
  class FakeStandardMaterial {
    constructor(parameters) { this.parameters = parameters; this.roughness = 1; this.metalness = 0; }
  }
  class FakeBasicNodeMaterial extends FakeBasicMaterial {}
  class FakeStandardNodeMaterial extends FakeStandardMaterial {}
  const THREE = {
    Color: FakeColor,
    MeshBasicMaterial: FakeBasicMaterial,
    MeshStandardMaterial: FakeStandardMaterial,
    MeshBasicNodeMaterial: FakeBasicNodeMaterial,
    MeshStandardNodeMaterial: FakeStandardNodeMaterial,
  };

  const iron = createMaterial(THREE, {
    id: 'material/painterly-hut/iron',
    kind: 'material',
    recipe: { type: 'basic', color: [0.018, 0.035, 0.05, 1] },
  });
  assert.equal(iron instanceof FakeBasicMaterial, true);
  assert.equal(iron instanceof FakeBasicNodeMaterial, false);
  assert.deepEqual(
    [iron.parameters.color.r, iron.parameters.color.g, iron.parameters.color.b],
    [0.018, 0.035, 0.05],
  );

  const rock = createMaterial(THREE, {
    id: 'material/painterly-hut/rock-cool',
    kind: 'material',
    recipe: {
      type: 'standard',
      color: [0.12, 0.19, 0.22, 1],
      roughness: 0.97,
      metalness: 0,
    },
  });
  assert.equal(rock instanceof FakeStandardMaterial, true);
  assert.equal(rock instanceof FakeStandardNodeMaterial, false);
  assert.deepEqual(
    [rock.parameters.color.r, rock.parameters.color.g, rock.parameters.color.b],
    [0.12, 0.19, 0.22],
  );
  assert.equal(rock.roughness, 0.97);
  assert.equal(rock.metalness, 0);
});
