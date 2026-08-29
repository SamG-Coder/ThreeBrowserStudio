# Connect Cursor, Grok Build, or Codex

Studio is a local STDIO MCP server. Start `ThreeBrowserStudio.exe` first, then
add the server to the client.

## Shared values

| Field | Value |
| --- | --- |
| Command | `node` (or `%LOCALAPPDATA%\ThreeBrowserStudio\node\node.exe`) |
| Arguments | `EXTRACT\app\src\mcp\server.mjs` |
| Working directory | `EXTRACT\app` |

Replace `EXTRACT` with the unpacked release folder, for example
`C:\Users\you\Downloads\ThreeBrowserStudio-0.2.0-win-x64`.

Templates ship in the zip:

| Client | Template |
| --- | --- |
| Cursor | `mcp\cursor\mcp.json` |
| Cursor, this folder as workspace | `mcp\cursor\workspace.mcp.json` |
| Grok Build | `mcp\grok\config.toml` |
| Codex / ChatGPT desktop | `mcp\codex.toml` |
| Same Codex template at pack root | `mcp.example.toml` |

## Cursor

Copy `mcp\cursor\mcp.json` into the project's `.cursor\mcp.json` and replace
`EXTRACT`. If you open the unpack folder itself as the Cursor workspace, use
`mcp\cursor\workspace.mcp.json` instead (`${workspaceFolder}` already points
at `app\src\mcp\server.mjs`).

Give the model [`AGENT_RULES.md`](../../AGENT_RULES.md) and
[`docs/ai/patterns.md`](../ai/patterns.md). The Codex-shaped skill is
[`skills/threebrowser-studio-mcp/SKILL.md`](../../skills/threebrowser-studio-mcp/SKILL.md).

## Grok Build

Copy `mcp\grok\config.toml` into `.grok\config.toml` and replace `EXTRACT`.
Keep `enabled = true`. Grok Build uses a 120s tool timeout in that template
because apply / render / save can compile.

## Codex / ChatGPT desktop

Use `mcp\codex.toml` or add a server under **Settings → MCP servers**:

- command: `node`
- arguments: `EXTRACT\app\src\mcp\server.mjs`
- working directory: `EXTRACT\app`

Copy `skills\threebrowser-studio-mcp\SKILL.md` into the Codex skills location
the client expects, or attach it in the conversation. Codex, ChatGPT desktop,
and the IDE extension share local MCP configuration on a Codex host.

## Give the model the right docs

The MCP adapter already sends a short server instruction block. That is not
enough for a good build. Also provide:

1. `AGENT_RULES.md` — hard capability and safety rules
2. `docs/ai/README.md` and `docs/ai/patterns.md` — how to work
3. `skills/threebrowser-studio-mcp/SKILL.md` — the authoring skill

Do not point a model at `DESIGN.md` or `src/tutorials` as an authoring path.

## After it connects

The first tool call must be `three_studio_status`. If the client reports
`tool_contract_mismatch`, reconnect: the native window is older than the
adapter or the protocol changed.
