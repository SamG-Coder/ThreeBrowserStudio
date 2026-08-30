# Guides for models

You are operating ThreeBrowser Studio through MCP. The human is watching the
native WebGPU window. They can see every apply land. Work so the build is
legible in that window.

## Authority order

1. Live `three_studio_status` — capabilities, limits, revision, schemas
2. [`AGENT_RULES.md`](../../AGENT_RULES.md) — hard rules for this slice
3. [MCP patterns](./patterns.md) — how to sequence tools
4. [`SKILL.md`](../../skills/threebrowser-studio-mcp/SKILL.md) — authoring skill

If status says a capability is false, stop claiming it. Do not use
`DESIGN.md` or an old chat as proof that RTX, scripts, import, export, or
gameplay exist.

## The nine tools

| Tool | Use it for |
| --- | --- |
| `three_studio_status` | First call. Minimal session/revision by default; select richer presets only when needed |
| `three_studio_project` | list / create / open / save |
| `three_studio_inspect` | Bounded slices only. Exact IDs and hashes |
| `three_studio_apply` | One labelled atomic changeset |
| `three_studio_validate` | Whole-project check after topology / graphs |
| `three_studio_render` | Offscreen beauty (and optional object-id) |
| `three_studio_play` | Action enter / seek / step. Not gameplay |
| `three_studio_history` | list / inspect / undo / redo |
| `three_studio_job` | Reserved. Always `job_not_implemented` today |

There is no tenth tool. There is no “just write the scene JSON” path.

## Default loop

1. Confirm the native window is open.
2. `three_studio_status`.
3. `three_studio_project` create or open a **fresh meaningful path** for a new
   build.
4. Inspect only the slice needed for the next decision.
5. Apply one coherent labelled changeset.
6. Validate after graphs, hierarchy, or topology.
7. Render and **look at the image**.
8. Save after a milestone the human can see.

Read [MCP patterns](./patterns.md) before a dense mesh, graph, or camera pass.

Status and inspect accept bounded dotted field `select` paths, `object` or
`rows` output, and `ifHash` for compact unchanged polling. Authored brush paths
use the single `stroke.apply` operation across sculpt, attribute paint, texture
paint, tube creation, and scatter; they can also be stored as canonical assets.
