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
    clipChildren = false,
  } = {}) {
    this.name = name;
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.visible = visible;
    this.enabled = enabled;
    this.backColor = backColor;
    this.clipChildren = clipChildren;
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

  setEnabled(enabled) {
    const next = enabled === true;
    if (this.enabled === next) return false;
    this.enabled = next;
    this.invalidate();
    return true;
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
    let region = rect ? intersectRect(offsetRect(rect, bounds.x, bounds.y), bounds) : bounds;
    let ancestor = this.parent;
    while (ancestor && !rectEmpty(region)) {
      if (ancestor.clipChildren) region = intersectRect(region, ancestor.absoluteBounds);
      ancestor = ancestor.parent;
    }
    if (rectEmpty(region)) return;
    this.host?.invalidateRect(region);
  }

  paint(context, fonts, clip) {
    if (!this.visible) return;
    const bounds = this.absoluteBounds;
    const local = intersectRect(bounds, clip);
    if (rectEmpty(local)) return;
    this.onPaint(context, fonts, local, bounds);
    if (!this.clipChildren) {
      for (const child of this.children) child.paint(context, fonts, clip);
      return;
    }
    context.save?.();
    clipContext(context, local);
    for (const child of this.children) child.paint(context, fonts, local);
    context.restore?.();
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
    const bounded = intersectRect(rect, this.absoluteBounds);
    if (rectEmpty(bounded)) return;
    absorbRect(this.#rects, bounded);
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

function wrapLabelLines(text, fonts, context, font, maxWidth, maxLines) {
  const measure = value => fonts.measure(context, value, font).width;
  const lines = [];
  const pushBrokenWord = word => {
    let remaining = word;
    while (remaining && lines.length < maxLines) {
      let end = 1;
      while (end < remaining.length && measure(remaining.slice(0, end + 1)) <= maxWidth) end += 1;
      lines.push(remaining.slice(0, end));
      remaining = remaining.slice(end);
    }
  };
  for (const paragraph of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (lines.length >= maxLines) break;
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of paragraph.trim().split(/\s+/)) {
      const candidate = current ? `${current} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) {
        lines.push(current);
        current = '';
        if (lines.length >= maxLines) break;
      }
      if (measure(word) <= maxWidth) current = word;
      else pushBrokenWord(word);
      if (lines.length >= maxLines) break;
    }
    if (current && lines.length < maxLines) lines.push(current);
  }
  const source = String(text ?? '').replace(/\s+/g, ' ').trim();
  const rendered = lines.join(' ').trim();
  if (source.length > rendered.length && lines.length > 0) {
    let last = lines.length - 1;
    let value = lines[last];
    while (value && measure(`${value}…`) > maxWidth) value = value.slice(0, -1);
    lines[last] = `${value.trimEnd()}…`;
  }
  return lines.slice(0, maxLines);
}

/** Retained bounded word-wrapped status text; never horizontally scales glyphs. */
export class WrappedLabel extends Label {
  constructor({ maxLines = 3, lineHeight = 16, padding = 2, ...rest } = {}) {
    super(rest);
    this.maxLines = Math.max(1, Math.floor(maxLines));
    this.lineHeight = Math.max(10, Number(lineHeight) || 16);
    this.padding = Math.max(0, Number(padding) || 0);
  }

  onPaint(context, fonts, clip, bounds) {
    Control.prototype.onPaint.call(this, context, fonts, clip, bounds);
    const maxWidth = Math.max(1, bounds.width - (this.padding * 2));
    const capacity = Math.max(1, Math.min(this.maxLines, Math.floor((bounds.height - this.padding) / this.lineHeight)));
    const lines = wrapLabelLines(this.text, fonts, context, this.font, maxWidth, capacity);
    for (let index = 0; index < lines.length; index += 1) {
      fonts.blit(context, lines[index], bounds.x + this.padding, bounds.y + this.padding + 12 + (index * this.lineHeight), {
        font: this.font,
        fillStyle: this.color,
      });
    }
  }
}

export class Button extends Control {
  constructor({ text = '', onClick, centered = false, ...rest } = {}) {
    super({ backColor: rest.backColor ?? 'rgba(22, 34, 52, 0.96)', ...rest });
    this.text = text;
    this.onClick = onClick;
    this.centered = centered === true;
    this.pressed = false;
  }

  onPaint(context, fonts, clip, bounds) {
    context.fillStyle = this.pressed ? 'rgba(70, 110, 160, 0.95)' : this.backColor;
    context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    context.fillStyle = 'rgba(135, 176, 224, 0.28)';
    context.fillRect(bounds.x, bounds.y, bounds.width, 1);
    context.fillRect(bounds.x, bounds.y + bounds.height - 1, bounds.width, 1);
    const font = '600 12px "Segoe UI", Arial, sans-serif';
    const textWidth = this.centered ? fonts.measure(context, this.text, font).width : 0;
    fonts.blit(context, this.text, this.centered ? bounds.x + Math.max(0, (bounds.width - textWidth) * 0.5) : bounds.x + 8, bounds.y + bounds.height * 0.5 + 4, {
      font,
      fillStyle: '#dce8f7',
      maxWidth: this.centered ? bounds.width - 4 : bounds.width - 16,
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

/**
 * Retained tool window/dialog chrome shared by the native and browser hosts.
 * It deliberately mirrors a small WinForms Form surface: title bar, close
 * action, client area, modal state, and an explicit close result.
 */
export class ToolWindow extends Control {
  constructor({ title = 'Window', closable = true, modal = false, onClose, ...rest } = {}) {
    super({
      backColor: rest.backColor ?? 'rgba(11, 19, 30, 0.98)',
      clipChildren: true,
      ...rest,
    });
    this.title = String(title);
    this.closable = closable !== false;
    this.modal = modal === true;
    this.onClose = onClose;
    this.dialogResult = null;
    this.titleLabel = this.add(new Label({
      name: `${this.name}-title`, text: this.title, color: '#dce8f7', font: '600 13px "Segoe UI", Arial, sans-serif',
    }));
    this.closeButton = this.add(new Button({
      name: `${this.name}-close`, text: 'Close', centered: true,
      visible: this.closable,
      onClick: () => this.close('cancel'),
    }));
    this.content = this.add(new Control({
      name: `${this.name}-content`, backColor: 'rgba(0, 0, 0, 0)', clipChildren: true,
    }));
  }

  setTitle(title) {
    const next = String(title ?? 'Window');
    if (next === this.title) return false;
    this.title = next;
    this.titleLabel.setText(next);
    return true;
  }

  open({ modal = this.modal } = {}) {
    this.modal = modal === true;
    this.dialogResult = null;
    this.setVisible(true);
    return this;
  }

  showDialog() { return this.open({ modal: true }); }

  close(result = 'cancel') {
    if (!this.visible) return false;
    this.dialogResult = result;
    this.setVisible(false);
    this.onClose?.(result, this);
    return true;
  }

  performLayout() {
    const titleHeight = 34;
    this.titleLabel?.setBounds(10, 8, Math.max(20, this.width - (this.closable ? 78 : 20)), 20);
    this.closeButton?.setBounds(Math.max(4, this.width - 62), 4, 56, 26);
    this.closeButton?.setVisible(this.closable);
    this.content?.setBounds(0, titleHeight, this.width, Math.max(0, this.height - titleHeight));
    this.content?.performLayout();
  }

  onPaint(context, fonts, clip, bounds) {
    super.onPaint(context, fonts, clip, bounds);
    context.fillStyle = 'rgba(41, 65, 94, 0.96)';
    context.fillRect(bounds.x, bounds.y, bounds.width, 34);
    context.fillStyle = 'rgba(135, 176, 224, 0.42)';
    context.fillRect(bounds.x, bounds.y, bounds.width, 1);
    context.fillRect(bounds.x, bounds.y + bounds.height - 1, bounds.width, 1);
    context.fillRect(bounds.x, bounds.y, 1, bounds.height);
    context.fillRect(bounds.x + bounds.width - 1, bounds.y, 1, bounds.height);
  }
}

export class TextInput extends Control {
  constructor({
    text = '',
    placeholder = '',
    maximumLength = 1200,
    multiline = false,
    readClipboardText,
    writeClipboardText,
    onChange,
    onSubmit,
    onFocusChange,
    ...rest
  } = {}) {
    super({ backColor: rest.backColor ?? 'rgba(10, 18, 29, 0.98)', ...rest });
    this.text = this.#normalize(text).slice(0, maximumLength);
    this.placeholder = String(placeholder ?? '');
    this.maximumLength = maximumLength;
    this.multiline = multiline === true;
    this.readClipboardText = readClipboardText;
    this.writeClipboardText = writeClipboardText;
    this.onChange = onChange;
    this.onSubmit = onSubmit;
    this.onFocusChange = onFocusChange;
    this.focused = false;
    this.cursor = this.text.length;
    this.anchor = this.cursor;
    this.scrollLine = 0;
    this.preferredColumn = null;
    this.undoStack = [];
    this.redoStack = [];
    this.dragging = false;
    this.lastFonts = null;
  }

  #normalize(value) {
    return String(value ?? '').replace(/\r\n?/g, '\n');
  }

  get selectionStart() { return Math.min(this.anchor, this.cursor); }
  get selectionEnd() { return Math.max(this.anchor, this.cursor); }
  get selectedText() { return this.text.slice(this.selectionStart, this.selectionEnd); }

  #recordUndo() {
    const previous = this.undoStack.at(-1);
    if (!previous || previous.text !== this.text || previous.cursor !== this.cursor || previous.anchor !== this.anchor) {
      this.undoStack.push({ text: this.text, cursor: this.cursor, anchor: this.anchor });
      if (this.undoStack.length > 100) this.undoStack.shift();
    }
    this.redoStack = [];
  }

  #restore(stack, destination) {
    const state = stack.pop();
    if (!state) return false;
    destination.push({ text: this.text, cursor: this.cursor, anchor: this.anchor });
    this.text = state.text;
    this.cursor = state.cursor;
    this.anchor = state.anchor;
    this.preferredColumn = null;
    this.#ensureCaretVisible();
    this.invalidate();
    this.onChange?.(this.text, this);
    return true;
  }

  #replaceSelection(value) {
    const insertion = this.#normalize(value);
    const start = this.selectionStart;
    const end = this.selectionEnd;
    const capacity = this.maximumLength - (this.text.length - (end - start));
    const accepted = insertion.slice(0, Math.max(0, capacity));
    if (start === end && accepted.length === 0) return false;
    this.#recordUndo();
    this.text = `${this.text.slice(0, start)}${accepted}${this.text.slice(end)}`;
    this.cursor = start + accepted.length;
    this.anchor = this.cursor;
    this.preferredColumn = null;
    this.#ensureCaretVisible();
    this.invalidate();
    this.onChange?.(this.text, this);
    return true;
  }

  #deleteRange(start, end) {
    if (end <= start) return false;
    this.anchor = Math.max(0, start);
    this.cursor = Math.min(this.text.length, end);
    return this.#replaceSelection('');
  }

  #wordBoundary(index, direction) {
    let cursor = Math.max(0, Math.min(this.text.length, index));
    const isWord = value => /[\p{L}\p{N}_]/u.test(value ?? '');
    if (direction < 0) {
      while (cursor > 0 && !isWord(this.text[cursor - 1])) cursor -= 1;
      while (cursor > 0 && isWord(this.text[cursor - 1])) cursor -= 1;
      return cursor;
    }
    while (cursor < this.text.length && !isWord(this.text[cursor])) cursor += 1;
    while (cursor < this.text.length && isWord(this.text[cursor])) cursor += 1;
    return cursor;
  }

  #lineColumn(index = this.cursor) {
    const before = this.text.slice(0, index);
    const row = before.split('\n').length - 1;
    const lineStart = before.lastIndexOf('\n') + 1;
    return { row, column: index - lineStart, lineStart };
  }

  #indexAtLineColumn(row, column) {
    const lines = this.text.split('\n');
    const targetRow = Math.max(0, Math.min(lines.length - 1, row));
    let index = 0;
    for (let line = 0; line < targetRow; line += 1) index += lines[line].length + 1;
    return index + Math.min(lines[targetRow].length, Math.max(0, column));
  }

  #move(next, extend = false) {
    const bounded = Math.max(0, Math.min(this.text.length, next));
    this.cursor = bounded;
    if (!extend) this.anchor = bounded;
    this.#ensureCaretVisible();
    this.invalidate();
  }

  #visualLines(bounds = this.absoluteBounds) {
    const available = Math.max(1, bounds.width - 16);
    const estimatedColumns = this.multiline ? Math.max(1, Math.floor(available / 7.2)) : Number.POSITIVE_INFINITY;
    const result = [];
    let offset = 0;
    for (const logical of this.text.split('\n')) {
      if (logical.length === 0) result.push({ text: '', start: offset, end: offset });
      else {
        for (let start = 0; start < logical.length; start += estimatedColumns) {
          const text = logical.slice(start, start + estimatedColumns);
          result.push({ text, start: offset + start, end: offset + start + text.length });
        }
      }
      offset += logical.length + 1;
    }
    return result.length > 0 ? result : [{ text: '', start: 0, end: 0 }];
  }

  #caretVisualLine(lines) {
    let match = lines.length - 1;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (this.cursor >= line.start && this.cursor <= line.end) {
        match = index;
        if (this.cursor === line.end && index + 1 < lines.length && lines[index + 1].start === this.cursor) continue;
        break;
      }
    }
    return match;
  }

  #ensureCaretVisible() {
    const lines = this.#visualLines();
    const caretLine = this.#caretVisualLine(lines);
    const capacity = Math.max(1, Math.floor((this.height - 12) / 18));
    if (caretLine < this.scrollLine) this.scrollLine = caretLine;
    if (caretLine >= this.scrollLine + capacity) this.scrollLine = caretLine - capacity + 1;
    this.scrollLine = Math.max(0, Math.min(this.scrollLine, Math.max(0, lines.length - capacity)));
  }

  #indexFromPoint(point) {
    const bounds = this.absoluteBounds;
    const lines = this.#visualLines(bounds);
    const row = Math.max(0, Math.min(lines.length - 1, this.scrollLine + Math.floor((point.y - bounds.y - 6) / 18)));
    const line = lines[row];
    const localX = Math.max(0, point.x - bounds.x - 8);
    if (!this.lastFonts) return line.start + Math.min(line.text.length, Math.round(localX / 7.2));
    let best = 0;
    let distance = Number.POSITIVE_INFINITY;
    for (let column = 0; column <= line.text.length; column += 1) {
      const width = this.lastFonts.measure(null, line.text.slice(0, column), '13px "Segoe UI", Arial, sans-serif').width;
      const nextDistance = Math.abs(width - localX);
      if (nextDistance < distance) {
        best = column;
        distance = nextDistance;
      }
    }
    return line.start + best;
  }

  setFocused(focused) {
    const next = focused === true;
    if (next === this.focused) return false;
    this.focused = next;
    this.invalidate();
    this.onFocusChange?.(next, this);
    return true;
  }

  setText(text, { notify = false } = {}) {
    const next = this.#normalize(text).slice(0, this.maximumLength);
    if (next === this.text) return false;
    this.text = next;
    this.cursor = Math.min(this.cursor, next.length);
    this.anchor = Math.min(this.anchor, next.length);
    this.undoStack = [];
    this.redoStack = [];
    this.#ensureCaretVisible();
    this.invalidate();
    if (notify) this.onChange?.(next, this);
    return true;
  }

  onPaint(context, fonts, clip, bounds) {
    this.lastFonts = fonts;
    context.fillStyle = this.backColor;
    context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    context.fillStyle = this.focused ? '#7eb0e8' : 'rgba(135, 176, 224, 0.34)';
    context.fillRect(bounds.x, bounds.y, bounds.width, 1);
    context.fillRect(bounds.x, bounds.y + bounds.height - 1, bounds.width, 1);
    context.fillRect(bounds.x, bounds.y, 1, bounds.height);
    context.fillRect(bounds.x + bounds.width - 1, bounds.y, 1, bounds.height);
    const font = '13px "Segoe UI", Arial, sans-serif';
    if (!this.text) {
      fonts.blit(context, this.placeholder, bounds.x + 8, bounds.y + 22, {
        font,
        fillStyle: '#667c94',
        maxWidth: bounds.width - 16,
      });
      if (this.focused) {
        context.fillStyle = '#b9d8f6';
        context.fillRect(bounds.x + 8, bounds.y + 7, 1, 16);
      }
      return;
    }
    const lines = this.#visualLines(bounds);
    const capacity = Math.max(1, Math.floor((bounds.height - 12) / 18));
    const visibleLines = lines.slice(this.scrollLine, this.scrollLine + capacity);
    for (let row = 0; row < visibleLines.length; row += 1) {
      const line = visibleLines[row];
      const y = bounds.y + 18 + (row * 18);
      const selectionStart = Math.max(line.start, this.selectionStart);
      const selectionEnd = Math.min(line.end, this.selectionEnd);
      if (selectionEnd > selectionStart) {
        const before = line.text.slice(0, selectionStart - line.start);
        const selected = line.text.slice(selectionStart - line.start, selectionEnd - line.start);
        const x = bounds.x + 8 + fonts.measure(context, before, font).width;
        const width = Math.max(2, fonts.measure(context, selected, font).width);
        context.fillStyle = 'rgba(74, 126, 186, 0.62)';
        context.fillRect(x, y - 14, width, 17);
      }
      fonts.blit(context, line.text.replaceAll('\t', '    '), bounds.x + 8, y, {
        font,
        fillStyle: '#dce8f7',
        maxWidth: bounds.width - 16,
      });
    }
    if (this.focused) {
      const caretLineIndex = this.#caretVisualLine(lines);
      if (caretLineIndex >= this.scrollLine && caretLineIndex < this.scrollLine + capacity) {
        const line = lines[caretLineIndex];
        const before = line.text.slice(0, Math.max(0, this.cursor - line.start));
        const x = Math.min(bounds.x + bounds.width - 9, bounds.x + 8 + fonts.measure(context, before, font).width);
        const y = bounds.y + 5 + ((caretLineIndex - this.scrollLine) * 18);
        context.fillStyle = '#b9d8f6';
        context.fillRect(x, y, 1, 16);
      }
    }
    void clip;
  }

  onPointerDown(event, point) {
    this.setFocused(true);
    const index = point ? this.#indexFromPoint(point) : this.cursor;
    if (event?.detail >= 2) {
      this.anchor = this.#wordBoundary(index, -1);
      this.cursor = this.#wordBoundary(index, 1);
    } else {
      this.cursor = index;
      this.anchor = event?.shiftKey ? this.anchor : index;
    }
    this.dragging = true;
    this.#ensureCaretVisible();
    this.invalidate();
    return true;
  }

  onPointerMove(event, point) {
    if (!this.dragging || !point) return false;
    this.cursor = this.#indexFromPoint(point);
    this.#ensureCaretVisible();
    this.invalidate();
    void event;
    return true;
  }

  onPointerUp() {
    this.dragging = false;
    return true;
  }

  handleKey(event) {
    if (!this.focused) return false;
    const command = event?.ctrlKey || event?.metaKey;
    const extend = event?.shiftKey === true;
    const key = String(event?.key ?? '');
    if (event.key === 'Escape') {
      this.setFocused(false);
      return true;
    }
    if (command && key.toLowerCase() === 'a') {
      this.anchor = 0;
      this.cursor = this.text.length;
      this.#ensureCaretVisible();
      this.invalidate();
      return true;
    }
    if (command && key.toLowerCase() === 'c') {
      if (this.selectedText) void this.writeClipboardText?.(this.selectedText);
      return true;
    }
    if (command && key.toLowerCase() === 'x') {
      if (this.selectedText) {
        void this.writeClipboardText?.(this.selectedText);
        this.#replaceSelection('');
      }
      return true;
    }
    if (command && key.toLowerCase() === 'v') {
      if (typeof this.readClipboardText === 'function') {
        void Promise.resolve(this.readClipboardText()).then(value => {
          if (this.focused && value != null) this.#replaceSelection(value);
        }).catch(() => {});
      }
      return true;
    }
    if (command && key.toLowerCase() === 'z') {
      this.#restore(extend ? this.redoStack : this.undoStack, extend ? this.undoStack : this.redoStack);
      return true;
    }
    if (command && key.toLowerCase() === 'y') {
      this.#restore(this.redoStack, this.undoStack);
      return true;
    }
    if (key === 'Enter' && (!this.multiline || command)) {
      this.onSubmit?.(this.text, this);
      return true;
    }
    if (key === 'Enter') return this.#replaceSelection('\n');
    if (key === 'Tab') return this.#replaceSelection('    ');
    if (key === 'Backspace') {
      if (this.selectionStart !== this.selectionEnd) this.#replaceSelection('');
      else if (this.cursor > 0) this.#deleteRange(command ? this.#wordBoundary(this.cursor, -1) : this.cursor - 1, this.cursor);
      return true;
    }
    if (key === 'Delete') {
      if (this.selectionStart !== this.selectionEnd) this.#replaceSelection('');
      else if (this.cursor < this.text.length) this.#deleteRange(this.cursor, command ? this.#wordBoundary(this.cursor, 1) : this.cursor + 1);
      return true;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const direction = key === 'ArrowLeft' ? -1 : 1;
      if (!extend && this.selectionStart !== this.selectionEnd) {
        this.#move(direction < 0 ? this.selectionStart : this.selectionEnd, false);
      } else {
        this.#move(command ? this.#wordBoundary(this.cursor, direction) : this.cursor + direction, extend);
      }
      this.preferredColumn = null;
      return true;
    }
    if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'PageUp' || key === 'PageDown') {
      const { row, column } = this.#lineColumn();
      if (this.preferredColumn == null) this.preferredColumn = column;
      const page = Math.max(1, Math.floor((this.height - 12) / 18));
      const delta = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : key === 'PageUp' ? -page : page;
      this.#move(this.#indexAtLineColumn(row + delta, this.preferredColumn), extend);
      return true;
    }
    if (key === 'Home' || key === 'End') {
      const { row, lineStart } = this.#lineColumn();
      const next = command
        ? key === 'Home' ? 0 : this.text.length
        : key === 'Home' ? lineStart : this.#indexAtLineColumn(row, Number.POSITIVE_INFINITY);
      this.#move(next, extend);
      this.preferredColumn = null;
      return true;
    }
    if (!command && !event?.altKey && key.length === 1) {
      const shifted = event?.shiftKey === true && /^[a-z]$/.test(key)
        ? key.toUpperCase()
        : event?.shiftKey === true
          ? ({
              '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
              '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
              '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|',
              ';': ':', "'": '"', ',': '<', '.': '>', '/': '?', '`': '~',
            }[key] ?? key)
          : key;
      this.#replaceSelection(shifted);
      return true;
    }
    // Focused text controls own every key even when it has no editing action.
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
    context.fillStyle = 'rgba(0, 0, 0, 0)';
    context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    this.tabs.forEach((tab, index) => {
      const rect = this.#tabRect(index, bounds);
      if (!rectsIntersect(rect, clip)) return;
      const active = tab.id === this.selected;
      context.fillStyle = 'rgba(0, 0, 0, 0)';
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

/** Pixel-scrolled retained content clipped to a fixed viewport. */
export class ScrollPanel extends Control {
  constructor({
    value = 0,
    contentHeight = 0,
    onScroll,
    ...rest
  } = {}) {
    super({ clipChildren: true, ...rest });
    this.value = Math.max(0, Math.round(finite(value, 0)));
    this.#wheelPosition = this.value;
    this.contentHeight = Math.max(0, Math.round(finite(contentHeight, 0)));
    this.onScroll = onScroll;
    this.content = Control.prototype.add.call(this, new Control({
      name: `${this.name}-content`,
    }));
  }

  #wheelPosition;

  get maxScroll() {
    return Math.max(0, this.contentHeight - this.height);
  }

  addContent(child) {
    return this.content.add(child);
  }

  setContentHeight(value) {
    const next = Math.max(0, Math.round(finite(value, 0)));
    if (next === this.contentHeight) return false;
    this.contentHeight = next;
    this.value = Math.min(this.value, this.maxScroll);
    this.#wheelPosition = this.value;
    this.#layoutContent();
    this.invalidate();
    return true;
  }

  setScroll(value, { notify = true } = {}) {
    const next = Math.min(this.maxScroll, Math.max(0, Math.round(finite(value, this.value))));
    this.#wheelPosition = next;
    if (next === this.value) return false;
    this.value = next;
    this.content.y = -this.value;
    this.invalidate();
    if (notify) this.onScroll?.(this.value);
    return true;
  }

  performLayout() {
    this.value = Math.min(this.value, this.maxScroll);
    this.#wheelPosition = this.value;
    this.#layoutContent();
  }

  #layoutContent() {
    this.content.x = 0;
    this.content.y = -this.value;
    this.content.width = this.width;
    this.content.height = Math.max(this.height, this.contentHeight);
    this.content.performLayout();
  }

  onWheel(event, { delta }) {
    if (this.maxScroll <= 0 || delta === 0) return false;
    const boundedDelta = Math.max(-this.height * 0.9, Math.min(this.height * 0.9, delta));
    const position = Math.min(this.maxScroll, Math.max(0, this.#wheelPosition + boundedDelta));
    this.#wheelPosition = position;
    const next = Math.round(position);
    if (next !== this.value) {
      this.value = next;
      this.content.y = -this.value;
      this.invalidate();
      this.onScroll?.(this.value);
    }
    return true;
  }
}

function quantizedRangeValue(value, minimum, maximum, step) {
  const clamped = Math.min(maximum, Math.max(minimum, finite(value, minimum)));
  if (!(step > 0)) return clamped;
  const steps = Math.round((clamped - minimum) / step);
  const result = minimum + (steps * step);
  const precision = Math.min(12, Math.max(0, String(step).split('.')[1]?.length ?? 0));
  return Math.min(maximum, Math.max(minimum, Number(result.toFixed(precision))));
}

/** Canvas range input. Dragging previews locally and commits once on release. */
export class RangeOption extends Control {
  constructor({
    text = '',
    value = 0,
    minimum = 0,
    maximum = 1,
    step = 0,
    curve = 1,
    scale = 'linear',
    formatValue,
    onChange,
    ...rest
  } = {}) {
    super(rest);
    this.text = text;
    this.minimum = finite(minimum, 0);
    this.maximum = finite(maximum, 1);
    if (!(this.maximum > this.minimum)) throw new RangeError('RangeOption maximum must exceed minimum.');
    this.step = Math.max(0, finite(step, 0));
    this.curve = Math.max(0.01, finite(curve, 1));
    this.scale = scale === 'log' ? 'log' : 'linear';
    if (this.scale === 'log' && !(this.minimum > 0)) {
      throw new RangeError('A logarithmic RangeOption requires a positive minimum.');
    }
    this.formatValue = typeof formatValue === 'function' ? formatValue : valueToFormat => String(valueToFormat);
    this.onChange = onChange;
    this.value = quantizedRangeValue(value, this.minimum, this.maximum, this.step);
    this.#dragging = false;
    this.#committedValue = this.value;
  }

  #dragging;
  #committedValue;

  get interacting() {
    return this.#dragging;
  }

  setValue(value, { notify = false } = {}) {
    const next = quantizedRangeValue(value, this.minimum, this.maximum, this.step);
    if (Object.is(next, this.value)) return false;
    this.value = next;
    this.invalidate();
    if (notify) this.onChange?.(this.value, this);
    return true;
  }

  #fraction() {
    if (this.scale === 'log') {
      return Math.log(this.value / this.minimum) / Math.log(this.maximum / this.minimum);
    }
    const normalized = (this.value - this.minimum) / (this.maximum - this.minimum);
    return Math.pow(Math.min(1, Math.max(0, normalized)), 1 / this.curve);
  }

  #valueAt(x) {
    const bounds = this.absoluteBounds;
    const left = bounds.x + 8;
    const width = Math.max(1, bounds.width - 16);
    const fraction = Math.min(1, Math.max(0, (x - left) / width));
    if (this.scale === 'log') {
      return this.minimum * Math.pow(this.maximum / this.minimum, fraction);
    }
    return this.minimum + ((this.maximum - this.minimum) * Math.pow(fraction, this.curve));
  }

  onPaint(context, fonts, clip, bounds) {
    super.onPaint(context, fonts, clip, bounds);
    const enabled = this.enabled;
    const valueText = this.formatValue(this.value);
    fonts.blit(context, this.text, bounds.x + 4, bounds.y + 13, {
      font: '12px "Segoe UI", Arial, sans-serif',
      fillStyle: enabled ? '#9fb1c6' : '#596b80',
      maxWidth: Math.max(20, bounds.width - 92),
    });
    const measured = fonts.measure(context, valueText, '12px "Cascadia Mono", Consolas, monospace').width;
    fonts.blit(context, valueText, bounds.x + bounds.width - measured - 4, bounds.y + 13, {
      font: '12px "Cascadia Mono", Consolas, monospace',
      fillStyle: enabled ? '#dce8f7' : '#596b80',
      maxWidth: 84,
    });
    const left = bounds.x + 8;
    const width = Math.max(1, bounds.width - 16);
    const y = bounds.y + bounds.height - 9;
    context.fillStyle = enabled ? '#31455d' : '#202d3d';
    context.fillRect(left, y, width, 3);
    const filled = Math.round(width * this.#fraction());
    context.fillStyle = enabled ? '#7eb0e8' : '#40536a';
    context.fillRect(left, y, filled, 3);
    context.fillRect(left + Math.max(0, filled - 2), y - 4, 5, 11);
  }

  onPointerDown(event, { x }) {
    this.#dragging = true;
    this.#committedValue = this.value;
    this.setValue(this.#valueAt(x));
    return true;
  }

  onPointerMove(event, { x }) {
    if (!this.#dragging) return false;
    this.setValue(this.#valueAt(x));
    return true;
  }

  onPointerUp(event, { x } = {}) {
    if (!this.#dragging) return false;
    if (Number.isFinite(x)) this.setValue(this.#valueAt(x));
    this.#dragging = false;
    if (!Object.is(this.value, this.#committedValue)) this.onChange?.(this.value, this);
    return true;
  }
}

export class VirtualList extends Control {
  constructor({
    itemHeight = 40,
    itemCount = 0,
    scrollIndex = 0,
    paintItem,
    onActivate,
    reusePixels = true,
    ...rest
  } = {}) {
    super({ backColor: rest.backColor ?? 'rgba(8, 13, 22, 0.92)', ...rest });
    this.itemHeight = itemHeight;
    this.itemCount = itemCount;
    this.scrollIndex = scrollIndex;
    this.paintItem = paintItem;
    this.onActivate = onActivate;
    this.reusePixels = reusePixels !== false;
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
    if (!this.reusePixels || !this.#scrollExistingRows(steps)) this.invalidate();
    if (notify) this.onScroll?.(this.scrollIndex);
    return true;
  }

  #scrollExistingRows(steps) {
    if (steps === 0 || Math.abs(steps) >= this.capacity) return false;
    const host = this.host;
    const bounds = this.absoluteBounds;
    const distance = steps * this.itemHeight;
    // Only full painted rows may be copied. The list can have a fractional
    // remainder when its viewport is not an exact multiple of itemHeight.
    const paintedHeight = Math.min(this.height, this.capacity * this.itemHeight);
    const keepHeight = paintedHeight - Math.abs(distance);
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

  onPointerDown(event, { x, y }) {
    const bounds = this.absoluteBounds;
    const index = this.scrollIndex + Math.floor((y - bounds.y) / this.itemHeight);
    if (!Number.isInteger(index) || index < 0 || index >= this.itemCount) return false;
    this.onActivate?.(index, { x, y, event });
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
