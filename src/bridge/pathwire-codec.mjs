const DEFAULT_MAX_LINES = 16_384;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_ARRAY_INDEX = 100_000;

function escapePointerSegment(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function unescapePointerSegment(value) {
  if (/~(?![01])/u.test(value)) throw new TypeError(`Invalid Pathwire pointer escape in ${value}.`);
  return value.replaceAll('~1', '/').replaceAll('~0', '~');
}

function pointerFor(segments) {
  return segments.length === 0 ? '$' : `/${segments.map(escapePointerSegment).join('/')}`;
}

function segmentsFor(pointer) {
  if (pointer === '$') return [];
  if (!pointer.startsWith('/')) throw new TypeError('Pathwire paths must be $ or JSON Pointer paths beginning with /.');
  return pointer.slice(1).split('/').map(unescapePointerSegment);
}

function containerToken(value) {
  if (Array.isArray(value)) return '@array';
  if (value !== null && typeof value === 'object') return '@object';
  return null;
}

function scalarToken(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Pathwire values must be JSON serializable.');
  return encoded;
}

function assertDenseArrays(value, path = '$') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError(`Pathwire array ${path} contains a missing index ${index}.`);
      assertDenseArrays(value[index], `${path}/${index}`);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) assertDenseArrays(child, `${path}/${escapePointerSegment(key)}`);
  }
}

/** Generic, deterministic JSON Pointer + value-per-line representation. */
export class PathwireCodec {
  constructor(options = {}) {
    this.id = 'pathwire-v1';
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxArrayIndex = options.maxArrayIndex ?? DEFAULT_MAX_ARRAY_INDEX;
  }

  format(value) {
    const lines = [];
    const active = new WeakSet();
    const visit = (current, segments) => {
      if (segments.length > this.maxDepth) throw new RangeError(`Pathwire nesting exceeds ${this.maxDepth} levels.`);
      const token = containerToken(current);
      if (!token) {
        lines.push(`${pointerFor(segments)}\t${scalarToken(current)}`);
        return;
      }
      if (active.has(current)) throw new TypeError('Pathwire cannot format cyclic values.');
      active.add(current);
      lines.push(`${pointerFor(segments)}\t${token}`);
      const entries = Array.isArray(current)
        ? current.map((child, index) => [String(index), child])
        : Object.keys(current).sort().map(key => [key, current[key]]);
      for (const [key, child] of entries) visit(child, [...segments, key]);
      active.delete(current);
      if (lines.length > this.maxLines) throw new RangeError(`Pathwire output exceeds ${this.maxLines} lines.`);
    };
    visit(value, []);
    return `${lines.join('\n')}\n`;
  }

  parse(source) {
    if (typeof source !== 'string') throw new TypeError('Pathwire source must be a string.');
    const rawLines = source.split(/\r?\n/u).filter(line => line.length > 0 && !line.startsWith('#'));
    if (rawLines.length === 0) throw new TypeError('Pathwire source is empty.');
    if (rawLines.length > this.maxLines) throw new RangeError(`Pathwire input exceeds ${this.maxLines} lines.`);
    const values = new Map();
    let root;
    for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
      const line = rawLines[lineIndex];
      const separator = line.indexOf('\t');
      if (separator < 1) throw new TypeError(`Pathwire line ${lineIndex + 1} must contain a path, tab, and value.`);
      const pointer = line.slice(0, separator);
      const token = line.slice(separator + 1);
      const segments = segmentsFor(pointer);
      if (segments.length > this.maxDepth) throw new RangeError(`Pathwire nesting exceeds ${this.maxDepth} levels.`);
      if (values.has(pointer)) throw new TypeError(`Duplicate Pathwire path ${pointer}.`);
      let value;
      if (token === '@object') value = {};
      else if (token === '@array') value = [];
      else {
        try {
          value = JSON.parse(token);
        } catch (error) {
          throw new TypeError(`Pathwire line ${lineIndex + 1} has an invalid JSON value.`, { cause: error });
        }
        if (value !== null && typeof value === 'object') {
          throw new TypeError(`Pathwire line ${lineIndex + 1} must use @object or @array for containers.`);
        }
      }
      if (segments.length === 0) {
        if (lineIndex !== 0) throw new TypeError('Pathwire root $ must be the first line.');
        root = value;
      } else {
        const parentPointer = pointerFor(segments.slice(0, -1));
        const parent = values.get(parentPointer);
        if (parent === undefined || parent === null || typeof parent !== 'object') {
          throw new TypeError(`Pathwire parent ${parentPointer} must be declared before ${pointer}.`);
        }
        const key = segments.at(-1);
        if (Array.isArray(parent)) {
          if (!/^(0|[1-9]\d*)$/u.test(key)) throw new TypeError(`Pathwire array path ${pointer} requires a numeric index.`);
          const index = Number(key);
          if (index > this.maxArrayIndex) throw new RangeError(`Pathwire array index ${index} exceeds ${this.maxArrayIndex}.`);
          if (Object.hasOwn(parent, index)) throw new TypeError(`Duplicate Pathwire array index ${pointer}.`);
          parent[index] = value;
        } else {
          if (Object.hasOwn(parent, key)) throw new TypeError(`Duplicate Pathwire object key ${pointer}.`);
          Object.defineProperty(parent, key, {
            value, enumerable: true, configurable: true, writable: true,
          });
        }
      }
      values.set(pointer, value);
    }
    if (!values.has('$')) throw new TypeError('Pathwire source must begin with a $ root declaration.');
    assertDenseArrays(root);
    return root;
  }
}
