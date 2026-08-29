import assert from 'node:assert/strict';
import test from 'node:test';

import { loadSystemTypeface } from '../src/viewport/system-typeface.mjs';
import { createFontRunCache } from '../src/viewport/overlay-fonts.mjs';

class FakeContext {
  constructor() {
    this.ops = [];
    this.fillStyle = '';
    this.font = '';
  }

  setTransform() {}
  beginPath() { this.ops.push('begin'); }
  moveTo(x, y) { this.ops.push(['M', x, y]); }
  lineTo(x, y) { this.ops.push(['L', x, y]); }
  quadraticCurveTo(cx, cy, x, y) { this.ops.push(['Q', cx, cy, x, y]); }
  closePath() { this.ops.push('Z'); }
  fill() { this.ops.push('fill'); }
  fillText() { this.ops.push('bitmap'); }
  measureText(text) { return { width: String(text).length * 7 }; }
}

class FakeCanvas {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.context = new FakeContext();
  }

  getContext() { return this.context; }
}

test('system typeface measures real outlines when a TTF is available', () => {
  const face = loadSystemTypeface();
  if (!face) {
    assert.equal(face, null);
    return;
  }
  const wide = face.measure('MMMM', 16);
  const narrow = face.measure('iiii', 16);
  assert.ok(wide > narrow, 'M should be wider than i in a real font');
  const context = new FakeContext();
  context.beginPath();
  face.addTextPath(context, 'A', 0, 16, 16);
  assert.equal(context.ops.includes('fill'), false);
  assert.ok(context.ops.some(op => Array.isArray(op) && op[0] === 'M'));
  assert.ok(context.ops.includes('Z'));
});

test('font cache uses outlines instead of the native 5x7 fillText bitmap', () => {
  const face = loadSystemTypeface();
  const canvas = new FakeCanvas();
  const fonts = createFontRunCache({
    createCanvas: () => new FakeCanvas(),
    typeface: face,
  });
  fonts.blit(canvas.context, 'Studio', 0, 12, { font: '13px sans-serif', fillStyle: '#fff' });
  if (face) {
    assert.equal(fonts.usesOutlines, true);
    assert.equal(canvas.context.ops.includes('bitmap'), false);
  }
});
