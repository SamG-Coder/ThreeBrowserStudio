import { StudioError } from '../core/errors.mjs';

const TOOL_PROTOCOL = [
  'Every response must be only one JSON object. To call a Studio MCP tool, output:',
  '{"type":"tool_call","name":"three_studio_status","arguments":{}}',
  'Only after required tools complete, output {"type":"final","text":"..."}.',
  'Plain text, Markdown, code fences, examples, and ASCII art are invalid responses.',
  'For Plainform authoring call three_studio_apply with arguments.program.language="plainform-v1" and arguments.program.source containing the controlled-English program.',
  'Never print a Plainform program instead of calling three_studio_apply.',
].join(' ');

function stripFence(text) {
  const trimmed = String(text ?? '').trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
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
      const toolCatalog = tools.map(tool => `${tool.name}: ${tool.description ?? 'Use the live Studio tool contract.'}`).join('\n');
      const protocol = `${TOOL_PROTOCOL}\nDeclared Studio MCP tools:\n${toolCatalog}`;
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
      const nextMessages = [
        { role: 'system', content: [protocol, ...systemRules].join('\n\n') },
        ...conversation,
      ];
      return normalizeLocalModelCompletion(await request('complete', { messages: nextMessages }, signal));
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
