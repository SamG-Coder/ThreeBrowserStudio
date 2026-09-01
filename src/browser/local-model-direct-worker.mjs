import { installNativeCacheStorage } from './native-cache-storage.mjs';

/**
 * Worker-shaped WebLLM adapter for hosts whose main surface exposes WebGPU but
 * whose WorkerGlobalScope does not (notably the native ThreeBrowser host).
 * The provider stays transport-agnostic and receives the same message events.
 */
export function createLocalModelDirectWorker({ importModule = url => import(url), runtimeBaseUrl = import.meta.url } = {}) {
  const NativeURL = globalThis.URL;
  if (globalThis.__threeBrowserNativeRuntime === true && typeof NativeURL === 'function') {
    function NativeCompatibleURL(input, base) {
      const source = String(input);
      try {
        return base === undefined ? new NativeURL(source) : new NativeURL(source, base);
      } catch {
        return new NativeURL(source, runtimeBaseUrl);
      }
    }
    NativeCompatibleURL.prototype = NativeURL.prototype;
    Object.setPrototypeOf(NativeCompatibleURL, NativeURL);
    for (const name of ['createObjectURL', 'revokeObjectURL', 'canParse', 'parse']) {
      if (typeof NativeURL[name] === 'function') NativeCompatibleURL[name] = NativeURL[name].bind(NativeURL);
    }
    globalThis.URL = NativeCompatibleURL;
    installNativeCacheStorage();
  }
  const listeners = new Set();
  let engine = null;
  let activeModelId = null;
  let runtimeModule = null;
  let terminated = false;

  const send = (id, type, value) => {
    if (terminated) return;
    const event = Object.freeze({ data: Object.freeze({ id, type, value }) });
    for (const listener of listeners) listener(event);
  };
  const loadRuntime = async url => {
    runtimeModule ??= await importModule(url);
    return runtimeModule;
  };
  const appConfigFor = runtime => runtime.prebuiltAppConfig
    ? { ...runtime.prebuiltAppConfig, useIndexedDBCache: false }
    : undefined;

  async function initialize(id, payload) {
    if (!globalThis.navigator?.gpu) throw new Error('WebGPU is required for local model inference.');
    const runtime = await loadRuntime(payload.runtimeUrl);
    if (engine && activeModelId !== payload.modelId) {
      await engine.unload?.();
      engine = null;
    }
    if (!engine) {
      engine = await runtime.CreateMLCEngine(payload.modelId, {
        initProgressCallback(progress) { send(id, 'progress', progress); },
        ...(appConfigFor(runtime) ? { appConfig: appConfigFor(runtime) } : {}),
      });
      activeModelId = payload.modelId;
    }
    return { modelId: activeModelId };
  }

  async function execute(id, command, payload) {
    if (command === 'initialize') return initialize(id, payload);
    if (command === 'complete') {
      if (!engine) throw new Error('Initialize the local model before prompting it.');
      return engine.chat.completions.create({
        model: activeModelId,
        messages: payload.messages,
        temperature: payload.temperature ?? 0.1,
        max_tokens: payload.maxTokens ?? 700,
      });
    }
    if (command === 'remove') {
      if (engine && activeModelId === payload.modelId) {
        await engine.unload?.();
        engine = null;
        activeModelId = null;
      }
      const runtime = await loadRuntime(payload.runtimeUrl);
      const remove = runtime.deleteModelAllInfoInCache ?? runtime.deleteModelInCache;
      if (typeof remove !== 'function') return { removed: false, reason: 'cache-api-unavailable' };
      await remove(payload.modelId, appConfigFor(runtime));
      return { removed: true };
    }
    if (command === 'unload') {
      await engine?.unload?.();
      engine = null;
      activeModelId = null;
      return { unloaded: true };
    }
    throw new Error(`Unknown local-model command ${command}.`);
  }

  return Object.freeze({
    addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
    postMessage(message) {
      const { id, command, payload = {} } = message ?? {};
      if (!id || terminated) return;
      void Promise.resolve().then(async () => {
        try { send(id, 'result', await execute(id, command, payload)); }
        catch (error) {
          console.error('[ThreeBrowser Studio local AI]', error?.stack ?? error?.message ?? String(error));
          const trace = String(error?.stack ?? '').split(/\r?\n/).slice(1, 3).map(line => line.trim()).join(' · ');
          send(id, 'error', { message: trace ? `${trace} · ${error?.message ?? String(error)}` : (error?.message ?? String(error)) });
        }
      });
    },
    terminate() {
      terminated = true;
      listeners.clear();
      void engine?.unload?.();
      engine = null;
      activeModelId = null;
    },
  });
}
