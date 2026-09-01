import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STUDIO_TOOL_NAMES,
  createBrowserMcpHarness,
  createUnavailableStudioDispatch,
} from '../src/browser/mcp-harness.mjs';

test('browser harness exposes the nine Studio tools and refuses unknown names', async () => {
  const harness = createBrowserMcpHarness({
    dispatch: async (name, args) => ({ ok: true, name, args }),
  });
  assert.deepEqual(harness.listTools().map(tool => tool.name), [...STUDIO_TOOL_NAMES]);
  assert.equal((await harness.callTool('three_studio_status', { a: 1 })).ok, true);
  await assert.rejects(() => harness.callTool('not_a_studio_tool'), { code: 'method_not_found' });
});

test('unavailable dispatch is kernel_unavailable and the run loop feeds tool results back', async () => {
  const harness = createBrowserMcpHarness({
    dispatch: createUnavailableStudioDispatch(),
  });
  await assert.rejects(() => harness.callTool('three_studio_status'), { code: 'kernel_unavailable' });

  let round = 0;
  const events = [];
  const provider = {
    async complete({ messages }) {
      round += 1;
      if (round === 1) {
        return {
          finishReason: 'tool_calls',
          message: { role: 'assistant', content: '' },
          toolCalls: [{ id: 'c1', name: 'three_studio_status', arguments: {} }],
        };
      }
      const tool = messages.find(item => item.role === 'tool');
      assert.match(tool.content, /kernel_unavailable/);
      return {
        finishReason: 'stop',
        message: { role: 'assistant', content: 'Kernel is not in the browser yet.' },
        toolCalls: [],
      };
    },
  };
  const result = await harness.run({
    provider,
    messages: [{ role: 'user', content: 'hello' }],
    onEvent: event => events.push(event.type),
  });
  assert.equal(result.text, 'Kernel is not in the browser yet.');
  assert.equal(result.toolTrace[0].ok, false);
  assert.equal(result.toolTrace[0].code, 'kernel_unavailable');
  assert.ok(events.includes('tool-call'));
  assert.ok(events.includes('tool-result'));
});

test('strict local harness routes through status and refuses completion until the required MCP mutation runs', async () => {
  const dispatched = [];
  const events = [];
  let round = 0;
  const harness = createBrowserMcpHarness({
    dispatch: async (name, args) => {
      dispatched.push({ name, args });
      if (name === 'three_studio_status') {
        return { sessionId: 'session/test', projectId: 'project/test', revision: 4 };
      }
      return { success: true, revision: 5 };
    },
  });
  const provider = {
    async complete({ messages, tools }) {
      round += 1;
      assert.equal(messages.some(message => message.role === 'tool' && message.name === 'three_studio_status'), true);
      assert.deepEqual(tools.map(tool => tool.name), ['three_studio_status', 'three_studio_apply']);
      if (round === 1) {
        return {
          finishReason: 'invalid_envelope',
          message: { role: 'assistant', content: 'Here is a simple example tree.' },
          toolCalls: [],
        };
      }
      if (round === 2) {
        return {
          finishReason: 'stop',
          message: { role: 'assistant', content: 'Done.' },
          toolCalls: [],
        };
      }
      if (round === 3) {
        return {
          finishReason: 'tool_calls',
          message: { role: 'assistant', content: '' },
          toolCalls: [{
            id: 'apply-tree',
            name: 'three_studio_apply',
            arguments: {
              protocolVersion: 'three-studio/1',
              sessionId: 'session/test',
              projectId: 'project/test',
              baseRevision: 4,
              idempotencyKey: 'local-tree-0001',
              label: 'Create a tree',
              program: { language: 'plainform-v1', source: 'Create a design named Local Tree.' },
            },
          }],
        };
      }
      return {
        finishReason: 'stop',
        message: { role: 'assistant', content: 'Created through Studio.' },
        toolCalls: [],
      };
    },
  };

  const result = await harness.run({
    provider,
    messages: [{ role: 'user', content: 'Create a tree using Plainform.' }],
    requiredFirstTool: 'three_studio_status',
    requiredToolNames: ['three_studio_apply'],
    availableToolNames: ['three_studio_status', 'three_studio_apply'],
    strictEnvelopes: true,
    onEvent: event => events.push(event.type),
  });

  assert.deepEqual(dispatched.map(item => item.name), ['three_studio_status', 'three_studio_apply']);
  assert.equal(result.text, 'Created through Studio.');
  assert.equal(result.rounds, 4);
  assert.deepEqual(result.toolTrace.map(item => item.name), ['three_studio_status', 'three_studio_apply']);
  assert.equal(events.filter(type => type === 'protocol-retry').length, 2);
});

test('local harness bounds large MCP results before the next 4K model round', async () => {
  let round = 0;
  const harness = createBrowserMcpHarness({
    dispatch: async name => name === 'three_studio_status'
      ? { projectId: 'project/test', sessionId: 'session/test', revision: 1 }
      : { success: true, payload: 'x'.repeat(2_000) },
  });
  const provider = {
    async complete({ messages }) {
      round += 1;
      if (round === 1) {
        return {
          finishReason: 'tool_calls',
          message: { role: 'assistant', content: '' },
          toolCalls: [{ id: 'inspect', name: 'three_studio_inspect', arguments: {} }],
        };
      }
      const result = messages.findLast(message => message.role === 'tool');
      assert.ok(result.content.length <= 240);
      assert.match(result.content, /\[tool result truncated\]$/);
      return { finishReason: 'stop', message: { role: 'assistant', content: 'Done.' }, toolCalls: [] };
    },
  };
  const result = await harness.run({
    provider,
    messages: [{ role: 'user', content: 'Inspect.' }],
    requiredFirstTool: 'three_studio_status',
    maxModelToolResultChars: 240,
  });
  assert.equal(result.text, 'Done.');
});

test('strict local harness fails closed when a model keeps returning prose', async () => {
  const harness = createBrowserMcpHarness({ dispatch: async () => ({ revision: 0 }) });
  const provider = {
    async complete() {
      return {
        finishReason: 'invalid_envelope',
        message: { role: 'assistant', content: 'An example instead of a tool call.' },
        toolCalls: [],
      };
    },
  };
  await assert.rejects(() => harness.run({
    provider,
    messages: [{ role: 'user', content: 'Create a tree.' }],
    requiredFirstTool: 'three_studio_status',
    requiredToolNames: ['three_studio_apply'],
    strictEnvelopes: true,
  }), { code: 'model_protocol_error' });
});
