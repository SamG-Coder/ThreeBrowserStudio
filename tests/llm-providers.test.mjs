import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLlmProvider,
  listLiveProviderKinds,
  normalizeChatCompletion,
  resolveChatCompletionsUrl,
} from '../src/browser/llm-providers.mjs';

test('provider catalog keeps http-chat and Gemini live', () => {
  const live = listLiveProviderKinds();
  assert.deepEqual(live.map(kind => kind.id), ['http-chat', 'gemini']);
  assert.equal(live[0].auth, 'bearer');
  assert.equal(live[1].auth, 'api-key');
});

test('http-chat posts OpenAI-shaped tools and never echoes the bearer token in errors', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call-1',
                function: { name: 'three_studio_status', arguments: '{}' },
              }],
            },
          }],
        };
      },
    };
  };
  const provider = createLlmProvider({
    id: 'conn/demo',
    kind: 'http-chat',
    label: 'Demo',
    config: { baseUrl: 'https://api.example.com/v1', model: 'demo-model' },
    secret: 'sk-never-log',
  }, { fetch: fetchImpl });
  const result = await provider.complete({
    messages: [{ role: 'user', content: 'status' }],
    tools: [{ name: 'three_studio_status', description: 'Status', inputSchema: { type: 'object' } }],
  });
  assert.equal(calls[0].url, 'https://api.example.com/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-never-log');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'demo-model');
  assert.equal(body.tools[0].function.name, 'three_studio_status');
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.toolCalls[0].name, 'three_studio_status');
});

test('chat URL and completion helpers stay conservative', () => {
  assert.equal(
    resolveChatCompletionsUrl('https://openrouter.ai/api/v1/'),
    'https://openrouter.ai/api/v1/chat/completions',
  );
  assert.equal(
    resolveChatCompletionsUrl('https://openrouter.ai/api/v1/chat/completions'),
    'https://openrouter.ai/api/v1/chat/completions',
  );
  assert.throws(() => resolveChatCompletionsUrl('ftp://x'), { code: 'invalid_provider_url' });
  const normalized = normalizeChatCompletion({
    choices: [{ message: { content: 'ok', tool_calls: [] } }],
  });
  assert.equal(normalized.finishReason, 'stop');
  assert.equal(normalized.message.content, 'ok');
});
