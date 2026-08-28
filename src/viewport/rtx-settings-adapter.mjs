import { normalizeRtxSettings } from '../core/rtx-settings.mjs';

/** Maps the flat canonical scene setting into the controller's render controls. */
export function adaptSceneRtxSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('scene.settings.rtx must be an object.');
  }
  const { enabled = false, ...authored } = value;
  if (typeof enabled !== 'boolean') throw new TypeError('scene.settings.rtx.enabled must be boolean.');
  const settings = normalizeRtxSettings(authored);
  return Object.freeze({
    enabled,
    lighting: Object.freeze({
      enabled: settings.lighting,
      maxDistance: settings.maxDistance,
      rayBias: settings.rayBias,
      depthInverted: false,
    }),
    shadows: Object.freeze({
      enabled: settings.shadows,
      strength: settings.shadowStrength,
      sampleCount: settings.directionalSampleCount,
      angularRadius: settings.directionalAngularRadius,
    }),
    ambientOcclusion: Object.freeze({
      enabled: settings.ambientOcclusion,
      strength: settings.aoStrength,
      sampleCount: settings.aoSampleCount,
      radius: settings.aoRadius,
    }),
  });
}
