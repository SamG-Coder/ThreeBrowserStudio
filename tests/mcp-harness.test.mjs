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
