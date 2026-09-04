# Action plan: Plainform assembly, rigs, and agent docs

Status: implemented (P0 docs, P1 assembly sentences, P2 compiler tests).
P3 interiors remain later. Source jeep:
`projects/projects/plainform-realistic-jeep-20260902`.

This is not a request for jeep-specific nouns. The jeep was a
manufactured-form + transform-rig exercise. Live `three_studio_status`
and `AGENT_RULES.md` still win.

## What succeeded

Design Plainform already does the **envelope**:

- `using the right-up-forward design frame` placed a 2-door Wrangler-scale
  body in world metres without a manual root rotation.
- One symmetric profile plus **positional** (not curvature) loft sections
  produced a readable hood / windshield / cabin break. Curvature would have
  turned it into a van.
- Semantic cylinder alignment (`along the right axis`, `along the forward
  axis`) is the right primitive language for axle tubes and lamp barrels.
- `material.look.create` plus `using material …` on generated parts is
  enough for paint, rubber, steel, glass, and lamps.
- Object-dialect grouping exists: `Put the canopy leaves into a group
  called "Canopy" with id entity/tree/canopy` lowers to world-preserving
  `entity.group`.
- Typed Actions on group rotations (`transform.rotation`) are enough to
  prove a rig: knuckle yaw, spin-group roll, steering-pivot turn.

The live window showed a boxy olive jeep, seven-slot grille, round lamps,
and front wheels that actually steered at timeline frame 24.

## What failed

Classified so we do not “fix English” when the compiler is honest, or
extend the compiler when the docs were silent.

| Outcome | Class | What actually happened |
| --- | --- | --- |
| Working axle | **language gap** | Design emits every solid as a mesh child of the design root. There is no empty pivot group, no parent clause, and no local-axis contract. The jeep rig was typed MCP after the fact. |
| Steering wheel | **language + bound** | No Design torus/lathe. The wheel was a typed torus parented to a world-identity group. It animated, but it sat *inside* the watertight body loft so a cabin camera saw only olive solid. |
| Wheel wells | **honest bound** | Pinch on the loft barely dented the tub. CSG on a curved loft is 64 triangles. Box flares looked like black bricks. Docs already say prove an annulus first; they do not say “do not CSG the body loft.” |
| Second design root | **docs + language** | `Design a vehicle called Jeep Details…` created `entity/jeep-details` beside `entity/jeep`. Two roots, two `Rx(-π/2)` frames. There is no `continue design entity/jeep`. Notes say “do not stack failed roots”; they do not say a *successful* follow-up Design is still a sibling. |
| Group origin | **language gap** | Object `Put … into a group` supplies `{id, kind, name}` only. Pivot is parent origin. Axles need the group origin at the axle centre. That required typed `entity.group` with an explicit `transform`. |
| `entity.reparent` | **docs gap** | Reparent keeps local TRS. It does **not** preserve world pose. Only `entity.group` / `entity.ungroup` do. The jeep path used group-with-explicit-origin because reparent would have thrown wheels by 90°. |
| Design-root children as animation targets | **docs gap** | Root rotation is `[-π/2, 0, 0]`. Local X of a child is world X, local Z is world Y. Steering around “Y” on a design-root child yaws around world −Z. Notes §2 explain the remap for *authoring*, not for *rigs*. |
| Interior occupancy | **docs gap** | Notes §3 already say Design lofts are capped solids. The jeep still put the column inside the loaf. Cabin evidence required hiding the body. |
| Hybrid authoring | **docs gap** | Skill + `plainform.md` never show the split: Design for the envelope, typed groups for the rig, Actions for motion. The agent invented that split live. |
| Grouping hashes | **docs gap** | `expectedEntitySetHash` is of the ID set and changes after a prior group. Sequential knuckle → axle grouping cannot share a pre-inspected hash across applies without re-inspect. |

## Priority order

Do documentation first. The jeep already compiled; the next vehicle run
should not rediscover the same traps. Extend the language only where a
generic manufactured assembly cannot be said in existing sentences.

### P0 — Docs (no compiler change)

1. **Skill `references/plainform.md`**
   - Document Object grouping with an explicit origin example, or state
     that origin is parent-origin only and typed `entity.group.transform`
     is required for a pivot.
   - Document that `entity.reparent` is local-TRS and is the wrong tool
     for assembling a rig.
   - Add a short “assembly vs envelope” note: a Design root is a
     manufacture group, not a vehicle rig.
2. **`docs/ai/plainform-authoring-notes.md`**
   - Add the vehicle/rig heads already appended as §13.
   - State the animation-axis consequence of `Rx(-π/2)` in one table.
3. **`docs/ai/patterns.md` §7**
   - One paragraph: world-preserving group with authored pivot versus
     reparent; do not parent animation pivots under a semantic design
     root unless the local axes have been inspected.
4. **`AGENT_RULES.md` (one bullet under Design Plainform)**
   - Empty transform groups and world-identity pivots stay typed MCP
     until a Design sentence exists. Do not claim a mesh under the
     design root is a working axle.

Acceptance: a later agent can author a wheeled vehicle without
re-deriving the design-root Euler trap from source.

### P1 — Language, generic assembly (compiler)

Keep nouns generic. Do **not** add `Create a jeep`, `Create an axle`, or
`Create a steering wheel`.

1. **Empty pivot group in Design**
   Proposed sentence:
   ```text
   Create a group called Front Hub with id entity/hub-fl,
   centred at [82 centimetres left, 42 centimetres up, 1.23 metres forward].
   ```
   Lowers to `entity.create` `kind: "group"` with the same
   `relativeEntityTransform` as other Design primitives. Optional:
   `with local rotation [0 degrees, 0 degrees, 0 degrees]` meaning
   **world-identity axes** after the design-root remap, or an explicit
   `aligned so local x is the right axis` clause.
2. **Parent while preserving world pose**
   Proposed sentence:
   ```text
   Put Front Left Tire, Front Left Rim, and Front Left Hub under $front-hub,
   keeping world pose.
   ```
   Lowers to `entity.group` or a world-preserving reparent. Reject
   without `keeping world pose` if the current local TRS would jump.
3. **Group origin in Object dialect**
   Extend `Put … into a group called … with id …` with optional
   `centred at [….]`. Without it, keep today’s parent-origin behaviour.
4. **Continue an existing design**
   Proposed header:
   ```text
   Continue the design entity/jeep using the right-up-forward design frame.
   ```
   Appends generated children to that root instead of creating a sibling
   `entity/jeep-details`. Reject if the stored `designFrame` disagrees.
5. **Torus / lathe as manufactured rounds**
   ```text
   Create a torus called Wheel Rim with id entity/rim,
   with ring radius 18 centimetres and tube radius 16 millimetres,
   centred at […], aligned along the right axis.
   ```
   Lathe stays a typed recipe unless a closed profile already exists:
   `Lathe profile tire section around the right axis as Tire`.

Acceptance: one Design program can emit
`root → axle group → knuckle group → spin group → meshes` with world
centres in right/up/forward and inspectable local axes. A later Action
can rotate knuckle Y and spin X without a typed hierarchy pass.

### P2 — Tests and evidence

1. Compiler test: semantic-frame empty group world centre equals the
   authored `[right, up, forward]` point (same assertion style as
   `entity/semantic-marker` in `tests/plainform.test.mjs`).
2. Compiler test: parenting `keeping world pose` does not change compiled
   world bounds of the children.
3. Compiler test: `Continue the design entity/jeep` does not create a
   second root.
4. Outcome test: a four-wheel, two-axle fixture with one Action; render
   frames 0 and 24; front wheels yaw, rear wheels do not; spin groups
   advance around the axle axis.
5. Negative test: `Put … under $hub` without `keeping world pose` when
   local TRS would shear or jump fails closed.

Do not gate this on a photoreal Wrangler. Silhouette + hierarchy +
timeline frames are the evidence.

### P3 — Interiors (later, only if P1 is live)

Hollowing a cabin is still the closed-loft bound in notes §3. A generic
path already exists (`Imprint` / `Open` / `Shell`), but a vehicle cabin
needs denser source topology than a 36-sample body loft. Do not add
`Create a cabin`. Document: interior parts that must be photographed
need an opened shell or a camera that does not sit inside a capped solid.

Animation English (Stage 9 in `docs/plainform-next-design.md`) can wait.
Typed Actions already prove the rig. Assembly identity is the blocker.

## Non-goals

- Subject-specific vehicles, axles, tires, or steering wheels as grammar.
- Changing the semantic design-root `Rx(-π/2)` remap.
- Making `entity.reparent` silently preserve world pose (that is
  `entity.group`’s job).
- Raising CSG budgets so a dense body loft can cut wheel arches.
- Claiming a solid loft is a hollow cabin because a steering wheel ID exists.

## Suggested first implementation slice

If this plan is executed, do **P0 in the same change** as the first P1
sentence (`Create a group called … centred at …`). That one sentence
unblocks axles, knuckles, spin hubs, and steering pivots without a torus
or a continue-design header. Parenting and torus can follow once a live
vehicle uses the empty group.
