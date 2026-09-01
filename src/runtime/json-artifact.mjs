import { StudioError } from '../core/errors.mjs';

function pointerToken(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function locateJsonValues(source) {
  let offset = 0;
  const spans = new Map();
  const whitespace = () => {
    while (/\s/u.test(source[offset] ?? '')) offset += 1;
  };
  const string = () => {
    const start = offset;
    if (source[offset] !== '"') throw new SyntaxError(`Expected JSON string at byte ${offset}.`);
    offset += 1;
    while (offset < source.length) {
      if (source[offset] === '\\') {
        offset += 2;
        continue;
      }
      if (source[offset] === '"') {
        offset += 1;
        return JSON.parse(source.slice(start, offset));
      }
      offset += 1;
    }
    throw new SyntaxError('Unterminated JSON string.');
  };
  const value = (pointer = '') => {
    whitespace();
    const start = offset;
    if (source[offset] === '{') {
      offset += 1;
      whitespace();
      if (source[offset] !== '}') {
        while (true) {
          whitespace();
          const key = string();
          whitespace();
          if (source[offset] !== ':') throw new SyntaxError(`Expected ':' at byte ${offset}.`);
          offset += 1;
          value(`${pointer}/${pointerToken(key)}`);
          whitespace();
          if (source[offset] === '}') break;
          if (source[offset] !== ',') throw new SyntaxError(`Expected ',' at byte ${offset}.`);
          offset += 1;
        }
      }
      offset += 1;
    } else if (source[offset] === '[') {
      offset += 1;
      whitespace();
      let index = 0;
      if (source[offset] !== ']') {
        while (true) {
          value(`${pointer}/${index}`);
          index += 1;
          whitespace();
          if (source[offset] === ']') break;
          if (source[offset] !== ',') throw new SyntaxError(`Expected ',' at byte ${offset}.`);
          offset += 1;
        }
      }
      offset += 1;
    } else if (source[offset] === '"') {
      string();
    } else {
      const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(source.slice(offset))?.[0];
      if (!token) throw new SyntaxError(`Invalid JSON value at byte ${offset}.`);
      offset += token.length;
    }
    spans.set(pointer, { start, end: offset });
  };
  value();
  whitespace();
  if (offset !== source.length) throw new SyntaxError(`Unexpected JSON content at byte ${offset}.`);
  return spans;
}

function collectLeafDifferences(before, after, pointer = '', differences = []) {
  if (Object.is(before, after)) return differences;
  const beforeObject = before !== null && typeof before === 'object';
  const afterObject = after !== null && typeof after === 'object';
  if (!beforeObject || !afterObject || Array.isArray(before) !== Array.isArray(after)) {
    differences.push({ pointer, value: after });
    return differences;
  }
  const beforeKeys = Object.keys(before);
  const afterKeys = Object.keys(after);
  if (beforeKeys.length !== afterKeys.length || beforeKeys.some(key => !Object.hasOwn(after, key))) {
    differences.push({ pointer, value: after, structural: true });
    return differences;
  }
  for (const key of beforeKeys) {
    collectLeafDifferences(before[key], after[key], `${pointer}/${pointerToken(key)}`, differences);
    if (differences.length > 1) return differences;
  }
  return differences;
}

export function synchronizeJsonSource(sourceText, document) {
  if (typeof sourceText !== 'string') return `${JSON.stringify(document, null, 2)}\n`;
  let parsed;
  let spans;
  try {
    parsed = JSON.parse(sourceText);
    spans = locateJsonValues(sourceText);
  } catch (error) {
    throw new StudioError('artifact_source_invalid', `Stored JSON artifact source is invalid: ${error.message}`);
  }
  const differences = collectLeafDifferences(parsed, document);
  if (differences.length === 0) return sourceText;
  if (differences.length !== 1 || differences[0].structural || differences[0].pointer === '') {
    throw new StudioError('artifact_source_diverged', 'Artifact export requires exactly one existing JSON leaf change.', {
      differenceCount: differences.length,
    });
  }
  const span = spans.get(differences[0].pointer);
  if (!span) throw new StudioError('artifact_pointer_not_found', `Artifact JSON pointer ${differences[0].pointer} is absent from stored source.`);
  const encoded = JSON.stringify(differences[0].value);
  if (encoded === undefined) throw new StudioError('artifact_value_invalid', 'Artifact JSON values must be serializable.');
  return `${sourceText.slice(0, span.start)}${encoded}${sourceText.slice(span.end)}`;
}
