/**
 * GitHub Pages / stock-browser entry. The desktop host never loads this file;
 * it keeps using site-entry.mjs and the native Three.js module map.
 *
 * Set the preview flag here with a literal. Do not import host-environment for
 * it — GitHub Pages can serve a cached copy of that module without new exports.
 */
globalThis.__THREE_STUDIO_BROWSER_PREVIEW__ = true;
await import('../src/viewport/main.mjs?v=prompt-15');
