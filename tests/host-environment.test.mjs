import assert from 'node:assert/strict';
import test from 'node:test';

import { BROWSER_PREVIEW_FLAG, detectStudioHost, isBrowserPreview } from '../src/runtime/host-environment.mjs';

test('stock browser and Node test runner are not a native ThreeRuntime host', () => {
  const host = detectStudioHost({
    globalObject: { navigator: { userAgent: 'Mozilla/5.0 Chrome/128.0.0.0' } },
  });
  assert.equal(host.attached, false);
  assert.equal(host.kind, 'browser');
  assert.equal(host.hasNativeFlag, false);
  assert.equal(host.hasRtxBridge, false);
  assert.equal(host.userAgentRuntime, false);
});

test('native flag attaches the desktop host without trusting a generic Chrome UA', () => {
  const host = detectStudioHost({
    globalObject: {
      __threeBrowserNativeRuntime: true,
      navigator: { userAgent: 'Mozilla/5.0 Chrome/128.0.0.0' },
    },
  });
  assert.equal(host.attached, true);
  assert.equal(host.kind, 'native');
  assert.equal(host.hasNativeFlag, true);
  assert.equal(host.userAgentRuntime, false);
});

test('RTX bridge or ThreeBrowserRuntime UA also attach the desktop host', () => {
  assert.equal(detectStudioHost({
    globalObject: { navigator: { gpu: { threeBrowserRTX: { getStatus() { return {}; } } } } },
  }).hasRtxBridge, true);
  assert.equal(detectStudioHost({
    globalObject: {
      navigator: {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0 Safari/537.36 ThreeBrowserRuntime/0.1',
      },
    },
  }).userAgentRuntime, true);
});

test('Pages entry flag is a browser preview even when ThreeRuntime is attached', () => {
  assert.equal(isBrowserPreview({ globalObject: {} }), false);
  assert.equal(isBrowserPreview({
    globalObject: { [BROWSER_PREVIEW_FLAG]: true, __threeBrowserNativeRuntime: true },
  }), true);
});
