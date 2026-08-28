/**
 * One display-referred render contract for both the persistent canvas and
 * explicit evidence captures. Values authored in Studio remain linear and
 * receive only the sRGB display transform; no global artistic tone curve is
 * allowed to replace authored colours.
 */
export const STUDIO_RENDER_STATE = Object.freeze({
  clearColor: 0x0d1118,
  clearAlpha: 1,
  toneMappingExposure: 1,
});

export function applyStudioRenderState(THREE, renderer) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = STUDIO_RENDER_STATE.toneMappingExposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(STUDIO_RENDER_STATE.clearColor, STUDIO_RENDER_STATE.clearAlpha);
  return renderer;
}

/**
 * The evidence texture is intentionally linear/unorm. WebGPURenderer writes
 * the final sRGB transformed bytes into it while it is selected as the
 * output target. Marking this texture as sRGB would add a second hardware
 * transfer during the output pass.
 */
export function createStudioEvidenceTarget(THREE, width, height) {
  const target = new THREE.RenderTarget(width, height, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.LinearSRGBColorSpace,
    depthBuffer: true,
    stencilBuffer: false,
    samples: 0,
    generateMipmaps: false,
  });
  target.texture.name = "ThreeBrowser Studio display-referred evidence target";
  return target;
}

/**
 * WebGPURenderer applies tone mapping and output-colour conversion only to an
 * output target. A regular setRenderTarget() capture silently receives linear,
 * un-tonemapped pixels, so bind both roles for the submitted evidence frame.
 */
export async function withStudioOutputTarget(renderer, target, render) {
  if (typeof renderer.setOutputRenderTarget !== "function"
      || typeof renderer.getOutputRenderTarget !== "function") {
    throw new Error("Studio evidence requires WebGPURenderer output-target support.");
  }
  const previousRenderTarget = renderer.getRenderTarget();
  const previousOutputTarget = renderer.getOutputRenderTarget();
  const previousMrt = renderer.getMRT();
  try {
    renderer.setMRT(null);
    renderer.setOutputRenderTarget(target);
    renderer.setRenderTarget(target);
    return await render();
  } finally {
    renderer.setRenderTarget(previousRenderTarget);
    renderer.setOutputRenderTarget(previousOutputTarget);
    renderer.setMRT(previousMrt);
  }
}
