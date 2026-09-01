# Plainform next: persistent natural-language design

Status: proposed contributor design

This document defines a staged extension of Plainform. It is not a statement
that every capability described here is already available. Live
`three_studio_status`, inspect schemas, and operation catalogs remain the
authority for implemented behavior.

## Outcome

Plainform should let a person describe a reusable 3D design, its presentation,
and its game behavior in constrained natural English. Studio should retain the
design as canonical typed data, show exactly what it understood, and regenerate
only the outputs owned by that design.

The intended end-to-end experience is:

1. Author a design in natural English.
2. Preview the parsed intent and estimated cost.
3. Apply it through the ordinary transactional Studio kernel.
4. Inspect or edit named parameters and individual design steps.
5. Regenerate without losing stable identities or unrelated user edits.
6. Use the same project and the same controls in native and browser builds.

The first complete reference design is a realistic pine tree. It exercises
hierarchical growth, semantic surface regions, persistent anchors, grooming,
procedural material detail, composition, and optional game behavior without
requiring unrestricted code.

## Product principles

- **Natural English, bounded meaning.** Sentences should read naturally, but
  every accepted statement must lower to a documented typed operation.
- **The project document stays canonical.** Three.js objects, generated code,
  UUIDs, and runtime graphs remain compiled products.
- **Plainform is a design source, not an alternate mutation path.** All changes
  pass through the existing kernel with revision checks, validation, inverse
  history, recovery, and idempotency.
- **Stable identity is mandatory.** Regeneration must preserve semantic IDs for
  unchanged design parts and report replacements before committing them.
- **Nine MCP tools remain enough.** New behavior belongs in typed operations,
  inspect queries, and catalogs rather than new top-level MCP tools.
- **Native and web stay equivalent.** Both surfaces use the Studio control
  system and the same typed document. Browser-only plumbing may use required
  platform APIs, but it must not become a second editor implementation.
- **Trusted code remains separate.** Ordinary Plainform cannot introduce raw
  JavaScript, WGSL, GLSL, TSL, filesystem access, or unrestricted evaluation.
- **Complexity is visible.** A preview reports affected objects, generated
  resources, topology work, estimated triangles, and validation risks.
- **Failure is atomic.** Compile and validate a candidate before swapping the
  visible result. A failed statement must not leave a half-built design.

## Non-goals

This proposal does not turn Plainform into a general programming language, add
a conventional inspector-heavy browser editor, replace the existing typed MCP
surface, or promise arbitrary CAD/NURBS compatibility. It does not permit an
LLM response to bypass validation merely because the text sounds plausible.

## Current baseline

Plainform already covers a useful set of procedural construction operations:

- primitives, profiles, guides, and lofts;
- dense loft caps and semantic surface regions;
- stable parametric anchors for supported generated surfaces;
- splits, imprints, shells, booleans, constraints, and deformation;
- local relaxation and region subdivision;
- attachment and fair-union operations;
- coordinated eyes and gaze targets;
- hair cards and strand guides;
- a bounded growth planner; and
- creation-oriented shader Plainform.

Those features proved the vocabulary but also exposed architectural limits:

- most meaning is consumed as one-shot text or metadata rather than retained as
  an editable, dependency-aware design;
- the Design compiler has grown into a large ordered regular-expression
  dispatcher, making overlaps and diagnostics increasingly difficult;
- local subdivision is not yet a complete conforming remesh with deterministic
  transition topology;
- evaluated surface queries and anchors are not uniform across every derived
  surface type;
- fair attachment quality depends on the available analytic representation and
  cannot generally guarantee G1 or G2 continuity;
- the growth planner scales templates along simple axes rather than expressing
  biological branching, tropisms, age, and pruning;
- grooming is based mainly on individually authored guides rather than a
  continuous region field with interpolation and density control;
- shader Plainform is stronger at graph creation than safe edits to an existing
  graph;
- there is no complete GameMaker-style event/condition/action dialect; and
- camera, lighting, and composition still require lower-level authoring for
  many common results.

## Target architecture

Plainform processing becomes an explicit compilation pipeline:

```text
source text
  -> tokenizer and statement registry
  -> typed Plainform AST with source spans
  -> semantic resolver and dependency graph
  -> canonical Plainform design resource
  -> typed lowering plan
  -> ordinary core operations
  -> candidate document validation
  -> atomic commit and visible runtime swap
```

Parsing answers *what the person wrote*. Resolution answers *which canonical
project entities it means*. Lowering answers *which existing guarded operations
will implement it*. These phases must remain separately inspectable.

### Canonical design resource

The first schema version stores each design as a typed item in
`resources.assets` with `kind: "plainformDesign"`. This avoids adding a new
manifest bucket while the model settles. A future schema migration may promote
designs to a dedicated collection if real project usage justifies it.

Illustrative shape:

```json
{
  "id": "design.pine",
  "kind": "plainformDesign",
  "schemaVersion": 1,
  "name": "Mountain Pine",
  "source": "Create a mature pine tree named Mountain Pine ...",
  "ast": {
    "dialect": "design",
    "statements": []
  },
  "parameters": {
    "height": { "type": "length", "value": 18, "unit": "m" }
  },
  "dependencies": [],
  "outputs": [
    { "semanticId": "trunk", "projectId": "object.pine.trunk" }
  ],
  "ownership": {
    "mode": "guarded",
    "lastAppliedRevision": 42
  },
  "evidence": {
    "lastPreviewHash": "...",
    "lastAppliedHash": "..."
  }
}
```

The retained source is provenance and an editable representation. The typed AST
and resolved dependency graph are the executable meaning. Loading a project
must never silently reinterpret old source using a newer grammar.

### Stable semantic identity

Every generated output receives an identity derived from:

```text
design ID + statement semantic key + declared part name + deterministic index
```

Source line numbers are not identities. Reformatting or inserting an unrelated
statement must not rename a trunk, branch tier, eye, material, event, or camera.
If a repeated element changes cardinality, the preview reports which semantic
members are retained, added, or retired.

### Ownership and regeneration

Each output is one of:

- `owned`: regeneration may replace the value because Plainform is authoritative;
- `parameterized`: user edits are represented by a named design parameter;
- `detached`: the output remains in the project but no longer regenerates; or
- `referenced`: Plainform may use it but never rewrite it.

Regeneration compares the current project value with the last applied output.
If an owned field was changed outside Plainform, Studio raises a conflict and
offers to keep, overwrite, or detach it. The default is to keep and stop.

### MCP surface

No new top-level tools are required. The existing apply and inspect tools expose
coarse typed operations such as:

- `plainform.design.create`
- `plainform.design.preview`
- `plainform.design.patch`
- `plainform.design.regenerate`
- `plainform.design.detachOutput`
- `plainform.design.resolveConflict`

The final names are defined by the operation catalog when implemented. Preview
may use the existing dry-run path rather than becoming a mutating operation.
Inspect exposes the grammar catalog, parsed AST, dependencies, outputs,
diagnostics, ownership, estimated cost, and last evidence.

### Local model and Prompt workspace boundary

The optional local LLM is a driver of Plainform and MCP, not part of the
compiler and never a privileged mutation path. Native and browser Studio use
the same Prompt workspace controls, message construction, Studio rules, tool
envelope schema, retry limits, and completion handling.

When Prompt workspace is enabled:

1. Studio places its compact system rules first in `messages`.
2. The user prompt and bounded project context follow.
3. The model may return only prose or a typed Studio tool envelope.
4. Every tool envelope passes through the existing MCP harness and kernel.
5. The model receives the resulting bounded observation and may continue only
   within the configured round and token limits.

A downloaded model never receives direct filesystem authority. Project reads
and writes are mediated by Studio operations, native file access requires the
existing explicit picker/permission path, and browser model files remain in
browser-managed storage. Disabling Prompt workspace removes the prompting UI
without changing Plainform compilation, saved designs, or game execution.

## Resource budgets

Plainform uses conservative defaults below the overall Studio guardrails. A
preview may request an explicit higher bounded budget, but it cannot disable the
project limits.

| Area | Default target | Preview must report |
| --- | ---: | --- |
| Source | 32 KiB per design | bytes and statement count |
| AST | 2,000 statements | expanded statement count |
| Generated objects | 2,000 per design | creates, updates, deletes |
| Generated triangles | 500,000 per design | current and projected count |
| Remesh region | 100,000 faces | region, passes, projected faces |
| Growth nodes | 4,096 | depth and node count |
| Groom guides | 20,000 | guides/cards/strands and density |
| Event actions | 1,000 per event sheet | events, conditions, actions |
| UI controls | 1,000 per form set | windows, controls, bindings, tab order |
| Regeneration | 2 seconds planning target | timing by compiler phase |

## Staged implementation

Each stage is independently shippable, keeps legacy Plainform working, and has
an explicit acceptance gate.

### Stage 0 — freeze and map the current grammar

Goal: make the existing language measurable before changing its parser.

1. Assign a stable statement kind to every supported sentence family.
2. Record precedence, aliases, accepted units, outputs, and lowerings.
3. Generate a machine-readable grammar catalog from the registry.
4. Add ambiguity fixtures for sentences currently captured by multiple patterns.
5. Add corpus tests proving that existing accepted examples still lower to the
   same operations.

Deliverables:

- a statement registry split by design domain;
- a generated grammar/operation cross-reference;
- golden tests for the existing Plainform corpus; and
- deprecation diagnostics for accidental or ambiguous aliases.

Acceptance gate: no project or visual output changes for the existing corpus.

### Stage 1 — typed AST, source spans, and semantic keys

Goal: replace opaque match-and-run parsing with inspectable typed intent.

1. Tokenize names, numbers, units, references, lists, and clauses with exact
   source spans.
2. Parse each registered statement into a typed node before lowering it.
3. Require every node to declare its semantic key, inputs, outputs, and cost
   estimator.
4. Produce structured diagnostics with error code, sentence span, expected
   forms, and one bounded correction example.
5. Retain a legacy parser fallback during migration and emit parity metrics.

Example AST node:

```json
{
  "kind": "surface.subdivideRegion",
  "semanticKey": "face.cheeks.detail",
  "surface": { "ref": "face" },
  "region": { "ref": "cheeks" },
  "levels": 2,
  "transition": "conforming",
  "span": { "start": 184, "end": 260 }
}
```

Acceptance gate: every migrated statement can be inspected before apply and
lowers identically to its legacy equivalent.

### Stage 2 — persistent designs and guarded regeneration

Goal: make Plainform editable after the first apply.

1. Add the versioned `plainformDesign` asset schema.
2. Store source, typed AST, named parameters, dependencies, semantic output map,
   ownership state, and compiler version.
3. Add preview, create, patch, regenerate, detach, and conflict-resolution
   operations through the ordinary command bus.
4. Compute a deterministic design hash and lowering-plan hash.
5. Track the last applied value for every owned field.
6. Make save, recovery, undo/redo, duplication, import, and export preserve the
   design resource and semantic mappings.

Natural-English edit examples:

```text
Set Mountain Pine height to 22 metres.
Make the lower branch tiers 15 percent longer.
Replace the bark material with Rugged Bark.
Detach the hero branch from Mountain Pine.
Regenerate Mountain Pine.
```

Acceptance gate: changing height regenerates a saved/reloaded tree with the
same trunk and surviving branch IDs; an external conflicting edit is never
silently overwritten.

### Stage 3 — conforming local remeshing and relaxation

Goal: support detailed local deformation without cracks, non-manifold edges, or
unbounded whole-mesh subdivision.

1. Represent semantic regions as stable face sets with a boundary loop.
2. Add deterministic edge split, collapse, and flip primitives.
3. Add conforming transition rings between refined and untouched topology.
4. Constrain boundary, crease, seam, anchor, and material-border vertices.
5. Add tangential relaxation with shrinkage compensation.
6. Reproject relaxed vertices onto the source evaluated surface.
7. Validate manifoldness, winding, minimum area, aspect ratio, and anchor drift.
8. Preserve or deterministically remap UVs, normals, skin weights, and semantic
   regions for every topology change.

Natural-English examples:

```text
Subdivide the cheek region of Face twice with a conforming transition.
Relax the cheek region for 8 passes while preserving its boundary and volume.
Remesh the nose region to an edge length of 3 millimetres.
```

Acceptance gate: a selected facial region may be refined and relaxed with no
boundary cracks, no non-manifold edges, deterministic topology, and bounded
anchor/UV error.

### Stage 4 — shared evaluated surfaces and persistent anchors

Goal: give every derived surface one query model for position, tangent frame,
normal, UV, region membership, and ancestry.

1. Introduce an internal evaluated-surface interface used by lofts, revolutions,
   sweeps, shells, remeshes, deformations, booleans, and fair transitions.
2. Store anchors in semantic coordinates where possible: surface ID, region,
   `(u, v)`, orientation mode, offset, and ancestry token.
3. When topology changes, resolve anchors against the regenerated semantic
   surface rather than a transient vertex index.
4. Fall back to a bounded nearest-surface projection only when semantic ancestry
   is unavailable, and report the fallback and distance.
5. Make deterministic UV generation part of every derived surface contract.
6. Expose anchor health through inspect: exact, remapped, projected, or broken.

Natural-English examples:

```text
Anchor the left nostril to Nose at 32 percent across and 58 percent upward.
Keep the eyebrow 6 millimetres above the Brow surface after regeneration.
Align each needle cluster to the branch surface normal.
```

Acceptance gate: anchors survive parameter changes, local remeshing, project
save/reload, and deterministic regeneration within declared tolerance.

### Stage 5 — fair transitions and continuous attachment

Goal: join separately authored forms using explicit, testable continuity.

1. Extract compatible boundary loops from semantic regions or cut surfaces.
2. Resample loops deterministically to compatible correspondence.
3. Build a transition strip with selectable positional, tangent, or curvature
   continuity targets (`G0`, bounded `G1`, and supported `G2`).
4. Solve with constrained iterations and a strict time/iteration budget.
5. Validate self-intersection, inversion, thickness, and deviation.
6. Fall back atomically to a lower requested continuity only when the sentence
   explicitly allows it; otherwise refuse.

Natural-English examples:

```text
Join Nose to Face across Nose Base with tangent continuity.
Fair the trunk into Root Flare over 40 centimetres while preserving volume.
Union each major branch into the trunk with a smooth 3-ring collar.
```

Acceptance gate: canonical facial-part and branch-collar fixtures meet their
declared continuity tolerances and regenerate deterministically.

### Stage 6 — botanical growth and branching

Goal: make natural trees and plants a first-class bounded procedural design,
not a large hand-authored list of cylinders.

The growth model is deterministic and data-driven. It combines a trunk curve,
branch hierarchy, age profile, taper, phyllotaxis, tropisms, pruning envelope,
environment cues, and seeded variation. It lowers to ordinary guides, profiles,
lofts/sweeps, instances, regions, and materials.

1. Add typed botanical parameters: age, height, trunk taper, whorl spacing,
   branching order, apical dominance, gravity response, light response,
   phototropism direction, pruning envelope, asymmetry, and seed.
2. Generate a semantic skeleton before geometry.
3. Assign stable path identities such as `trunk`, `tier.04.branch.02`, and
   `tier.04.branch.02.child.03`.
4. Generate branch collars through Stage 5 rather than intersecting cylinders.
5. Add controlled deadwood, broken tips, and sparse-zone masks.
6. Separate structural geometry from instanced foliage so level of detail can be
   selected by the renderer without changing design identity.
7. Expose a dry-run growth report before geometry generation.

Natural-English example:

```text
Create a mature mountain pine named Mountain Pine, 18 metres tall and about
70 years old. Give it a straight tapered trunk, irregular whorled branches,
strong upward growth near the crown, long slightly drooping lower limbs, a
sparse shaded side to the north, and seed 1847. Keep the crown asymmetrical and
inside a 9 metre envelope.
```

Acceptance gate: the pine fixture has a stable semantic skeleton, plausible
taper and branch hierarchy, bounded object/triangle counts, no detached branch
collars, and identical output for the same seed.

### Stage 7 — region grooming, foliage, and deterministic detail

Goal: describe dense repeated surface detail without individually authoring
every strand, card, needle, or clump.

1. Add a groom field over a semantic region with direction, density, length,
   width, bend, clumping, noise, exclusions, and seed.
2. Interpolate authored guide curves across the field.
3. Support bounded outputs: cards, curve strands, instanced meshes, or guide-only
   data selected by capability and budget.
4. Add botanical foliage clusters with species-style radial needle placement,
   age/season variation, and branch-tip density falloff.
5. Generate deterministic UV/detail coordinates for cards, strands, bark bands,
   and every derived surface.
6. Preserve semantic attachment to the parent surface through regeneration.

Natural-English examples:

```text
Groom short swept-back hair over Scalp using 24 guides, medium clumping, and
seed 91; exclude the forehead and ears.
Place clusters of 9 centimetre pine needles along second- and third-order
branches, denser near healthy tips and absent from deadwood.
Generate cylindrical bark coordinates along the trunk and branch hierarchy.
```

Acceptance gate: guide edits update the interpolated field predictably; every
generated element has deterministic parent, identity, attachment, and detail
coordinates.

### Stage 8 — guarded semantic material and shader editing

Goal: create and revise materials in the same language without exposing raw
shader code.

1. Parse semantic graph edits into the existing typed graph operations.
2. Address nodes by stable graph IDs and semantic roles rather than UI position.
3. Add bounded operations for insert, connect, disconnect, replace, expose
   parameter, set value, and remove-if-unused.
4. Type-check sockets and compile a candidate graph before commit.
5. Add material presets as catalog data, not hard-coded parser branches.
6. Preserve explicit user nodes and raise ownership conflicts on regeneration.

Natural-English examples:

```text
Create Rugged Bark from brown albedo noise, vertical ridges, dark crevices, and
subtle roughness variation at a 12 centimetre scale.
In Rugged Bark, make the ridges 20 percent narrower and expose Bark Age.
Connect Needle Variation to needle color only, not roughness.
```

Acceptance gate: create/edit/regenerate survives save/reload, rejects invalid
socket types before commit, and never accepts raw TSL/WGSL/GLSL.

### Stage 9 — GameMaker-style event Plainform

Goal: make object behavior readable as events, conditions, and ordered actions
while retaining the existing bounded behavior runtime.

Each event sheet is canonical typed data. A row contains an event trigger,
optional conditions, and ordered actions. Actions lower to the existing Action
or blueprint subsets; they are not arbitrary code.

1. Define event types such as Create, Step, Draw, key/button input, pointer,
   collision, timer, message, and destroy where supported by the runtime.
2. Define typed condition expressions with bounded comparisons and logical
   grouping.
3. Define an action catalog for movement, animation, state, spawning, audio,
   messages, scene changes, and supported Studio operations.
4. Give every event, condition, and action a stable ID and editable label.
5. Keep action order explicit and show unavailable native/web capabilities.
6. Use the same event-sheet window and controls in native and browser builds.
7. Stop keyboard events at focused text controls before they reach the 3D canvas;
   multiline editing retains selection, clipboard, undo/redo, navigation, IME,
   and platform shortcuts.

Natural-English examples:

```text
For Player, when Left is held, move left at 5 metres per second.
When Player collides with Pine Trunk, stop horizontal movement.
When the tree receives Chop with strength at least 3, add 1 to Damage and play
the bark-hit animation. If Damage reaches 10, send Tree Fell once.
```

Acceptance gate: the same saved event sheet runs deterministically in native
and browser Play mode, with focus-safe text input and no raw code path.

### Stage 10 — retained windows, forms, and dialogs

Goal: author WinForms-style game and tool interfaces with the same retained
control system in native and browser Studio.

Forms are canonical typed resources, not HTML documents. A form owns a stable
control tree, layout rules, style references, accessibility labels, tab order,
and event bindings. Native and browser hosts render the same control model;
DOM-backed primitives are permitted only inside the browser platform adapter
when required for text input, accessibility, clipboard, IME, or file pickers.

1. Define form/window types: ordinary window, modal dialog, tool panel, overlay,
   menu, and supported system picker requests.
2. Define a bounded control catalog: panel, stack/grid layout, label, button,
   checkbox, radio group, single-line input, multiline input, number input,
   list, tree, tabs, progress, image, and viewport host.
3. Give every form and control a stable ID, editable name, properties, layout
   constraints, and compatible component list.
4. Bind control events to Stage 9 event sheets rather than inline callbacks.
5. Keep input focus, selection, clipboard, undo/redo, keyboard navigation, IME,
   validation, scroll, and multiline behavior inside the shared control contract.
6. Stop handled keyboard and pointer input before it reaches the 3D canvas.
7. Expose component presence, compatibility, and validation as inspectable data;
   expanding a component column must not collapse the scene tree.
8. Preview modal ownership, focus restoration, escape/default buttons, and
   unsupported platform behavior before apply.

Natural-English examples:

```text
Create an Inventory window with a two-column layout, an item tree on the left,
details on the right, and Use and Close buttons along the bottom.
When Close is clicked, close Inventory. When an item is selected, show its name,
description, weight, and icon in the details panel.
Create a modal Save Game dialog with a multiline notes box. Enter adds a line;
Control+Enter confirms only when a slot is selected.
```

Acceptance gate: one saved form tree renders and behaves equivalently in native
and browser hosts, event bindings use canonical event sheets, text controls do
not leak input to the canvas, and no browser-only editor document is created.

### Stage 11 — camera, lighting, and composition

Goal: let a design produce a deliberate, repeatable presentation and useful
evidence frame.

1. Add bounded camera composition statements for subject framing, angle,
   distance, lens, depth of field, and look target.
2. Add semantic light-rig statements for key/fill/rim/environment with physical
   units where the renderer supports them.
3. Add ground, backdrop, fog, time-of-day, and exposure as typed presentation
   resources.
4. Resolve composition against semantic bounds and anchors rather than transient
   object UUIDs.
5. Make native and browser fallbacks explicit in preview diagnostics.

Natural-English example:

```text
Frame the whole pine from slightly below at a 50 millimetre lens. Use late
afternoon sun from camera left, soft blue sky fill, a dry grass ground, and
enough depth of field to keep the trunk and crown sharp.
```

Acceptance gate: the same composition resolves to equivalent subject framing
in native and browser renderers within documented renderer differences.

### Stage 12 — visual benchmarks and regression gates

Goal: measure whether added vocabulary actually improves authored results.

1. Add small canonical designs: face patch, eye assembly, hair groom, branch
   collar, pine tree, shader edit, event sheet, and hero composition.
2. Store source, expected AST, dependency graph, topology metrics, semantic IDs,
   and approved evidence views.
3. Run parser/lowering fixtures in ordinary tests.
4. Run deterministic document comparisons without requiring a GPU.
5. Run native visual acceptance separately: launch the external runtime, apply
   through the real MCP path, capture the exact window/frame, and inspect it.
6. Use perceptual images only as supporting evidence; topology, identity,
   validation, and document invariants remain hard gates.

Acceptance gate: a change cannot silently alter grammar meaning, stable IDs,
generated topology, budgets, or the approved reference composition.

## Diagnostics contract

Every diagnostic has:

- a stable code such as `PLAINFORM_UNKNOWN_REFERENCE`;
- severity: information, warning, conflict, or error;
- exact source span and statement semantic key;
- plain-English explanation;
- relevant resolved project IDs;
- expected sentence shapes or legal catalog values; and
- at most one safe automatic correction, shown before it is applied.

Diagnostics must not encourage unconstrained retries. For example:

```text
PLAINFORM_CONTINUITY_UNAVAILABLE at sentence 8, "curvature continuity":
the selected trunk and root-flare boundaries do not provide compatible second
derivatives. Use tangent continuity, or subdivide both boundary regions first.
No project changes were made.
```

## Compatibility and migration

1. Existing one-shot Plainform remains accepted during the AST migration.
2. Legacy input is parsed with a pinned grammar version and immediately lowered
   through the same typed plan used by persistent designs.
3. A saved design stores its grammar and schema versions; project load never
   silently reparses it with current rules.
4. Grammar upgrades are explicit migrations that show AST and output diffs.
5. Removed aliases remain readable for old projects but produce deprecation
   diagnostics in newly authored source.
6. Designs may be detached into ordinary project resources when a user no longer
   wants parametric regeneration.

## Verification strategy

Verification is layered so most failures are cheap to diagnose:

1. **Parser tests:** source to typed AST, spans, ambiguity, units, diagnostics.
2. **Lowering tests:** AST to exact typed operation plan and cost estimate.
3. **Kernel tests:** apply, idempotency, revision guard, inverse history,
   recovery, conflicts, save/reload, and deterministic semantic IDs.
4. **Geometry/graph tests:** manifoldness, continuity tolerance, UV/anchor
   stability, socket typing, growth budgets, and event determinism.
5. **Native acceptance:** real MCP authoring, external runtime launch, exact
   viewport/GPU capture where applicable, and visual inspection.

Browser tests reuse the same documents, controls, compiler fixtures, and event
sheet fixtures. Platform-specific tests cover only the actual browser boundary:
worker/model lifecycle, download persistence, permission gates, input focus,
file handles, and renderer capability fallback.

## Delivery order

The recommended release sequence is:

1. Stages 0–1: parser architecture and parity, with no output changes.
2. Stage 2: persistent design resources and guarded regeneration.
3. Stages 3–5: topology, surfaces, anchors, and fair attachment.
4. Stages 6–7: botanical growth and region-based grooming/foliage.
5. Stage 8: semantic graph editing.
6. Stage 9: event/condition/action design.
7. Stage 10: retained windows, forms, and dialogs.
8. Stage 11: presentation design.
9. Stage 12: promote reference designs to release gates.

Stages 0–2 are architectural prerequisites. Geometry stages may then progress
in parallel by typed operation family, but a feature is not complete until it
participates in persistence, preview, ownership, diagnostics, and regeneration.

## First implementation slice

The first code change should deliberately be smaller than the full roadmap:

1. Introduce a tokenizer that retains exact source spans.
2. Define the common AST envelope and statement registry interface.
3. Migrate one representative statement from each existing domain: primitive,
   profile/guide, loft, region operation, groom, eye assembly, growth, and shader.
4. Generate a grammar catalog from those registrations.
5. Keep the current dispatcher as a fallback for unmigrated statements.
6. Add AST inspection and old/new lowering parity tests.
7. Do not change the project schema or rendered output in this slice.

This provides a safe seam for later work and tests the architecture against the
actual breadth of Plainform before committing to persistent schema details.

## Definition of complete roadmap

The roadmap is complete when a user can create the pine reference design, save
and reopen it, edit named botanical and material parameters, regenerate it with
stable semantic identities, inspect its rules and dependencies, add a bounded
event sheet and retained control form, and reproduce its camera/light
composition in native and browser Studio. The full path must use the existing
MCP boundary and transactional kernel, remain inside reported budgets, preserve
unrelated manual edits, and produce evidence through the real runtime rather
than a preauthored generator.
