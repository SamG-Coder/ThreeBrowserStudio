# Blender concepts in ThreeBrowser Studio

ThreeBrowser Studio adopts Blender's durable authoring concepts without
copying Blender's panel UI or pretending Three.js is Cycles. The editor remains
LLM-first: every mutation names exact stable IDs, every batch is atomic, and no
operation depends on selection, mode, mouse position, or the active editor.

The machine-readable source of truth is
[`src/blender/catalog.mjs`](./src/blender/catalog.mjs). It covers 37 domains and
labels each one `implemented`, `partial`, `planned`, `bake-required`, or
`not-applicable`. Query it live with:

```json
{
  "query": "blenderCatalog",
  "selector": { "kind": "modifiers" },
  "limit": 8
}
```

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
| Mesh data | Shared geometry resource | Procedural and explicit indexed meshes |
| Materials | Shared basic/standard/physical/toon resource | Scalar PBR plus supported live node graphs |
| Modifier stack | `entity.components.modifiers[]` in authored order | Array and Mirror; other kinds stay bake boundaries |
| Constraint stack | `entity.components.constraints[]` in authored order | Aim/copy/limit subset |
| Action/F-curves | Animation resource with stable target/property tracks | Frame/second keyframes and four interpolations |
| Geometry Nodes | Typed graph IR | Validation only |
| Shader Editor | Typed shader graph IR | Blender RNA core compiles to TSL/WebGPU; unsupported nodes fail explicitly |
| Compositor/View Layers | Future render graph and named passes | Beauty pass only |
| Physics | Future solver adapter or baked Actions | Not executed |
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
- explicit/indexed buffer geometry.

This is enough to translate many beginner modeling exercises without inventing
a fake Edit Mode. Topology operations such as arbitrary loop cuts, inset,
dissolve and sculpting need a real editable mesh kernel or a bake job.

Blender defines modifiers as ordered, non-destructive operations evaluated
top-to-bottom. Studio preserves that model in canonical data and currently
executes bounded Array and single-axis Mirror stacks as deterministic instance
matrices. Unsupported modifier kinds remain visible and produce a
`runtime_modifier_bake_required` warning instead of being ignored. See
[Blender's modifier stack](https://docs.blender.org/manual/en/latest/modeling/modifiers/introduction.html).

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

The pinned Blender 5.2 inventory distinguishes 115 current Add-menu entries,
100 direct `ShaderNode` API subclasses, API-only and legacy nodes, and 36 live
TSL nodes. `NodeFrame` plus bounded node layout metadata preserve tutorial
organization; numeric `NodeReroute` executes as a typed pass-through. Engine
closures, world/volume outputs, and context-specific nodes remain catalogued
with explicit candidate-compile failure until their runtime contract exists.

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
- topology-aware Edit/Sculpt/Paint modes, UV authoring and armatures;
- the complete modifier and constraint sets;
- shader/texture/Geometry Nodes compilation and Blender-specific nodes;
- drivers, NLA layers, shape keys, rigging and motion paths;
- rigid body, cloth, fluid, particles and simulation caches;
- compositor nodes, render layers and diagnostic passes;
- asset import, link/append, local overrides and external libraries; and
- `.blend` serialization or `bpy` execution.

Those features should be implemented, imported, or baked behind explicit
capabilities. They must never be approximated silently.
