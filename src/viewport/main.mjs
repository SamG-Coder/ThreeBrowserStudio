import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { createBootstrapScene } from "./bootstrap-scene.mjs";
import { createFrameCapture } from "./frame-capture.mjs";
import { updateCameraAspect } from "./camera-projection.mjs";
import { applyStudioRenderState, STUDIO_RENDER_STATE } from "./render-state.mjs";
import { createReviewControls } from "./review-controls.mjs";
import { createReviewSession, VIEW_MODE_FOLLOW_SHOT } from "./view-mode.mjs";
import { createMcpLiveFeedWebGpuHud } from "./mcp-live-feed-webgpu-hud.mjs";
import { createStudioCommandTelemetry } from "../runtime/mcp-live-feed-telemetry.mjs";
import { detectStudioHost } from "../runtime/host-environment.mjs";
import { collectRtxScene } from "../runtime/rtx-scene-collector.mjs";
import { createRtxLightingController } from "./rtx-lighting-controller.mjs";
import { adaptSceneRtxSettings } from "./rtx-settings-adapter.mjs";

document.title = "ThreeBrowser Studio — waiting for project";

async function main() {
  const host = detectStudioHost();
  const browserPreview = globalThis.__THREE_STUDIO_BROWSER_PREVIEW__ === true;
  const renderer = new THREE.WebGPURenderer({
    antialias: true,
    powerPreference: "high-performance",
    ...(host.attached ? { trackTimestamp: true } : {}),
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
    throw new Error(host.attached
      ? "Studio could not initialize the native WebGPU backend."
      : "Studio could not initialize WebGPU in this browser.");
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
  });
  const reviewSession = createReviewSession({
    THREE,
    reviewCamera: camera,
    controls,
    onChange() {
      controls.enabled = reviewSession.viewMode !== VIEW_MODE_FOLLOW_SHOT;
      liveFeed?.setViewMode?.(reviewSession.viewMode);
      const width = Math.max(1, Number(innerWidth) || 1);
      const height = Math.max(1, Number(innerHeight) || 1);
      updateCameraAspect(reviewSession.renderCamera, width / height);
    },
  });
  controls.enabled = false;
  controls.onBeginInteract = () => {
    if (reviewSession.viewMode === VIEW_MODE_FOLLOW_SHOT) {
      reviewSession.enterReview({ seedFromAuthored: true });
    }
  };

  const bootstrap = createBootstrapScene();
  scene.add(bootstrap.root);
  const commandTelemetry = createStudioCommandTelemetry({
    onSinkError: error => console.warn("[ThreeBrowser Studio live feed]", error?.message || error),
  });
  let typeface = null;
  if (host.attached) {
    const { getSystemTypeface } = await import("./system-typeface.mjs");
    typeface = getSystemTypeface();
  }
  let promptSheet = null;
  const liveFeed = createMcpLiveFeedWebGpuHud({
    THREE,
    scene,
    source: commandTelemetry,
    width: Math.max(1, innerWidth),
    height: Math.max(1, innerHeight),
    pixelRatio: Math.max(1, Number(globalThis.devicePixelRatio || 1)),
    typeface,
    promptTab: browserPreview || !host.attached,
    onViewModeChange(mode) {
      reviewSession.setViewMode(mode);
    },
    onTabChange() {
      promptSheet?.setOpen(Boolean(liveFeed.visible && liveFeed.tab === 'prompt'));
    },
    onVisibilityChange() {
      promptSheet?.setOpen(Boolean(liveFeed.visible && liveFeed.tab === 'prompt'));
    },
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
    getCamera: () => reviewSession.renderCamera,
    excludedObjects: [liveFeed.sprite],
    async renderFrame({ target, camera: activeCamera, width, height, pass }) {
      if (pass !== "objectId") {
        const renderedWithRtx = await rtxLighting.render({
          scene,
          camera: activeCamera,
          width,
          height,
          outputTarget: target,
        });
        if (renderedWithRtx) return;
      }
      renderer.render(scene, activeCamera);
    },
  });
  const started = performance.now() * 0.001;
  let application = null;

  let lastPresentation = '';
  let gpuResizeTimer = null;
  function applyGpuSize(width, height, pixelRatio) {
    const key = `${width}x${height}@${pixelRatio}`;
    const bufferWidth = Math.max(1, Math.round(width * pixelRatio));
    const bufferHeight = Math.max(1, Math.round(height * pixelRatio));
    if (key === lastPresentation
        && renderer.domElement.width === bufferWidth
        && renderer.domElement.height === bufferHeight) {
      return;
    }
    lastPresentation = key;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    renderer.domElement.style.left = '0';
    renderer.domElement.style.top = '0';
  }

  function resize() {
    const width = Math.max(1, Number(innerWidth) || 1);
    const height = Math.max(1, Number(innerHeight) || 1);
    const pixelRatio = Math.max(1, Number(globalThis.devicePixelRatio || 1));
    updateCameraAspect(reviewSession.renderCamera, width / height);
    liveFeed.resize(width, height, pixelRatio);
    promptSheet?.layout();
    if (lastPresentation === '') {
      applyGpuSize(width, height, pixelRatio);
      return;
    }
    if (gpuResizeTimer !== null) {
      try { clearTimeout(gpuResizeTimer); } catch { /* ignore */ }
    }
    gpuResizeTimer = setTimeout(() => {
      gpuResizeTimer = null;
      applyGpuSize(width, height, pixelRatio);
    }, 140);
  }

  let disposed = false;
  async function dispose() {
    if (disposed) return;
    disposed = true;
    renderer.setAnimationLoop(null);
    globalThis.removeEventListener("resize", resize);
    promptSheet?.dispose();
    promptSheet = null;
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
      return reviewSession.renderCamera;
    },
    get authoredCamera() {
      return reviewSession.authoredCamera;
    },
    get viewMode() {
      return reviewSession.viewMode;
    },
    setRenderCamera(nextCamera) {
      reviewSession.setAuthoredCamera(nextCamera ?? camera);
    },
    setAuthoredCamera(nextCamera) {
      reviewSession.setAuthoredCamera(nextCamera ?? null);
    },
    followShot() {
      return reviewSession.followShot();
    },
    enterReview(options) {
      return reviewSession.enterReview(options);
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
      reviewSession.enterReview({ seedFromAuthored: false });
    },
    setTitle({ project = "waiting for project", scene: sceneName = "", revision = 0, dirty = false } = {}) {
      document.title = `ThreeBrowser Studio — ${project}${sceneName ? ` / ${sceneName}` : ""} — r${revision}${dirty ? " *" : ""}`;
    },
    setExplorerOutline(outline) {
      liveFeed.setExplorerOutline?.(outline);
    },
    dispose,
  });
  globalThis.__THREE_STUDIO_VIEWPORT__ = viewportApi;

  try {
    if (host.attached && !browserPreview) {
      const { startStudioApplication } = await import("../runtime/studio-application.mjs");
      application = await startStudioApplication({
        THREE,
        TSL,
        viewport: viewportApi,
        bootstrap,
        beginCommand: commandTelemetry.begin,
      });
    } else {
      document.title = "ThreeBrowser Studio — browser preview";
      console.log("[ThreeBrowser Studio] browser host: MCP pipe and project kernel stay on the desktop runtime");
      const { createSecretVault } = await import("../browser/secret-vault.mjs");
      const { createBrowserMcpHarness, createUnavailableStudioDispatch } = await import("../browser/mcp-harness.mjs");
      const { createBrowserPromptSession } = await import("../browser/prompt-session.mjs");
      const { createBrowserPromptPanel } = await import("../browser/prompt-panel.mjs");
      const session = createBrowserPromptSession({
        vault: createSecretVault(),
        harness: createBrowserMcpHarness({
          dispatch: createUnavailableStudioDispatch(),
        }),
      });
      promptSheet = createBrowserPromptPanel({
        document,
        session,
        getBounds: () => liveFeed.panelBounds,
      });
    }
  } catch (error) {
    await dispose();
    throw error;
  }
  if (application) globalThis.__THREE_STUDIO_APPLICATION__ = application;
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
      if (reviewSession.viewMode !== VIEW_MODE_FOLLOW_SHOT) controls.update(delta);
      renderer.setRenderTarget(null);
      renderer.setMRT(null);
      const activeCamera = reviewSession.renderCamera;
      liveFeed.updateCamera(activeCamera);
      const renderedWithRtx = await rtxLighting.render({
        scene,
        camera: activeCamera,
        width: renderer.domElement.width,
        height: renderer.domElement.height,
        outputTarget: null,
      });
      if (!renderedWithRtx) renderer.render(scene, activeCamera);
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
