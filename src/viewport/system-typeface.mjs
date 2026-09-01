import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function readU16(view, offset) {
  return view.getUint16(offset, false);
}

function readI16(view, offset) {
  return view.getInt16(offset, false);
}

function readU32(view, offset) {
  return view.getUint32(offset, false);
}

function tableDirectory(view) {
  const count = readU16(view, 4);
  const tables = new Map();
  for (let index = 0; index < count; index += 1) {
    const base = 12 + index * 16;
    const tag = String.fromCharCode(
      view.getUint8(base),
      view.getUint8(base + 1),
      view.getUint8(base + 2),
      view.getUint8(base + 3),
    );
    tables.set(tag, { offset: readU32(view, base + 8), length: readU32(view, base + 12) });
  }
  return tables;
}

function parseCmapFormat4(view, offset) {
  const segCount = readU16(view, offset + 6) / 2;
  let cursor = offset + 14;
  const endCode = [];
  for (let index = 0; index < segCount; index += 1) {
    endCode.push(readU16(view, cursor));
    cursor += 2;
  }
  cursor += 2;
  const startCode = [];
  for (let index = 0; index < segCount; index += 1) {
    startCode.push(readU16(view, cursor));
    cursor += 2;
  }
  const idDelta = [];
  for (let index = 0; index < segCount; index += 1) {
    idDelta.push(readI16(view, cursor));
    cursor += 2;
  }
  const idRangeOffsetBase = cursor;
  const idRangeOffset = [];
  for (let index = 0; index < segCount; index += 1) {
    idRangeOffset.push(readU16(view, cursor));
    cursor += 2;
  }
  return codepoint => {
    for (let index = 0; index < segCount; index += 1) {
      if (codepoint < startCode[index] || codepoint > endCode[index]) continue;
      if (idRangeOffset[index] === 0) return (codepoint + idDelta[index]) & 0xffff;
      const glyphOffset = idRangeOffsetBase + index * 2 + idRangeOffset[index]
        + (codepoint - startCode[index]) * 2;
      const glyphId = readU16(view, glyphOffset);
      if (glyphId === 0) return 0;
      return (glyphId + idDelta[index]) & 0xffff;
    }
    return 0;
  };
}

function parseCmap(view, table) {
  const tableOffset = table.offset;
  const numTables = readU16(view, tableOffset + 2);
  let format4 = null;
  for (let index = 0; index < numTables; index += 1) {
    const record = tableOffset + 4 + index * 8;
    const subOffset = tableOffset + readU32(view, record + 4);
    if (readU16(view, subOffset) === 4) format4 = parseCmapFormat4(view, subOffset);
  }
  if (!format4) throw new Error('TrueType cmap format 4 is required');
  return format4;
}

function readGlyphPoints(view, offset, numberOfContours) {
  const endPts = [];
  let cursor = offset;
  for (let index = 0; index < numberOfContours; index += 1) {
    endPts.push(readU16(view, cursor));
    cursor += 2;
  }
  const instructionLength = readU16(view, cursor);
  cursor += 2 + instructionLength;
  const pointCount = endPts[endPts.length - 1] + 1;
  const flags = [];
  for (let index = 0; index < pointCount;) {
    const flag = view.getUint8(cursor);
    cursor += 1;
    flags.push(flag);
    index += 1;
    if (flag & 0x08) {
      const repeat = view.getUint8(cursor);
      cursor += 1;
      for (let count = 0; count < repeat; count += 1) {
        flags.push(flag);
        index += 1;
      }
    }
  }
  const xs = [];
  let x = 0;
  for (const flag of flags) {
    if (flag & 0x02) {
      const value = view.getUint8(cursor);
      cursor += 1;
      x += flag & 0x10 ? value : -value;
    } else if (!(flag & 0x10)) {
      x += readI16(view, cursor);
      cursor += 2;
    }
    xs.push(x);
  }
  const ys = [];
  let y = 0;
  for (const flag of flags) {
    if (flag & 0x04) {
      const value = view.getUint8(cursor);
      cursor += 1;
      y += flag & 0x20 ? value : -value;
    } else if (!(flag & 0x20)) {
      y += readI16(view, cursor);
      cursor += 2;
    }
    ys.push(y);
  }
  const points = flags.map((flag, index) => ({
    x: xs[index],
    y: ys[index],
    on: (flag & 0x01) !== 0,
  }));
  const contours = [];
  let start = 0;
  for (const end of endPts) {
    contours.push(points.slice(start, end + 1));
    start = end + 1;
  }
  return contours;
}

function readCompositeContours(view, offset, readGlyph) {
  const contours = [];
  let cursor = offset;
  let flags = 0;
  do {
    flags = readU16(view, cursor);
    const glyphIndex = readU16(view, cursor + 2);
    cursor += 4;
    let arg1;
    let arg2;
    if (flags & 0x0001) {
      arg1 = readI16(view, cursor);
      arg2 = readI16(view, cursor + 2);
      cursor += 4;
    } else {
      arg1 = view.getInt8(cursor);
      arg2 = view.getInt8(cursor + 1);
      cursor += 2;
    }
    let xx = 1;
    let xy = 0;
    let yx = 0;
    let yy = 1;
    if (flags & 0x0008) {
      xx = yy = readI16(view, cursor) / 0x4000;
      cursor += 2;
    } else if (flags & 0x0040) {
      xx = readI16(view, cursor) / 0x4000;
      yy = readI16(view, cursor + 2) / 0x4000;
      cursor += 4;
    } else if (flags & 0x0080) {
      xx = readI16(view, cursor) / 0x4000;
      xy = readI16(view, cursor + 2) / 0x4000;
      yx = readI16(view, cursor + 4) / 0x4000;
      yy = readI16(view, cursor + 6) / 0x4000;
      cursor += 8;
    }
    const child = readGlyph(glyphIndex);
    const dx = flags & 0x0002 ? arg1 : 0;
    const dy = flags & 0x0002 ? arg2 : 0;
    for (const contour of child.contours) {
      contours.push(contour.map(point => ({
        x: point.x * xx + point.y * yx + dx,
        y: point.x * xy + point.y * yy + dy,
        on: point.on,
      })));
    }
  } while (flags & 0x0020);
  return contours;
}

function emitContour(context, points, originX, originY, scale) {
  if (points.length === 0) return;
  const mapped = points.map(point => ({
    x: originX + point.x * scale,
    y: originY - point.y * scale,
    on: point.on,
  }));
  const start = mapped[0].on
    ? mapped[0]
    : {
        x: (mapped[0].x + mapped[mapped.length - 1].x) * 0.5,
        y: (mapped[0].y + mapped[mapped.length - 1].y) * 0.5,
        on: true,
      };
  context.moveTo(start.x, start.y);
  let previous = start;
  for (let index = mapped[0].on ? 1 : 0; index < mapped.length; index += 1) {
    const current = mapped[index];
    const next = mapped[(index + 1) % mapped.length];
    if (current.on) {
      context.lineTo(current.x, current.y);
      previous = current;
      continue;
    }
    const end = next.on
      ? next
      : { x: (current.x + next.x) * 0.5, y: (current.y + next.y) * 0.5 };
    context.quadraticCurveTo(current.x, current.y, end.x, end.y);
    previous = end;
    if (next.on) index += 1;
  }
  if (previous.x !== start.x || previous.y !== start.y) context.lineTo(start.x, start.y);
  context.closePath();
}

function candidateFontPaths() {
  const windows = process.env.WINDIR || 'C:\\Windows';
  return [
    path.join(windows, 'Fonts', 'segoeui.ttf'),
    path.join(windows, 'Fonts', 'segoeuisl.ttf'),
    path.join(windows, 'Fonts', 'arial.ttf'),
    path.join(windows, 'Fonts', 'calibri.ttf'),
    path.join(windows, 'Fonts', 'tahoma.ttf'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  ];
}

export function loadSystemTypeface({
  readFile = readFileSync,
  exists = existsSync,
  paths = candidateFontPaths(),
} = {}) {
  const filePath = paths.find(candidate => {
    try {
      return exists(candidate);
    } catch {
      return false;
    }
  });
  if (!filePath) return null;
  const buffer = readFile(filePath);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const tables = tableDirectory(view);
  const required = ['cmap', 'head', 'hhea', 'hmtx', 'loca', 'glyf', 'maxp'];
  if (required.some(tag => !tables.has(tag))) return null;

  const head = tables.get('head').offset;
  const unitsPerEm = readU16(view, head + 18);
  const indexToLocFormat = readI16(view, head + 50);
  const hhea = tables.get('hhea').offset;
  const ascender = readI16(view, hhea + 4);
  const descender = readI16(view, hhea + 6);
  const numberOfHMetrics = readU16(view, hhea + 34);
  const numGlyphs = readU16(view, tables.get('maxp').offset + 4);
  const locaOffset = tables.get('loca').offset;
  const glyfOffset = tables.get('glyf').offset;
  const hmtxOffset = tables.get('hmtx').offset;
  const glyphIndexFor = parseCmap(view, tables.get('cmap'));
  const glyphCache = new Map();

  function glyphOffset(index) {
    if (indexToLocFormat === 0) return glyfOffset + readU16(view, locaOffset + index * 2) * 2;
    return glyfOffset + readU32(view, locaOffset + index * 4);
  }

  function advanceFor(index) {
    if (index < numberOfHMetrics) return readU16(view, hmtxOffset + index * 4);
    return readU16(view, hmtxOffset + (numberOfHMetrics - 1) * 4);
  }

  function readGlyph(index) {
    if (glyphCache.has(index)) return glyphCache.get(index);
    const offset = glyphOffset(index);
    const next = glyphOffset(index + 1);
    if (index >= numGlyphs || next <= offset) {
      const empty = Object.freeze({ contours: Object.freeze([]), advance: advanceFor(index) });
      glyphCache.set(index, empty);
      return empty;
    }
    const numberOfContours = readI16(view, offset);
    const contours = numberOfContours >= 0
      ? readGlyphPoints(view, offset + 10, numberOfContours)
      : readCompositeContours(view, offset + 10, readGlyph);
    const glyph = Object.freeze({
      contours: Object.freeze(contours.map(contour => Object.freeze(contour.map(point => Object.freeze(point))))),
      advance: advanceFor(index),
    });
    glyphCache.set(index, glyph);
    return glyph;
  }

  return Object.freeze({
    filePath,
    unitsPerEm,
    get ascent() { return ascender; },
    get descent() { return descender; },
    measure(text, fontSize) {
      const scale = fontSize / unitsPerEm;
      let width = 0;
      for (const character of String(text ?? '')) {
        width += readGlyph(glyphIndexFor(character.codePointAt(0))).advance * scale;
      }
      return width;
    },
    metrics(fontSize) {
      const scale = fontSize / unitsPerEm;
      return {
        width: 0,
        ascent: Math.max(1, ascender * scale),
        descent: Math.max(0, -descender * scale),
      };
    },
    addTextPath(context, text, x, y, fontSize, maxWidth) {
      const scale = fontSize / unitsPerEm;
      let cursor = x;
      for (const character of String(text ?? '')) {
        const glyph = readGlyph(glyphIndexFor(character.codePointAt(0)));
        const advance = glyph.advance * scale;
        if (Number.isFinite(maxWidth) && cursor + advance - x > maxWidth) break;
        for (const contour of glyph.contours) emitContour(context, contour, cursor, y, scale);
        cursor += advance;
      }
      return cursor - x;
    },
  });
}

let cached = undefined;

export function getSystemTypeface() {
  if (cached !== undefined) return cached;
  try {
    cached = loadSystemTypeface();
  } catch {
    cached = null;
  }
  return cached;
}
