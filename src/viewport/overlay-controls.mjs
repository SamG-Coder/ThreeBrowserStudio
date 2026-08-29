import {
  copyRect,
  createRect,
  intersectRect,
  offsetRect,
  pointInRect,
  rectEmpty,
  rectsIntersect,
  unionRect,
} from './overlay-geometry.mjs';

function finite(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clipContext(context, clip) {
  if (!context || rectEmpty(clip)) return;
  context.beginPath?.();
  context.rect?.(clip.x, clip.y, clip.width, clip.height);
  context.clip?.();
}

/** Retained control. Painting is host-driven and clipped to the update region. */
export class Control {
  constructor({
    name = 'control',
    x = 0,
    y = 0,
    width = 0,
    height = 0,
    visible = true,
    enabled = true,
    backColor = null,
  } = {}) {
    this.name = name;
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.visible = visible;
    this.enabled = enabled;
    this.backColor = backColor;
    this.parent = null;
    this.children = [];
  }

  get host() {
    return this.parent?.host ?? null;
  }

  get absoluteBounds() {
    let x = this.x;
    let y = this.y;
    let node = this.parent;
    while (node) {
      x += node.x;
      y += node.y;
      node = node.parent;
    }
    return createRect(x, y, this.width, this.height);
  }

  add(child) {
    if (!child) return child;
    child.parent = this;
    this.children.push(child);
    this.invalidate();
    return child;
  }

  clear() {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.invalidate();
  }

  setBounds(x, y, width, height) {
    if (this.x === x && this.y === y && this.width === width && this.height === height) return;
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.performLayout();
    this.invalidate();
  }

  performLayout() {
    for (const child of this.children) child.performLayout();
  }

  invalidate(rect) {
    const bounds = this.absoluteBounds;
    const region = rect ? intersectRect(offsetRect(rect, bounds.x, bounds.y), bounds) : bounds;
    this.host?.invalidateRect(region);
  }

  paint(context, fonts, clip) {
    if (!this.visible) return;
    const bounds = this.absoluteBounds;
    const local = intersectRect(bounds, clip);
    if (rectEmpty(local)) return;
    this.onPaint(context, fonts, local, bounds);
    for (const child of this.children) child.paint(context, fonts, clip);
  }

  onPaint(context, fonts, clip, bounds) {
    if (!this.backColor) return;
    context.fillStyle = this.backColor;
    context.fillRect(clip.x, clip.y, clip.width, clip.height);
    void fonts;
    void bounds;
  }

  hitTest(x, y) {
    if (!this.visible || !this.enabled) return null;
    const bounds = this.absoluteBounds;
    if (!pointInRect(x, y, bounds)) return null;
    for (let index = this.children.length - 1; index >= 0; index -= 1) {
      const hit = this.children[index].hitTest(x, y);
      if (hit) return hit;
    }
    return this;
  }

  onPointerDown() { return false; }
  onPointerMove() { return false; }
  onPointerUp() { return false; }
  onWheel() { return false; }
}

/**
 * Canvas host. Invalidations coalesce into one update region; Update() paints
 * only that region, like WinForms WM_PAINT.
 */
export class OverlayHost extends Control {
  constructor({
    canvas,
    context,
    fonts,
    backingRatio = 1,
    schedulePaint,
    onPainted,
    backColor = null,
  } = {}) {
    super({ name: 'host', x: 0, y: 0, backColor });
    if (!canvas || !context) throw new TypeError('OverlayHost requires a 2D canvas context');
    if (!fonts) throw new TypeError('OverlayHost requires a font run cache');
    this.canvas = canvas;
    this.context = context;
    this.fonts = fonts;
    this.backingRatio = Math.max(1, finite(backingRatio, 1));
    this.#schedulePaint = typeof schedulePaint === 'function'
      ? schedulePaint
      : (callback => {
        const raf = globalThis.requestAnimationFrame;
        if (typeof raf === 'function') return raf.call(globalThis, callback);
        return queueMicrotask(callback);
      });
    this.onPainted = onPainted;
    this.#region = null;
    this.#scheduled = false;
    this.paintGeneration = 0;
    this.paintedRects = [];
  }

  #region;
  #scheduled;
  #schedulePaint;

  get host() {
    return this;
  }

  invalidateRect(rect) {
    if (rectEmpty(rect)) return;
    this.#region = this.#region ? unionRect(this.#region, rect) : copyRect(rect);
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#schedulePaint(() => {
      this.#scheduled = false;
      this.update();
    });
  }

  /** Paint the coalesced update region now. Returns false when nothing is dirty. */
  update() {
    if (rectEmpty(this.#region) || !this.visible) {
      this.#region = null;
      return false;
    }
    const clip = intersectRect(this.#region, this.absoluteBounds);
    this.#region = null;
    if (rectEmpty(clip)) return false;
    const context = this.context;
    context.setTransform?.(this.backingRatio, 0, 0, this.backingRatio, 0, 0);
    context.save?.();
    clipContext(context, clip);
    this.paint(context, this.fonts, clip);
    context.restore?.();
    this.paintGeneration += 1;
    this.paintedRects.push(copyRect(clip));
    if (this.paintedRects.length > 16) this.paintedRects.shift();
    this.onPainted?.(clip, this.paintGeneration);
    return true;
  }

  onPaint(context, fonts, clip) {
    context.clearRect(clip.x, clip.y, clip.width, clip.height);
    super.onPaint(context, fonts, clip, this.absoluteBounds);
  }

  setBacking(width, height, backingRatio) {
    const nextRatio = Math.max(1, finite(backingRatio, this.backingRatio));
    const nextWidth = Math.max(1, Math.round(width));
    const nextHeight = Math.max(1, Math.round(height));
    const nextCanvasWidth = Math.max(1, Math.round(nextWidth * nextRatio));
    const nextCanvasHeight = Math.max(1, Math.round(nextHeight * nextRatio));
    if (
      this.width === nextWidth
      && this.height === nextHeight
      && this.backingRatio === nextRatio
      && this.canvas.width === nextCanvasWidth
      && this.canvas.height === nextCanvasHeight
    ) {
      return false;
    }
    this.backingRatio = nextRatio;
    this.width = nextWidth;
    this.height = nextHeight;
    this.canvas.width = nextCanvasWidth;
    this.canvas.height = nextCanvasHeight;
    this.fonts.setScale?.(this.backingRatio);
    this.performLayout();
    this.#region = copyRect(this.absoluteBounds);
    return this.update();
  }
}

export class Label extends Control {
  constructor({ text = '', font, color = '#9fb1c6', align = 'left', ...rest } = {}) {
    super(rest);
    this.text = text;
    this.font = font ?? '13px "Segoe UI", Arial, sans-serif';
    this.color = color;
    this.align = align;
  }

  setText(text) {
    const next = String(text ?? '');
    if (next === this.text) return;
    this.text = next;
    this.invalidate();
  }

  onPaint(context, fonts, clip, bounds) {
    super.onPaint(context, fonts, clip, bounds);
    const maxWidth = Math.max(0, bounds.width - 4);
    const x = this.align === 'right' ? bounds.x + bounds.width - 2 : bounds.x + 2;
    fonts.blit(context, this.text, this.align === 'right' ? x - fonts.measure(context, this.text, this.font).width : x, bounds.y + bounds.height * 0.5 + 4, {
      font: this.font,
      fillStyle: this.color,
      maxWidth,
    });
  }
}

export class Button extends Control {
  constructor({ text = '', onClick, ...rest } = {}) {
    super({ backColor: rest.backColor ?? 'rgba(22, 34, 52, 0.96)', ...rest });
    this.text = text;
    this.onClick = onClick;
    this.pressed = false;
  }

  onPaint(context, fonts, clip, bounds) {
    context.fillStyle = this.pressed ? 'rgba(70, 110, 160, 0.95)' : this.backColor;
    context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    context.fillStyle = 'rgba(135, 176, 224, 0.28)';
    context.fillRect(bounds.x, bounds.y, bounds.width, 1);
    context.fillRect(bounds.x, bounds.y + bounds.height - 1, bounds.width, 1);
    fonts.blit(context, this.text, bounds.x + 8, bounds.y + bounds.height * 0.5 + 4, {
      font: '600 12px "Segoe UI", Arial, sans-serif',
      fillStyle: '#dce8f7',
      maxWidth: bounds.width - 16,
    });
    void clip;
  }

  onPointerDown() {
    this.pressed = true;
    this.invalidate();
    return true;
  }

  onPointerUp(event, { inside } = {}) {
    const wasPressed = this.pressed;
    this.pressed = false;
    this.invalidate();
    if (wasPressed && inside !== false) this.onClick?.(event, this);
    return true;
  }
}

export class TabStrip extends Control {
  constructor({ tabs = [], selected = tabs[0]?.id, onChange, ...rest } = {}) {
    super(rest);
    this.tabs = tabs;
    this.selected = selected;
    this.onChange = onChange;
  }

  setSelected(id) {
    if (this.selected === id) return;
    this.selected = id;
    this.invalidate();
    this.onChange?.(id);
  }

  #tabRect(index, bounds) {
    const width = bounds.width / Math.max(1, this.tabs.length);
    return createRect(bounds.x + (index * width), bounds.y, width, bounds.height);
  }

  onPaint(context, fonts, clip, bounds) {
    context.fillStyle = 'rgba(8, 13, 22, 0.96)';
    context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    this.tabs.forEach((tab, index) => {
      const rect = this.#tabRect(index, bounds);
      if (!rectsIntersect(rect, clip)) return;
      const active = tab.id === this.selected;
      context.fillStyle = active ? 'rgba(36, 58, 88, 0.98)' : 'rgba(12, 20, 32, 0.92)';
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
      fonts.blit(context, tab.label, rect.x + 12, rect.y + rect.height * 0.5 + 4, {
        font: active ? '600 13px "Segoe UI", Arial, sans-serif' : '13px "Segoe UI", Arial, sans-serif',
        fillStyle: active ? '#dce8f7' : '#7f94ad',
        maxWidth: rect.width - 24,
      });
      if (active) {
        context.fillStyle = '#7eb0e8';
        context.fillRect(rect.x + 10, rect.y + rect.height - 3, rect.width - 20, 2);
      }
    });
  }

  onPointerDown(event, { x, y }) {
    const bounds = this.absoluteBounds;
    const index = this.tabs.findIndex((_, tabIndex) => pointInRect(x, y, this.#tabRect(tabIndex, bounds)));
    if (index < 0) return false;
    this.setSelected(this.tabs[index].id);
    return true;
  }
}

export class ScrollBar extends Control {
  constructor({
    value = 0,
    minimum = 0,
    maximum = 0,
    viewportSize = 1,
    onScroll,
    ...rest
  } = {}) {
    super({ width: 10, ...rest });
    this.value = value;
    this.minimum = minimum;
    this.maximum = maximum;
    this.viewportSize = viewportSize;
    this.onScroll = onScroll;
    this.#dragging = false;
    this.#grab = 0;
  }

  #dragging;
  #grab;

  get range() {
    return Math.max(0, this.maximum - this.minimum);
  }

  #thumb(bounds) {
    const range = this.range;
    if (range <= 0 || bounds.height <= 8) return createRect(bounds.x, bounds.y, bounds.width, bounds.height);
    const track = Math.max(8, bounds.height);
    const thumbHeight = Math.max(18, (this.viewportSize / (this.viewportSize + range)) * track);
    const travel = Math.max(0, track - thumbHeight);
    const t = range === 0 ? 0 : (this.value - this.minimum) / range;
    return createRect(bounds.x + 1, bounds.y + (t * travel), Math.max(4, bounds.width - 2), thumbHeight);
  }

  setScroll(value, { notify = true } = {}) {
    const next = Math.min(this.maximum, Math.max(this.minimum, Math.round(value)));
    if (next === this.value) return false;
    this.value = next;
    this.invalidate();
    if (notify) this.onScroll?.(this.value);
    return true;
  }

  onPaint(context, fonts, clip, bounds) {
    if (this.range <= 0) return;
    context.fillStyle = 'rgba(12, 20, 32, 0.88)';
    context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    const thumb = this.#thumb(bounds);
    if (!rectsIntersect(thumb, clip)) return;
    context.fillStyle = '#6d8aab';
    context.fillRect(thumb.x, thumb.y, thumb.width, thumb.height);
    void fonts;
  }

  onPointerDown(event, { y }) {
    if (this.range <= 0) return false;
    const bounds = this.absoluteBounds;
    const thumb = this.#thumb(bounds);
    this.#dragging = true;
    this.#grab = pointInRect(bounds.x + 2, y, thumb) ? y - thumb.y : thumb.height * 0.5;
    if (!pointInRect(bounds.x + 2, y, thumb)) this.#scrollToY(y);
    return true;
  }

  onPointerMove(event, { y }) {
    if (!this.#dragging) return false;
    this.#scrollToY(y);
    return true;
  }

  onPointerUp() {
    this.#dragging = false;
    return true;
  }

  #scrollToY(y) {
    const bounds = this.absoluteBounds;
    const thumb = this.#thumb(bounds);
    const travel = Math.max(1, bounds.height - thumb.height);
    const t = Math.min(1, Math.max(0, (y - bounds.y - this.#grab) / travel));
    this.setScroll(this.minimum + (t * this.range));
  }
}

export class VirtualList extends Control {
  constructor({
    itemHeight = 40,
    itemCount = 0,
    scrollIndex = 0,
    paintItem,
    onActivate,
    ...rest
  } = {}) {
    super({ backColor: rest.backColor ?? 'rgba(8, 13, 22, 0.92)', ...rest });
    this.itemHeight = itemHeight;
    this.itemCount = itemCount;
    this.scrollIndex = scrollIndex;
    this.paintItem = paintItem;
    this.onActivate = onActivate;
  }

  get capacity() {
    return Math.max(1, Math.floor(this.height / this.itemHeight));
  }

  get maxScroll() {
    return Math.max(0, this.itemCount - this.capacity);
  }

  setItems(itemCount, { followTail = false } = {}) {
    const atTail = followTail || this.scrollIndex >= this.maxScroll;
    this.itemCount = Math.max(0, itemCount);
    this.scrollIndex = atTail ? this.maxScroll : Math.min(this.scrollIndex, this.maxScroll);
    this.invalidate();
  }

  setScrollIndex(index, { notify = true } = {}) {
    const next = Math.min(this.maxScroll, Math.max(0, Math.round(index)));
    if (next === this.scrollIndex) return false;
    this.scrollIndex = next;
    this.invalidate();
    if (notify) this.onScroll?.(this.scrollIndex);
    return true;
  }

  invalidateItem(index) {
    if (!Number.isInteger(index) || index < this.scrollIndex || index >= this.scrollIndex + this.capacity) return;
    const bounds = this.absoluteBounds;
    this.invalidate(createRect(0, (index - this.scrollIndex) * this.itemHeight, this.width, this.itemHeight));
    void bounds;
  }

  rowBounds(index) {
    const bounds = this.absoluteBounds;
    return createRect(bounds.x, bounds.y + ((index - this.scrollIndex) * this.itemHeight), bounds.width, this.itemHeight);
  }

  onPaint(context, fonts, clip, bounds) {
    super.onPaint(context, fonts, clip, bounds);
    const last = Math.min(this.itemCount, this.scrollIndex + this.capacity);
    for (let index = this.scrollIndex; index < last; index += 1) {
      const row = this.rowBounds(index);
      const local = intersectRect(row, clip);
      if (rectEmpty(local)) continue;
      this.paintItem?.(context, fonts, {
        index,
        bounds: row,
        clip: local,
      });
    }
  }

  onWheel(event, { delta }) {
    if (this.maxScroll <= 0 || delta === 0) return false;
    const steps = Math.max(1, Math.ceil(Math.abs(delta) / this.itemHeight));
    return this.setScrollIndex(this.scrollIndex + (delta > 0 ? steps : -steps));
  }

  onPointerDown(event, { y }) {
    const bounds = this.absoluteBounds;
    const index = this.scrollIndex + Math.floor((y - bounds.y) / this.itemHeight);
    if (!Number.isInteger(index) || index < 0 || index >= this.itemCount) return false;
    this.onActivate?.(index, { y, event });
    return true;
  }
}

export class RadioOption extends Control {
  constructor({ text = '', selected = false, onSelect, ...rest } = {}) {
    super(rest);
    this.text = text;
    this.selected = selected;
    this.onSelect = onSelect;
  }

  setSelected(selected) {
    if (this.selected === selected) return;
    this.selected = selected;
    this.invalidate();
  }

  onPaint(context, fonts, clip, bounds) {
    context.fillStyle = this.selected ? 'rgba(36, 58, 88, 0.98)' : 'rgba(12, 20, 32, 0.0)';
    context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    context.fillStyle = this.selected ? '#7eb0e8' : '#4d6178';
    context.beginPath?.();
    const cy = bounds.y + (bounds.height * 0.5);
    const cx = bounds.x + 12;
    context.arc?.(cx, cy, 5, 0, Math.PI * 2);
    context.fill?.();
    if (!this.selected) {
      context.fillStyle = 'rgba(8, 13, 22, 0.96)';
      context.beginPath?.();
      context.arc?.(cx, cy, 3, 0, Math.PI * 2);
      context.fill?.();
    }
    fonts.blit(context, this.text, bounds.x + 24, cy + 4, {
      font: '13px "Segoe UI", Arial, sans-serif',
      fillStyle: this.selected ? '#e8f1fb' : '#9fb1c6',
      maxWidth: bounds.width - 32,
    });
    void clip;
  }

  onPointerDown() {
    this.onSelect?.(this);
    return true;
  }
}

export function eventPoint(event) {
  if (Number.isFinite(event?.offsetX) && Number.isFinite(event?.offsetY)) {
    return { x: finite(event.offsetX, 0), y: finite(event.offsetY, 0) };
  }
  return { x: finite(event?.clientX, -1), y: finite(event?.clientY, -1) };
}
