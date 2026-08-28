import assert from 'node:assert/strict';
import test from 'node:test';
import { collectObsNames, createObsAuthentication } from '../scripts/obs-showcase.mjs';

test('OBS WebSocket authentication follows the v5 challenge digest', () => {
  assert.equal(
    createObsAuthentication('secret', 'salt', 'challenge'),
    '39cfhx7et2iyoMZvoQ6o3OPLNSKgtMmy48GQ7jnvsdE=',
  );
});

test('OBS list responses normalize both string and object name shapes', () => {
  assert.deepEqual(
    [...collectObsNames(['ThreeBrowser Showcase', { profileName: 'Default' }], 'profileName')],
    ['ThreeBrowser Showcase', 'Default'],
  );
});
