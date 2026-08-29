import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildBeautyDigest,
  encodeObjectId,
  encodePngRgba,
  resolveStudioEvidencePath,
} from '../src/core/index.mjs';

function rgbaFill(width, height, rgba) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels.set(rgba, index * 4);
  }
  return pixels;
}

function paint(pixels, width, x, y, rgba) {
  pixels.set(rgba, ((y * width) + x) * 4);
}

async function withArtifacts(t) {
  const studioRoot = await mkdtemp(path.join(os.tmpdir(), 'beauty-evidence-'));
  const artifacts = path.join(studioRoot, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  t.after(async () => {
    await rm(studioRoot, { recursive: true, force: true });
  });
  return { studioRoot, artifacts };
}

test('beauty digest hashes pixels, probes clips, and diffs another capture', async (t) => {
  const { studioRoot, artifacts } = await withArtifacts(t);
  const firstPixels = rgbaFill(4, 2, [10, 20, 30, 255]);
  paint(firstPixels, 4, 3, 1, [255, 0, 0, 255]);
  const secondPixels = Buffer.from(firstPixels);
  paint(secondPixels, 4, 0, 0, [0, 0, 0, 255]);
  await writeFile(path.join(artifacts, 'studio-100.png'), encodePngRgba(4, 2, firstPixels));
  await writeFile(path.join(artifacts, 'studio-200.png'), encodePngRgba(4, 2, secondPixels));

  const digest = buildBeautyDigest({
    studioRoot,
    evidence: {
      path: 'studio-100.png',
      comparePath: 'studio-200.png',
      probes: [{ name: 'clip', x: 3, y: 1 }, { name: 'mid', x: 1, y: 0 }],
      maxChanged: 4,
    },
  });

  assert.equal(digest.width, 4);
  assert.equal(digest.height, 2);
  assert.match(digest.fileHash, /^[a-f0-9]{64}$/);
  assert.match(digest.pixelHash, /^[a-f0-9]{64}$/);
  assert.equal(digest.stats.pixelCount, 8);
  assert.equal(digest.stats.clipCount, 1);
  assert.equal(digest.stats.blackCount, 0);
  assert.equal(digest.probes[0].clip, true);
  assert.deepEqual(digest.probes[0].rgba, [255, 0, 0, 255]);
  assert.equal(digest.probes[1].clip, false);
  assert.equal(digest.compare.identical, false);
  assert.equal(digest.compare.changedPixelCount, 1);
  assert.deepEqual(digest.compare.changed[0].x, 0);
  assert.deepEqual(digest.compare.changed[0].otherRgba, [0, 0, 0, 255]);
});

test('beauty digest bbox isolates a region and identical captures compare cleanly', async (t) => {
  const { studioRoot, artifacts } = await withArtifacts(t);
  const pixels = rgbaFill(3, 3, [40, 50, 60, 255]);
  await writeFile(path.join(artifacts, 'studio-300.png'), encodePngRgba(3, 3, pixels));
  const digest = buildBeautyDigest({
    studioRoot,
    latestEvidence: { items: [{ path: path.join(artifacts, 'studio-300.png') }] },
    evidence: {
      comparePath: 'studio-300.png',
      bbox: { x0: 1, y0: 1, x1: 2, y1: 2 },
    },
  });
  assert.deepEqual(digest.bbox, { x0: 1, y0: 1, x1: 2, y1: 2 });
  assert.equal(digest.stats.pixelCount, 4);
  assert.equal(digest.compare.identical, true);
  assert.equal(digest.compare.regionIdentical, true);
});

test('beauty digest probes resolve entity ids from a matching object-id capture', async (t) => {
  const { studioRoot, artifacts } = await withArtifacts(t);
  const beauty = rgbaFill(2, 1, [10, 20, 30, 255]);
  const objectId = rgbaFill(2, 1, [0, 0, 0, 255]);
  objectId.set([...encodeObjectId(1), 255], 0);
  await writeFile(path.join(artifacts, 'studio-500.png'), encodePngRgba(2, 1, beauty));
  await writeFile(path.join(artifacts, 'studio-500-objectid.png'), encodePngRgba(2, 1, objectId));
  const digest = buildBeautyDigest({
    studioRoot,
    latestEvidence: {
      items: [
        { path: path.join(artifacts, 'studio-500.png'), pass: 'beauty' },
        {
          path: path.join(artifacts, 'studio-500-objectid.png'),
          pass: 'objectId',
          entities: [{ index: 1, id: 'entity/cloth' }],
        },
      ],
      objectId: {
        path: path.join(artifacts, 'studio-500-objectid.png'),
        entities: [{ index: 1, id: 'entity/cloth' }],
      },
    },
    evidence: {
      path: 'studio-500.png',
      probes: [{ name: 'cloth', x: 0, y: 0 }, { name: 'empty', x: 1, y: 0 }],
    },
  });
  assert.equal(digest.probes[0].entityId, 'entity/cloth');
  assert.equal(digest.probes[0].objectId, 1);
  assert.equal(digest.probes[1].entityId, null);
  assert.equal(digest.probes[1].objectId, 0);
});

test('beauty evidence paths stay inside studio artifacts', async (t) => {
  const { studioRoot, artifacts } = await withArtifacts(t);
  await writeFile(path.join(artifacts, 'studio-400.png'), encodePngRgba(1, 1, Buffer.from([1, 2, 3, 255])));
  await writeFile(path.join(studioRoot, 'secret.png'), encodePngRgba(1, 1, Buffer.from([9, 9, 9, 255])));
  assert.equal(
    resolveStudioEvidencePath('studio-400.png', { studioRoot }),
    path.resolve(artifacts, 'studio-400.png'),
  );
  assert.throws(
    () => resolveStudioEvidencePath(path.join(studioRoot, 'secret.png'), { studioRoot }),
    error => error.code === 'beauty_evidence_path_invalid',
  );
  assert.throws(
    () => resolveStudioEvidencePath('../secret.png', { studioRoot }),
    error => error.code === 'beauty_evidence_path_invalid',
  );
  assert.throws(
    () => buildBeautyDigest({ studioRoot, evidence: { path: 'notes.txt' } }),
    error => error.code === 'beauty_evidence_path_invalid',
  );
});
