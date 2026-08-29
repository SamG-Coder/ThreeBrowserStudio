export function createRect(x = 0, y = 0, width = 0, height = 0) {
  return {
    x: Number(x) || 0,
    y: Number(y) || 0,
    width: Math.max(0, Number(width) || 0),
    height: Math.max(0, Number(height) || 0),
  };
}

export function copyRect(rect) {
  return createRect(rect?.x, rect?.y, rect?.width, rect?.height);
}

export function rectEmpty(rect) {
  return !rect || rect.width <= 0 || rect.height <= 0;
}

export function rectsIntersect(a, b) {
  if (rectEmpty(a) || rectEmpty(b)) return false;
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

export function intersectRect(a, b) {
  if (!rectsIntersect(a, b)) return createRect(0, 0, 0, 0);
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return createRect(x, y, Math.min(a.x + a.width, b.x + b.width) - x, Math.min(a.y + a.height, b.y + b.height) - y);
}

export function unionRect(a, b) {
  if (rectEmpty(a)) return copyRect(b);
  if (rectEmpty(b)) return copyRect(a);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return createRect(
    x,
    y,
    Math.max(a.x + a.width, b.x + b.width) - x,
    Math.max(a.y + a.height, b.y + b.height) - y,
  );
}

export function offsetRect(rect, dx, dy) {
  return createRect((rect?.x ?? 0) + (dx || 0), (rect?.y ?? 0) + (dy || 0), rect?.width, rect?.height);
}

export function absorbRect(rects, next) {
  if (rectEmpty(next)) return rects;
  const incoming = copyRect(next);
  for (let index = 0; index < rects.length; index += 1) {
    if (!rectsIntersect(rects[index], incoming)) continue;
    const merged = unionRect(rects[index], incoming);
    rects.splice(index, 1);
    return absorbRect(rects, merged);
  }
  rects.push(incoming);
  return rects;
}

export function pointInRect(x, y, rect) {
  return !rectEmpty(rect)
    && x >= rect.x
    && y >= rect.y
    && x < rect.x + rect.width
    && y < rect.y + rect.height;
}
