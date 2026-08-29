import { readFileSync } from 'node:fs';
import path from 'node:path';
import { StudioError } from './errors.mjs';
import { decodePngRgba } from './png-rgba.mjs';

export const STUDIO_OBJECT_ID_EVIDENCE_NAME = /^studio-\d+-objectid\.png$/;

export function encodeObjectId(index) {
  const value = Number(index);
  if (!Number.isInteger(value) || value < 0 || value > 0xFFFFFF) {
    throw new StudioError('invalid_object_id', 'Object-id index must be an integer from 0 to 16777215.');
  }
  return [value & 255, (value >> 8) & 255, (value >> 16) & 255];
}

export function encodeObjectIdRgb01(index) {
  return encodeObjectId(index).map(channel => channel / 255);
}

export function decodeObjectId(r, g, b) {
  return (Number(r) & 255) | ((Number(g) & 255) << 8) | ((Number(b) & 255) << 16);
}

export function sampleObjectId(rgba, width, height, x, y, entities = []) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
    return { objectId: null, entityId: null, occlusion: 'unknown' };
  }
  const offset = ((y * width) + x) * 4;
  const index = decodeObjectId(rgba[offset], rgba[offset + 1], rgba[offset + 2]);
  if (index === 0) {
    return { objectId: 0, entityId: null, occlusion: 'background' };
  }
  const hit = entities.find(entity => entity.index === index) ?? null;
  return {
    objectId: index,
    entityId: hit?.id ?? null,
    occlusion: 'visible',
  };
}

export function occlusionForExpected(sample, expectedEntityId) {
  if (!sample || sample.occlusion === 'unknown') return 'unknown';
  if (sample.occlusion === 'background') return 'background';
  if (!expectedEntityId) return 'visible';
  if (sample.entityId === expectedEntityId) return 'visible';
  return 'occluded';
}

export function loadObjectIdEvidence(meta, { studioRoot } = {}) {
  if (!meta?.path) return null;
  const resolved = path.resolve(meta.path);
  if (studioRoot) {
    const artifactsDir = path.resolve(studioRoot, 'artifacts');
    const relative = path.relative(artifactsDir, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new StudioError('object_id_evidence_path_invalid', 'Object-id evidence must stay inside the Studio artifacts directory.');
    }
  }
  if (!STUDIO_OBJECT_ID_EVIDENCE_NAME.test(path.basename(resolved))) {
    throw new StudioError('object_id_evidence_path_invalid', 'Object-id evidence must be a studio-<timestamp>-objectid.png capture.');
  }
  let bytes;
  try {
    bytes = readFileSync(resolved);
  } catch (error) {
    throw new StudioError('object_id_evidence_unreadable', `Could not read object-id evidence ${path.basename(resolved)}.`, {
      cause: error.message,
    });
  }
  const decoded = decodePngRgba(bytes);
  return {
    path: resolved,
    width: decoded.width,
    height: decoded.height,
    rgba: decoded.rgba,
    entities: Array.isArray(meta.entities) ? meta.entities : [],
  };
}
