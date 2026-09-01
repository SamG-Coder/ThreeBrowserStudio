import { StudioError } from '../core/errors.mjs';
import { LOCAL_MODEL_CATALOG, getLocalModel } from './local-model-catalog.mjs';
import { createLocalModelProvider } from './local-model-provider.mjs';

const STORAGE_KEY = 'three-studio-local-model-v1';

export function createLocalModelManager({
  storage = globalThis.localStorage,
  navigator = globalThis.navigator,
  workerFactory = () => new Worker(new URL('./local-model-worker.mjs', import.meta.url), { type: 'module', name: 'three-studio-local-ai' }),
} = {}) {
  let provider = null;
  let ready = false;
  let activeModelId = null;
  let progress = null;
  const listeners = new Set();
  try { activeModelId = JSON.parse(storage?.getItem?.(STORAGE_KEY) ?? 'null')?.activeModelId ?? null; } catch { activeModelId = null; }

  const emit = () => {
    const value = manager.status();
    for (const listener of listeners) listener(value);
  };
  const persist = () => storage?.setItem?.(STORAGE_KEY, JSON.stringify({ activeModelId }));

  const manager = Object.freeze({
    catalog() { return LOCAL_MODEL_CATALOG; },
    status() { return Object.freeze({ supported: Boolean(navigator?.gpu), activeModelId, ready, progress }); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async activate(modelId, { signal } = {}) {
      if (!navigator?.gpu) throw new StudioError('webgpu_unavailable', 'WebGPU is required for local AI.');
      const model = getLocalModel(modelId);
      if (!model) throw new StudioError('local_model_unknown', `Unknown local model ${modelId}.`);
      provider?.dispose();
      ready = false;
      progress = { text: 'Preparing model…', progress: 0 };
      provider = createLocalModelProvider({ model, worker: workerFactory(), onProgress(value) { progress = value; emit(); } });
      emit();
      try { await navigator.storage?.persist?.(); } catch { /* Persistence is a best-effort browser hint. */ }
      try {
        await provider.initialize({ signal });
      } catch (error) {
        provider.dispose();
        provider = null;
        ready = false;
        progress = null;
        emit();
        throw error;
      }
      activeModelId = model.id;
      ready = true;
      progress = null;
      persist();
      emit();
      return provider;
    },
    provider() {
      if (!provider || !ready) throw new StudioError('local_model_required', 'Download and activate a local model first.');
      return provider;
    },
    async remove(modelId) {
      const model = getLocalModel(modelId);
      if (!model) return { removed: false };
      if (!provider || activeModelId !== modelId) {
        const temporary = createLocalModelProvider({ model, worker: workerFactory() });
        try { return await temporary.remove(); } finally { temporary.dispose(); }
      }
      const result = await provider.remove();
      provider.dispose();
      provider = null;
      ready = false;
      activeModelId = null;
      persist();
      emit();
      return result;
    },
    dispose() { provider?.dispose(); provider = null; ready = false; listeners.clear(); },
  });
  return manager;
}
