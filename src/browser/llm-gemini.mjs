import { StudioError } from '../core/errors.mjs';

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';

function trimSlash(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

export function resolveGeminiGenerateUrl(baseUrl, model) {
  const raw = trimSlash(baseUrl || GEMINI_DEFAULT_BASE_URL);
  const id = String(model || GEMINI_DEFAULT_MODEL).trim().replace(/^models\//, '');
  if (!id) throw new StudioError('invalid_provider_config', 'Gemini model is required.', { field: 'model' });
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new StudioError('invalid_provider_url', 'Gemini base URL must be an absolute http(s) URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new StudioError('invalid_provider_url', 'Gemini base URL must use http or https.');
  }
  if (/:generateContent$/i.test(parsed.pathname)) return parsed.href;
  if (/\/models\/[^/]+$/i.test(parsed.pathname)) return `${parsed.href.replace(/\/+$/, '')}:generateContent`;
  return `${trimSlash(parsed.href)}/models/${encodeURIComponent(id)}:generateContent`;
}

function jsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { result: value };
  } catch {
    return { result: value };
  }
}

function uppercaseSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'OBJECT' };
  const next = { ...schema };
  if (typeof next.type === 'string') next.type = next.type.toUpperCase();
  if (next.properties && typeof next.properties === 'object') {
    next.properties = Object.fromEntries(
      Object.entries(next.properties).map(([key, value]) => [key, uppercaseSchema(value)]),
    );
  }
  if (next.items) next.items = uppercaseSchema(next.items);
  return next;
}

export function toGeminiTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return [{
    functionDeclarations: tools.map(tool => ({
      name: tool.name,
      description: tool.description ?? '',
      parameters: uppercaseSchema(tool.inputSchema ?? { type: 'object' }),
    })),
  }];
}

export function toGeminiRequest(messages, tools) {
  const systemParts = [];
  const contents = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role;
    if (role === 'system') {
      const text = message.content == null ? '' : String(message.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: String(message.name ?? ''),
            response: jsonObject(message.content),
          },
        }],
      });
      continue;
    }
    const parts = [];
    const text = message?.content == null ? '' : String(message.content);
    if (text) parts.push({ text });
    if (role === 'assistant' && Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        parts.push({
          functionCall: {
            name: String(call.name ?? ''),
            args: jsonObject(call.arguments),
          },
        });
      }
    }
    if (parts.length === 0) continue;
    contents.push({
      role: role === 'assistant' ? 'model' : 'user',
      parts,
    });
  }
  const body = { contents };
  if (systemParts.length > 0) {
    body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
  }
  const geminiTools = toGeminiTools(tools);
  if (geminiTools) body.tools = geminiTools;
  return body;
}

export function normalizeGeminiCompletion(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if ((!Array.isArray(parts) || parts.length === 0) && payload?.promptFeedback?.blockReason) {
    throw new StudioError(
      'provider_blocked',
      `Gemini blocked the prompt (${payload.promptFeedback.blockReason}).`,
    );
  }
  const list = Array.isArray(parts) ? parts : [];
  const text = list.map(part => part?.text).filter(Boolean).join('');
  const toolCalls = list
    .filter(part => part?.functionCall?.name)
    .map((part, index) => Object.freeze({
      id: String(part.functionCall.id || `gemini-${part.functionCall.name}-${index}`),
      name: String(part.functionCall.name),
      arguments: jsonObject(part.functionCall.args ?? part.functionCall.arguments),
    }));
  return Object.freeze({
    message: Object.freeze({
      role: 'assistant',
      content: text,
    }),
    toolCalls: Object.freeze(toolCalls),
    finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    usage: payload?.usageMetadata && typeof payload.usageMetadata === 'object'
      ? Object.freeze({ ...payload.usageMetadata })
      : null,
  });
}

export function createGeminiProvider(connection, { fetchImpl }) {
  const model = connection.config.model || GEMINI_DEFAULT_MODEL;
  const url = resolveGeminiGenerateUrl(connection.config.baseUrl, model);

  async function request(body, signal) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-goog-api-key': connection.secret,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new StudioError(
        'provider_unreachable',
        'Gemini could not be reached from this origin. Google blocks browser CORS; use a same-origin proxy URL if needed.',
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new StudioError('provider_http_error', `Gemini returned HTTP ${response.status}.`, {
        status: response.status,
      });
    }
    try {
      return await response.json();
    } catch (error) {
      throw new StudioError('provider_bad_response', 'Gemini did not return JSON.', { cause: error });
    }
  }

  return Object.freeze({
    id: connection.id,
    kind: connection.kind,
    label: connection.label,
    model,
    async complete({ messages, tools, signal } = {}) {
      return normalizeGeminiCompletion(await request(toGeminiRequest(messages, tools), signal));
    },
    async testConnection({ signal } = {}) {
      const result = await this.complete({
        messages: [{ role: 'user', content: 'Reply with the single word ok.' }],
        signal,
      });
      return Object.freeze({
        ok: true,
        model,
        finishReason: result.finishReason,
      });
    },
  });
}
