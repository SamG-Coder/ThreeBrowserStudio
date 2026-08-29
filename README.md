# ThreeBrowser Studio

[![CI](https://github.com/SamG-Coder/ThreeBrowserStudio/actions/workflows/ci.yml/badge.svg)](https://github.com/SamG-Coder/ThreeBrowserStudio/actions/workflows/ci.yml)

ThreeBrowser Studio is a persistent Three.js WebGPU authoring runtime for
Codex and ChatGPT. MCP is the editor. The native window is a live viewport
where a user can watch a project being created and review the same visual
evidence as the model. Play evaluates deterministic Action/keyframe animation;
game behaviour execution is a later capability.

The project is intentionally standalone. It uses an installed ThreeBrowser
Runtime as its renderer/host instead of copying runtime, RTX, game, or sample
code into this repository.

The target architecture and phased authoring-pipeline contract are in
[`DESIGN.md`](./DESIGN.md). Model operating rules are in
[`AGENT_RULES.md`](./AGENT_RULES.md). Blender concept mapping and the executable
official tutorial translation are in
[`BLENDER_COMPATIBILITY.md`](./BLENDER_COMPATIBILITY.md).

## Product shape

- One long-running native WebGPU viewport.
- One versioned project document and revision shared by MCP and the viewport.
- Nine model-facing tools: status, project, inspect, apply, validate, play,
  render, history, and jobs.
- Typed scene/resources and validated shader, texture, and blueprint graph IR.
- Atomic changesets, dry-run, undo/redo, recovery, and named saves.
- Agent-safe `.mjs` validation and storage, with MCP authoring/attachment and
  execution deliberately deferred.
- An explicit managed project restores its named save or newer recovery state,
  including active scene and authored camera, into the persistent viewport.

## Current MCP capability boundary

The nine-tool shape is stable, but each tool advertises only its live slice:

- `inspect`: scene digest or ID/name/kind/tag selection with summary, tree and
  delete-guard hashes, transform, component, compiled-bounds, and incoming-
  reference slices; bounded resource topology/component digests; exact
  mesh-element pages, exact modifier-stack hashes/execution classifications,
  graph digests, and RTX collector diagnostics; changes,
  unresolved/unused resources, graph and Blender compatibility catalogs,
  Play/Action state, and latest evidence metadata;
- `apply`: the live-refreshed atomic scene, camera, layout, indexed-triangle and
  hash-guarded editable-polygon geometry contract, including direct per-corner
  UV/color layers, per-face materials, sharp edges, crease storage, bounded
  inline raster textures, RTX, entity, resource, and modifier-stack operations;
- `validate`: whole-project interactive schema, reference, hierarchy, typed
  graph, Action/keyframe, and budget validation;
- `render`: an exact animation frame, named camera, or explicit framing followed
  by offscreen WebGPU beauty capture without changing canonical state;
- `play`: deterministic Action animation enter/stop/pause/resume/seek/step plus
  recorded input, without script, blueprint, physics, or game-logic execution;
- `project`: list, create, open, and atomic save; and
- `history`: list, inspect, undo, and redo.

The jobs tool remains as an explicit reserved ninth slot and always reports
`job_not_implemented`. Shader and texture graph resources are authored through
ordinary resource operations: the live subset compiles to TSL/WebGPU and the
procedural subset can be deterministically CPU-baked. Bounded inline
`dataTexture` resources compile once to shared RGBA8 WebGPU textures and bind
to supported raster material map slots. Existing format-v1 generic texture
placeholders remain valid/indexable but are not live raster inputs. Script operations,
layout generators, scoped or code/asset/render validation, diagnostic passes,
export, and RTX evidence remain absent. Status capabilities are authoritative.

## Lean dependency boundary

Studio does not vendor ThreeBrowser or Three.js renderer code. The viewport is
launched by the external ThreeBrowser Runtime, which supplies its native
`three/webgpu` compatibility layer. This package owns only the authoring kernel,
MCP adapter, project schemas, compilers, persistent viewport application, and
tests.

The runtime root is resolved in this order:

1. `THREEBROWSER_RUNTIME_ROOT`;
2. the configured path in `.studio-local.json`;
3. a packaged `host` folder beside the Studio app (release layout); or
4. a sibling checkout at `<parent>/ThreeBrowser/ThreeBrowserRuntime`.

Local machine paths never enter a saved Studio project.

The strict split-file envelope is
[`schemas/project-manifest-v1.schema.json`](./schemas/project-manifest-v1.schema.json);
[`schemas/project-v1.schema.json`](./schemas/project-v1.schema.json) separately
describes the normalized in-memory document.

## Repository layout

```text
src/core       canonical project IR, transactions, history, persistence
src/blender    machine-readable Blender concept/capability catalog
src/graphs     shader, texture, and blueprint graph catalogs/validators
src/scripts    behaviour validation and atomic source storage (no execution)
src/bridge     authenticated live named-pipe protocol
src/mcp        official MCP stdio adapter and nine tools
src/runtime    Three.js scene, modifier, constraint, and Action compiler/runtime
src/tutorials  official Blender Fundamentals workflows translated to MCP
src/viewport   persistent native review/evidence surface
schemas        machine-readable normalized IR, disk-manifest, and tool contracts
templates      lean starter projects
tests          kernel, protocol, schema, graph, script, and runtime contracts
projects       local user projects (ignored by Git)
```

## Run the live Studio

### Windows release

The first Windows release is a lean zip: `ThreeBrowserStudio.exe`, Studio,
and only the compiled host binaries the viewport needs. It does not ship
Node.js, ThreeC++ / threepp source, CMake trees, samples, games, or the
NVIDIA DLSS / Streamline stack. The compiled `three_native.dll` is included
because the current host addon links it; that is the built library, not the
source tree.

Build the pack from a machine that already has a built ThreeBrowser Runtime
and Node 24:

```powershell
npm run release:pack
```

That writes `dist/ThreeBrowserStudio-<version>-win-x64/` and a zip beside it.
The launcher is a Release win-x64 .NET 10 single-file trimmed executable.
Extract the zip and double-click `ThreeBrowserStudio.exe`. The first launch
uses Node.js 24+ from PATH, or asks to download the official Windows x64
`node.exe` from nodejs.org into `%LOCALAPPDATA%\ThreeBrowserStudio\node`.
User projects go to `%LOCALAPPDATA%\ThreeBrowserStudio\projects`. After the
window is open, point an MCP client at `node` with `app\src\mcp\server.mjs`
and working directory `app` (see `mcp.example.toml` in the zip). Pass
`--with-node` to `release:pack` only when you want an air-gapped zip that
still embeds `node.exe`.

### Development checkout

The checkout path targets Windows x64. It requires Node 24+, .NET 10,
CMake, and the MSYS2 UCRT64 toolchain described by the
[ThreeBrowser Runtime](https://github.com/SamG-Coder/threepp/tree/master/ThreeBrowserRuntime).
Clone and build that runtime beside Studio, then install Studio deterministically:

```powershell
git clone https://github.com/SamG-Coder/ThreeBrowserStudio.git
cd ThreeBrowserStudio
git clone https://github.com/SamG-Coder/threepp.git ..\ThreeBrowser
dotnet build ..\ThreeBrowser\ThreeBrowserRuntime\ThreeBrowserRuntime.csproj
npm ci
npm test
npm run launch
```

After that one-time runtime setup, the easiest Windows launch is to double-click
[`Launch ThreeBrowser Studio.cmd`](./Launch%20ThreeBrowser%20Studio.cmd) in the
repository folder. It always starts from the correct folder, checks for Node 24,
runs the locked `npm ci` install only when required packages are missing, and
keeps the console open if setup or launch fails. A project folder can be dragged
onto the launcher to open it explicitly.

For a terminal launch, use the shorter alias `npm start`. `npm run launch`
continues to work unchanged, and either command accepts a project path after
`--`, for example `npm start -- projects/my-project`.

By default Studio finds a packaged `host` folder beside the app, then the
sibling checkout at `..\ThreeBrowser\ThreeBrowserRuntime`. For another
location, set `THREEBROWSER_RUNTIME_ROOT` to the absolute
`ThreeBrowserRuntime` directory, or put
`{ "runtimeRoot": "C:\\path\\to\\ThreeBrowserRuntime" }` in the ignored
`.studio-local.json` file. Machine-local paths never enter a saved project.

`npm run launch` opens one native WebGPU window and restores the last opened
project (falling back to `projects/live`). The first launch seeds a 13.6 KB,
asset-free starter stage. Later launches restore the named project, newer
recovery journal, review camera, selected render camera, and evidence metadata.
The authenticated connection marker is kept outside the repository at
`%LOCALAPPDATA%\ThreeBrowserStudio\live-session.json` with a current-user-only
Windows ACL.

Press **Ctrl+Shift+M** in the native window to hide the side panel. The panel
is retained 2D chrome (Log + Explorer + Settings), not an inspector: a
virtualized, redacted MCP command log with a visible scrollbar, a read-only
scene tree of objects and groups, and Follow shot / Review camera settings.
Follow shot is the authored camera; the first drag on the view enters a
session-only Review look/fly camera that never writes that camera.
Evidence stays on the authored shot. The log excludes bridge pings and never
displays raw arguments or results.

While the window is running, the thin CLI is useful for diagnostics without
starting an MCP client:

```powershell
npm run call -- three_studio_status
```

To build the official Blender Fundamentals watering-can + bouncing-ball
translation as a new project, dry-run it, render three frames, and save it:

```powershell
npm run tutorial:blender
```

The runner never overwrites an existing project. Pass a new managed directory
name for another clean translation, for example
`npm run tutorial:blender -- blender-fundamentals-2`.

For the more involved procedural-shading showcase, recreate Simon Thommes'
Blender Studio **Rainy Window** tutorial as an aged four-pane window with two
live TSL shader graphs, 48 raised rain details, a storm exterior, WebGPU
lighting/shadows, and a 28-second Action:

```powershell
npm run tutorial:blender:rainy-window
```

The runner dry-runs the 113-operation changeset, compiles the scene, validates
all graphs/references/animations/budgets, captures opening/middle/closing frames,
and atomically saves the project. The adaptation and CC BY 4.0 attribution are
recorded in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

To show MCP authoring rather than cutting straight to the completed artwork,
the live runner can prepare a blank authored camera and then assemble the same
scene in visible dependency-safe stages:

```powershell
node scripts/run-blender-rainy-window-live.mjs prepare rainy-window-live-take
node scripts/run-blender-rainy-window-live.mjs build rainy-window-live-take
```

The native viewport stays open while the frame, joinery, exterior, panes,
shader graphs, and three rain layers arrive as atomic WebGPU scene swaps. The
runner validates and saves the result, then starts the full 28-second Action.

On Windows, a local OBS 32 installation can be prepared for an isolated silent
showcase capture with `npm run obs:setup`. The guarded recorder in
`scripts/record-threebrowser.ps1` binds the exact native ThreeBrowser process,
requires its window to remain maximized, and deletes the partial take if that
window closes, is replaced, or stops being maximized. Pass `-SkipPlay` while a
live runner owns the final Action start; `-RecordingName` gives a take a stable
OBS filename.

## Connect Codex or ChatGPT desktop

Studio is a local STDIO MCP server. Start the native window first, then add the
server using the values in [`codex-mcp.example.toml`](./codex-mcp.example.toml),
or add it in ChatGPT desktop under **Settings → MCP servers → Add server**:

- command: `node`
- arguments: `<absolute-repository-path>\src\mcp\server.mjs`
- working directory: `<absolute-repository-path>`

Codex, the ChatGPT desktop app, and the IDE extension share local MCP
configuration on a Codex host. Studio supplies server-level LLM instructions
as well as strict schemas for all nine tools. See the
[official MCP configuration guide](https://learn.chatgpt.com/docs/extend/mcp).

The adapter discovers the per-user marker automatically and reconnects when a
new native window appears. The marker remains a backward-compatible ownership
and discovery envelope. The authenticated bridge ping and status publish each
tool contract with a deterministic hash, allowing refresh-aware adapters to
rediscover all nine schemas without restarting. A contract-aware adapter that
cannot refresh a mismatched contract returns `tool_contract_mismatch` instead
of exposing stale validation; restart or reconnect that client to update it.

## Working first slice

The current native loop is functional, not a static design mock:

- canonical project/scene/entity/resource documents with strict stable IDs;
- atomic multi-operation changes, dry-run, optimistic revisions, idempotency,
  recovery, named split-file saves, guarded delete, and monotonic undo/redo;
- guarded exact-ID bulk patch/transform, world-preserving transform groups,
  and independent nested many-to-many organizational collections;
- authenticated one-MiB NDJSON bridge over a random local named pipe;
- official MCP v2 STDIO adapter with nine bounded model-facing tools and an
  explicit native/adapter contract handshake;
- typed shader, texture, and blueprint graph catalogs and validation;
- Blender 4.5/5.2 RNA-shaped shader nodes with per-socket values and links,
  Principled-to-Material-Output flow, live TSL/WebGPU compilation, an official
  115-node Add-menu inventory plus all 100 direct ShaderNode API subclasses,
  and explicit unsupported-node failures;
- 36 live Blender RNA nodes, including Noise, Voronoi, Wave, Checker, all
  Gradient modes, White Noise, Magic, Brick, Color Ramp, Mix/Map Range, Bump,
  Principled, Material Output, and numeric Reroute;
- Blender-style node positions, dimensions, labels, collapsed state, frame
  parenting, frame-cycle checks, and stable socket-name/RNA aliases;
- deterministic bounded CPU albedo/roughness/normal/height texture baking;
- agent-safe ordinary `.mjs` behaviour validation and atomic source storage,
  not yet exposed as live MCP mutations;
- procedural primitive/lathe/tube/shape/extrude geometry and PBR/physical
  material compilation into a persistent native WebGPU scene with shadows;
- canonical polygon/corner meshes with exact topology guards, layered UV/color
  attributes, material slots, sharp edges, creases, smoothing, inset, extrusion,
  subdivision, bevel, deletion, merge, and polygon-native inspection;
- direct create/delete/rename/activate/project/transform edits for per-corner
  UV layers, direct color and face-material edits, and sharp/crease edge edits;
  only the active UV layer lowers to raster UV channel 0 and only the active
  color layer lowers to the viewport, while edge creases are canonical
  storage/editing data and do not yet affect subdivision;
- bounded 1–4-channel inline byte/base64 `dataTexture` resources, expanded to
  shared RGBA8 GPU textures with explicit colour space, wrapping, filtering,
  anisotropy, mipmap and flip controls, reference-safe material map binding,
  and exact disposal; defaults are trilinear mipmapped filtering with
  anisotropy 4, and each complete mip chain stays below 1,398,100 GPU bytes;
  aggregate recipes stay below 8 MiB serialized and 16 MiB decoded; the
  independent 512 × 512 dimension cap does not relax the 700,000 decoded-byte
  base64 cap imposed beneath the one-MiB MCP request, so full-resolution
  three/four-channel payloads need a future chunk/blob path;
- sRGB and pre-linearized color maps both bind to color-role material slots and
  `texture.sample2d` when its declaration exactly matches the resource, while
  numeric/data maps require no colour space; a direct material map is
  rejected when its material graph outputs the same property or a `surface`
  value that supersedes that slot, so the texture must be sampled inside it with
  `texture.sample2d`; graph `image` asset nodes remain CPU-bake-only;
- generic format-v1 texture placeholders remain loadable, indexable, patchable,
  and deletable but cannot shade until upgraded to canonical `dataTexture`;
- `three_studio_status.capabilities.imageTextures.materialControls` publishes
  the accepted scalar and vec2 ranges, `vertexColors` and color-control names,
  plus the exact neutral multiplier chosen for every mapped slot. Map-aware
  defaults keep texture data visible instead of multiplying it by a legacy
  zero: this includes white base/emissive/sheen/specular colors, sheen and
  specular intensity 1, unit normal scales, and displacement scale 1/bias 0;
- exact modifier-stack inspection/editing, nine bounded live geometry modifiers,
  explicit bake boundaries for the remaining Blender modifier inventory, and
  multi-material runtime groups;
- ordered Array/Mirror modifiers, aim/copy/limit constraints, and typed
  Action/keyframe playback with exact render-frame scrubbing;
- deliberate GPU evidence capture to PNG; and
- an animation-only Author/Play boundary ready for a future behaviour runtime.

Native acceptance has exercised live create → inspect → visual swap → undo →
GPU capture → named save → close → reopen without touching the window.

Still intentionally deferred: script execution/hot reload, blueprint
execution, external image-file import/decoding and file-producing import/export
jobs, diagnostic passes beyond beauty/object-id, incremental resource recompilation, and RTX
per-entity inclusion/material-hit controls.
These are the next pipelines in `DESIGN.md`; the nine-tool contract already
reserves them without pretending they work today.

## License

ThreeBrowser Studio is released under the [MIT License](./LICENSE).
Compatibility references and dependency acknowledgements are recorded in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) before proposing a change. Report
security vulnerabilities privately as described in [`SECURITY.md`](./SECURITY.md).
