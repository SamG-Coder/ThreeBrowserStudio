import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VIEWPORT_LAYER_ALL,
  VIEWPORT_LAYER_PREVIEW,
  VIEWPORT_LAYER_SCENE,
  createViewportLayers,
} from '../src/viewport/viewport-layers.mjs';

class FakeObject {
  constructor() {
    this.visible = true;
    this.parent = null;
    this.position = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
    this.userData = {};
  }

  removeFromParent() {
    this.parent?.remove(this);
  }

  traverse(callback) { callback(this); }
}

class FakeGrid extends FakeObject {
  constructor(size, divisions, major, minor) {
    super();
    this.size = size;
    this.divisions = divisions;
    this.major = major;
    this.minor = minor;
    this.material = { disposed: false, dispose() { this.disposed = true; } };
    this.geometry = { disposed: false, dispose() { this.disposed = true; } };
  }
}

class FakeGroup extends FakeObject {
  constructor() { super(); this.children = []; }
  add(...objects) {
    for (const object of objects) {
      object.removeFromParent?.();
      this.children.push(object);
      object.parent = this;
    }
  }
  remove(object) {
    this.children = this.children.filter(child => child !== object);
    if (object.parent === this) object.parent = null;
  }
  traverse(callback) {
    callback(this);
    for (const child of this.children) child.traverse(callback);
  }
}

class FakeLight extends FakeObject {
  constructor() { super(); this.isLight = true; }
}

class FakeScene {
  constructor() { this.children = []; }
  add(object) {
    object.removeFromParent?.();
    this.children.push(object);
    object.parent = this;
  }
  remove(object) {
    this.children = this.children.filter(child => child !== object);
    if (object.parent === this) object.parent = null;
  }
}

function compiled(name) {
  const root = new FakeObject();
  root.name = name;
  return { root, background: name, activeCamera: { name: `${name}-camera` } };
}

function compiledWithLight(name) {
  const value = compiled(name);
  const root = new FakeGroup();
  root.name = name;
  root.add(new FakeLight());
  return { ...value, root };
}

test('viewport layers keep the grid transient and make dry-run previews visible', () => {
  const scene = new FakeScene();
  const states = [];
  const presentations = [];
  const layers = createViewportLayers({
    THREE: { GridHelper: FakeGrid, Group: FakeGroup, HemisphereLight: FakeLight, DirectionalLight: FakeLight },
    scene,
    onStateChange(state) { states.push(state); },
    onPresentationChange(value) { presentations.push(value); },
  });
  const committed = compiled('committed');
  const preview = compiled('preview');

  layers.setCommitted(committed);
  assert.equal(layers.grid.userData.studioHelper, true);
  assert.equal(layers.grid.userData.studioLayer, 'grid');
  assert.equal(layers.studioLighting.userData.studioLayer, 'lighting');
  assert.equal(layers.studioLighting.visible, true);
  assert.equal(committed.root.visible, true);
  assert.equal(layers.getState().mode, VIEWPORT_LAYER_SCENE);

  layers.setPreview(preview, { label: 'Shape the roof', revision: 4 });
  assert.equal(layers.getState().mode, VIEWPORT_LAYER_PREVIEW);
  assert.equal(layers.getState().previewActive, true);
  assert.equal(committed.root.visible, false);
  assert.equal(preview.root.visible, true);
  assert.equal(presentations.at(-1), preview);

  layers.setMode(VIEWPORT_LAYER_ALL);
  assert.equal(committed.root.visible, true);
  assert.equal(preview.root.visible, true);
  layers.setGridVisible(false);
  assert.equal(layers.grid.visible, false);
  layers.setStudioLightVisible(false);
  assert.equal(layers.studioLighting.visible, false);

  layers.clearPreview();
  assert.equal(preview.root.parent, null);
  assert.equal(committed.root.visible, true);
  assert.equal(layers.getState().mode, VIEWPORT_LAYER_SCENE);
  assert.equal(states.at(-1).previewActive, false);

  const grid = layers.grid;
  layers.dispose();
  assert.equal(grid.geometry.disposed, true);
  assert.equal(grid.material.disposed, true);
  assert.equal(scene.children.length, 0);
});

test('preview and all modes fail closed to the committed scene without a candidate', () => {
  const layers = createViewportLayers({
    THREE: { GridHelper: FakeGrid, Group: FakeGroup, HemisphereLight: FakeLight, DirectionalLight: FakeLight },
    scene: new FakeScene(),
  });
  layers.setMode(VIEWPORT_LAYER_PREVIEW);
  assert.equal(layers.getState().mode, VIEWPORT_LAYER_SCENE);
  layers.setMode(VIEWPORT_LAYER_ALL);
  assert.equal(layers.getState().mode, VIEWPORT_LAYER_SCENE);
  assert.throws(() => layers.setMode('hidden'), /Unknown viewport layer mode/u);
  layers.dispose();
});

test('workbench lighting yields to authored lights in every visible layer', () => {
  const layers = createViewportLayers({
    THREE: { GridHelper: FakeGrid, Group: FakeGroup, HemisphereLight: FakeLight, DirectionalLight: FakeLight },
    scene: new FakeScene(),
  });
  layers.setCommitted(compiledWithLight('lit committed'));
  assert.equal(layers.studioLighting.visible, false);
  layers.setPreview(compiled('unlit preview'));
  assert.equal(layers.studioLighting.visible, true);
  layers.setMode(VIEWPORT_LAYER_ALL);
  assert.equal(layers.studioLighting.visible, false);
  layers.dispose();
});
