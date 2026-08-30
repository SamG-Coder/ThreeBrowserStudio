import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { StudioError } from './errors.mjs';
import { loadObjectIdEvidence, sampleObjectId } from './object-id-evidence.mjs';
import { decodePngRgba } from './png-rgba.mjs';

export const STUDIO_EVIDENCE_NAME = /^studio-\d+(?:-raster)?\.png$/;
export const BEAUTY_EVIDENCE_LIMITS = Object.freeze({
  maxProbes: 32,
  maxChanged: 32,
});

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isObjectIdPath(filePath) {
  return typeof filePath === 'string' && path.basename(filePath).includes('-objectid');
}

function latestEvidencePaths(latestEvidence, { beautyOnly = false } = {}) {
  const paths = [];
  if (typeof latestEvidence?.path === 'string') paths.push(latestEvidence.path);
  for (const item of latestEvidence?.items ?? []) {
    if (item?.pass === 'objectId') continue;
    if (typeof item?.path === 'string') paths.push(item.path);
  }
  return beautyOnly ? paths.filter(entry => !isObjectIdPath(entry)) : paths.filter(entry => !isObjectIdPath(entry));
}

function latestObjectIdMeta(latestEvidence, requested) {
  if (requested) return { path: requested, entities: latestEvidence?.objectId?.entities ?? [] };
  if (latestEvidence?.objectId?.path) return latestEvidence.objectId;
  const item = (latestEvidence?.items ?? []).find(entry => entry?.pass === 'objectId' || isObjectIdPath(entry?.path));
  return item ?? null;
}

/**
 * Resolve a Studio beauty or explicit raster-preview PNG inside the session
 * artifacts directory. Object-id and material diagnostic passes stay excluded.
 */
export function resolveStudioEvidencePath(requested, {
  studioRoot,
  latestEvidence = null,
} = {}) {
  if (typeof studioRoot !== 'string' || studioRoot.length === 0) {
    throw new StudioError('beauty_evidence_unavailable', 'Studio root is required to read beauty evidence.');
  }
  const artifactsDir = path.resolve(studioRoot, 'artifacts');
  const allowedLatest = new Set(latestEvidencePaths(latestEvidence, { beautyOnly: true }).map(entry => path.resolve(entry)));
  let candidate;
  if (requested === undefined || requested === null || requested === '') {
    candidate = allowedLatest.size ? [...allowedLatest][0] : null;
  } else if (typeof requested !== 'string') {
    throw new StudioError('beauty_evidence_path_invalid', 'Evidence path must be a string.');
  } else if (path.isAbsolute(requested)) {
    candidate = path.resolve(requested);
  } else {
    const base = path.basename(requested);
    if (base !== requested.replaceAll('\\', '/').split('/').pop()) {
      throw new StudioError('beauty_evidence_path_invalid', 'Relative evidence paths must be a studio-*.png filename.');
    }
    candidate = path.resolve(artifactsDir, base);
  }
  if (!candidate) {
    throw new StudioError('beauty_evidence_unavailable', 'No beauty evidence is available. Render a WebGPU beauty first or pass evidence.path.');
  }
  const resolved = path.resolve(candidate);
  if (!STUDIO_EVIDENCE_NAME.test(path.basename(resolved))) {
    throw new StudioError('beauty_evidence_path_invalid', 'Beauty evidence must be a studio-<timestamp>.png capture.');
  }
  if (!pathIsInside(artifactsDir, resolved)) {
    throw new StudioError('beauty_evidence_path_invalid', 'Beauty evidence must stay inside the Studio artifacts directory.');
  }
  return resolved;
}

function pixelOffset(x, y, width) {
  return ((y * width) + x) * 4;
}

function samplePixel(rgba, width, height, x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
    throw new StudioError('beauty_probe_out_of_range', `Probe (${x}, ${y}) is outside ${width}x${height}.`, {
      x,
      y,
      width,
      height,
    });
  }
  const offset = pixelOffset(x, y, width);
  const r = rgba[offset];
  const g = rgba[offset + 1];
  const b = rgba[offset + 2];
  const a = rgba[offset + 3];
  const luma = (LUMA_R * r) + (LUMA_G * g) + (LUMA_B * b);
  return {
    x,
    y,
    rgba: [r, g, b, a],
    luma,
    clip: r === 0 || r === 255 || g === 0 || g === 255 || b === 0 || b === 255,
    black: r === 0 && g === 0 && b === 0,
  };
}

function accumulateStats(rgba, width, height, x0, y0, x1, y1) {
  let clipCount = 0;
  let blackCount = 0;
  let lumaTotal = 0;
  let pixels = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const sample = samplePixel(rgba, width, height, x, y);
      pixels += 1;
      lumaTotal += sample.luma;
      if (sample.clip) clipCount += 1;
      if (sample.black) blackCount += 1;
    }
  }
  return {
    pixelCount: pixels,
    clipCount,
    blackCount,
    meanLuma: pixels === 0 ? 0 : lumaTotal / pixels,
  };
}

function normalizeBbox(bbox, width, height) {
  if (!bbox) return { x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
  const x0 = Math.min(bbox.x0, bbox.x1);
  const x1 = Math.max(bbox.x0, bbox.x1);
  const y0 = Math.min(bbox.y0, bbox.y1);
  const y1 = Math.max(bbox.y0, bbox.y1);
  if (![x0, y0, x1, y1].every(Number.isInteger)) {
    throw new StudioError('beauty_bbox_invalid', 'Beauty bbox must contain integer pixel coordinates.');
  }
  if (x0 < 0 || y0 < 0 || x1 >= width || y1 >= height) {
    throw new StudioError('beauty_bbox_out_of_range', `Beauty bbox is outside ${width}x${height}.`);
  }
  return { x0, y0, x1, y1 };
}

function loadDecoded(filePath) {
  let bytes;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    throw new StudioError('beauty_evidence_unreadable', `Could not read beauty evidence ${path.basename(filePath)}.`, {
      cause: error.message,
    });
  }
  const decoded = decodePngRgba(bytes);
  return {
    path: filePath,
    fileHash: createHash('sha256').update(bytes).digest('hex'),
    pixelHash: createHash('sha256').update(decoded.rgba).digest('hex'),
    width: decoded.width,
    height: decoded.height,
    rgba: decoded.rgba,
    byteLength: bytes.length,
  };
}

function comparePixels(current, other, bbox, maxChanged) {
  if (current.width !== other.width || current.height !== other.height) {
    throw new StudioError(
      'beauty_compare_size_mismatch',
      `Cannot compare ${current.width}x${current.height} with ${other.width}x${other.height}.`,
    );
  }
  const region = normalizeBbox(bbox, current.width, current.height);
  let changedPixelCount = 0;
  let maxChannelDelta = 0;
  const changed = [];
  for (let y = region.y0; y <= region.y1; y += 1) {
    for (let x = region.x0; x <= region.x1; x += 1) {
      const offset = pixelOffset(x, y, current.width);
      let delta = 0;
      for (let channel = 0; channel < 4; channel += 1) {
        delta = Math.max(delta, Math.abs(current.rgba[offset + channel] - other.rgba[offset + channel]));
      }
      if (delta === 0) continue;
      changedPixelCount += 1;
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      if (changed.length < maxChanged) {
        changed.push({
          x,
          y,
          delta,
          rgba: [current.rgba[offset], current.rgba[offset + 1], current.rgba[offset + 2], current.rgba[offset + 3]],
          otherRgba: [other.rgba[offset], other.rgba[offset + 1], other.rgba[offset + 2], other.rgba[offset + 3]],
        });
      }
    }
  }
  return {
    comparePath: other.path,
    compareFileHash: other.fileHash,
    comparePixelHash: other.pixelHash,
    identical: current.pixelHash === other.pixelHash,
    regionIdentical: changedPixelCount === 0,
    changedPixelCount,
    maxChannelDelta,
    changed: changed.slice(0, maxChanged),
    changedTruncated: changedPixelCount > maxChanged,
  };
}

/** Hash, clip/black/luma stats, exact probes, optional bbox, and optional PNG diff. */
export function buildBeautyDigest({
  studioRoot,
  latestEvidence = null,
  evidence = {},
} = {}) {
  const filePath = resolveStudioEvidencePath(evidence.path, { studioRoot, latestEvidence });
  const decoded = loadDecoded(filePath);
  const bbox = evidence.bbox ? normalizeBbox(evidence.bbox, decoded.width, decoded.height) : null;
  const statsRegion = bbox ?? { x0: 0, y0: 0, x1: decoded.width - 1, y1: decoded.height - 1 };
  const stats = accumulateStats(decoded.rgba, decoded.width, decoded.height, statsRegion.x0, statsRegion.y0, statsRegion.x1, statsRegion.y1);
  const objectIdMeta = latestObjectIdMeta(latestEvidence, evidence.objectIdPath);
  let objectId = null;
  try {
    if (objectIdMeta?.path) objectId = loadObjectIdEvidence(objectIdMeta, { studioRoot });
  } catch {
    objectId = null;
  }
  const probes = (evidence.probes ?? []).map((probe, index) => {
    const sample = samplePixel(decoded.rgba, decoded.width, decoded.height, probe.x, probe.y);
    const hit = objectId
      ? sampleObjectId(objectId.rgba, objectId.width, objectId.height, probe.x, probe.y, objectId.entities)
      : null;
    return {
      name: probe.name ?? `probe-${index + 1}`,
      ...sample,
      ...(hit ? { entityId: hit.entityId, objectId: hit.objectId } : {}),
    };
  });
  let compare;
  if (evidence.comparePath) {
    const comparePath = resolveStudioEvidencePath(evidence.comparePath, { studioRoot, latestEvidence });
    compare = comparePixels(
      decoded,
      loadDecoded(comparePath),
      bbox,
      Math.min(BEAUTY_EVIDENCE_LIMITS.maxChanged, evidence.maxChanged ?? 16),
    );
  }
  return {
    path: decoded.path,
    fileHash: decoded.fileHash,
    pixelHash: decoded.pixelHash,
    width: decoded.width,
    height: decoded.height,
    byteLength: decoded.byteLength,
    ...(bbox ? { bbox } : {}),
    stats,
    probes,
    ...(compare ? { compare } : {}),
  };
}
