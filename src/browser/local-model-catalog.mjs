export const LOCAL_MODEL_RUNTIME_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.81/+esm';

export const LOCAL_MODEL_CATALOG = Object.freeze([
  Object.freeze({
    id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    label: 'Llama 3.2 1B · Fast',
    source: 'https://huggingface.co/mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC',
    runtime: 'webllm',
    runtimeUrl: LOCAL_MODEL_RUNTIME_URL,
    vramRequiredMB: 880,
    contextTokens: 4096,
    structuredToolEnvelope: true,
    license: 'See model repository',
  }),
  Object.freeze({
    id: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC',
    label: 'Hermes 3 · 3B Tool Use',
    source: 'https://huggingface.co/mlc-ai/Hermes-3-Llama-3.2-3B-q4f16_1-MLC',
    runtime: 'webllm',
    runtimeUrl: LOCAL_MODEL_RUNTIME_URL,
    vramRequiredMB: 2264,
    contextTokens: 4096,
    structuredToolEnvelope: true,
    license: 'See model repository',
  }),
]);

export function getLocalModel(modelId) {
  return LOCAL_MODEL_CATALOG.find(model => model.id === modelId) ?? null;
}
