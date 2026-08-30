import {
  absorbRect,
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

  isShown() {
    let node = this;
    while (node) {
      if (!node.visible) return false;
      node = node.parent;
    }
    return true;
  }

  setVisible(visible) {
    if (this.visible === visible) return;
    if (this.visible && this.isShown()) this.invalidate();
    this.visible = visible;
    if (this.visible && this.isShown()) this.invalidate();
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
    if (!this.isShown()) return;
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
 * Canvas host. Invalidations stay as separate clips unless they overlap.
 * Update() paints only those clips, like WinForms WM_PAINT.
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
    this.#rects = [];
    this.#scheduled = false;
    this.paintGeneration = 0;
    this.paintedRects = [];
  }

  #rects;
  #scheduled;
  #schedulePaint;

  get host() {
    return this;
  }

  invalidateRect(rect) {
    if (rectEmpty(rect)) return;
    absorbRect(this.#rects, rect);
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#schedulePaint(() => {
      this.#scheduled = false;
      this.update();
    });
  }

  copyRect(from, to) {
    if (rectEmpty(from) || rectEmpty(to) || from.width !== to.width || from.height !== to.height) return false;
    const ratio = this.backingRatio;
    const sx = Math.round(from.x * ratio);
    const sy = Math.round(from.y * ratio);
    const dx = Math.round(to.x * ratio);
    const dy = Math.round(to.y * ratio);
    const width = Math.max(1, Math.round(from.width * ratio));
    const height = Math.max(1, Math.round(from.height * ratio));
    const canvas = this.canvas;
    if (
      sx < 0 || sy < 0 || dx < 0 || dy < 0
      || sx + width > canvas.width
      || sy + height > canvas.height
      || dx + width > canvas.width
      || dy + height > canvas.height
    ) {
      return false;
    }
    const context = this.context;
    if (typeof context.getImageData !== 'function' || typeof context.putImageData !== 'function') return false;
    context.save?.();
    context.setTransform?.(1, 0, 0, 1, 0, 0);
    try {
      const pixels = context.getImageData(sx, sy, width, height);
      context.putImageData(pixels, dx, dy);
      return true;
    } catch {
      return false;
    } finally {
      context.restore?.();
    }
  }

  /** Paint each dirty clip. Returns false when nothing is dirty. */
  update() {
    if (this.#rects.length === 0 || !this.visible) {
      this.#rects = [];
      return false;
    }
    const rects = this.#rects;
    this.#rects = [];
    const context = this.context;
    let painted = false;
    for (const raw of rects) {
      const clip = intersectRect(raw, this.absoluteBounds);
      if (rectEmpty(clip)) continue;
      context.setTransform?.(this.backingRatio, 0, 0, this.backingRatio, 0, 0);
      context.save?.();
      clipContext(context, clip);
      this.paint(context, this.fonts, clip);
      context.restore?.();
      this.paintedRects.push(copyRect(clip));
      painted = true;
    }
    if (!painted) return false;
    this.paintGeneration += 1;
    if (this.paintedRects.length > 16) this.paintedRects.splice(0, this.paintedRects.length - 16);
    this.onPainted?.(this.paintedRects.at(-1), this.paintGeneration);
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
    this.#rects = [copyRect(this.absoluteBounds)];
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
    const bounds = this.absoluteBounds;
    const previous = this.tabs.findIndex(tab => tab.id === this.selected);
    this.selected = id;
    const next = this.tabs.findIndex(tab => tab.id === id);
    if (previous >= 0) {
      const rect = this.#tabRect(previous, bounds);
      this.invalidate(createRect(rect.x - bounds.x, rect.y - bounds.y, rect.width, rect.height));
    }
    if (next >= 0) {
      const rect = this.#tabRect(next, bounds);
      this.invalidate(createRect(rect.x - bounds.x, rect.y - bounds.y, rect.width, rect.height));
    } else this.invalidate();
    this.onChange?.(id);
  }

  #tabRect(index, bounds) {
    const width = bounds.width / Math.max(1, this.tabs.length);
    return createRect(bounds.x + (index * width), bounds.y, width, bounds.height);
  }

  onPaint(context, fonts, clip, bounds) {
    context.fillStyle = 'rgba(8, 13, 22, 0.92)';
    context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    this.tabs.forEach((tab, index) => {
      const rect = this.#tabRect(index, bounds);
      if (!rectsIntersect(rect, clip)) return;
      const active = tab.id === this.selected;
      context.fillStyle = active ? 'rgba(36, 58, 88, 0.92)' : 'rgba(12, 20, 32, 0.92)';
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
    const bounds = this.absoluteBounds;
    const previous = this.#thumb(bounds);
    this.value = next;
    const current = this.#thumb(bounds);
    const dirty = unionRect(previous, current);
    this.invalidate(createRect(dirty.x - bounds.x, dirty.y - bounds.y, dirty.width, dirty.height));
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

  setItems(itemCount, { followTail = false, invalidate = true } = {}) {
    const nextCount = Math.max(0, itemCount);
    const previousCount = this.itemCount;
    const previousScroll = this.scrollIndex;
    const previousMax = Math.max(0, previousCount - this.capacity);
    const atTail = followTail || previousScroll >= previousMax;
    this.itemCount = nextCount;
    const nextScroll = atTail ? this.maxScroll : Math.min(previousScroll, this.maxScroll);
    if (nextCount === previousCount && nextScroll === previousScroll) return false;
    if (!invalidate) {
      this.scrollIndex = nextScroll;
      return true;
    }
    if (previousCount > 0 && nextCount >= previousCount && nextScroll !== previousScroll) {
      this.scrollIndex = previousScroll;
      return this.setScrollIndex(nextScroll, { notify: false });
    }
    this.scrollIndex = nextScroll;
    this.invalidate();
    return true;
  }

  setScrollIndex(index, { notify = true } = {}) {
    const next = Math.min(this.maxScroll, Math.max(0, Math.round(index)));
    if (next === this.scrollIndex) return false;
    const steps = next - this.scrollIndex;
    this.scrollIndex = next;
    if (!this.#scrollExistingRows(steps)) this.invalidate();
    if (notify) this.onScroll?.(this.scrollIndex);
    return true;
  }

  #scrollExistingRows(steps) {
    if (steps === 0 || Math.abs(steps) >= this.capacity) return false;
    const host = this.host;
    const bounds = this.absoluteBounds;
    const distance = steps * this.itemHeight;
    const keepHeight = this.height - Math.abs(distance);
    if (!host?.copyRect || keepHeight <= 0 || bounds.width <= 0) return false;
    const from = steps > 0
      ? createRect(bounds.x, bounds.y + distance, bounds.width, keepHeight)
      : createRect(bounds.x, bounds.y, bounds.width, keepHeight);
    const to = steps > 0
      ? createRect(bounds.x, bounds.y, bounds.width, keepHeight)
      : createRect(bounds.x, bounds.y - distance, bounds.width, keepHeight);
    if (!host.copyRect(from, to)) return false;
    this.invalidate(steps > 0
      ? createRect(0, keepHeight, this.width, Math.abs(distance))
      : createRect(0, 0, this.width, Math.abs(distance)));
    return true;
  }

  invalidateFromIndex(index) {
    const first = Math.max(this.scrollIndex, Math.max(0, index));
    if (first >= this.scrollIndex + this.capacity) return;
    const y = (first - this.scrollIndex) * this.itemHeight;
    this.invalidate(createRect(0, y, this.width, this.height - y));
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

export class ToggleOption extends Control {
  constructor({ text = '', selected = false, onChange, ...rest } = {}) {
    super(rest);
    this.text = text;
    this.selected = selected;
    this.onChange = onChange;
  }

  setSelected(selected) {
    if (this.selected === selected) return;
    this.selected = selected;
    this.invalidate();
  }

  onPaint(context, fonts, clip, bounds) {
    const cy = bounds.y + (bounds.height * 0.5);
    const box = 12;
    const x = bounds.x + 6;
    const y = cy - (box * 0.5);
    context.fillStyle = this.selected ? 'rgba(36, 58, 88, 0.98)' : 'rgba(12, 20, 32, 0.0)';
    context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    context.fillStyle = this.selected ? '#7eb0e8' : '#4d6178';
    context.fillRect(x, y, box, box);
    if (!this.selected) {
      context.fillStyle = 'rgba(8, 13, 22, 0.96)';
      context.fillRect(x + 2, y + 2, box - 4, box - 4);
    } else {
      context.fillStyle = '#e8f1fb';
      context.fillRect(x + 3, y + 3, box - 6, box - 6);
    }
    fonts.blit(context, this.text, bounds.x + 24, cy + 4, {
      font: '13px "Segoe UI", Arial, sans-serif',
      fillStyle: this.selected ? '#e8f1fb' : '#9fb1c6',
      maxWidth: bounds.width - 32,
    });
    void clip;
  }

  onPointerDown() {
    this.setSelected(!this.selected);
    this.onChange?.(this.selected, this);
    return true;
  }
}

export function eventPoint(event) {
  if (Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)) {
    return { x: finite(event.clientX, 0), y: finite(event.clientY, 0) };
  }
  if (Number.isFinite(event?.offsetX) && Number.isFinite(event?.offsetY)) {
    return { x: finite(event.offsetX, 0), y: finite(event.offsetY, 0) };
  }
  return { x: -1, y: -1 };
}

export function isStudioOverlayEvent(event) {
  try {
    return Boolean(event?.target?.closest?.('[data-studio-overlay]'));
  } catch {
    return false;
  }
}

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isEditableNode(target) {
  if (!target || typeof target !== 'object') return false;
  try {
    if (target.closest?.('[data-studio-overlay]')) return true;
  } catch {
    // Synthetic events may not implement closest.
  }
  const tag = String(target.tagName || '').toUpperCase();
  if (EDITABLE_TAGS.has(tag)) return true;
  if (target.isContentEditable === true) return true;
  try {
    return Boolean(target.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
  } catch {
    return false;
  }
}

/** Prompt, HUD chrome, and other page fields must not drive the review camera. */
export function isEditableStudioEvent(event) {
  if (isEditableNode(event?.target)) return true;
  try {
    return isEditableNode(globalThis.document?.activeElement);
  } catch {
    return false;
  }
}

/**
 * Stock browsers do not move focus off a textarea when the WebGPU canvas is
 * clicked. Native Chromium often does. Blur overlay fields and focus the
 * viewport surface so Review keys and the caret follow the click.
 */
export function claimStudioViewportFocus(event, surface = null, { document: doc = globalThis.document } = {}) {
  if (isStudioOverlayEvent(event)) return false;
  const active = doc?.activeElement;
  if (isEditableNode(active) && active !== surface) {
    try {
      active.blur?.();
    } catch {
      // Synthetic controls may not implement blur.
    }
  }
  if (surface && typeof surface.focus === 'function') {
    try {
      if (!surface.hasAttribute?.('tabindex')) surface.tabIndex = -1;
    } catch {
      // Test surfaces may not support tabIndex.
    }
    try {
      surface.focus({ preventScroll: true });
    } catch {
      try {
        surface.focus();
      } catch {
        // The surface remains unfocused; overlay fields are already blurred.
      }
    }
  }
  return true;
}
