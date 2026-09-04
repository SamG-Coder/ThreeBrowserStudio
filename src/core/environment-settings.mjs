export const ENVIRONMENT_MODES = Object.freeze(['studio', 'sky']);
export const ENVIRONMENT_TEXTURE_SIZE = Object.freeze([512, 256]);

/** Optional bounded, project-owned image-based illumination; colours are linear. */
export function validateEnvironmentSettings(value, path = '$.environment', diagnostics = []) {
  const fail = (field, message) => diagnostics.push({ severity: 'error', code: 'invalid_environment', path: field ? `${path}.${field}` : path, message });
  if (value == null) return diagnostics;
  if (typeof value !== 'object' || Array.isArray(value)) { fail('', 'Environment must be null or an object.'); return diagnostics; }
  for (const key of Object.keys(value)) {
    if (!['mode', 'intensity', 'rotation', 'skyColor', 'groundColor'].includes(key)) fail(key, `Unsupported environment setting ${key}.`);
  }
  if (!ENVIRONMENT_MODES.includes(value.mode)) fail('mode', 'Environment mode must be studio or sky.');
  for (const [key, low, high] of [['intensity', 0, 8], ['rotation', -Math.PI * 2, Math.PI * 2]]) {
    if (value[key] !== undefined && (!Number.isFinite(value[key]) || value[key] < low || value[key] > high)) fail(key, `${key} must be finite from ${low} through ${high}.`);
  }
  for (const key of ['skyColor', 'groundColor']) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length !== 3 || value[key].some(channel => !Number.isFinite(channel) || channel < 0 || channel > 1))) fail(key, `${key} must contain three linear colour channels from 0 through 1.`);
  }
  return diagnostics;
}
