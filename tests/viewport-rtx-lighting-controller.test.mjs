import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_RTX_LIGHTING_SETTINGS,
  createRtxLightingController,
  normalizeRtxLightingSettings,
  selectStrongestDirectionalLight,
} from '../src/viewport/rtx-lighting-controller.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeThree(targets = [], materials = []) {
  class Texture {
    constructor() {
      this.name = '';
      this.native = null;
      this.disposed = false;
    }
  }

  class DepthTexture extends Texture {
    constructor(width, height, type) {
      super();
      this.width = width;
      this.height = height;
      this.type = type;
    }
  }

  class RenderTarget {
    constructor(width, height, options) {
      this.width = width;
      this.height = height;
      this.options = options;
      this.texture = new Texture();
      this.depthTexture = options.depthTexture;
      this.disposed = false;
      targets.push(this);
    }

    dispose() {
      this.disposed = true;
      this.texture.disposed = true;
      this.depthTexture.disposed = true;
    }
  }

  class PlaneGeometry {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.disposed = false;
    }

    dispose() {
      this.disposed = true;
    }
  }

  class MeshBasicMaterial {
    constructor(options) {
      Object.assign(this, options);
      this.disposed = false;
      this.needsUpdate = false;
      materials.push(this);
    }

    dispose() {
      this.disposed = true;
    }
  }

  class Mesh {
    constructor(geometry, material) {
      this.geometry = geometry;
      this.material = material;
      this.scale = { x: 1, y: 1, z: 1 };
      this.frustumCulled = true;
    }
  }

  class Scene {
    constructor() {
      this.children = [];
      this.name = '';
    }

    add(value) {
      this.children.push(value);
    }
  }

  class OrthographicCamera {
    constructor(left, right, top, bottom, near, far) {
      Object.assign(this, { left, right, top, bottom, near, far });
      this.position = { z: 0 };
    }

    updateProjectionMatrix() {}
  }

  return {
    Texture,
    DepthTexture,
    RenderTarget,
    PlaneGeometry,
    MeshBasicMaterial,
    Mesh,
    Scene,
    OrthographicCamera,
    FloatType: 'float',
    HalfFloatType: 'half-float',
    DepthFormat: 'depth',
    RGBAFormat: 'rgba',
    LinearSRGBColorSpace: 'linear-srgb',
    NoColorSpace: 'none',
  };
}

function makeCamera() {
  const matrix = {
    elements: [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      4, 5, 6, 1,
    ],
  };
  return {
    matrixWorld: matrix,
    projectionMatrixInverse: {
      clone() {
        return {
          premultiply(value) {
            assert.equal(value, matrix);
            return this;
          },
          toArray() {
            return Array.from({ length: 16 }, (_, index) => index + 1);
          },
        };
      },
    },
    updateMatrixWorld() {},
  };
}

function multiplyMatrixVector(matrix, vector) {
  return Array.from({ length: 4 }, (_, row) => (
    matrix[row] * vector[0]
    + matrix[4 + row] * vector[1]
    + matrix[8 + row] * vector[2]
    + matrix[12 + row] * vector[3]
  ));
}

function multiplyMatrices(left, right) {
  const result = Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let index = 0; index < 4; index += 1) {
        result[column * 4 + row] += left[index * 4 + row] * right[column * 4 + index];
      }
    }
  }
  return result;
}

function numericMatrix(elements) {
  return {
    elements: [...elements],
    clone() {
      return numericMatrix(this.elements);
    },
    premultiply(value) {
      this.elements = multiplyMatrices(value.elements, this.elements);
      return this;
    },
    toArray() {
      return [...this.elements];
    },
  };
}

function makeNumericCamera() {
  return {
    matrixWorld: numericMatrix([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      4, 5, 6, 1,
    ]),
    projectionMatrixInverse: numericMatrix([
      2, 0, 0, 0,
      0, 3, 0, 0,
      0, 0, 4, 0,
      0, 0, 0, 1,
    ]),
    updateMatrixWorld() {},
  };
}

function triangleScene(overrides = {}) {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    directionalLights: [
      { direction: [1, 0, 0], intensity: 1 },
      { direction: [0, -2, 0], intensity: 3 },
    ],
    lights: new Float32Array(16).fill(0.5),
    ...overrides,
  };
}

function makeHarness({
  settings = { enabled: true },
  collectScene = async () => triangleScene(),
  registerQueued = true,
  evaluateQueued = true,
  capability = true,
  featureSupported = true,
  featureActive,
  normalizeSettings,
} = {}) {
  const events = [];
  const renderStates = [];
  const presenterScales = [];
  const presenterBindings = [];
  const compiledPresenterBindings = new Map();
  const targets = [];
  const materials = [];
  const THREE = makeThree(targets, materials);
  const queue = {
    submissions: [],
    submit(commandBuffers) {
      events.push('queue:submit');
      this.submissions.push(commandBuffers);
    },
  };
  const device = {
    queue,
    createCommandEncoder({ label }) {
      events.push('encoder:create');
      let finished = false;
      return {
        label,
        get finished() { return finished; },
        finish() {
          assert.equal(finished, false);
          finished = true;
          events.push('encoder:finish');
          return { label: `${label}:finished` };
        },
      };
    },
  };
  const renderer = {
    backend: {
      device,
      get(texture) {
        return texture?.native ? { texture: texture.native } : null;
      },
    },
    shadowMap: { enabled: true },
    currentTarget: null,
    currentOutputTarget: null,
    currentMrt: null,
    initRenderTarget(target) {
      events.push('target:init');
      target.texture.native = { name: `native-color-${targets.indexOf(target)}` };
      target.depthTexture.native = { name: `native-depth-${targets.indexOf(target)}` };
    },
    getRenderTarget() {
      return this.currentTarget;
    },
    setRenderTarget(target) {
      this.currentTarget = target;
      events.push(target ? `target:${target.name ?? 'offscreen'}` : 'target:canvas');
    },
    getOutputRenderTarget() {
      return this.currentOutputTarget;
    },
    setOutputRenderTarget(target) {
      this.currentOutputTarget = target;
      events.push(target ? `output:${target.name ?? 'target'}` : 'output:canvas');
    },
    getMRT() {
      return this.currentMrt;
    },
    setMRT(value) {
      this.currentMrt = value;
      events.push(value === null ? 'mrt:none' : 'mrt:restore');
    },
    render(scene) {
      if (scene?.name === 'ThreeBrowser Studio RTX presentation') {
        const quad = scene.children[0];
        presenterScales.push(quad?.scale?.y);
        if (!compiledPresenterBindings.has(quad.material)) {
          compiledPresenterBindings.set(quad.material, quad.material?.map ?? null);
        }
        presenterBindings.push(compiledPresenterBindings.get(quad.material));
      }
      renderStates.push({
        scene: scene?.name || 'authored',
        shadows: this.shadowMap.enabled,
        target: this.currentTarget,
        outputTarget: this.currentOutputTarget,
      });
      events.push(`render:${scene?.name || 'authored'}:shadows=${this.shadowMap.enabled}`);
    },
    async renderAsync(scene) {
      if (scene?.name === 'ThreeBrowser Studio RTX presentation') {
        const quad = scene.children[0];
        presenterScales.push(quad?.scale?.y);
        if (!compiledPresenterBindings.has(quad.material)) {
          compiledPresenterBindings.set(quad.material, quad.material?.map ?? null);
        }
        presenterBindings.push(compiledPresenterBindings.get(quad.material));
      }
      renderStates.push({
        scene: scene?.name || 'authored',
        shadows: this.shadowMap.enabled,
        target: this.currentTarget,
        outputTarget: this.currentOutputTarget,
      });
      events.push(`render:${scene?.name || 'authored'}:shadows=${this.shadowMap.enabled}`);
    },
  };
  const rtx = {
    capabilities: { nativeRayTracing: capability },
    vulkanImageLayouts: {
      colorAttachment: 'VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL',
      depthStencilAttachment: 'VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL',
    },
    registered: false,
    registrations: [],
    evaluations: [],
    destroyCount: 0,
    getStatus() {
      events.push('rtx:status');
      return {
        features: {
          nativeRayTracing: {
            supported: featureSupported,
            active: featureActive ?? this.registered,
          },
        },
      };
    },
    registerStaticScene(payload) {
      events.push('rtx:register');
      this.registrations.push(payload);
      if (registerQueued) this.registered = true;
      return registerQueued ? { queued: true } : { queued: false, reason: 'registration rejected by fake' };
    },
    destroyStaticScene() {
      events.push('rtx:destroy');
      this.destroyCount += 1;
      this.registered = false;
    },
    evaluateRayLighting(payload) {
      assert.equal(payload.commandEncoder.finished, false);
      events.push('rtx:evaluate');
      this.evaluations.push(payload);
      return evaluateQueued ? { queued: true } : { queued: false, reason: 'evaluation rejected by fake' };
    },
  };
  const controller = createRtxLightingController({
    THREE,
    renderer,
    rtx,
    collectScene,
    normalizeSettings,
    settings,
    pollIntervalMs: 0,
    delay: async () => {},
  });
  return {
    controller,
    THREE,
    renderer,
    rtx,
    device,
    events,
    renderStates,
    presenterScales,
    presenterBindings,
    targets,
    materials,
  };
}

test('settings normalizer maps independent master, lighting, shadow, and AO controls', () => {
  assert.equal(DEFAULT_RTX_LIGHTING_SETTINGS.enabled, false);
  const settings = normalizeRtxLightingSettings({
    masterEnabled: true,
    lighting: { enabled: false, maxDistance: -4, rayBias: 7, depthInverted: true },
    shadows: { enabled: false, strength: 2, samples: 99, angularRadius: -1 },
    ao: { enabled: true, strength: -1, samples: 0, radius: -8 },
  });
  assert.deepEqual(settings, {
    enabled: true,
    lighting: { enabled: false, maxDistance: 0.01, rayBias: 1, depthInverted: true },
    shadows: { enabled: false, strength: 1, sampleCount: 64, angularRadius: 0 },
    ambientOcclusion: { enabled: true, strength: 0, sampleCount: 1, radius: 0.001 },
  });
  assert.ok(Object.isFrozen(settings));
  assert.ok(Object.isFrozen(settings.ambientOcclusion));

  const strongest = selectStrongestDirectionalLight([
    { direction: [1, 0, 0], intensity: 3, color: [0.1, 0.1, 0.1] },
    { direction: [0, -4, 0], intensity: 2, color: [1, 1, 1] },
  ]);
  assert.deepEqual(strongest.direction, [0, -1, 0]);
  assert.equal(strongest.intensity, 2);

  const coreShape = normalizeRtxLightingSettings({
    enabled: true,
    lighting: true,
    shadows: false,
    ambientOcclusion: true,
    directionalSampleCount: 9,
    aoSampleCount: 11,
    directionalAngularRadius: 0.03,
    shadowStrength: 0.8,
    aoStrength: 0.4,
    aoRadius: 4,
    maxDistance: 900,
    rayBias: 0.01,
  });
  assert.equal(coreShape.shadows.enabled, false);
  assert.equal(coreShape.shadows.sampleCount, 9);
  assert.equal(coreShape.shadows.angularRadius, 0.03);
  assert.equal(coreShape.ambientOcclusion.sampleCount, 11);
  assert.equal(coreShape.ambientOcclusion.strength, 0.4);
  assert.equal(coreShape.lighting.maxDistance, 900);
  assert.equal(coreShape.lighting.rayBias, 0.01);

  const collectorShape = selectStrongestDirectionalLight([{
    directionalLightDirection: new Float32Array([0, 0, -5]),
    directionalLightIntensity: 4,
  }]);
  assert.deepEqual(collectorShape.direction, [0, 0, -1]);
  assert.equal(collectorShape.intensity, 4);
});

test('collector payloads may contain no packed point or spot lights', async () => {
  const harness = makeHarness({
    collectScene: async () => triangleScene({
      lights: new Float32Array(),
      directionalLights: undefined,
      directionalLight: {
        directionalLightDirection: new Float32Array([0, -3, 0]),
        directionalLightIntensity: 6,
      },
    }),
  });
  const { controller, rtx } = harness;
  assert.equal(await controller.configure({ scene: {}, width: 3, height: 3 }), true);
  assert.equal(rtx.registrations[0].lights.length, 0);
  assert.equal(await controller.render({ scene: {}, camera: makeCamera() }), true);
  assert.deepEqual(rtx.evaluations[0].directionalLightDirection, [0, -1, 0]);
  assert.equal(rtx.evaluations[0].directionalLightIntensity, 6);
});

test('digest preserves bounded collector inclusion and exclusion diagnostics', async () => {
  const harness = makeHarness({
    collectScene: async () => triangleScene({
      stats: {
        objectsVisited: 12,
        meshesSeen: 5,
        meshesIncluded: 1,
        skipped: 4,
        skipCounts: { rtx_hidden: 3, rtx_transparent: 1 },
      },
      diagnostics: [{
        severity: 'warning',
        code: 'rtx_transparent',
        objectId: 'entity/window',
        message: 'Transparent material was excluded.',
      }],
      registrable: true,
    }),
  });
  assert.equal(await harness.controller.configure({ scene: {}, width: 4, height: 4 }), true);
  const digest = harness.controller.getDigest();
  assert.equal(digest.collection.current, true);
  assert.equal(digest.collection.registrable, true);
  assert.equal(digest.collection.stats.objectsVisited, 12);
  assert.equal(digest.collection.stats.triangleCount, 1);
  assert.deepEqual(digest.collection.skipCounts, { rtx_hidden: 3, rtx_transparent: 1 });
  assert.deepEqual(digest.collection.diagnostics, [{
    severity: 'warning',
    code: 'rtx_transparent',
    objectId: 'entity/window',
    message: 'Transparent material was excluded.',
  }]);
  harness.controller.markStale('scene changed');
  assert.equal(harness.controller.getDigest().collection.current, false);
});

test('an unregistrable dynamic-only collection clears prior RTX state and remains raster-only', async () => {
  let collected = triangleScene();
  const harness = makeHarness({ collectScene: async () => collected });

  assert.equal(await harness.controller.configure({ scene: {}, width: 4, height: 4 }), true);
  assert.equal(harness.rtx.registered, true);
  assert.equal(harness.rtx.registrations.length, 1);
  const priorTarget = harness.targets.at(-1);
  assert.equal(priorTarget.disposed, false);

  collected = {
    positions: new Float32Array(),
    indices: new Uint32Array(),
    triangleRadiance: new Float32Array(),
    triangleSurface: new Float32Array(),
    lights: new Float32Array(),
    registrable: false,
    stats: {
      objectsVisited: 2,
      meshesSeen: 1,
      meshesIncluded: 0,
      skipped: 1,
      skipCounts: { rtx_missing_or_ignored_geometry: 1 },
    },
    diagnostics: [{
      severity: 'warning',
      code: 'rtx_scene_empty',
      objectId: 'scene/root',
      message: 'No static triangles remain after excluding timeline-driven geometry.',
    }],
  };

  assert.equal(await harness.controller.configure({ scene: {}, width: 4, height: 4 }), false);
  assert.equal(harness.rtx.registered, false);
  assert.equal(harness.rtx.destroyCount, 1);
  assert.equal(harness.rtx.registrations.length, 1);
  assert.equal(priorTarget.disposed, true);

  const status = harness.controller.getStatus();
  assert.equal(status.requested, true);
  assert.equal(status.supported, true);
  assert.equal(status.configured, false);
  assert.equal(status.active, false);
  assert.equal(status.stale, false);
  assert.equal(status.failed, false);
  assert.equal(status.reason, 'no registrable static RTX triangles; raster WebGPU rendering remains active');
  assert.equal(status.staticScene, null);

  const digest = harness.controller.getDigest();
  assert.equal(digest.registeredToken, null);
  assert.equal(digest.collection.current, false);
  assert.equal(digest.collection.registrable, false);
  assert.equal(digest.collection.stats.triangleCount, 0);
  assert.equal(digest.collection.skipCounts.rtx_missing_or_ignored_geometry, 1);
  assert.equal(digest.collection.diagnostics[0].code, 'rtx_scene_empty');
  assert.equal(await harness.controller.render({ scene: {}, camera: makeCamera() }), false);
  assert.equal(harness.rtx.evaluations.length, 0);
});

test('status distinguishes support, request, build, configuration, activity, stale, and off', async () => {
  const collection = deferred();
  const harness = makeHarness({ collectScene: () => collection.promise });
  const { controller, rtx } = harness;

  controller.setSettings({ enabled: false });
  assert.deepEqual(
    Object.fromEntries(Object.entries(controller.getStatus()).filter(([key]) => [
      'supported', 'requested', 'configured', 'building', 'active', 'stale', 'failed', 'reason',
    ].includes(key))),
    {
      supported: true,
      requested: false,
      configured: false,
      building: false,
      active: false,
      stale: false,
      failed: false,
      reason: 'disabled',
    },
  );

  controller.setSettings({ enabled: true });
  const build = controller.configure({ scene: { name: 'authored' }, width: 8, height: 6 });
  assert.equal(controller.getStatus().building, true);
  assert.equal(controller.getStatus().requested, true);
  collection.resolve(triangleScene());
  assert.equal(await build, true);
  assert.equal(controller.getStatus().configured, true);
  assert.equal(controller.getStatus().active, false);

  assert.equal(await controller.render({ scene: { name: 'authored' }, camera: makeCamera() }), true);
  assert.equal(controller.getStatus().active, true);
  assert.equal(controller.getStatus().reason, 'active');

  controller.markStale('topology changed');
  assert.equal(controller.getStatus().stale, true);
  assert.equal(controller.getStatus().active, false);
  assert.equal(controller.getStatus().reason, 'topology changed');

  controller.setSettings({ enabled: false });
  assert.equal(controller.getStatus().requested, false);
  assert.equal(controller.getStatus().configured, false);
  assert.equal(rtx.destroyCount, 1);
});

test('native frame order is raster, evaluate on a fresh encoder, submit, then fullscreen present', async () => {
  const harness = makeHarness({
    settings: {
      enabled: true,
      lighting: { maxDistance: 222, rayBias: 0.004 },
      shadows: { enabled: true, strength: 0.75, sampleCount: 5, angularRadius: 0.02 },
      ambientOcclusion: { enabled: false, strength: 0.9, sampleCount: 7, radius: 3 },
    },
  });
  const { controller, rtx, events, renderer, presenterScales, targets } = harness;
  assert.equal(await controller.configure({ scene: {}, width: 12, height: 9 }), true);
  const registrationIndex = events.lastIndexOf('rtx:register');
  assert.ok(registrationIndex >= 0);
  assert.ok(events.findIndex((event, index) => index > registrationIndex && event === 'rtx:status') > registrationIndex);
  events.length = 0;

  assert.equal(await controller.render({ scene: { name: 'authored' }, camera: makeCamera() }), true);
  const authored = events.indexOf('render:authored:shadows=false');
  const evaluate = events.indexOf('rtx:evaluate');
  const finish = events.indexOf('encoder:finish');
  const submit = events.indexOf('queue:submit');
  const present = events.indexOf('render:ThreeBrowser Studio RTX presentation:shadows=true');
  assert.ok(authored >= 0);
  assert.ok(authored < evaluate);
  assert.ok(evaluate < finish);
  assert.ok(finish < submit);
  assert.ok(submit < present);
  assert.equal(renderer.shadowMap.enabled, true);
  assert.deepEqual(presenterScales, [-1]);

  const evaluation = rtx.evaluations[0];
  assert.equal(evaluation.color.layout, 'VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL');
  assert.equal(evaluation.color.vulkanLayout, evaluation.color.layout);
  assert.equal(evaluation.depth.layout, 'VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL');
  assert.equal(evaluation.depth.vulkanLayout, evaluation.depth.layout);
  assert.equal(evaluation.color.texture, targets[0].texture.native);
  assert.equal(evaluation.depth.texture, targets[0].depthTexture.native);
  assert.deepEqual(evaluation.cameraPosition, [4, 5, 6]);
  assert.deepEqual(evaluation.directionalLightDirection, [0, -1, 0]);
  assert.equal(evaluation.directionalLightIntensity, 3);
  assert.equal(evaluation.directionalSampleCount, 5);
  assert.equal(evaluation.shadowStrength, 0.75);
  assert.equal(evaluation.aoSampleCount, 7);
  assert.equal(evaluation.aoStrength, 0);
  assert.equal(evaluation.aoRadius, 3);
  assert.equal(evaluation.maxDistance, 222);
  assert.equal(evaluation.rayBias, 0.004);
  assert.equal(evaluation.frameIndex, 0);

  const registration = rtx.registrations[0];
  assert.equal(registration.lights.length, 16);
  assert.equal(controller.getStatus().staticScene.packedLightCount, 1);
});

test('RTX payload reconstructs world positions with matrixWorld times projectionMatrixInverse', async () => {
  const harness = makeHarness();
  const camera = makeNumericCamera();
  assert.equal(await harness.controller.configure({ scene: {}, width: 4, height: 4 }), true);
  assert.equal(await harness.controller.render({ scene: {}, camera }), true);

  const clip = [0.25, -0.5, 0.2, 1];
  const viewPosition = multiplyMatrixVector(camera.projectionMatrixInverse.elements, clip);
  const expectedWorld = multiplyMatrixVector(camera.matrixWorld.elements, viewPosition);
  const reconstructed = multiplyMatrixVector(
    harness.rtx.evaluations[0].inverseViewProjection,
    clip,
  );
  assert.deepEqual(reconstructed, expectedWorld);
});

test('HDR base rendering disables the output transform and presentation honors an evidence output target', async () => {
  const harness = makeHarness();
  const { controller, renderer, renderStates, targets } = harness;
  assert.equal(await controller.configure({ scene: {}, width: 6, height: 4 }), true);
  const previousRenderTarget = { name: 'prior-render-target' };
  const previousOutputTarget = { name: 'prior-output-target' };
  const evidenceTarget = { name: 'evidence-target' };
  renderer.currentTarget = previousRenderTarget;
  renderer.currentOutputTarget = previousOutputTarget;
  renderStates.length = 0;

  assert.equal(await controller.render({
    scene: { name: 'authored' },
    camera: makeCamera(),
    outputTarget: evidenceTarget,
  }), true);
  assert.deepEqual(renderStates[0], {
    scene: 'authored',
    shadows: false,
    target: targets[0],
    outputTarget: null,
  });
  assert.deepEqual(renderStates[1], {
    scene: 'ThreeBrowser Studio RTX presentation',
    shadows: true,
    target: evidenceTarget,
    outputTarget: evidenceTarget,
  });
  assert.equal(renderer.currentTarget, previousRenderTarget);
  assert.equal(renderer.currentOutputTarget, previousOutputTarget);
});

test('live and evidence RTX frames serialize incompatible attachment sizes', async () => {
  const harness = makeHarness();
  const {
    controller, rtx, renderStates, presenterBindings, targets, materials,
  } = harness;
  assert.equal(await controller.configure({ scene: {}, width: 16, height: 9 }), true);
  rtx.evaluations.length = 0;
  renderStates.length = 0;
  const evidenceTarget = { name: 'evidence-1280x720' };

  const live = controller.render({
    scene: { name: 'live-2434x1369' }, camera: makeCamera(),
    width: 2434, height: 1369, outputTarget: null,
  });
  const evidence = controller.render({
    scene: { name: 'evidence-1280x720' }, camera: makeCamera(),
    width: 1280, height: 720, outputTarget: evidenceTarget,
  });

  assert.deepEqual(await Promise.all([live, evidence]), [true, true]);
  assert.deepEqual(rtx.evaluations.map(({ width, height }) => [width, height]), [
    [2434, 1369],
    [1280, 720],
  ]);
  assert.notEqual(rtx.evaluations[0].color.texture, rtx.evaluations[1].color.texture);
  assert.equal(targets.at(-2).disposed, true);
  assert.deepEqual(presenterBindings, [targets.at(-2).texture, targets.at(-1).texture]);
  assert.equal(materials.length, 3);
  assert.equal(materials[0].disposed, true);
  assert.equal(materials[1].disposed, true);
  assert.equal(materials[2].disposed, false);
  assert.deepEqual(
    renderStates.filter(({ scene }) => scene === 'ThreeBrowser Studio RTX presentation')
      .map(({ outputTarget }) => outputTarget),
    [null, evidenceTarget],
  );
});

test('disabling ray shadows preserves raster shadows and maps native component strengths to zero', async () => {
  const harness = makeHarness({
    settings: {
      enabled: true,
      shadows: false,
      ambientOcclusion: false,
    },
  });
  const { controller, rtx, events } = harness;
  assert.equal(await controller.configure({ scene: {}, width: 5, height: 5 }), true);
  events.length = 0;
  assert.equal(await controller.render({ scene: { name: 'authored' }, camera: makeCamera() }), true);
  assert.ok(events.includes('render:authored:shadows=true'));
  assert.equal(rtx.evaluations[0].shadowStrength, 0);
  assert.equal(rtx.evaluations[0].aoStrength, 0);
});

test('newer async builds cancel stale collector results before native registration', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const harness = makeHarness({
    collectScene() {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    },
  });
  const { controller, rtx } = harness;
  const firstBuild = controller.configure({ scene: { id: 'first' }, width: 4, height: 4 });
  const secondBuild = controller.configure({ scene: { id: 'second' }, width: 7, height: 6 });

  second.resolve(triangleScene({ positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]) }));
  assert.equal(await secondBuild, true);
  first.resolve(triangleScene());
  assert.equal(await firstBuild, false);
  assert.equal(rtx.registrations.length, 1);
  assert.equal(rtx.registrations[0].positions[3], 2);
  assert.equal(controller.getStatus().configured, true);
  assert.equal(controller.getStatus().size.width, 7);
});

test('markStale aborts an in-flight collector and prevents its result from registering', async () => {
  const collection = deferred();
  const harness = makeHarness({ collectScene: () => collection.promise });
  const { controller, rtx } = harness;
  const build = controller.configure({ scene: { id: 'changing' }, width: 4, height: 4 });
  assert.equal(controller.getStatus().building, true);
  const stale = controller.markStale('scene revision advanced');
  assert.equal(stale.building, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.reason, 'scene revision advanced');
  collection.resolve(triangleScene());
  assert.equal(await build, false);
  assert.equal(rtx.registrations.length, 0);
});

test('registration and frame rejection set truthful failed status without claiming activity', async () => {
  const buildFailure = makeHarness({ registerQueued: false });
  assert.equal(await buildFailure.controller.configure({ scene: {}, width: 4, height: 4 }), false);
  assert.equal(buildFailure.controller.getStatus().failed, true);
  assert.equal(buildFailure.controller.getStatus().configured, false);
  assert.equal(buildFailure.controller.getStatus().active, false);
  assert.match(buildFailure.controller.getStatus().reason, /registration rejected by fake/);

  const frameFailure = makeHarness({ evaluateQueued: false });
  assert.equal(await frameFailure.controller.configure({ scene: {}, width: 4, height: 4 }), true);
  assert.equal(await frameFailure.controller.render({ scene: {}, camera: makeCamera() }), false);
  assert.equal(frameFailure.controller.getStatus().configured, true);
  assert.equal(frameFailure.controller.getStatus().failed, true);
  assert.equal(frameFailure.controller.getStatus().active, false);
  assert.match(frameFailure.controller.getStatus().reason, /evaluation rejected by fake/);
});

test('unsupported adapters stay requested but never configured or active', async () => {
  const { controller } = makeHarness({ capability: false });
  assert.equal(await controller.configure({ scene: {}, width: 4, height: 4 }), false);
  const status = controller.getStatus();
  assert.equal(status.supported, false);
  assert.equal(status.requested, true);
  assert.equal(status.configured, false);
  assert.equal(status.active, false);
  assert.equal(status.failed, false);
  assert.match(status.reason, /unsupported/);
});

test('resize replaces and disposes GPU targets safely, and dispose tears down every owned resource', async () => {
  const harness = makeHarness();
  const { controller, targets, rtx } = harness;
  assert.equal(await controller.configure({ scene: {}, width: 4, height: 3 }), true);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].options.type, 'half-float');
  assert.equal(targets[0].options.format, 'rgba');
  assert.equal(targets[0].options.colorSpace, 'none');
  assert.equal(targets[0].depthTexture.type, 'float');
  assert.equal(targets[0].depthTexture.format, 'depth');
  assert.match(targets[0].texture.name, /rgba16float/);
  assert.equal(targets[0].texture.colorSpace, 'none');
  assert.match(targets[0].depthTexture.name, /depth32float/);
  assert.equal(targets[0].texture.isStorageTexture, true);

  assert.equal(controller.resize(9, 7), true);
  assert.equal(targets[0].disposed, true);
  assert.equal(targets.length, 2);
  assert.equal(targets[1].width, 9);
  assert.equal(targets[1].height, 7);
  assert.equal(controller.resize(9, 7), false);

  controller.dispose();
  assert.equal(targets[1].disposed, true);
  assert.equal(rtx.destroyCount, 1);
  assert.equal(controller.getStatus().configured, false);
  assert.equal(controller.getStatus().reason, 'disposed');
  controller.dispose();
  assert.equal(rtx.destroyCount, 1);
});

test('injected settings normalizer is used before the canonical safety clamp', () => {
  const seen = [];
  const normalizeSettings = value => {
    seen.push(value);
    return {
      enabled: value.mode === 'native',
      lighting: true,
      shadows: { enabled: true, strength: 8 },
      ambientOcclusion: false,
    };
  };
  const { controller } = makeHarness({ settings: { mode: 'native' }, normalizeSettings });
  assert.equal(seen.length, 1);
  assert.equal(controller.getStatus().requested, true);
  assert.equal(controller.settings.shadows.strength, 1);
  assert.equal(controller.settings.ambientOcclusion.enabled, false);
});
