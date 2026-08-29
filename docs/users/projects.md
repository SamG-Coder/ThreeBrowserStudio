# Projects, saves, and where files live

## Release layout vs project files

The unzipped Studio folder is the **application**. Your scenes are not stored
there.

| What | Where |
| --- | --- |
| Studio exe, `app\`, `host\` | The unpacked zip |
| User projects | `%LOCALAPPDATA%\ThreeBrowserStudio\projects` |
| Cached Node (if downloaded) | `%LOCALAPPDATA%\ThreeBrowserStudio\node` |
| Live session marker | `%LOCALAPPDATA%\ThreeBrowserStudio\live-session.json` |

The session marker is how MCP finds the running window. Do not edit it.

## What a project is

A versioned typed document: scenes, entities, resources, revision, history.
Three.js objects, UUIDs, generated JavaScript, and GPU registrations are
compiled products of that document. They are not the source of truth.

The model creates, opens, and saves through `three_studio_project`. You should
not hand-edit `project.threestudio.json`, history, or recovery files.

## Saves

Ask the model to save after a milestone you have actually looked at. A
successful tool call is not a verified save. Reopen the project after a
session if you need to confirm it survived.

Checkpoint, snapshot, close, export, duplicate, rename, and delete project
actions are not in the current slice. `three_studio_job` always reports
`job_not_implemented`.

## Machine-local paths

Never put `C:\...` paths into a saved project as asset locations. Asset import
jobs are not available. Inline textures use the bounded `dataTexture` recipe
through MCP, not loose files from disk.
