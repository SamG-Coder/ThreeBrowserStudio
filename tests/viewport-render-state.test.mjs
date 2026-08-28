import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STUDIO_RENDER_STATE,
  applyStudioRenderState,
  createStudioEvidenceTarget,
  withStudioOutputTarget,
} from '../src/viewport/render-state.mjs';

const THREE = Object.freeze({
  SRGBColorSpace: 'srgb-display',
  LinearSRGBColorSpace: 'linear-srgb-working',
  ACESFilmicToneMapping: 'aces-filmic',
  PCFSoftShadowMap: 'pcf-soft',
  RGBAFormat: 'rgba',
  UnsignedByteType: 'uint8',
  RenderTarget: class RenderTarget {
    constructor(width, height, options) {
      this.width = width;
      this.height = height;
      this.options = options;
      this.texture = { name: '' };
    }
  },
});

function fakeRenderer() {
  return {
    outputColorSpace: null,
    toneMapping: null,
    toneMappingExposure: null,
    shadowMap: { enabled: false, type: null },
    clear: null,
    renderTarget: { id: 'previous-render-target' },
    outputTarget: { id: 'previous-output-target' },
    mrt: { id: 'previous-mrt' },
    setClearColor(color, alpha) { this.clear = { color, alpha }; },
    getRenderTarget() { return this.renderTarget; },
    setRenderTarget(value) { this.renderTarget = value; },
    getOutputRenderTarget() { return this.outputTarget; },
    setOutputRenderTarget(value) { this.outputTarget = value; },
    getMRT() { return this.mrt; },
    setMRT(value) { this.mrt = value; },
    get isOutputTarget() {
      return this.renderTarget === this.outputTarget || this.renderTarget === null;
    },
    get currentToneMapping() {
      return this.isOutputTarget ? this.toneMapping : 'none';
    },
    get currentColorSpace() {
      return this.isOutputTarget ? this.outputColorSpace : THREE.LinearSRGBColorSpace;
    },
  };
}

test('persistent viewport configuration comes from one display-referred render contract', () => {
  const renderer = fakeRenderer();
  assert.equal(applyStudioRenderState(THREE, renderer), renderer);
  assert.equal(renderer.outputColorSpace, THREE.SRGBColorSpace);
  assert.equal(renderer.toneMapping, THREE.NoToneMapping);
  assert.equal(renderer.toneMappingExposure, STUDIO_RENDER_STATE.toneMappingExposure);
  assert.deepEqual(renderer.shadowMap, { enabled: true, type: THREE.PCFSoftShadowMap });
  assert.deepEqual(renderer.clear, {
    color: STUDIO_RENDER_STATE.clearColor,
    alpha: STUDIO_RENDER_STATE.clearAlpha,
  });
});

test('evidence target stores display-referred bytes without a second sRGB transfer', () => {
  const target = createStudioEvidenceTarget(THREE, 1280, 720);
  assert.equal(target.width, 1280);
  assert.equal(target.height, 720);
  assert.equal(target.options.format, THREE.RGBAFormat);
  assert.equal(target.options.type, THREE.UnsignedByteType);
  assert.equal(target.options.colorSpace, THREE.LinearSRGBColorSpace);
  assert.notEqual(target.options.colorSpace, THREE.SRGBColorSpace);
  assert.equal(target.options.samples, 0);
  assert.match(target.texture.name, /display-referred evidence target/);
});

test('evidence render is an output target so it receives the viewport tone and colour transform', async () => {
  const renderer = fakeRenderer();
  applyStudioRenderState(THREE, renderer);
  const before = {
    renderTarget: renderer.renderTarget,
    outputTarget: renderer.outputTarget,
    mrt: renderer.mrt,
  };
  const target = { id: 'evidence-target' };

  const value = await withStudioOutputTarget(renderer, target, () => {
    assert.equal(renderer.renderTarget, target);
    assert.equal(renderer.outputTarget, target);
    assert.equal(renderer.isOutputTarget, true);
    assert.equal(renderer.currentToneMapping, THREE.NoToneMapping);
    assert.equal(renderer.currentColorSpace, THREE.SRGBColorSpace);
    assert.equal(renderer.mrt, null);
    return 'rendered';
  });

  assert.equal(value, 'rendered');
  assert.deepEqual(renderer.renderTarget, before.renderTarget);
  assert.deepEqual(renderer.outputTarget, before.outputTarget);
  assert.deepEqual(renderer.mrt, before.mrt);
});

test('evidence output binding restores every renderer target after failure', async () => {
  const renderer = fakeRenderer();
  const before = {
    renderTarget: renderer.renderTarget,
    outputTarget: renderer.outputTarget,
    mrt: renderer.mrt,
  };
  await assert.rejects(
    withStudioOutputTarget(renderer, { id: 'failed-target' }, () => {
      throw new Error('render failed');
    }),
    /render failed/,
  );
  assert.deepEqual(renderer.renderTarget, before.renderTarget);
  assert.deepEqual(renderer.outputTarget, before.outputTarget);
  assert.deepEqual(renderer.mrt, before.mrt);
});
