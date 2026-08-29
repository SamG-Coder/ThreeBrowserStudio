import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  chooseNativeJsonPath,
  encodePowerShellCommand,
  openJsonWithNativeDialog,
  saveJsonWithNativeDialog,
} from '../src/viewport/project-file-transfer-native.mjs';

function fakeSpawn(stdout, { code = 0, stderr = '' } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
    return child;
  };
  return { spawnImpl, calls };
}

test('native save dialog writes JSON to the chosen Windows path', async () => {
  const { spawnImpl, calls } = fakeSpawn('C:\\\\Users\\\\sam\\\\Desktop\\\\three-studio-demo.json');
  const writes = [];
  const saved = await saveJsonWithNativeDialog('three-studio-demo.json', { kind: 'ThreeStudioProjectPack' }, {
    spawn: spawnImpl,
    writeFile: async (filePath, text) => { writes.push({ filePath, text }); },
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
  });
  assert.equal(saved.name, 'three-studio-demo.json');
  assert.match(saved.path, /three-studio-demo\.json$/);
  assert.match(writes[0].text, /ThreeStudioProjectPack/);
  assert.equal(calls[0].options.env.THREE_STUDIO_DIALOG_MODE, 'save');
  assert.equal(calls[0].options.env.THREE_STUDIO_DIALOG_NAME, 'three-studio-demo.json');
  assert.ok(calls[0].args.includes('-STA'));
  assert.ok(calls[0].args.includes('-EncodedCommand'));
  assert.equal(encodePowerShellCommand('abc').length > 0, true);
});

test('native open dialog reads the chosen file and cancel returns null', async () => {
  const opened = fakeSpawn('C:\\\\packs\\\\scene.json');
  const picked = await openJsonWithNativeDialog({
    spawn: opened.spawnImpl,
    stat: async () => ({ size: 24 }),
    readFile: async () => '{"kind":"ThreeStudioProject"}',
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
  });
  assert.equal(picked.name, 'scene.json');
  assert.equal(picked.text, '{"kind":"ThreeStudioProject"}');

  const cancelled = fakeSpawn('');
  assert.equal(await chooseNativeJsonPath({
    mode: 'open',
    spawn: cancelled.spawnImpl,
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
  }), null);
});

test('native dialogs stay Windows-only without an injected chooser', async () => {
  await assert.rejects(
    chooseNativeJsonPath({ platform: 'darwin' }),
    error => error.code === 'native_dialog_unsupported',
  );
});
