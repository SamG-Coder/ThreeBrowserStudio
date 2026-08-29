import assert from 'node:assert/strict';
import test from 'node:test';

import { createSecretVault } from '../src/browser/secret-vault.mjs';

class MemoryStorage {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial));
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    this.map.set(key, String(value));
  }

  removeItem(key) {
    this.map.delete(key);
  }
}

function vault(storage = new MemoryStorage()) {
  return { storage, vault: createSecretVault({ storage }) };
}

test('PIN-encrypted vault stores no plaintext token and unlocks only with the PIN', async () => {
  const { storage, vault: store } = vault();
  await store.create('1234', {
    connections: [{ id: 'conn/demo', kind: 'http-chat', label: 'Demo', config: {}, secret: 'sk-secret' }],
    activeConnectionId: 'conn/demo',
  });
  const raw = storage.getItem(store.storageKey);
  assert.match(raw, /AES-GCM/);
  assert.doesNotMatch(raw, /sk-secret|1234/);
  assert.equal(store.isUnlocked(), true);
  assert.equal(store.getPayload().connections[0].secret, 'sk-secret');

  store.lock();
  assert.equal(store.isUnlocked(), false);
  assert.throws(() => store.getPayload(), { code: 'vault_locked' });

  const other = createSecretVault({ storage });
  await assert.rejects(() => other.unlock('9999'), { code: 'invalid_pin' });
  await other.unlock('1234');
  assert.equal(other.getPayload().connections[0].secret, 'sk-secret');
});

test('wrong PIN length and missing vault fail without writing secrets', async () => {
  const { vault: store } = vault();
  await assert.rejects(() => store.unlock('1234'), { code: 'vault_missing' });
  await assert.rejects(() => store.create('12'), { code: 'invalid_pin' });
  await store.create('abcd');
  await assert.rejects(() => store.create('efgh'), { code: 'vault_exists' });
});
