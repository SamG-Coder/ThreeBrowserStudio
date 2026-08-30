# MCP patterns

Categories for models. Each pattern is a way of using the nine tools that
survives contact with the live viewport. If status or `AGENT_RULES.md`
disagrees with a line here, status and the rules win.

Units are **metres, radians, and seconds**.

---

## 1. Establish authority

**When:** first message, reconnect, lost context, or after `tool_contract_mismatch`.

1. The native window must already be open. MCP discovers it through the
   per-user session marker. Do not start authoring against a dead host.
2. Call `three_studio_status` before anything else.
3. Treat `capabilities`, limits, `revision`, project id, `viewport.viewMode`,
   and the live tool schemas as the only truth for this process.
4. If a capability is false or missing, say so and build the best honest
   supported result. Never claim RTX, scripting, physics, export, file import,
   or gameplay unless status exposes it **and** the current schema has the
   operation.
5. If the adapter still reports `tool_contract_mismatch` after a refresh,
   stop and ask the human to reconnect. The window predates this adapter.

Do not infer support from an earlier Studio session, a tutorial module, or
`DESIGN.md`.

---

## 2. Project first, then inspect

**When:** starting a build or switching work.

- For a live demonstration, `three_studio_project` **create** a new path with
  a meaningful name. Opening a leftover project hides the build.
- Then inspect the active scene, revision, and only the catalog or resources
  needed for the **next** decision.
- Inspect is paginated and hashed. Do not request the whole mesh, whole graph
  sockets as raw dumps, or unbounded arrays.
- Explicitly use `preset: "summary"` plus dotted `select` fields for the next decision.
  Use `format: "rows"` for collections and `ifHash` to avoid receiving an
  unchanged payload again.
- Use `sceneDigest` for the tree. Use `resourceDigest` for counts, hashes, and
  references. Loft geometries always return `loft.sections` identities (`id`,
  `index`, `pointCount`, `transform`, `localBounds`); request
  `include: ["components"]` for control points. Never guess loft section IDs.
  A missing `geometry.loft.edit` section includes `error.data.sectionIds`.
  Use `meshElements` with a `meshFilter` (bbox, y-range, boundary,
  `notAdjacentTo`) instead of paging a cloth. Use `meshSelection` when an edit
  needs all matching indices at once; it supports bounds, radius, boundary,
  manifold, sharp/crease, material, and face-normal criteria and returns an
  exact `selectionHash`. Feed that hash to `geometry.selection.edit` so a
  spatial or material selection cannot silently drift before mutation. Use `operationCatalog` to find
  the exact typed mutation name, `geometryCatalog` to inspect supported recipes,
  defaults, and budgets, `lookCatalog` for material-look defaults and raster
  notes before `material.look.create`, `lightingDigest` for rig and light
  intensities, and `graphCatalog` before graph authoring. Use
  `graphDigest` and read `sockets` (`source`, `compiled`,
  `live`), not `inputs.$summary`.
- Recolor or retune a semantic look with `material.look.patch` on the same
  material id. `material.look.create` stays create-only. Optional look
  scalars (`roughness`, `opacity`, `transmission`, and the rest of the look
  schema) override the recipe. Read `lookCatalog` first: default glass
  transmission is 1, and `emissiveLens` defaults to amber `#ff3b08`. Raster
  glass is `look: "glass"` with `transmission: 0` and an opacity below 1.
  `camera.frame` may target entities created earlier in the same apply; it
  uses authored recipe bounds when the compiled revision does not yet contain
  them. `view.distanceScale` scales camera distance and does not multiply
  `padding` below 1.
- Carry `selectionHash`, membership hashes, and modifier `stackHash` into the
  apply that needs them. Never bulk-mutate a stale or half-paged selection.

Exact stable IDs from inspect are the only IDs you may write. Never mutate by
fuzzy name or tag.

For timed authoring runs, read `status.authoringTelemetry`. Retained counters
describe the bounded HUD window; `cumulative` survives HUD pruning and reports
tool totals, authored and lowered operation counts, compile/capture counts,
PNG bytes, and elapsed time. Apply responses also expose redacted operation
families and lowering/kernel/compile/preview timings without IDs or payloads.

---

## 3. One labelled apply

**When:** every mutation.

One apply is one coherent intent: “ground plane and key light”, not “the
entire still life”. The human is watching the window. A 40-operation dump
looks like a teleport.

Every apply needs:

- latest `baseRevision`
- a **new** `idempotencyKey` (do not reuse after a timeout)
- one human-readable `label`
- exact IDs (or aliases created in **this** same changeset)

Aliases exist so you can create a mesh and assign it in one transaction. They
are not a second ID namespace across applies.

On success, read diagnostics, invalidation scopes, the new revision, and
`pixelForecast`. Resolve errors before adding detail.

For a costly batch, dry-run once and retain the returned `candidateToken`.
Submit the identical operation batch at the same `baseRevision` with that token
to promote the already compiled candidate. Tokens are content guarded, keep
only one candidate alive, and fail closed after another dry run or project
switch. Use `resource.createMany` when provisioning several independent typed
resources so one semantic operation and compact inverse replace many core ops.

Procedural geometry is intentionally concise during block-out. Before detailed
vertex, UV, paint, or topology work, call `geometry.realize` with the inspected
`resourceHash`; it atomically replaces the recipe with canonical editable
triangle topology. Loft recipes may use named section descriptors, per-section
TRS, `profileResolution` resampling, interpolated `subdivisions`, closest-ring
alignment, and generated side UVs.

Static `smooth`, `simpleDeform`, and `displace` modifiers on editable meshes run
before UV seams are split into render vertices, so one authored vertex cannot
crack into independently smoothed triangle copies.

Compile-heavy tools (`apply`, `render`, `project`, `history`) have a 120s
budget. Status and inspect stay at 15s. If apply times out, it aborted
**before** commit. Re-inspect revision. Do **not** retry the same
idempotency key.

On revision conflict, inspect `changedSinceRevision` before retrying.

---

## 4. Visible stages

**When:** any build the human should follow.

Work in stages the window can show: block-in, primary forms, secondary forms,
materials, graphs, lights, dressing, animation, final camera. The subject
picks the stages; do not invent a ritual.

For each stage:

1. Inspect the slice you need.
2. Apply a few related objects or one resource family.
3. Validate if graphs or topology changed.
4. Render beauty and **look at the image**.
5. Say what you actually saw, then choose the next stage.

Do not add `sleep` calls. Real model and MCP time is the timing.

Do not translate a finished JavaScript scene, a tutorial module, or
`studio-call` helper output into one MCP batch. That hides the build and
usually violates IDs, hashes, and catalogs.

The HUD log compact line `Apply 30 operations` is a count. Expanded details
name **whitelisted** op types only. Neither is visual proof.

---

## 5. Dry-run and pixel forecast

**When:** deletes, graph resources, large batches, unclear sockets.

Dry-run destructive, large, graph-resource, or high-budget work first.

Every apply (dry-run and commit) returns `pixelForecast`:

| Forecast | Meaning |
| --- | --- |
| `will-move` | Beauty pixels should change |
| `will-not-move` | Document may patch; 8-bit beauty likely will not |
| `unknown` | Do not guess |

Catalog-only sockets and bump `strength * distance` below `1/255` forecast
`will-not-move` even when the patch succeeds. Trust that over a later
identical PNG. Raise bump **distance** (metres of height), not only strength.

`recalculateNormals` on editable mesh is accepted (normals are derived at
compile) and forecasts `will-not-move` when it is the only edit.

Inspect a subtree and its expected hash before recursive delete. Never delete
a referenced resource without reassigning or removing references in the **same**
transaction.

---

## 6. IDs, groups, and collections

**When:** placing, parenting, or organising.

- IDs are semantic and stable: `market/stall-03`, not runtime UUIDs.
- **Groups** own transforms. `entity.group` / `entity.ungroup` preserve world
  TRS when they can. Non-uniform scale that would shear must be restructured
  or baked on purpose.
- **Collections** are many-to-many folders. Membership never changes
  transforms. Deleting a collection never deletes members.
- Prefer `layout.pattern` (linear, grid, radial, seeded scatter) when status
  says it is implemented. Use explicit transforms for everything else.
- Prefer `stroke.apply` for authored paths: sculpt a local/world/surface path,
  paint a color layer or UV data texture, turn the path into a tube, or scatter
  an existing mesh along it. A single point can stamp; multiple points form a
  pressure/radius/opacity-varying stroke. Persist commonly reused paths with
  `storeAsAssetId`.
- Keep transforms finite and scales non-zero.
- Inspect compiled bounds before placing dependents.
- Use `projectVisibility` before editing something that may be off-screen
  (`visible` / `occluded` / `background`).

---

## 7. Graphs and materials

**When:** shaders, texture graphs, Principled, mapped PBR.

1. `inspect` `query: "graphCatalog"` for the domain (`shader` or `texture`)
   before every graph pass. The catalog, `authoring.canonicalEnvelope`, and
   `authoring.edgePortShape` are the names you may use.
2. Create graphs as `resource.create` / `resourceType: "graphs"` with the
   graph nested under `resource.graph`. Keep envelope `id`, `name`, `kind`,
   `metadata`.
3. Socket values go in `node.inputs`. Node configuration goes in `params`.
   Edges are `{ from: { nodeId, port }, to: { nodeId, port } }` using catalog
   port names.
4. `three_studio_validate` immediately after every graph create or patch,
   **before** assigning the graph to a material.
5. Patch one socket with `resource.patch` `nodeInputs`. Do not replace a
   whole graph to change one value.

Live vs catalog: `graphDigest.sockets.live === false` means the catalog
accepted the value but TSL does not bind it. Principled sheen, specular
IOR/tint, anisotropy, and iridescence compile only when live (weight or
connection). Catalog-only Principled sockets will not move beauty.

sRGB is for display colour (albedo, emissive). No colour space for normals,
roughness, metalness, height, masks. Query
`status.capabilities.imageTextures.materialControls` for map ranges and
neutral defaults. Raster maps need an active UV layer. The graph `image`
asset node is CPU-bake only; it is not a live WebGPU texture.

No raw WGSL, GLSL, TSL, or `eval` through ordinary apply.

---

## 8. Cameras and evidence

**When:** looking, framing, claiming a visual result.

- `status.viewport.viewMode`: `follow-shot` is the authored camera. `review`
  means the human is flying a session-only camera. Evidence,
  `effectiveCamera`, and `cameraId` stay on the authored shot.
- `camera.frame` persists a shot (bounds + presentation aspect) and snaps the
  window back to Follow shot. Transient render framing is evidence-only.
- After a visually meaningful stage, `three_studio_render` and inspect the
  returned image, not just metadata.
- Follow with `beautyDigest` for hashes, clip/black/luma, and `(x, y)` probes.
- Need entity IDs or occlusion? `passes: ["beauty", "objectId"]`. Probes then
  include `entityId`.
- Current evidence is beauty (plus object-id). Do not request other diagnostic
  passes unless the live render schema lists them.
- `capabilities.rtx` is adapter support, not activation. Claim RTX lighting
  only when returned status is `active`. Inline raster maps do **not** appear
  in RTX hit shading.

Never claim a visual result without a capture from the committed revision.

---

## 9. Play and animation

**When:** keyframes, Actions, timeline.

Create animation resources through apply, validate them, then
`three_studio_play` enter / pause / resume / seek / step. Play evaluates
deterministic Action animation and timeline-driven Ocean geometry even when a
scene has no Actions. Ocean is displacement-only: apply it to a sufficiently
subdivided local-XY surface and keep a moving Ocean last among live geometry
modifiers. Dynamic Ocean geometry renders through raster WebGPU and is excluded
from the static RTX triangle scene; set `timelineScale: 0` only when a static
Ocean result is intended. Keep the sum of `evaluated vertices × waveCount`
within `capabilities.timelineGeometryMaxSamples` across distinct moving oceans.

Typed blueprint controller graphs run when status reports
`controllerRuntime: true`. Author scene-owned `settings.controller` with one
exact controlled entity and attach blueprint graph IDs through that entity's
`components.logic`. Enter (or the configured activation key) begins a
runtime-only session; Escape is globally reserved, clears input, restores the
authored pose/UI/cursor, and returns to Author. Use only the event/action nodes
listed by `capabilities.logicRuntime` and validate after every graph change.

Entities use a Unity-like typed component model. `entity.self` supplies the
controlled entity ID; `component.has` can branch on typed capabilities. Camera
nodes activate, follow, aim, and adjust perspective FOV. `rigidBody` and
`collider` components provide bounded fixed-step box, sphere, one-sided ramp, and static mesh physics, triggers,
and collision enter/exit events. Prefer a root entity for a moving rigid body;
Use `shape: "ramp"`, a positive `size`, and `slopeAxis: "x" | "-x" | "z" | "-z"`
for authored jump faces. Use `shape: "mesh"` on a mesh entity to collide against its compiled triangles as a bounded, one-sided static terrain surface. Dynamic mesh colliders, joints, CCD, soft bodies, cloth, fluids, and simulation caches remain unsupported.
For vehicles and other surface-following bodies, set `rigidBody.alignToSurface: true`; tune `surfaceAlignSpeed` and `maxSurfaceTilt` to smoothly pitch and roll the body toward the live contact normal while preserving authored yaw control.

`behaviorRuntime` remains false: arbitrary scripts do not run. Physics and
uncatalogued blueprint nodes remain unavailable. Do not send script operations
through apply or claim capabilities beyond the live controller contract.

---

## 10. History, validation, and save

**When:** closing a stage or a session.

- Validate after graph, hierarchy, reference, animation, or topology changes,
  and again before you call the work done.
- Undo / redo are **new compensating revisions**. Revision numbers never go
  backwards.
- Save with `three_studio_project` only after validation **and** visual
  review.
- Never edit project JSON, the history journal, recovery files, generated
  assets, or the session marker on disk.
- Never enable trusted-project mode.

Completion means: the project reopens, validation passes, and the last render
supports the claim. A successful tool payload is not completion.

---

## 11. Anti-patterns

These fail in this product even when they work in a Three.js snippet.

| Do not | Do this instead |
| --- | --- |
| Write `projects\...\*.json` yourself | `three_studio_project` + apply |
| Run a tutorial `.mjs` or `studio-call` to “build the scene” | MCP tools only |
| One apply with the whole finished scene | Visible stages |
| Guess Blender node / socket / RNA names | `graphCatalog` |
| Guess operation or geometry recipe fields | `operationCatalog` / `geometryCatalog` |
| Raw WGSL / GLSL / TSL / `eval` | Catalogued graph nodes |
| Reuse an idempotency key after a timeout | Re-inspect, new key |
| Bulk patch without `selectionHash` | Inspect the exact set first |
| Treat Review fly-cam as the render camera | Authored shot + `camera.frame` |
| Treat an unchanged PNG as “apply failed” | Read `pixelForecast` and `sockets.live` |
| Claim gameplay, import, export, or jobs | Status capabilities |
| Put `C:\...` asset paths in the document | Bounded `dataTexture` or wait for import jobs |
| Grow an inspector UI | MCP + the live window |

`three_studio_job` is a reserved ninth slot. It always returns
`job_not_implemented` in this slice.
