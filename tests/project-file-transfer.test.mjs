import assert from 'node:assert/strict';
import test from 'node:test';

import { downloadJsonFile, openProjectPackFile, pickJsonFile, saveProjectPackFile } from '../src/viewport/project-file-transfer.mjs';

class FakeElement {
  constructor(name) {
    this.tagName = name;
    this.listeners = new Map();
    this.removed = false;
    this.clicked = false;
  }

  addEventListener(type, fn) {
    this.listeners.set(type, fn);
  }

  click() {
    this.clicked = true;
  }

  remove() {
    this.removed = true;
  }
}

class FakeTransferDocument {
  constructor() {
    this.created = [];
    this.body = {
      children: [],
      appendChild(element) {
        this.children.push(element);
        return element;
      },
    };
  }

  createElement(name) {
    const element = new FakeElement(name);
    this.created.push(element);
    return element;
  }
}

test('downloadJsonFile writes a JSON attachment without keeping the object URL', async () => {
  const document = new FakeTransferDocument();
  const urls = [];
  downloadJsonFile('three-studio-demo.json', { kind: 'ThreeStudioProjectPack' }, {
    document,
    createObjectURL(blob) {
      assert.equal(blob.type, 'application/json');
      urls.push('blob:test');
      return 'blob:test';
    },
    revokeObjectURL(href) {
      urls.push(`revoked:${href}`);
    },
  });
  const anchor = document.created[0];
  assert.equal(anchor.tagName, 'a');
  assert.equal(anchor.download, 'three-studio-demo.json');
  assert.equal(anchor.clicked, true);
  assert.equal(anchor.removed, true);
  assert.deepEqual(urls, ['blob:test', 'revoked:blob:test']);
  const saved = await saveProjectPackFile('three-studio-demo.json', { kind: 'ThreeStudioProjectPack' }, {
    native: false,
    document,
    createObjectURL: () => 'blob:test-2',
    revokeObjectURL() {},
  });
  assert.equal(saved.name, 'three-studio-demo.json');
});

test('pickJsonFile returns file text and treats cancel as null', async () => {
  const document = new FakeTransferDocument();
  const pending = pickJsonFile({ document });
  const input = document.created[0];
  assert.equal(input.type, 'file');
  assert.equal(input.clicked, true);
  input.files = [new File(['{"kind":"ThreeStudioProject"}'], 'pack.json', { type: 'application/json' })];
  await input.listeners.get('change')();
  const picked = await pending;
  assert.equal(picked.name, 'pack.json');
  assert.equal(picked.text, '{"kind":"ThreeStudioProject"}');

  const cancelledDocument = new FakeTransferDocument();
  const cancelled = pickJsonFile({ document: cancelledDocument });
  cancelledDocument.created[0].listeners.get('cancel')();
  assert.equal(await cancelled, null);
});
