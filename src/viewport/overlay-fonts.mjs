import { getSystemTypeface } from './system-typeface.mjs';

const DEFAULT_MAX_RUNS = 256;
const DEFAULT_MAX_MEASURES = 512;

function finite(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function runKey(font, fillStyle, text, maxWidth, scale) {
  return `${scale}\0${font}\0${fillStyle}\0${maxWidth ?? ''}\0${text}`;
}

function parseFontSize(font) {
  const match = String(font ?? '').match(/(\d+(?:\.\d+)?)px/);
  return Math.max(8, finite(match?.[1], 13));
}

function drawText(context, typeface, text, font, fillStyle, maxWidth) {
  context.fillStyle = fillStyle;
  context.textBaseline = 'alphabetic';
  context.textAlign = 'left';
  if (typeface) {
    const size = parseFontSize(font);
    const metrics = typeface.metrics(size);
    context.beginPath?.();
    typeface.addTextPath(context, text, 1, metrics.ascent + 1, size, maxWidth);
    context.fill?.();
    return;
  }
  context.font = font;
  context.fillText(text, 1, parseFontSize(font) * 0.8 + 1, maxWidth);
}

/**
 * Rasterizes system-font outlines into cached 2D runs. Native fillText is a
 * 5x7 bitmap; outlines go through the coverage rasterizer instead.
 */
export function createFontRunCache({
  createCanvas,
  typeface = getSystemTypeface(),
  maxRuns = DEFAULT_MAX_RUNS,
  maxMeasures = DEFAULT_MAX_MEASURES,
} = {}) {
  if (typeof createCanvas !== 'function') {
    throw new TypeError('createFontRunCache requires createCanvas()');
  }
  const measures = new Map();
  const runs = new Map();
  const measureOrder = [];
  const runOrder = [];
  let blitCount = 0;
  let rasterCount = 0;
  let scale = 1;

  function evict(map, order, limit) {
    while (map.size > limit && order.length > 0) {
      const key = order.shift();
      map.delete(key);
    }
  }

  function touch(order, key) {
    const index = order.indexOf(key);
    if (index >= 0) order.splice(index, 1);
    order.push(key);
  }

  function measure(context, text, font) {
    const value = String(text ?? '');
    const key = `${font}\0${value}`;
    const cached = measures.get(key);
    if (cached) {
      touch(measureOrder, key);
      return cached;
    }
    const size = parseFontSize(font);
    let result;
    if (typeface) {
      const metrics = typeface.metrics(size);
      result = Object.freeze({
        width: Math.max(0, typeface.measure(value, size)),
        ascent: metrics.ascent,
        descent: metrics.descent,
      });
    } else {
      if (context) context.font = font;
      const metrics = context?.measureText?.(value) ?? { width: value.length * 7 };
      result = Object.freeze({
        width: Math.max(0, finite(metrics.width, value.length * 7)),
        ascent: Math.max(1, finite(metrics.actualBoundingBoxAscent, size * 0.8)),
        descent: Math.max(0, finite(metrics.actualBoundingBoxDescent, size * 0.2)),
      });
    }
    measures.set(key, result);
    touch(measureOrder, key);
    evict(measures, measureOrder, maxMeasures);
    return result;
  }

  function rasterize(text, font, fillStyle, maxWidth, backingScale = scale) {
    const value = String(text ?? '');
    const ratio = Math.max(1, finite(backingScale, 1));
    const key = runKey(font, fillStyle, value, maxWidth, ratio);
    const cached = runs.get(key);
    if (cached) {
      touch(runOrder, key);
      return cached;
    }
    const canvas = createCanvas();
    const context = canvas.getContext?.('2d', { alpha: true });
    if (!context) throw new Error('Font cache requires a 2D canvas context');
    const metrics = measure(context, value, font);
    const cssWidth = Math.max(1, Math.ceil(maxWidth == null ? metrics.width + 2 : Math.min(metrics.width, maxWidth) + 2));
    const cssHeight = Math.max(1, Math.ceil(metrics.ascent + metrics.descent + 2));
    canvas.width = Math.max(1, Math.ceil(cssWidth * ratio));
    canvas.height = Math.max(1, Math.ceil(cssHeight * ratio));
    context.setTransform?.(ratio, 0, 0, ratio, 0, 0);
    context.imageSmoothingEnabled = true;
    if (context.imageSmoothingQuality !== undefined) context.imageSmoothingQuality = 'high';
    drawText(context, typeface, value, font, fillStyle, maxWidth);
    const run = Object.freeze({
      canvas,
      width: cssWidth,
      height: cssHeight,
      ascent: metrics.ascent + 1,
      scale: ratio,
      text: value,
    });
    runs.set(key, run);
    touch(runOrder, key);
    evict(runs, runOrder, maxRuns);
    rasterCount += 1;
    return run;
  }

  function blit(dest, text, x, y, { font, fillStyle, maxWidth, scale: blitScale } = {}) {
    if (!dest) return null;
    const run = rasterize(text, font, fillStyle, maxWidth, blitScale ?? scale);
    dest.drawImage?.(run.canvas, x, y - run.ascent, run.width, run.height);
    blitCount += 1;
    return run;
  }

  return Object.freeze({
    measure,
    blit,
    rasterize,
    setScale(value) {
      scale = Math.max(1, finite(value, 1));
      return scale;
    },
    get scale() { return scale; },
    get usesOutlines() { return Boolean(typeface); },
    get size() { return runs.size; },
    get blitCount() { return blitCount; },
    get rasterCount() { return rasterCount; },
    clear() {
      measures.clear();
      runs.clear();
      measureOrder.length = 0;
      runOrder.length = 0;
    },
  });
}
