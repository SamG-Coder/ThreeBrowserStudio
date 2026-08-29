import assert from 'node:assert/strict';
import test from 'node:test';

import { createLlmProvider } from '../src/browser/llm-providers.mjs';
import {
  GEMINI_DEFAULT_BASE_URL,
  GEMINI_DEFAULT_MODEL,
  normalizeGeminiCompletion,
  resolveGeminiGenerateUrl,
  toGeminiRequest,
} from '../src/browser/llm-gemini.mjs';

test('Gemini generateContent URL stays on the model path and never takes a query key', () => {
  assert.equal(
    resolveGeminiGenerateUrl(GEMINI_DEFAULT_BASE_URL, GEMINI_DEFAULT_MODEL),
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
  );
  assert.equal(
    resolveGeminiGenerateUrl(`${GEMINI_DEFAULT_BASE_URL}/`, 'models/gemini-2.5-flash'),
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
  );
  assert.equal(
    resolveGeminiGenerateUrl(
      'https://proxy.example/v1beta/models/gemini-2.0-flash:generateContent',
      'ignored',
    ),
    'https://proxy.example/v1beta/models/gemini-2.0-flash:generateContent',
  );
  assert.throws(() => resolveGeminiGenerateUrl('ftp://x', 'gemini-2.5-flash'), {
    code: 'invalid_provider_url',
  });
});

test('Gemini request maps system, tools, and function responses', () => {
  const body = toGeminiRequest([
    { role: 'system', content: 'Use the nine tools.' },
    { role: 'user', content: 'status' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'three_studio_status', arguments: { inspect: true } }],
    },
    { role: 'tool', name: 'three_studio_status', content: '{"revision":1}' },
  ], [{
    name: 'three_studio_status',
    description: 'Status',
    inputSchema: { type: 'object', properties: { inspect: { type: 'boolean' } } },
  }]);
  assert.equal(body.systemInstruction.parts[0].text, 'Use the nine tools.');
  assert.equal(body.contents[0].role, 'user');
  assert.equal(body.contents[1].role, 'model');
  assert.equal(body.contents[1].parts[0].functionCall.name, 'three_studio_status');
  assert.deepEqual(body.contents[1].parts[0].functionCall.args, { inspect: true });
  assert.equal(body.contents[2].parts[0].functionResponse.name, 'three_studio_status');
  assert.deepEqual(body.contents[2].parts[0].functionResponse.response, { revision: 1 });
  assert.equal(body.tools[0].functionDeclarations[0].parameters.type, 'OBJECT');
  assert.equal(body.tools[0].functionDeclarations[0].parameters.properties.inspect.type, 'BOOLEAN');
});

test('Gemini completion normalizes functionCall parts and blocked prompts', () => {
  const result = normalizeGeminiCompletion({
    candidates: [{
      content: {
        parts: [
          { functionCall: { name: 'three_studio_inspect', args: { target: 'scene' } } },
        ],
      },
    }],
    usageMetadata: { promptTokenCount: 12 },
  });
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.toolCalls[0].name, 'three_studio_inspect');
  assert.deepEqual(result.toolCalls[0].arguments, { target: 'scene' });
  assert.equal(result.usage.promptTokenCount, 12);
  assert.throws(
    () => normalizeGeminiCompletion({ promptFeedback: { blockReason: 'SAFETY' } }),
    { code: 'provider_blocked' },
  );
});

test('gemini adapter posts generateContent with x-goog-api-key and never puts the key in the URL', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      async json() {
        return {
          candidates: [{
            content: {
              parts: [{ functionCall: { name: 'three_studio_status', args: {} } }],
            },
          }],
        };
      },
    };
  };
  const provider = createLlmProvider({
    id: 'conn/gemini',
    kind: 'gemini',
    label: 'Gemini',
    config: { model: 'gemini-2.5-flash' },
    secret: 'AIza-never-log',
  }, { fetch: fetchImpl });
  const result = await provider.complete({
    messages: [{ role: 'user', content: 'status' }],
    tools: [{ name: 'three_studio_status', description: 'Status', inputSchema: { type: 'object' } }],
  });
  assert.equal(
    calls[0].url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
  );
  assert.equal(new URL(calls[0].url).search, '');
  assert.equal(calls[0].options.headers['x-goog-api-key'], 'AIza-never-log');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[0].options.body.includes('AIza-never-log'), false);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.contents[0].parts[0].text, 'status');
  assert.equal(body.tools[0].functionDeclarations[0].name, 'three_studio_status');
  assert.equal(result.toolCalls[0].name, 'three_studio_status');
});

test('Gemini fetch failures stay provider_unreachable without echoing the key', async () => {
  const provider = createLlmProvider({
    id: 'conn/gemini',
    kind: 'gemini',
    label: 'Gemini',
    config: { model: 'gemini-2.5-flash' },
    secret: 'AIza-never-log',
  }, {
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  await assert.rejects(() => provider.complete({
    messages: [{ role: 'user', content: 'hi' }],
  }), error => {
    assert.equal(error.code, 'provider_unreachable');
    assert.equal(String(error.message).includes('AIza-never-log'), false);
    return true;
  });
});
