function requestUrl(value) {
  return String(value?.url ?? value);
}

/** Install the CacheStorage subset WebLLM uses when the native host lacks it. */
export function installNativeCacheStorage({ globalObject = globalThis } = {}) {
  if (globalObject.caches?.open) return globalObject.caches;
  const processObject = globalObject.process;
  const getBuiltin = processObject?.getBuiltinModule?.bind(processObject);
  const fs = getBuiltin?.('fs')?.promises;
  const path = getBuiltin?.('path');
  const crypto = getBuiltin?.('crypto');
  if (!fs || !path || !crypto || typeof globalObject.fetch !== 'function' || typeof globalObject.Response !== 'function') {
    throw new Error('The native host cannot provide persistent local model storage.');
  }
  const base = path.join(
    processObject.env?.LOCALAPPDATA ?? processObject.cwd(),
    'ThreeBrowserStudio',
    'model-cache',
  );
  const opened = new Map();
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');

  async function open(scope) {
    const key = String(scope);
    if (opened.has(key)) return opened.get(key);
    const folder = path.join(base, digest(key));
    const indexPath = path.join(folder, 'index.json');
    await fs.mkdir(folder, { recursive: true });
    let entries = {};
    try { entries = JSON.parse(await fs.readFile(indexPath, 'utf8')); }
    catch { entries = {}; }
    let indexWrite = Promise.resolve();
    const saveIndex = () => {
      indexWrite = indexWrite.then(async () => {
        const temporary = `${indexPath}.${processObject.pid}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(entries), 'utf8');
        await fs.rename(temporary, indexPath);
      });
      return indexWrite;
    };
    const cache = Object.freeze({
      async match(request) {
        const url = requestUrl(request);
        const fileName = entries[url];
        if (!fileName) return undefined;
        try { return new globalObject.Response(await fs.readFile(path.join(folder, fileName))); }
        catch { return undefined; }
      },
      async add(request) {
        const url = requestUrl(request);
        const response = await globalObject.fetch(request);
        if (!response?.ok) throw new Error(`Failed to download local model artifact (${response?.status ?? 'network error'}).`);
        const fileName = `${digest(url)}.bin`;
        const destination = path.join(folder, fileName);
        const temporary = `${destination}.${processObject.pid}.tmp`;
        await fs.writeFile(temporary, new Uint8Array(await response.arrayBuffer()));
        await fs.rename(temporary, destination);
        entries[url] = fileName;
        await saveIndex();
      },
      async keys() {
        return Object.keys(entries).map(url => new globalObject.Request(url));
      },
      async delete(request) {
        const url = requestUrl(request);
        const fileName = entries[url];
        if (!fileName) return false;
        delete entries[url];
        try { await fs.unlink(path.join(folder, fileName)); } catch { /* Missing cache data is already removed. */ }
        await saveIndex();
        return true;
      },
    });
    opened.set(key, cache);
    return cache;
  }

  const storage = Object.freeze({ open });
  globalObject.caches = storage;
  return storage;
}
