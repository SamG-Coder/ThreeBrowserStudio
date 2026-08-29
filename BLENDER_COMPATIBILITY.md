# Blender concepts in ThreeBrowser Studio

ThreeBrowser Studio adopts Blender's durable authoring concepts without
copying Blender's panel UI or pretending Three.js is Cycles. The editor remains
LLM-first: every mutation names exact stable IDs, every batch is atomic, and no
operation depends on selection, mode, mouse position, or the active editor.

The machine-readable domain source of truth is
[`src/blender/catalog.mjs`](./src/blender/catalog.mjs). The pinned Blender 5.2
modifier inventory lives beside it in
[`src/blender/modifier-inventory.mjs`](./src/blender/modifier-inventory.mjs).
The domain catalog labels capabilities `implemented`, `partial`, `planned`,
`bake-required`, or `not-applicable`. Query it live with:

```json
{
  "query": "blenderCatalog",
  "selector": { "kind": "modifiers" },
  "limit": 200
}
```

For the `modifiers` domain, `catalog.modifierInventory` contains the matching
modifier rows and `catalog.modifierInventorySummary` contains exact counts.
Use `selector.name` to search labels, RNA classes, or operator type identifiers.

## Architectural translation

Blender's central distinction is between an **Object** (transform, hierarchy,
visibility, modifiers and constraints) and reusable **Object Data** such as a
mesh, camera or light. Studio preserves that split as entity documents plus
stable-ID resources. Multiple mesh entities can reference the same geometry or
material without duplicating it. This follows Blender's documented
[Object/Object Data model](https://docs.blender.org/manual/en/latest/scene_layout/object/introduction.html)
and its database-oriented
[Python data access](https://docs.blender.org/api/current/info_quickstart.html#data-access).

Blender operators often depend on context—selection, mode, area and active
object. Studio follows the data API side of Blender instead: MCP commands name
the scene, entity, resource and property explicitly. The distinction matters
because Blender itself documents operators separately from direct
[data access](https://docs.blender.org/api/current/) and
[context-sensitive operators](https://docs.blender.org/api/current/bpy.ops.html).

| Blender concept | Studio representation | Current execution |
|---|---|---|
| `.blend` data-block database | Project, scenes, stable-ID resources, scripts and graphs | Partial |
| Scene | Scene document, roots, world-like settings, timeline and active camera | Partial |
| Collection | Group entity as a transform hierarchy | Planned as independent many-to-many membership |
| View Layer | Single active compiled scene view | Planned |
| Object | Entity document | Implemented for the declared entity kinds |
| Mesh data | Shared geometry resource | Procedural, explicit indexed, and canonical editable polygon/corner meshes |
| Materials | Shared basic/standard/physical/toon resource | Scalar PBR, supported bounded raster maps, and supported live node graphs |
| Modifier stack | `entity.components.modifiers[]` in authored order | Array/Mirror/Pattern plus ten bounded geometry evaluators; all other Blender types use an explicit validated bake boundary |
| Constraint stack | `entity.components.constraints[]` in authored order | Aim/copy/limit subset |
| Action/F-curves | Animation resource with stable target/property tracks | Frame/second keyframes and four interpolations |
| Geometry Nodes | Typed graph IR | Validation only |
| Shader Editor | Typed shader graph IR | Blender RNA core compiles to TSL/WebGPU; unsupported nodes fail explicitly |
| Compositor/View Layers | Future render graph and named passes | Beauty pass only |
| Physics | Ordered Ocean geometry modifier; future solver adapter/cache resources | Bounded deterministic Ocean displacement only; no physics world or general solver |
| Python | Project-owned validated `.mjs` design | Stored/validated internally, not executed |

Collections and view layers are not the same thing as parenting. Blender lets
an object belong to multiple
[Collections](https://docs.blender.org/manual/en/latest/scene_layout/collections/introduction.html),
while [View Layers](https://docs.blender.org/manual/en/4.5/scene_layout/view_layers/introduction.html)
control evaluation and rendering. Studio therefore does not mislabel a group
entity as full collection parity; the catalog keeps those capabilities
explicitly planned.

## Modeling and non-destructive evaluation

Geometry resources currently compile these recipes:

- box, plane, sphere, capsule, circle, cone and cylinder;
- torus and torus knot;
- lathe profiles;
- Catmull–Rom tube paths;
- 2D shapes with holes and beveled extrusion; and
- explicit/indexed buffer geometry; and
- canonical editable polygon meshes with per-corner UV/color layers, material
  slots, sharp edges, creases, and hash-guarded vertex/face/edge edits.

Studio now has a bounded editable-mesh kernel for exact vertex transforms,
smoothing, face subdivision/inset/individual extrusion/deletion, pairwise
manifold edge bevels, and exact vertex merges. Region extrusion, arbitrary loop
cuts/dissolve, sculpting, and adjacency-dependent live modifiers over split UV
seams remain explicit bake boundaries rather than approximations.

The same guarded edit path directly creates, deletes, renames, activates,
projects, transforms, and sets per-corner UV/color layers; assigns per-face
material slots; and edits sharp edges and crease weights. Multiple layers stay
canonical, but only the active UV and active color layer compile into the
current viewport; the active UV becomes raster channel 0. Crease weights are
storage/editing data only until a
seam-safe subdivision lowering consumes them.

Blender defines modifiers as ordered, non-destructive operations evaluated
top-to-bottom. Studio preserves that model in canonical data. Use
`three_studio_inspect` with `query: "modifierDigest"` to obtain the exact
`stackHash`, then apply guarded `modifier.create`, `modifier.patch`,
`modifier.move`, `modifier.delete`, or one atomic `modifier.stack.edit` batch.
The live canonical types are strict: Array, Mirror, Pattern, Triangulate, Weld,
Smooth, Weighted Normal, Edge Split, Solidify, Subdivision, Decimate, Displace,
and Ocean. Ocean is a deterministic, bounded displacement-only subset over an
existing local-XY surface. It supports seeded timeline motion, but not generated
grids, alternate spectra, caches, foam, or spray; timeline-driven Ocean meshes
stay in raster WebGPU and are excluded from the static RTX triangle scene. A
misspelled type fails validation instead of falling through to a default.

Unsupported Blender modifiers are represented as `type: "bakeBoundary"` with
an `operatorType` validated against the complete 83-row Blender inventory and
optional bounded opaque `parameters`. A bake boundary deliberately stops live
downstream evaluation; it is never treated as approximate geometry. Authored
viewport/render enable flags are preserved, but this does not claim separate
render/evidence evaluation parity. See
[Blender's modifier stack](https://docs.blender.org/manual/en/5.2/modeling/modifiers/introduction.html).

### Blender 5.2 modifier inventory

The inventory is pinned to Blender 5.2 LTS's official
[`Object Modifier Type Items`](https://docs.blender.org/api/5.2/bpy_types_enum_items/object_modifier_type_items.html)
enum and the direct [`bpy.types.Modifier`](https://docs.blender.org/api/5.2/bpy.types.Modifier.html)
RNA subclasses, cross-checked against the release branch's
[`properties_data_modifier.py`](https://projects.blender.org/blender/blender/src/branch/blender-v5.2-release/scripts/startup/bl_ui/properties_data_modifier.py)
Add Modifier menus. That is the exhaustive built-in object-modifier type surface:
83 types split into 17 Modify, 30 Generate, 26 Deform, and 10 Simulate entries.
Blender's API calls the final section “Physics”; Studio uses the modifier
manual's “Simulate” category name. Asset-library Geometry Nodes modifiers are
instances of `bpy.types.NodesModifier`/`NODES`, not additional RNA types.

Every row includes its full `bpy.types.*` RNA identifier, the
`bpy.ops.object.modifier_add` operator plus exact `type` enum identifier, a
concise purpose, and one deliberately conservative execution status:

| Status | Count | Meaning |
|---|---:|---|
| `live-runtime` | 2 | Executes as non-destructive object/instance evaluation: `ARRAY`, `MIRROR` |
| `live-geometry` | 10 | Bounded deterministic indexed-mesh subset: `DECIMATE`, `DISPLACE`, `EDGE_SPLIT`, `OCEAN`, `SMOOTH`, `SOLIDIFY`, `SUBSURF`, `TRIANGULATE`, `WEIGHTED_NORMAL`, `WELD` |
| `bake-required` | 35 | Preserve a validated explicit boundary and bake evaluated data before expecting downstream live evaluation |
| `planned` | 10 | Geometry Nodes plus the remaining nine solver/physics stack types are catalogued but not executed |
| `not-applicable` | 26 | Grease Pencil modifiers require a stroke/layer object model Studio does not have |

This inventory is discovery and compatibility metadata, not a claim that all
83 types execute or that the ten geometry subsets reproduce every Blender
option. The full list remains queryable even when a type is unsupported, so MCP
clients can author a validated bake workflow without guessing or silently
degrading the scene.

Constraint stacks use the same rule. `lookAt`/`trackTo`, copy location,
rotation or scale, and limit location execute as derived transforms. More
complex IK, shrinkwrap, path and bone constraints stay authored/bake-required
until a dependency solver exists.

## Materials, nodes and rendering

Blender defines materials, lights and world backgrounds through typed shader
node networks. Studio keeps validated shader/texture graphs as canonical data
and compiles the supported Blender-shaped procedural/PBR subset directly to
Three.js TSL/WebGPU NodeMaterials. The full current Blender node inventory is
discoverable; unsupported closures and engine-specific nodes fail clearly
rather than degrading to a washed-out approximation. See
Blender's [shader-node model](https://docs.blender.org/manual/en/latest/render/shader_nodes/introduction.html)
and [Principled BSDF](https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/principled.html).

Studio also compiles strict inline 1–4-channel `dataTexture` resources to
shared RGBA8 WebGPU textures for supported basic, standard, physical, and toon
map slots. Encoded albedo/emissive/color maps use sRGB; normal, roughness,
metalness, AO, bump, displacement, alpha/mask, and physical data maps use no
colour space.
Raster maps require an active UV layer. They shade the WebGPU material path but
are not sampled by native RTX hit shading.

Direct color-role map bindings and `texture.sample2d` may use `linear` instead
of sRGB when their bytes are already linear; a graph sampler declaration must
exactly match its texture resource. Canonical textures default to trilinear
generated mipmaps, linear magnification, clamp wrapping, and anisotropy 4;
normalized recipes always contain bounded anisotropy. A direct map is rejected
when a material graph outputs the same property or a `surface` value that
supersedes that slot; use
`texture.sample2d` inside that graph. Graph `image` asset nodes remain
CPU-bake-only. Generic format-v1 texture placeholders remain valid for project
compatibility but cannot enter these live raster paths.

Inline dimensions stop at 512 × 512, but canonical base64 still stops at
700,000 decoded bytes under the one-MiB MCP control request. Consequently,
full-resolution three/four-channel sources require a future chunk/blob path.
Aggregate canonical recipes stop at 8 MiB serialized and 16 MiB decoded, and
each expanded RGBA8 mip chain stops at 1,398,100 GPU bytes.

`three_studio_status.capabilities.imageTextures.materialControls` exposes the
accepted scalar/vec2 ranges, `vertexColors` and color-control names, and the
exact neutral multiplier for each mapped slot. This is the Studio equivalent
of checking Blender's material inputs before connecting a texture: unauthored
mapped base/emissive/sheen/specular colors become white, applicable lobe and
intensity controls become 1, normal scales become `[1, 1]`, and displacement
uses scale 1/bias 0. The map-aware table explicitly activates sheen (including
white `sheenColor`) and preserves white `specularColor`/unit
`specularIntensity`, preventing those physical maps from being multiplied away.
Authored controls override these neutral defaults.

The pinned Blender 5.2 inventory distinguishes 115 current Add-menu entries,
100 direct `ShaderNode` API subclasses, API-only and legacy nodes, and 44 live
TSL nodes. `NodeFrame` plus bounded node layout metadata preserve tutorial
organization; numeric `NodeReroute` executes as a typed pass-through. The live
numeric/vector tranche includes Integer Input, Camera Data, Normal, Vector
Rotate, and object-space scalar/vector Displacement; world/tangent displacement
remains explicitly rejected. Engine closures, world/volume outputs, and
context-specific nodes remain catalogued with explicit candidate-compile
failure until their runtime contract exists.

The native viewport and evidence renderer use ThreeBrowser's external
`three/webgpu` runtime. Authored WebGPU materials and shadows stay active.
Current evidence is a beauty PNG; Cycles, EEVEE, OSL, Cryptomatte, volumes,
full compositing and RTX evidence remain capability-gated.

## Actions, keyframes and deterministic frames

An animation resource is the Studio analogue of a Blender Action:

```json
{
  "id": "animation/ball-bounce",
  "kind": "animation",
  "fps": 24,
  "frameStart": 0,
  "frameEnd": 48,
  "loop": "repeat",
  "autoplay": true,
  "tracks": [{
    "targetId": "entity/ball",
    "property": "transform.position",
    "interpolation": "bezier",
    "keyframes": [
      { "frame": 0, "value": [0, 0.5, 0] },
      { "frame": 12, "value": [0, 2.5, 0] },
      { "frame": 24, "value": [0, 0.5, 0] }
    ]
  }]
}
```

Supported property paths are position, rotation, scale and visibility.
Interpolation is constant, linear, smooth, or cubic Bezier; loops are once,
repeat, or ping-pong. Evaluation is pure and frame-rate independent. Play can
enter, pause, resume, seek or step Actions, while `three_studio_render` accepts
`timelineFrame` for an exact non-canonical scrub. Drivers, arbitrary RNA paths,
NLA blending, bones, morphs and event tracks remain planned. The design follows
Blender's [animation model](https://docs.blender.org/manual/en/latest/animation/introduction.html),
[Actions](https://docs.blender.org/manual/en/latest/animation/actions.html), and
[NLA](https://docs.blender.org/manual/en/latest/editors/nla/introduction.html).

## Official tutorial translated to MCP

The executable acceptance workflow combines free sections of Blender Studio's
[Blender Fundamentals 4.5 LTS](https://studio.blender.org/training/blender-fundamentals-45-lts/):

1. Model the stylized watering can with a lathed body and tube-path handle and
   spout, translating the official
   [watering-can exercise](https://studio.blender.org/training/blender-fundamentals-45-lts/blender_4-5_lts_modeling-the-watering-can/).
2. Preserve ordered Array/Mirror modifiers and an explicit bake-required Bevel.
3. Assign metallic and matte PBR materials.
4. Build Key, Fill and Rim lighting based on the official
   [light-types lesson](https://studio.blender.org/training/blender-fundamentals-45-lts/blender_4-5_lts_light-types/).
5. Aim a 52 mm active camera with a stable-ID constraint.
6. Author the official 0/12/24/36/48
   [bouncing-ball key sequence](https://studio.blender.org/training/blender-fundamentals-45-lts/blender-5-2-keyframes/).
7. Dry-run one 39-operation MCP changeset, commit it atomically, validate the
   whole project, render frames 1, 7 and 13, then save.

With the native Studio window running:

```powershell
cd <absolute-repository-path>
npm run tutorial:blender
```

The checked-in runner refuses to overwrite a populated project. Supply a fresh
managed directory name as its positional argument for repeat acceptance runs.

The operation source is
[`src/tutorials/blender-fundamentals.mjs`](./src/tutorials/blender-fundamentals.mjs)
and the live runner is
[`scripts/run-blender-fundamentals.mjs`](./scripts/run-blender-fundamentals.mjs).
They use only the same nine MCP method contracts available to Codex/ChatGPT.

## Deliberate capability gates

The catalog represents the rest of Blender instead of claiming it works:

- true Collection membership and View Layers;
- context-dependent Edit/Sculpt/Paint modes, automatic UV unwrap/island
  packing, and armatures;
- live evaluation of the complete modifier and constraint sets;
- the remaining Blender shader/texture nodes and Geometry Nodes execution;
- drivers, NLA layers, shape keys, rigging and motion paths;
- rigid body, cloth, fluid, particles and simulation caches;
- compositor nodes, render layers and diagnostic passes;
- external image/asset import, link/append, local overrides and libraries; and
- `.blend` serialization or `bpy` execution.

Those features should be implemented, imported, or baked behind explicit
capabilities. They must never be approximated silently.
