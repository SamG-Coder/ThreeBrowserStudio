import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { createBootstrapScene } from "./bootstrap-scene.mjs";
import { createFrameCapture } from "./frame-capture.mjs";
import {
  cameraPresentationAspect,
  fitPresentationViewport,
  updateCameraAspect,
} from "./camera-projection.mjs";
import { applyStudioRenderState, STUDIO_RENDER_STATE } from "./render-state.mjs";
import { createReviewControls } from "./review-controls.mjs";
import { createMcpLiveFeedWebGpuHud } from "./mcp-live-feed-webgpu-hud.mjs";
import { createStudioCommandTelemetry } from "../runtime/mcp-live-feed-telemetry.mjs";
import { collectRtxScene } from "../runtime/rtx-scene-collector.mjs";
import { startStudioApplication } from "../runtime/studio-application.mjs";
import { createRtxLightingController } from "./rtx-lighting-controller.mjs";
import { adaptSceneRtxSettings } from "./rtx-settings-adapter.mjs";

document.title = "ThreeBrowser Studio — waiting for project";

async function main() {
  const renderer = new THREE.WebGPURenderer({
    antialias: true,
    powerPreference: "high-performance",
    trackTimestamp: true,
  });
  renderer.setPixelRatio(Math.max(1, Number(globalThis.devicePixelRatio || 1)));
  renderer.setSize(Math.max(1, innerWidth), Math.max(1, innerHeight));
  applyStudioRenderState(THREE, renderer);
  renderer.domElement.style.position = "fixed";
  renderer.domElement.style.inset = "auto";
  renderer.domElement.style.left = "0";
  renderer.domElement.style.top = "0";
  renderer.domElement.style.touchAction = "none";
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  if (!renderer.backend?.isWebGPUBackend) {
    throw new Error("Studio could not initialize the native WebGPU backend.");
  }
  renderer.backend.device?.addEventListener?.("uncapturederror", event => {
    console.error("[ThreeBrowser Studio WebGPU]", event.error?.message || event.error || event);
  });

  const scene = new THREE.Scene();
  scene.name = "ThreeBrowser Studio live stage";
  scene.background = null;
  scene.fog = new THREE.FogExp2(STUDIO_RENDER_STATE.clearColor, 0.018);
  scene.userData.renderer = renderer;

  const camera = new THREE.PerspectiveCamera(
    46,
    Math.max(1, innerWidth) / Math.max(1, innerHeight),
    0.05,
    2000,
  );
  camera.name = "Studio review camera";
  camera.position.set(8.5, 6.2, 10.5);
  camera.lookAt(0, 1.8, 0);

  const controls = createReviewControls(camera, renderer.domElement, {
    target: new THREE.Vector3(0, 1.8, 0),
    minDistance: 1.2,
    maxDistance: 800,
  });

  const bootstrap = createBootstrapScene();
  scene.add(bootstrap.root);
  let renderCamera = camera;
  const commandTelemetry = createStudioCommandTelemetry({
    onSinkError: error => console.warn("[ThreeBrowser Studio live feed]", error?.message || error),
  });
  const liveFeed = createMcpLiveFeedWebGpuHud({
    THREE,
    scene,
    source: commandTelemetry,
    width: Math.max(1, innerWidth),
    height: Math.max(1, innerHeight),
    pixelRatio: Math.max(1, Number(globalThis.devicePixelRatio || 1)),
  });
  const rtxLighting = createRtxLightingController({
    THREE,
    renderer,
    rtx: globalThis.navigator?.gpu?.threeBrowserRTX ?? null,
    collectScene: root => collectRtxScene(root),
    normalizeSettings: adaptSceneRtxSettings,
    settings: {},
  });
  const capture = createFrameCapture({
    renderer,
    scene,
    getCamera: () => renderCamera,
    excludedObjects: [liveFeed.sprite],
    async renderFrame({ target, camera: activeCamera, width, height }) {
      const renderedWithRtx = await rtxLighting.render({
        scene,
        camera: activeCamera,
        width,
        height,
        outputTarget: target,
      });
      if (!renderedWithRtx) renderer.render(scene, activeCamera);
    },
  });
  const started = performance.now() * 0.001;
  let application = null;

  function resize() {
    const width = Math.max(1, Number(innerWidth) || 1);
    const height = Math.max(1, Number(innerHeight) || 1);
    const presentationAspect = cameraPresentationAspect(renderCamera, width / height);
    const content = fitPresentationViewport(width, height, presentationAspect);
    updateCameraAspect(renderCamera, presentationAspect);
    renderer.setSize(content.width, content.height);
    renderer.domElement.style.left = `${content.x}px`;
    renderer.domElement.style.top = `${content.y}px`;
    liveFeed.resize(content.width, content.height, Math.max(1, Number(globalThis.devicePixelRatio || 1)));
  }

  let disposed = false;
  async function dispose() {
    if (disposed) return;
    disposed = true;
    renderer.setAnimationLoop(null);
    globalThis.removeEventListener("resize", resize);
    await application?.dispose();
    liveFeed.dispose();
    commandTelemetry.dispose();
    capture.dispose();
    rtxLighting.dispose();
    controls.dispose();
    bootstrap.dispose();
    scene.clear();
    renderer.dispose();
  }

  const viewportApi = Object.freeze({
    renderer,
    scene,
    camera,
    controls,
    get renderCamera() {
      return renderCamera;
    },
    setRenderCamera(nextCamera) {
      renderCamera = nextCamera ?? camera;
      resize();
    },
    setAppearance({ background = null, backgroundNode = null, fog = null } = {}) {
      // Scene colours belong to the scene background path. Keeping the colour
      // there makes WebGPURenderer force the authored clear value for every
      // output target; renderer-only clear state can be superseded by the
      // node-material render path.
      scene.background = background;
      scene.backgroundNode = backgroundNode;
      scene.fog = fog;
      if (!background && !backgroundNode) renderer.setClearColor(STUDIO_RENDER_STATE.clearColor, 1);
    },
    configureRtx({ root, settings = {} } = {}) {
      rtxLighting.setSettings(settings);
      if (settings.enabled !== true) return Promise.resolve(false);
      rtxLighting.markStale("compiled scene revision changed");
      return rtxLighting.configure({
        scene: root,
        width: renderer.domElement.width,
        height: renderer.domElement.height,
        settings,
      });
    },
    getRtxStatus() {
      return rtxLighting.getStatus();
    },
    getRtxDigest() {
      return rtxLighting.getDigest();
    },
    capture: capture.capture,
    async focusBounds(bounds) {
      const centre = new THREE.Vector3();
      const size = new THREE.Vector3();
      bounds.getCenter(centre);
      bounds.getSize(size);
      const radius = Math.max(0.5, size.length() * 0.5);
      controls.target.copy(centre);
      camera.position.copy(centre).add(new THREE.Vector3(1, 0.72, 1.2).normalize().multiplyScalar(radius * 2.6));
      camera.near = Math.max(0.01, radius / 1000);
      camera.far = Math.max(200, radius * 40);
      camera.updateProjectionMatrix();
      controls.syncFromCamera();
      renderCamera = camera;
    },
    setTitle({ project = "waiting for project", scene: sceneName = "", revision = 0, dirty = false } = {}) {
      document.title = `ThreeBrowser Studio — ${project}${sceneName ? ` / ${sceneName}` : ""} — r${revision}${dirty ? " *" : ""}`;
    },
    dispose,
  });
  globalThis.__THREE_STUDIO_VIEWPORT__ = viewportApi;

  try {
    application = await startStudioApplication({
      THREE,
      TSL,
      viewport: viewportApi,
      bootstrap,
      beginCommand: commandTelemetry.begin,
    });
  } catch (error) {
    await dispose();
    throw error;
  }
  globalThis.__THREE_STUDIO_APPLICATION__ = application;
  globalThis.__THREE_STUDIO_LIVE_FEED__ = liveFeed;

  globalThis.addEventListener("resize", resize);
  globalThis.addEventListener("beforeunload", () => { void dispose(); }, { once: true });
  resize();
  let previousFrame = performance.now() * 0.001;
  let renderingFrame = false;
  renderer.setAnimationLoop(async () => {
    if (disposed || renderingFrame) return;
    renderingFrame = true;
    try {
      const now = performance.now() * 0.001;
      const elapsed = now - started;
      const delta = Math.min(0.1, Math.max(0, now - previousFrame));
      previousFrame = now;
      if (bootstrap.root.parent) bootstrap.update(elapsed);
      application?.update(delta);
      if (renderCamera === camera) controls.update(delta);
      renderer.setRenderTarget(null);
      renderer.setMRT(null);
      liveFeed.updateCamera(renderCamera);
      const renderedWithRtx = await rtxLighting.render({
        scene,
        camera: renderCamera,
        width: renderer.domElement.width,
        height: renderer.domElement.height,
        outputTarget: null,
      });
      if (!renderedWithRtx) renderer.render(scene, renderCamera);
    } finally {
      renderingFrame = false;
    }
  });

  console.log("[ThreeBrowser Studio] persistent WebGPU viewport ready");
}

main().catch(error => {
  console.error("[ThreeBrowser Studio]", error);
  throw error;
});
