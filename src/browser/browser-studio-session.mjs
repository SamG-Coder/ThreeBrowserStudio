import { AuthoringKernel } from '../core/kernel.mjs';
import { PROTOCOL_VERSION } from '../core/constants.mjs';
import { validateProjectDocument } from '../core/documents.mjs';
import { StudioError } from '../core/errors.mjs';
import { createTransactionId } from '../core/util.mjs';
import { queryEntityComponentCatalog } from '../core/component-catalog.mjs';
import { createProjectPack } from '../core/project-pack.mjs';
import { createLogicControllerRuntime } from '../runtime/logic-controller-runtime.mjs';
import { buildExplorerOutline } from '../viewport/scene-explorer.mjs';

function toolTarget(params, kernel) {
  if (params?.projectId && params.projectId !== kernel.projectId) {
    throw new StudioError('project_mismatch', `Browser session owns ${kernel.projectId}, not ${params.projectId}.`);
  }
}

function mutationRequest(params, kernel, fallbackLabel) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    projectId: kernel.projectId,
    baseRevision: params.baseRevision ?? kernel.revision,
    idempotencyKey: params.idempotencyKey ?? createTransactionId('browser'),
    label: params.label ?? fallbackLabel,
  };
}

export async function createBrowserStudioSession({ project, preview, viewport, alreadyShown = false } = {}) {
  if (!project || !preview?.prepare || !viewport) throw new TypeError('project, preview, and viewport are required.');

  let kernel = null;
  let unsubscribe = null;
  let pendingCandidate = null;
  let controller = null;
  let disposed = false;
  let mode = 'author';
  let play = { paused: false, tick: 0, elapsed: 0, latestInput: null };

  function scene() {
    const document = kernel.document;
    return document.scenes[document.activeSceneId];
  }

  function rebuildController() {
    controller?.stop?.();
    const document = kernel.document;
    const activeScene = document.scenes[document.activeSceneId];
    controller = createLogicControllerRuntime({
      project: document,
      scene: activeScene,
      objects: preview.compiled?.objects,
      animationRuntime: preview.compiled?.animationRuntime,
      setActiveCamera(entityId) {
        const camera = preview.compiled?.objects?.get?.(entityId);
        if (!camera?.isCamera) return false;
        viewport.setAuthoredCamera?.(camera);
        viewport.followShot?.();
        return true;
      },
    });
    viewport.setControllerState?.(controller.status);
  }

  async function attach(nextProject, { alreadyShown = false } = {}) {
    unsubscribe?.();
    pendingCandidate?.dispose?.();
    pendingCandidate = null;
    if (!alreadyShown) await preview.show(nextProject);
    kernel = new AuthoringKernel(nextProject, {
      prepare: async (candidateDocument, context) => {
        const candidate = await preview.prepare(candidateDocument);
        if (context.dryRun) {
          candidate.dispose();
          return;
        }
        pendingCandidate?.dispose?.();
        pendingCandidate = candidate;
      },
    });
    unsubscribe = kernel.subscribe(async () => {
      const candidate = pendingCandidate;
      pendingCandidate = null;
      if (candidate) await candidate.show();
      viewport.setExplorerOutline?.(buildExplorerOutline(kernel.document));
      rebuildController();
    });
    rebuildController();
  }

  function animationState() {
    return {
      actions: preview.compiled?.animationStates?.() ?? [],
      timelineGeometryModifierIds: preview.compiled?.timelineGeometryModifierIds ?? [],
      timelineGeometrySampleCount: preview.compiled?.timelineGeometrySampleCount ?? 0,
    };
  }

  function status() {
    const base = kernel.status();
    return {
      success: true,
      ...base,
      mode,
      play: { ...play, controller: controller?.status ?? null, ...animationState() },
      viewport: { ready: true, renderer: 'webgpu', cameraId: scene()?.settings?.activeCameraId ?? null },
      capabilities: {
        browserKernel: true,
        liveSceneCompilation: true,
        controllerRuntime: true,
        componentComposer: true,
        componentOperations: ['attach', 'remove'],
        history: true,
        projectImportExport: true,
        renderEvidence: false,
        jobs: false,
      },
    };
  }

  function stopPlay() {
    controller?.stop?.();
    mode = 'author';
    play = { paused: false, tick: 0, elapsed: 0, latestInput: null };
    const timeline = scene()?.settings?.timeline;
    const authoredTime = timeline
      ? (timeline.currentFrame - timeline.frameStart) / timeline.framesPerSecond
      : 0;
    preview.compiled?.setAnimationTime?.(authoredTime);
    for (const action of preview.compiled?.animationRuntime?.actions?.values?.() ?? []) {
      preview.compiled.animationRuntime.pause(action.id);
    }
    viewport.setControllerState?.(controller?.status ?? { active: false });
    return controller?.status ?? { active: false };
  }

  function enterPlay({ activateController = true } = {}) {
    if (controller?.active) controller.stop();
    mode = 'play';
    play = { paused: false, tick: 0, elapsed: 0, latestInput: null };
    preview.compiled?.setAnimationTime?.(0);
    for (const action of preview.compiled?.animationRuntime?.actions?.values?.() ?? []) {
      if (action.autoplay) preview.compiled.animationRuntime.play(action.id, { restart: true });
      else preview.compiled.animationRuntime.pause(action.id);
    }
    if (activateController) controller?.activate?.();
    viewport.setControllerState?.(controller?.status ?? { active: false });
    return controller?.status ?? { active: false };
  }

  function playTool(params = {}) {
    toolTarget(params, kernel);
    if (params.action === 'query' || !params.action) return { success: true, revision: kernel.revision, mode, ...play, ...animationState(), controller: controller?.status ?? null };
    if ((params.baseRevision ?? kernel.revision) !== kernel.revision) {
      throw new StudioError('revision_conflict', `Base revision ${params.baseRevision} does not match ${kernel.revision}.`);
    }
    if (params.action === 'enter') enterPlay();
    else if (params.action === 'stop') stopPlay();
    else if (params.action === 'pause') play.paused = true;
    else if (params.action === 'resume') play.paused = false;
    else if (params.action === 'step') {
      const ticks = Math.max(1, Math.min(600, Number(params.ticks) || 1));
      const delta = ticks / 60;
      play.tick += ticks;
      play.elapsed += delta;
      preview.compiled?.advanceAnimation?.(delta, { restorePose: controller?.active !== true });
      controller?.update?.(delta);
    } else if (params.action === 'seek') {
      const timeline = scene()?.settings?.timeline;
      const frame = Number(params.frame) || timeline?.frameStart || 0;
      play.elapsed = timeline ? (frame - timeline.frameStart) / timeline.framesPerSecond : 0;
      play.tick = Math.round(play.elapsed * 60);
      preview.compiled?.setAnimationTime?.(play.elapsed);
    } else if (params.action === 'inject') {
      play.latestInput = { action: params.inputAction ?? null, input: params.input ?? null };
    } else throw new StudioError('play_action_not_implemented', `Unknown Play action ${params.action}.`);
    return { success: true, revision: kernel.revision, mode, ...play, ...animationState(), controller: controller?.status ?? null };
  }

  async function dispatch(name, params = {}, context = {}) {
    if (disposed) throw new StudioError('session_disposed', 'The browser Studio session is closed.');
    toolTarget(params, kernel);
    switch (name) {
      case 'three_studio_status': return status();
      case 'three_studio_inspect': {
        const document = kernel.document;
        const activeScene = document.scenes[document.activeSceneId];
        if (params.query === 'playState') return playTool({ action: 'query' });
        if (params.query === 'operationCatalog' && params.selector?.kind === 'component') {
          return { success: true, revision: kernel.revision, entries: queryEntityComponentCatalog() };
        }
        const ids = params.selector?.ids;
        const entities = Array.isArray(ids)
          ? ids.map(id => activeScene.entities[id]).filter(Boolean)
          : Object.values(activeScene.entities);
        return { success: true, revision: kernel.revision, scene: { id: activeScene.id, name: activeScene.name }, entities };
      }
      case 'three_studio_apply': return kernel.apply({
        ...mutationRequest(params, kernel, 'Apply browser Studio changes'),
        dryRun: params.dryRun === true,
        operations: params.operations,
      }, context);
      case 'three_studio_validate': {
        const result = validateProjectDocument(kernel.document);
        return { success: result.valid, revision: kernel.revision, ...result };
      }
      case 'three_studio_history': {
        if (params.action === 'undo' || params.action === 'redo') {
          return kernel[params.action]({
            ...mutationRequest(params, kernel, `${params.action} browser Studio change`),
            ...(params.transactionId ? { transactionId: params.transactionId } : {}),
          });
        }
        const entries = kernel.history({ limit: params.limit, includeOperations: params.action === 'inspect' });
        return { success: true, revision: kernel.revision, entries: params.action === 'inspect' ? entries.filter(item => item.transactionId === params.transactionId) : entries };
      }
      case 'three_studio_project': {
        if (params.action === 'export' || params.action === 'query') return { success: true, revision: kernel.revision, pack: createProjectPack(kernel.document) };
        throw new StudioError('project_action_not_implemented', `Browser project action ${params.action} is not available through AI.`);
      }
      case 'three_studio_play': return playTool(params);
      case 'three_studio_render': throw new StudioError('capability_unavailable', 'Browser evidence file rendering is not enabled yet.');
      case 'three_studio_job': throw new StudioError('capability_unavailable', 'Browser file-producing jobs are not enabled.');
      default: throw new StudioError('method_not_found', `Unknown Studio method ${name}.`);
    }
  }

  const api = Object.freeze({
    dispatch,
    status,
    get document() { return kernel.document; },
    get mode() { return mode; },
    getControllerStatus() { return controller?.status ?? { available: false, active: false, activationKey: null, capture: null }; },
    controllerKeyDown(code, { repeat = false } = {}) {
      const key = String(code ?? '');
      if (key === 'Escape' && mode === 'play') return { handled: true, action: 'deactivated', ...stopPlay() };
      if (mode !== 'play') {
        const activationKey = controller?.settings?.activationKey ?? 'Enter';
        if (repeat || key !== activationKey) return { handled: false, ...api.getControllerStatus() };
        const state = enterPlay();
        return { handled: true, action: 'activated', activationKey, ...state };
      }
      const handled = controller?.keyDown?.(key, { repeat }) ?? false;
      return { handled, action: 'input', ...api.getControllerStatus() };
    },
    controllerKeyUp(code) {
      const handled = controller?.keyUp?.(String(code ?? '')) ?? false;
      return { handled, action: 'input', ...api.getControllerStatus() };
    },
    releaseControllerKeys() { controller?.releaseKeys?.(); },
    enterPlay,
    stopPlay,
    togglePlay() { return mode === 'play' ? stopPlay() : enterPlay(); },
    update(deltaSeconds) {
      if (disposed || mode !== 'play' || play.paused || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
      play.elapsed += deltaSeconds;
      play.tick = Math.round(play.elapsed * 60);
      preview.compiled?.advanceAnimation?.(deltaSeconds, { restorePose: controller?.active !== true });
      controller?.update?.(deltaSeconds);
    },
    async exportProjectDocument() { return createProjectPack(kernel.document); },
    async importProjectDocument(document) { stopPlay(); await attach(document); return { success: true, revision: kernel.revision }; },
    getActiveSceneRtxSettings() { return structuredClone(scene()?.settings?.rtx ?? {}); },
    async patchActiveSceneRtx(patch) {
      return dispatch('three_studio_apply', {
        baseRevision: kernel.revision,
        label: 'Update RTX settings from browser Studio',
        idempotencyKey: createTransactionId('ui-rtx'),
        operations: [{ op: 'scene.rtx.patch', sceneId: scene().id, patch }],
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopPlay();
      unsubscribe?.();
      pendingCandidate?.dispose?.();
    },
  });

  await attach(project, { alreadyShown });
  return api;
}
