import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_RTX_SETTINGS,
  RtxSettingsError,
  createRtxState,
  nativeRayLightingSettings,
  normalizeRtxSettings,
  rtxCanBuild,
  rtxCanEvaluate,
  rtxLightingEnabled,
  rtxStatePhase,
  transitionRtxState,
  validateRtxState,
} from '../src/core/rtx-settings.mjs';

test('RTX defaults mirror the native lighting field names and compatibility defaults', () => {
  assert.deepEqual(normalizeRtxSettings(), DEFAULT_RTX_SETTINGS);
  const native = nativeRayLightingSettings(DEFAULT_RTX_SETTINGS, {
    directionalLightDirection: new Float32Array([0, 1, 0]),
    directionalLightIntensity: 2,
    sourceId: 'light/sun',
  });
  assert.deepEqual([...native.directionalLightDirection], [0, 1, 0]);
  assert.equal(native.directionalLightIntensity, 2);
  assert.equal(native.directionalSampleCount, 1);
  assert.equal(native.aoSampleCount, 2);
  assert.equal(native.directionalAngularRadius, 0.0065);
  assert.equal(native.maxDistance, 10_000);
  assert.equal(native.rayBias, 0.002);
});

test('RTX settings are strict and enforce native sample, radius, distance, bias, and strength ranges', () => {
  for (const input of [
    { typo: true },
    { directionalSampleCount: 0 },
    { directionalSampleCount: 65 },
    { aoSampleCount: 1.5 },
    { directionalAngularRadius: Math.PI / 2 },
    { shadowStrength: 1.1 },
    { aoStrength: -0.1 },
    { aoRadius: 0 },
    { maxDistance: 0 },
    { maxDistance: 1, rayBias: 1 },
  ]) {
    assert.throws(() => normalizeRtxSettings(input), error => error instanceof RtxSettingsError);
  }
});

test('lighting toggles lower to zero native effect strengths without changing authored quality values', () => {
  const shadowsOff = nativeRayLightingSettings({ shadows: false, aoStrength: 0.4 });
  assert.equal(shadowsOff.shadowStrength, 0);
  assert.equal(shadowsOff.aoStrength, 0.4);
  assert.equal(rtxLightingEnabled({ shadows: false, aoStrength: 0.4 }), true);

  const lightingOff = nativeRayLightingSettings({ lighting: false });
  assert.equal(lightingOff.shadowStrength, 0);
  assert.equal(lightingOff.aoStrength, 0);
  assert.equal(rtxLightingEnabled({ lighting: false }), false);

  assert.throws(() => nativeRayLightingSettings(DEFAULT_RTX_SETTINGS, {
    directionalLightDirection: [0, 0, 0], directionalLightIntensity: 1,
  }), error => error.code === 'invalid_directional_light');
});

test('RTX state transitions never confuse support, request, build, activation, staleness, and failure', () => {
  let state = createRtxState({ supported: false, requested: true, reason: 'No ray-query adapter.' });
  assert.equal(rtxStatePhase(state), 'unsupported');
  assert.equal(state.active, false);
  assert.equal(rtxCanBuild(state), false);

  state = transitionRtxState(state, { type: 'support', supported: true });
  assert.equal(rtxStatePhase(state), 'stale');
  assert.equal(rtxCanBuild(state), true);

  state = transitionRtxState(state, { type: 'build.start' });
  assert.equal(rtxStatePhase(state), 'building');
  assert.equal(state.active, false);
  assert.equal(state.stale, true);

  state = transitionRtxState(state, { type: 'build.success' });
  assert.equal(rtxStatePhase(state), 'active');
  assert.equal(rtxCanEvaluate(state), true);

  state = transitionRtxState(state, { type: 'invalidate', reason: 'Topology changed.' });
  assert.equal(rtxStatePhase(state), 'stale');
  assert.equal(state.reason, 'Topology changed.');
  assert.equal(rtxCanEvaluate(state), false);

  state = transitionRtxState(state, { type: 'build.start' });
  state = transitionRtxState(state, { type: 'build.failure', reason: 'Native BLAS build failed.' });
  assert.equal(rtxStatePhase(state), 'failed');
  assert.equal(state.failed, true);
  assert.equal(state.active, false);
  assert.equal(state.reason, 'Native BLAS build failed.');

  state = transitionRtxState(state, { type: 'request', requested: false });
  assert.equal(rtxStatePhase(state), 'disabled');
  assert.equal(state.reason, null);
});

test('invalid RTX states and impossible transitions are rejected', () => {
  assert.throws(() => validateRtxState({
    supported: false,
    requested: true,
    active: true,
    stale: false,
    building: false,
    failed: false,
    reason: null,
  }), error => error.code === 'invalid_rtx_state');
  const disabled = createRtxState({ supported: true, requested: false });
  assert.throws(
    () => transitionRtxState(disabled, { type: 'build.start' }),
    error => error.code === 'invalid_rtx_transition',
  );
  assert.throws(
    () => transitionRtxState(disabled, { type: 'unknown' }),
    error => error.code === 'invalid_rtx_event',
  );
  assert.throws(
    () => createRtxState({ supported: true, requested: false, typo: true }),
    error => error.code === 'invalid_rtx_state_input',
  );
});
