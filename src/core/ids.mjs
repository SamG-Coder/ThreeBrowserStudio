import { StudioError } from './errors.mjs';

const STABLE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)*$/;
const ALIAS_PATTERN = /^\$[a-z][a-z0-9_-]{0,63}$/;

export function isStableId(value) {
  return typeof value === 'string'
    && value.length <= 160
    && STABLE_ID_PATTERN.test(value)
    && !value.split('/').includes('..');
}

export function assertStableId(value, label = 'id') {
  if (!isStableId(value)) {
    throw new StudioError(
      'invalid_id',
      `${label} must be a lowercase semantic ID using letters, numbers, '.', '_', '-', and '/'`,
      { label, value },
    );
  }
  return value;
}

export function normalizeStableId(label, { prefix } = {}) {
  const segment = String(label ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
    .replace(/-+$/g, '');
  const id = prefix ? `${prefix}/${segment || 'item'}` : (segment || 'item');
  return assertStableId(id);
}

export function isTransactionAlias(value) {
  return typeof value === 'string' && ALIAS_PATTERN.test(value);
}

export function assertTransactionAlias(value) {
  if (!isTransactionAlias(value)) {
    throw new StudioError('invalid_alias', 'Aliases must look like $name', { value });
  }
  return value;
}

export function resolveId(value, aliases, label = 'id') {
  if (!isTransactionAlias(value)) return assertStableId(value, label);
  if (!aliases.has(value)) {
    throw new StudioError('unknown_alias', `Unknown in-transaction alias ${value}`, { alias: value });
  }
  return aliases.get(value);
}
