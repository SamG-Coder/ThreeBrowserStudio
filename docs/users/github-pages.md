# GitHub Pages preview

The published page is a **browser WebGPU preview** of the Studio viewport. It
is not the desktop authoring host. Open this URL in Chrome or Edge (WebGPU).
Hard-refresh if you still see an old boot error. The native `.exe` /
`npm run launch` window does not show Prompt.

https://samg-coder.github.io/ThreeBrowserStudio/

## Load a project from GitHub

The browser preview can load a canonical `ThreeStudioProject` or
`ThreeStudioProjectPack` from the published starter scenes in this repository.
Pass the GitHub file link through the `starter-project-scene` query parameter.
GitHub `blob` links are converted to `raw.githubusercontent.com` before fetching:

```text
https://samg-coder.github.io/ThreeBrowserStudio/?starter-project-scene=https%3A%2F%2Fgithub.com%2FSamG-Coder%2FThreeBrowserStudio%2Fblob%2Fmain%2Ftemplates%2Fstarter-project%2Fscenes%2Fthree-studio-crimson-orchard-apple.json
```

The fetch is browser-only, anonymous, HTTPS-only, size-bounded, and limited to
JSON files under `SamG-Coder/ThreeBrowserStudio/templates/starter-project/scenes/`.
The downloaded JSON goes through the same project-pack validation and
compile-before-swap path as **Import JSON**. If the link cannot be downloaded,
validated, or compiled, the page keeps working and opens the bundled starter
project instead.

## What you get

- The same canvas viewport, the authored starter project, Follow shot / Review, and HUD
- Stock browser WebGPU (Chrome / Edge)
- Three.js loaded from a CDN import map (`three@0.184.0`)
- Settings **Import / Export** of a canonical project JSON pack. Export
  downloads the compiled starter (or the last import). Import replaces the
  scene in this tab. Nothing is written under `%LOCALAPPDATA%`.
  The wait-for-kernel bootstrap stage is desktop-only; it is not a project
  object and the browser never keeps it.
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
