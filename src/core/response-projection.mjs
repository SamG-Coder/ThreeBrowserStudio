import { contentHash, isPlainRecord } from './util.mjs';
import { StudioError } from './errors.mjs';

export const RESPONSE_PROJECTION_LIMITS = Object.freeze({
  maxFields: 64,
  maxPathLength: 160,
  maxDepth: 8,
});

const PATH_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*$/u;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor', 'token', 'pixels', 'data', 'inputschemas']);
const ENVELOPE_FIELDS = Object.freeze(['success', 'revision', 'projectId']);

function segments(path) {
  if (typeof path !== 'string' || path.length < 1 || path.length > RESPONSE_PROJECTION_LIMITS.maxPathLength || !PATH_PATTERN.test(path)) {
    throw new StudioError('invalid_response_projection', `Invalid response field path ${String(path)}.`);
  }
  const result = path.split('.');
  if (result.length > RESPONSE_PROJECTION_LIMITS.maxDepth || result.some(segment => FORBIDDEN_SEGMENTS.has(segment.toLowerCase()))) {
    throw new StudioError('response_projection_forbidden', `Response field path ${path} is not selectable.`);
  }
  return result;
}

function hasPath(value, path) {
  if (path.length === 0) return true;
  if (Array.isArray(value)) return value.length === 0 || value.some(item => hasPath(item, path));
  return isPlainRecord(value) && Object.hasOwn(value, path[0]) && hasPath(value[path[0]], path.slice(1));
}

function selectionTree(paths) {
  const root = {};
  for (const path of paths) {
    let node = root;
    for (const segment of path) node = (node[segment] ??= {});
  }
  return root;
}

function projectNode(value, tree) {
  if (Array.isArray(value)) return value.map(item => projectNode(item, tree));
  if (!isPlainRecord(value)) return value;
  const output = {};
  for (const [key, branch] of Object.entries(tree)) {
    if (!Object.hasOwn(value, key)) continue;
    output[key] = Object.keys(branch).length === 0 ? structuredClone(value[key]) : projectNode(value[key], branch);
  }
  return output;
}

function firstRows(value, prefix = '') {
  if (!isPlainRecord(value)) return null;
  const preferred = ['entities', 'resources', 'items', 'entries', 'children', 'diagnostics', 'projects'];
  for (const key of preferred) {
    if (Array.isArray(value[key])) return { path: prefix ? `${prefix}.${key}` : key, rows: value[key] };
  }
  for (const [key, child] of Object.entries(value)) {
    if (!isPlainRecord(child)) continue;
    const found = firstRows(child, prefix ? `${prefix}.${key}` : key);
    if (found) return found;
  }
  return null;
}

function isPageableObjectCollection(path) {
  return !path.includes('.') || path === 'catalog.entries';
}

function pageInfo(value, rowCount) {
  const existing = value.pageInfo ?? {};
  const nextCursor = existing.nextCursor ?? value.nextCursor ?? null;
  const total = existing.total ?? value.total ?? value.totalCount ?? value.scene?.selectedEntityCount;
  const truncated = existing.truncated ?? value.truncated ?? nextCursor !== null;
  return {
    returned: rowCount,
    ...(Number.isInteger(total) ? { total } : {}),
    nextCursor,
    truncated: Boolean(truncated),
  };
}

/** Applies a bounded field projection and optional row envelope to an MCP result. */
export function shapeToolResponse(raw, {
  select,
  defaultSelect,
  format = 'object',
  ifHash,
  preset,
} = {}) {
  const requested = select ?? defaultSelect;
  let projected = structuredClone(raw);
  if (requested?.length) {
    if (requested.length > RESPONSE_PROJECTION_LIMITS.maxFields) {
      throw new StudioError('response_projection_limit', `select supports at most ${RESPONSE_PROJECTION_LIMITS.maxFields} field paths.`);
    }
    const unique = [...new Set([...ENVELOPE_FIELDS, ...requested])];
    const parsed = unique.map(segments);
    for (let index = 0; index < unique.length; index += 1) {
      if (!hasPath(raw, parsed[index]) && !ENVELOPE_FIELDS.includes(unique[index])) {
        throw new StudioError('response_projection_unknown_field', `Response field ${unique[index]} is unavailable for this query.`, {
          field: unique[index],
        });
      }
    }
    projected = projectNode(raw, selectionTree(parsed));
  }
  if (format === 'rows') {
    const found = firstRows(projected);
    if (!found) throw new StudioError('response_rows_unavailable', 'The selected response contains no row collection.');
    projected = {
      success: raw.success !== false,
      ...(raw.revision === undefined ? {} : { revision: raw.revision }),
      ...(raw.projectId === undefined ? {} : { projectId: raw.projectId }),
      rowPath: found.path,
      rows: found.rows,
      pageInfo: pageInfo(raw, found.rows.length),
    };
  } else {
    const found = firstRows(projected);
    if (found && isPageableObjectCollection(found.path) && projected.pageInfo === undefined) {
      projected.pageInfo = pageInfo(raw, found.rows.length);
    }
  }
  const hash = contentHash(projected);
  if (ifHash === hash) {
    return {
      success: true,
      ...(raw.revision === undefined ? {} : { revision: raw.revision }),
      ...(raw.projectId === undefined ? {} : { projectId: raw.projectId }),
      notModified: true,
      responseHash: hash,
    };
  }
  const estimatedBytes = new TextEncoder().encode(JSON.stringify(projected)).byteLength;
  return {
    ...projected,
    responseMeta: {
      responseHash: hash,
      estimatedBytes,
      format,
      preset: preset ?? null,
      selectedFields: requested?.length ?? 0,
    },
  };
}
