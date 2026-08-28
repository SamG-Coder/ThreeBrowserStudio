import assert from 'node:assert/strict';
import test from 'node:test';

import { createStudioCommandTelemetry } from '../src/runtime/mcp-live-feed-telemetry.mjs';
import { createMcpLiveFeedWebGpuHud } from '../src/viewport/mcp-live-feed-webgpu-hud.mjs';

class FakeVector {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.z = 0;
  }

  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  applyMatrix4() { return this; }
}

class FakeCanvasContext {
  constructor() {
    this.draws = 0;
    this.text = [];
    this.fillStyle = '';
    this.font = '';
    this.textBaseline = '';
    this.textAlign = 'left';
    this.transforms = [];
  }

  setTransform(...values) {
    this.transforms.push(values);
  }

  clearRect() {
    this.draws += 1;
    this.text = [];
  }

  fillRect() {}

  fillText(value) {
    this.text.push(String(value));
  }
}

class FakeCanvas {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.context = new FakeCanvasContext();
  }

  getContext(kind) {
    return kind === '2d' ? this.context : null;
  }
}

class FakeDocument {
  constructor() {
    this.canvases = [];
  }

  createElement(name) {
    if (name !== 'canvas') throw new Error(`unexpected element ${name}`);
    const canvas = new FakeCanvas();
    this.canvases.push(canvas);
    return canvas;
  }
}

class FakeCanvasTexture {
  constructor(image) {
    this.image = image;
    this.updateCount = 0;
    this.disposed = false;
  }

  set needsUpdate(value) {
    if (value) this.updateCount += 1;
  }

  dispose() {
    this.disposed = true;
  }
}

class FakeSpriteMaterial {
  constructor(values) {
    Object.assign(this, values);
    this.disposed = false;
  }

  dispose() {
    this.disposed = true;
  }
}

class FakeSprite {
  constructor(material) {
    this.material = material;
    this.position = new FakeVector();
    this.scale = new FakeVector();
    this.center = new FakeVector();
    this.visible = true;
  }
}

class FakeScene {
  constructor() {
    this.children = [];
  }

  add(value) {
    this.children.push(value);
  }

  remove(value) {
    this.children = this.children.filter(child => child !== value);
  }
}

const THREE = Object.freeze({
  CanvasTexture: FakeCanvasTexture,
  SpriteMaterial: FakeSpriteMaterial,
  Sprite: FakeSprite,
  Vector3: FakeVector,
  SRGBColorSpace: 'srgb',
  LinearFilter: 'linear',
});

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function fakeTimers() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    setIntervalFn(callback, milliseconds) {
      const id = nextId++;
      callbacks.set(id, { callback, milliseconds });
      return id;
    },
    clearIntervalFn(id) {
      callbacks.delete(id);
    },
    tick() {
      for (const { callback } of [...callbacks.values()]) callback();
    },
    get active() { return callbacks.size; },
  };
}

function keyEvent(overrides = {}) {
  return {
    key: 'm', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false,
    repeat: false, prevented: false,
    preventDefault() { this.prevented = true; },
    ...overrides,
  };
}

function wheelEvent(x, y, deltaY) {
  return {
    clientX: x,
    clientY: y,
    deltaY,
    deltaMode: 0,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
}

function fixture({ now = () => 0, width = 1000, height = 700, pixelRatio = 2, maxVisibleRows = 10 } = {}) {
  const document = new FakeDocument();
  const eventTarget = new FakeEventTarget();
  const timers = fakeTimers();
  const telemetry = createStudioCommandTelemetry({ now });
  const scene = new FakeScene();
  const hud = createMcpLiveFeedWebGpuHud({
    THREE, document, eventTarget, source: telemetry, scene,
    width, height, pixelRatio, maxVisibleRows, now,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });
  return { document, eventTarget, timers, telemetry, scene, hud, context: hud.canvas.context };
}

test('HUD is visible by default, high-DPI, and camera updates reuse one cached texture in the primary scene', () => {
  const { timers, scene, hud, context } = fixture({ pixelRatio: 1 });
  assert.equal(hud.visible, true);
  assert.equal(hud.sprite.visible, true);
  assert.equal(scene.children[0], hud.sprite);
  assert.equal(hud.material.map, hud.texture);
  assert.equal(hud.material.depthTest, false);
  assert.equal(hud.material.depthWrite, false);
  assert.equal(hud.material.toneMapped, false);
  assert.equal(hud.texture.colorSpace, 'srgb');
  assert.equal(hud.panelBounds.left, 18);
  assert.equal(hud.panelBounds.pixelRatio, 3, 'HUD enforces a 3x backing store at DPR 1');
  assert.equal(hud.canvas.width, Math.round(hud.panelBounds.width * 3));
  assert.equal(hud.canvas.height, Math.round(hud.panelBounds.height * 3));
  assert.deepEqual(context.transforms.at(-1), [3, 0, 0, 3, 0, 0]);
  assert.equal(timers.active, 0);

  const drawRevision = hud.drawRevision;
  const texture = hud.texture;
  const camera = {
    isPerspectiveCamera: true,
    fov: 50,
    zoom: 1,
    near: 0.1,
    updateMatrixWorldCalls: 0,
    updateMatrixWorld() { this.updateMatrixWorldCalls += 1; },
    localToWorld(vector) { vector.x += 3; vector.y += 2; return vector; },
  };
  assert.equal(hud.updateCamera(camera), true);
  assert.equal(hud.updateCamera(camera), true);
  assert.equal(camera.updateMatrixWorldCalls, 2);
  assert.ok(hud.sprite.scale.x > 0 && hud.sprite.scale.y > 0);
  assert.equal('render' in hud, false, 'HUD cannot submit a second native render/swap');
  assert.equal(hud.texture, texture);
  assert.equal(hud.drawRevision, drawRevision, 'camera anchoring must not repaint the canvas');
});

test('telemetry events update a redacted row and only active elapsed time owns a timer', () => {
  let milliseconds = 1_000;
  const { timers, telemetry, hud, context } = fixture({ now: () => milliseconds });
  const before = hud.drawRevision;
  const lifecycle = telemetry.begin('three_studio_apply', {
    baseRevision: 4,
    sessionId: 'session-private',
    projectId: 'project/private',
    label: '<script>token-private</script>',
    operations: [{ op: 'entity.patch', entityId: 'entity/private', patch: { secret: true } }],
  });
  assert.ok(hud.drawRevision > before);
  assert.equal(timers.active, 1);
  assert.match(context.text.join('\n'), /three_studio_apply\s+STARTED\s+0ms\s+r4/);
  assert.match(context.text.join('\n'), /Apply 1 operation/);
  assert.doesNotMatch(context.text.join('\n'), /private|token|script|entity\//i);

  milliseconds += 1_250;
  const activeDraw = hud.drawRevision;
  timers.tick();
  assert.equal(hud.drawRevision, activeDraw + 1);
  assert.match(context.text.join('\n'), /1\.25s/);

  lifecycle.complete({ revision: 5, evidence: [{ data: 'base64-private', path: 'C:\\private.png' }] });
  assert.equal(timers.active, 0);
  assert.match(context.text.join('\n'), /three_studio_apply\s+COMPLETED\s+1\.25s\s+r5/);
  assert.doesNotMatch(context.text.join('\n'), /base64|private\.png/i);
});

test('wheel scrolling is virtualized, pointer-bounded, and redraws without affecting main render', () => {
  let milliseconds = 0;
  const { eventTarget, telemetry, hud } = fixture({
    now: () => milliseconds,
    width: 900,
    height: 300,
    pixelRatio: 1,
    maxVisibleRows: 10,
  });
  for (let index = 0; index < 14; index += 1) {
    const lifecycle = telemetry.begin('three_studio_status', {});
    milliseconds += 1;
    lifecycle.complete({ revision: index });
  }
  assert.ok(hud.visibleRowCount < 14);
  assert.ok(hud.scrollIndex > 0, 'new activity follows the tail');
  const bounds = hud.panelBounds;
  const inside = wheelEvent(bounds.left + 20, bounds.top + 20, -80);
  const beforeScroll = hud.scrollIndex;
  const beforeDraw = hud.drawRevision;
  eventTarget.dispatch('wheel', inside);
  assert.equal(inside.prevented, true);
  assert.equal(inside.stopped, true);
  assert.ok(hud.scrollIndex < beforeScroll);
  assert.equal(hud.drawRevision, beforeDraw + 1);

  const outside = wheelEvent(2, 2, -80);
  const afterInside = hud.scrollIndex;
  eventTarget.dispatch('wheel', outside);
  assert.equal(outside.prevented, false);
  assert.equal(hud.scrollIndex, afterInside);
});

test('exact shortcut, cached resize, and disposal update GPU presentation state safely', () => {
  const { eventTarget, timers, telemetry, hud } = fixture({ width: 800, height: 600, pixelRatio: 1 });
  telemetry.begin('three_studio_status', {});
  assert.equal(timers.active, 1);

  for (const event of [
    keyEvent({ altKey: true }), keyEvent({ metaKey: true }),
    keyEvent({ repeat: true }), keyEvent({ key: 'n' }),
  ]) eventTarget.dispatch('keydown', event);
  assert.equal(hud.visible, true);

  const hide = keyEvent();
  eventTarget.dispatch('keydown', hide);
  assert.equal(hide.prevented, true);
  assert.equal(hud.visible, false);
  assert.equal(hud.sprite.visible, false);
  assert.equal(timers.active, 0);
  eventTarget.dispatch('keydown', keyEvent({ key: 'M' }));
  assert.equal(hud.visible, true);
  assert.equal(timers.active, 1);
  const beforeResize = hud.drawRevision;
  const beforeWidth = hud.canvas.width;
  const beforeHeight = hud.canvas.height;
  hud.resize(1600, 900, 2.5);
  assert.equal(hud.panelBounds.pixelRatio, 3);
  assert.equal(hud.canvas.width, beforeWidth);
  assert.equal(hud.canvas.height, beforeHeight);
  assert.equal(hud.drawRevision, beforeResize);

  hud.dispose();
  hud.dispose();
  assert.equal(hud.visible, false);
  assert.equal(hud.sprite.visible, false);
  assert.equal(timers.active, 0);
  assert.equal(hud.texture.disposed, true);
  assert.equal(hud.material.disposed, true);
  assert.equal(hud.scene.children.length, 0);
  assert.equal(eventTarget.listeners.get('keydown').size, 0);
  assert.equal(eventTarget.listeners.get('wheel').size, 0);
});
