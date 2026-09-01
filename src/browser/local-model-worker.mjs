let engine = null;
let activeModelId = null;
let runtimeModule = null;

function send(id, type, value) {
  globalThis.postMessage({ id, type, value });
}

async function loadRuntime(url) {
  runtimeModule ??= await import(url);
  return runtimeModule;
}

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
    });
    activeModelId = payload.modelId;
  }
  return { modelId: activeModelId };
}

async function complete(payload) {
  if (!engine) throw new Error('Initialize the local model before prompting it.');
  return engine.chat.completions.create({
    model: activeModelId,
    messages: payload.messages,
    temperature: payload.temperature ?? 0.1,
    max_tokens: payload.maxTokens ?? 700,
  });
}

async function removeModel(payload) {
  if (engine && activeModelId === payload.modelId) {
    await engine.unload?.();
    engine = null;
    activeModelId = null;
  }
  const runtime = await loadRuntime(payload.runtimeUrl);
  const remove = runtime.deleteModelAllInfoInCache ?? runtime.deleteModelInCache;
  if (typeof remove !== 'function') return { removed: false, reason: 'cache-api-unavailable' };
  await remove(payload.modelId);
  return { removed: true };
}

globalThis.addEventListener('message', async event => {
  const { id, command, payload = {} } = event.data ?? {};
  if (!id) return;
  try {
    let value;
    if (command === 'initialize') value = await initialize(id, payload);
    else if (command === 'complete') value = await complete(payload);
    else if (command === 'remove') value = await removeModel(payload);
    else if (command === 'unload') {
      await engine?.unload?.();
      engine = null;
      activeModelId = null;
      value = { unloaded: true };
    } else throw new Error(`Unknown local-model worker command ${command}.`);
    send(id, 'result', value);
  } catch (error) {
    send(id, 'error', { message: error?.message ?? String(error) });
  }
});
