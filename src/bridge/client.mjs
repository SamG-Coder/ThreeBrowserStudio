import { randomUUID } from 'node:crypto';
import net from 'node:net';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  MAX_REQUEST_TIMEOUT_MS,
  PROTOCOL_VERSION,
  RpcError,
  assertResponseEnvelope,
  createNdjsonDecoder,
  encodeNdjson,
} from './protocol.mjs';
import { readSessionMarker } from './session.mjs';
import { WIRE_FORMAT_CONFIGURE_METHOD, WireFormatSession } from './wire-format-session.mjs';

export class LiveBridgeClient {
  constructor(options = {}) {
    if (typeof options.pipePath !== 'string' || options.pipePath.length === 0) throw new TypeError('pipePath is required.');
    if (typeof options.token !== 'string' || options.token.length < 32) throw new TypeError('A 256-bit live-session token is required.');
    this.pipePath = options.pipePath;
    this.token = options.token;
    this.sessionId = options.sessionId;
    this.protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? Math.min(this.timeoutMs, 5_000);
    this.maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
    this.wireFormats = new WireFormatSession();
    this._socket = undefined;
    this._connectPromise = undefined;
    this._pending = new Map();
    this._closed = false;
  }

  static async fromMarker(markerOrPath, options = {}) {
    const marker = typeof markerOrPath === 'string'
      ? await readSessionMarker(markerOrPath)
      : markerOrPath;
    return new LiveBridgeClient({ ...marker, ...options });
  }

  async connect() {
    if (this._socket && !this._socket.destroyed) return this;
    if (this._connectPromise) return this._connectPromise;
    this._closed = false;
    this._connectPromise = new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipePath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new RpcError('timeout', `Timed out connecting to the Studio viewport after ${this.connectTimeoutMs}ms.`));
      }, this.connectTimeoutMs);
      timer.unref?.();

      const decoder = createNdjsonDecoder({
        maxBytes: this.maxMessageBytes,
        onMessage: (message) => this._handleResponse(message),
        onError: (error) => {
          this._failAll(error);
          socket.destroy();
        },
      });

      socket.setNoDelay(true);
      socket.on('data', decoder.push);
      socket.once('connect', () => {
        clearTimeout(timer);
        this._socket = socket;
        resolve(this);
      });
      socket.on('error', (error) => {
        const wrapped = new RpcError('connection_closed', `Studio live bridge connection failed: ${error.message}`, undefined, { cause: error });
        if (!this._socket) {
          clearTimeout(timer);
          reject(wrapped);
        }
        this._failAll(wrapped);
      });
      socket.on('close', () => {
        if (this._socket === socket) this._socket = undefined;
        this._failAll(new RpcError('connection_closed', 'Studio live bridge closed.'));
      });
    }).finally(() => {
      this._connectPromise = undefined;
    });
    return this._connectPromise;
  }

  _handleResponse(raw) {
    let response;
    try {
      response = assertResponseEnvelope(raw, this.protocolVersion);
    } catch (error) {
      this._failAll(error);
      this._socket?.destroy();
      return;
    }
    const pending = this._pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this._pending.delete(response.id);
    if (response.ok) {
      try {
        pending.resolve(pending.wireBypass ? response.result : this.wireFormats.decodeOutput(response.result));
      } catch (error) {
        pending.reject(error);
      }
    }
    else pending.reject(new RpcError(response.error.code, response.error.message, response.error.data));
  }

  _failAll(error) {
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pending.clear();
  }

  async request(method, params = {}, options = {}) {
    if (this._closed) throw new RpcError('connection_closed', 'Studio live bridge client is closed.');
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new RpcError('connection_closed', 'RPC request was cancelled.');
    }
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_REQUEST_TIMEOUT_MS) {
      throw new RangeError(`timeoutMs must be between 1 and ${MAX_REQUEST_TIMEOUT_MS}.`);
    }
    await this.connect();
    const id = options.id ?? randomUUID();
    if (this._pending.has(id)) throw new RpcError('duplicate_request', `Request id ${id} is already active.`);

    const wireBypass = options.wireBypass === true;
    const encoded = encodeNdjson({
      protocolVersion: this.protocolVersion,
      token: this.token,
      id,
      method,
      params: wireBypass ? params : this.wireFormats.encodeInput(params),
      timeoutMs,
    }, this.maxMessageBytes);

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const pending = this._pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this._pending.delete(id);
        reject(options.signal.reason instanceof Error
          ? options.signal.reason
          : new RpcError('connection_closed', `RPC method ${method} was cancelled.`));
      };
      const timer = setTimeout(() => {
        this._pending.delete(id);
        options.signal?.removeEventListener('abort', onAbort);
        reject(new RpcError('timeout', `RPC method ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref?.();
      const settle = (callback) => (value) => {
        options.signal?.removeEventListener('abort', onAbort);
        callback(value);
      };
      this._pending.set(id, { resolve: settle(resolve), reject: settle(reject), timer, wireBypass });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this._socket.write(encoded, (error) => {
        if (!error) return;
        const pending = this._pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this._pending.delete(id);
        pending.reject(new RpcError('connection_closed', `Could not write RPC request: ${error.message}`, undefined, { cause: error }));
      });
    });
  }

  call(method, params, options) {
    return this.request(method, params, options);
  }

  ping(options) {
    return this.request('ping', {}, { ...options, wireBypass: true });
  }

  async configureWireFormats(options = {}) {
    const result = await this.request(WIRE_FORMAT_CONFIGURE_METHOD, options, { wireBypass: true });
    this.wireFormats.configure({ inputMode: result.inputMode, outputMode: result.outputMode });
    return result;
  }

  async close() {
    this._closed = true;
    const socket = this._socket;
    this._socket = undefined;
    if (socket && !socket.destroyed) {
      await new Promise((resolve) => {
        socket.once('close', resolve);
        socket.end();
      });
    }
    this._failAll(new RpcError('connection_closed', 'Studio live bridge client was closed.'));
  }
}

export async function createLiveBridgeClient(options) {
  const client = options.markerPath
    ? await LiveBridgeClient.fromMarker(options.markerPath, options)
    : new LiveBridgeClient(options);
  await client.connect();
  return client;
}
