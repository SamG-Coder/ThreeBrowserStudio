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

On the GitHub Pages preview only, Settings points at a **Prompt** tab for
connecting chat APIs. The native window does not show that tab.

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
