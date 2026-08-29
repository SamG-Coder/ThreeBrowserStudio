import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectDocument, validateProjectDocument } from '../src/core/index.mjs';
import { compileSceneDocument } from '../src/runtime/scene-compiler.mjs';

function fakeThree() {
  class VectorLike {
    fromArray(values) { this.values = [...values]; return this; }
    copy(other) { this.values = [...(other.values ?? [other.x, other.y, other.z])]; return this; }
    lerp(other, influence) {
      const values = other.values ?? [other.x, other.y, other.z];
      this.values = this.values.map((value, index) => value + (values[index] - value) * influence);
      return this;
    }
    toArray() { return [...(this.values ?? [0, 0, 0])]; }
  }
  class Object3D {
    constructor() {
      this.children = [];
      this.parent = null;
      this.position = new VectorLike();
      this.rotation = new VectorLike();
      this.scale = new VectorLike();
      this.userData = {};
    }
    add(child) {
      child.removeFromParent();
      child.parent = this;
      this.children.push(child);
    }
    removeFromParent() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter(child => child !== this);
      this.parent = null;
    }
    clear() {
      for (const child of this.children) child.parent = null;
      this.children = [];
    }
    updateMatrix() {}
    updateMatrixWorld() {}
    lookAt(...values) { this.lookAtValues = values; }
  }
  class Group extends Object3D {}
  class Color {
    setRGB(...values) {
      this.values = values;
      [this.r, this.g, this.b] = values;
      return this;
    }
    set(value) { this.value = value; return this; }
  }
  class DisposableGeometry {
    constructor() { this.userData = {}; this.disposeCount = 0; }
    dispose() { this.disposeCount += 1; }
  }
  class Float32BufferAttribute {
    constructor(values, itemSize) {
      this.array = Array.from(values);
      this.itemSize = itemSize;
      this.count = this.array.length / itemSize;
    }
    getX(index) { return this.array[index * this.itemSize]; }
    getY(index) { return this.array[index * this.itemSize + 1]; }
    getZ(index) { return this.array[index * this.itemSize + 2]; }
    getW(index) { return this.array[index * this.itemSize + 3]; }
  }
  class BufferGeometry extends DisposableGeometry {
    constructor() {
      super();
      this.attributes = {};
      this.groups = [];
      this.index = null;
    }
    setAttribute(name, value) { this.attributes[name] = value; return this; }
    getAttribute(name) { return this.attributes[name]; }
    setIndex(values) {
      const array = Array.from(values);
      this.index = { array, count: array.length, getX: index => array[index] };
      return this;
    }
    getIndex() { return this.index; }
    clearGroups() { this.groups = []; }
    addGroup(start, count, materialIndex) { this.groups.push({ start, count, materialIndex }); }
    computeVertexNormals() {
      const positions = this.attributes.position;
      this.attributes.normal = new Float32BufferAttribute(new Array(positions.count * 3).fill(0), 3);
    }
    computeBoundingBox() {
      const position = this.attributes.position;
      if (!position) return;
      const axes = [
        Array.from({ length: position.count }, (_, index) => position.getX(index)),
        Array.from({ length: position.count }, (_, index) => position.getY(index)),
        Array.from({ length: position.count }, (_, index) => position.getZ(index)),
      ];
      this.boundingBox = {
        min: { x: Math.min(...axes[0]), y: Math.min(...axes[1]), z: Math.min(...axes[2]) },
        max: { x: Math.max(...axes[0]), y: Math.max(...axes[1]), z: Math.max(...axes[2]) },
      };
    }
    computeBoundingSphere() {}
  }
  class Material {
    constructor() { this.userData = {}; this.disposeCount = 0; }
    dispose() { this.disposeCount += 1; }
  }
  class DataTexture {
    constructor(...arguments_) {
      this.arguments = arguments_;
      this.userData = {};
      this.disposeCount = 0;
    }
    dispose() { this.disposeCount += 1; }
  }
  class Mesh extends Object3D {
    constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; }
  }
  class InstancedMesh extends Mesh {
    constructor(geometry, material, count) {
      super(geometry, material);
      this.count = count;
      this.isInstancedMesh = true;
      this.disposeCount = 0;
    }
    setMatrixAt(index, matrix) { (this.matrices ??= [])[index] = matrix; }
    dispose() { this.disposeCount += 1; }
  }
  class Matrix4 {
    constructor(values = ['identity']) { this.values = values; }
    clone() { return new Matrix4([...this.values]); }
    multiply(other) { this.values.push(...other.values); return this; }
    makeTranslation(...values) { this.values = ['translation', ...values]; return this; }
    makeScale(...values) { this.values = ['scale', ...values]; return this; }
  }
  class Light extends Object3D {
    constructor() {
      super();
      this.isLight = true;
      this.disposeCount = 0;
      this.shadow = {
        mapSize: { set() {} },
        camera: { updateProjectionMatrix() {} },
        bias: 0,
        normalBias: 0,
      };
    }
    dispose() { this.disposeCount += 1; }
  }
  class PerspectiveCamera extends Object3D { updateProjectionMatrix() {} }
  class OrthographicCamera extends PerspectiveCamera {}
  return {
    Group,
    Object3D,
    Matrix4,
    Color,
    Mesh,
    InstancedMesh,
    AmbientLight: Light,
    HemisphereLight: Light,
    RectAreaLight: Light,
    DirectionalLight: Light,
    PointLight: Light,
    SpotLight: Light,
    PerspectiveCamera,
    OrthographicCamera,
    BoxGeometry: DisposableGeometry,
    BufferGeometry,
    Float32BufferAttribute,
    DataTexture,
    MeshStandardNodeMaterial: Material,
    RGBAFormat: 'rgba-format',
    UnsignedByteType: 'unsigned-byte',
    ClampToEdgeWrapping: 'clamp-wrap',
    RepeatWrapping: 'repeat-wrap',
    MirroredRepeatWrapping: 'mirror-wrap',
    NearestFilter: 'nearest-filter',
    LinearFilter: 'linear-filter',
    NearestMipmapNearestFilter: 'nearest-mipmap-nearest-filter',
    NearestMipmapLinearFilter: 'nearest-mipmap-linear-filter',
    LinearMipmapNearestFilter: 'linear-mipmap-nearest-filter',
    LinearMipmapLinearFilter: 'linear-mipmap-linear-filter',
    SRGBColorSpace: 'srgb-space',
    LinearSRGBColorSpace: 'linear-space',
    NoColorSpace: 'no-color-space',
    FrontSide: 0,
    BackSide: 1,
    DoubleSide: 2,
  };
}

function fakeTsl() {
  return {
    vec2(...value) { return { isNode: true, kind: 'vec2', value }; },
    uv() { return { isNode: true, kind: 'uv' }; },
    texture(texture, coordinate) {
      return {
        rgb: { isNode: true, kind: 'texture-rgb', texture, coordinate },
        a: { isNode: true, kind: 'texture-alpha', texture, coordinate },
      };
    },
    color(value) {
      return {
        isNode: true,
        value,
        disposeCount: 0,
        dispose() { this.disposeCount += 1; },
      };
    },
    vec4(...value) {
      return {
        isNode: true,
        value,
        disposeCount: 0,
        dispose() { this.disposeCount += 1; },
      };
    },
  };
}

function entity(id, kind, options = {}) {
  return {
    id,
    kind,
    parentId: options.parentId ?? null,
    children: options.children ?? [],
    components: options.components ?? {},
  };
}

test('scene compilation follows canonical root and child order', () => {
  const project = createProjectDocument({
    projectId: 'project/order',
    scenes: [{
      id: 'scene/main',
      rootEntityIds: ['entity/root-b', 'entity/root-a'],
      entities: [
        entity('entity/root-a', 'group', { children: ['entity/a-2', 'entity/a-1'] }),
        entity('entity/a-1', 'empty', { parentId: 'entity/root-a' }),
        entity('entity/root-b', 'group'),
        entity('entity/a-2', 'empty', { parentId: 'entity/root-a' }),
      ],
    }],
  });
  const compiled = compileSceneDocument({ THREE: fakeThree(), TSL: fakeTsl(), project });

  assert.deepEqual(compiled.root.children.map(child => child.userData.studioEntityId), [
    'entity/root-b',
    'entity/root-a',
  ]);
  assert.deepEqual(compiled.objects.get('entity/root-a').children.map(child => child.userData.studioEntityId), [
    'entity/a-2',
    'entity/a-1',
  ]);
});

test('multi-material meshes require complete authored face groups while populated instancing remains explicit', () => {
  const project = createProjectDocument({
    projectId: 'project/unsupported',
    resources: {
      geometries: [
        { id: 'geometry/box', recipe: { kind: 'box' } },
        { id: 'geometry/grouped', recipe: {
          kind: 'indexedMesh',
          positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
          indices: [0, 1, 2, 0, 2, 3],
          triangleMaterialIndices: [0, 1],
        } },
      ],
      materials: [{ id: 'material/a' }, { id: 'material/b' }],
    },
    scenes: [{
      id: 'scene/main',
      rootEntityIds: ['entity/multi', 'entity/ungrouped', 'entity/instances'],
      entities: [
        entity('entity/multi', 'mesh', { components: { mesh: {
          geometryId: 'geometry/grouped',
          materialIds: ['material/a', 'material/b'],
        } } }),
        entity('entity/ungrouped', 'mesh', { components: { mesh: {
          geometryId: 'geometry/box',
          materialIds: ['material/a', 'material/b'],
        } } }),
        entity('entity/instances', 'instancedMesh', { components: { mesh: {
          geometryId: 'geometry/box',
          materialIds: ['material/a'],
          count: 2,
        } } }),
      ],
    }],
  });
  const compiled = compileSceneDocument({ THREE: fakeThree(), TSL: fakeTsl(), project });

  assert.deepEqual(compiled.diagnostics.map(item => item.code), [
    'runtime_material_groups_missing',
    'runtime_instancing_unsupported',
  ]);
  assert.equal(compiled.objects.has('entity/multi'), true);
  assert.equal(Array.isArray(compiled.objects.get('entity/multi').material), true);
  assert.equal(compiled.objects.get('entity/multi').material.length, 2);
  assert.equal(compiled.objects.has('entity/ungrouped'), false);
  assert.equal(compiled.objects.has('entity/instances'), false);
});

test('compiled lights, instances, geometry, and materials dispose exactly once', () => {
  const project = createProjectDocument({
    projectId: 'project/disposal',
    resources: {
      geometries: [{ id: 'geometry/box', recipe: { kind: 'box' } }],
      materials: [{ id: 'material/a' }],
    },
    scenes: [{
      id: 'scene/main',
      rootEntityIds: ['entity/light', 'entity/instance'],
      entities: [
        entity('entity/light', 'directionalLight'),
        entity('entity/instance', 'instancedMesh', { components: { mesh: {
          geometryId: 'geometry/box',
          materialIds: ['material/a'],
          count: 1,
        } } }),
      ],
    }],
  });
  const compiled = compileSceneDocument({ THREE: fakeThree(), TSL: fakeTsl(), project });
  const light = compiled.objects.get('entity/light');
  const instance = compiled.objects.get('entity/instance');
  const geometry = instance.geometry;
  const material = instance.material;

  compiled.dispose();
  compiled.dispose();

  assert.equal(light.disposeCount, 1);
  assert.equal(instance.disposeCount, 1);
  assert.equal(geometry.disposeCount, 1);
  assert.equal(material.disposeCount, 1);
});

test('scene compilation shares one texture across materials and disposes it exactly once', () => {
  const project = createProjectDocument({
    projectId: 'project/texture-cache',
    resources: {
      textures: [{
        id: 'texture/shared', kind: 'dataTexture', width: 1, height: 1, channels: 4,
        pixels: [12, 34, 56, 255], colorSpace: 'srgb',
      }],
      geometries: [{ id: 'geometry/uv-triangle', recipe: {
        kind: 'indexedMesh',
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 2],
        uvs: [0, 0, 1, 0, 0, 1],
      } }],
      materials: [
        { id: 'material/first', kind: 'standard', baseColorMapId: 'texture/shared' },
        { id: 'material/second', kind: 'standard', baseColorMapId: 'texture/shared' },
      ],
    },
    scenes: [{
      id: 'scene/main',
      entities: [
        entity('entity/first', 'mesh', { components: { mesh: {
          geometryId: 'geometry/uv-triangle', materialIds: ['material/first'],
        } } }),
        entity('entity/second', 'mesh', { components: { mesh: {
          geometryId: 'geometry/uv-triangle', materialIds: ['material/second'],
        } } }),
      ],
    }],
  });

  const compiled = compileSceneDocument({ THREE: fakeThree(), TSL: fakeTsl(), project });
  const first = compiled.objects.get('entity/first');
  const second = compiled.objects.get('entity/second');
  assert.equal(first.material.map, second.material.map);
  assert.deepEqual(Array.from(first.material.map.arguments[0]), [12, 34, 56, 255]);
  assert.equal(first.material.map.userData.studioResourceId, 'texture/shared');
  assert.deepEqual(compiled.diagnostics, []);

  const shared = first.material.map;
  compiled.dispose();
  compiled.dispose();
  assert.equal(first.material.disposeCount, 1);
  assert.equal(second.material.disposeCount, 1);
  assert.equal(shared.disposeCount, 1);
});

test('raster-mapped materials fail closed on geometry without an active UV attribute', () => {
  const project = createProjectDocument({
    projectId: 'project/texture-needs-uv',
    resources: {
      textures: [{
        id: 'texture/albedo', kind: 'dataTexture', width: 1, height: 1, channels: 4,
        pixels: [255, 255, 255, 255], colorSpace: 'srgb',
      }],
      geometries: [{ id: 'geometry/no-uv', recipe: {
        kind: 'indexedMesh', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2],
      } }],
      materials: [{ id: 'material/mapped', kind: 'standard', baseColorMapId: 'texture/albedo' }],
    },
    scenes: [{
      id: 'scene/main',
      entities: [entity('entity/no-uv', 'mesh', { components: { mesh: {
        geometryId: 'geometry/no-uv', materialIds: ['material/mapped'],
      } } })],
    }],
  });

  const compiled = compileSceneDocument({ THREE: fakeThree(), TSL: fakeTsl(), project });
  assert.equal(compiled.objects.has('entity/no-uv'), false);
  assert.deepEqual(compiled.diagnostics.map(entry => entry.code), ['runtime_texture_uv_missing']);
  compiled.dispose();
});

test('no-UV geometry accepts constant-coordinate graph sampling but rejects input.uv sampling', () => {
  const textureGraph = (id, coordinateNode) => ({
    id,
    kind: 'graph',
    graph: {
      formatVersion: 1,
      id,
      domain: 'shader',
      nodes: [
        coordinateNode,
        { id: 'sample', type: 'texture.sample2d', params: { textureId: 'texture/albedo', colorSpace: 'srgb' } },
      ],
      edges: [{
        from: {
          nodeId: coordinateNode.id,
          port: coordinateNode.type === 'input.uv' ? 'uv' : 'value',
        },
        to: { nodeId: 'sample', port: 'uv' },
      }],
      outputs: { baseColor: { nodeId: 'sample', port: 'color' } },
    },
  });
  const project = createProjectDocument({
    projectId: 'project/graph-texture-uv-provenance',
    resources: {
      textures: [{
        id: 'texture/albedo', kind: 'dataTexture', width: 1, height: 1, channels: 4,
        pixels: [180, 120, 60, 255], colorSpace: 'srgb',
      }],
      geometries: [{ id: 'geometry/no-uv', recipe: {
        kind: 'indexedMesh', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2],
      } }],
      graphs: [
        textureGraph('graph/constant-coordinate', {
          id: 'coordinate', type: 'constant.vec2', params: { value: [0.5, 0.5] },
        }),
        textureGraph('graph/geometry-uv', { id: 'coordinate', type: 'input.uv', params: {} }),
      ],
      materials: [
        { id: 'material/constant-coordinate', kind: 'standard', graphId: 'graph/constant-coordinate' },
        { id: 'material/geometry-uv', kind: 'standard', graphId: 'graph/geometry-uv' },
      ],
    },
    scenes: [{
      id: 'scene/main',
      entities: [
        entity('entity/constant-coordinate', 'mesh', { components: { mesh: {
          geometryId: 'geometry/no-uv', materialIds: ['material/constant-coordinate'],
        } } }),
        entity('entity/geometry-uv', 'mesh', { components: { mesh: {
          geometryId: 'geometry/no-uv', materialIds: ['material/geometry-uv'],
        } } }),
      ],
    }],
  });

  const compiled = compileSceneDocument({ THREE: fakeThree(), TSL: fakeTsl(), project });
  assert.equal(compiled.objects.has('entity/constant-coordinate'), true);
  assert.equal(compiled.objects.has('entity/geometry-uv'), false);
  assert.equal(
    compiled.objects.get('entity/constant-coordinate').material.userData.studioRequiresGeometryUv,
    false,
  );
  assert.deepEqual(compiled.diagnostics.map(entry => entry.code), ['runtime_texture_uv_missing']);
  compiled.dispose();
});

test('legacy texture placeholders stay valid until a live material tries to bind them', () => {
  const placeholder = {
    id: 'texture/legacy', kind: 'texture',
    recipe: { kind: 'image', assetId: 'asset/legacy' },
  };
  const unused = createProjectDocument({
    projectId: 'project/unused-legacy-texture',
    resources: { textures: [placeholder] },
  });
  assert.equal(validateProjectDocument(unused).valid, true);

  const project = createProjectDocument({
    projectId: 'project/bound-legacy-texture',
    resources: {
      textures: [placeholder],
      geometries: [{ id: 'geometry/uv-triangle', recipe: {
        kind: 'indexedMesh',
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 2],
        uvs: [0, 0, 1, 0, 0, 1],
      } }],
      materials: [{ id: 'material/legacy', kind: 'standard', baseColorMapId: 'texture/legacy' }],
    },
    scenes: [{
      id: 'scene/main',
      entities: [entity('entity/legacy', 'mesh', { components: { mesh: {
        geometryId: 'geometry/uv-triangle', materialIds: ['material/legacy'],
      } } })],
    }],
  });
  assert.equal(validateProjectDocument(project).valid, true);
  const compiled = compileSceneDocument({ THREE: fakeThree(), TSL: fakeTsl(), project });
  assert.equal(compiled.objects.has('entity/legacy'), false);
  assert.deepEqual(compiled.diagnostics.map(entry => entry.code), ['texture_not_live_raster']);
  compiled.dispose();
});

test('ordered array and mirror modifiers lower to deterministic instance matrices', () => {
  const project = createProjectDocument({
    projectId: 'project/modifiers',
    resources: {
      geometries: [{ id: 'geometry/box', recipe: { kind: 'box' } }],
      materials: [{ id: 'material/a' }],
    },
    scenes: [{
      id: 'scene/main',
      entities: [entity('entity/subject', 'mesh', { components: {
        mesh: { geometryId: 'geometry/box', materialIds: ['material/a'] },
        modifiers: [
          { id: 'modifier/array', type: 'array', count: 3, offset: [2, 0, 0] },
          { id: 'modifier/mirror', type: 'mirror', axis: 'x' },
        ],
      } })],
    }],
  });

  const compiled = compileSceneDocument({ THREE: fakeThree(), TSL: fakeTsl(), project });
  const subject = compiled.objects.get('entity/subject');
  assert.equal(subject.isInstancedMesh, true);
  assert.equal(subject.count, 6);
  assert.equal(subject.matrices.length, 6);
  assert.deepEqual(compiled.diagnostics, []);
});

test('derived geometry is cached by resource, exact stack hash, and viewport target', () => {
  const sourcePositions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const project = createProjectDocument({
    projectId: 'project/derived-geometry-cache',
    resources: {
      geometries: [{ id: 'geometry/triangle', recipe: {
        kind: 'indexedMesh',
        positions: sourcePositions,
        indices: [0, 1, 2],
      } }],
      materials: [{ id: 'material/a' }],
    },
    scenes: [{
      id: 'scene/main',
      entities: [
        entity('entity/first', 'mesh', { components: {
          mesh: { geometryId: 'geometry/triangle', materialIds: ['material/a'] },
          modifiers: [{ id: 'modifier/subdivide', type: 'subdivision', levels: 1, scheme: 'simple' }],
        } }),
        entity('entity/second', 'mesh', { components: {
          mesh: { geometryId: 'geometry/triangle', materialIds: ['material/a'] },
          modifiers: [{ id: 'modifier/subdivide', type: 'subdivision', levels: 1, scheme: 'simple' }],
        } }),
        entity('entity/third', 'mesh', { components: {
          mesh: { geometryId: 'geometry/triangle', materialIds: ['material/a'] },
          modifiers: [{ id: 'modifier/subdivide', type: 'subdivision', levels: 2, scheme: 'simple' }],
        } }),
      ],
    }],
  });

  const compiled = compileSceneDocument({ THREE: fakeThree(), TSL: fakeTsl(), project });
  const first = compiled.objects.get('entity/first');
  const second = compiled.objects.get('entity/second');
  const third = compiled.objects.get('entity/third');
  assert.equal(first.geometry, second.geometry);
  assert.notEqual(first.geometry, third.geometry);
  assert.equal(first.geometry.getAttribute('position').count, 6);
  assert.equal(first.geometry.getIndex().count, 12);
  assert.equal(third.geometry.getIndex().count, 48);
  assert.equal(first.geometry.userData.studioGeometryTarget, 'viewport');
  assert.deepEqual(first.geometry.userData.studioAppliedGeometryModifiers, ['modifier/subdivide']);
  assert.deepEqual(project.resources.geometries['geometry/triangle'].recipe.positions, sourcePositions);
  assert.deepEqual(compiled.diagnostics, []);

  compiled.dispose();
  assert.equal(first.geometry.disposeCount, 1);
  assert.equal(third.geometry.disposeCount, 1);
});

test('bake and order boundaries show only the exact evaluable modifier prefix', () => {
  const project = createProjectDocument({
    projectId: 'project/modifier-boundaries',
    resources: {
      geometries: [{ id: 'geometry/triangle', recipe: {
        kind: 'indexedMesh', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2],
      } }],
      materials: [{ id: 'material/a' }],
    },
    scenes: [{
      id: 'scene/main',
      entities: [
        entity('entity/unsupported', 'mesh', { components: {
          mesh: { geometryId: 'geometry/triangle', materialIds: ['material/a'] },
          modifiers: [
            { id: 'modifier/smooth', type: 'smooth', factor: 0.25 },
            {
              id: 'modifier/bevel',
              type: 'bakeBoundary',
              operatorType: 'BEVEL',
              parameters: { width: 0.1 },
            },
            { id: 'modifier/displace', type: 'displace', strength: 2 },
          ],
        } }),
        entity('entity/order', 'mesh', { components: {
          mesh: { geometryId: 'geometry/triangle', materialIds: ['material/a'] },
          modifiers: [
            { id: 'modifier/array', type: 'array', count: 2, offset: [1, 0, 0] },
            { id: 'modifier/subdivision', type: 'subdivision', levels: 1 },
          ],
        } }),
      ],
    }],
  });

  const compiled = compileSceneDocument({ THREE: fakeThree(), TSL: fakeTsl(), project });
  assert.equal(compiled.objects.has('entity/unsupported'), true);
  assert.equal(compiled.objects.has('entity/order'), true);
  assert.deepEqual(
    compiled.objects.get('entity/unsupported').geometry.userData.studioAppliedGeometryModifiers,
    ['modifier/smooth'],
  );
  assert.equal(compiled.objects.get('entity/order').isInstancedMesh, true);
  assert.equal(compiled.objects.get('entity/order').count, 2);
  assert.deepEqual(compiled.diagnostics.map(item => item.code), [
    'runtime_modifier_bake_required',
    'runtime_modifier_order_unsupported',
  ]);
  assert.equal(compiled.diagnostics.every(item => item.severity === 'warning'), true);
});

test('indexed triangle material slots compile into real geometry groups', () => {
  const project = createProjectDocument({
    projectId: 'project/material-groups',
    resources: {
      geometries: [{ id: 'geometry/quad', recipe: {
        kind: 'indexedMesh',
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
        indices: [0, 1, 2, 0, 2, 3],
        triangleMaterialIndices: [0, 1],
      } }],
      materials: [{ id: 'material/a' }, { id: 'material/b' }],
    },
    scenes: [{
      id: 'scene/main',
      entities: [entity('entity/quad', 'mesh', { components: { mesh: {
        geometryId: 'geometry/quad', materialIds: ['material/a', 'material/b'],
      } } })],
    }],
  });

  const compiled = compileSceneDocument({ THREE: fakeThree(), TSL: fakeTsl(), project });
  const subject = compiled.objects.get('entity/quad');
  assert.deepEqual(subject.geometry.groups, [
    { start: 0, count: 3, materialIndex: 0 },
    { start: 3, count: 3, materialIndex: 1 },
  ]);
  assert.equal(subject.material.length, 2);
  assert.deepEqual(compiled.diagnostics, []);
});

test('direct format-v1 indexed mesh resources still compile through the generic geometry envelope', () => {
  const project = createProjectDocument({
    projectId: 'project/direct-indexed-compatibility',
    resources: {
      geometries: [{
        id: 'geometry/direct',
        type: 'indexedMesh',
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 2],
      }],
      materials: [{ id: 'material/only' }],
    },
    scenes: [{
      id: 'scene/main',
      entities: [entity('entity/direct', 'mesh', { components: { mesh: {
        geometryId: 'geometry/direct', materialIds: ['material/only'],
      } } })],
    }],
  });
  const compiled = compileSceneDocument({ THREE: fakeThree(), TSL: fakeTsl(), project });
  assert.equal(compiled.objects.has('entity/direct'), true);
  assert.equal(compiled.objects.get('entity/direct').geometry.getIndex().count, 3);
  assert.deepEqual(compiled.diagnostics, []);
});

test('intrinsic procedural groups remain scalar-compatible before and after live geometry modifiers', () => {
  const THREE = fakeThree();
  THREE.BoxGeometry = class {
    constructor() {
      this.userData = {};
      this.disposeCount = 0;
      this.attributes = {
        position: new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
      };
      this.index = { array: [0, 1, 2], count: 3, getX: index => [0, 1, 2][index] };
      this.groups = Array.from({ length: 6 }, (_, materialIndex) => ({
        start: 0, count: 3, materialIndex,
      }));
    }
    getAttribute(name) { return this.attributes[name]; }
    setAttribute(name, value) { this.attributes[name] = value; return this; }
    getIndex() { return this.index; }
    computeVertexNormals() {
      this.attributes.normal = new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3);
    }
    computeBoundingBox() {}
    computeBoundingSphere() {}
    dispose() { this.disposeCount += 1; }
  };
  const project = createProjectDocument({
    projectId: 'project/intrinsic-groups',
    resources: {
      geometries: [{ id: 'geometry/box', recipe: { kind: 'box' } }],
      materials: [{ id: 'material/only' }],
    },
    scenes: [{
      id: 'scene/main',
      entities: [
        entity('entity/plain', 'mesh', { components: { mesh: {
          geometryId: 'geometry/box', materialIds: ['material/only'],
        } } }),
        entity('entity/modified', 'mesh', { components: {
          mesh: { geometryId: 'geometry/box', materialIds: ['material/only'] },
          modifiers: [{ id: 'modifier/smooth', type: 'smooth', factor: 0.25 }],
        } }),
      ],
    }],
  });
  const compiled = compileSceneDocument({ THREE, TSL: fakeTsl(), project });
  assert.equal(compiled.objects.has('entity/plain'), true);
  assert.equal(compiled.objects.has('entity/modified'), true);
  assert.equal(compiled.objects.get('entity/plain').material, compiled.objects.get('entity/modified').material);
  assert.deepEqual(compiled.diagnostics, []);
});

test('complete procedural material groups preserve exact slots through live topology evaluation', () => {
  const THREE = fakeThree();
  THREE.BoxGeometry = class {
    constructor() {
      this.userData = {};
      this.disposeCount = 0;
      this.attributes = {
        position: new THREE.Float32BufferAttribute([
          0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
        ], 3),
      };
      const values = [0, 1, 2, 0, 2, 3];
      this.index = { array: values, count: values.length, getX: index => values[index] };
      this.groups = [
        { start: 0, count: 3, materialIndex: 0 },
        { start: 3, count: 3, materialIndex: 1 },
      ];
    }
    getAttribute(name) { return this.attributes[name]; }
    setAttribute(name, value) { this.attributes[name] = value; return this; }
    getIndex() { return this.index; }
    computeVertexNormals() {
      this.attributes.normal = new THREE.Float32BufferAttribute(new Array(12).fill(0), 3);
    }
    computeBoundingBox() {}
    computeBoundingSphere() {}
    dispose() { this.disposeCount += 1; }
  };
  const project = createProjectDocument({
    projectId: 'project/procedural-group-provenance',
    resources: {
      geometries: [{ id: 'geometry/box', recipe: { kind: 'box' } }],
      materials: [{ id: 'material/a' }, { id: 'material/b' }],
    },
    scenes: [{
      id: 'scene/main',
      entities: [entity('entity/modified', 'mesh', { components: {
        mesh: { geometryId: 'geometry/box', materialIds: ['material/a', 'material/b'] },
        modifiers: [{ id: 'modifier/smooth', type: 'smooth', factor: 0.25 }],
      } })],
    }],
  });
  const compiled = compileSceneDocument({ THREE, TSL: fakeTsl(), project });
  const geometry = compiled.objects.get('entity/modified').geometry;
  assert.deepEqual(geometry.userData.studioTriangleMaterialIndices, [0, 1]);
  assert.deepEqual(geometry.groups, [
    { start: 0, count: 3, materialIndex: 0 },
    { start: 3, count: 3, materialIndex: 1 },
  ]);
  assert.deepEqual(compiled.diagnostics, []);
});

test('face material slots fail closed when scalar or fallback materials cannot address them', () => {
  const project = createProjectDocument({
    projectId: 'project/material-slot-coverage',
    resources: {
      geometries: [{ id: 'geometry/slot-one', recipe: {
        kind: 'indexedMesh',
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 2],
        triangleMaterialIndices: [1],
      } }],
      materials: [{ id: 'material/only' }],
    },
    scenes: [{
      id: 'scene/main',
      entities: [
        entity('entity/scalar', 'mesh', { components: { mesh: {
          geometryId: 'geometry/slot-one', materialIds: ['material/only'],
        } } }),
        entity('entity/fallback', 'mesh', { components: { mesh: {
          geometryId: 'geometry/slot-one', materialIds: [],
        } } }),
      ],
    }],
  });

  const compiled = compileSceneDocument({ THREE: fakeThree(), TSL: fakeTsl(), project });
  assert.equal(compiled.objects.has('entity/scalar'), false);
  assert.equal(compiled.objects.has('entity/fallback'), false);
  assert.deepEqual(compiled.diagnostics.map(item => item.code), [
    'runtime_material_slot_missing',
    'runtime_material_slot_missing',
  ]);
});

test('a mesh with a live layout pattern compiles directly to InstancedMesh', () => {
  const project = createProjectDocument({
    projectId: 'project/layout-pattern',
    resources: {
      geometries: [{ id: 'geometry/box', recipe: { kind: 'box' } }],
      materials: [{ id: 'material/a' }],
    },
    scenes: [{
      id: 'scene/main',
      entities: [entity('entity/subject', 'mesh', { components: {
        mesh: { geometryId: 'geometry/box', materialId: 'material/a' },
        modifiers: [{
          id: 'modifier/grid', type: 'pattern', mode: 'grid',
          counts: [2, 3, 1], spacing: [2, 4, 6],
        }],
      } })],
    }],
  });

  const compiled = compileSceneDocument({ THREE: fakeThree(), TSL: fakeTsl(), project });
  const subject = compiled.objects.get('entity/subject');
  assert.equal(subject.isInstancedMesh, true);
  assert.equal(subject.count, 6);
  assert.deepEqual(subject.matrices.map(matrix => matrix.values), [
    ['identity', 'translation', 0, 0, 0],
    ['identity', 'translation', 2, 0, 0],
    ['identity', 'translation', 0, 4, 0],
    ['identity', 'translation', 2, 4, 0],
    ['identity', 'translation', 0, 8, 0],
    ['identity', 'translation', 2, 8, 0],
  ]);
  assert.deepEqual(compiled.diagnostics, []);
});

test('look-at and copy-location constraints evaluate in authored order', () => {
  const project = createProjectDocument({
    projectId: 'project/constraints',
    scenes: [{
      id: 'scene/main',
      entities: [
        entity('entity/target', 'empty', { components: {}, }),
        entity('entity/camera', 'perspectiveCamera', { components: {
          constraints: [{ id: 'constraint/aim', type: 'lookAt', targetId: 'entity/target' }],
        } }),
        entity('entity/follower', 'empty', { components: {
          constraints: [{ id: 'constraint/copy', type: 'copyLocation', targetId: 'entity/target' }],
        } }),
      ],
    }],
  });
  project.scenes['scene/main'].entities['entity/target'].transform.position = [4, 3, 2];

  const compiled = compileSceneDocument({ THREE: fakeThree(), TSL: fakeTsl(), project });
  assert.deepEqual(compiled.objects.get('entity/camera').lookAtValues, [4, 3, 2]);
  assert.deepEqual(compiled.objects.get('entity/follower').position.values, [4, 3, 2]);
  assert.deepEqual(compiled.diagnostics, []);
});

test('compiled Blender-style Actions scrub exact frames and remain derived state', () => {
  const project = createProjectDocument({
    projectId: 'project/animation',
    resources: {
      animations: [{
        id: 'animation/bounce',
        kind: 'animation',
        frameStart: 0,
        frameEnd: 48,
        fps: 24,
        loop: 'repeat',
        autoplay: true,
        tracks: [{
          targetId: 'entity/ball',
          property: 'transform.position',
          interpolation: 'linear',
          keyframes: [
            { frame: 0, value: [0, 0.5, 0] },
            { frame: 12, value: [0, 2.5, 0] },
            { frame: 24, value: [0, 0.5, 0] },
            { frame: 36, value: [0, 2.5, 0] },
            { frame: 48, value: [0, 0.5, 0] },
          ],
        }],
      }],
    },
    scenes: [{
      id: 'scene/main',
      entities: [entity('entity/ball', 'empty')],
      settings: { timeline: { frameStart: 1, frameEnd: 48, currentFrame: 1, framesPerSecond: 24 } },
    }],
  });

  const compiled = compileSceneDocument({ THREE: fakeThree(), TSL: fakeTsl(), project });
  assert.deepEqual(compiled.animationActions, ['animation/bounce']);
  assert.deepEqual(compiled.objects.get('entity/ball').position.values, [0, 0.5, 0]);
  compiled.setAnimationTime(0.5);
  assert.deepEqual(compiled.objects.get('entity/ball').position.values, [0, 2.5, 0]);
  assert.deepEqual(project.scenes['scene/main'].entities['entity/ball'].transform.position, [0, 0, 0]);
  assert.deepEqual(compiled.diagnostics, []);
});

test('timeline-driven Ocean geometry scrubs without Actions and is explicitly excluded from static RTX', () => {
  const project = createProjectDocument({
    projectId: 'project/ocean-timeline',
    resources: {
      geometries: [{
        id: 'geometry/ocean-grid',
        recipe: {
          kind: 'indexedMesh',
          positions: [-2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0],
          indices: [0, 1, 2, 0, 2, 3],
          uvs: [0, 0, 1, 0, 1, 1, 0, 1],
        },
      }],
    },
    scenes: [{
      id: 'scene/main',
      settings: { timeline: { frameStart: 1, frameEnd: 48, currentFrame: 1, framesPerSecond: 24 } },
      entities: [entity('entity/ocean', 'mesh', { components: {
        mesh: { geometryId: 'geometry/ocean-grid' },
        modifiers: [
          { id: 'modifier/ocean-prefix-subdivision', type: 'subdivision', scheme: 'simple', levels: 1 },
          {
            id: 'modifier/ocean', type: 'ocean', mode: 'displace', seed: 9,
            spatialSize: 20, waveScaleMin: 0.2, waveScale: 0.7,
            windVelocity: 25, choppiness: 1.2, waveCount: 12,
          },
        ],
      } })],
    }],
  });

  const compiled = compileSceneDocument({ THREE: fakeThree(), TSL: fakeTsl(), project });
  const geometry = compiled.objects.get('entity/ocean').geometry;
  const atStart = [...geometry.getAttribute('position').array];
  assert.equal(compiled.animationRuntime.actions.size, 0);
  assert.deepEqual(compiled.timelineGeometryModifierIds, ['modifier/ocean']);
  assert.equal(compiled.timelineGeometrySampleCount, (atStart.length / 3) * 12);
  assert.equal(compiled.maxTimelineGeometrySamples, 131_072);
  assert.deepEqual(geometry.userData.studioAppliedGeometryModifiers, [
    'modifier/ocean-prefix-subdivision',
    'modifier/ocean',
  ]);
  assert.equal(geometry.userData.rtxIgnore, true);
  const rtxDiagnostic = compiled.diagnostics.find(
    item => item.code === 'runtime_dynamic_geometry_rtx_excluded',
  );
  assert.equal(rtxDiagnostic?.id, 'entity/ocean');
  assert.deepEqual(rtxDiagnostic?.modifierIds, ['modifier/ocean']);

  assert.deepEqual(compiled.setAnimationTime(1), []);
  const atOneSecond = [...geometry.getAttribute('position').array];
  assert.notDeepEqual(atOneSecond, atStart);
  compiled.setAnimationTime(0);
  assert.deepEqual([...geometry.getAttribute('position').array], atStart);
});

test('timeline-driven Ocean geometry enforces one accumulated scene update budget', () => {
  const vertexCount = 2_050;
  const project = createProjectDocument({
    projectId: 'project/ocean-scene-budget',
    resources: { geometries: [{
      id: 'geometry/ocean-grid',
      recipe: {
        kind: 'indexedMesh',
        positions: new Array(vertexCount * 3).fill(0),
        indices: [0, 1, 2],
      },
    }] },
    scenes: [{
      id: 'scene/main',
      entities: [
        entity('entity/ocean-a', 'mesh', { components: {
          mesh: { geometryId: 'geometry/ocean-grid' },
          modifiers: [{
            id: 'modifier/ocean-a', type: 'ocean', mode: 'displace', waveCount: 32,
          }],
        } }),
        entity('entity/ocean-b', 'mesh', { components: {
          mesh: { geometryId: 'geometry/ocean-grid' },
          modifiers: [{
            id: 'modifier/ocean-b', type: 'ocean', mode: 'displace', waveCount: 32,
          }],
        } }),
      ],
    }],
  });

  const compiled = compileSceneDocument({ THREE: fakeThree(), TSL: fakeTsl(), project });
  assert.equal(compiled.timelineGeometrySampleCount, vertexCount * 32);
  assert.equal(compiled.objects.has('entity/ocean-a'), true);
  assert.equal(compiled.objects.has('entity/ocean-b'), false);
  assert.equal(
    compiled.diagnostics.some(item => (
      item.severity === 'error'
      && item.code === 'runtime_timeline_geometry_budget_exceeded'
      && item.id === 'entity/ocean-b'
    )),
    true,
  );
});

test('static Ocean displacement remains eligible for static RTX registration', () => {
  const project = createProjectDocument({
    projectId: 'project/ocean-static',
    resources: { geometries: [{
      id: 'geometry/ocean-grid',
      recipe: {
        kind: 'indexedMesh',
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 2],
      },
    }] },
    scenes: [{
      id: 'scene/main',
      entities: [entity('entity/ocean', 'mesh', { components: {
        mesh: { geometryId: 'geometry/ocean-grid' },
        modifiers: [{
          id: 'modifier/ocean', type: 'ocean', mode: 'displace', timelineScale: 0,
        }],
      } })],
    }],
  });
  const compiled = compileSceneDocument({ THREE: fakeThree(), TSL: fakeTsl(), project });
  assert.deepEqual(compiled.timelineGeometryModifierIds, []);
  assert.equal(compiled.objects.get('entity/ocean').geometry.userData.rtxIgnore, undefined);
  assert.equal(
    compiled.diagnostics.some(item => item.code === 'runtime_dynamic_geometry_rtx_excluded'),
    false,
  );
});

test('authored linear color backgrounds become an opaque WebGPU background node', () => {
  const THREE = fakeThree();
  const TSL = fakeTsl();
  const project = createProjectDocument({
    projectId: 'project/background-node',
    scenes: [{
      id: 'scene/main',
      settings: {
        background: {
          mode: 'color',
          color: [0.035, 0.045, 0.06],
          colorSpace: 'linear-srgb',
        },
      },
    }],
  });

  const compiled = compileSceneDocument({ THREE, TSL, project });

  assert.equal(compiled.backgroundNode.isNode, true);
  assert.deepEqual(compiled.backgroundNode.value, [0.035, 0.045, 0.06, 1]);
  assert.deepEqual(compiled.background.values, [0.035, 0.045, 0.06]);
  compiled.dispose();
  compiled.dispose();
});
