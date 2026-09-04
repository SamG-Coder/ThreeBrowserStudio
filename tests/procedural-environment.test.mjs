import assert from 'node:assert/strict';
import test from 'node:test';
import { validateEnvironmentSettings } from '../src/core/environment-settings.mjs';
import { proceduralEnvironmentPixels, createProceduralEnvironment } from '../src/runtime/procedural-environment.mjs';
import { createProjectDocument, validateProjectDocument } from '../src/core/documents.mjs';

function fromHalf(value) {
  const exponent = (value >> 10) & 31;
  const mantissa = value & 1023;
  return exponent === 0 ? mantissa * 2 ** -24 : (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

test('procedural IBL is opt-in and rejects unbounded or unknown authored input', () => {
  assert.equal(proceduralEnvironmentPixels(null), null);
  assert.deepEqual(validateEnvironmentSettings(undefined), []);
  for (const value of [true, {}, { mode: 'file', path: 'x.hdr' }, { mode: 'studio', intensity: Infinity }, { mode: 'studio', intensity: 9 }, { mode: 'sky', rotation: 20 }, { mode: 'studio', skyColor: [1, -1, 0] }, { mode: 'studio', groundColor: [1, 1] }]) {
    assert.ok(validateEnvironmentSettings(value).length, JSON.stringify(value));
  }
  assert.deepEqual(validateEnvironmentSettings({ mode: 'studio', intensity: 0.6, rotation: 1, skyColor: [0.1, 0.2, 0.3] }), []);
});

test('studio illumination is deterministic HDR with dark ground, bright panels, and bounded allocation', () => {
  const first = proceduralEnvironmentPixels({ mode: 'studio' });
  const second = proceduralEnvironmentPixels({ mode: 'studio' });
  assert.equal(first.width, 512);
  assert.equal(first.height, 256);
  assert.equal(first.data.byteLength, 512 * 256 * 8);
  assert.deepEqual(first.data, second.data);
  const radiance = Array.from(first.data).filter((_, index) => index % 4 !== 3).map(fromHalf);
  assert.ok(Math.max(...radiance.slice(0, 60000)) < 0.1, 'lower hemisphere should remain dark');
  assert.ok(radiance.some(value => value > 2), 'softboxes must retain HDR radiance');
  assert.ok(radiance.every(value => Number.isFinite(value) && value >= 0 && value < 8));
  const rotated = proceduralEnvironmentPixels({ mode: 'studio', rotation: Math.PI });
  assert.notDeepEqual(first.data, rotated.data);
  const disabled = proceduralEnvironmentPixels({ mode: 'sky', intensity: 0 });
  assert.ok(disabled.data.every((value, index) => index % 4 === 3 || value === 0));
});

test('environment texture uses portable half-float linear equirectangular sampling', () => {
  class DataTexture { constructor(data, width, height, format, type) { Object.assign(this, { image: { data, width, height }, format, type }); } }
  const THREE = { DataTexture, RGBAFormat: 1, HalfFloatType: 2, EquirectangularReflectionMapping: 3, LinearSRGBColorSpace: 'linear', LinearFilter: 4, RepeatWrapping: 5, ClampToEdgeWrapping: 6 };
  const texture = createProceduralEnvironment(THREE, { mode: 'sky' });
  assert.equal(texture.type, THREE.HalfFloatType);
  assert.equal(texture.mapping, THREE.EquirectangularReflectionMapping);
  assert.equal(texture.colorSpace, THREE.LinearSRGBColorSpace);
  assert.equal(texture.generateMipmaps, false);
  assert.equal(texture.flipY, false);
  assert.equal(texture.needsUpdate, true);
  assert.throws(() => createProceduralEnvironment({}, { mode: 'studio' }), /requires WebGPU/);
});

test('canonical scene validation rejects malformed environment before candidate compilation', () => {
  const project = createProjectDocument({ projectId: 'project/environment-check' });
  const scene = project.scenes[project.activeSceneId];
  scene.settings.environment = { mode: 'studio', intensity: 0.7 };
  assert.equal(validateProjectDocument(project).valid, true);
  scene.settings.environment.rotation = 500;
  const result = validateProjectDocument(project);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some(item => item.code === 'invalid_environment' && item.path.endsWith('.environment.rotation')));
});
