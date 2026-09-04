import { ENVIRONMENT_TEXTURE_SIZE, validateEnvironmentSettings } from '../core/environment-settings.mjs';

// Positive finite half-floats suffice for the bounded radiance used here.
function half(value) {
  if (value <= 0) return 0;
  const exponent = Math.floor(Math.log2(value));
  if (exponent < -14) return Math.round(value * 16777216);
  return (exponent + 15) * 1024 + Math.round((value / 2 ** exponent - 1) * 1024);
}

export function proceduralEnvironmentPixels(settings) {
  const errors = validateEnvironmentSettings(settings);
  if (errors.length) { const error = new Error(errors.map(item => item.message).join(' ')); error.code = 'invalid_environment'; throw error; }
  if (settings == null) return null;
  const [width, height] = ENVIRONMENT_TEXTURE_SIZE;
  const data = new Uint16Array(width * height * 4);
  const studio = settings.mode === 'studio';
  const sky = settings.skyColor ?? (studio ? [0.19, 0.22, 0.27] : [0.16, 0.34, 0.68]);
  const ground = settings.groundColor ?? [0.045, 0.042, 0.038];
  const intensity = settings.intensity ?? 1;
  const rotation = settings.rotation ?? 0;
  const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  for (let row = 0; row < height; row += 1) {
    // Equirectangular UV y=0 is -Y for Three's unflipped DataTexture.
    const elevation = ((row + 0.5) / height - 0.5) * Math.PI;
    const up = Math.sin(elevation);
    const blend = Math.min(1, Math.max(0, (up + 0.12) / 0.35));
    for (let column = 0; column < width; column += 1) {
      const azimuth = ((column + 0.5) / width - 0.5) * Math.PI * 2 + rotation;
      let light = 0;
      if (studio) {
        // Three broad rectangular softboxes leave readable curves in polished surfaces.
        for (const [angle, altitude, span, power] of [[-0.85, 0.55, 0.27, 3], [1.9, 0.38, 0.18, 1.7], [0.25, 1.25, 0.55, 2]]) {
          light += power * Math.exp(-((angleDelta(azimuth, angle) / span) ** 8 + ((elevation - altitude) / 0.3) ** 8));
        }
      } else {
        // Broad bright horizon and a restrained sun; this is illumination, not a sky mesh.
        light = 0.18 * Math.exp(-((up / 0.19) ** 2))
          + 3 * Math.exp(-((angleDelta(azimuth, -0.8) / 0.06) ** 2 + ((elevation - 0.7) / 0.06) ** 2));
      }
      const offset = (row * width + column) * 4;
      for (let channel = 0; channel < 3; channel += 1) data[offset + channel] = half((ground[channel] * (1 - blend) + sky[channel] * blend + light) * intensity);
      data[offset + 3] = half(1);
    }
  }
  return { width, height, data };
}

export function createProceduralEnvironment(THREE, settings) {
  const pixels = proceduralEnvironmentPixels(settings);
  if (!pixels) return null;
  if (!THREE.DataTexture || THREE.HalfFloatType === undefined || THREE.EquirectangularReflectionMapping === undefined) throw new Error('Procedural environment requires WebGPU half-float equirectangular textures.');
  const texture = new THREE.DataTexture(pixels.data, pixels.width, pixels.height, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.name = `Studio ${settings.mode} reflection environment`;
  texture.needsUpdate = true;
  return texture;
}
