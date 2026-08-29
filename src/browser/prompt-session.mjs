import { StudioError } from '../core/errors.mjs';
import { isStableId, normalizeStableId } from '../core/ids.mjs';
import { createLlmProvider, listLiveProviderKinds, normalizeProviderConnection } from './llm-providers.mjs';
import { createBrowserMcpHarness } from './mcp-harness.mjs';

export const BROWSER_HARNESS_SYSTEM = [
  'You are authoring inside ThreeBrowser Studio through the nine three_studio_* tools.',
  'Call three_studio_status first and treat the live capability contract as authoritative.',
  'Do not invent JavaScript scene generators, eval, WGSL, or GLSL.',
  'If a tool returns kernel_unavailable, say that the browser preview has no authoring kernel yet.',
].join(' ');

function publicConnection(connection) {
  return Object.freeze({
    id: connection.id,
    kind: connection.kind,
    label: connection.label,
    config: Object.freeze({ ...connection.config }),
    hasSecret: Boolean(connection.secret),
  });
}

function allocateConnectionId(label, used) {
  const base = normalizeStableId(label || 'model', { prefix: 'conn' });
  if (!used.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (isStableId(candidate) && !used.has(candidate)) return candidate;
  }
  throw new StudioError('invalid_id', 'Could not allocate a unique connection id.');
}

export function createBrowserPromptSession({
  vault,
  harness = createBrowserMcpHarness(),
  fetch: fetchImpl = globalThis.fetch,
  systemPrompt = BROWSER_HARNESS_SYSTEM,
} = {}) {
  if (!vault?.exists || !vault.unlock || !vault.getPayload) {
    throw new TypeError('vault must be a Studio secret vault.');
  }

  function requireUnlocked() {
    if (!vault.isUnlocked()) throw new StudioError('vault_locked', 'Unlock the provider vault with your PIN first.');
  }

  function connectionsFromPayload(payload) {
    return payload.connections.map(item => normalizeProviderConnection(item, { requireSecret: false }));
  }

  return Object.freeze({
    vault,
    harness,
    exists() {
      return vault.exists();
    },
    isUnlocked() {
      return vault.isUnlocked();
    },
    lock() {
      vault.lock();
    },
    async createVault(pin) {
      await vault.create(pin);
    },
    async unlock(pin) {
      await vault.unlock(pin);
    },
    listProviderKinds() {
      return listLiveProviderKinds();
    },
    listConnections() {
      requireUnlocked();
      return connectionsFromPayload(vault.getPayload()).map(publicConnection);
    },
    activeConnection() {
      requireUnlocked();
      const payload = vault.getPayload();
      const connections = connectionsFromPayload(payload);
      const active = connections.find(item => item.id === payload.activeConnectionId) ?? connections[0] ?? null;
      return active ? publicConnection(active) : null;
    },
    async setActiveConnection(id) {
      requireUnlocked();
      const payload = vault.getPayload();
      if (!payload.connections.some(item => item.id === id)) {
        throw new StudioError('provider_unknown', `No saved connection ${id}.`);
      }
      payload.activeConnectionId = id;
      await vault.putPayload(payload);
      return this.activeConnection();
    },
    async saveConnection(draft) {
      requireUnlocked();
      const payload = vault.getPayload();
      const used = new Set(payload.connections.map(item => item.id));
      const id = draft.id && used.has(draft.id)
        ? draft.id
        : (draft.id && isStableId(draft.id) ? draft.id : allocateConnectionId(draft.label, used));
      const existing = payload.connections.find(item => item.id === id);
      const secret = draft.secret || existing?.secret || '';
      const normalized = normalizeProviderConnection({
        id,
        kind: draft.kind,
        label: draft.label,
        config: draft.config,
        secret,
      }, { requireSecret: true });
      const next = {
        id: normalized.id,
        kind: normalized.kind,
        label: normalized.label,
        config: { ...normalized.config },
        secret: normalized.secret,
      };
      payload.connections = [...payload.connections.filter(item => item.id !== id), next];
      payload.activeConnectionId = normalized.id;
      await vault.putPayload(payload);
      return publicConnection(normalized);
    },
    async deleteConnection(id) {
      requireUnlocked();
      const payload = vault.getPayload();
      payload.connections = payload.connections.filter(item => item.id !== id);
      if (payload.activeConnectionId === id) {
        payload.activeConnectionId = payload.connections[0]?.id ?? null;
      }
      await vault.putPayload(payload);
      return this.listConnections();
    },
    async testActive({ signal } = {}) {
      return createActiveProvider().testConnection({ signal });
    },
    async runPrompt(text, { signal, onEvent } = {}) {
      const content = String(text ?? '').trim();
      if (!content) throw new StudioError('prompt_required', 'Write a prompt before running the harness.');
      return harness.run({
        provider: createActiveProvider(),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content },
        ],
        signal,
        onEvent,
      });
    },
  });

  function createActiveProvider() {
    requireUnlocked();
    const payload = vault.getPayload();
    const connections = connectionsFromPayload(payload);
    const active = connections.find(item => item.id === payload.activeConnectionId) ?? connections[0] ?? null;
    if (!active) throw new StudioError('provider_required', 'Save a model connection before running a prompt.');
    return createLlmProvider(active, { fetch: fetchImpl, requireSecret: true });
  }
}
