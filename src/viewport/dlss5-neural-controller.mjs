const STYLE_VALUES = Object.freeze([0, 1, 2]);
const STYLE_SET = new Set(STYLE_VALUES);
const PERFORMANCE_MODES = Object.freeze({
  dlaa: 6,
});

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  intensity: 1,
  localToneStrength: 1,
  localStructureStrength: 1,
  globalToneStrength: 1,
  skinStructureStrength: -1,
  style: 0,
  performanceMode: 'dlaa',
  useAutoMask: true,
});

const SETTING_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum, fallback) {
  return Math.min(maximum, Math.max(minimum, finite(value, fallback)));
}

function freeze(value) {
  return Object.freeze(value);
}

export const DLSS5_STYLE_VALUES = STYLE_VALUES;
export const DEFAULT_DLSS5_SETTINGS = DEFAULT_SETTINGS;

export function normalizeDlss5Settings(value = {}, previous = DEFAULT_SETTINGS) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('DLSS 5 settings must be an object.');
  }
  for (const key of Object.keys(value)) {
    if (!SETTING_KEYS.has(key)) throw new TypeError(`Unknown DLSS 5 setting ${key}.`);
  }
  const source = { ...DEFAULT_SETTINGS, ...previous, ...value };
  const style = Math.trunc(Number(source.style));
  if (!Number.isInteger(Number(source.style)) || !STYLE_SET.has(style)) {
    throw new RangeError('DLSS 5 style must be exactly 0, 1, or 2.');
  }
  const performanceMode = String(source.performanceMode).trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!(performanceMode in PERFORMANCE_MODES)) {
    throw new RangeError('Studio DLSS 5 currently requires same-resolution DLAA mode.');
  }
  return freeze({
    enabled: Boolean(source.enabled),
    intensity: clamp(source.intensity, 0, 1, DEFAULT_SETTINGS.intensity),
    localToneStrength: clamp(source.localToneStrength, -1, 1, DEFAULT_SETTINGS.localToneStrength),
    localStructureStrength: clamp(
      source.localStructureStrength,
      -1,
      1,
      DEFAULT_SETTINGS.localStructureStrength,
    ),
    globalToneStrength: clamp(source.globalToneStrength, 0, 1, DEFAULT_SETTINGS.globalToneStrength),
    skinStructureStrength: clamp(
      source.skinStructureStrength,
      -1,
      1,
      DEFAULT_SETTINGS.skinStructureStrength,
    ),
    style,
    performanceMode,
    useAutoMask: Boolean(source.useAutoMask),
  });
}

function capabilitySnapshot(rtx, guideRuntimeAvailable) {
  let capabilities = {};
  try {
    capabilities = rtx?.capabilities ?? {};
  } catch {
    capabilities = {};
  }
  const supported = capabilities.dlssNeuralRendering === true;
  const apiLoaded = capabilities.dlssNeuralRenderingApiLoaded === true;
  const methodAvailable = typeof rtx?.evaluateNeuralRendering === 'function';
  const available = supported && apiLoaded && methodAvailable && guideRuntimeAvailable;
  const reason = available
    ? null
    : !guideRuntimeAvailable
      ? 'Studio motion-vector MRT support is unavailable.'
      : !supported
        ? 'Runtime/GPU unsupported.'
        : !apiLoaded
          ? 'The signed DLSS Neural Rendering plug-in API is unavailable.'
          : 'The runtime does not expose DLSS Neural Rendering evaluation.';
  return { supported, apiLoaded, methodAvailable, available, reason };
}

function liveFeature(rtx) {
  try {
    return rtx?.getStatus?.()?.features?.dlssNeuralRendering ?? null;
  } catch {
    return null;
  }
}

function resource(texture, layout, width, height) {
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

function rowMajor(matrix) {
  return matrix.clone().transpose().toArray();
}

export class Dlss5NeuralController {
  #THREE;
  #TSL;
  #renderer;
  #rtx;
  #device;
  #settings = DEFAULT_SETTINGS;
  #mrt = null;
  #outputTarget = null;
  #outputNative = null;
  #width = 1;
  #height = 1;
  #viewport = 1705;
  #disposed = false;
  #configured = false;
  #active = false;
  #failed = false;
  #reason = 'DLSS 5 is disabled.';
  #reset = true;
  #lastFailureCount = 0;
  #viewProjection;
  #inverseViewProjection;
  #previousViewProjection;
  #clipToPreviousClip;
  #previousClipToClip;
  #identity;
  #cameraPosition;
  #cameraUp;
  #cameraRight;
  #cameraForward;

  constructor({ THREE, TSL, renderer, rtx, viewport = 1705 } = {}) {
    this.#THREE = THREE;
    this.#TSL = TSL;
    this.#renderer = renderer;
    this.#rtx = rtx;
    this.#device = renderer?.backend?.device ?? null;
    this.#viewport = Math.max(0, Math.trunc(finite(viewport, 1705)));
    this.#viewProjection = new THREE.Matrix4();
    this.#inverseViewProjection = new THREE.Matrix4();
    this.#previousViewProjection = new THREE.Matrix4();
    this.#clipToPreviousClip = new THREE.Matrix4();
    this.#previousClipToClip = new THREE.Matrix4();
    this.#identity = new THREE.Matrix4();
    this.#cameraPosition = new THREE.Vector3();
    this.#cameraUp = new THREE.Vector3();
    this.#cameraRight = new THREE.Vector3();
    this.#cameraForward = new THREE.Vector3();
    if (typeof TSL?.mrt === 'function' && TSL.output && TSL.velocity) {
      this.#mrt = TSL.mrt({ output: TSL.output, velocity: TSL.velocity });
    }
    this.#syncAvailability();
  }

  #guideRuntimeAvailable() {
    return Boolean(this.#mrt && this.#device?.createCommandEncoder && this.#THREE?.RenderTarget);
  }

  #syncAvailability() {
    const capability = capabilitySnapshot(this.#rtx, this.#guideRuntimeAvailable());
    if (!this.#settings.enabled) {
      this.#reason = capability.available ? 'DLSS 5 is disabled.' : capability.reason;
      return capability;
    }
    if (!capability.available) {
      this.#configured = false;
      this.#active = false;
      this.#reason = capability.reason;
    }
    return capability;
  }

  get settings() { return this.#settings; }
  get mrt() { return this.#mrt; }
  get requested() { return this.#settings.enabled; }
  get outputTexture() { return this.#outputTarget?.texture ?? null; }

  setSettings(value = {}) {
    const previous = this.#settings;
    const next = normalizeDlss5Settings(value, previous);
    const changed = JSON.stringify(next) !== JSON.stringify(previous);
    this.#settings = next;
    if (changed) {
      this.#reset = true;
      this.#failed = false;
      this.#active = false;
      if (!next.enabled) {
        this.#releaseViewport();
        this.#disposeTarget();
      }
    }
    this.#syncAvailability();
    return this.#settings;
  }

  #releaseViewport() {
    try {
      this.#rtx?.releaseViewport?.(this.#viewport);
    } catch {
      // Optional runtime cleanup must not break raster/RTX presentation.
    }
  }

  #disposeTarget() {
    this.#outputTarget?.dispose?.();
    this.#outputTarget = null;
    this.#outputNative = null;
    this.#configured = false;
  }

  resize(width, height) {
    const nextWidth = Math.max(1, Math.trunc(finite(width, this.#width)));
    const nextHeight = Math.max(1, Math.trunc(finite(height, this.#height)));
    if (this.#outputTarget && nextWidth === this.#width && nextHeight === this.#height) return false;
    this.#width = nextWidth;
    this.#height = nextHeight;
    this.#releaseViewport();
    this.#disposeTarget();
    this.#reset = true;
    this.#active = false;
    if (!this.#settings.enabled || !this.#syncAvailability().available || this.#disposed) return true;

    const THREE = this.#THREE;
    const target = new THREE.RenderTarget(nextWidth, nextHeight, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: false,
      stencilBuffer: false,
      samples: 0,
      generateMipmaps: false,
    });
    target.texture.name = 'ThreeBrowser Studio DLSS 5 neural output';
    target.texture.format = THREE.RGBAFormat;
    target.texture.type = THREE.HalfFloatType;
    target.texture.colorSpace = THREE.NoColorSpace;
    target.texture.isStorageTexture = true;
    target.texture.generateMipmaps = false;
    target.texture.mipmapsAutoUpdate = false;
    this.#renderer.initRenderTarget?.(target);
    const native = this.#renderer.backend?.get?.(target.texture)?.texture ?? null;
    if (!native) {
      target.dispose?.();
      this.#failed = true;
      this.#reason = 'Three.js did not expose the DLSS 5 rgba16float output texture.';
      return true;
    }
    this.#outputTarget = target;
    this.#outputNative = native;
    this.#configured = true;
    this.#reason = 'DLSS 5 is configured; awaiting evaluation.';
    return true;
  }

  #frameConstants(camera) {
    camera.updateMatrixWorld?.();
    camera.matrixWorldInverse?.copy?.(camera.matrixWorld)?.invert?.();
    this.#viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.#inverseViewProjection.copy(this.#viewProjection).invert();
    if (this.#reset) this.#previousViewProjection.copy(this.#viewProjection);
    this.#clipToPreviousClip.copy(this.#previousViewProjection).multiply(this.#inverseViewProjection);
    this.#previousClipToClip
      .copy(this.#viewProjection)
      .multiply(this.#previousViewProjection.clone().invert());
    camera.getWorldPosition?.(this.#cameraPosition);
    this.#cameraRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    this.#cameraUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    camera.getWorldDirection?.(this.#cameraForward);
    this.#cameraForward.normalize();
    return {
      cameraViewToClip: rowMajor(camera.projectionMatrix),
      clipToCameraView: rowMajor(camera.projectionMatrixInverse),
      clipToLensClip: rowMajor(this.#identity),
      clipToPrevClip: rowMajor(this.#clipToPreviousClip),
      prevClipToClip: rowMajor(this.#previousClipToClip),
      jitterOffset: [0, 0],
      // Three's velocity node emits currentNDC - previousNDC. Streamline
      // expects normalized UV motion, including the NDC-to-texture Y flip.
      motionVectorScale: [0.5, -0.5],
      cameraPinholeOffset: [0, 0],
      cameraPosition: this.#cameraPosition.toArray(),
      cameraUp: this.#cameraUp.toArray(),
      cameraRight: this.#cameraRight.toArray(),
      cameraForward: this.#cameraForward.toArray(),
      cameraNear: finite(camera.near, 0.1),
      cameraFar: finite(camera.far, 10_000),
      // Streamline ignores FOV for an orthographic projection, but the shared
      // runtime contract still requires a finite positive value.
      cameraFov: camera.isOrthographicCamera
        ? Math.PI / 2
        : finite(camera.fov, 50) * Math.PI / 180,
      cameraAspectRatio: finite(camera.aspect, this.#width / this.#height),
      depthInverted: false,
      cameraMotionIncluded: true,
      motionVectors3D: false,
      reset: this.#reset,
      orthographicProjection: Boolean(camera.isOrthographicCamera),
      motionVectorsDilated: false,
      motionVectorsJittered: false,
    };
  }

  #clearOutput() {
    const view = this.#outputNative?.createView?.();
    if (!view) return;
    const encoder = this.#device.createCommandEncoder({ label: 'ThreeBrowser Studio DLSS 5 output clear' });
    const pass = encoder.beginRenderPass({
      label: 'ThreeBrowser Studio DLSS 5 output clear',
      colorAttachments: [{
        view,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.end();
    this.#device.queue.submit([encoder.finish()]);
  }

  evaluate({ color, depth, motionVectors, camera, width = this.#width, height = this.#height } = {}) {
    if (this.#disposed || !this.#settings.enabled || this.#failed) return null;
    const capability = this.#syncAvailability();
    if (!capability.available || !color || !depth || !motionVectors || !camera) return null;
    this.resize(width, height);
    if (!this.#configured || !this.#outputNative) return null;

    try {
      this.#clearOutput();
      const layouts = this.#rtx?.vulkanImageLayouts ?? {};
      if (!layouts.colorAttachment || !layouts.depthStencilAttachment) {
        throw new Error('DLSS 5 Vulkan image layouts are unavailable.');
      }
      const before = liveFeature(this.#rtx);
      const beforeFailures = Number(before?.failureCount ?? this.#lastFailureCount);
      const encoder = this.#device.createCommandEncoder({ label: 'ThreeBrowser Studio DLSS 5 Neural Rendering' });
      const result = this.#rtx.evaluateNeuralRendering({
        commandEncoder: encoder,
        viewport: this.#viewport,
        colorInput: resource(color, layouts.colorAttachment, this.#width, this.#height),
        colorOutput: resource(this.#outputNative, layouts.colorAttachment, this.#width, this.#height),
        depth: resource(depth, layouts.depthStencilAttachment, this.#width, this.#height),
        motionVectors: resource(motionVectors, layouts.colorAttachment, this.#width, this.#height),
        options: {
          ...this.#settings,
          renderPreset: 0,
          performanceMode: PERFORMANCE_MODES[this.#settings.performanceMode],
        },
        constants: this.#frameConstants(camera),
      });
      if (result !== true && result?.queued !== true) {
        throw new Error(result?.reason || 'The runtime rejected DLSS 5 evaluation.');
      }
      this.#device.queue.submit([encoder.finish()]);
      const feature = liveFeature(this.#rtx);
      const failures = Number(feature?.failureCount ?? beforeFailures);
      this.#lastFailureCount = failures;
      if (failures > beforeFailures || feature?.failed === true) {
        throw new Error(feature?.reason || 'DLSS 5 evaluation failed.');
      }
      this.#previousViewProjection.copy(this.#viewProjection);
      this.#reset = false;
      this.#active = true;
      this.#failed = false;
      this.#reason = feature?.active === true
        ? (feature?.reason || 'DLSS 5 Neural Rendering is active.')
        : 'DLSS 5 evaluation was accepted; awaiting live runtime status.';
      return this.#outputTarget.texture;
    } catch (error) {
      this.#active = false;
      this.#failed = true;
      this.#reason = `DLSS 5 disabled after evaluation failure: ${error?.message ?? String(error)}`;
      return null;
    }
  }

  getStatus() {
    const capability = capabilitySnapshot(this.#rtx, this.#guideRuntimeAvailable());
    const feature = liveFeature(this.#rtx);
    return freeze({
      supported: capability.supported,
      apiLoaded: capability.apiLoaded,
      methodAvailable: capability.methodAvailable,
      available: capability.available,
      requested: this.#settings.enabled,
      configured: this.#configured,
      active: this.#active && feature?.active === true,
      failed: this.#failed,
      reason: this.#reason ?? capability.reason,
      evaluationCount: Number(feature?.evaluationCount ?? 0),
      failureCount: Number(feature?.failureCount ?? this.#lastFailureCount),
      lastResult: Number(feature?.lastResult ?? 0),
      controls: freeze({
        styles: STYLE_VALUES,
        performanceModes: freeze(Object.keys(PERFORMANCE_MODES)),
      }),
      settings: this.#settings,
    });
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#releaseViewport();
    this.#disposeTarget();
    this.#active = false;
  }
}

export function createDlss5NeuralController(options) {
  return new Dlss5NeuralController(options);
}
