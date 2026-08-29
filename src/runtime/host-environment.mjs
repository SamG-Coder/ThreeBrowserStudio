const RUNTIME_UA = /\bThreeBrowserRuntime\//i;

/**
 * Detects the ThreeBrowser native host versus a stock browser (GitHub Pages).
 * Prefer the host flag and RTX bridge. User-agent is a fallback only.
 */
export function detectStudioHost({ globalObject = globalThis } = {}) {
  let userAgent = '';
  try {
    userAgent = String(globalObject?.navigator?.userAgent ?? '');
  } catch {
    userAgent = '';
  }
  let rtx = null;
  try {
    rtx = globalObject?.navigator?.gpu?.threeBrowserRTX ?? null;
  } catch {
    rtx = null;
  }
  const hasNativeFlag = globalObject?.__threeBrowserNativeRuntime === true;
  const hasRtxBridge = rtx != null && typeof rtx === 'object';
  const userAgentRuntime = RUNTIME_UA.test(userAgent);
  const attached = hasNativeFlag || hasRtxBridge || userAgentRuntime;
  return Object.freeze({
    attached,
    kind: attached ? 'native' : 'browser',
    hasNativeFlag,
    hasRtxBridge,
    userAgentRuntime,
  });
}
