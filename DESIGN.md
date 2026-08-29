# ThreeBrowser Studio

ThreeBrowser Studio is a live Three.js WebGPU authoring runtime built for an
LLM, not a traditional desktop editor. Codex or ChatGPT is the primary editor.
The human-facing application is a persistent viewport where the user can watch
the active project change, play it, and review visual evidence.

The working protocol name is `three-studio/1`.

## Implementation status and normative contract

This document records both the current lean implementation and the phased
product architecture. It is not, by itself, a promise that every described
pipeline is callable. The live MCP input schemas and
`three_studio_status.capabilities` are the normative model-facing contract.

The current slice exposes atomic scene/entity/resource authoring; persistent
exact-aspect camera framing; bounded linear/grid/radial/seeded-scatter instancing; indexed
vertex editing with compact whole-mesh selection, smoothing, welding, and
normal recalculation; canonical native
ray-query lighting/shadow/AO controls with truthful lifecycle state; bounded
scene and resource-topology inspection with delete-guard hashes, compiled/local
bounds, references, and resource-usage checks; whole-project interactive document/graph validation;
offscreen WebGPU beauty capture; list/inspect/undo/redo history; project
list/create/open/save; deterministic Action playback and frame scrubbing; a
queryable Blender compatibility catalog; and a transient Play boundary.
Script operations/execution, blueprint execution, layout generators beyond the
implemented patterns, jobs/import/bake/export, diagnostic render passes, and
behavior simulation remain planned and are absent from the current schemas.

## Product decision

The source of truth is a versioned, project-owned authoring document. It is not
generated JavaScript, a live `THREE.Scene`, or `Object3D.toJSON()` output.
Three.js objects, TSL nodes, animation mixers, GPU resources, and native RTX
registrations are compiled runtime products of that document.

The persistent native window shows the latest committed revision. It never
relaunches for an ordinary edit. Today a model can create a scene, change its
light, and capture the result while the user watches the same window. Attaching
and executing game code is a later capability.

This is deliberately not a Blender panel clone:

- no permanent hierarchy, inspector, graph editor, asset browser, or timeline;
- no in-window chat transcript;
- no requirement to target screen coordinates to author content;
- no arbitrary JavaScript injection as the mutation protocol; and
- no hidden state that exists only in widgets.

The target keeps hierarchy, properties, graphs, animation, code, diagnostics,
and history in precise documents. The current MCP slice exposes only the
subsets listed above. The viewport is currently a review surface plus a
deterministic animation Play control boundary.

## What the model needs

The design optimizes this loop:

1. Inspect a compact, bounded summary of the current project and scene.
2. Apply one named, atomic changeset using stable semantic IDs.
3. See the committed change in the persistent native viewport.
4. Validate the affected resources and runtime budgets.
5. Run or step the game and inspect state or diagnostics.
6. Render visual evidence from a deliberate camera and pass.
7. Refine, undo, or save a durable project revision.

The model therefore needs:

- stable IDs independent of Three.js UUIDs;
- metres, radians, seconds, linear values, and colour spaces made explicit;
- semantic queries rather than fuzzy write selectors;
- high-level layout operations for arrays, grids, scatter, alignment, curves,
  grounding, and framing;
- typed graph catalogs so legal nodes and ports never have to be guessed;
- frame-rate-independent game scripting rules;
- transactional hot reload and rollback;
- compact diffs, changed IDs, diagnostics, and invalidation scopes;
- real screenshots and optional render passes; and
- one revision number shared by MCP, the project store, and the live viewport.

## Architecture

```text
Codex / ChatGPT
      |
      | MCP over stdio
      v
Node MCP adapter
      |
      | authenticated NDJSON RPC over a random local named pipe
      v
Persistent ThreeBrowser Studio process
  - AuthoringKernel / DocumentStore
  - transaction queue + history journal
  - project persistence
  - script / graph compilers (planned)
  - Three.js WebGPU runtime scene
  - deterministic Action runtime + blueprint runtime (blueprints planned)
  - native RTX lighting preview adapter (implemented when the host bridge supports it)
  - persistent viewport + evidence capture
```

The first implementation belongs at the Node/JavaScript layer. The current
runtime already provides Node 24, filesystem APIs, native WebGPU, Three.js r184,
TSL, image decoding, and the ThreeBrowser RTX bridge. Keeping MCP out of C++
makes tool and schema iteration cheap and isolates malformed protocol input
from the native renderer.

C++ should expose only capabilities JavaScript cannot implement cleanly, such
as future native file dialogs, native window capture, device-specific telemetry,
or new RTX primitives. It must not own project semantics or MCP tools.

## Live session lifecycle (target)

The viewport process owns the live document and GPU resources. The MCP process
is a thin adapter.

The current launch opens the explicitly configured project, otherwise the last
successfully opened project, otherwise managed `projects/live`. It restores
named-save/recovery document state plus the review/render camera and latest
evidence metadata, creates a fresh authenticated pipe, presents the viewport,
and publishes a heartbeat marker. Selection and transient Play state are not
restored yet.

On launch the viewport:

1. Reads private machine-local Studio state, never the previous bearer marker.
2. Reopens the last explicit project and authored active scene.
3. Restores the review/render camera and latest evidence metadata; selection,
   mode, and Play state remain a later capability.
4. Restores a newer recovery revision as dirty rather than overwriting the
   named project.
5. Creates a random local pipe and a 256-bit ownership token.
6. Presents the first real frame.
7. Atomically publishes the live session marker.

The marker records protocol version, process ID, pipe path, token, project
path, revision, and heartbeat. By default it lives under the user's local app
data with an explicit private ACL. The MCP adapter accepts that default or an
explicit marker, verifies freshness, token, session ID, and process ID, and
never scans or connects to unrelated named pipes.

The last committed scene remains visible if the MCP client disconnects. A new
client can reconnect without rebuilding the window or losing camera state.

The live bridge is a local same-user control boundary, not a malware sandbox.
The private marker directory, unguessable pipe name, 256-bit token, strict
message limits, timeouts, and connection quotas prevent accidental or
cross-account attachment. Node does not expose a safe named-pipe DACL API, so
same-account hostile code remains outside the threat model.

## Project format

One project is a normal directory suitable for Git:

```text
my-game/
  project.threestudio.json
  scenes/
    scene_2Fmain.<content-hash>.scene.json
    scene_2Finterior.<content-hash>.scene.json
  resources/
    geometries.<content-hash>.json
    materials.<content-hash>.json
    animations.<content-hash>.json
  graphs/
    shaders/
    textures/
    blueprints/
  scripts/
    player-controller.mjs
    door.mjs
  assets/
    <sha256>.<extension>
  generated/
    textures/
    meshes/
  renders/
  history/
    journal.ndjson
    snapshots/
  .studio/
    recovery.json
    view.json
```

`project.threestudio.json` contains project identity, format version, active
scene, scene index, resource index, script trust policy, export settings, and
content hashes. Scene documents contain only scene-local entities, scene
settings, and references to project resources.

`schemas/project-manifest-v1.schema.json` is the strict on-disk envelope
contract. It is intentionally separate from `project-v1.schema.json`, which
describes the normalized in-memory document after indexed files are loaded.

Named saves use write-to-temp, flush, and atomic rename. Recovery is debounced
and never silently replaces a named save. Generated assets are content
addressed. Imported assets record original source, hash, license/provenance,
colour role, and importer settings.

Paths are resolved inside the canonical project root. Traversal and symlink
escapes are rejected. Remote download is an explicit job with URL, checksum,
size limit, and provenance; ordinary scene mutation cannot fetch the network.

## Canonical intermediate representation

### Entities

Every entity has a stable project ID chosen for meaning, not a Three.js UUID:

```json
{
  "id": "courtyard/fountain",
  "kind": "mesh",
  "name": "Courtyard Fountain",
  "parentId": "courtyard",
  "children": [],
  "visible": true,
  "transform": {
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1]
  },
  "components": {
    "mesh": {
      "geometryId": "geometry/fountain-basin",
      "materialIds": ["material/wet-stone"]
    }
  },
  "tags": ["environment", "water-feature"]
}
```

Supported v1 kinds are scene, group, mesh, instancedMesh, perspectiveCamera,
orthographicCamera, directionalLight, pointLight, spotLight, ambientLight,
sprite, line, points, audioSource, and empty/gameObject.

Entity components are typed records. Raw property paths are never accepted by
the mutation API. Three.js UUIDs and object pointers are runtime-only.

### Geometry

Geometry is a resource recipe or imported asset reference. V1 recipes include
box, plane, sphere, capsule, circle, cone, cylinder, lathe, extrude, shape,
torus, torusKnot, tube, heightfield, line, points, explicit indexed mesh, and a
canonical polygon/corner editable mesh.

Every recipe reports bounds, vertex count, triangle count, attribute layout,
and whether topology is static, instanced, or deforming before commit.
Editable meshes preserve multiple per-corner UV/color layers, per-face material
indices, sharp edges, and crease weights through guarded topology edits. Direct
attribute commands create, delete, rename, activate, project, transform, and
set these values. The current compiler lowers only the active UV and color
layer; the active UV becomes raster channel 0. Crease weights are
storage/editing data and do not affect viewport subdivision yet.

### Materials and shader graphs

Material compilation supports scalar basic, standard, physical, and toon
recipes plus the live typed shader-graph subset. Blender RNA aliases, socket
values, links, procedural textures, bump, Principled BSDF, and Material Output
compile to Three.js TSL/WebGPU nodes. Catalogued-but-unimplemented nodes fail
during candidate compilation before the live scene is swapped.

The graph contract also preserves bounded Blender-style node layout: position,
dimensions/width, label, collapsed state, optional color, and `NodeFrame`
parenting. Parent references are validated and frame cycles are rejected.
Numeric `NodeReroute` is a real live/CPU pass-through; closure reroutes remain
explicitly unsupported.

Materials are `basic`, `standard`, `physical`, `toon`, `sprite`, `line`, or
`nodePhysical` records. A material can reference maps and one typed shader
graph. The graph compiles through a curated registry into TSL assignments on a
Three.js NodeMaterial.

Basic, standard, physical, and toon materials can also reference bounded
inline `dataTexture` resources through their supported PBR map slots. Encoded
colour maps use sRGB, while direct color-role bindings and
`texture.sample2d` also accept `linear` for already-linear bytes; graph sampler
declarations must exactly match their resource. Normals, roughness, metalness,
AO, height, masks, and other numeric maps require no colour space. A geometry
must expose an active UV layer before a raster map can compile. Each canonical
texture is cached once per compiled candidate and disposed exactly once with
that candidate.

A material cannot define a direct map for a property that its graph also
outputs, and a graph `surface` output conflicts with every direct map it
overrides. Candidate validation rejects the ambiguity; author the sample inside
the graph through `texture.sample2d` instead. Graph `image` asset nodes are
bounded CPU-bake inputs only and fail explicitly in live WebGPU compilation.

Status publishes the mapped-material control contract at
`capabilities.imageTextures.materialControls`: exact scalar and vec2 ranges,
the `vertexColors` boolean, accepted base/color, emissive, sheen, and specular
color-control names, and per-map neutral defaults. Unit-bounded PBR weights and
AO intensity, IOR 1–3, large but finite thickness/emissive and displacement
ranges, and ±100 normal-scale components are therefore discoverable instead of
implicit runtime knowledge.

Map-aware defaults make an unauthored multiplier neutral rather than allowing a
constructor default to erase the sampled map. Base, emissive, sheen, and
specular color multipliers become white; relevant scalar lobes/intensities and
normal scales become 1; displacement becomes scale 1/bias 0. The exact map in
status also covers paired activation: clearcoat-normal/roughness maps activate
clearcoat, sheen color/roughness maps activate sheen with white sheen color,
thickness activates transmission, specular color stays white, specular
intensity becomes 1, and anisotropy/iridescence maps activate their weights.
Explicit authored values always take precedence.

V1 graph outputs are limited to:

- surface (Principled/Material Output contract);
- baseColor;
- roughness;
- metalness;
- normal;
- emissive;
- opacity;
- alphaTest; and
- positionOffset.

The model cannot provide raw TSL, WGSL, GLSL, `Fn`, `Loop`, `fragmentNode`, or
`outputNode` through ordinary tools. This keeps stage legality, resource use,
and serialization inspectable. A later trusted-code path may add raw shaders as
normal project files with explicit user trust.

Three.js NodeMaterial JSON is not authoritative. In r184 even simple node
material round-trips require custom registries and fail for some node types.
The project-owned graph IR is compiled afresh and baked to ordinary PBR maps
when exporting to interchange formats.

### Texture graphs

The typed texture-graph contract, validator, live TSL material path, and bounded
deterministic CPU evaluator/baker exist. Bounded inline byte/base64
`dataTexture` resources compile to RGBA8 for raster material shading. External
image-file decoding/import and MCP file-producing bake jobs remain deferred.
Generic texture envelopes from format v1 remain valid/indexable placeholders,
but do not compile into a live raster map until patched to `dataTexture`.

Texture graphs use the same typed DAG envelope as shader and blueprint graphs.
V1 nodes include constant, image, UV, world position, Blender Gradient,
Checker, White Noise, Magic and Brick, value noise, FBM, Voronoi, Wave,
colour ramp, arithmetic, mix, remap, warp, blur,
normal-from-height, and channel pack.

A texture graph can remain live as TSL or bake deterministically to DataTexture
and PNG. Seed, resolution, wrapping, filtering, channel roles, and colour space
are explicit. Albedo/emissive outputs use sRGB; normal, roughness, metalness,
height, masks, and data use no colour space.

Interactive resolution is capped at 2048. Explicit bake jobs may use 4096.
Inline `dataTexture` resources have their own live limit of 512 × 512 and use
1–4 source channels expanded to RGBA8 at upload. Canonical sampler defaults are
trilinear minification with generated mipmaps, linear magnification, clamp
wrapping, and anisotropy 4; normalized recipes always carry anisotropy.

### Blueprint graphs

The typed blueprint-graph contract and validator exist; execution described
below is planned.

Blueprints are bounded, deterministic game-logic graphs, not an alternate
unrestricted programming language. V1 nodes cover:

- lifecycle and input events;
- timers, branches, comparisons, state, and events;
- get/set typed entity properties;
- transform, visibility, spawn, destroy, and reparent actions;
- animation and audio control;
- camera actions;
- material parameter changes;
- seeded arrays, grids, scatter, along-curve, and prefab instancing; and
- calls into explicitly exposed script functions.

Graphs compile to a small project-owned instruction representation with an
instruction budget. Cycles require an event, delay, timer, or bounded loop.
Execution traces identify graph ID, node ID, frame, input, output, and error.

### Animations

Animation resources use a context-free Action subset with stable entity IDs
and typed property paths rather than raw Three.js `PropertyBinding` strings.
The current runtime supports position, Euler rotation, scale, and visibility;
scalar/vector keyframes; constant, linear, smooth, and cubic Bezier
interpolation; once, repeat, and ping-pong loops; autoplay; speed; and exact
frame/seconds seeking. `three_studio_play` advances or scrubs Actions, while
`three_studio_render.timelineFrame` captures a deterministic authored frame.

The runtime resolves stable IDs only after scene instantiation, snapshots the
authored pose, evaluates Actions, then reapplies the supported constraint
stack. Skeletal clips, morph weights, material/light parameter tracks, event
tracks, drivers, and NLA strip composition remain planned or require baking.

### JavaScript game code

Agent-safe parsing and atomic source storage exist as internal modules. Script
MCP mutations, attachment, hot reload, and execution described below are not
currently exposed.

The Acorn policy is a save-time capability preflight, not an execution
sandbox. `behaviorRuntime` remains false until accepted modules can run behind
a real process/OS capability boundary with transitive-import validation.

Scripts are ordinary `.mjs` project files and can be attached at project,
scene, or entity scope. A behaviour module exports a lifecycle object:

```js
export default defineBehavior({
  start(context) {},
  fixedUpdate(context, delta) {},
  update(context, delta) {},
  onEvent(context, event) {},
  stop(context) {},
});
```

Two trust levels exist:

1. `agent-safe` is the default. Acorn validates imports and syntax. Scripts can
   import the Studio behaviour API plus allowlisted Three.js math/types. Node
   builtins, `process`, `require`, dynamic import, `eval`, and global filesystem
   or network access are rejected. The script receives a capability object for
   scene queries, commands, input, time, events, audio, and deterministic RNG.
2. `trusted-project` is explicit user-owned code. It may use the full project
   runtime and Node APIs. The trust choice is stored in the manifest and cannot
   be enabled by an ordinary MCP mutation.

Hot reload is transactional: parse and validate, import with a revision key,
instantiate in shadow state, run validation/start checks, swap at a frame
boundary, dispose the old instance, and roll back if the new module fails.
Script exceptions become diagnostics and cannot corrupt the authoring document.

## The nine MCP tools

The external surface stays deliberately small. The model should learn nine
strong contracts rather than dozens of micro-tools.

### 1. `three_studio_status`

Returns the session, active project/scene/revision, dirty/saved state, entity
and scene counts, undo/redo availability, transient mode/counters, viewport
camera, latest evidence metadata, and explicit capability flags. Capabilities
are authoritative; an architecture section mentioning RTX or jobs does not
make them available.

It is cheap and should be the first call after connection or compaction.

### 2. `three_studio_project`

Currently lists, creates, opens, and atomically saves managed Studio projects.
`starter` is the only template. Checkpoint/snapshot, close, export, project
duplication/rename/deletion, and scene-management actions are not in this tool
schema; scenes are authored by the implemented `apply` operations.

### 3. `three_studio_inspect`

Reads bounded semantic context. Current selectors identify exact IDs or match
name, kind, or tag. Fuzzy queries are read-only; writes use exact IDs returned
by inspect.

Current include slices are summary, tree, transform, components, compiled
bounds, and incoming references. Scene digests include the exact scene hash;
the tree slice includes subtree hashes needed for guarded deletes. Pagination
prevents a large scene from flooding model context.

`resourceDigest` searches every canonical resource table and returns bounded
hashes and topology summaries. Dense geometry attributes are reported as
counts/item sizes rather than echoed as raw arrays, so a model can verify that
it authored real indexed geometry without consuming the next request budget.

`meshElements` is the exact dense-geometry path. It pages vertices, unique
edges, triangular faces, and corners with available normal/UV/colour attributes
and bounded adjacency. Cursors include resource and topology hashes.
`graphDigest` returns graph/resource guards plus byte-bounded nodes, edges,
outputs, settings, and validation diagnostics. `rtxDigest` retains the native
collector report so skipped geometry can be diagnosed without rebuilding the
static scene during inspection.

Useful special queries include:

- scene digest;
- exact entity-set guards plus independent collection membership/subtree
  guards;
- resource digest with indexed-mesh counts, local bounds, compact components,
  and incoming references;
- exact mesh elements and adjacency;
- exact graph topology and validation diagnostics;
- authored/effective RTX state and collector exclusions;
- changed since revision;
- unresolved resources and unused resources;
- graph node catalog and typed ports;
- Blender compatibility catalog by domain/status/query;
- current animation Play state and Action states; and
- latest evidence metadata.

### 4. `three_studio_apply`

The only ordinary mutation tool. It accepts a label, base revision,
idempotency key, optional dry-run, and up to 128 domain operations. The batch is
atomic and all-or-nothing.

Operation families include:

- scene create, patch, guarded delete, active scene, settings, and active
  camera;
- entity create, patch, exact guarded bulk patch/transform, world-preserving
  group/ungroup, duplicate, reparent, and guarded delete;
- independent nested collection create, patch, guarded membership edit,
  reparent, and collection-only delete;
- exact-aspect camera framing, bounded live layout patterns, indexed-triangle
  edits plus topology-guarded editable polygon/corner operations (including
  compact `selection: "all"`, direct UV/color layers, face materials, sharp
  edges, and crease storage), and canonical RTX settings; and
- resource create, patch, and reference-safe delete across canonical resource
  tables, including bounded inline raster textures and material-map references.

In-transaction aliases such as `$ground` let later operations reference new
entities/resources without round trips. A dry-run returns resolved IDs, the
compact document diff, diagnostics, and expected invalidations without
touching the document or viewport. Script, arbitrary selection/review-camera,
layout modes beyond the four declared patterns, and persistent Play-parameter
operations are not in the current schema.

Dense resource arrays use geometry-scale schema budgets rather than the generic
20,000-item JSON limit, while the one-MiB control request and core topology
budgets remain authoritative. Explicit vertex-index lists stay bounded; use
`selection: "all"` for a whole indexed mesh instead of serializing thousands of
indices. Indexed and explicit topology is validated on both resource creation
and the fully merged result of a resource patch before canonical state changes.

Groups and collections deliberately remain different document concepts. A
group entity owns a transform and changes the entity parent hierarchy;
group/ungroup computes exact relative TRS and rejects shear that canonical TRS
cannot preserve. A collection has no transform and can contain overlapping
entity memberships in its own hierarchy. Deleting a collection never deletes
its member entities. Bulk entity mutations and collection membership changes
must carry the exact hash returned by the preceding bounded inspection.

### 5. `three_studio_validate`

Currently validates the complete project at `interactive` strictness. The
exposed checks are document schemas, references, hierarchy, typed graph
structure, animation Actions, and budgets. Scene/entity/resource scoping and
shader, script, asset, offscreen-render, RTX, Play, and export validation are
not exposed.

Validation never mutates the project.

### 6. `three_studio_play`

Currently enters/stops a transient Play mode, pauses/resumes deterministic
Actions, seeks to an exact time or frame, advances by bounded ticks, records
the latest named input, and reports Action states. It does not run scripts,
blueprints, physics, events, or game logic. It never mutates the authoring
document.

### 7. `three_studio_render`

Currently frames exact target IDs or explicit bounds, or uses a named compiled
camera, then captures WebGPU beauty evidence at the committed revision to an
offscreen target. Capture does not change the authoring document or the visible
review camera. An optional `timelineFrame` evaluates and captures an exact
Action frame before restoring the prior runtime time. Diagnostic passes and
RTX/hybrid rendering are not exposed.

### 8. `three_studio_history`

Lists or inspects transactions and performs undo or redo. Undo and redo create
new revisions by applying inverse commands; revision numbers never move
backward. Dedicated diff and revision-compare actions are not exposed.

### 9. `three_studio_job`

This is an explicit reserved slot so the nine-tool topology need not change.
It currently exposes no start/inspect/cancel action and returns
`job_not_implemented`; `status.capabilities.jobs` is false. Asset import,
texture/mesh bakes, reconstruction, lightmaps, and packaging are future job
kinds, not callable operations.

## Shared request and response contract

`apply` always carries protocol/session/project identity, exact base revision,
an idempotency key, and a human-readable label. Undo/redo, non-query Play
controls, and project mutations carry the correlation fields required by their
schemas; project create/open have no meaningful prior project revision. Read
actions accept the bounded connection/target fields declared by their own
schemas. There is currently no long-running job request.

Responses are action-specific. Committed `apply`/undo/redo responses include
the revision, transaction ID, resolved IDs, changed/deleted IDs, compact diff,
invalidation scopes, diagnostics, warnings, and dirty state. Read, render,
project, and Play responses return only their documented state. Errors use a
typed code. Stale revision-bearing mutations fail with `revision_conflict`;
idempotent mutations replay the original result only when the request
fingerprint matches.

## Transaction pipeline

Every `apply` follows the same path:

1. Authenticate the local session and enforce message/operation limits.
2. Parse with strict schemas (`additionalProperties: false`, finite bounded
   numbers, enums, and explicit units).
3. Check the base revision and idempotency journal.
4. Resolve exact IDs and in-transaction aliases.
5. Apply all operations to a structural draft.
6. Validate the canonical document, stable IDs, references, hierarchy, and
   budgets; validate typed graph and animation resources before they enter the
   kernel.
7. Compile the candidate scene through the currently implemented procedural
   geometry, ordered modifier/constraint subset, shared raster textures,
   PBR/physical material, light, camera, fog, shadow, and Action factories.
8. Compute normalized diff, inverse operations, hashes, and invalidations.
9. If dry-run, return without publishing document or viewport state.
10. For a commit, increment once and atomically publish recovery/journal state.
11. Swap the fully compiled scene at a frame boundary and dispose the previous
    compiled scene.
12. Return the exact committed result.

Any validation, compile, persistence, or preparation failure before commit
leaves canonical document state unchanged. Incremental resource compilation,
TSL/script/blueprint preparation, automatic evidence capture, and swap
compensation are later pipeline stages.

## High-level layout pipeline (partially implemented)

The model should not spend hundreds of tokens hand-authoring repetitive object
coordinates. The live `layout.pattern` operation supports bounded linear,
grid, radial, and seeded volume scatter instancing. A broader later `apply`
slice is designed to support the remaining deterministic layout operations:

- align minimum/centre/maximum on an axis;
- distribute by centres, edges, or equal gaps;
- stack and pack within bounds;
- grid and radial arrays;
- seeded volume scatter is live; density, masks, slope, clearance, and collision
  rules remain planned;
- along-curve placement with tangent/orientation policy;
- snap to ground, surface, vertex, grid, or named anchor;
- frame or aim cameras at targets;
- create named anchors and spatial zones;
- instantiate parameterized blueprints/prefabs; and
- replace or update a prior generated set by generator ID.

Every layout dry-run returns output bounds, count, overlaps, triangle/instance
budgets, and the deterministic seed. Generated children retain derivation
metadata so a later call can change count or spacing rather than delete and
rebuild unrelated content.

## Play and game-code pipeline (partially implemented)

The current implementation snapshots authored transforms, deterministically
evaluates the Action subset, stores mode/pause/tick/elapsed/input state, and
restores authored state on stop. It does not create a separate game-state
layer or execute scripts, blueprints, physics, or the remaining steps below.
The intended broader behaviour capability is:

Author and Play are separate runtime modes over the same document:

1. Author mode commits and saves canonical state.
2. Enter Play captures a cheap document/runtime snapshot.
3. Runtime-only entity creation and component state use a separate play layer.
4. Fixed update runs before frame update at a deterministic clock.
5. Blueprints and scripts receive bounded input/event queues.
6. MCP can pause, step one fixed tick/frame, inject named input actions, query
   exposed game state, and render evidence.
7. Stop disposes the play layer and restores the authoring snapshot unless the
   model explicitly bakes selected runtime results through a validated apply.

This prevents a playtest from silently becoming the saved scene while still
allowing deliberate procedural bake workflows.

## Persistent viewport

The scene is the interface. The viewport occupies the window.

The only persistent chrome is a small retained overlay showing project/scene,
revision, saved/dirty state, Author/Play/Capture mode, latest operation, and
diagnostic count. A selection chip appears only when needed. An evidence drawer
may show before/after/diff targets and compile errors, but is closed by default
and never resizes the viewport.

Before/after/diff views remain persistent GPU render targets. Readback happens
only for an explicit evidence request. Text uses a retained bitmap glyph atlas
and fixed-capacity geometry. Static chrome is painted once, converted to a
DataTexture, pre-uploaded, and detached from Canvas2D. Progress, hover, preview
wipe, and status transitions change transforms, buffer ranges, or uniforms,
not full-screen canvas textures.

One final render presents to the swapchain. World and transparent overlay are
composited offscreen so no helper render accidentally presents a second frame.

The current project save persists the active scene and authored active-camera
reference. Session recovery also restores the transient review camera and
latest evidence metadata. Selection and Play mode do not persist across
process restarts. A render request is an offscreen evidence capture and leaves
the visible camera unchanged.

## RTX and WebGPU policy

Authored WebGPU/TSL materials and raster shadows remain active during editing.
RTX accelerates review; it is never an on/off replacement for the authored
shader.

The current Studio reports native RTX adapter support and activation state
separately, exposes `renderer: webgpu` for evidence, and keeps compiled TSL and
raster-map materials active in the WebGPU viewport. `scene.rtx.patch` can
request the available ray lighting, shadows, and AO without replacing those
materials.

Topology and opaque membership edits mark static RTX data stale. Rebuild after
300–500 ms idle or on an explicit RTX render request. Transform-only repeated
geometry should use native instance groups. The current native contract allows
up to 8,192 slots per group, eight packed point/spot lights, one fixed-topology
dynamic mesh, ray lighting/AO, and one-bounce reflections. Unsupported
transparency, textured hit materials, refraction, and recursive tracing stay in
the WebGPU authored path. In particular, inline albedo, normal, roughness, AO,
height, and alpha maps shade raster materials but are not sampled at RTX hits.

Every status and render response distinguishes `ready`, `stale`, `building`,
`unsupported`, and `failed`; adapter support is never reported as an active
render result.

## Initial guardrails

Currently enforced guardrails include the 1 MiB bridge request, 128 operations
per transaction, 20,000 authored entities, typed-graph limits, 1,920 × 1,080
evidence bounds, strict Action structure and target validation, and
hash-guarded recursive/non-empty deletes. Inline raster resources are limited
to 512 × 512, 65,536 numeric source bytes or 700,000 decoded base64 bytes,
1,398,100 expanded RGBA8 mip-chain bytes per texture, 8 MiB serialized recipe
JSON across a project, and 16 MiB decoded source bytes across a project. The
dimension cap and base64-byte cap are independent: under the one-MiB MCP
control request, full-resolution three/four-channel payloads require a future
chunk/blob path. The animation-key, texture-bake, and RTX-specific numbers
below are planned pipeline limits.

- 1 MiB control request;
- 128 operations per transaction;
- 20,000 authored entities;
- 256 nodes and graph depth 64;
- 512 × 512 and 1,398,100 mip-chain GPU bytes per inline `dataTexture`;
- 8 MiB serialized and 16 MiB decoded inline texture data per project;
- 2,048 interactive and 4,096 bake texture resolution;
- 100,000 animation keys per project;
- 2 million registered static RTX triangles;
- 8 RTX point/spot lights;
- 8,192 instances per native group;
- 1,920 × 1,080 evidence render by default maximum; and
- no recursive delete without an expected subtree hash.

Delete defaults to refusing referenced resources and non-empty hierarchies.
Large/topology/destructive changes should be dry-run first. These are product
guardrails, not claims about the maximum hardware capability.

## Implementation phases

### Phase 1: authoring kernel

- schemas and normalized document;
- stable IDs and object/resource indexes;
- atomic command bus, inverse operations, revision journal, recovery, save;
- geometry/material/light/camera factories;
- persistent viewport and screenshot evidence; and
- authenticated named-pipe RPC.

### Phase 2: MCP and live creation loop

- official MCP v2 stdio adapter;
- the nine tools and project resources;
- bounded inspect queries and catalogs;
- live incremental runtime updates;
- history/diff and idempotency; and
- native end-to-end scene creation acceptance test.

### Phase 3: authored behaviour

- animation clips and deterministic play controls (initial Action subset complete);
- capability-limited `.mjs` behaviour scripts and transactional hot reload;
- blueprint graph compiler/runtime; and
- play-state inspection and input injection.

### Phase 4: visual pipelines

- unified graph core;
- TSL shader compiler;
- deterministic texture compiler/bake jobs;
- generated layout/blueprint recipes;
- pipeline prewarm; and
- before/after/diff evidence.

### Phase 5: production output

- asset import and provenance;
- glTF/PBR baking and project export;
- debounced RTX preview and instance-group updates;
- packaging through the existing ThreeBrowser executable exporter; and
- headless validation/playtest mode for CI.

## Acceptance test for the complete first useful version (future milestone)

From a clean project and an external MCP client, without manually touching the
window, the model must be able to:

1. Create a second scene.
2. Build a lit courtyard from primitives using a layout operation.
3. Create and assign a procedural wet-stone material.
4. Add a camera and frame the courtyard.
5. Attach a deterministic door behaviour script.
6. Enter Play, inject the open-door action, and step the simulation.
7. Inspect the resulting door transform and any diagnostics.
8. Render beauty and object-ID evidence.
9. Undo the material transaction without losing later camera state.
10. Save, close, reopen, and restore the exact scene, resources, code,
    selection, review camera, and revision history.

The user should be able to watch the courtyard appear and the door run in one
persistent native window throughout the test.
