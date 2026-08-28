import * as THREE from "three/webgpu";
import { cloneCameraForCapture } from "./camera-projection.mjs";
import { unpadWebGpuReadbackRows } from "./readback-layout.mjs";

/** GPU readback is performed only for an explicit MCP evidence request. */
export function createFrameCapture({ renderer, scene, camera, getCamera, renderFrame } = {}) {
  let target = null;

  async function capture(filePath, {
    width = 1280,
    height = 720,
    pass = "beauty",
    camera: requestedCamera,
  } = {}) {
    const sourceCamera = requestedCamera ?? getCamera?.() ?? camera;
    if (!sourceCamera) throw new Error("Studio capture has no active camera.");
    const captureWidth = Math.max(16, Math.min(1920, Math.trunc(Number(width) || 1280)));
    const captureHeight = Math.max(16, Math.min(1080, Math.trunc(Number(height) || 720)));
    const activeCamera = cloneCameraForCapture(sourceCamera, captureWidth / captureHeight);
    if (!target) {
      target = new THREE.RenderTarget(captureWidth, captureHeight, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        colorSpace: THREE.SRGBColorSpace,
        depthBuffer: true,
        stencilBuffer: false,
        samples: 0,
        generateMipmaps: false,
      });
      target.texture.name = "ThreeBrowser Studio evidence target";
    } else {
      target.setSize(captureWidth, captureHeight);
    }

    const previousTarget = renderer.getRenderTarget();
    const previousMrt = renderer.getMRT();
    try {
      renderer.setMRT(null);
      renderer.setRenderTarget(target);
      renderer.clear(true, true, true);
      if (renderFrame) await renderFrame({ target, pass, width: captureWidth, height: captureHeight });
      else renderer.render(scene, activeCamera);
      const pixels = await renderer.readRenderTargetPixelsAsync(
        target,
        0,
        0,
        captureWidth,
        captureHeight,
      );
      const packedPixels = unpadWebGpuReadbackRows(pixels, captureWidth, captureHeight);
      const canvas = document.createElement("canvas");
      canvas.width = captureWidth;
      canvas.height = captureHeight;
      const context = canvas.getContext("2d");
      context.putImageData(
        new ImageData(new Uint8ClampedArray(packedPixels), captureWidth, captureHeight),
        0,
        0,
      );
      const [{ mkdir, writeFile }, path] = await Promise.all([
        import("node:fs/promises"),
        import("node:path"),
      ]);
      const studioRoot = globalThis.process?.env?.THREE_STUDIO_ROOT
        || globalThis.process?.cwd?.()
        || ".";
      const resolved = filePath
        ? path.resolve(String(filePath))
        : path.join(studioRoot, "artifacts", `studio-${Date.now()}.png`);
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, canvas.toBuffer("image/png"));
      canvas.width = 1;
      canvas.height = 1;
      return Object.freeze({
        path: resolved,
        width: captureWidth,
        height: captureHeight,
        pass,
      });
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setMRT(previousMrt);
    }
  }

  return Object.freeze({
    capture,
    dispose() {
      target?.dispose();
      target = null;
    },
  });
}
