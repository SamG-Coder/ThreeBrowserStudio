import { StudioError } from '../core/errors.mjs';
import { STUDIO_BROWSER_TOOLS, STUDIO_TOOL_NAMES } from './studio-tools.mjs';

export { STUDIO_BROWSER_TOOLS, STUDIO_TOOL_NAMES };

const DEFAULT_MAX_TOOL_ROUNDS = 8;

export function createUnavailableStudioDispatch({
  reason = 'The browser preview has no in-process authoring kernel yet. The nine tools stay on the desktop runtime until a dispatch is attached.',
} = {}) {
  return async function unavailableDispatch(name) {
    throw new StudioError('kernel_unavailable', reason, {
      tool: name,
      host: 'browser',
    });
  };
}

function normalizeDispatch(dispatch) {
  if (typeof dispatch === 'function') return dispatch;
  if (dispatch && typeof dispatch.dispatch === 'function') return dispatch.dispatch.bind(dispatch);
  throw new TypeError('dispatch must be a function or an object with dispatch().');
}

function toolByName(tools, name) {
  return tools.find(tool => tool.name === name) ?? null;
}

function emit(onEvent, event) {
  if (typeof onEvent !== 'function') return;
  onEvent(Object.freeze({ ...event }));
}

function assertNotAborted(signal) {
  if (signal?.aborted) {
    throw new StudioError('prompt_aborted', 'The prompt run was aborted.');
  }
}

/**
 * Generic MCP-layer harness for the browser. Same nine tool names as desktop.
 * The transport is in-process dispatch, not stdio or the named pipe.
 */
export function createBrowserMcpHarness({
  dispatch = createUnavailableStudioDispatch(),
  tools = STUDIO_BROWSER_TOOLS,
  maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS,
} = {}) {
  let invoke = normalizeDispatch(dispatch);
  const catalog = Object.freeze(tools.map(tool => Object.freeze({ ...tool, inputSchema: tool.inputSchema ?? { type: 'object' } })));

  return Object.freeze({
    listTools() {
      return catalog;
    },
    setDispatch(next) {
      invoke = normalizeDispatch(next);
    },
    async callTool(name, args = {}, context = {}) {
      if (!STUDIO_TOOL_NAMES.includes(name) || !toolByName(catalog, name)) {
        throw new StudioError('method_not_found', `Unknown Studio method ${name}.`);
      }
      assertNotAborted(context.signal);
      return invoke(name, args, context);
    },
    async run({
      provider,
      messages,
      signal,
      onEvent,
      requiredFirstTool = null,
      requiredToolNames = [],
      strictEnvelopes = false,
      maxProtocolRepairs = 2,
    } = {}) {
      if (!provider || typeof provider.complete !== 'function') {
        throw new StudioError('provider_required', 'A chat provider with complete() is required.');
      }
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new StudioError('prompt_required', 'A non-empty message list is required.');
      }
      const thread = messages.map(message => ({ ...message }));
      const toolTrace = [];
      const modelToolNames = new Set();
      let protocolRepairs = 0;

      const callAndRecord = async (call, round) => {
        assertNotAborted(signal);
        const callId = String(call.id || `call-${round}-${call.name}`);
        emit(onEvent, { type: 'tool-call', round, id: callId, name: call.name });
        let result;
        let error = null;
        try {
          result = await this.callTool(call.name, call.arguments ?? {}, { signal, toolCallId: callId });
        } catch (caught) {
          error = caught instanceof StudioError
            ? caught
            : new StudioError('dispatch_error', caught?.message ?? String(caught), { cause: caught });
          result = { success: false, error: error.toJSON() };
        }
        const serialized = (() => {
          try {
            return JSON.stringify(result);
          } catch {
            return '{"success":false,"error":{"code":"dispatch_error","message":"Tool result was not JSON serializable."}}';
          }
        })();
        toolTrace.push(Object.freeze({
          id: callId,
          name: call.name,
          ok: error == null,
          code: error?.code ?? null,
        }));
        emit(onEvent, {
          type: 'tool-result',
          round,
          id: callId,
          name: call.name,
          ok: error == null,
          code: error?.code ?? null,
        });
        thread.push({ role: 'tool', toolCallId: callId, name: call.name, content: serialized });
      };

      if (requiredFirstTool) {
        const call = { id: `required-first-${requiredFirstTool}`, name: requiredFirstTool, arguments: {} };
        thread.push({ role: 'assistant', content: '', toolCalls: [call] });
        await callAndRecord(call, -1);
      }

      const requestCorrection = (round, message) => {
        if (!strictEnvelopes || protocolRepairs >= maxProtocolRepairs) {
          throw new StudioError('model_protocol_error', message, {
            round,
            requiredToolNames: [...requiredToolNames],
          });
        }
        protocolRepairs += 1;
        emit(onEvent, { type: 'protocol-retry', round, attempt: protocolRepairs });
        thread.push({
          role: 'user',
          content: `PROTOCOL_CORRECTION: ${message} Output only one valid JSON tool_call envelope now. Do not explain or provide an example.`,
        });
      };

      for (let round = 0; round < maxToolRounds; round += 1) {
        assertNotAborted(signal);
        emit(onEvent, { type: 'model', round });
        const completion = await provider.complete({
          messages: thread,
          tools: catalog,
          signal,
        });
        const content = completion?.message?.content ?? '';
        const toolCalls = Array.isArray(completion?.toolCalls) ? completion.toolCalls : [];
        if (completion?.finishReason === 'invalid_envelope') {
          thread.push({ role: 'assistant', content, toolCalls: [] });
          requestCorrection(round, 'Your previous response was not a valid Studio tool envelope.');
          continue;
        }
        if (toolCalls.length === 0 || completion?.finishReason === 'stop') {
          const missing = requiredToolNames.filter(name => !modelToolNames.has(name));
          thread.push({ role: 'assistant', content, toolCalls: [] });
          if (missing.length > 0) {
            requestCorrection(round, `This request requires ${missing.join(', ')} before a final response.`);
            continue;
          }
          if (content) emit(onEvent, { type: 'text', round, text: content });
          return Object.freeze({
            messages: Object.freeze(thread.map(item => Object.freeze({ ...item }))),
            text: content,
            toolTrace: Object.freeze(toolTrace),
            finishReason: 'stop',
            rounds: round + 1,
          });
        }
        thread.push({ role: 'assistant', content, toolCalls });
        for (const call of toolCalls) {
          modelToolNames.add(call.name);
          await callAndRecord(call, round);
        }
      }
      throw new StudioError('tool_round_limit', `The harness stopped after ${maxToolRounds} tool rounds.`);
    },
  });
}
