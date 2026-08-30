# Viewport, camera, and the MCP log

The native window is shared progress. You watch the scene while the model
authors through MCP. The side panel is 2D chrome, not an inspector.

Hide or show the panel with **Ctrl+Shift+M**.

## Camera: Follow shot vs Review

| Mode | Who owns it | What it writes |
| --- | --- | --- |
| Follow shot | The authored / AI camera | The project document |
| Review | You, look / fly | Nothing. Session-only |

Follow shot is the default. The first drag on the view enters Review. WASD
moves, Space goes up, Ctrl goes down. Evidence captures, `effectiveCamera`,
and `cameraId` stay on the authored shot even while you fly around.

`camera.frame` and `scene.setActiveCamera` snap the window back to Follow
shot. Do not treat the Review pose as the camera the model is rendering.

Switch modes from the header button or Settings.

## RTX and DLSS 5 settings

The Settings page scrolls. Its RTX section controls the canonical project
settings for native ray lighting, shadows, ambient occlusion, samples,
strengths, radius, maximum distance, and ray bias. A slider commits once when
you release it; each accepted change is an ordinary undoable project revision.

DLSS 5 Neural Rendering has its own enable switch and status. It remains
disabled when the active Runtime build, NVIDIA GPU, or signed plug-in API does
not report complete availability. Its Advanced style selector contains only
styles **0**, **1**, and **2**. The same-resolution Studio path uses DLAA.
Advanced also includes intensity, local and global tone, local and skin
structure, and automatic-mask controls; all remain disabled until the complete
capability gate passes.
If native evaluation fails, Studio keeps the authored raster/RTX frame instead
of presenting the neural output.

## Import / Export

Settings has **Export JSON** and **Import JSON** for a portable pack of the
canonical project (`ThreeStudioProjectPack`). History, recovery, session
markers, and Prompt keys stay out of the file.

On the desktop host, Export and Import open a Windows file dialog. Import
then writes a new folder under `projects/imports/` and opens it. It does
not overwrite the project that was already open. The native window has no
browser download bar or `<input type="file">` chrome.

On GitHub Pages, Export uses the browser download prompt and Import uses
the browser file picker. Import compiles the document in this tab only —
it does not create files on disk.

Trusted-project scripts are forced to `agent-safe` on both hosts. Raw
`ThreeStudioProject` JSON is accepted as well as a pack.

The wait-for-kernel bootstrap stage (floor, plinth, ring) is **not** a project
object. The desktop host disposes it as soon as a project compiles. The
browser host never mounts it: it compiles the same starter project a new
desktop project uses, so Explorer and Export match the viewport.

On the GitHub Pages preview only, a **Prompt** dock sits at the bottom of the
window for Gemini or an HTTP chat API. The native window does not show it.

## Explorer

A read-only tree of objects, groups, and collections. Collapse a group in the
tree; that does not change the scene. Groups parent transforms. Collections
are folders only — membership never moves objects.

## Log

The Log tab is a redacted MCP command feed. It never shows raw arguments,
results, paths, or tokens. Bridge pings are omitted.

Each row is tool, stage (started / completed / failed), elapsed time, and
revision. Compact mode summarises apply as `Apply 30 operations`.

Turn on **Expanded details** on the Log toolbar (or Settings → Log) to see
**whitelisted** operation types, entity kinds, and resource families, for
example `entity.create mesh ×12 · resource.create materials ×4`. Failed rows
stay redacted; they do not dump stacks.

Use the log to follow what the model is doing. Use MCP inspect and a beauty
render when you need the actual scene state.
