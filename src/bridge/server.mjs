import net from 'node:net';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  RpcError,
  assertRequestEnvelope,
  createNdjsonDecoder,
  encodeNdjson,
  safeError,
  secureTokenEquals,
} from './protocol.mjs';
import { createSessionCredentials } from './session.mjs';

export const DEFAULT_PREAUTH_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_SOCKETS = 8;
export const DEFAULT_MAX_PENDING_REQUESTS = 32;

function requirePositiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function normalizeDispatcher(dispatch) {
  if (typeof dispatch === 'function') return dispatch;
  if (dispatch && typeof dispatch.dispatch === 'function') return dispatch.dispatch.bind(dispatch);
  if (dispatch && typeof dispatch === 'object') {
    return (method, params, context) => {
      const handler = dispatch[method];
      if (typeof handler !== 'function') throw new RpcError('method_not_found', `Unknown RPC method: ${method}.`);
      return handler(params, context);
    };
  }
  throw new TypeError('dispatch must be a function, an object with dispatch(), or a method map.');
}

function callLifecycle(lifecycle, method, value, onError) {
  if (!lifecycle || typeof lifecycle[method] !== 'function') return;
  try {
    lifecycle[method](value);
  } catch (error) {
    try {
      onError(error);
    } catch {
      // Observability sinks must never alter RPC command semantics.
    }
  }
}

export class LiveBridgeServer {
  constructor(options = {}) {
    const credentials = options.credentials ?? createSessionCredentials(options);
    this.protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
    this.pipePath = options.pipePath ?? credentials.pipePath;
    this.token = options.token ?? credentials.token;
    this.sessionId = options.sessionId ?? credentials.sessionId;
    this.maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.preAuthTimeoutMs = requirePositiveInteger(
      options.preAuthTimeoutMs ?? DEFAULT_PREAUTH_TIMEOUT_MS,
      'preAuthTimeoutMs',
      60_000,
    );
    this.maxSockets = requirePositiveInteger(options.maxSockets ?? DEFAULT_MAX_SOCKETS, 'maxSockets', 1_024);
    this.maxPendingRequests = requirePositiveInteger(
      options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
      'maxPendingRequests',
      1_024,
    );
    this.dispatch = normalizeDispatcher(options.dispatch);
    this.beginCommand = typeof options.beginCommand === 'function' ? options.beginCommand : null;
    this.serverInfo = options.serverInfo === undefined ? {} : structuredClone(options.serverInfo);
    this.onError = typeof options.onError === 'function' ? options.onError : () => {};
    this._server = net.createServer((socket) => this._accept(socket));
    this._server.on('error', (error) => this.onError(error));
    this._sockets = new Set();
    this._started = false;
    this._closing = false;
  }

  async start() {
    if (this._started) return this;
    if (this._closing) throw new RpcError('connection_closed', 'Live bridge is closing.');
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this._server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this._server.off('error', onError);
        resolve();
      };
      this._server.once('error', onError);
      this._server.once('listening', onListening);
      this._server.listen(this.pipePath);
    });
    this._started = true;
    return this;
  }

  address() {
    return this._server.address();
  }

  _accept(socket) {
    if (this._closing || this._sockets.size >= this.maxSockets) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    this._sockets.add(socket);
    const pending = new Map();
    let authenticated = false;
    let connectionFailed = false;
    const preAuthTimer = setTimeout(() => {
      if (!authenticated) socket.destroy();
    }, this.preAuthTimeoutMs);
    preAuthTimer.unref?.();

    const write = (message) => {
      if (!socket.destroyed && socket.writable) socket.write(encodeNdjson(message, this.maxMessageBytes));
    };

    const writeError = (id, error, fallbackCode = 'dispatch_error') => {
      try {
        write({
          protocolVersion: this.protocolVersion,
          id,
          ok: false,
          error: safeError(error, fallbackCode),
        });
      } catch {
        try {
          write({
            protocolVersion: this.protocolVersion,
            id,
            ok: false,
            error: { code: fallbackCode, message: 'RPC request failed.' },
          });
        } catch {
          socket.destroy();
        }
      }
    };

    const failConnection = (error, id = 'protocol') => {
      if (connectionFailed) return;
      connectionFailed = true;
      clearTimeout(preAuthTimer);
      writeError(id, error, 'invalid_message');
      socket.end();
    };

    const decoder = createNdjsonDecoder({
      maxBytes: this.maxMessageBytes,
      onError: (error) => failConnection(error),
      onMessage: async (raw) => {
        if (connectionFailed) return;
        let request;
        try {
          request = assertRequestEnvelope(raw, this.protocolVersion);
          if (!secureTokenEquals(this.token, request.token)) {
            throw new RpcError('authentication_failed', 'Invalid live-session token.');
          }
          if (!authenticated) {
            authenticated = true;
            clearTimeout(preAuthTimer);
          }
          if (pending.has(request.id)) throw new RpcError('duplicate_request', `Request id ${request.id} is already active.`);
        } catch (error) {
          failConnection(error, typeof raw.id === 'string' ? raw.id : 'protocol');
          return;
        }

        if (pending.size >= this.maxPendingRequests) {
          writeError(
            request.id,
            new RpcError('resource_exhausted', `A client may have at most ${this.maxPendingRequests} active RPC requests.`),
          );
          return;
        }

        const controller = new AbortController();
        const requestedTimeout = request.timeoutMs ?? this.requestTimeoutMs;
        const timeoutMs = Math.min(requestedTimeout, this.requestTimeoutMs);
        const state = { controller, timer: undefined };
        pending.set(request.id, state);

        const timeout = new Promise((_, reject) => {
          state.timer = setTimeout(() => {
            controller.abort(new RpcError('timeout', `RPC method ${request.method} timed out after ${timeoutMs}ms.`));
            reject(controller.signal.reason);
          }, timeoutMs);
          state.timer.unref?.();
        });

        let lifecycle = null;
        if (request.method !== 'ping' && this.beginCommand) {
          try {
            lifecycle = this.beginCommand(request.method, request.params);
          } catch (error) {
            try {
              this.onError(error);
            } catch {
              // Observability sinks must never alter RPC command semantics.
            }
          }
        }

        try {
          const invocation = request.method === 'ping'
            ? Promise.resolve({
                protocolVersion: this.protocolVersion,
                sessionId: this.sessionId,
                pid: process.pid,
                heartbeat: new Date().toISOString(),
                serverInfo: this.serverInfo,
              })
            : Promise.resolve(this.dispatch(request.method, request.params, {
              id: request.id,
              method: request.method,
              protocolVersion: this.protocolVersion,
              sessionId: this.sessionId,
              signal: controller.signal,
            }));
          const result = await Promise.race([
            invocation,
            timeout,
          ]);
          callLifecycle(lifecycle, 'complete', result, this.onError);
          write({ protocolVersion: this.protocolVersion, id: request.id, ok: true, result: result ?? null });
        } catch (error) {
          callLifecycle(lifecycle, 'fail', error, this.onError);
          writeError(request.id, error);
        } finally {
          clearTimeout(state.timer);
          pending.delete(request.id);
        }
      },
    });

    socket.on('data', decoder.push);
    socket.on('error', (error) => {
      if (authenticated) this.onError(error);
    });
    socket.on('close', () => {
      clearTimeout(preAuthTimer);
      for (const { controller, timer } of pending.values()) {
        clearTimeout(timer);
        controller.abort(new RpcError('connection_closed', 'Live bridge client disconnected.'));
      }
      pending.clear();
      this._sockets.delete(socket);
    });
  }

  async close() {
    if (this._closing) return;
    this._closing = true;
    for (const socket of this._sockets) socket.destroy();
    this._sockets.clear();
    if (this._started) {
      await new Promise((resolve) => this._server.close(() => resolve()));
    }
    this._started = false;
  }
}

export async function createLiveBridgeServer(options) {
  const server = new LiveBridgeServer(options);
  await server.start();
  return server;
}
