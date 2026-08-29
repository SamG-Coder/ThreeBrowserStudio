# GitHub Pages preview

The published page is a **browser WebGPU preview** of the Studio viewport. It
is not the desktop authoring host. Open this URL in Chrome or Edge (WebGPU).
Hard-refresh if you still see an old boot error. The native `.exe` /
`npm run launch` window does not show Prompt.

https://samg-coder.github.io/ThreeBrowserStudio/

## What you get

- The same canvas viewport, bootstrap stage, Follow shot / Review, and HUD
- Stock browser WebGPU (Chrome / Edge)
- Three.js loaded from a CDN import map (`three@0.184.0`)
- Settings **Import / Export** of a canonical project JSON pack. Export
  downloads a file; Import compiles it in this tab. Nothing is written under
  `%LOCALAPPDATA%`.
- A bottom **Prompt** dock (browser only) for Gemini or an HTTP chat API
  through an abstract provider catalog. API keys live in `localStorage` only
  as AES-GCM ciphertext; a PIN unlocks them. Prompt keys are never included
  in a project pack.

## What stays desktop-only

- MCP named pipe and the Node authoring kernel
- Project files under `%LOCALAPPDATA%`
- Native typeface outlines, RTX, and `three_browser_runtime.node`

The browser Prompt dock talks to the nine `three_studio_*` names through a
generic in-page harness. Until an in-process kernel is attached, tool calls
return `kernel_unavailable`. The page never stores a PIN, and it never puts
API keys in the published HTML. Gemini uses `x-goog-api-key` against
`generativelanguage.googleapis.com`. Stock browsers usually block that origin
with CORS; if Test fails, put a same-origin proxy URL in Base URL, or use
HTTP chat through a CORS-friendly host. Do not paste a key into the page
source.

The page detects the host in JavaScript. It attaches the desktop kernel only
when ThreeRuntime is present (`__threeBrowserNativeRuntime`, the RTX bridge,
or a `ThreeBrowserRuntime/` user-agent). A generic Chrome user-agent is not
enough — that is how GitHub Pages stays on the browser path.

## Desktop is unchanged

The Windows exe still loads `site-entry.mjs` through the native host. It never
loads `pages/index.html`.
