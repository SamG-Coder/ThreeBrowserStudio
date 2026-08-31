import { PathwireCodec } from './pathwire-codec.mjs';

const JSON_MODE = 'json';
export const WIRE_FORMAT_CONFIGURE_METHOD = 'connection.configure';

function assertMode(value, codecs, label) {
  if (value === JSON_MODE || codecs.has(value)) return value;
  throw new RangeError(`${label} must be one of: ${[JSON_MODE, ...codecs.keys()].join(', ')}.`);
}

function assertWrapper(value, mode) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${mode} payload must be an object containing format and source.`);
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('format') || !keys.includes('source')) {
    throw new TypeError(`${mode} payload must contain exactly format and source.`);
  }
  if (value.format !== mode || typeof value.source !== 'string') {
    throw new TypeError(`${mode} payload has a mismatched format or non-string source.`);
  }
  return value.source;
}

/** Per-connection representation state, independent from RPC and Studio semantics. */
export class WireFormatSession {
  constructor(options = {}) {
    const supplied = options.codecs ?? [new PathwireCodec()];
    this.codecs = new Map(supplied.map(codec => [codec.id, codec]));
    this.inputMode = assertMode(options.inputMode ?? JSON_MODE, this.codecs, 'inputMode');
    this.outputMode = assertMode(options.outputMode ?? JSON_MODE, this.codecs, 'outputMode');
  }

  availableModes() {
    return [JSON_MODE, ...this.codecs.keys()];
  }

  configure(options = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Wire format configuration must be an object.');
    }
    for (const key of Object.keys(options)) {
      if (key !== 'inputMode' && key !== 'outputMode') throw new TypeError(`Unknown wire format option ${key}.`);
    }
    const { inputMode = this.inputMode, outputMode = this.outputMode } = options;
    this.inputMode = assertMode(inputMode, this.codecs, 'inputMode');
    this.outputMode = assertMode(outputMode, this.codecs, 'outputMode');
    return { inputMode: this.inputMode, outputMode: this.outputMode, availableModes: this.availableModes() };
  }

  encodeInput(value) { return this.#encode(value, this.inputMode); }
  decodeInput(value) { return this.#decode(value, this.inputMode); }
  encodeOutput(value) { return this.#encode(value, this.outputMode); }
  decodeOutput(value) { return this.#decode(value, this.outputMode); }

  #encode(value, mode) {
    if (mode === JSON_MODE) return value;
    return { format: mode, source: this.codecs.get(mode).format(value) };
  }

  #decode(value, mode) {
    if (mode === JSON_MODE) return value;
    return this.codecs.get(mode).parse(assertWrapper(value, mode));
  }
}
