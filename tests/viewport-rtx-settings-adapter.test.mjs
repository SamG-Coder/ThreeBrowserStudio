import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RTX_SETTINGS } from '../src/core/rtx-settings.mjs';
import { adaptSceneRtxSettings } from '../src/viewport/rtx-settings-adapter.mjs';

test('canonical flat RTX settings map exactly to independent controller controls', () => {
  assert.deepEqual(adaptSceneRtxSettings({ enabled: true, ...DEFAULT_RTX_SETTINGS }), {
    enabled: true,
    lighting: {
      enabled: true,
      maxDistance: 10_000,
      rayBias: 0.002,
      depthInverted: false,
    },
    shadows: {
      enabled: true,
      strength: 0.9,
      sampleCount: 1,
      angularRadius: 0.0065,
    },
    ambientOcclusion: {
      enabled: true,
      strength: 0.22,
      sampleCount: 2,
      radius: 0.8,
    },
  });
  assert.equal(adaptSceneRtxSettings({}).enabled, false);
  assert.throws(() => adaptSceneRtxSettings({ enabled: 'yes' }));
  assert.throws(() => adaptSceneRtxSettings({ enabled: true, unknown: 1 }));
});
