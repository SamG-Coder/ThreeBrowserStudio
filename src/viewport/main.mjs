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
import {
  createBrowserPreviewDocument,
  createProjectPack,
  parseProjectPack,
  projectPackFileName,
} from "../core/project-pack.mjs";
import { openProjectPackFile, saveProjectPackFile } from "./project-file-transfer.mjs";
import { showStarterProjectFromLocation } from "../browser/starter-project-scene.mjs";
import { createSceneControllerInput } from './scene-controller-input.mjs';
import { createViewportLayers } from './viewport-layers.mjs';
import { LOCAL_MODEL_CATALOG } from '../browser/local-model-catalog.mjs';
import { createLocalModelManager } from '../browser/local-model-manager.mjs';
import { createBrowserMcpHarness } from '../browser/mcp-harness.mjs';
import { createLocalModelDirectWorker } from '../browser/local-model-direct-worker.mjs';
import { LOCAL_AI_SYSTEM_PROMPT, localAiToolNames, requiredLocalAiTools } from '../browser/local-ai-policy.mjs';
import { createProjectWorkspaceActions } from './project-workspace-actions.mjs';
import { applyComponentWorkspace, readComponentWorkspace } from './component-workspace.mjs';
import { createTransactionId } from '../core/util.mjs';

const NATIVE_WEBLLM_RUNTIME_URL = new URL('../../node_modules/@mlc-ai/web-llm/lib/index.js', import.meta.url).href;
const LOCAL_PROMPT_ENABLED_KEY = 'three-browser-studio.local-prompt.enabled';
function readLocalPromptEnabled() {
  try {
    return globalThis.localStorage?.getItem(LOCAL_PROMPT_ENABLED_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeLocalPromptEnabled(enabled) {
  try {
    globalThis.localStorage?.setItem(LOCAL_PROMPT_ENABLED_KEY, enabled === true ? 'true' : 'false');
  } catch {
    // Some embedded or privacy-restricted hosts do not expose persistent storage.
  }
}

async function importNativeWebLlm() {
  // The native surface exposes Node globals for Studio, but WebLLM's bundled
  // Emscripten modules must select their browser/WebGPU branch. Rewrite only
  // those compile-time environment probes; never hide globals from the host.
  const processObject = globalThis.process;
  const fs = processObject?.getBuiltinModule?.('fs');
  const nodeUrl = processObject?.getBuiltinModule?.('url');
  if (!fs || !nodeUrl || typeof globalThis.Buffer?.from !== 'function') {
    throw new Error('The native WebLLM runtime could not be loaded locally.');
  }
  const source = fs.readFileSync(nodeUrl.fileURLToPath(NATIVE_WEBLLM_RUNTIME_URL), 'utf8')
    .replace(/typeof process=="object"&&typeof process\.versions=="object"&&typeof process\.versions\.node=="string"/g, 'false')
    .replace(/typeof process === "object" && typeof process\.versions === "object" && typeof process\.versions\.node === "string"/g, 'false');
  const moduleUrl = `data:text/javascript;base64,${globalThis.Buffer.from(source).toString('base64')}`;
  return import(moduleUrl);
}

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
  let controllerInput = null;
  const reviewSession = createReviewSession({
    THREE,
    reviewCamera: camera,
    controls,
    onChange() {
      controls.enabled = reviewSession.viewMode !== VIEW_MODE_FOLLOW_SHOT && controllerInput?.active !== true;
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

  const browserHost = browserPreview || !host.attached;
  const nativeTransfer = !browserHost;
  const bootstrap = createBootstrapScene();
  if (!browserHost) scene.add(bootstrap.root);
  const commandTelemetry = createStudioCommandTelemetry({
    onSinkError: error => console.warn("[ThreeBrowser Studio live feed]", error?.message || error),
  });
  let typeface = null;
  if (host.attached) {
    const { getSystemTypeface } = await import("./system-typeface.mjs");
    typeface = getSystemTypeface();
  }
  let localModelManager = createLocalModelManager({
    ...(host.attached ? {
      workerFactory: () => createLocalModelDirectWorker({
        importModule: importNativeWebLlm,
        runtimeBaseUrl: NATIVE_WEBLLM_RUNTIME_URL,
      }),
    } : {}),
  });
  let localModelUnsubscribe = null;
  let localAiHarness = null;
  let localAiBusy = false;
  let application = null;
  let projectWorkspaceActions = null;
  let rtxLighting = null;
  let activeRtxSettings = {};
  let preview = null;
  let viewportLayers = null;
  let bootstrapDisposed = browserHost;
  let transferBusy = false;
  let initialBrowserProjectStatus = null;
  const liveFeed = createMcpLiveFeedWebGpuHud({
    THREE,
    scene,
    source: commandTelemetry,
    width: Math.max(1, innerWidth),
    height: Math.max(1, innerHeight),
    pixelRatio: Math.max(1, Number(globalThis.devicePixelRatio || 1)),
    typeface,
    llmSetupTab: true,
    localModels: LOCAL_MODEL_CATALOG,
    promptEnabled: readLocalPromptEnabled(),
    onViewModeChange(mode) {
      reviewSession.setViewMode(mode);
    },
    onViewportLayerChange(patch) {
      if (patch?.mode) viewportLayers?.setMode(patch.mode);
      if (patch?.gridVisible !== undefined) viewportLayers?.setGridVisible(patch.gridVisible);
      if (patch?.studioLightVisible !== undefined) viewportLayers?.setStudioLightVisible(patch.studioLightVisible);
    },
    async onRtxSettingsChange(patch) {
      if (!application) throw new Error('The native Studio project is not ready.');
      await application.patchActiveSceneRtx(patch);
      activeRtxSettings = application.getActiveSceneRtxSettings();
      syncGraphicsSettingsState();
    },
    onDlss5SettingsChange(patch) {
      if (!rtxLighting) throw new Error('The native DLSS 5 controller is not ready.');
      rtxLighting.setDlss5Settings(patch);
      syncGraphicsSettingsState();
    },
    onProjectAction(action) {
      if (!projectWorkspaceActions) throw new Error('The Studio project is still loading.');
      return projectWorkspaceActions.run(action);
    },
    async onPlayToggle(currentMode) {
      if (!application?.dispatch || !application.document) throw new Error('The Studio project is still loading.');
      return application.dispatch('three_studio_play', {
        action: currentMode === 'play' ? 'stop' : 'enter',
        baseRevision: application.document.revision,
        idempotencyKey: createTransactionId('ui-play'),
      });
    },
    onExplorerEntitySelect(entityId) {
      return readComponentWorkspace(application?.document, entityId);
    },
    onExplorerComponentsApply(entityId, components) {
      return applyComponentWorkspace(application, entityId, components);
    },
    async onLocalModelActivate(modelId) {
      localAiBusy = true;
      try { return await localModelManager.activate(modelId); }
      finally { localAiBusy = false; }
    },
    async onLocalModelRemove(modelId) {
      return localModelManager.remove(modelId);
    },
    onPromptEnabledChange(enabled) {
      writeLocalPromptEnabled(enabled);
    },
    async onLocalPromptRun(prompt, { onEvent } = {}) {
      if (!localAiHarness) throw new Error('The Studio AI tool harness is not ready yet.');
      localAiBusy = true;
      try {
        return await localAiHarness.run({
          provider: localModelManager.provider(),
          messages: [
            { role: 'system', content: LOCAL_AI_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          onEvent,
          requiredFirstTool: 'three_studio_status',
          requiredToolNames: requiredLocalAiTools(prompt),
          availableToolNames: localAiToolNames(prompt),
          strictEnvelopes: true,
          maxModelToolResultChars: 6_000,
        });
      } finally {
        localAiBusy = false;
      }
    },
  });

  localModelUnsubscribe = localModelManager.subscribe(state => liveFeed.setLocalModelState(state));
  liveFeed.setLocalModelState(localModelManager.status());

  const presentCompiledLayer = compiled => {
    scene.background = compiled?.background ?? null;
    scene.backgroundNode = compiled?.backgroundNode ?? null;
    scene.fog = compiled?.fog ?? null;
    if (!scene.background && !scene.backgroundNode) renderer.setClearColor(STUDIO_RENDER_STATE.clearColor, 1);
    reviewSession.setAuthoredCamera(compiled?.activeCamera ?? camera);
  };
  viewportLayers = createViewportLayers({
    THREE,
    scene,
    onPresentationChange(compiled) {
      presentCompiledLayer(compiled);
    },
    onStateChange(state) {
      liveFeed.setViewportLayerState?.(state);
    },
  });

  function syncGraphicsSettingsState() {
    if (!rtxLighting) return;
    try { liveFeed.setPlayMode?.(application?.mode ?? application?.status?.().mode); } catch { /* Status display is best effort. */ }
    liveFeed.setGraphicsSettingsState?.({
      rtx: {
        authored: application?.getActiveSceneRtxSettings?.() ?? activeRtxSettings,
        status: rtxLighting.getStatus(),
      },
      dlss5: {
        settings: rtxLighting.getDlss5Settings(),
        status: rtxLighting.getDlss5Status(),
      },
    });
  }

  async function transferProject(action) {
    if (transferBusy) {
      return "A transfer is already running.";
    }
    if (nativeTransfer && !application) {
      return "Studio project is still loading. Try again in a moment.";
    }
    if (!nativeTransfer && !preview) {
      return "Project preview is still loading. Try again in a moment.";
    }
    transferBusy = true;
    try {
      if (action === "export") {
        liveFeed.setProjectTransferStatus("Exporting…");
        const pack = application
          ? await application.exportProjectDocument()
          : createProjectPack(preview?.document ?? createBrowserPreviewDocument());
        const saved = await saveProjectPackFile(projectPackFileName(pack.document), pack, {
          native: nativeTransfer,
        });
        if (!saved) {
          return "Export cancelled.";
        }
        return `Exported ${pack.document.name}.`;
      }
      liveFeed.setProjectTransferStatus("Choose a JSON pack…");
      const picked = await openProjectPackFile({ native: nativeTransfer });
      if (!picked) {
        return "Import cancelled.";
      }
      liveFeed.setProjectTransferStatus("Importing…");
      const document = parseProjectPack(picked.text);
      if (application) {
        await application.importProjectDocument(document);
      } else if (preview) {
        await preview.show(document);
      } else {
        throw new Error("Project preview is not ready.");
      }
      return `Imported ${document.name}.`;
    } catch (error) {
      liveFeed.setProjectTransferStatus(error?.message ?? String(error));
      console.warn("[ThreeBrowser Studio import/export]", error);
      throw error;
    } finally {
      transferBusy = false;
    }
  }
  rtxLighting = createRtxLightingController({
    THREE,
    TSL,
    renderer,
    rtx: globalThis.navigator?.gpu?.threeBrowserRTX ?? null,
    collectScene: root => collectRtxScene(root),
    normalizeSettings: adaptSceneRtxSettings,
    settings: {},
  });
  syncGraphicsSettingsState();
  const capture = createFrameCapture({
    renderer,
    scene,
    getCamera: () => reviewSession.renderCamera,
    excludedObjects: [liveFeed.sprite],
    async renderFrame({ target, camera: activeCamera, width, height, pass }) {
      if (pass === "beauty") {
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
    try { delete globalThis.__THREE_STUDIO_LOCAL_AI__; } catch { /* Host globals are best-effort diagnostics. */ }
    renderer.setAnimationLoop(null);
    globalThis.removeEventListener("resize", resize);
    localModelUnsubscribe?.();
    localModelUnsubscribe = null;
    localModelManager?.dispose();
    localModelManager = null;
    localAiHarness = null;
    await application?.dispose();
    preview?.dispose();
    preview = null;
    liveFeed.dispose();
    viewportLayers?.dispose();
    viewportLayers = null;
    commandTelemetry.dispose();
    capture.dispose();
    rtxLighting.dispose();
    controllerInput?.dispose();
    controllerInput = null;
    controls.dispose();
    if (!bootstrapDisposed) bootstrap.dispose();
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
    setCommittedLayer(compiled) {
      return viewportLayers?.setCommitted(compiled);
    },
    setPreviewLayer(compiled, options) {
      return viewportLayers?.setPreview(compiled, options);
    },
    clearPreviewLayer(options) {
      return viewportLayers?.clearPreview(options);
    },
    setViewportLayerMode(mode) {
      return viewportLayers?.setMode(mode);
    },
    setGridVisible(visible) {
      return viewportLayers?.setGridVisible(visible);
    },
    setStudioLightVisible(visible) {
      return viewportLayers?.setStudioLightVisible(visible);
    },
    getViewportLayerState() {
      return viewportLayers?.getState();
    },
    async configureRtx({ root, settings = {} } = {}) {
      activeRtxSettings = structuredClone(settings);
      rtxLighting.setSettings(settings);
      try {
        if (settings.enabled !== true) return false;
        rtxLighting.markStale("compiled scene revision changed");
        return await rtxLighting.configure({
          scene: root,
          width: renderer.domElement.width,
          height: renderer.domElement.height,
          settings,
        });
      } finally {
        syncGraphicsSettingsState();
      }
    },
    getRtxStatus() {
      return rtxLighting.getStatus();
    },
    getRtxDigest() {
      return rtxLighting.getDigest();
    },
    getDlss5Status() {
      return rtxLighting.getDlss5Status();
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
    setControllerState(state) {
      controllerInput?.sync?.(state);
    },
    dispose,
  });
  globalThis.__THREE_STUDIO_VIEWPORT__ = viewportApi;
  controllerInput = createSceneControllerInput({
    keyboard: globalThis,
    document: globalThis.document,
    domElement: renderer.domElement,
    getApplication: () => application,
    hud: liveFeed,
    controls,
  });

  try {
    if (host.attached && !browserPreview) {
      const { startStudioApplication } = await import("../runtime/studio-application.mjs");
      application = await startStudioApplication({
        THREE,
        TSL,
        viewport: viewportApi,
        bootstrap,
        beginCommand: commandTelemetry.begin,
        commandMetrics: commandTelemetry.metrics,
      });
    } else {
      document.title = "ThreeBrowser Studio — browser preview";
      console.log("[ThreeBrowser Studio] browser host: in-process authoring kernel enabled");
      const { createLiveProjectPreview } = await import("./live-project-preview.mjs");
      preview = createLiveProjectPreview({
        THREE,
        TSL,
        viewport: viewportApi,
        getAspect: () => Math.max(1, innerWidth) / Math.max(1, innerHeight),
      });
      const starterResult = await showStarterProjectFromLocation({
        preview,
        fallbackDocument: createBrowserPreviewDocument(),
        onRemoteError(error) {
          console.warn("[ThreeBrowser Studio remote starter]", error);
        },
      });
      const { createBrowserStudioSession } = await import("../browser/browser-studio-session.mjs");
      application = await createBrowserStudioSession({
        project: starterResult.document,
        preview,
        viewport: viewportApi,
        alreadyShown: true,
      });
      initialBrowserProjectStatus = starterResult.sourceUrl
        ? `Loaded ${starterResult.document.name} from GitHub.`
        : starterResult.error
          ? `Starter link failed: ${starterResult.error.message ?? String(starterResult.error)} Using bundled starter.`
          : null;
    }
    projectWorkspaceActions = createProjectWorkspaceActions({
      application: () => application,
      native: nativeTransfer,
      exportProject: () => transferProject('export'),
      importProject: () => transferProject('import'),
    });
  } catch (error) {
    await dispose();
    throw error;
  }
  localAiHarness = application ? createBrowserMcpHarness({ dispatch: application }) : null;
  if (application) globalThis.__THREE_STUDIO_APPLICATION__ = application;
  globalThis.__THREE_STUDIO_LOCAL_AI__ = Object.freeze({ manager: localModelManager, harness: localAiHarness });
  globalThis.__THREE_STUDIO_LIVE_FEED__ = liveFeed;
  liveFeed.setProjectTransferStatus(nativeTransfer
    ? "Canonical project actions route through Studio."
    : initialBrowserProjectStatus ?? "Canonical project actions route through Studio.");
  syncGraphicsSettingsState();

  globalThis.addEventListener("resize", resize);
  globalThis.addEventListener("beforeunload", () => { void dispose(); }, { once: true });
  resize();
  let previousFrame = performance.now() * 0.001;
  let previousAiFrame = 0;
  let nextGraphicsStatusSync = 0;
  let renderingFrame = false;
  renderer.setAnimationLoop(async () => {
    if (disposed || renderingFrame) return;
    const frameMilliseconds = performance.now();
    if (localAiBusy && frameMilliseconds - previousAiFrame < 66) return;
    previousAiFrame = frameMilliseconds;
    renderingFrame = true;
    try {
      const now = performance.now() * 0.001;
      const elapsed = now - started;
      const delta = Math.min(0.1, Math.max(0, now - previousFrame));
      previousFrame = now;
      if (now >= nextGraphicsStatusSync) {
        nextGraphicsStatusSync = now + 0.25;
        syncGraphicsSettingsState();
      }
      if (bootstrap.root.parent) bootstrap.update(elapsed);
      application?.update(delta);
      if (reviewSession.viewMode !== VIEW_MODE_FOLLOW_SHOT && controllerInput?.active !== true) controls.update(delta);
      renderer.setRenderTarget(null);
      renderer.setMRT(null);
      const activeCamera = reviewSession.renderCamera;
      liveFeed.updateCamera(activeCamera);
      const panelBounds = liveFeed.panelBounds;
      const renderedWithRtx = await rtxLighting.render({
        scene,
        camera: activeCamera,
        width: renderer.domElement.width,
        height: renderer.domElement.height,
        outputTarget: null,
        overlay: {
          object: liveFeed.sprite,
          texture: liveFeed.texture,
          bounds: panelBounds,
          viewport: {
            width: Math.max(1, Number(innerWidth) || 1),
            height: Math.max(1, Number(innerHeight) || 1),
          },
          visible: liveFeed.webGpuPresentation && liveFeed.visible,
        },
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
