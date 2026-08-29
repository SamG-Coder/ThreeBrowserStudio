# ThreeBrowser Studio agent rules

These rules are written for the model operating the Studio MCP tools.

## Current capability boundary

Treat `three_studio_status.capabilities` and the live tool schemas as the
authority. In the current lean slice:

- inspect supports scene summaries and delete-guard hashes,
  ID/name/kind/tag/collection selection, exact entity-set guards, collection
  membership/subtree guards, tree, transforms, components, compiled bounds,
  incoming references, bounded resource topology/component digests, exact
  hash-guarded mesh elements with optional bbox/y/boundary/adjacency filters,
  graph structure plus authored-versus-default sockets, RTX collection
  diagnostics, resource-usage checks, changes, graph catalog, Play counters,
  latest evidence metadata, beauty pixel digest/probes/diff, camera
  projection visibility, and group modifier-stack resolution;
- apply supports the declared scene/entity/resource operations, exact guarded
  bulk patch/transform, world-preserving transform groups, independent nested
  organizational collections, persistent `camera.frame`, bounded
  `layout.pattern`, indexed-triangle and topology-guarded editable-polygon
  `geometry.edit` with direct per-corner UV/color, face-material, sharp-edge,
  and crease edits, bounded inline raster texture resources, and canonical
  `scene.rtx.patch`;
- validation is whole-project, interactive document/reference/hierarchy/graph
  validation with budgets;
- rendering is WebGPU beauty capture through the same effective camera and
  presentation aspect as the live viewport, plus an optional `objectId` pass
  for probe entity IDs and projection occlusion; native ray-query lighting
  augments beauty only while the explicit RTX status is active;
- Play changes and reports transient counters/input state but executes no game
  behaviour; and
- jobs, asset import, script authoring/execution, layout modes beyond the live
  linear/grid/radial/seeded-scatter patterns, diagnostic passes beyond beauty
  and object-id, export, and behavior simulation are not available.

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
- Inspect the complete intended set and carry its `selectionHash` into
  `entity.patchMany`, `entity.transformMany`, or `entity.group`; never bulk
  mutate a stale or partially paged selection.
- Use group entities only for transform parenting. Use collections for
  independent many-to-many organization; collection membership never changes
  transforms and collection deletion never deletes member entities.
- `entity.group` and `entity.ungroup` preserve world transforms when the result
  can be represented by canonical TRS. If non-uniform scale would introduce
  shear, restructure or bake deliberately instead of forcing a drifting
  approximation.
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
- Use sRGB for encoded display colour such as albedo and emissive; direct
  color-role material bindings and `texture.sample2d` also accept `linear` when
  the authored bytes are already linear. The sampler declaration must exactly
  match its resource. Do not tag the same color values both ways interchangeably.
- Use no colour space for normals, roughness, metalness, height, masks, and
  numeric data.
- Inline raster resources use a strict `dataTexture` recipe: 1–512 pixels per
  axis, 1–4 byte channels, and exactly one numeric-byte or canonical padded
  base64 source. Numeric arrays stop at 65,536 bytes; decoded base64 stops at
  700,000 bytes; aggregate recipe JSON stops at 8 MiB and aggregate decoded
  sources stop at 16 MiB. A complete expanded RGBA8 mip chain stops at
  1,398,100 GPU bytes.
- Sampler defaults are trilinear `linearMipmapLinear`, generated mipmaps,
  linear magnification, clamp wrapping, and anisotropy 4. Canonical normalized
  recipes contain all sampler fields, including anisotropy (bounded 1–16).
- Raster material maps require an active UV layer on their geometry. Only the
  active UV layer lowers to raster channel 0 and only the active color layer
  lowers to the current viewport; other layers remain canonical and directly
  editable.
- Edge creases can be stored and edited, but the current viewport subdivision
  path does not consume crease weights. Do not claim a visible crease effect.
- Reject a direct material map when the assigned material graph outputs the
  same property or a `surface` value that supersedes that slot; sample that
  texture inside the graph with `texture.sample2d` instead. The graph `image`
  asset node is CPU-bake-only and cannot compile into a live WebGPU material.
- Preserve generic format-v1 texture placeholders. They remain indexable and
  deletable but cannot be used by raster maps or `texture.sample2d` until
  patched into a canonical `dataTexture` recipe.
- Read `three_studio_status.capabilities.imageTextures.materialControls`
  instead of guessing mapped-material controls. Its `scalarRanges` exposes
  exact finite bounds: unit intervals for the declared PBR weights and
  `aoMapIntensity`; thickness/emissive intensity 0–1,000,000; IOR 1–3;
  bump scale -1,000–1,000; and displacement scale/bias
  -100,000–100,000. `vector2Ranges` bounds both components of `normalScale`
  and `clearcoatNormalScale` to -100–100. It also names the `vertexColors`
  boolean and the accepted base/color, emissive, sheen, and specular color
  controls.
- Respect the exact `mapAwareNeutralDefaults` from that status contract when a
  multiplier is unauthored. They use white for mapped base, emissive, sheen,
  and specular colors; 1 for applicable roughness/metalness, opacity,
  emissive intensity, AO/bump/displacement scale, clearcoat,
  transmission/thickness, sheen and sheen roughness, specular intensity,
  anisotropy, and iridescence; `[1, 1]`
  for normal scales; and 0 for displacement bias. Explicit authored controls
  still win.
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
- Procedural texture CPU baking and bounded inline `dataTexture` binding are
  deterministic. External image-file decoding/import and file-producing bake
  jobs remain unavailable through MCP.
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
- Inline raster maps affect WebGPU material shading only. RTX hit shading does
  not sample them, so never attribute albedo, normal, roughness, AO, height, or
  alpha texture detail to a ray hit.
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
- Use `meshElements` for exact vertices, unique edges, authored triangular or
  polygon faces, per-corner layers, material slots, annotations, and adjacency;
  continue only with its resource/topology/filter-bound cursor. Use
  `meshFilter` (bbox, y-range, boundary, `notAdjacentTo`) instead of paging
  an entire cloth or shell. Use   `graphDigest` before graph edits and read `sockets` (`source`, `compiled`,
  `live`) rather than compact `inputs.$summary`; patch one socket with
  `resource.patch` `nodeInputs` instead of replacing the graph. Dry-run apply
  returns `pixelForecast` (`will-move` / `will-not-move` / `unknown`) from the
  same live-socket contract; catalog-only sockets and bump
  `strength * distance` below 1/255 forecast `will-not-move`. Use
  `projectVisibility` before editing an object that may be off-screen; render
  `passes: ["beauty", "objectId"]` when probes or occlusion need entity IDs.
  Use `beautyDigest` after a render for hash, clip/black/luma, exact probes
  (with `entityId` when object-id evidence exists), and capture diffs. Do not
  treat an unchanged PNG as proof the document failed to patch. Principled
  sheen, specular IOR/tint, anisotropy, and thin-film/iridescence compile when
  live. Use `rtxDigest` when geometry is unexpectedly missing from native
  lighting. `modifierDigest` accepts a group and returns descendant mesh
  stacks. Editable-mesh `recalculateNormals` is accepted (normals are derived
  at compile) and forecasts `will-not-move` when it is the only edit.
  Seam-safe live modifiers on editableMesh are triangulate,
  smooth, weightedNormal, displace, and edgeSplit.
- For whole-mesh transforms or smoothing, use `selection: "all"`; keep explicit
  vertex-index lists for genuinely local edits.
- Treat realism as the combination of silhouette, bevel/profile detail,
  coherent material response, scale cues, camera, and lighting. Polygon count
  alone is not evidence of realism.
- Use graph parameters or material instances for shader variants.
- Avoid per-object lights when an emissive material or shared light suffices.
- Keep interactive texture graphs at or below 2048 unless a bake job is
  explicitly justified.
- Keep inline `dataTexture` recipes at or below 512 × 512 and prefer base64
  after 65,536 source bytes; the 512 × 512 dimension cap is independent of the
  700,000 decoded-base64-byte cap. Full-resolution three- or four-channel
  payloads therefore need a future chunk/blob path. All live source channel
  counts upload as bounded RGBA8.
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
