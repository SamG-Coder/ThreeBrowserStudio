import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLocalModelCompletion, createLocalModelProvider } from '../src/browser/local-model-provider.mjs';
import { createLocalModelManager } from '../src/browser/local-model-manager.mjs';
import { createLocalModelDirectWorker } from '../src/browser/local-model-direct-worker.mjs';
import { installNativeCacheStorage } from '../src/browser/native-cache-storage.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

class FakeWorker {
  listeners = new Set();
  terminated = false;
  requests = [];
  addEventListener(type, listener) { if (type === 'message') this.listeners.add(listener); }
  removeEventListener(type, listener) { if (type === 'message') this.listeners.delete(listener); }
  postMessage(message) {
    this.requests.push(message);
    queueMicrotask(() => {
      const value = message.command === 'complete'
        ? { choices: [{ message: { content: '{"type":"tool_call","name":"three_studio_status","arguments":{}}' } }] }
        : { modelId: message.payload.modelId };
      for (const listener of this.listeners) listener({ data: { id: message.id, type: 'result', value } });
    });
  }
  terminate() { this.terminated = true; }
}

test('local model completion normalizes constrained tool and final envelopes', () => {
  const tool = normalizeLocalModelCompletion({ choices: [{ message: { content: '```json\n{"type":"tool_call","name":"three_studio_validate","arguments":{}}\n```' } }] });
  assert.equal(tool.finishReason, 'tool_calls');
  assert.equal(tool.toolCalls[0].name, 'three_studio_validate');
  const final = normalizeLocalModelCompletion({ choices: [{ message: { content: '{"type":"final","text":"Done"}' } }] });
  assert.equal(final.message.content, 'Done');
  const invalid = normalizeLocalModelCompletion({ choices: [{ message: { content: 'Here is an example tree.' } }] });
  assert.equal(invalid.finishReason, 'invalid_envelope');
  assert.equal(invalid.message.content, 'Here is an example tree.');
});

test('worker-backed provider initializes and emits Studio tool calls', async () => {
  const worker = new FakeWorker();
  const provider = createLocalModelProvider({
    model: { id: 'model/test', label: 'Test', runtimeUrl: 'https://example.test/runtime.js' },
    worker,
  });
  await provider.initialize();
  const completion = await provider.complete({
    messages: [
      { role: 'system', content: 'Studio rules' },
      { role: 'user', content: 'Inspect' },
      { role: 'assistant', content: '' },
      { role: 'tool', name: 'three_studio_status', content: '{"revision":0}' },
    ],
    tools: [{ name: 'three_studio_status' }],
  });
  assert.equal(completion.toolCalls[0].name, 'three_studio_status');
  const sent = worker.requests.findLast(request => request.command === 'complete').payload.messages;
  assert.equal(sent[0].role, 'system');
  assert.match(sent[0].content, /Studio rules/);
  assert.match(sent[0].content, /three_studio_status:/);
  assert.match(sent[0].content, /Plain text, Markdown, code fences, examples, and ASCII art are invalid/);
  assert.equal(sent.filter(message => message.role === 'system').length, 1);
  assert.match(sent.at(-1).content, /^TOOL_RESULT three_studio_status:/);
  provider.dispose();
  assert.equal(worker.terminated, true);
});

test('model manager persists only the active model id and keeps weights in browser cache', async () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const manager = createLocalModelManager({
    storage,
    navigator: { gpu: {}, storage: { async persist() { return true; } } },
    workerFactory: () => new FakeWorker(),
  });
  const model = manager.catalog()[0];
  await manager.activate(model.id);
  assert.equal(manager.status().ready, true);
  assert.equal(manager.status().activeModelId, model.id);
  assert.match([...values.values()][0], new RegExp(model.id));
  manager.dispose();
});

test('direct adapter runs WebLLM on a host main surface with WebGPU', async () => {
  const previousNavigator = globalThis.navigator;
  const progress = [];
  let unloaded = false;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: {} } });
  try {
    const worker = createLocalModelDirectWorker({
      async importModule() {
        return {
          async CreateMLCEngine(modelId, options) {
            options.initProgressCallback({ text: 'Loading', progress: 0.5 });
            return {
              chat: { completions: { async create() { return { choices: [{ message: { content: '{"type":"final","text":"Ready"}' } }] }; } } },
              async unload() { unloaded = true; },
            };
          },
        };
      },
    });
    const provider = createLocalModelProvider({
      model: { id: 'model/native', label: 'Native', runtimeUrl: 'https://example.test/webllm.js' },
      worker,
      onProgress(value) { progress.push(value); },
    });
    await provider.initialize();
    const completion = await provider.complete({ messages: [{ role: 'user', content: 'Ready?' }] });
    assert.equal(progress[0].progress, 0.5);
    assert.equal(completion.message.content, 'Ready');
    provider.dispose();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(unloaded, true);
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator });
  }
});

test('native CacheStorage adapter persists WebLLM artifacts outside the project', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'three-studio-model-cache-'));
  let fetches = 0;
  const processFacade = {
    pid: process.pid,
    env: { LOCALAPPDATA: root },
    cwd: () => root,
    getBuiltinModule: process.getBuiltinModule.bind(process),
  };
  const globalObject = {
    process: processFacade,
    Request,
    Response,
    async fetch() { fetches += 1; return new Response('local artifact'); },
  };
  try {
    const storage = installNativeCacheStorage({ globalObject });
    const cache = await storage.open('webllm/model');
    const request = new Request('https://example.test/model.bin');
    await cache.add(request);
    assert.equal(await (await cache.match(request)).text(), 'local artifact');
    assert.deepEqual((await cache.keys()).map(item => item.url), [request.url]);
    assert.equal(fetches, 1);
    assert.equal(await cache.delete(request), true);
    assert.equal(await cache.match(request), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
