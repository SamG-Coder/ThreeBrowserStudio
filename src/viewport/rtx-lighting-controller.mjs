const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  lighting: Object.freeze({
    enabled: true,
    maxDistance: 10_000,
    rayBias: 0.002,
    depthInverted: false,
  }),
  shadows: Object.freeze({
    enabled: true,
    strength: 0.6,
    sampleCount: 1,
    angularRadius: 0.0065,
  }),
  ambientOcclusion: Object.freeze({
    enabled: true,
    strength: 0.2,
    sampleCount: 2,
    radius: 0.9,
  }),
});

export const DEFAULT_RTX_LIGHTING_SETTINGS = DEFAULT_SETTINGS;

const MAX_PACKED_LIGHTS = 8;
const PACKED_LIGHT_FLOATS = 16;

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum, fallback) {
  return Math.min(maximum, Math.max(minimum, finite(value, fallback)));
}

function integer(value, minimum, maximum, fallback) {
  return Math.min(maximum, Math.max(minimum, Math.trunc(finite(value, fallback))));
}

function control(value, defaults) {
  if (typeof value === 'boolean') return { ...defaults, enabled: value };
  if (!value || typeof value !== 'object') return { ...defaults };
  const normalized = { ...defaults, ...value };
  if (value.sampleCount === undefined && value.samples !== undefined) normalized.sampleCount = value.samples;
  return normalized;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/**
 * Canonicalizes the small authored RTX control surface. `enabled` requests the
 * native scene; lighting, shadows, and AO remain independently switchable.
 */
export function normalizeRtxLightingSettings(value = {}) {
  const source = value === true ? { enabled: true } : value && typeof value === 'object' ? value : {};
  const lighting = control(source.lighting, DEFAULT_SETTINGS.lighting);
  const shadows = control(source.shadows, DEFAULT_SETTINGS.shadows);
  const ambientOcclusion = control(
    source.ambientOcclusion ?? source.ao,
    DEFAULT_SETTINGS.ambientOcclusion,
  );
  if (source.maxDistance !== undefined) lighting.maxDistance = source.maxDistance;
  if (source.rayBias !== undefined) lighting.rayBias = source.rayBias;
  if (source.depthInverted !== undefined) lighting.depthInverted = source.depthInverted;
  if (source.shadowStrength !== undefined) shadows.strength = source.shadowStrength;
  if (source.directionalSampleCount !== undefined) shadows.sampleCount = source.directionalSampleCount;
  if (source.directionalAngularRadius !== undefined) shadows.angularRadius = source.directionalAngularRadius;
  if (source.aoStrength !== undefined) ambientOcclusion.strength = source.aoStrength;
  if (source.aoSampleCount !== undefined) ambientOcclusion.sampleCount = source.aoSampleCount;
  if (source.aoRadius !== undefined) ambientOcclusion.radius = source.aoRadius;
  return deepFreeze({
    enabled: Boolean(source.enabled ?? source.masterEnabled ?? false),
    lighting: {
      enabled: Boolean(lighting.enabled),
      maxDistance: clamp(lighting.maxDistance, 0.01, 10_000_000, DEFAULT_SETTINGS.lighting.maxDistance),
      rayBias: clamp(lighting.rayBias, 0.000001, 1, DEFAULT_SETTINGS.lighting.rayBias),
      depthInverted: Boolean(lighting.depthInverted),
    },
    shadows: {
      enabled: Boolean(shadows.enabled),
      strength: clamp(shadows.strength, 0, 1, DEFAULT_SETTINGS.shadows.strength),
      sampleCount: integer(
        shadows.sampleCount ?? shadows.samples,
        1,
        64,
        DEFAULT_SETTINGS.shadows.sampleCount,
      ),
      angularRadius: clamp(
        shadows.angularRadius,
        0,
        1,
        DEFAULT_SETTINGS.shadows.angularRadius,
      ),
    },
    ambientOcclusion: {
      enabled: Boolean(ambientOcclusion.enabled),
      strength: clamp(
        ambientOcclusion.strength,
        0,
        1,
        DEFAULT_SETTINGS.ambientOcclusion.strength,
      ),
      sampleCount: integer(
        ambientOcclusion.sampleCount ?? ambientOcclusion.samples,
        1,
        64,
        DEFAULT_SETTINGS.ambientOcclusion.sampleCount,
      ),
      radius: clamp(
        ambientOcclusion.radius,
        0.001,
        1_000_000,
        DEFAULT_SETTINGS.ambientOcclusion.radius,
      ),
    },
  });
}

function dimension(value, fallback = 1) {
  return Math.max(1, Math.min(16_384, Math.trunc(finite(value, fallback))));
}

function normalizeDirection(value) {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null;
  if (value.length < 3) return null;
  const x = finite(value[0], 0);
  const y = finite(value[1], 0);
  const z = finite(value[2], 0);
  const length = Math.hypot(x, y, z);
  if (!(length > 0)) return null;
  return [x / length, y / length, z / length];
}

function colorLuminance(value) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return Math.max(0, 0.2126 * finite(value[0], 1) + 0.7152 * finite(value[1], 1) + 0.0722 * finite(value[2], 1));
  }
  if (value && typeof value === 'object') {
    return Math.max(0, 0.2126 * finite(value.r, 1) + 0.7152 * finite(value.g, 1) + 0.0722 * finite(value.b, 1));
  }
  return 1;
}

/** Selects and normalizes the strongest bridge-ready directional light. */
export function selectStrongestDirectionalLight(lights = []) {
  let strongest = null;
  for (const light of Array.isArray(lights) ? lights : []) {
    if (!light || typeof light !== 'object') continue;
    const direction = normalizeDirection(light.direction ?? light.directionalLightDirection);
    if (!direction) continue;
    const intensity = Math.max(0, finite(light.intensity ?? light.directionalLightIntensity, 0));
    const strength = Math.max(0, finite(light.strength, intensity * colorLuminance(light.color)));
    if (!strongest || strength > strongest.strength) {
      strongest = { direction, intensity: strength, strength };
    }
  }
  return deepFreeze(strongest ?? { direction: [0, -1, 0], intensity: 0, strength: 0 });
}

function requireTypedArray(value, Type, label, multiple, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (!(value instanceof Type) || value.length === 0 || value.length % multiple !== 0) {
    throw new TypeError(`${label} must be a non-empty ${Type.name} with length divisible by ${multiple}.`);
  }
  return value;
}

function validateCollectedScene(value) {
  if (!value || typeof value !== 'object') {
    throw new TypeError('RTX scene collector must return an object.');
  }
  const positions = requireTypedArray(value.positions, Float32Array, 'positions', 3);
  const indices = requireTypedArray(value.indices, Uint32Array, 'indices', 3);
  const vertexCount = positions.length / 3;
  for (const index of indices) {
    if (index >= vertexCount) throw new RangeError(`RTX scene index ${index} exceeds ${vertexCount} vertices.`);
  }
  const triangleCount = indices.length / 3;
  const triangleRadiance = requireTypedArray(
    value.triangleRadiance,
    Float32Array,
    'triangleRadiance',
    4,
    { optional: true },
  );
  const triangleSurface = requireTypedArray(
    value.triangleSurface,
    Float32Array,
    'triangleSurface',
    4,
    { optional: true },
  );
  if (triangleRadiance && triangleRadiance.length !== triangleCount * 4) {
    throw new RangeError('triangleRadiance must contain one vec4 per triangle.');
  }
  if (triangleSurface && triangleSurface.length !== triangleCount * 4) {
    throw new RangeError('triangleSurface must contain one vec4 per triangle.');
  }
  const packedLights = value.packedLights ?? value.lights;
  if (packedLights !== undefined) {
    if (!(packedLights instanceof Float32Array) || packedLights.length % PACKED_LIGHT_FLOATS !== 0) {
      throw new TypeError(`packed point/spot lights must be a Float32Array with length divisible by ${PACKED_LIGHT_FLOATS}.`);
    }
    if (packedLights.length > MAX_PACKED_LIGHTS * PACKED_LIGHT_FLOATS) {
      throw new RangeError(`packed point/spot lights support at most ${MAX_PACKED_LIGHTS} records.`);
    }
  }
  const instanceGroups = value.instanceGroups;
  if (instanceGroups !== undefined && !Array.isArray(instanceGroups)) {
    throw new TypeError('instanceGroups must be an array when provided.');
  }
  const directionalLights = value.directionalLights ?? (value.directionalLight ? [value.directionalLight] : []);
  return {
    positions,
    indices,
    triangleRadiance,
    triangleSurface,
    lights: packedLights,
    instanceGroups,
    directionalLight: selectStrongestDirectionalLight(directionalLights),
    stats: deepFreeze({
      vertexCount,
      triangleCount,
      packedLightCount: packedLights ? packedLights.length / PACKED_LIGHT_FLOATS : 0,
      directionalLightCount: Array.isArray(directionalLights) ? directionalLights.length : 0,
    }),
  };
}

function registrationPayload(scene) {
  return {
    positions: scene.positions,
    indices: scene.indices,
    ...(scene.triangleRadiance ? { triangleRadiance: scene.triangleRadiance } : {}),
    ...(scene.triangleSurface ? { triangleSurface: scene.triangleSurface } : {}),
    ...(scene.lights ? { lights: scene.lights } : {}),
    ...(scene.instanceGroups ? { instanceGroups: scene.instanceGroups } : {}),
  };
}

function runtimeStatus(rtx) {
  try {
    return rtx?.getStatus?.() ?? rtx?.status ?? null;
  } catch {
    return null;
  }
}

function runtimeFeature(rtx) {
  return runtimeStatus(rtx)?.features?.nativeRayTracing ?? null;
}

function textureResource(texture, layout, width, height) {
  return {
    texture,
    layout,
    vulkanLayout: layout,
    left: 0,
    top: 0,
    width,
    height,
  };
}

function inverseViewProjection(camera) {
  if (!camera?.projectionMatrixInverse?.clone || !camera?.matrixWorld) {
    throw new TypeError('RTX lighting requires a camera with projectionMatrixInverse and matrixWorld.');
  }
  return camera.projectionMatrixInverse.clone().multiply(camera.matrixWorld).toArray();
}

function cameraPosition(camera) {
  const elements = camera?.matrixWorld?.elements;
  if (!elements || elements.length < 16) throw new TypeError('RTX lighting requires camera.matrixWorld elements.');
  return [finite(elements[12], 0), finite(elements[13], 0), finite(elements[14], 0)];
}

function defaultDelay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * Owns the optional native ray-lighting path without owning project semantics.
 *
 * collectScene(scene, { signal, settings }) must return world-space positions,
 * indices, optional triangleRadiance/triangleSurface/instanceGroups, optional
 * packed point/spot `lights` (16 floats each, maximum eight), and optional
 * `directionalLights` with bridge-ready direction/intensity/color values.
 */
export class RtxLightingController {
  #THREE;
  #renderer;
  #rtx;
  #device;
  #collectScene;
  #normalizeSettings;
  #settings;
  #pollIntervalMs;
  #waitTimeoutMs;
  #delay;
  #now;
  #target = null;
  #presenter = null;
  #width = 1;
  #height = 1;
  #buildToken = 0;
  #buildAbort = null;
  #registeredToken = null;
  #sceneRegistered = false;
  #building = false;
  #configured = false;
  #active = false;
  #stale = false;
  #failed = false;
  #reason = 'disabled';
  #frameIndex = 0;
  #directionalLight = selectStrongestDirectionalLight();
  #staticSceneStats = null;
  #disposed = false;
  #gpuTail = Promise.resolve();
  #gpuPending = 0;

  constructor({
    THREE,
    renderer,
    rtx,
    collectScene,
    normalizeSettings = normalizeRtxLightingSettings,
    settings = DEFAULT_SETTINGS,
    pollIntervalMs = 10,
    waitTimeoutMs = 12_000,
    delay = defaultDelay,
    now = () => performance.now(),
  } = {}) {
    if (!THREE || typeof THREE !== 'object') throw new TypeError('THREE dependency is required.');
    if (!renderer || typeof renderer.render !== 'function') throw new TypeError('renderer dependency is required.');
    if (typeof collectScene !== 'function') throw new TypeError('collectScene dependency is required.');
    if (typeof normalizeSettings !== 'function') throw new TypeError('normalizeSettings must be a function.');
    this.#THREE = THREE;
    this.#renderer = renderer;
    this.#rtx = rtx;
    this.#device = renderer.backend?.device ?? null;
    this.#collectScene = collectScene;
    this.#normalizeSettings = normalizeSettings;
    this.#pollIntervalMs = Math.max(0, finite(pollIntervalMs, 10));
    this.#waitTimeoutMs = Math.max(1, finite(waitTimeoutMs, 12_000));
    this.#delay = delay;
    this.#now = now;
    this.#settings = normalizeRtxLightingSettings(this.#normalizeSettings(settings));
    if (this.#settings.enabled) this.#reason = this.#supportReason() ?? 'not configured';
  }

  #supportReason() {
    if (!this.#rtx?.capabilities?.nativeRayTracing) return 'native ray tracing is unsupported';
    if (!this.#device?.createCommandEncoder || !this.#device?.queue?.submit) return 'renderer GPU device is unavailable';
    if (typeof this.#rtx.registerStaticScene !== 'function') return 'registerStaticScene is unavailable';
    if (typeof this.#rtx.destroyStaticScene !== 'function') return 'destroyStaticScene is unavailable';
    if (typeof this.#rtx.evaluateRayLighting !== 'function') return 'evaluateRayLighting is unavailable';
    if (typeof this.#rtx.getStatus !== 'function') return 'native RTX status is unavailable';
    if (typeof this.#renderer.getOutputRenderTarget !== 'function'
        || typeof this.#renderer.setOutputRenderTarget !== 'function') {
      return 'renderer output-target control is unavailable';
    }
    const layouts = this.#rtx.vulkanImageLayouts;
    if (!layouts?.colorAttachment || !layouts?.depthStencilAttachment) {
      return 'native Vulkan attachment layouts are unavailable';
    }
    if (runtimeFeature(this.#rtx)?.supported === false) return 'native ray tracing is unsupported';
    return null;
  }

  #isSupported() {
    return this.#supportReason() === null;
  }

  get settings() {
    return this.#settings;
  }

  getStatus() {
    const feature = runtimeFeature(this.#rtx);
    const supported = this.#isSupported();
    const requested = Boolean(this.#settings.enabled);
    const active = Boolean(
      this.#active
      && supported
      && requested
      && this.#configured
      && this.#settings.lighting.enabled
      && !this.#building
      && !this.#stale
      && !this.#failed
      && feature?.active === true
    );
    let reason = this.#reason;
    if (this.#disposed) reason = 'disposed';
    else if (!requested) reason = 'disabled';
    else if (!supported) reason = this.#supportReason();
    else if (this.#failed) reason = this.#reason;
    else if (this.#building) reason = 'building native static scene';
    else if (this.#stale) reason = this.#reason || 'native static scene is stale';
    else if (!this.#configured) reason = 'not configured';
    else if (!this.#settings.lighting.enabled) reason = 'native lighting control is disabled';
    else if (active) reason = 'active';
    else reason = 'configured; awaiting a native lighting frame';
    return deepFreeze({
      supported,
      requested,
      configured: Boolean(this.#configured),
      building: Boolean(this.#building),
      active,
      stale: Boolean(this.#stale),
      failed: Boolean(this.#failed),
      reason,
      frameIndex: this.#frameIndex,
      size: { width: this.#width, height: this.#height },
      settings: this.#settings,
      staticScene: this.#staticSceneStats,
      runtimeFeature: feature ? { ...feature } : null,
    });
  }

  setSettings(value) {
    const wasEnabled = this.#settings.enabled;
    this.#settings = normalizeRtxLightingSettings(this.#normalizeSettings(value));
    if (!this.#settings.enabled) {
      const teardown = () => {
        if (this.#settings.enabled || this.#disposed) return false;
        const destroyed = this.destroyStaticScene('disabled');
        this.#disposeTarget();
        return destroyed;
      };
      if (this.#gpuPending === 0) teardown();
      else {
        // Report the authored off state immediately, but do not destroy a
        // native scene or attachment that an in-flight capture still owns.
        this.#cancelBuild();
        this.#configured = false;
        this.#active = false;
        this.#stale = false;
        this.#failed = false;
        this.#reason = 'disabled';
        this.#staticSceneStats = null;
        this.#frameIndex = 0;
        void this.#enqueueGpu(teardown);
      }
      return this.#settings;
    }
    if (!wasEnabled) {
      this.#failed = false;
      this.#reason = this.#supportReason() ?? 'not configured';
    }
    if (!this.#settings.lighting.enabled) this.#active = false;
    return this.#settings;
  }

  #cancelBuild() {
    this.#buildToken += 1;
    this.#buildAbort?.abort?.();
    this.#buildAbort = null;
    this.#building = false;
  }

  #destroyRegistration() {
    if (!this.#sceneRegistered) return;
    this.#rtx.destroyStaticScene();
    this.#sceneRegistered = false;
    this.#registeredToken = null;
  }

  destroyStaticScene(reason = 'native static scene destroyed') {
    this.#cancelBuild();
    try {
      this.#destroyRegistration();
      this.#configured = false;
      this.#active = false;
      this.#stale = false;
      this.#failed = false;
      this.#reason = reason;
      this.#staticSceneStats = null;
      this.#frameIndex = 0;
      return true;
    } catch (error) {
      this.#configured = false;
      this.#active = false;
      this.#failed = true;
      this.#reason = `failed to destroy native static scene: ${error?.message ?? String(error)}`;
      return false;
    }
  }

  markStale(reason = 'authored scene changed') {
    if (!this.#settings.enabled) return this.getStatus();
    if (this.#building) this.#cancelBuild();
    if (!this.#configured && !this.#stale) this.#staticSceneStats = null;
    this.#stale = true;
    this.#active = false;
    this.#reason = reason;
    return this.getStatus();
  }

  async #waitForActive(token) {
    const deadline = this.#now() + this.#waitTimeoutMs;
    while (this.#now() <= deadline) {
      if (token !== this.#buildToken || this.#disposed) return false;
      const feature = this.#rtx.getStatus()?.features?.nativeRayTracing;
      if (feature?.active) return true;
      if (feature?.supported === false) throw new Error('native ray tracing became unsupported');
      if (feature?.failed) throw new Error(feature.reason || feature.error || 'native ray tracing configuration failed');
      await this.#delay(this.#pollIntervalMs);
    }
    throw new Error('native ray tracing did not become active before timeout');
  }

  #enqueueGpu(task) {
    this.#gpuPending += 1;
    const run = this.#gpuTail.then(task, task);
    const tracked = run.finally(() => {
      this.#gpuPending = Math.max(0, this.#gpuPending - 1);
    });
    this.#gpuTail = tracked.then(() => undefined, () => undefined);
    return tracked;
  }

  async configure({ scene, width = this.#width, height = this.#height, settings } = {}) {
    if (settings !== undefined) this.setSettings(settings);
    if (this.#disposed) return false;
    if (!this.#settings.enabled) return false;
    const unsupported = this.#supportReason();
    if (unsupported) {
      this.#configured = false;
      this.#active = false;
      this.#failed = false;
      this.#reason = unsupported;
      return false;
    }

    this.#cancelBuild();
    const token = this.#buildToken;
    const abort = new AbortController();
    this.#buildAbort = abort;
    this.#building = true;
    this.#active = false;
    this.#stale = this.#configured;
    this.#failed = false;
    this.#reason = 'building native static scene';

    try {
      const collected = await this.#collectScene(scene, {
        signal: abort.signal,
        settings: this.#settings,
      });
      if (token !== this.#buildToken || this.#disposed || abort.signal.aborted) return false;
      const staticScene = validateCollectedScene(collected);

      return await this.#enqueueGpu(async () => {
        if (token !== this.#buildToken || this.#disposed || abort.signal.aborted) return false;
        this.#destroyRegistration();
        this.#configured = false;
        const registration = this.#rtx.registerStaticScene(registrationPayload(staticScene));
        if (registration?.queued !== true) {
          throw new Error(registration?.reason || 'native static scene registration was rejected');
        }
        this.#sceneRegistered = true;
        this.#registeredToken = token;
        const ready = await this.#waitForActive(token);
        if (!ready || token !== this.#buildToken || this.#disposed) return false;

        this.#directionalLight = staticScene.directionalLight;
        this.#staticSceneStats = staticScene.stats;
        this.#configured = true;
        this.#building = false;
        this.#stale = false;
        this.#failed = false;
        this.#active = false;
        this.#reason = 'configured; awaiting a native lighting frame';
        this.#frameIndex = 0;
        this.resize(width, height);
        return true;
      });
    } catch (error) {
      if (token !== this.#buildToken || this.#disposed || abort.signal.aborted) return false;
      if (this.#registeredToken === token) {
        try {
          this.#destroyRegistration();
        } catch {
          // Preserve the original build failure as the primary status reason.
        }
      }
      this.#configured = false;
      this.#building = false;
      this.#active = false;
      this.#stale = false;
      this.#failed = true;
      this.#reason = `native static scene build failed: ${error?.message ?? String(error)}`;
      return false;
    } finally {
      if (token === this.#buildToken) {
        this.#building = false;
        this.#buildAbort = null;
      }
    }
  }

  #createPresenter(texture) {
    const THREE = this.#THREE;
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: true,
    });
    material.toneMapped = true;
    const quad = new THREE.Mesh(geometry, material);
    // WebGPU render-target rows are addressed from the native attachment
    // origin. Sampling that storage image through the ordinary material map
    // path otherwise presents it upside down on both the canvas and evidence
    // targets after native ray-lighting writes. Flip only the presentation
    // quad; the registered geometry, depth reconstruction, and RTX dispatch
    // remain in their canonical coordinate spaces.
    if (quad.scale) quad.scale.y = -1;
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.name = 'ThreeBrowser Studio RTX presentation';
    scene.add(quad);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
    camera.position.z = 1;
    camera.updateProjectionMatrix?.();
    return { geometry, material, quad, scene, camera };
  }

  #disposeTarget() {
    if (!this.#target) return;
    if (this.#presenter) {
      this.#presenter.material.map = null;
      this.#presenter.material.needsUpdate = true;
    }
    this.#target.dispose?.();
    this.#target = null;
  }

  resize(width, height) {
    const nextWidth = dimension(width, this.#width);
    const nextHeight = dimension(height, this.#height);
    if (this.#target && nextWidth === this.#width && nextHeight === this.#height) return false;
    this.#width = nextWidth;
    this.#height = nextHeight;
    this.#disposeTarget();
    if (!this.#settings.enabled || !this.#isSupported() || this.#disposed) return true;

    const THREE = this.#THREE;
    const depthTexture = new THREE.DepthTexture(nextWidth, nextHeight, THREE.FloatType);
    depthTexture.name = 'ThreeBrowser Studio RTX depth32float';
    depthTexture.format = THREE.DepthFormat;
    depthTexture.type = THREE.FloatType;
    const target = new THREE.RenderTarget(nextWidth, nextHeight, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture,
      samples: 0,
      generateMipmaps: false,
    });
    target.texture.name = 'ThreeBrowser Studio RTX rgba16float storage';
    target.texture.format = THREE.RGBAFormat;
    target.texture.type = THREE.HalfFloatType;
    target.texture.colorSpace = THREE.NoColorSpace;
    target.texture.isStorageTexture = true;
    target.texture.generateMipmaps = false;
    target.texture.mipmapsAutoUpdate = false;
    this.#renderer.initRenderTarget?.(target);
    this.#target = target;

    if (!this.#presenter) this.#presenter = this.#createPresenter(target.texture);
    else {
      this.#presenter.material.map = target.texture;
      this.#presenter.material.needsUpdate = true;
    }
    this.#active = false;
    if (this.#configured) this.#reason = 'configured; awaiting a native lighting frame';
    return true;
  }

  async #renderThree(scene, camera) {
    // Studio initializes WebGPURenderer before creating this controller, so
    // the current Three.js render() path is authoritative. renderAsync() is
    // deprecated and emits native-console noise on every explicit capture.
    const result = this.#renderer.render(scene, camera);
    if (result && typeof result.then === 'function') await result;
  }

  async #renderBase(scene, camera) {
    const previousTarget = this.#renderer.getRenderTarget?.() ?? null;
    const previousOutputTarget = this.#renderer.getOutputRenderTarget();
    const previousMrt = this.#renderer.getMRT?.() ?? null;
    const shadowMap = this.#renderer.shadowMap;
    const previousShadows = shadowMap?.enabled;
    try {
      if (shadowMap && this.#settings.shadows.enabled) shadowMap.enabled = false;
      this.#renderer.setMRT?.(null);
      this.#renderer.setOutputRenderTarget(null);
      this.#renderer.setRenderTarget(this.#target);
      await this.#renderThree(scene, camera);
    } finally {
      if (shadowMap && previousShadows !== undefined) shadowMap.enabled = previousShadows;
      this.#renderer.setRenderTarget(previousTarget);
      this.#renderer.setOutputRenderTarget(previousOutputTarget);
      this.#renderer.setMRT?.(previousMrt);
    }
  }

  async #present(outputTarget) {
    const previousTarget = this.#renderer.getRenderTarget?.() ?? null;
    const previousOutputTarget = this.#renderer.getOutputRenderTarget();
    const previousMrt = this.#renderer.getMRT?.() ?? null;
    try {
      this.#renderer.setMRT?.(null);
      this.#renderer.setOutputRenderTarget(outputTarget);
      this.#renderer.setRenderTarget(outputTarget);
      await this.#renderThree(this.#presenter.scene, this.#presenter.camera);
    } finally {
      this.#renderer.setRenderTarget(previousTarget);
      this.#renderer.setOutputRenderTarget(previousOutputTarget);
      this.#renderer.setMRT?.(previousMrt);
    }
  }

  async #renderFrame({
    scene,
    camera,
    width = this.#width,
    height = this.#height,
    outputTarget = null,
  } = {}) {
    if (this.#disposed || !this.#settings.enabled || !this.#settings.lighting.enabled) return false;
    if (!this.#isSupported() || !this.#configured || this.#building || this.#stale || this.#failed) return false;
    this.resize(width, height);
    if (!this.#target || !this.#presenter) return false;

    try {
      camera?.updateMatrixWorld?.();
      await this.#renderBase(scene, camera);

      const nativeColor = this.#renderer.backend?.get?.(this.#target.texture)?.texture;
      const nativeDepth = this.#renderer.backend?.get?.(this.#target.depthTexture)?.texture;
      if (!nativeColor || !nativeDepth) {
        throw new Error('Three.js did not expose the rgba16float color and depth32float textures');
      }

      const encoder = this.#device.createCommandEncoder({ label: 'ThreeBrowser Studio RTX lighting' });
      const layouts = this.#rtx.vulkanImageLayouts;
      const result = this.#rtx.evaluateRayLighting({
        commandEncoder: encoder,
        color: textureResource(nativeColor, layouts.colorAttachment, this.#width, this.#height),
        depth: textureResource(nativeDepth, layouts.depthStencilAttachment, this.#width, this.#height),
        width: this.#width,
        height: this.#height,
        inverseViewProjection: inverseViewProjection(camera),
        cameraPosition: cameraPosition(camera),
        directionalLightDirection: this.#directionalLight.direction,
        directionalLightIntensity: this.#directionalLight.intensity,
        directionalAngularRadius: this.#settings.shadows.angularRadius,
        directionalSampleCount: this.#settings.shadows.sampleCount,
        aoSampleCount: this.#settings.ambientOcclusion.sampleCount,
        maxDistance: this.#settings.lighting.maxDistance,
        rayBias: this.#settings.lighting.rayBias,
        frameIndex: this.#frameIndex,
        shadowStrength: this.#settings.shadows.enabled ? this.#settings.shadows.strength : 0,
        aoStrength: this.#settings.ambientOcclusion.enabled ? this.#settings.ambientOcclusion.strength : 0,
        aoRadius: this.#settings.ambientOcclusion.radius,
        depthInverted: this.#settings.lighting.depthInverted,
      });
      if (result?.queued !== true) throw new Error(result?.reason || 'native ray lighting dispatch was rejected');
      const commandBuffer = encoder.finish();
      this.#device.queue.submit([commandBuffer]);
      await this.#present(outputTarget);
      this.#frameIndex += 1;
      this.#active = true;
      this.#failed = false;
      this.#reason = 'active';
      return true;
    } catch (error) {
      this.#active = false;
      this.#failed = true;
      this.#reason = `native lighting frame failed: ${error?.message ?? String(error)}`;
      return false;
    }
  }

  render(options = {}) {
    // The live viewport and explicit evidence capture can request different
    // sizes at the same time. Serialize their native attachment lifecycle so
    // one frame cannot resize/dispose a texture while another command encoder
    // is still copying it to a differently sized destination.
    return this.#enqueueGpu(() => this.#renderFrame(options));
  }

  dispose() {
    if (this.#disposed) return;
    this.#cancelBuild();
    try {
      this.#destroyRegistration();
    } catch {
      // Disposal must release the local renderer resources even if native teardown fails.
    }
    this.#disposeTarget();
    this.#presenter?.geometry?.dispose?.();
    this.#presenter?.material?.dispose?.();
    this.#presenter = null;
    this.#configured = false;
    this.#active = false;
    this.#stale = false;
    this.#failed = false;
    this.#reason = 'disposed';
    this.#staticSceneStats = null;
    this.#disposed = true;
  }
}

export function createRtxLightingController(options) {
  return new RtxLightingController(options);
}
