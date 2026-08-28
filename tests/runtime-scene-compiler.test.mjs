import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectDocument } from '../src/core/index.mjs';
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
  class Material {
    constructor() { this.userData = {}; this.disposeCount = 0; }
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
    MeshStandardNodeMaterial: Material,
    FrontSide: 0,
    BackSide: 1,
    DoubleSide: 2,
  };
}

function fakeTsl() {
  return {
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

test('unsupported multi-material and populated instancing produce explicit diagnostics', () => {
  const project = createProjectDocument({
    projectId: 'project/unsupported',
    resources: {
      geometries: [{ id: 'geometry/box', recipe: { kind: 'box' } }],
      materials: [{ id: 'material/a' }, { id: 'material/b' }],
    },
    scenes: [{
      id: 'scene/main',
      rootEntityIds: ['entity/multi', 'entity/instances'],
      entities: [
        entity('entity/multi', 'mesh', { components: { mesh: {
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
    'runtime_multi_material_unsupported',
    'runtime_instancing_unsupported',
  ]);
  assert.equal(compiled.objects.has('entity/multi'), false);
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
