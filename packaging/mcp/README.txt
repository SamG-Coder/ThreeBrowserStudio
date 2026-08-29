MCP clients and agent rules

Start ThreeBrowserStudio.exe first. Then point an MCP client at this unpack
folder. Replace EXTRACT with the full path of this folder, for example
C:\Users\you\Downloads\ThreeBrowserStudio-0.2.0-win-x64.

User guides and AI MCP patterns:
  docs\README.md
  docs\users\
  docs\ai\

Agent operating rules (give these to the model):
  AGENT_RULES.md
  docs\ai\patterns.md
  skills\threebrowser-studio-mcp\SKILL.md

Client templates:
  mcp\cursor\mcp.json            Cursor — paste into .cursor\mcp.json and replace EXTRACT
  mcp\cursor\workspace.mcp.json  Cursor — use this if you open this unpack folder as the workspace
  mcp\grok\config.toml           Grok Build — copy into .grok\config.toml and replace EXTRACT
  mcp\codex.toml                 Codex / ChatGPT desktop — replace EXTRACT
  mcp.example.toml               same as mcp\codex.toml (kept at the pack root)

Command is `node`. Arguments point at app\src\mcp\server.mjs. Working
directory is app. If Node is not on PATH, use
%LOCALAPPDATA%\ThreeBrowserStudio\node\node.exe.
