# ThreeBrowser Studio documentation

MCP is the editor. The native WebGPU window is the shared live viewport. That
split is the product: you watch the scene; the model authors through nine
`three_studio_*` tools.

Start here by role.

## For people using Studio

1. [Install and first launch](./users/getting-started.md)
2. [Connect Cursor, Grok Build, or Codex](./users/connect-mcp.md)
3. [Viewport, camera, and the MCP log](./users/viewport.md)
4. [Projects, saves, and where files live](./users/projects.md)

## For models using Studio

1. [How an AI should work in Studio](./ai/README.md)
2. [MCP patterns](./ai/patterns.md) — categories for status, inspect, apply,
   graphs, cameras, Play, history, and the mistakes that waste a session

Operating rules that stay authoritative:

- [`AGENT_RULES.md`](../AGENT_RULES.md) — capability boundary and hard rules
- [`skills/threebrowser-studio-mcp/SKILL.md`](../skills/threebrowser-studio-mcp/SKILL.md) — authoring skill

If a guide and a live `three_studio_status` result disagree, **status wins**.
Do not infer a capability from this documentation or from an earlier session.

## What this is not

- `DESIGN.md` is the architectural contract for contributors, not a user
  manual.
- `AGENTS.md` is for people changing this repository.
- Tutorial modules under `src/tutorials` are reference translations. They are
  not an authoring API and they are not in the Windows zip.
