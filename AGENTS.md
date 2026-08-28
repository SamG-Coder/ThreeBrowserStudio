# ThreeBrowser Studio contributor rules

ThreeBrowser Studio is an LLM-first authoring runtime. MCP is the editor and
the native WebGPU window is the shared live viewport. Preserve that product
shape: do not grow a conventional inspector-heavy browser UI.

- Keep this repository standalone and lean. Never copy ThreeBrowser Runtime,
  Three.js, GTA, Secret River, or sample-game source/assets into it.
- Resolve and launch the external ThreeBrowser Runtime through
  `scripts/runtime-path.mjs`; machine-local paths do not belong in projects.
- The project-owned typed document is canonical. Three.js objects, UUIDs,
  generated JavaScript, node-material JSON, and RTX registrations are compiled
  runtime products only.
- Every authored mutation goes through the core kernel with exact stable IDs,
  one revision, idempotency, validation, inverse history, and recovery.
- Keep the nine MCP tools coarse and stable. Add typed operations or catalog
  entries before adding more top-level tools.
- No raw eval, WGSL, GLSL, TSL, or unrestricted code through ordinary MCP
  mutations. User-authorized trusted project code remains a separate path.
- Compile candidates before committing and swap visible results only after
  validation. Keep explicit GPU capture off the ordinary render loop.
- Add dependencies only when the platform or a small local module cannot do
  the job. Do not add an app framework or bundle Three.js.
- Run `npm test` after changes. For native rendering changes, also run
  `npm run launch`, exercise the live bridge, capture the exact window or GPU
  frame, and inspect the image before claiming completion.

`AGENT_RULES.md` contains the operating rules sent to models using Studio.
`DESIGN.md` is the architectural contract and phased roadmap.
