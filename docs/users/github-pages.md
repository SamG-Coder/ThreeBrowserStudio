# GitHub Pages preview

The published page is a **browser WebGPU preview** of the Studio viewport. It
is not the desktop authoring host. Open this URL in Chrome or Edge (WebGPU).
Hard-refresh if you still see an old boot error. Both this page and the native
`.exe` expose the same retained **LLM Setup** tab.

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
- An in-process browser authoring kernel with canonical revisions, validation,
  history, component editing, and transient Play.
- A retained **LLM Setup** tab that can download and activate a curated WebLLM
  model from Hugging Face in the device-local cache. There is no HTTP-provider,
  API-key, or separate prompt-settings UI. An **Enable Prompt workspace** toggle
  reveals Studio-native prompt controls in the same tab.
- A GameMaker-style component composer opened by selecting an object in
  Explorer. Component changes are staged and committed as one revision.
- A visible **Play** button. Enter starts Play and Escape stops it and restores
  the authored state.

## What stays desktop-only

- MCP named pipe and Node filesystem persistence
- Project files under `%LOCALAPPDATA%`
- Native typeface outlines, RTX, and `three_browser_runtime.node`

The active local model is paired with the same nine `three_studio_*` names
through the Studio harness. In the browser those calls reach the in-process
kernel; in native they reach the native application. Model weights are cached
locally and are never included in project packs. WebGPU inference and the
viewport share GPU memory, so Studio lowers viewport refresh while a model is
busy.

When the Prompt workspace is enabled, its shared retained multiline editor
supports selection, navigation, clipboard editing, and undo/redo. Enter adds a
line; Ctrl+Enter sends the text through the active local model, Studio rules,
and that harness. Tool-call progress and the final response stay in the LLM
tab; Escape releases the editor. While it owns focus, key-down and key-up events
are stopped before the 3D viewport input controllers. The enabled state is
local to the host and no prompt or model setting is added to the canonical
project document.

The native host stores downloaded artifacts under
`%LOCALAPPDATA%\ThreeBrowserStudio\model-cache`; the browser uses its private
CacheStorage. The pinned WebLLM JavaScript runtime is installed with Studio,
while model weights are downloaded only when the user presses **Download &
activate**.

The page detects the host in JavaScript. It attaches the desktop kernel only
when ThreeRuntime is present (`__threeBrowserNativeRuntime`, the RTX bridge,
or a `ThreeBrowserRuntime/` user-agent). A generic Chrome user-agent is not
enough — that is how GitHub Pages stays on the browser path.

The Windows exe still loads `site-entry.mjs` through the native host rather
than `pages/index.html`; the retained LLM tab is part of the shared viewport.
