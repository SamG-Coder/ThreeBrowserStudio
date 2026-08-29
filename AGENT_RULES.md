# ThreeBrowser Studio agent rules

These rules are written for the model operating the Studio MCP tools.

## Current capability boundary

Treat `three_studio_status.capabilities` and the live tool schemas as the
authority. In the current lean slice:

- inspect supports scene summaries and delete-guard hashes,
  ID/name/kind/tag selection, tree, transforms, components, compiled bounds,
  incoming references, bounded resource topology/component digests, exact
  hash-guarded mesh elements, graph structure, RTX collection diagnostics,
  resource-usage checks, changes, graph catalog, Play counters, and latest
  evidence metadata;
- apply supports the declared scene/entity/resource operations plus persistent
  `camera.frame`, bounded `layout.pattern`, indexed `geometry.edit`, and
  canonical `scene.rtx.patch`;
- validation is whole-project, interactive document/reference/hierarchy/graph
  validation with budgets;
- rendering is WebGPU beauty capture through the same effective camera and
  presentation aspect as the live viewport; native ray-query lighting augments
  it only while the explicit RTX status is active;
- Play changes and reports transient counters/input state but executes no game
  behaviour; and
- jobs, asset import, script authoring/execution, layout modes beyond the live
  linear/grid/radial/seeded-scatter patterns, diagnostic render passes, export, and behavior
  simulation are not available.

Do not attempt a reserved pipeline because it appears in the design document.
Use it only after both status and the current tool schema expose it.

## Authoring loop

1. Call status after connecting or losing context.
   The adapter refreshes verified native schemas in place. If it still reports
   `tool_contract_mismatch`, stop and reconnect because the running native
   session predates the refresh manifest or uses another protocol.
2. Inspect only the bounded slices needed for the next decision.
3. Use exact stable IDs returned by inspect for every mutation.
4. Group one coherent intent into one labelled atomic apply.
5. Dry-run destructive, large, graph-resource, or high-budget work.
6. Run current whole-project validation after graph or topology changes.
7. Render WebGPU beauty and inspect the actual evidence before claiming visual
   completion.
8. Never claim gameplay completion while `behaviorRuntime` is false; current
   Play only verifies the Author/Play control boundary.
9. Save the project after a verified milestone.

## Scene rules

- World units are metres. Rotation values are radians. Time is seconds.
- Use meaningful stable IDs such as `market/stall-03`, not runtime UUIDs.
- Never write using fuzzy name/tag selectors.
- Prefer `layout.pattern` for bounded linear, grid, radial, and seeded volume
  scatter repetition when status reports it implemented; use explicit
  transforms for other layouts.
- Use deterministic seeds and preserve generator IDs when work may be revised.
- Keep transforms finite and scales non-zero.
- Inspect compiled bounds before dependent placement, and frame captures from
  exact target IDs or explicit bounds.
- Do not recursively delete without inspecting the subtree and providing its
  expected hash.
- Do not delete referenced resources; reassign or remove their references in
  the same transaction.

## Resource rules

- State the intended colour/data role for every texture.
- Use sRGB only for display colour such as albedo and emissive.
- Use no colour space for normals, roughness, metalness, height, masks, and
  numeric data.
- Prefer reusable material, texture, geometry, animation, and blueprint
  resources over near-duplicates.
- Query the graph node catalog rather than inventing node or port names.
- Keep shader, texture, and blueprint graphs acyclic unless the blueprint cycle
  crosses an allowed event, timer, delay, or bounded loop.
- Assign shader graphs only while `graphCompilation` is true. Candidate scene
  compilation must succeed before swap; a catalogued Blender node without a
  live TSL implementation is an explicit error, never a visual approximation.
- Author Blender socket values in `node.inputs` and links in `edges`; keep node
  properties in `params`. Query the Blender inventory and executable graph
  catalog instead of guessing RNA IDs or port names.
- Procedural texture CPU baking is deterministic and bounded, but image asset
  decoding/binding and file-producing bake jobs remain unavailable through MCP.
- Once export/bake jobs exist, bake node materials to PBR maps before
  interchange export.

## JavaScript game-code rules (future behaviour capability)

The repository has an agent-safe parser and atomic script store, but the live
MCP contract cannot create, attach, hot-reload, or execute scripts yet. Do not
send script operations through `apply`. The rules below become active only
after status reports `behaviorRuntime: true` and the tool schema exposes script
operations.

- Default to `agent-safe` behaviours.
- Use the Studio behaviour lifecycle and capability context.
- Make movement and animation frame-rate independent.
- Use `fixedUpdate` for deterministic simulation and `update` for presentation.
- Do not allocate objects, geometry, materials, textures, or closures every
  frame when state can be retained.
- Cache stable entity handles but tolerate them becoming invalid after scene
  edits or stop/reload.
- Unsubscribe events and release owned resources in `stop`.
- Never use `eval`, `new Function`, dynamic import, Node builtins, `process`, or
  global filesystem/network access in agent-safe code.
- Do not enable trusted-project mode; only the user may choose that trust level.
- Once that capability exists, hot-reload, enter Play, inject representative
  input, step, inspect state, and check diagnostics after changing behaviour
  code.

## Rendering rules

- Treat the visible native viewport as shared progress with the user; inspect
  the returned offscreen capture as the actual render evidence.
- Use `camera.frame` when a shot must persist, including its target bounds and
  presentation aspect; transient render framing remains evidence-only.
- Current evidence is beauty-only. Use semantic scene inspection and deliberate
  framing to resolve ambiguity; request diagnostic passes only if the render
  schema later exposes them.
- Keep the authored WebGPU material path active; once graph compilation and RTX
  exist, RTX augments lighting/reflections rather than replacing shaders.
- `capabilities.rtx` means adapter support, not activation. Use
  `scene.rtx.patch` for the master lighting request and independent shadow/AO
  controls; claim RTX evidence only when the returned status is `active`, and
  always distinguish supported, requested, configured, building, active,
  stale, and failed states.
- Never claim a visual result without inspecting a capture from the committed
  revision.

## Transaction and history rules

- Include the latest base revision and a unique idempotency key.
- On revision conflict, inspect changes since the supplied revision before
  retrying.
- Do not split an invariant across transactions when an intermediate scene
  would contain broken references.
- Use aliases for resources/entities created and consumed within one apply.
- Read diagnostics and invalidation scopes from each apply/undo/redo result.
- Undo is a new compensating revision; do not assume revision numbers decrease.
- Never edit the journal, recovery files, generated assets, or session marker
  directly.

## Performance guardrails

- Stay within the limits reported by status; do not hard-code assumed limits.
- Prefer instancing for repeated geometry.
- Build and render one representative high-detail asset before scattering or
  duplicating it. Repetition amplifies silhouette and shading defects.
- Use `resourceDigest` to verify indexed vertex/triangle counts, attributes,
  bounds, and references without requesting raw geometry arrays.
- Use `meshElements` for exact vertices, unique edges, triangular faces, corner
  attributes, and adjacency; continue only with its resource/topology-bound
  cursor. Use `graphDigest` before graph edits and `rtxDigest` when geometry is
  unexpectedly missing from native lighting.
- For whole-mesh transforms or smoothing, use `selection: "all"`; keep explicit
  vertex-index lists for genuinely local edits.
- Treat realism as the combination of silhouette, bevel/profile detail,
  coherent material response, scale cues, camera, and lighting. Polygon count
  alone is not evidence of realism.
- Use graph parameters or material instances for shader variants.
- Avoid per-object lights when an emissive material or shared light suffices.
- Keep interactive texture graphs at or below 2048 unless a bake job is
  explicitly justified.
- Dry-run large explicit batches and inspect the budgets returned by current
  validation. Dense resource arrays remain subject to the one-MiB MCP request
  ceiling even when their per-array schema budget is higher. Generated layouts
  and RTX remain bounded and capability-gated.

## Files and assets

- Use project-relative logical asset IDs, never arbitrary absolute paths in
  scene documents.
- Asset import jobs are unavailable in the current slice; do not place
  arbitrary absolute paths into a project as a workaround.
- Record source, license/provenance, colour role, and importer settings.
- Do not overwrite a user-authored script or asset without inspecting it and
  making the replacement explicit in the transaction label.
- Save only after validation and evidence review.
