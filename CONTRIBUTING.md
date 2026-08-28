# Contributing

ThreeBrowser Studio is public source but is not currently open source. Public
visibility does not grant a license to copy, modify, or redistribute the code.
Discuss licensing with the maintainer before preparing a contribution.

If a contribution has been invited:

1. Read `AGENTS.md`, `AGENT_RULES.md`, and the relevant architecture section in
   `DESIGN.md` before editing.
2. Use Node 24 and install the locked dependency graph with `npm ci`.
3. Keep projects, generated evidence, local runtime configuration, and session
   credentials out of commits.
4. Run `npm test` before submitting a change.
5. For native viewport work, exercise create → inspect → visual swap → undo →
   GPU capture → named save → close → reopen against ThreeBrowser Runtime and
   report the observed result.

Keep changes bounded and preserve the LLM-first contract: model-facing actions
must be typed, inspectable, validated before mutation, and safe to retry.
