const DEFAULT_ACCEPT = '.json,application/json';

function requireDocument(doc) {
  if (!doc?.createElement) throw new TypeError('A DOM document is required for project file transfer');
  return doc;
}

export function downloadJsonFile(fileName, value, {
  document: doc = globalThis.document,
  createObjectURL = globalThis.URL?.createObjectURL?.bind(globalThis.URL),
  revokeObjectURL = globalThis.URL?.revokeObjectURL?.bind(globalThis.URL),
} = {}) {
  const document = requireDocument(doc);
  if (typeof createObjectURL !== 'function' || typeof revokeObjectURL !== 'function') {
    throw new TypeError('Blob object URLs are required to export a project');
  }
  const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  const blob = new Blob([text], { type: 'application/json' });
  const href = createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body?.appendChild(anchor);
  anchor.click();
  anchor.remove();
  revokeObjectURL(href);
}

export async function saveProjectPackFile(fileName, value, options = {}) {
  if (options.native) {
    const { saveJsonWithNativeDialog } = await import('./project-file-transfer-native.mjs');
    return saveJsonWithNativeDialog(fileName, value, options);
  }
  downloadJsonFile(fileName, value, options);
  return { name: fileName };
}

export async function openProjectPackFile(options = {}) {
  if (options.native) {
    const { openJsonWithNativeDialog } = await import('./project-file-transfer-native.mjs');
    return openJsonWithNativeDialog(options);
  }
  return pickJsonFile(options);
}

export function pickJsonFile({
  accept = DEFAULT_ACCEPT,
  document: doc = globalThis.document,
} = {}) {
  const document = requireDocument(doc);
  return new Promise((resolve, reject) => {
    let settled = false;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.hidden = true;

    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      input.remove();
      if (error) reject(error);
      else resolve(value);
    };

    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      try {
        finish({ name: file.name, size: file.size, text: await file.text() });
      } catch (error) {
        finish(null, error);
      }
    }, { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    document.body?.appendChild(input);
    input.click();
  });
}
