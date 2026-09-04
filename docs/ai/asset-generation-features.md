# Asset-generation capabilities

Use the nine Studio MCP tools and the normal
inspect/apply/validate/render/save loop to author assets. The live status and
catalogs define supported operations and budgets. The native renderer is WebGPU.

## Editable panels and shells

`solidify` and `subdivision` are live on `editableMesh` geometry. They operate on
shared geometric topology before render vertices split at UV, material, color,
or hard-normal seams. Each UV/color corner layer remains independently editable.

- `solidify`: thickness and offset create inner and outer skins plus closed rim
  walls at actual open boundaries. Rims inherit adjacent face materials and
  colors and receive separate world-unit UV strips.
- `subdivision`: `scheme: "loop"` smooths actual geometry; `scheme: "simple"`
  splits triangles without changing the original surface. `levels` is 1–6,
  subject to output budgets. Sharp edges are full creases; normalized crease
  weights persist across levels.
- Order topology stages before weighted normals, edge splitting, and Ocean.
  Invalid ordering reports the blocked modifier and previews only the supported
  prefix of the stack. Reorder the stack to evaluate all intended stages.
- The output must remain within the reported vertex/triangle budget and the
  8-million-value corner-attribute budget. Non-manifold edges, bow-tie vertices,
  inconsistent winding and loose vertices are rejected.

GLB export uses the same editable topology stage and retains material groups,
UVs and vertex colors. Shell offsets use averaged surface normals; this is not
an even-thickness or self-intersection solver. Subdivision is Loop/simple,
not Catmull-Clark. Adding thickness does not automatically cut openings.

## Importing a local GLB

`three_studio_job` accepts `action: "sceneImport"` with:

```json
{
  "action": "sceneImport",
  "sourcePath": "C:/Assets/model.glb",
  "expectedFileSha256": "<actual SHA-256 of the selected file>",
  "sceneId": "scene/imported-model",
  "idPrefix": "asset/imported-model",
  "name": "Imported model",
  "dryRun": true
}
```

Supply the normal session, project, baseRevision, idempotencyKey and label.
The scene ID and generated resource/entity IDs must be unused. Inspect the
preview, then repeat with `dryRun: false` and the returned `candidateToken`.
Import creates and activates a new scene in one kernel transaction. It retains
the existing project scenes and supports normal undo, recovery and save.

The subset is self-contained GLB 2.0 rigid triangle meshes, shared geometry,
hierarchy, local transforms, normals, UV set 0, RGB/RGBA vertex colors, PBR
factors, and embedded non-interlaced 8-bit RGB/RGBA PNG maps. Supported material
extensions are clearcoat, IOR and transmission. Texture color roles and sampler
settings are retained. Source provenance records the filename and content hash;
machine-local source paths do not enter the project.

Limits include 64 MiB input, 4 MiB JSON, 4,096 source nodes, 8,192 generated
entities, 2,048 unique primitives, one million vertices, two million triangles,
and the existing 512-pixel inline texture and aggregate texture budgets. Skins,
animation clips, morph targets, sparse accessors, compressed geometry, JPEG,
external URIs and additional UV sets are rejected. Camera/light presentation,
optional unsupported extensions and derived tangent frames are reported in job
warnings. No URL or companion file is fetched.

## Accurate capability feedback

Blueprint graph digests now trace execution from event roots and then include
their data dependencies. Implemented controller sockets report live runtime
support; catalog-only nodes remain unavailable. Conditional controller changes
forecast `unknown` with a runtime-dependent reason, since visible results depend
on Play state and input. Parameter changes and equal-count edge rewires are
detected. Node layout changes do not predict pixel changes.

`entity.component.attach` and `entity.component.remove` use the known component
catalog, accept canonical camelCase names such as `rigidBody`, and pass through
the kernel with validation and inverse history.

## Capability limits

The current catalog does not implement general CAD trimming/filleting, Catmull-Clark,
automatic LOD authoring, arbitrary image/model formats, skeletal animation
import, or full material-graph baking. Do not infer support from a familiar
operation name: inspect the live capability and validate the resulting asset.
