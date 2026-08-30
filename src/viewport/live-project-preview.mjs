import { StudioError } from '../core/errors.mjs';
import { compileSceneDocument } from '../runtime/scene-compiler.mjs';
import { buildExplorerOutline } from './scene-explorer.mjs';

export function createLiveProjectPreview({ THREE, TSL, viewport, getAspect } = {}) {
  if (!THREE?.Scene || !viewport?.scene) {
    throw new TypeError('A Three.js runtime and live viewport are required');
  }
  let compiled = null;
  let document = null;

  async function compile(project) {
    const aspect = typeof getAspect === 'function' ? getAspect() : 16 / 9;
    const candidate = compileSceneDocument({ THREE, TSL, project, aspect });
    const errors = candidate.diagnostics.filter(item => item.severity === 'error');
    if (errors.length) {
      candidate.dispose();
      throw new StudioError('runtime_compile_failed', 'The candidate scene did not compile.', {
        diagnostics: errors,
      });
    }
    if (typeof viewport.renderer?.compileAsync === 'function' && candidate.activeCamera) {
      const staging = new THREE.Scene();
      staging.add(candidate.root);
      staging.background = candidate.background;
      staging.backgroundNode = candidate.backgroundNode;
      staging.fog = candidate.fog;
      try {
        await viewport.renderer.compileAsync(staging, candidate.activeCamera);
      } catch (error) {
        candidate.dispose();
        throw new StudioError('runtime_pipeline_failed', 'WebGPU pipeline preparation failed.', {
          diagnostics: [{ severity: 'error', code: 'runtime_pipeline_failed', message: error.message }],
        });
      } finally {
        candidate.root.removeFromParent();
        staging.background = null;
        staging.backgroundNode = null;
        staging.fog = null;
      }
    }
    return candidate;
  }

  async function show(project, { onBeforeSwap } = {}) {
    const next = await compile(project);
    const previous = compiled;
    try {
      onBeforeSwap?.();
      viewport.scene.add(next.root);
      viewport.setAppearance?.(next);
      viewport.setAuthoredCamera?.(next.activeCamera ?? viewport.camera);
      viewport.followShot?.();
    } catch (error) {
      next.dispose();
      throw error;
    }
    compiled = next;
    document = project;
    previous?.dispose();
    const scene = project.scenes[project.activeSceneId];
    if (typeof viewport.configureRtx === 'function') {
      next.root.updateWorldMatrix?.(true, true);
      void Promise.resolve(viewport.configureRtx({
        root: next.root,
        settings: scene?.settings?.rtx ?? {},
      })).catch(error => console.warn('[ThreeBrowser Studio RTX]', error.message));
    }
    viewport.setTitle?.({
      project: project.name,
      scene: scene?.name,
      revision: project.revision,
      dirty: false,
    });
    viewport.setExplorerOutline?.(buildExplorerOutline(project));
    return { document: project };
  }

  function dispose() {
    compiled?.dispose();
    compiled = null;
    document = null;
  }

  return Object.freeze({
    get document() { return document; },
    show,
    dispose,
  });
}
