import assert from 'node:assert/strict';
import test from 'node:test';
import { createGeometry, createMaterial, normalizeGeometryRecipe } from '../src/runtime/resource-factories.mjs';

class FakeGeometry {
  constructor(...arguments_) {
    this.arguments = arguments_;
    this.attributes = {};
  }

  getAttribute(name) { return this.attributes[name]; }
  computeVertexNormals() { this.attributes.normal = true; this.normalsComputed = true; }
  computeBoundingBox() { this.boundingBoxComputed = true; }
  computeBoundingSphere() { this.boundingSphereComputed = true; }
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

test('resource recipe takes precedence over resource kind', () => {
  const recipe = normalizeGeometryRecipe({ kind: 'geometry', recipe: { kind: 'torus', radius: 3 } });
  assert.equal(recipe.kind, 'torus');
  assert.equal(recipe.radius, 3);
  assert.equal(recipe.tubularSegments, 48);
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

test('unsupported materials, missing graphs, and unbound map inputs fail explicitly', () => {
  const THREE = {
    Color: class { setRGB() { return this; } set() { return this; } },
    MeshStandardMaterial: class {},
  };
  assert.throws(() => createMaterial(THREE, { id: 'material/unknown', kind: 'mystery' }), /Unsupported material recipe/);
  assert.throws(() => createMaterial(THREE, { id: 'material/graph', kind: 'standard', graphId: 'graph/pbr' }), /references missing graph graph\/pbr/);
  assert.throws(() => createMaterial(THREE, { id: 'material/map', kind: 'standard', mapId: 'texture/albedo' }), /image texture resources are not bound/);
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
