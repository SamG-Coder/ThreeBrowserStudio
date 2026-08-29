import { StudioError } from '../core/errors.mjs';

export const VAULT_STORAGE_KEY = 'three-studio.secret-vault.v1';
export const VAULT_VERSION = 1;
const KDF_ITERATIONS = 210_000;
const PIN_MIN = 4;
const PIN_MAX = 64;

function requireCrypto(crypto) {
  const subtle = crypto?.subtle;
  if (!subtle?.importKey || !subtle.deriveKey || !subtle.encrypt || !subtle.decrypt) {
    throw new StudioError('crypto_unavailable', 'Web Crypto is required to PIN-encrypt provider secrets.');
  }
  return subtle;
}

function requireStorage(storage) {
  if (typeof storage?.getItem !== 'function' || typeof storage?.setItem !== 'function' || typeof storage?.removeItem !== 'function') {
    throw new StudioError('storage_unavailable', 'localStorage is required to keep the encrypted provider vault.');
  }
  return storage;
}

function bytesToBase64(bytes) {
  const binary = String.fromCharCode(...bytes);
  return globalThis.btoa(binary);
}

function base64ToBytes(value) {
  const binary = globalThis.atob(String(value ?? ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function normalizePin(pin) {
  const value = String(pin ?? '');
  if (value.length < PIN_MIN || value.length > PIN_MAX) {
    throw new StudioError('invalid_pin', `PIN must be ${PIN_MIN}–${PIN_MAX} characters.`);
  }
  return value;
}

function clonePayload(payload) {
  return structuredClone(payload ?? { version: VAULT_VERSION, connections: [], activeConnectionId: null });
}

function assertPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new StudioError('vault_corrupt', 'The decrypted vault payload is not an object.');
  }
  if (payload.version !== VAULT_VERSION) {
    throw new StudioError('vault_unsupported', `Unsupported vault version ${payload.version}.`);
  }
  if (!Array.isArray(payload.connections)) {
    throw new StudioError('vault_corrupt', 'The vault connections list is missing.');
  }
  return payload;
}

async function deriveKey(subtle, pin, salt) {
  const material = await subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: KDF_ITERATIONS },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function readRecord(storage, storageKey) {
  const raw = storage.getItem(storageKey);
  if (raw == null || raw === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StudioError('vault_corrupt', 'The stored vault record is not JSON.');
  }
  if (!parsed || parsed.version !== VAULT_VERSION || parsed.kdf?.name !== 'PBKDF2' || parsed.cipher !== 'AES-GCM') {
    throw new StudioError('vault_unsupported', 'The stored vault record is not a PIN-encrypted Studio vault.');
  }
  if (typeof parsed.salt !== 'string' || typeof parsed.iv !== 'string' || typeof parsed.ciphertext !== 'string') {
    throw new StudioError('vault_corrupt', 'The stored vault record is missing cipher fields.');
  }
  return parsed;
}

/**
 * Browser-only secret store. The PIN never goes into localStorage. Tokens live
 * only in the AES-GCM ciphertext and in memory while unlocked.
 */
export function createSecretVault({
  storage = globalThis.localStorage,
  crypto = globalThis.crypto,
  storageKey = VAULT_STORAGE_KEY,
} = {}) {
  const store = requireStorage(storage);
  const subtle = requireCrypto(crypto);
  let key = null;
  let payload = null;

  async function encryptAndWrite(nextPayload, nextKey, saltBytes) {
    const existing = readRecord(store, storageKey);
    const salt = saltBytes ?? (existing ? base64ToBytes(existing.salt) : crypto.getRandomValues(new Uint8Array(16)));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(nextPayload));
    const ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, nextKey, encoded));
    store.setItem(storageKey, JSON.stringify({
      version: VAULT_VERSION,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS },
      cipher: 'AES-GCM',
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertext),
    }));
  }

  async function decryptWith(pin) {
    const record = readRecord(store, storageKey);
    if (!record) throw new StudioError('vault_missing', 'No encrypted provider vault exists in this browser yet.');
    const nextKey = await deriveKey(subtle, normalizePin(pin), base64ToBytes(record.salt));
    let plaintext;
    try {
      plaintext = await subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes(record.iv) },
        nextKey,
        base64ToBytes(record.ciphertext),
      );
    } catch {
      throw new StudioError('invalid_pin', 'That PIN does not unlock the provider vault.');
    }
    const nextPayload = assertPayload(JSON.parse(new TextDecoder().decode(plaintext)));
    return { key: nextKey, payload: nextPayload };
  }

  return Object.freeze({
    get storageKey() {
      return storageKey;
    },
    exists() {
      return readRecord(store, storageKey) != null;
    },
    isUnlocked() {
      return key != null && payload != null;
    },
    lock() {
      key = null;
      payload = null;
    },
    clear() {
      this.lock();
      store.removeItem(storageKey);
    },
    getPayload() {
      if (!this.isUnlocked()) throw new StudioError('vault_locked', 'Unlock the provider vault with your PIN first.');
      return clonePayload(payload);
    },
    async create(pin, initial = {}) {
      if (this.exists()) throw new StudioError('vault_exists', 'A provider vault already exists in this browser.');
      const nextPayload = assertPayload({
        connections: [],
        activeConnectionId: null,
        ...initial,
        version: VAULT_VERSION,
      });
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const nextKey = await deriveKey(subtle, normalizePin(pin), salt);
      await encryptAndWrite(nextPayload, nextKey, salt);
      key = nextKey;
      payload = nextPayload;
      return clonePayload(payload);
    },
    async unlock(pin) {
      const unlocked = await decryptWith(pin);
      key = unlocked.key;
      payload = unlocked.payload;
      return clonePayload(payload);
    },
    async putPayload(next) {
      if (!this.isUnlocked()) throw new StudioError('vault_locked', 'Unlock the provider vault with your PIN first.');
      payload = assertPayload(clonePayload(next));
      await encryptAndWrite(payload, key);
      return clonePayload(payload);
    },
  });
}
