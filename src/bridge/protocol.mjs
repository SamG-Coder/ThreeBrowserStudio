import { timingSafeEqual } from 'node:crypto';

export const PROTOCOL_VERSION = 'three-studio/1';
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const MAX_REQUEST_TIMEOUT_MS = 120_000;
export const COMPILE_HEAVY_METHODS = Object.freeze(new Set([
  'three_studio_apply',
  'three_studio_render',
  'three_studio_project',
  'three_studio_history',
]));

export function requestTimeoutMsForMethod(method, fallback = DEFAULT_REQUEST_TIMEOUT_MS) {
  return COMPILE_HEAVY_METHODS.has(method) ? MAX_REQUEST_TIMEOUT_MS : fallback;
}

const ERROR_CODES = new Set([
  'authentication_failed',
  'connection_closed',
  'dispatch_error',
  'duplicate_request',
  'invalid_message',
  'message_too_large',
  'method_not_found',
  'protocol_mismatch',
  'timeout',
]);

export class RpcError extends Error {
  constructor(code, message, data, options) {
    super(message, options);
    this.name = 'RpcError';
    this.code = typeof code === 'string' ? code : 'dispatch_error';
    if (data !== undefined) this.data = data;
  }
}

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function safeError(error, fallbackCode = 'dispatch_error') {
  const candidate = error && typeof error === 'object' ? error : undefined;
  const code = typeof candidate?.code === 'string' ? candidate.code : fallbackCode;
  const output = {
    code: ERROR_CODES.has(code) || /^[a-z][a-z0-9_]{1,63}$/.test(code)
      ? code
      : fallbackCode,
    message: error instanceof Error ? error.message : String(error ?? 'Unknown error'),
  };
  const details = candidate?.data ?? candidate?.details;
  if (details !== undefined) {
    try {
      output.data = JSON.parse(JSON.stringify(details, (key, value) => {
        if (key === 'cause' || key === 'stack' || key === 'token') return undefined;
        if (value instanceof Error) return { message: value.message };
        return value;
      }));
    } catch {
      // Typed code/message remain useful when details are not JSON data.
    }
  }
  return output;
}

export function secureTokenEquals(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const receivedBytes = Buffer.from(received, 'utf8');
  if (expectedBytes.length !== receivedBytes.length) return false;
  return timingSafeEqual(expectedBytes, receivedBytes);
}

export function encodeNdjson(message, maxBytes = MAX_MESSAGE_BYTES) {
  let json;
  try {
    json = JSON.stringify(message);
  } catch (error) {
    throw new RpcError('invalid_message', 'RPC message is not JSON serializable.', undefined, { cause: error });
  }
  const encoded = Buffer.from(`${json}\n`, 'utf8');
  if (encoded.byteLength - 1 > maxBytes) {
    throw new RpcError('message_too_large', `RPC message exceeds the ${maxBytes}-byte limit.`);
  }
  return encoded;
}

export function createNdjsonDecoder({
  onMessage,
  onError,
  maxBytes = MAX_MESSAGE_BYTES,
} = {}) {
  if (typeof onMessage !== 'function') throw new TypeError('onMessage must be a function.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be a positive integer.');

  let buffered = Buffer.alloc(0);
  let failed = false;

  const fail = (error) => {
    if (failed) return;
    failed = true;
    buffered = Buffer.alloc(0);
    onError?.(error instanceof RpcError
      ? error
      : new RpcError('invalid_message', error instanceof Error ? error.message : String(error)));
  };

  const push = (chunk) => {
    if (failed || chunk == null) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffered = buffered.length === 0 ? bytes : Buffer.concat([buffered, bytes]);

    for (;;) {
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) {
        if (buffered.byteLength > maxBytes) {
          fail(new RpcError('message_too_large', `RPC message exceeds the ${maxBytes}-byte limit.`));
        }
        return;
      }

      let line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      if (line.byteLength > maxBytes) {
        fail(new RpcError('message_too_large', `RPC message exceeds the ${maxBytes}-byte limit.`));
        return;
      }
      if (line.byteLength > 0 && line[line.byteLength - 1] === 0x0d) line = line.subarray(0, -1);
      if (line.byteLength === 0) continue;

      try {
        const message = JSON.parse(line.toString('utf8'));
        if (!isPlainObject(message)) throw new Error('RPC message must be a JSON object.');
        const outcome = onMessage(message);
        if (outcome && typeof outcome.then === 'function') {
          Promise.resolve(outcome).catch(fail);
        }
      } catch (error) {
        fail(new RpcError('invalid_message', 'Malformed NDJSON RPC message.', undefined, { cause: error }));
        return;
      }
    }
  };

  return {
    push,
    end() {
      if (!failed && buffered.byteLength > 0) {
        fail(new RpcError('invalid_message', 'RPC stream ended with an incomplete message.'));
      }
    },
    get failed() {
      return failed;
    },
  };
}

export function assertRequestEnvelope(message, protocolVersion = PROTOCOL_VERSION) {
  const allowed = new Set(['protocolVersion', 'token', 'id', 'method', 'params', 'timeoutMs']);
  for (const key of Object.keys(message)) {
    if (!allowed.has(key)) throw new RpcError('invalid_message', `Unexpected request field: ${key}.`);
  }
  if (message.protocolVersion !== protocolVersion) {
    throw new RpcError('protocol_mismatch', `Expected protocol ${protocolVersion}.`);
  }
  if (typeof message.token !== 'string' || message.token.length < 32 || message.token.length > 256) {
    throw new RpcError('authentication_failed', 'Invalid live-session token.');
  }
  if (typeof message.id !== 'string' || message.id.length < 1 || message.id.length > 128) {
    throw new RpcError('invalid_message', 'Request id must be a non-empty string of at most 128 characters.');
  }
  if (typeof message.method !== 'string' || !/^[a-z][a-z0-9_.-]{0,127}$/.test(message.method)) {
    throw new RpcError('invalid_message', 'Request method is invalid.');
  }
  if (!isPlainObject(message.params)) throw new RpcError('invalid_message', 'Request params must be an object.');
  if (message.timeoutMs !== undefined &&
      (!Number.isSafeInteger(message.timeoutMs) || message.timeoutMs < 1 || message.timeoutMs > MAX_REQUEST_TIMEOUT_MS)) {
    throw new RpcError('invalid_message', `timeoutMs must be between 1 and ${MAX_REQUEST_TIMEOUT_MS}.`);
  }
  return message;
}

export function assertResponseEnvelope(message, protocolVersion = PROTOCOL_VERSION) {
  const allowed = new Set(['protocolVersion', 'id', 'ok', 'result', 'error']);
  for (const key of Object.keys(message)) {
    if (!allowed.has(key)) throw new RpcError('invalid_message', `Unexpected response field: ${key}.`);
  }
  if (message.protocolVersion !== protocolVersion) {
    throw new RpcError('protocol_mismatch', `Expected protocol ${protocolVersion}.`);
  }
  if (typeof message.id !== 'string' || message.id.length < 1 || message.id.length > 128) {
    throw new RpcError('invalid_message', 'Response id is invalid.');
  }
  if (typeof message.ok !== 'boolean') throw new RpcError('invalid_message', 'Response ok flag is missing.');
  if (message.ok) {
    if (!Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) {
      throw new RpcError('invalid_message', 'Successful response must contain only a result.');
    }
  } else if (!isPlainObject(message.error) || typeof message.error.code !== 'string' || typeof message.error.message !== 'string') {
    throw new RpcError('invalid_message', 'Failed response must contain a typed error.');
  }
  return message;
}
