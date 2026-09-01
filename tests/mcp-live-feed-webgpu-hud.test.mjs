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
    repeat: false, prevented: false, stopped: false, immediateStopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
    stopImmediatePropagation() { this.immediateStopped = true; },
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
  llmSetupTab = true,
  localModels = [],
  promptEnabled = false,
  onProjectAction,
  onExportProject,
  onImportProject,
  onRtxSettingsChange,
  onDlss5SettingsChange,
  onViewportLayerChange,
  onPromptEnabledChange,
  onLocalPromptRun,
  writeClipboardText,
} = {}) {
  const document = new FakeDocument();
  const eventTarget = new FakeEventTarget();
  const timers = fakeTimers();
  const telemetry = createStudioCommandTelemetry({ now });
  const scene = new FakeScene();
  const hud = createMcpLiveFeedWebGpuHud({
    THREE, document, eventTarget, source: telemetry, scene,
    width, height, pixelRatio, maxVisibleRows, now, llmSetupTab, localModels, promptEnabled,
    onProjectAction,
    onExportProject,
    onImportProject,
    onRtxSettingsChange,
    onDlss5SettingsChange,
    onViewportLayerChange,
    onPromptEnabledChange,
    onLocalPromptRun,
    writeClipboardText,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    schedulePaint: callback => callback(),
  });
  return { document, eventTarget, timers, telemetry, scene, hud, context: hud.canvas.context };
}

function findControl(root, name) {
  if (root?.name === name) return root;
  for (const child of root?.children ?? []) {
    const match = findControl(child, name);
    if (match) return match;
  }
  return undefined;
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
  const logPage = hud.host.children.find(child => child.name === 'log-page');
  const explorerPage = hud.host.children.find(child => child.name === 'explorer-page');
  assert.equal(logPage.backColor, 'rgba(0, 0, 0, 0)');
  assert.equal(logPage.children.find(child => child.name === 'log-list').backColor, 'rgba(0, 0, 0, 0)');
  assert.equal(explorerPage.backColor, 'rgba(0, 0, 0, 0)');
  assert.equal(explorerPage.children.find(child => child.name === 'explorer-list').backColor, 'rgba(0, 0, 0, 0)');
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
  const settingsToggle = findControl(hud.host, 'settings-log-expanded');
  assert.equal(settingsToggle.selected, true);
  settingsToggle.onPointerDown();
  assert.equal(hud.logExpanded, false);
  tabs.setSelected('log');
  assert.doesNotMatch(hud.visibleLogText, /entity\.create mesh/);
});

test('expanded log reflows every visible item and preserves a followed tail', () => {
  const { hud, telemetry } = fixture({ height: 360, maxVisibleRows: 10 });
  for (let index = 0; index < 18; index += 1) {
    telemetry.begin('three_studio_status', {}).complete({ revision: index });
  }
  const compactMax = findControl(hud.host, 'log-list').maxScroll;
  assert.equal(hud.scrollIndex, compactMax);
  findControl(hud.host, 'log-expanded').onPointerDown();
  const expandedList = findControl(hud.host, 'log-list');
  assert.equal(hud.scrollIndex, expandedList.maxScroll);
  assert.equal(hud.visibleRowCount, expandedList.capacity);
  assert.match(hud.visibleLogText, /three_studio_status/u);
});

test('Plainform tab is a complete wrapped source stream', () => {
  const { hud, telemetry } = fixture({ height: 460 });
  const lifecycle = telemetry.begin('three_studio_apply', {
    baseRevision: 2,
    program: {
      language: 'plainform-v1',
      source: 'Use entity/tower as the tower.\nLay out a 4 by 8 grid over the front face of the tower.',
    },
  });
  lifecycle.complete({
    revision: 3,
    plainform: { interpretation: ['Will use the tower.', 'Laid out a centered grid.'] },
  });
  findControl(hud.host, 'tabs').setSelected('plainform');
  assert.equal(hud.tab, 'plainform');
  assert.match(hud.visiblePlainformText, /Use entity\/tower as the tower\./u);
  assert.match(hud.visiblePlainformText, /Lay out a 4 by 8 grid/u);
  assert.doesNotMatch(hud.visiblePlainformText, /UNDERSTOOD|Laid out a centered grid\./u);
});

test('Plainform Copy all writes the complete unwrapped retained source stream', async () => {
  const writes = [];
  const { hud, telemetry } = fixture({
    height: 260,
    writeClipboardText(value) { writes.push(value); },
  });
  telemetry.begin('three_studio_apply', {
    program: { language: 'plainform-v1', source: 'First precise sentence.\nSecond precise sentence.' },
  }).complete({ revision: 1 });
  telemetry.begin('three_studio_apply', {
    program: { language: 'plainform-v1', source: 'Third sentence from another change.' },
  }).complete({ revision: 2 });

  assert.equal(hud.completePlainformText,
    'First precise sentence.\nSecond precise sentence.\n\nThird sentence from another change.');
  assert.equal(await hud.copyAllPlainform(), true);
  assert.deepEqual(writes, [hud.completePlainformText]);
  assert.equal(findControl(hud.host, 'plainform-copy-all').text, 'Copied');
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

test('HUD does not steal pointer events from a marked Studio DOM overlay', () => {
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
  const review = findControl(hud.host, 'review');
  review.onPointerDown();
  assert.equal(hud.viewMode, 'review');

  const hide = keyEvent();
  eventTarget.dispatch('keydown', hide);
  assert.equal(hud.visible, false);
  eventTarget.dispatch('keydown', keyEvent({ key: 'M' }));
  assert.equal(hud.visible, true);
  assert.equal(hud.tab, 'settings');
});

test('Layers exposes committed, preview, all, and transient grid controls', () => {
  const changes = [];
  const { hud } = fixture({
    onViewportLayerChange(patch) { changes.push(patch); },
  });
  const tabs = findControl(hud.host, 'tabs');
  tabs.setSelected('layers');
  assert.equal(hud.tab, 'layers');
  assert.equal(findControl(hud.host, 'layer-preview').enabled, false);
  assert.equal(findControl(hud.host, 'layer-all').enabled, false);
  assert.equal(findControl(hud.host, 'layer-grid').selected, true);

  hud.setViewportLayerState({
    mode: 'preview',
    gridVisible: true,
    studioLightVisible: true,
    previewActive: true,
    previewLabel: 'Preview roof form',
    previewRevision: 7,
    layers: { scene: false, preview: true, grid: true, lighting: true },
  });
  assert.equal(findControl(hud.host, 'layer-preview').enabled, true);
  assert.equal(findControl(hud.host, 'layer-preview').selected, true);
  assert.match(findControl(hud.host, 'layer-preview-status').text, /PREVIEW ACTIVE.*r7.*Preview roof form/u);
  assert.match(findControl(hud.host, 'title').text, /PREVIEW/u);

  findControl(hud.host, 'layer-all').onPointerDown();
  findControl(hud.host, 'layer-grid').onPointerDown();
  findControl(hud.host, 'layer-studio-light').onPointerDown();
  assert.deepEqual(changes, [{ mode: 'all' }, { gridVisible: false }, { studioLightVisible: false }]);
  assert.equal(hud.viewportLayerState.mode, 'all');
  assert.equal(hud.viewportLayerState.gridVisible, false);
  assert.equal(hud.viewportLayerState.studioLightVisible, false);
});

test('Settings is a clipped pixel-scroll page with a visible synchronized scrollbar', () => {
  const { eventTarget, hud } = fixture({ width: 1000, height: 700, pixelRatio: 1 });
  hud.host.children.find(child => child.name === 'tabs').setSelected('settings');
  assert.ok(hud.settingsMaxScroll > 0);
  assert.equal(hud.settingsScrollOffset, 0);
  const settingsScroll = findControl(hud.host, 'settings-scroll');
  assert.equal(settingsScroll.visible, true);
  assert.equal(settingsScroll.maximum, hud.settingsMaxScroll);

  const bounds = hud.panelBounds;
  const wheel = wheelEvent(bounds.left + 100, bounds.top + 180, 180);
  eventTarget.dispatch('wheel', wheel);
  assert.equal(wheel.prevented, true);
  assert.ok(hud.settingsScrollOffset > 0);
  assert.equal(settingsScroll.value, hud.settingsScrollOffset);

  settingsScroll.setScroll(settingsScroll.maximum);
  assert.equal(hud.settingsScrollOffset, hud.settingsMaxScroll);
  const llmHint = findControl(hud.host, 'llm-settings-hint');
  assert.ok(llmHint.absoluteBounds.y < bounds.top + bounds.height);
});

test('Settings exposes the complete RTX controls and numeric drag commits only on release', () => {
  const rtxChanges = [];
  const { hud } = fixture({
    onRtxSettingsChange(patch) { rtxChanges.push(patch); },
  });
  hud.setGraphicsSettingsState({
    rtx: {
      authored: {
        enabled: true,
        lighting: true,
        shadows: true,
        ambientOcclusion: true,
        directionalSampleCount: 4,
        aoSampleCount: 6,
        directionalAngularRadius: 0.02,
        shadowStrength: 0.8,
        aoStrength: 0.3,
        aoRadius: 1.2,
        maxDistance: 5_000,
        rayBias: 0.003,
      },
      status: { supported: true, requested: true, configured: true, active: true, reason: 'active' },
    },
  });
  const names = [
    'rtx-enabled', 'rtx-lighting', 'rtx-shadows', 'rtx-ambient-occlusion',
    'rtx-directional-samples', 'rtx-directional-radius', 'rtx-shadow-strength',
    'rtx-ao-samples', 'rtx-ao-strength', 'rtx-ao-radius', 'rtx-max-distance', 'rtx-ray-bias',
  ];
  assert.deepEqual(names.filter(name => !findControl(hud.host, name)), []);
  assert.equal(findControl(hud.host, 'rtx-status').text, 'RTX active');

  const range = findControl(hud.host, 'rtx-shadow-strength');
  const bounds = range.absoluteBounds;
  range.onPointerDown({}, { x: bounds.x + 20 });
  range.onPointerMove({}, { x: bounds.x + bounds.width * 0.5 });
  range.onPointerMove({}, { x: bounds.x + bounds.width - 20 });
  assert.equal(rtxChanges.length, 0, 'dragging previews without compiling each pointer move');
  range.onPointerUp({}, { x: bounds.x + bounds.width - 20 });
  assert.equal(rtxChanges.length, 1);
  assert.deepEqual(Object.keys(rtxChanges[0]), ['shadowStrength']);
});

test('live graphics refreshes cannot snap back an active or compiling RTX slider', async () => {
  let finishUpdate;
  const update = new Promise(resolve => { finishUpdate = resolve; });
  const rtxChanges = [];
  const { hud } = fixture({
    onRtxSettingsChange(patch) {
      rtxChanges.push(patch);
      return update;
    },
  });
  const status = { supported: true, available: true, requested: true, reason: 'ready' };
  const initial = { enabled: true, shadowStrength: 0.2 };
  hud.setGraphicsSettingsState({ rtx: { authored: initial, status } });

  const range = findControl(hud.host, 'rtx-shadow-strength');
  const bounds = range.absoluteBounds;
  const x = bounds.x + (bounds.width * 0.8);
  range.onPointerDown({}, { x });
  const preview = range.value;
  hud.setGraphicsSettingsState({ rtx: { authored: initial, status } });
  assert.equal(range.value, preview, 'periodic state sync leaves the live drag alone');

  range.onPointerUp({}, { x });
  assert.deepEqual(rtxChanges, [{ shadowStrength: preview }]);
  hud.setGraphicsSettingsState({ rtx: { authored: initial, status } });
  assert.equal(range.value, preview, 'stale canonical state cannot overwrite an in-flight update');

  hud.setGraphicsSettingsState({
    rtx: { authored: { ...initial, shadowStrength: preview }, status },
  });
  finishUpdate();
  await update;
  await Promise.resolve();
  assert.equal(range.value, preview);
});

test('DLSS 5 has a capability-gated enable and exactly the real styles 0, 1, and 2', () => {
  const dlssChanges = [];
  const { hud } = fixture({
    onDlss5SettingsChange(patch) { dlssChanges.push(patch); },
  });
  const styleControls = findControl(hud.host, 'settings-scroll-panel-content').children
    .filter(control => control.name.startsWith('dlss5-style-'));
  assert.deepEqual(styleControls.map(control => control.name), [
    'dlss5-style-0', 'dlss5-style-1', 'dlss5-style-2',
  ]);
  assert.equal(findControl(hud.host, 'dlss5-enabled').enabled, false);

  hud.setGraphicsSettingsState({
    dlss5: {
      settings: { enabled: true, style: 1 },
      status: { supported: true, requested: true, configured: true, active: false, reason: 'ready' },
    },
  });
  assert.equal(findControl(hud.host, 'dlss5-enabled').enabled, true);
  assert.equal(findControl(hud.host, 'dlss5-style-1').selected, true);
  assert.equal(styleControls.every(control => control.enabled), true);
  findControl(hud.host, 'dlss5-style-2').onPointerDown();
  assert.deepEqual(dlssChanges, [{ style: 2 }]);
  assert.equal(hud.graphicsSettingsState.dlss5.settings.style, 2);
});

test('DLSS 5 advanced controls mirror native settings, gate together, and commit drags once', () => {
  const dlssChanges = [];
  const { hud } = fixture({
    onDlss5SettingsChange(patch) { dlssChanges.push(patch); },
  });
  const advancedNames = [
    'dlss5-style-0', 'dlss5-style-1', 'dlss5-style-2',
    'dlss5-intensity', 'dlss5-local-tone', 'dlss5-local-structure',
    'dlss5-global-tone', 'dlss5-skin-structure', 'dlss5-auto-mask',
  ];
  const advancedControls = advancedNames.map(name => findControl(hud.host, name));
  assert.deepEqual(advancedNames.filter((name, index) => !advancedControls[index]), []);
  assert.equal(advancedControls.every(control => control.enabled === false), true);

  hud.setGraphicsSettingsState({
    dlss5: {
      settings: {
        enabled: true,
        intensity: 0.82,
        localToneStrength: -0.25,
        localStructureStrength: 0.64,
        globalToneStrength: 0.45,
        skinStructureStrength: -0.7,
        style: 1,
        performanceMode: 'dlaa',
        useAutoMask: true,
      },
      status: {
        supported: true,
        available: true,
        requested: true,
        configured: true,
        active: true,
        reason: 'active',
      },
    },
  });

  assert.equal(advancedControls.every(control => control.enabled === true), true);
  assert.equal(findControl(hud.host, 'dlss5-intensity').value, 0.82);
  assert.equal(findControl(hud.host, 'dlss5-local-tone').value, -0.25);
  assert.equal(findControl(hud.host, 'dlss5-local-structure').value, 0.64);
  assert.equal(findControl(hud.host, 'dlss5-global-tone').value, 0.45);
  assert.equal(findControl(hud.host, 'dlss5-skin-structure').value, -0.7);
  assert.equal(findControl(hud.host, 'dlss5-auto-mask').selected, true);

  const localTone = findControl(hud.host, 'dlss5-local-tone');
  const bounds = localTone.absoluteBounds;
  localTone.onPointerDown({}, { x: bounds.x + 20 });
  localTone.onPointerMove({}, { x: bounds.x + bounds.width * 0.75 });
  assert.equal(dlssChanges.length, 0, 'advanced slider movement stays local until release');
  localTone.onPointerUp({}, { x: bounds.x + bounds.width * 0.75 });
  assert.equal(dlssChanges.length, 1);
  assert.deepEqual(Object.keys(dlssChanges[0]), ['localToneStrength']);

  findControl(hud.host, 'dlss5-auto-mask').onPointerDown();
  assert.deepEqual(dlssChanges[1], { useAutoMask: false });
  assert.equal(hud.graphicsSettingsState.dlss5.settings.useAutoMask, false);

  hud.setGraphicsSettingsState({
    dlss5: {
      settings: { enabled: false, style: 2 },
      status: { supported: true, available: true, requested: false, reason: 'disabled' },
    },
  });
  assert.equal(advancedControls.every(control => control.enabled === false), true);
});

test('graphics status accepts controller snapshots and gates DLSS on complete availability', () => {
  const { hud } = fixture();
  hud.setGraphicsSettingsState({
    rtx: {
      supported: true,
      requested: false,
      configured: false,
      active: false,
      settings: {
        enabled: false,
        lighting: { enabled: true, maxDistance: 2_500, rayBias: 0.001 },
        shadows: { enabled: true, strength: 0.64, sampleCount: 7, angularRadius: 0.01 },
        ambientOcclusion: { enabled: false, strength: 0.2, sampleCount: 3, radius: 2 },
      },
      reason: 'disabled',
    },
    dlss5: {
      supported: true,
      available: false,
      requested: false,
      configured: false,
      active: false,
      failed: false,
      settings: { enabled: false, style: 2 },
      reason: 'The signed plug-in API is unavailable.',
    },
  });

  assert.equal(findControl(hud.host, 'rtx-enabled').enabled, true);
  assert.equal(findControl(hud.host, 'rtx-directional-samples').value, 7);
  assert.equal(findControl(hud.host, 'rtx-ambient-occlusion').selected, false);
  assert.equal(findControl(hud.host, 'dlss5-enabled').enabled, false);
  assert.equal(findControl(hud.host, 'dlss5-style-2').selected, true);
  assert.match(findControl(hud.host, 'dlss5-status').text, /DLSS 5 unavailable/);
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
  assert.ok(hud.drawRevision > beforeResize, 'viewport-aware sizing repaints the HUD bitmap');
  assert.equal(hud.panelBounds.width, beforeBounds.width);
  assert.ok(hud.panelBounds.height >= beforeBounds.height);
  assert.equal(hud.panelBounds.pixelRatio, 2);
  assert.ok(hud.panelBounds.top + hud.panelBounds.height <= 900 - 12);

  hud.dispose();
  hud.dispose();
  assert.equal(hud.visible, false);
  assert.equal(hud.sprite.visible, false);
  assert.equal(timers.active, 0);
  assert.equal(hud.texture.disposed, true);
  assert.equal(hud.material.disposed, true);
  assert.equal(hud.scene.children.length, 0);
  assert.equal(eventTarget.listeners.get('keydown').size, 0);
  assert.equal(eventTarget.listeners.get('keyup').size, 0);
  assert.equal(eventTarget.listeners.get('keypress').size, 0);
  assert.equal(eventTarget.listeners.get('pointerdown').size, 0);
  assert.equal(eventTarget.listeners.get('wheel').size, 0);
});

test('HUD backing bitmap never exceeds the visible control or window bounds', () => {
  const { hud } = fixture({ width: 220, height: 180, pixelRatio: 2 });
  const bounds = hud.panelBounds;

  assert.ok(bounds.left + bounds.width <= 220 - 12);
  assert.ok(bounds.top + bounds.height <= 180 - 12);
  assert.equal(hud.canvas.width, Math.round(bounds.width * bounds.pixelRatio));
  assert.equal(hud.canvas.height, Math.round(bounds.height * bounds.pixelRatio));
  assert.ok(hud.canvas.width <= Math.round((220 - 24) * bounds.pixelRatio));
  assert.ok(hud.canvas.height <= Math.round((180 - 24) * bounds.pixelRatio));

  hud.dispose();
});

test('LLM Setup is a retained main-window tab on every host', () => {
  const model = { id: 'model/local', label: 'Local Test', runtime: 'webllm', vramRequiredMB: 64, contextTokens: 2048 };
  const { hud } = fixture({ localModels: [model] });
  const tabs = hud.host.children.find(child => child.name === 'tabs');
  assert.deepEqual(tabs.tabs.map(tab => tab.id), ['log', 'plainform', 'explorer', 'layers', 'settings', 'llm']);
  tabs.setSelected('llm');
  assert.equal(hud.tab, 'llm');
  assert.equal(hud.host.children.find(child => child.name === 'llm-page').visible, true);
  const status = hud.host.children.find(child => child.name === 'status');
  assert.equal(status.text, 'LLM Setup  ·  on-device models');
  hud.setLocalModelState({ supported: true, activeModelId: model.id, ready: true });
  assert.equal(status.text, 'LLM Setup  ·  local model ready');
  assert.match(findControl(hud.host, 'llm-harness-hint').text, /Every prompt routes through Studio MCP/);
  assert.match(findControl(hud.host, 'llm-harness-hint').text, /three_studio_apply/);
  tabs.setSelected('settings');
  findControl(hud.host, 'open-llm-setup').onClick();
  assert.equal(hud.tab, 'llm');
  hud.dispose();
});

test('optional Prompt workspace routes Ctrl+Enter through the active local model harness', async () => {
  const model = { id: 'model/local', label: 'Local Test', runtime: 'webllm', vramRequiredMB: 64, contextTokens: 2048 };
  const enabledChanges = [];
  const runs = [];
  const { eventTarget, hud } = fixture({
    localModels: [model],
    onPromptEnabledChange(enabled) { enabledChanges.push(enabled); },
    async onLocalPromptRun(prompt, { onEvent }) {
      runs.push(prompt);
      onEvent({ type: 'tool-call', name: 'three_studio_status' });
      onEvent({ type: 'tool-result', name: 'three_studio_status', ok: true });
      return { text: 'Project is ready.', rounds: 2, toolTrace: [{ name: 'three_studio_status' }] };
    },
  });
  const tabs = findControl(hud.host, 'tabs');
  tabs.setSelected('llm');
  const toggle = findControl(hud.host, 'llm-prompt-enabled');
  const input = findControl(hud.host, 'llm-prompt-input');
  const runButton = findControl(hud.host, 'llm-prompt-run');
  assert.equal(toggle.selected, false);
  assert.equal(input.visible, false);

  toggle.onPointerDown();
  assert.deepEqual(enabledChanges, [true]);
  assert.equal(input.visible, true);
  assert.equal(runButton.enabled, false, 'a ready model and non-empty prompt are both required');
  hud.setLocalModelState({ supported: true, activeModelId: model.id, ready: true });
  input.onPointerDown();
  for (const key of 'Status') {
    const event = keyEvent({ key, ctrlKey: false, shiftKey: false });
    eventTarget.dispatch('keydown', event);
    assert.equal(event.prevented, true, 'typing is retained by the Prompt workspace');
  }
  assert.equal(input.text, 'Status');
  eventTarget.dispatch('keydown', keyEvent({ key: 'x', code: 'KeyX', timeStamp: 123, ctrlKey: false, shiftKey: false }));
  eventTarget.dispatch('keydown', keyEvent({ key: 'x', code: 'KeyX', timeStamp: 123, ctrlKey: false, shiftKey: false }));
  assert.equal(input.text, 'Statusx', 'duplicate native delivery of one physical key edits once');
  assert.equal(runButton.enabled, true);
  const newline = keyEvent({ key: 'Enter', code: 'Enter', ctrlKey: false, shiftKey: false });
  eventTarget.dispatch('keydown', newline);
  assert.equal(input.text, 'Statusx\n');
  assert.equal(newline.immediateStopped, true);
  assert.deepEqual(runs, [], 'plain Enter edits the multiline prompt');
  for (const key of 'More') eventTarget.dispatch('keydown', keyEvent({ key, ctrlKey: false, shiftKey: false }));
  const submit = keyEvent({ key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: false });
  eventTarget.dispatch('keydown', submit);
  const submitUp = keyEvent({ key: 'Enter', code: 'Enter', ctrlKey: false, shiftKey: false });
  eventTarget.dispatch('keyup', submitUp);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(runs, ['Statusx\nMore']);
  assert.equal(submit.immediateStopped, true);
  assert.equal(submitUp.immediateStopped, true, 'key-up is also retained and cannot reach the 3D input controller');
  assert.equal(findControl(hud.host, 'llm-prompt-status').text, 'Completed via 1 MCP call in 2 model rounds.');
  assert.equal(findControl(hud.host, 'llm-prompt-output').text, 'Project is ready.');
  assert.equal(hud.visible, true, 'Enter cannot leak into the panel shortcut or viewport');
  hud.dispose();
});

test('top project toolbar routes save, new, clear, import, and export actions', async () => {
  const calls = [];
  const { document, hud } = fixture({
    onProjectAction(action) { calls.push(action); return `${action} complete`; },
  });
  assert.equal(document.canvases.length > 0, true);
  const exportButton = findControl(hud.host, 'export-project');
  const importButton = findControl(hud.host, 'import-project');
  const newBlankButton = findControl(hud.host, 'project-new-blank');
  const clearButton = findControl(hud.host, 'project-clear-scene');
  assert.equal(exportButton.text, 'Export');
  assert.equal(importButton.text, 'Import');
  assert.equal(newBlankButton.text, 'Blank');
  assert.equal(clearButton.text, 'Clear');
  assert.equal(exportButton.parent, hud.host, 'project transfer controls live in the retained top toolbar');
  exportButton.onClick();
  await new Promise(resolve => setImmediate(resolve));
  importButton.onClick();
  assert.match(hud.projectTransferStatus, /again within 5 seconds/);
  importButton.onClick();
  await new Promise(resolve => setImmediate(resolve));
  newBlankButton.onClick();
  newBlankButton.onClick();
  await new Promise(resolve => setImmediate(resolve));
  clearButton.onClick();
  clearButton.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['export', 'import', 'new-blank', 'clear-scene']);
  hud.setProjectTransferStatus('Exported Packed Scene.');
  assert.equal(hud.projectTransferStatus, 'Exported Packed Scene.');
  hud.dispose();
});

test('wide left panel collapses to a retained expand handle and restores its selected page', () => {
  const { hud } = fixture({ width: 1000, height: 700, pixelRatio: 1 });
  const collapseButton = findControl(hud.host, 'panel-collapse');
  const title = findControl(hud.host, 'title');
  const logPage = findControl(hud.host, 'log-page');
  assert.equal(hud.panelBounds.width, 460);
  assert.equal(hud.collapsed, false);
  collapseButton.onClick();
  assert.equal(hud.collapsed, true);
  assert.equal(hud.panelBounds.width, 44);
  assert.equal(hud.panelBounds.height, 44);
  assert.equal(collapseButton.visible, true);
  assert.equal(collapseButton.text, '>');
  assert.equal(title.visible, false);
  assert.equal(logPage.visible, false);
  collapseButton.onClick();
  assert.equal(hud.collapsed, false);
  assert.equal(hud.panelBounds.width, 460);
  assert.equal(title.visible, true);
  assert.equal(logPage.visible, true);
  hud.dispose();
});
