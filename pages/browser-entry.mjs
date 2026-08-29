/**
 * GitHub Pages / stock-browser entry. The desktop host never loads this file;
 * it keeps using site-entry.mjs and the native Three.js module map.
 */
import { BROWSER_PREVIEW_FLAG } from '../src/runtime/host-environment.mjs';

globalThis[BROWSER_PREVIEW_FLAG] = true;
await import('../src/viewport/main.mjs?v=prompt-2');
