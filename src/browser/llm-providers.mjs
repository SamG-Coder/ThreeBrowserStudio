import { StudioError } from '../core/errors.mjs';
import {
  GEMINI_DEFAULT_BASE_URL,
  GEMINI_DEFAULT_MODEL,
  createGeminiProvider,
  resolveGeminiGenerateUrl,
} from './llm-gemini.mjs';

const HTTP_CHAT_FIELDS = Object.freeze([
  Object.freeze({ id: 'baseUrl', label: 'Base URL', kind: 'url', required: true, placeholder: 'https://api.example.com/v1' }),
  Object.freeze({ id: 'model', label: 'Model', kind: 'text', required: true, placeholder: 'model-id' }),
  Object.freeze({ id: 'authHeader', label: 'Auth header', kind: 'text', required: false, defaultValue: 'Authorization' }),
  Object.freeze({ id: 'authScheme', label: 'Auth scheme', kind: 'text', required: false, defaultValue: 'Bearer' }),
  Object.freeze({ id: 'secret', label: 'Token', kind: 'secret', required: true }),
]);

/** Provider kinds stay declarative so a new adapter can register without changing the harness. */
export const PROVIDER_KINDS = Object.freeze([
  Object.freeze({
    id: 'http-chat',
    label: 'HTTP chat API',
    status: 'live',
    auth: 'bearer',
    description: 'OpenAI-compatible /chat/completions. Use for OpenAI, Groq, OpenRouter, or a local server that allows this origin.',
    fields: HTTP_CHAT_FIELDS,
  }),
  Object.freeze({
    id: 'gemini',
    label: 'Google Gemini',
    status: 'live',
    auth: 'api-key',
    description: 'Gemini generateContent. Store the API key in the PIN vault. Google may block browser CORS; a same-origin proxy URL still works.',
    fields: Object.freeze([
      Object.freeze({
        id: 'baseUrl',
        label: 'Base URL',
        kind: 'url',
        required: false,
        defaultValue: GEMINI_DEFAULT_BASE_URL,
        placeholder: GEMINI_DEFAULT_BASE_URL,
      }),
      Object.freeze({
        id: 'model',
        label: 'Model',
        kind: 'text',
        required: true,
        defaultValue: GEMINI_DEFAULT_MODEL,
        placeholder: GEMINI_DEFAULT_MODEL,
      }),
      Object.freeze({ id: 'secret', label: 'API key', kind: 'secret', required: true }),
    ]),
  }),
]);

export function listLiveProviderKinds() {
  return PROVIDER_KINDS.filter(kind => kind.status === 'live');
}

export function getProviderKind(id) {
  return PROVIDER_KINDS.find(kind => kind.id === id) ?? null;
}

function trimSlash(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

export function resolveChatCompletionsUrl(baseUrl) {
  const raw = String(baseUrl ?? '').trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new StudioError('invalid_provider_url', 'Base URL must be an absolute http(s) URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new StudioError('invalid_provider_url', 'Base URL must use http or https.');
  }
  if (/\/chat\/completions\/?$/i.test(parsed.pathname)) return parsed.href.replace(/\/+$/, '');
  return `${trimSlash(parsed.href)}/chat/completions`;
}

function normalizeConfig(kind, config = {}) {
  const next = {};
  for (const field of kind.fields) {
    if (field.kind === 'secret') continue;
    const supplied = config[field.id];
    const value = supplied == null || supplied === '' ? field.defaultValue ?? '' : String(supplied).trim();
    if (field.required && !value) {
      throw new StudioError('invalid_provider_config', `${field.label} is required.`, { field: field.id });
    }
    if (value) next[field.id] = value;
  }
  if (kind.id === 'http-chat') resolveChatCompletionsUrl(next.baseUrl);
  if (kind.id === 'gemini') resolveGeminiGenerateUrl(next.baseUrl, next.model);
  return next;
}

export function normalizeProviderConnection(connection, { requireSecret = false } = {}) {
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) {
    throw new StudioError('invalid_provider_connection', 'Provider connection must be an object.');
  }
  const kind = getProviderKind(connection.kind);
  if (!kind) throw new StudioError('provider_unknown', `Unknown provider kind ${connection.kind}.`);
  if (kind.status !== 'live') {
    throw new StudioError('provider_not_implemented', `${kind.label} is catalogued but not implemented yet.`, { kind: kind.id });
  }
  const id = String(connection.id ?? '').trim();
  const label = String(connection.label ?? kind.label).trim() || kind.label;
  if (!id) throw new StudioError('invalid_provider_connection', 'Provider connection id is required.');
  const secret = connection.secret == null ? '' : String(connection.secret);
  if (requireSecret && !secret) throw new StudioError('secret_required', 'A bearer token or API key is required.');
  return Object.freeze({
    id,
    kind: kind.id,
    label,
    config: Object.freeze(normalizeConfig(kind, connection.config)),
    secret,
  });
}

function toOpenAiMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map(message => {
    const role = message?.role === 'tool' ? 'tool' : message?.role === 'assistant' ? 'assistant' : message?.role === 'system' ? 'system' : 'user';
    const next = { role, content: message?.content == null ? '' : String(message.content) };
    if (role === 'tool') {
      next.tool_call_id = String(message.toolCallId ?? message.tool_call_id ?? '');
      next.name = message.name ? String(message.name) : undefined;
    }
    if (role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      next.tool_calls = message.toolCalls.map(call => ({
        id: String(call.id),
        type: 'function',
        function: {
          name: String(call.name),
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
        },
      }));
    }
    return next;
  });
}

function parseToolArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new StudioError('provider_tool_arguments', 'The model returned tool arguments that are not JSON.');
  }
}

export function normalizeChatCompletion(payload) {
  const choice = payload?.choices?.[0];
  const message = choice?.message ?? {};
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map(call => Object.freeze({
      id: String(call?.id ?? ''),
      name: String(call?.function?.name ?? ''),
      arguments: parseToolArguments(call?.function?.arguments),
    }))
    : [];
  const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
  return Object.freeze({
    message: Object.freeze({
      role: 'assistant',
      content: message.content == null ? '' : String(message.content),
    }),
    toolCalls: Object.freeze(toolCalls),
    finishReason,
    usage: payload?.usage && typeof payload.usage === 'object' ? Object.freeze({ ...payload.usage }) : null,
  });
}

function createHttpChatProvider(connection, { fetchImpl }) {
  const url = resolveChatCompletionsUrl(connection.config.baseUrl);
  const headerName = connection.config.authHeader || 'Authorization';
  const scheme = connection.config.authScheme ?? 'Bearer';
  const headerValue = scheme ? `${scheme} ${connection.secret}` : connection.secret;

  async function request(body, signal) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          [headerName]: headerValue,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new StudioError(
        'provider_unreachable',
        'The chat API could not be reached from this origin. The endpoint must allow CORS for GitHub Pages.',
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new StudioError('provider_http_error', `The chat API returned HTTP ${response.status}.`, {
        status: response.status,
      });
    }
    try {
      return await response.json();
    } catch (error) {
      throw new StudioError('provider_bad_response', 'The chat API did not return JSON.', { cause: error });
    }
  }

  return Object.freeze({
    id: connection.id,
    kind: connection.kind,
    label: connection.label,
    model: connection.config.model,
    async complete({ messages, tools, signal } = {}) {
      const body = {
        model: connection.config.model,
        messages: toOpenAiMessages(messages),
      };
      if (Array.isArray(tools) && tools.length > 0) {
        body.tools = tools.map(tool => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description ?? '',
            parameters: tool.inputSchema ?? { type: 'object' },
          },
        }));
      }
      return normalizeChatCompletion(await request(body, signal));
    },
    async testConnection({ signal } = {}) {
      const result = await this.complete({
        messages: [{ role: 'user', content: 'Reply with the single word ok.' }],
        signal,
      });
      return Object.freeze({
        ok: true,
        model: connection.config.model,
        finishReason: result.finishReason,
      });
    },
  });
}

const ADAPTERS = Object.freeze({
  'http-chat': createHttpChatProvider,
  gemini: createGeminiProvider,
});

export function createLlmProvider(connection, { fetch: fetchImpl = globalThis.fetch, requireSecret = true } = {}) {
  const normalized = normalizeProviderConnection(connection, { requireSecret });
  if (typeof fetchImpl !== 'function') {
    throw new StudioError('fetch_unavailable', 'fetch is required to call a chat API from the browser.');
  }
  return ADAPTERS[normalized.kind](normalized, { fetchImpl });
}
