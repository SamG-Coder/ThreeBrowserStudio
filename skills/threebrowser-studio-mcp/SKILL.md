---
name: threebrowser-studio-mcp
description: Author, inspect, render, validate, animate, and save Three.js WebGPU projects in the native ThreeBrowser Studio through its real three_studio_* MCP tools. Use whenever Codex is asked to build or edit a ThreeBrowser Studio scene, material, Blender-style shader or texture graph, animation, lighting setup, camera, or project; to reproduce a visual reference in Studio; or to perform a visible/recorded LLM-first build. This skill forbids substituting preauthored JavaScript scene generators, direct bridge calls, or script playback for MCP authoring.
---

# ThreeBrowser Studio MCP

Use the native Studio viewport as the shared canvas and the nine
`three_studio_*` MCP tools as the sole project-authoring interface.

## Non-negotiable authoring boundary

- Make every project read or mutation through `three_studio_status`,
  `three_studio_project`, `three_studio_inspect`, `three_studio_apply`,
  `three_studio_validate`, `three_studio_render`, `three_studio_play`,
  `three_studio_history`, or `three_studio_job`.
- Never author by running a tutorial module, operation-list generator, bridge
  client, `studio-call` helper, JavaScript scene builder, or recorded macro.
- Do not translate a finished JavaScript scene into one MCP batch. Decide and
  author each stage from the live project state and the latest visual evidence.
- Shell access may launch Studio, OBS, or tests. It must not read, write, or
  mutate a Studio project behind MCP.
- Do not use raw `eval`, JavaScript, WGSL, or GLSL as a scene-authoring escape
  hatch. Use supported typed resources and the live graph catalog.

## Connect and establish authority

1. Ensure the native Studio runtime is open. If the user wants a recording,
   start and verify recording before the first project or authoring call.
2. Call `three_studio_status` first. Treat its capabilities, limits, revision,
   project identity, and tool schemas as authoritative.
3. If a requested capability is false or missing, state the boundary and build
   the best honest supported result. Never claim RTX, scripting, physics,
   export, or gameplay when status does not expose it.
4. Create or open the intended project with `three_studio_project`. For a new
   live build, use a fresh meaningful project path so the viewport begins from
   an honest empty/starter state.
5. Inspect the active scene, current revision, and only the bounded catalog or
   resources needed for the next decision.

## Build visibly and incrementally

Work in semantic stages that a viewer can follow, for example composition,
primary forms, secondary forms, materials, shader graphs, lighting, dressing,
animation, and final camera. The subject determines the actual stages.

For every stage:

1. Inspect the entities, resources, bounds, references, or graph catalog needed
   to make the next choice.
2. Send one labelled, coherent `three_studio_apply` changeset using the latest
   base revision and a new idempotency key.
3. Use meaningful stable IDs. Use aliases only for objects created and consumed
   atomically in the same changeset.
4. Keep a live demonstration human-legible: prefer a few related objects or one
   resource family per apply instead of hiding the build in a huge transaction.
   Do not add artificial sleeps; real model and MCP time is the timing.
5. Read all diagnostics and the returned revision. Resolve errors before adding
   more detail.
6. Inspect compiled bounds or the changed slice. Render a WebGPU beauty capture
   after every visually meaningful stage and actually examine the image.
7. State the concrete visual observation that motivates the next stage. If the
   render contradicts the plan, revise the scene through another MCP changeset.

Dry-run destructive changes, graph-resource changes, and unusually large
batches. Inspect a subtree and its guard hash before recursive deletion. Never
delete a referenced resource without resolving its references in the same
transaction.

## Blender-style materials and graphs

- Call `three_studio_inspect` with `query: "graphCatalog"` and the relevant
  shader or texture domain before every graph-authoring pass. Treat the
  returned node/socket catalog plus `authoring.canonicalEnvelope` and
  `authoring.edgePortShape` as authoritative. Never guess node types, sockets,
  ports, or RNA IDs.
- Author graph creates through `three_studio_apply` with plural
  `resourceType: "graphs"` and the graph document nested under
  `resource.graph`. Use this canonical operation shape:

  ```json
  {
    "op": "resource.create",
    "resourceType": "graphs",
    "resource": {
      "id": "graph/example",
      "kind": "graph",
      "name": "Example Graph",
      "metadata": {},
      "graph": {
        "formatVersion": 1,
        "id": "graph/example",
        "domain": "shader",
        "nodes": [],
        "edges": [],
        "outputs": {}
      }
    }
  }
  ```

  Preserve the envelope `id`, `name`, `kind`, and `metadata` when patching.
  Do not author a flat graph resource even when compatibility normalization
  would accept one.
- Put Blender socket values in `node.inputs`, node configuration in `params`,
  and connections in `edges`, following the returned catalog exactly. Every
  edge endpoint is an object containing both the node ID and exact catalog port:

  ```json
  {
    "from": { "nodeId": "source-node", "port": "outputPort" },
    "to": { "nodeId": "target-node", "port": "inputPort" }
  }
  ```

- Immediately call `three_studio_validate` after every graph create or patch,
  before assigning it to a material or continuing the build. A graph must
  validate even while unused; never rely on a later material reference to
  expose malformed envelopes, nodes, edges, outputs, or ports.
- Use sRGB only for display colour. Use no colour space for numeric data such
  as masks, roughness, normal, metalness, and height.
- Keep graphs acyclic and within reported budgets. Candidate compilation must
  succeed before assigning a graph-backed material.
- Preserve saturation intentionally. Judge colour from the render evidence,
  not parameter names alone, and correct lighting/exposure before compensating
  with destructive colour shifts.

## Composition, animation, and play

- Use metres, radians, and seconds.
- Place dependent objects only after inspecting compiled bounds.
- Frame evidence from an exact camera or explicit subject bounds.
- Create animation resources through MCP, validate them, then use
  `three_studio_play` to enter, seek, or step. Report only the behavior actually
  exposed by status.
- Keep authored shaders active in Author and Play modes; do not model quality
  as an on/off preview toggle.

## Verify and save

1. Run `three_studio_validate` after graph, hierarchy, reference, animation, or
   other topology changes, and again before completion.
2. Confirm graph-backed materials are visibly active in the native viewport;
   schema validation or successful candidate compilation alone is not visual
   verification.
3. Render the committed revision at a useful final resolution and inspect the
   returned WebGPU image, not just its metadata. Follow the render with
   `beautyDigest` for file/pixel hashes, clip/black/mean luma, exact `(x,y)`
   probes, and an optional capture-to-capture diff. A byte-identical PNG after
   a `nodeInputs` patch means the socket is not in the live TSL subset or the
   delta is below 8-bit, not that the document failed to patch. Principled
   `sheenWeight` / `sheenRoughness` / `sheenTint` compile live.
4. Use `projectVisibility` before editing an object that may be off-screen.
   Use `meshFilter` on `meshElements` instead of paging an entire cloth. Read
   `graphDigest` `sockets` (authored vs default vs edge); `inputs.$summary`
   is display truncation. Patch one socket with `resource.patch` `nodeInputs`.
   `modifierDigest` accepts a group and returns descendant mesh stacks.
5. Inspect final scene/resource counts and `latestEvidence`, and confirm that
   the evidence revision and camera match the native viewport result being
   claimed.
6. Save with `three_studio_project` only after validation and visual review.
7. For a recorded build, stop recording only after the final evidence and save
   are visibly complete. Preserve the resulting video path in the handoff.

Completion means the fresh project can be reopened, validation passes, and the
final render visibly supports the claim. A successful tool response alone is
not visual completion.
