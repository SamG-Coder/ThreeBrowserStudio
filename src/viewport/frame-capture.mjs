import * as THREE from "three/webgpu";
import {
  cameraPresentationAspect,
  cloneCameraForCapture,
  fitPresentationViewport,
} from "./camera-projection.mjs";
import { unpadWebGpuReadbackRows } from "./readback-layout.mjs";
import { createStudioEvidenceTarget, withStudioOutputTarget } from "./render-state.mjs";

/** GPU readback is performed only for an explicit MCP evidence request. */
export function createFrameCapture({ renderer, scene, camera, getCamera, renderFrame, excludedObjects = [], prepareScene } = {}) {
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
    const presentationAspect = cameraPresentationAspect(sourceCamera, captureWidth / captureHeight);
    const content = fitPresentationViewport(captureWidth, captureHeight, presentationAspect);
    const activeCamera = cloneCameraForCapture(sourceCamera, presentationAspect);
    if (!target) {
      target = createStudioEvidenceTarget(THREE, content.width, content.height);
    } else {
      target.setSize(content.width, content.height);
    }

    const excludedVisibility = excludedObjects.map(object => [object, object?.visible]);
    try {
      for (const [object] of excludedVisibility) if (object) object.visible = false;
      await prepareScene?.({
        camera: activeCamera,
        width: content.width,
        height: content.height,
        outputWidth: captureWidth,
        outputHeight: captureHeight,
        target,
        pass,
      });
      await withStudioOutputTarget(renderer, target, async () => {
        renderer.clear(true, true, true);
        if (renderFrame) await renderFrame({
          target,
          pass,
          width: content.width,
          height: content.height,
          camera: activeCamera,
        });
        else renderer.render(scene, activeCamera);
      });
    } finally {
      for (const [object, visible] of excludedVisibility) if (object) object.visible = visible;
    }
    // Target binding is restored before readback so the persistent canvas
    // cannot inherit the evidence output while asynchronous PNG work runs.
    const pixels = await renderer.readRenderTargetPixelsAsync(
      target,
      0,
      0,
      content.width,
      content.height,
    );
    const packedPixels = unpadWebGpuReadbackRows(pixels, content.width, content.height);
    const canvas = document.createElement("canvas");
    canvas.width = captureWidth;
    canvas.height = captureHeight;
    const context = canvas.getContext("2d");
    context.fillStyle = pass === "beauty" ? "#0d1118" : "#000000";
    context.fillRect(0, 0, captureWidth, captureHeight);
    context.putImageData(
      new ImageData(new Uint8ClampedArray(packedPixels), content.width, content.height),
      content.x,
      content.y,
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
      : path.join(studioRoot, "artifacts", pass === "beauty"
        ? `studio-${Date.now()}.png`
        : `studio-${Date.now()}-${pass}.png`);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, canvas.toBuffer("image/png"));
    canvas.width = 1;
    canvas.height = 1;
    return Object.freeze({
      path: resolved,
      width: captureWidth,
      height: captureHeight,
      pass,
      presentationAspect,
      contentViewport: {
        x: content.x,
        y: content.y,
        width: content.width,
        height: content.height,
      },
    });
  }

  return Object.freeze({
    capture,
    dispose() {
      target?.dispose();
      target = null;
    },
  });
}
