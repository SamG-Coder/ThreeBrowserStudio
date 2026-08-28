import { createHash, randomUUID } from 'node:crypto';

export function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertJsonValue(value, path = '$', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only finite numbers`);
    return;
  }
  if (typeof value !== 'object') throw new TypeError(`${path} is not JSON-serializable`);
  if (seen.has(value)) throw new TypeError(`${path} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertJsonValue(value[index], `${path}[${index}]`, seen);
    }
  } else {
    if (!isPlainRecord(value)) throw new TypeError(`${path} must be a plain object`);
    for (const [key, child] of Object.entries(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new TypeError(`${path}.${key} is not an allowed key`);
      }
      assertJsonValue(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainRecord(value)) return value;
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
  return result;
}

export function stableStringify(value, space = 0) {
  return JSON.stringify(canonicalize(value), null, space);
}

export function contentHash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function createTransactionId(prefix = 'tx') {
  return `${prefix}/${randomUUID()}`;
}

export function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

export function mergePatch(target, patch) {
  if (!isPlainRecord(patch)) return cloneJson(patch);
  const result = isPlainRecord(target) ? cloneJson(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else if (isPlainRecord(value)) result[key] = mergePatch(result[key], value);
    else result[key] = cloneJson(value);
  }
  return result;
}

export function changedTopLevelFields(before, after, ignored = new Set()) {
  const fields = [];
  for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    if (ignored.has(key)) continue;
    if (stableStringify(before?.[key]) !== stableStringify(after?.[key])) fields.push(key);
  }
  return fields.sort();
}

export function nowIso(clock = Date) {
  const value = typeof clock === 'function' ? clock() : clock.now();
  return new Date(value).toISOString();
}
