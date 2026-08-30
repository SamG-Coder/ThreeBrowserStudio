import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectDocument } from '../src/core/index.mjs';
import { createStudioCommandTelemetry } from '../src/runtime/mcp-live-feed-telemetry.mjs';
import { createMcpLiveFeedWebGpuHud } from '../src/viewport/mcp-live-feed-webgpu-hud.mjs';
import { buildExplorerOutline } from '../src/viewport/scene-explorer.mjs';

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

  save() {}
  restore() {}
  beginPath() {}
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  closePath() {}
  rect() {}
  clip() {}
  arc() {}
  fill() {}

  clearRect() {
    this.draws += 1;
    this.text = [];
  }

  fillRect() {}

  fillText(value) {
    this.text.push(String(value));
  }

  measureText(text) {
    return { width: String(text).length * 7, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 };
  }

  drawImage() {}

  getImageData(x, y, width, height) {
    return { x, y, width, height, data: new Uint8ClampedArray(Math.max(0, width * height * 4)) };
  }

  putImageData() {}
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

function fixture({
  now = () => 0,
  width = 1000,
  height = 700,
  pixelRatio = 2,
  maxVisibleRows = 10,
  promptTab = false,
  onExportProject,
  onImportProject,
} = {}) {
  const document = new FakeDocument();
  const eventTarget = new FakeEventTarget();
  const timers = fakeTimers();
  const telemetry = createStudioCommandTelemetry({ now });
  const scene = new FakeScene();
  const hud = createMcpLiveFeedWebGpuHud({
    THREE, document, eventTarget, source: telemetry, scene,
    width, height, pixelRatio, maxVisibleRows, now, promptTab,
    onExportProject,
    onImportProject,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    schedulePaint: callback => callback(),
  });
  return { document, eventTarget, timers, telemetry, scene, hud, context: hud.canvas.context };
}

test('side panel is visible by default and camera updates do not invalidate', () => {
  const { timers, scene, hud } = fixture({ pixelRatio: 1 });
  assert.equal(hud.visible, true);
  assert.equal(hud.sprite.visible, true);
  assert.equal(hud.tab, 'log');
  assert.equal(scene.children[0], hud.sprite);
  assert.equal(hud.material.map, hud.texture);
  assert.equal(hud.material.depthTest, false);
  assert.equal(hud.texture.colorSpace, 'srgb');
  assert.equal(hud.host.backColor, 'rgba(8, 13, 22, 0.92)', 'HUD backing keeps its intentional translucency');
  assert.equal(hud.panelBounds.left, 12);
  assert.equal(hud.panelBounds.pixelRatio, 1);
  assert.equal(hud.canvas.width, Math.round(hud.panelBounds.width * hud.panelBounds.pixelRatio));
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

test('telemetry updates a redacted log row and only active rows own the timer', () => {
  let milliseconds = 1_000;
  const { timers, telemetry, hud } = fixture({ now: () => milliseconds });
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
  assert.match(hud.visibleLogText, /three_studio_apply\s+STARTED\s+0ms\s+r4/);
  assert.match(hud.visibleLogText, /Apply 1 operation/);
  assert.doesNotMatch(hud.visibleLogText, /private|token|script|entity\//i);

  milliseconds += 1_250;
  const activeDraw = hud.drawRevision;
  timers.tick();
  assert.ok(hud.drawRevision > activeDraw);
  assert.match(hud.visibleLogText, /1\.25s/);

  lifecycle.complete({ revision: 5, evidence: [{ data: 'base64-private', path: 'C:\\private.png' }] });
  assert.equal(timers.active, 0);
  assert.match(hud.visibleLogText, /three_studio_apply\s+COMPLETED\s+1\.25s\s+r5/);
  assert.doesNotMatch(hud.visibleLogText, /base64|private\.png/i);
});

test('expanded log toggle shows whitelisted operation types and stays redacted', () => {
  const { hud, telemetry } = fixture();
  telemetry.begin('three_studio_apply', {
    baseRevision: 4,
    label: '<script>token-private</script>',
    operations: [
      { op: 'entity.create', entity: { kind: 'mesh', name: 'private-mesh' } },
      { op: 'entity.create', entity: { kind: 'mesh' } },
      { op: 'entity.patch', entityId: 'entity/private', patch: { secret: true } },
    ],
  });
  assert.equal(hud.logExpanded, false);
  assert.match(hud.visibleLogText, /Apply 3 operations/);
  assert.doesNotMatch(hud.visibleLogText, /entity\.create mesh|entity\.patch/);

  const logToggle = hud.host.children
    .find(child => child.name === 'log-page')
    .children.find(child => child.name === 'log-toolbar')
    .children.find(child => child.name === 'log-expanded');
  logToggle.onPointerDown();
  assert.equal(hud.logExpanded, true);
  assert.match(hud.visibleLogText, /Apply 3 operations/);
  assert.match(hud.visibleLogText, /entity\.create mesh ×2/);
  assert.match(hud.visibleLogText, /entity\.patch/);
  assert.doesNotMatch(hud.visibleLogText, /private|token|script|secret/i);

  const tabs = hud.host.children.find(child => child.name === 'tabs');
  tabs.setSelected('settings');
  const settingsToggle = hud.host.children
    .find(child => child.name === 'settings-page')
    .children.find(child => child.name === 'settings-log-expanded');
  assert.equal(settingsToggle.selected, true);
  settingsToggle.onPointerDown();
  assert.equal(hud.logExpanded, false);
  tabs.setSelected('log');
  assert.doesNotMatch(hud.visibleLogText, /entity\.create mesh/);
});

test('wheel scrolling is virtualized, pointer-bounded, and shows a scrollbar', () => {
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
  const inside = wheelEvent(bounds.left + 20, bounds.top + 90, -80);
  const beforeScroll = hud.scrollIndex;
  const beforeDraw = hud.drawRevision;
  eventTarget.dispatch('wheel', inside);
  assert.equal(inside.prevented, true);
  assert.equal(inside.stopped, true);
  assert.ok(hud.scrollIndex < beforeScroll);
  assert.ok(hud.drawRevision > beforeDraw);

  const outside = wheelEvent(2, 2, -80);
  const afterInside = hud.scrollIndex;
  eventTarget.dispatch('wheel', outside);
  assert.equal(outside.prevented, false);
  assert.equal(hud.scrollIndex, afterInside);
});

test('pointer hits on the panel steal the event so orbit does not start', () => {
  const { eventTarget, hud } = fixture({ width: 1000, height: 700, pixelRatio: 1 });
  const bounds = hud.panelBounds;
  const event = {
    clientX: bounds.left + 24,
    clientY: bounds.top + 20,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
    stopImmediatePropagation() { this.stopped = true; },
  };
  eventTarget.dispatch('pointerdown', event);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
});

test('HUD does not steal pointer events from the browser Prompt overlay', () => {
  const { hud } = fixture({ width: 1000, height: 700, pixelRatio: 1 });
  const overlay = { closest: selector => String(selector).includes('data-studio-overlay') ? overlay : null };
  const event = {
    clientX: 40,
    clientY: 40,
    offsetX: 3,
    offsetY: 4,
    target: overlay,
    prevented: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() {},
    stopImmediatePropagation() {},
  };
  assert.equal(hud.handlePointerDown(event), false);
  assert.equal(event.prevented, false);
});

test('explorer tab shows the scene tree and collapse stays in the HUD', () => {
  const { hud } = fixture({ width: 1000, height: 700, pixelRatio: 1 });
  hud.setExplorerOutline(buildExplorerOutline(createProjectDocument({
    projectId: 'project/hud-explorer',
    name: 'HUD explorer',
    scenes: [{
      id: 'scene/main',
      name: 'Stage',
      rootEntityIds: ['entity/room'],
      entities: [
        { id: 'entity/room', kind: 'group', name: 'Room', children: ['entity/table'] },
        { id: 'entity/table', kind: 'mesh', name: 'Table', parentId: 'entity/room' },
      ],
    }],
  })));
  const tabs = hud.host.children.find(child => child.name === 'tabs');
  tabs.setSelected('explorer');
  assert.equal(hud.tab, 'explorer');
  assert.match(hud.visibleExplorerText, /Stage/);
  assert.match(hud.visibleExplorerText, /Room/);
  assert.match(hud.visibleExplorerText, /Table/);

  const explorerList = hud.host.children
    .find(child => child.name === 'explorer-page')
    .children.find(child => child.name === 'explorer-list');
  const roomIndex = hud.visibleExplorerText.split('\n').findIndex(line => line.includes('Room'));
  explorerList.onActivate(roomIndex);
  assert.match(hud.visibleExplorerText, /Room/);
  assert.doesNotMatch(hud.visibleExplorerText, /Table/);
  assert.equal(hud.explorerRowCount, 2);
});

test('settings tab switches without a full-tree glyph rebuild and view-mode is retained', () => {
  const { eventTarget, hud } = fixture({ width: 1000, height: 700, pixelRatio: 1 });
  assert.equal(hud.viewMode, 'follow-shot');
  const tabs = hud.host.children.find(child => child.name === 'tabs');
  tabs.setSelected('settings');
  assert.equal(hud.tab, 'settings');
  const review = hud.host.children
    .find(child => child.name === 'settings-page')
    .children.find(child => child.name === 'review');
  review.onPointerDown();
  assert.equal(hud.viewMode, 'review');

  const hide = keyEvent();
  eventTarget.dispatch('keydown', hide);
  assert.equal(hud.visible, false);
  eventTarget.dispatch('keydown', keyEvent({ key: 'M' }));
  assert.equal(hud.visible, true);
  assert.equal(hud.tab, 'settings');
});

test('exact shortcut and disposal update GPU presentation state safely', () => {
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
  const beforeBounds = { ...hud.panelBounds };
  hud.resize(1600, 900, 2.5);
  assert.equal(hud.drawRevision, beforeResize, 'window size must not rebuild the HUD bitmap');
  assert.equal(hud.panelBounds.width, beforeBounds.width);
  assert.equal(hud.panelBounds.height, beforeBounds.height);
  assert.equal(hud.panelBounds.pixelRatio, beforeBounds.pixelRatio);

  hud.dispose();
  hud.dispose();
  assert.equal(hud.visible, false);
  assert.equal(hud.sprite.visible, false);
  assert.equal(timers.active, 0);
  assert.equal(hud.texture.disposed, true);
  assert.equal(hud.material.disposed, true);
  assert.equal(hud.scene.children.length, 0);
  assert.equal(eventTarget.listeners.get('keydown').size, 0);
  assert.equal(eventTarget.listeners.get('pointerdown').size, 0);
  assert.equal(eventTarget.listeners.get('wheel').size, 0);
});

test('Prompt tab is browser-only and does not appear on the native HUD', () => {
  const native = fixture();
  const nativeTabs = native.hud.host.children.find(child => child.name === 'tabs');
  assert.deepEqual(nativeTabs.tabs.map(tab => tab.id), ['log', 'explorer', 'settings']);
  assert.equal(native.hud.host.children.some(child => child.name === 'prompt-page'), false);
  native.hud.dispose();

  const browser = fixture({ promptTab: true });
  const browserTabs = browser.hud.host.children.find(child => child.name === 'tabs');
  assert.deepEqual(browserTabs.tabs.map(tab => tab.id), ['log', 'explorer', 'settings', 'prompt']);
  browserTabs.setSelected('prompt');
  assert.equal(browser.hud.tab, 'prompt');
  const promptPage = browser.hud.host.children.find(child => child.name === 'prompt-page');
  assert.equal(promptPage.visible, true);
  const status = browser.hud.host.children.find(child => child.name === 'status');
  assert.equal(status.text, 'Prompt  ·  PIN-encrypted models');
  browserTabs.setSelected('settings');
  const openPrompt = browser.hud.host.children
    .find(child => child.name === 'settings-page')
    .children.find(child => child.name === 'open-prompt');
  openPrompt.onClick();
  assert.equal(browser.hud.tab, 'prompt');
  browser.hud.dispose();
});

test('Settings Import/Export is always present and does not create file inputs', () => {
  const calls = [];
  const { document, hud } = fixture({
    onExportProject() { calls.push('export'); },
    onImportProject() { calls.push('import'); },
  });
  assert.equal(document.canvases.length > 0, true);
  const settings = hud.host.children.find(child => child.name === 'settings-page');
  const exportButton = settings.children.find(child => child.name === 'export-project');
  const importButton = settings.children.find(child => child.name === 'import-project');
  assert.equal(exportButton.text, 'Export JSON');
  assert.equal(importButton.text, 'Import JSON');
  exportButton.onClick();
  importButton.onClick();
  assert.deepEqual(calls, ['export', 'import']);
  hud.setProjectTransferStatus('Exported Packed Scene.');
  assert.equal(hud.projectTransferStatus, 'Exported Packed Scene.');
  hud.dispose();
});
