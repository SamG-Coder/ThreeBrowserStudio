import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeObjectId,
  encodeObjectId,
  occlusionForExpected,
  sampleObjectId,
} from '../src/core/index.mjs';

test('object-id RGB packing round-trips and classifies occlusion', () => {
  assert.deepEqual(encodeObjectId(1), [1, 0, 0]);
  assert.deepEqual(encodeObjectId(256), [0, 1, 0]);
  assert.equal(decodeObjectId(1, 0, 0), 1);
  assert.equal(decodeObjectId(0, 1, 0), 256);

  const rgba = Buffer.from([1, 0, 0, 255, 0, 0, 0, 255]);
  const entities = [{ index: 1, id: 'entity/cloth' }];
  const hit = sampleObjectId(rgba, 2, 1, 0, 0, entities);
  const empty = sampleObjectId(rgba, 2, 1, 1, 0, entities);
  assert.equal(hit.entityId, 'entity/cloth');
  assert.equal(empty.occlusion, 'background');
  assert.equal(occlusionForExpected(hit, 'entity/cloth'), 'visible');
  assert.equal(occlusionForExpected({ ...hit, entityId: 'entity/other' }, 'entity/cloth'), 'occluded');
});
