import assert from 'node:assert/strict';
import test from 'node:test';

import { createFontRunCache } from '../src/viewport/overlay-fonts.mjs';
import { absorbRect, intersectRect, unionRect } from '../src/viewport/overlay-geometry.mjs';
import {
  Button,
  Label,
  OverlayHost,
  RangeOption,
  ScrollPanel,
  VirtualList,
  claimStudioViewportFocus,
  isEditableStudioEvent,
  isStudioOverlayEvent,
} from '../src/viewport/overlay-controls.mjs';
import {
  createReviewSession,
  operationsSnapFollowShot,
  resolveVisibleCamera,
} from '../src/viewport/view-mode.mjs';

class FakeContext {
  constructor() {
    this.fills = [];
    this.texts = [];
    this.blits = [];
    this.clips = [];
    this.font = '';
    this.fillStyle = '';
    this.saves = 0;
  }

  setTransform() {}
  save() { this.saves += 1; }
  restore() {}
  beginPath() {}
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  closePath() {}
  fill() {}
  rect(x, y, width, height) { this.clips.push({ x, y, width, height }); }
  clip() {}
  clearRect() {}
  fillRect(x, y, width, height) { this.fills.push({ x, y, width, height, fillStyle: this.fillStyle }); }
  fillText(text) { this.texts.push(String(text)); }
  measureText(text) {
    return { width: String(text).length * 7, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 };
  }
  drawImage(image, x, y, width = image?.width, height = image?.height) {
    this.blits.push({ x, y, width, height: height ?? image?.height });
  }

  getImageData(x, y, width, height) {
    return { x, y, width, height, data: new Uint8ClampedArray(Math.max(0, width * height * 4)) };
  }

  putImageData() {}
}

class FakeCanvas {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.context = new FakeContext();
  }

  getContext(kind) {
    return kind === '2d' ? this.context : null;
  }
}

function hostFixture() {
  const canvases = [];
  const createCanvas = () => {
    const canvas = new FakeCanvas();
    canvases.push(canvas);
    return canvas;
  };
  const canvas = createCanvas();
  const fonts = createFontRunCache({ createCanvas });
  const host = new OverlayHost({
    canvas,
    context: canvas.context,
    fonts,
    schedulePaint: callback => callback(),
    backColor: '#000',
  });
  host.setBacking(200, 160, 2);
  return { host, canvas, fonts };
}

test('update regions union and only the dirty clip is painted', () => {
  const { host } = hostFixture();
  const label = host.add(new Label({ text: 'hello', x: 10, y: 80, width: 80, height: 20 }));
  const before = host.paintGeneration;
  host.paintedRects = [];
  label.setText('hello');
  assert.equal(host.paintGeneration, before, 'unchanged text must not invalidate');

  label.setText('world');
  assert.equal(host.paintGeneration, before + 1);
  const clip = host.paintedRects.at(-1);
  assert.ok(clip.width <= 90 && clip.height <= 24);
  assert.ok(clip.y >= 80);
});

test('dirty regions are clipped to the control bitmap before scheduling paint', () => {
  const { host } = hostFixture();
  host.paintedRects = [];

  host.invalidateRect({ x: -500, y: -500, width: 1000, height: 1000 });

  assert.deepEqual(host.paintedRects.at(-1), { x: 0, y: 0, width: 200, height: 160 });
});

test('list scroll copies existing rows and paints only the exposed strip', () => {
  const { host } = hostFixture();
  const painted = [];
  const list = host.add(new VirtualList({
    x: 0,
    y: 40,
    width: 200,
    height: 80,
    itemHeight: 20,
    itemCount: 8,
    paintItem(_context, _fonts, { index }) { painted.push(index); },
  }));
  host.paintedRects = [];
  painted.length = 0;
  assert.equal(list.setScrollIndex(1), true);
  assert.deepEqual(painted, [4]);
  const clip = host.paintedRects.at(-1);
  assert.ok(clip.y >= 100);
  assert.ok(clip.height <= 24);

  const generation = host.paintGeneration;
  assert.equal(list.setItems(8), false);
  assert.equal(host.paintGeneration, generation);
  list.setVisible(false);
  const afterHide = host.paintGeneration;
  list.invalidate();
  list.invalidateItem(4);
  assert.equal(host.paintGeneration, afterHide);
});

test('virtual list item invalidation does not repaint the header', () => {
  const { host } = hostFixture();
  host.add(new Label({ name: 'header', text: 'HEADER', x: 0, y: 0, width: 200, height: 24 }));
  const painted = [];
  const list = host.add(new VirtualList({
    x: 0,
    y: 40,
    width: 200,
    height: 80,
    itemHeight: 20,
    itemCount: 8,
    paintItem(_context, _fonts, { index }) { painted.push(index); },
  }));
  host.paintedRects = [];
  painted.length = 0;
  list.invalidateItem(2);
  const clip = host.paintedRects.at(-1);
  assert.ok(clip.y >= 40, 'header y=0 must stay outside the update region');
  assert.deepEqual(painted, [2]);
});

test('font runs rasterize once and then blit', () => {
  const canvases = [];
  const fonts = createFontRunCache({
    createCanvas: () => {
      const canvas = new FakeCanvas();
      canvases.push(canvas);
      return canvas;
    },
  });
  const dest = new FakeContext();
  fonts.blit(dest, 'Follow shot', 0, 10, { font: '13px sans-serif', fillStyle: '#fff' });
  fonts.blit(dest, 'Follow shot', 0, 30, { font: '13px sans-serif', fillStyle: '#fff' });
  assert.equal(fonts.rasterCount, 1);
  assert.equal(fonts.blitCount, 2);
  assert.equal(dest.blits.length, 2);
  fonts.setScale(2);
  fonts.blit(dest, 'Follow shot', 0, 50, { font: '13px sans-serif', fillStyle: '#fff' });
  assert.equal(fonts.rasterCount, 2, 'device-pixel scale is a distinct cached run');
  assert.ok(dest.blits.at(-1).width >= dest.blits[0].width);
});

test('virtual list pointer down activates the visible row', () => {
  const { host } = hostFixture();
  let activated = null;
  const list = host.add(new VirtualList({
    x: 0,
    y: 40,
    width: 200,
    height: 80,
    itemHeight: 20,
    itemCount: 8,
    onActivate(index) { activated = index; },
  }));
  list.setScrollIndex(2, { notify: false });
  assert.equal(list.onPointerDown({}, { y: 55 }), true);
  assert.equal(activated, 2);
  assert.equal(list.onPointerDown({}, { y: 200 }), false);
});

test('button click only invalidates the button bounds', () => {
  const { host } = hostFixture();
  let clicks = 0;
  const button = host.add(new Button({
    text: 'Review',
    x: 40,
    y: 100,
    width: 80,
    height: 24,
    onClick() { clicks += 1; },
  }));
  host.paintedRects = [];
  const hit = host.hitTest(50, 110);
  assert.equal(hit, button);
  button.onPointerDown();
  button.onPointerUp({}, { inside: true });
  assert.equal(clicks, 1);
  const clip = host.paintedRects.at(-1);
  assert.ok(clip.y >= 100);
});

test('scroll panel clips offscreen children and scrolls in pixels', () => {
  const { host, canvas } = hostFixture();
  const panel = host.add(new ScrollPanel({
    name: 'settings',
    x: 10,
    y: 20,
    width: 160,
    height: 80,
    contentHeight: 240,
  }));
  const below = panel.addContent(new Label({
    name: 'below',
    text: 'BELOW',
    x: 0,
    y: 180,
    width: 140,
    height: 20,
  }));
  host.paintedRects = [];
  below.invalidate();
  assert.deepEqual(host.paintedRects, [], 'offscreen children cannot dirty outside the clipped viewport');

  assert.equal(panel.onWheel({}, { delta: 120 }), true);
  assert.ok(panel.value > 0);
  panel.setScroll(panel.maxScroll);
  assert.equal(panel.value, 160);
  assert.ok(below.absoluteBounds.y >= panel.absoluteBounds.y);
  panel.invalidate();
  assert.ok(canvas.context.clips.some(clip => clip.x === 10 && clip.y === 20 && clip.width === 160 && clip.height === 80));
});

test('scroll panel follows high-resolution wheel deltas without relaying out its tree', () => {
  const { host } = hostFixture();
  const panel = host.add(new ScrollPanel({ width: 160, height: 80, contentHeight: 240 }));
  let layouts = 0;
  panel.addContent(new class extends Label {
    performLayout() { layouts += 1; }
  }({ text: 'child', width: 100, height: 20 }));
  layouts = 0;
  for (let index = 0; index < 4; index += 1) panel.onWheel({}, { delta: 0.4 });
  assert.equal(panel.value, 2);
  assert.equal(layouts, 0, 'scrolling only repositions retained content');
});

test('range option previews a drag and commits exactly once on pointer release', () => {
  const { host } = hostFixture();
  const values = [];
  const range = host.add(new RangeOption({
    text: 'Strength',
    x: 10,
    y: 40,
    width: 180,
    height: 36,
    value: 0.2,
    minimum: 0,
    maximum: 1,
    step: 0.01,
    onChange(value) { values.push(value); },
  }));
  const bounds = range.absoluteBounds;
  range.onPointerDown({}, { x: bounds.x + 20 });
  assert.equal(range.interacting, true);
  range.onPointerMove({}, { x: bounds.x + 100 });
  range.onPointerMove({}, { x: bounds.x + 150 });
  assert.equal(values.length, 0);
  range.onPointerUp({}, { x: bounds.x + 150 });
  assert.equal(range.interacting, false);
  assert.equal(values.length, 1);
  assert.equal(values[0], range.value);
});

test('camera.frame snaps follow-shot; review keeps the free camera', () => {
  assert.equal(operationsSnapFollowShot([{ op: 'camera.frame' }]), true);
  assert.equal(operationsSnapFollowShot([{ type: 'entity.patch' }]), false);
  const authored = { id: 'authored' };
  const review = { id: 'review' };
  assert.equal(resolveVisibleCamera({
    viewMode: 'follow-shot',
    authoredCamera: authored,
    reviewCamera: review,
  }), authored);
  assert.equal(resolveVisibleCamera({
    viewMode: 'review',
    authoredCamera: authored,
    reviewCamera: review,
  }), review);
});

test('rect union/intersect stay conservative for WM_PAINT coalescing', () => {
  const united = unionRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 8, y: 8, width: 10, height: 10 });
  assert.deepEqual(united, { x: 0, y: 0, width: 18, height: 18 });
  const hit = intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 8, y: 0, width: 10, height: 4 });
  assert.deepEqual(hit, { x: 8, y: 0, width: 2, height: 4 });
  const rects = [];
  absorbRect(rects, { x: 0, y: 0, width: 10, height: 10 });
  absorbRect(rects, { x: 20, y: 0, width: 10, height: 10 });
  assert.equal(rects.length, 2);
  absorbRect(rects, { x: 8, y: 0, width: 16, height: 10 });
  assert.equal(rects.length, 1);
  assert.deepEqual(rects[0], { x: 0, y: 0, width: 30, height: 10 });
});

test('a clean host update is a no-op and review mode does not re-seed', () => {
  const { host } = hostFixture();
  assert.equal(host.update(), false);

  let seeded = 0;
  const authored = {
    position: { x: 1, y: 2, z: 3 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    getWorldPosition(target) { return Object.assign(target, this.position); },
    getWorldDirection(target) { return Object.assign(target, { x: 0, y: 0, z: -1 }); },
  };
  const review = { position: { copy() { return this; } }, quaternion: { copy() { return this; } } };
  const session = createReviewSession({
    THREE: { Vector3: class { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } } },
    reviewCamera: review,
    controls: {
      target: { copy() { seeded += 1; return { addScaledVector() { return this; } }; } },
    },
  });
  session.setAuthoredCamera(authored);
  assert.equal(session.followShot(), 'follow-shot');
  session.enterReview({ seedFromAuthored: true });
  assert.equal(session.viewMode, 'review');
  assert.equal(seeded, 1);
  session.enterReview({ seedFromAuthored: true });
  session.setViewMode('review');
  assert.equal(seeded, 1, 'already reviewing must not re-seed the free camera');
});

test('editable Prompt fields and overlay chrome count as typing targets', () => {
  const overlay = { closest: selector => String(selector).includes('data-studio-overlay') ? overlay : null };
  const textarea = { tagName: 'TEXTAREA', closest: () => null };
  const canvas = { tagName: 'CANVAS', closest: () => null };
  assert.equal(isStudioOverlayEvent({ target: overlay }), true);
  assert.equal(isEditableStudioEvent({ target: overlay }), true);
  assert.equal(isEditableStudioEvent({ target: textarea }), true);
  assert.equal(isEditableStudioEvent({ target: canvas }), false);
});

test('clicking the viewport blurs Prompt fields and focuses the canvas', () => {
  const overlay = { closest: selector => String(selector).includes('data-studio-overlay') ? overlay : null };
  const textarea = {
    tagName: 'TEXTAREA',
    blurred: false,
    closest: () => null,
    blur() { this.blurred = true; },
  };
  const canvas = {
    tagName: 'CANVAS',
    focused: false,
    tabIndex: -1,
    closest: () => null,
    hasAttribute() { return false; },
    focus() { this.focused = true; },
  };
  const document = { activeElement: textarea };
  assert.equal(claimStudioViewportFocus({ target: overlay }, canvas, { document }), false);
  assert.equal(textarea.blurred, false);
  assert.equal(canvas.focused, false);
  assert.equal(claimStudioViewportFocus({ target: canvas }, canvas, { document }), true);
  assert.equal(textarea.blurred, true);
  assert.equal(canvas.focused, true);
  assert.equal(canvas.tabIndex, -1);
});
