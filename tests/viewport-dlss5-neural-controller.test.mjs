import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_DLSS5_SETTINGS,
  DLSS5_STYLE_VALUES,
  createDlss5NeuralController,
  normalizeDlss5Settings,
} from '../src/viewport/dlss5-neural-controller.mjs';

const IDENTITY = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function makeThree(targets) {
  class Matrix4 {
    constructor(elements = IDENTITY) {
      this.elements = [...elements];
    }

    copy(other) {
      this.elements = [...other.elements];
      return this;
    }

    invert() { return this; }

    multiplyMatrices(left) {
      this.elements = [...left.elements];
      return this;
    }

    multiply() { return this; }

    clone() { return new Matrix4(this.elements); }

    transpose() {
      const source = [...this.elements];
      for (let row = 0; row < 4; row += 1) {
        for (let column = 0; column < 4; column += 1) {
          this.elements[(row * 4) + column] = source[(column * 4) + row];
        }
      }
      return this;
    }

    toArray() { return [...this.elements]; }
  }

  class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
      Object.assign(this, { x, y, z });
    }

    set(x, y, z) {
      Object.assign(this, { x, y, z });
      return this;
    }

    setFromMatrixColumn(matrix, index) {
      const offset = index * 4;
      return this.set(
        matrix.elements[offset] ?? 0,
        matrix.elements[offset + 1] ?? 0,
        matrix.elements[offset + 2] ?? 0,
      );
    }

    normalize() {
      const length = Math.hypot(this.x, this.y, this.z) || 1;
      this.x /= length;
      this.y /= length;
      this.z /= length;
      return this;
    }

    toArray() { return [this.x, this.y, this.z]; }
  }

  class RenderTarget {
    constructor(width, height, options) {
      this.width = width;
      this.height = height;
      this.options = options;
      this.texture = { native: null, disposed: false };
      this.disposed = false;
      targets.push(this);
    }

    dispose() {
      this.disposed = true;
      this.texture.disposed = true;
    }
  }

  return {
    Matrix4,
    Vector3,
    RenderTarget,
    RGBAFormat: 'rgba16f-compatible',
    HalfFloatType: 'half-float',
    NoColorSpace: 'no-color-space',
  };
}

function makeCamera(THREE) {
  return {
    matrixWorld: new THREE.Matrix4(),
    matrixWorldInverse: new THREE.Matrix4(),
    projectionMatrix: new THREE.Matrix4(Array.from({ length: 16 }, (_, index) => index + 1)),
    projectionMatrixInverse: new THREE.Matrix4(),
    near: 0.25,
    far: 25_000,
    fov: 62,
    aspect: 16 / 9,
    isOrthographicCamera: false,
    updateMatrixWorld() {},
    getWorldPosition(target) { return target.set(4, 5, 6); },
    getWorldDirection(target) { return target.set(0, 0, -1); },
  };
}

function makeHarness({
  apiLoaded = true,
  supported = true,
  methodAvailable = true,
  evaluationResult = { queued: true },
  activateOnEvaluate = true,
  layouts = true,
  exposeNativeOutput = true,
  viewport = 73,
} = {}) {
  const targets = [];
  const evaluations = [];
  const releases = [];
  const encoders = [];
  const clearPasses = [];
  const submissions = [];
  const THREE = makeThree(targets);
  const feature = {
    supported,
    active: false,
    failed: false,
    reason: null,
    evaluationCount: 0,
    failureCount: 0,
    lastResult: 0,
  };
  const queue = {
    submit(buffers) { submissions.push(buffers); },
  };
  const device = {
    queue,
    createCommandEncoder({ label }) {
      let finished = false;
      const encoder = {
        label,
        get finished() { return finished; },
        beginRenderPass(descriptor) {
          const pass = { descriptor, ended: false };
          clearPasses.push(pass);
          return {
            end() { pass.ended = true; },
          };
        },
        finish() {
          assert.equal(finished, false);
          finished = true;
          return { label: `${label}:finished` };
        },
      };
      encoders.push(encoder);
      return encoder;
    },
  };
  const renderer = {
    backend: {
      device,
      get(texture) {
        return texture?.native ? { texture: texture.native } : null;
      },
    },
    initRenderTarget(target) {
      if (!exposeNativeOutput) return;
      target.texture.native = {
        name: `native-output-${targets.indexOf(target)}`,
        createView() { return { name: `output-view-${targets.indexOf(target)}` }; },
      };
    },
  };
  const TSL = {
    output: { name: 'output' },
    velocity: { name: 'velocity' },
    mrt(value) { return { kind: 'mrt', value }; },
  };
  const rtx = {
    capabilities: {
      dlssNeuralRendering: supported,
      dlssNeuralRenderingApiLoaded: apiLoaded,
      status: supported ? 'supported' : 'unsupported by fake',
    },
    vulkanImageLayouts: layouts ? {
      colorAttachment: 'VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL',
      depthStencilAttachment: 'VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL',
    } : {},
    getStatus() {
      return { features: { dlssNeuralRendering: feature } };
    },
    releaseViewport(value) { releases.push(value); },
  };
  if (methodAvailable) {
    rtx.evaluateNeuralRendering = payload => {
      assert.equal(payload.commandEncoder.finished, false);
      evaluations.push(payload);
      const result = typeof evaluationResult === 'function'
        ? evaluationResult(payload, feature)
        : evaluationResult;
      if (result === true || result?.queued === true) {
        feature.evaluationCount += 1;
        feature.lastResult = 1;
        feature.active = activateOnEvaluate;
      }
      return result;
    };
  }
  const controller = createDlss5NeuralController({ THREE, TSL, renderer, rtx, viewport });
  return {
    THREE,
    TSL,
    controller,
    renderer,
    rtx,
    feature,
    targets,
    evaluations,
    releases,
    encoders,
    clearPasses,
    submissions,
    viewport,
  };
}

test('DLSS 5 normalizer exposes and accepts only styles 0, 1, and 2', () => {
  assert.deepEqual(DLSS5_STYLE_VALUES, [0, 1, 2]);
  assert.ok(Object.isFrozen(DLSS5_STYLE_VALUES));
  assert.equal(DEFAULT_DLSS5_SETTINGS.style, 0);

  for (const style of DLSS5_STYLE_VALUES) {
    const settings = normalizeDlss5Settings({ style });
    assert.equal(settings.style, style);
    assert.ok(Object.isFrozen(settings));
  }
  for (const style of [-1, 3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => normalizeDlss5Settings({ style }),
      /style must be exactly 0, 1, or 2/,
    );
  }
  assert.throws(
    () => normalizeDlss5Settings({ performanceMode: 'quality' }),
    /same-resolution DLAA mode/,
  );
});

test('unavailable DLSS capability fails closed without allocating or evaluating', () => {
  const harness = makeHarness({ apiLoaded: false });
  harness.controller.setSettings({ enabled: true, style: 1 });
  assert.equal(harness.controller.resize(1280, 720), true);
  const output = harness.controller.evaluate({
    color: { name: 'color' },
    depth: { name: 'depth' },
    motionVectors: { name: 'motion' },
    camera: makeCamera(harness.THREE),
    width: 1280,
    height: 720,
  });

  assert.equal(output, null);
  assert.equal(harness.targets.length, 0);
  assert.equal(harness.evaluations.length, 0);
  assert.equal(harness.controller.outputTexture, null);
  assert.deepEqual(harness.controller.getStatus(), {
    supported: true,
    apiLoaded: false,
    methodAvailable: true,
    available: false,
    requested: true,
    configured: false,
    active: false,
    failed: false,
    reason: 'The signed DLSS Neural Rendering plug-in API is unavailable.',
    evaluationCount: 0,
    failureCount: 0,
    lastResult: 0,
    controls: {
      styles: [0, 1, 2],
      performanceModes: ['dlaa'],
    },
    settings: normalizeDlss5Settings({ enabled: true, style: 1 }),
  });
});

test('accepted evaluation uses a separate RGBA16F output and complete native payload', () => {
  const harness = makeHarness({ viewport: 1705 });
  harness.controller.setSettings({
    enabled: true,
    style: 2,
    performanceMode: 'dlaa',
    intensity: 0.8,
    useAutoMask: false,
  });
  const color = { name: 'authored-color' };
  const depth = { name: 'authored-depth' };
  const motionVectors = { name: 'authored-motion-vectors' };
  const output = harness.controller.evaluate({
    color,
    depth,
    motionVectors,
    camera: makeCamera(harness.THREE),
    width: 1920,
    height: 1080,
  });

  assert.equal(harness.targets.length, 1);
  const [target] = harness.targets;
  assert.equal(output, target.texture);
  assert.equal(harness.controller.outputTexture, target.texture);
  assert.notEqual(output, color);
  assert.deepEqual(target.options, {
    format: harness.THREE.RGBAFormat,
    type: harness.THREE.HalfFloatType,
    colorSpace: harness.THREE.NoColorSpace,
    depthBuffer: false,
    stencilBuffer: false,
    samples: 0,
    generateMipmaps: false,
  });
  assert.equal(target.texture.isStorageTexture, true);
  assert.equal(target.texture.format, harness.THREE.RGBAFormat);
  assert.equal(target.texture.type, harness.THREE.HalfFloatType);

  assert.equal(harness.evaluations.length, 1);
  const [payload] = harness.evaluations;
  assert.equal(payload.viewport, 1705);
  assert.equal(payload.colorInput.texture, color);
  assert.equal(payload.colorOutput.texture, target.texture.native);
  assert.notEqual(payload.colorOutput.texture, color);
  assert.equal(payload.depth.texture, depth);
  assert.equal(payload.motionVectors.texture, motionVectors);
  assert.equal(payload.colorInput.layout, 'VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL');
  assert.equal(payload.colorOutput.layout, 'VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL');
  assert.equal(payload.depth.layout, 'VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL');
  assert.equal(payload.motionVectors.layout, 'VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL');
  for (const resource of [payload.colorInput, payload.colorOutput, payload.depth, payload.motionVectors]) {
    assert.equal(resource.width, 1920);
    assert.equal(resource.height, 1080);
    assert.equal(resource.left, 0);
    assert.equal(resource.top, 0);
  }
  assert.equal(payload.options.style, 2);
  assert.equal(payload.options.performanceMode, 6);
  assert.equal(payload.options.renderPreset, 0);
  assert.equal(payload.options.intensity, 0.8);
  assert.equal(payload.options.useAutoMask, false);
  assert.deepEqual(payload.constants.cameraPosition, [4, 5, 6]);
  assert.deepEqual(payload.constants.cameraForward, [0, 0, -1]);
  assert.deepEqual(payload.constants.motionVectorScale, [0.5, -0.5]);
  assert.equal(payload.constants.cameraNear, 0.25);
  assert.equal(payload.constants.cameraFar, 25_000);
  assert.equal(payload.constants.reset, true);
  assert.equal(payload.constants.cameraViewToClip.length, 16);
  assert.equal(payload.constants.clipToPrevClip.length, 16);

  assert.equal(harness.clearPasses.length, 1);
  assert.equal(harness.clearPasses[0].ended, true);
  assert.equal(harness.submissions.length, 2, 'clear and DLSS evaluation submit separately');
  const status = harness.controller.getStatus();
  assert.equal(status.configured, true);
  assert.equal(status.active, true);
  assert.equal(status.failed, false);
  assert.equal(status.evaluationCount, 1);
});

test('frame constants use Streamline row-major matrices and valid orthographic metadata', () => {
  const harness = makeHarness();
  harness.controller.setSettings({ enabled: true });
  const camera = makeCamera(harness.THREE);
  camera.isOrthographicCamera = true;
  camera.fov = undefined;
  const output = harness.controller.evaluate({
    color: { name: 'color' },
    depth: { name: 'depth' },
    motionVectors: { name: 'motion' },
    camera,
    width: 640,
    height: 360,
  });

  assert.ok(output);
  const constants = harness.evaluations[0].constants;
  assert.deepEqual(constants.cameraViewToClip, [
    1, 5, 9, 13,
    2, 6, 10, 14,
    3, 7, 11, 15,
    4, 8, 12, 16,
  ]);
  assert.deepEqual(constants.cameraForward, [0, 0, -1]);
  assert.deepEqual(constants.motionVectorScale, [0.5, -0.5]);
  assert.equal(constants.orthographicProjection, true);
  assert.equal(constants.cameraFov, Math.PI / 2);
});

test('native evaluation failure returns raster fallback and latches DLSS off', () => {
  const harness = makeHarness({
    evaluationResult: { queued: false, reason: 'fake native rejection' },
  });
  harness.controller.setSettings({ enabled: true });
  const inputs = {
    color: { name: 'color' },
    depth: { name: 'depth' },
    motionVectors: { name: 'motion' },
    camera: makeCamera(harness.THREE),
    width: 800,
    height: 450,
  };

  assert.equal(harness.controller.evaluate(inputs), null);
  assert.equal(harness.evaluations.length, 1);
  const status = harness.controller.getStatus();
  assert.equal(status.active, false);
  assert.equal(status.failed, true);
  assert.match(status.reason, /DLSS 5 disabled after evaluation failure: fake native rejection/);
  assert.equal(harness.controller.evaluate(inputs), null);
  assert.equal(harness.evaluations.length, 1, 'latched failure cannot repeatedly call the native plug-in');
});

test('resize, disable, and dispose release viewport state and output targets', () => {
  const harness = makeHarness({ viewport: 92 });
  harness.controller.setSettings({ enabled: true });

  assert.equal(harness.controller.resize(320, 180), true);
  const first = harness.targets[0];
  assert.equal(first.disposed, false);
  assert.equal(harness.controller.resize(320, 180), false);
  assert.equal(harness.releases.length, 1);

  assert.equal(harness.controller.resize(640, 360), true);
  const second = harness.targets[1];
  assert.equal(first.disposed, true);
  assert.equal(second.disposed, false);
  assert.deepEqual(harness.releases, [92, 92]);

  harness.controller.setSettings({ enabled: false });
  assert.equal(second.disposed, true);
  assert.equal(harness.controller.outputTexture, null);
  assert.equal(harness.controller.getStatus().configured, false);
  assert.deepEqual(harness.releases, [92, 92, 92]);

  harness.controller.setSettings({ enabled: true });
  assert.equal(harness.controller.resize(640, 360), true);
  const third = harness.targets[2];
  assert.equal(third.disposed, false);
  harness.controller.dispose();
  assert.equal(third.disposed, true);
  assert.equal(harness.controller.outputTexture, null);
  assert.deepEqual(harness.releases, [92, 92, 92, 92, 92]);
  harness.controller.dispose();
  assert.deepEqual(harness.releases, [92, 92, 92, 92, 92], 'dispose is idempotent');
});
