import { StudioError } from '../core/errors.mjs';

const TOOL_PROTOCOL = [
  'JSON ONLY.',
  'Call: {"type":"tool_call","name":"three_studio_apply","arguments":{...}}.',
  'Finish: {"type":"final","text":"actual result"}.',
  'A change is never a final until its required tool ran.',
].join(' ');

export function createLocalModelResponseFormat(tools = []) {
  const toolNames = [...new Set(tools.map(tool => String(tool?.name ?? '')).filter(Boolean))];
  const choices = [
    ...(toolNames.length > 0 ? [
      {
        type: 'object',
        properties: {
          type: { const: 'tool_call' },
          name: { enum: toolNames },
          arguments: { type: 'object' },
        },
        required: ['type', 'name', 'arguments'],
        additionalProperties: false,
      },
    ] : []),
      {
        type: 'object',
        properties: {
          type: { const: 'final' },
          text: { type: 'string' },
        },
        required: ['type', 'text'],
        additionalProperties: false,
      },
  ];
  return Object.freeze({
    type: 'json_object',
    schema: JSON.stringify(choices.length === 1 ? choices[0] : { oneOf: choices }),
  });
}

function stripFence(text) {
  const trimmed = String(text ?? '').trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function messageChars(message) {
  return String(message?.content ?? '').length + 24;
}

/** Preserve the request, live status, and newest rounds inside a small model's input budget. */
export function compactLocalModelConversation(messages, maximumChars) {
  const source = Array.isArray(messages) ? messages : [];
  const limit = Math.max(1_000, Number(maximumChars) || 1_000);
  if (source.reduce((total, message) => total + messageChars(message), 0) <= limit) return source;

  const anchors = new Set();
  const originalUser = source.findIndex(message => message.role === 'user'
    && !String(message.content ?? '').startsWith('PROTOCOL_CORRECTION:')
    && !String(message.content ?? '').startsWith('TOOL_RESULT '));
  if (originalUser >= 0) anchors.add(originalUser);
  const statusResult = source.findIndex(message => String(message.content ?? '').startsWith('TOOL_RESULT three_studio_status:'));
  if (statusResult >= 0) anchors.add(statusResult);

  let used = [...anchors].reduce((total, index) => total + messageChars(source[index]), 0);
  const selected = new Set(anchors);
  for (let index = source.length - 1; index >= 0; index -= 1) {
    if (selected.has(index)) continue;
    const size = messageChars(source[index]);
    if (used + size > limit && selected.size > 0) continue;
    selected.add(index);
    used += size;
  }
  return [...selected].sort((left, right) => left - right).map(index => source[index]);
}

export function normalizeLocalModelCompletion(payload) {
  const content = String(payload?.choices?.[0]?.message?.content ?? payload?.message?.content ?? payload?.text ?? '');
  try {
    const envelope = JSON.parse(stripFence(content));
    if (envelope?.type === 'tool_call' && typeof envelope.name === 'string') {
      return Object.freeze({
        message: Object.freeze({ role: 'assistant', content: '' }),
        toolCalls: Object.freeze([Object.freeze({
          id: `local-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
          name: envelope.name,
          arguments: envelope.arguments && typeof envelope.arguments === 'object' && !Array.isArray(envelope.arguments) ? envelope.arguments : {},
        })]),
        finishReason: 'tool_calls',
        usage: payload?.usage ?? null,
      });
    }
    if (envelope?.type === 'final') {
      return Object.freeze({ message: Object.freeze({ role: 'assistant', content: String(envelope.text ?? '') }), toolCalls: Object.freeze([]), finishReason: 'stop', usage: payload?.usage ?? null });
    }
  } catch {
    // The strict harness feeds invalid output back to the model for correction.
  }
  return Object.freeze({ message: Object.freeze({ role: 'assistant', content }), toolCalls: Object.freeze([]), finishReason: 'invalid_envelope', usage: payload?.usage ?? null });
}

export function createLocalModelProvider({ model, worker, onProgress } = {}) {
  if (!model?.id || !worker?.postMessage) throw new TypeError('model and worker are required.');
  let sequence = 0;
  const pending = new Map();
  let initialized = false;

  function request(command, payload = {}, signal) {
    const id = `local-model-${++sequence}`;
    return new Promise((resolve, reject) => {
      const abort = () => {
        pending.delete(id);
        reject(new StudioError('prompt_aborted', 'The local model request was aborted.'));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener?.('abort', abort, { once: true });
      pending.set(id, {
        resolve(value) { signal?.removeEventListener?.('abort', abort); resolve(value); },
        reject(error) { signal?.removeEventListener?.('abort', abort); reject(error); },
      });
      worker.postMessage({ id, command, payload });
    });
  }

  function onMessage(event) {
    const { id, type, value } = event.data ?? {};
    if (type === 'progress') { onProgress?.(value); return; }
    const task = pending.get(id);
    if (!task) return;
    pending.delete(id);
    if (type === 'error') task.reject(new StudioError('local_model_error', value?.message ?? 'Local model failed.'));
    else task.resolve(value);
  }
  worker.addEventListener?.('message', onMessage);

  return Object.freeze({
    id: `local/${model.id}`,
    kind: 'local-webllm',
    label: model.label,
    model: model.id,
    async initialize({ signal } = {}) {
      const result = await request('initialize', { modelId: model.id, runtimeUrl: model.runtimeUrl }, signal);
      initialized = true;
      return result;
    },
    async complete({ messages = [], tools = [], signal } = {}) {
      if (!initialized) await this.initialize({ signal });
      const toolCatalog = tools.map(tool => `${tool.name}: ${tool.description ?? ''}`).join('\n');
      const protocol = `${TOOL_PROTOCOL}\nTOOLS:\n${toolCatalog}`;
      // WebLLM accepts at most one system message and requires it to be first.
      // Merge Studio's tool protocol with the caller's system rules instead of
      // prepending a second system entry on every harness round.
      const systemRules = messages
        .filter(message => message?.role === 'system')
        .map(message => String(message.content ?? ''))
        .filter(Boolean);
      const conversation = messages
        .filter(message => message?.role !== 'system')
        .map(message => message.role === 'tool'
          ? { role: 'user', content: `TOOL_RESULT ${message.name ?? ''}: ${String(message.content ?? '')}` }
          : { role: message.role, content: String(message.content ?? '') });
      const combinedSystem = [protocol, ...systemRules].join('\n\n');
      const contextTokens = Math.max(2_048, Number(model.contextTokens) || 4_096);
      const maximumInputChars = Math.max(4_000, (contextTokens - 640) * 3);
      const compactConversation = compactLocalModelConversation(conversation, maximumInputChars - combinedSystem.length);
      const nextMessages = [
        { role: 'system', content: combinedSystem },
        ...compactConversation,
      ];
      return normalizeLocalModelCompletion(await request('complete', {
        messages: nextMessages,
        responseFormat: createLocalModelResponseFormat(tools),
        temperature: 0,
        maxTokens: 512,
        seed: 7,
      }, signal));
    },
    async testConnection({ signal } = {}) {
      await this.initialize({ signal });
      return { ok: true, model: model.id, local: true };
    },
    async remove() { initialized = false; return request('remove', { modelId: model.id, runtimeUrl: model.runtimeUrl }); },
    async unload() { initialized = false; return request('unload'); },
    dispose() {
      worker.removeEventListener?.('message', onMessage);
      worker.terminate?.();
      for (const task of pending.values()) task.reject(new StudioError('local_model_disposed', 'Local model provider was closed.'));
      pending.clear();
    },
  });
}
