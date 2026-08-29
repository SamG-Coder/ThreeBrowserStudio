# GitHub Pages preview

The published page is a **browser WebGPU preview** of the Studio viewport. It
is not the desktop authoring host.

https://samg-coder.github.io/ThreeBrowserStudio/

## What you get

- The same canvas viewport, bootstrap stage, Follow shot / Review, and HUD
- Stock browser WebGPU (Chrome / Edge)
- Three.js loaded from a CDN import map (`three@0.184.0`)

## What stays desktop-only

- MCP named pipe and the nine tools
- Project files under `%LOCALAPPDATA%`
- Native typeface outlines, RTX, and `three_browser_runtime.node`

The page detects the host in JavaScript. It attaches the desktop kernel only
when ThreeRuntime is present (`__threeBrowserNativeRuntime`, the RTX bridge,
or a `ThreeBrowserRuntime/` user-agent). A generic Chrome user-agent is not
enough — that is how GitHub Pages stays on the browser path.

## Desktop is unchanged

The Windows exe still loads `site-entry.mjs` through the native host. It never
loads `pages/index.html`.
