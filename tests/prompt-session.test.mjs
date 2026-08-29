import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserMcpHarness } from '../src/browser/mcp-harness.mjs';
import { createBrowserPromptSession } from '../src/browser/prompt-session.mjs';
import { createSecretVault } from '../src/browser/secret-vault.mjs';

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    this.map.set(key, String(value));
  }

  removeItem(key) {
    this.map.delete(key);
  }
}

function sessionWithFetch(fetchImpl) {
  const vault = createSecretVault({ storage: new MemoryStorage() });
  const harness = createBrowserMcpHarness({
    dispatch: async () => ({ success: true, revision: 0 }),
  });
  return createBrowserPromptSession({ vault, harness, fetch: fetchImpl });
}

test('prompt session keeps secrets in the vault and omits them from the public list', async () => {
  const session = sessionWithFetch(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }));
  await session.createVault('1234');
  const saved = await session.saveConnection({
    kind: 'http-chat',
    label: 'OpenRouter',
    config: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini' },
    secret: 'sk-live',
  });
  assert.equal(saved.hasSecret, true);
  assert.equal('secret' in saved, false);
  assert.equal(session.listConnections()[0].id, 'conn/openrouter');
  session.lock();
  assert.throws(() => session.listConnections(), { code: 'vault_locked' });
});

test('runPrompt uses the active provider and the MCP harness', async () => {
  const session = sessionWithFetch(async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.tools) {
      return {
        ok: true,
        async json() {
          return {
            choices: [{
              message: {
                content: 'status first',
                tool_calls: [],
              },
            }],
          };
        },
      };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  });
  await session.createVault('1234');
  await session.saveConnection({
    kind: 'http-chat',
    label: 'Local',
    config: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'local' },
    secret: 'ollama',
  });
  const result = await session.runPrompt('What is the scene?');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.text, 'status first');
});

test('prompt session can save and run a Gemini connection', async () => {
  const session = sessionWithFetch(async (url, options) => {
    assert.match(String(url), /:generateContent$/);
    assert.equal(options.headers['x-goog-api-key'], 'AIza-test');
    return {
      ok: true,
      async json() {
        return { candidates: [{ content: { parts: [{ text: 'kernel is offline' }] } }] };
      },
    };
  });
  await session.createVault('1234');
  const saved = await session.saveConnection({
    kind: 'gemini',
    label: 'Gemini',
    config: { model: 'gemini-2.5-flash' },
    secret: 'AIza-test',
  });
  assert.equal(saved.kind, 'gemini');
  assert.equal('secret' in saved, false);
  const result = await session.runPrompt('What is the scene?');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.text, 'kernel is offline');
});
