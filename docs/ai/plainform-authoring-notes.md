# Plainform research notes

How Design Plainform actually works, from the compiler and one live
helmet attempt. Live `three_studio_status` and `AGENT_RULES.md` still win.

These are research heads, not a recipe book. The official sentence families
live in `skills/threebrowser-studio-mcp/references/plainform.md`. This file
records what those sentences compile to, and which remaining limits are
honest tessellation bounds rather than English mismatches.

## 1. Three dialects, one guarded compile

Plainform is controlled English for `three_studio_apply`. It never evals.

| Dialect | Starts with | Job |
| --- | --- | --- |
| Object | references, selections, layouts | Place and group existing IDs |
| Design | `Design a … called … with id …` | Manufacture solids, patches, surfaces |
| Shader | `Create a shader graph called …` | Bounded graph math |
| Sound | `Design a sound called … with id audio/…` | Audio graph, sound scene, 3D spectrogram |

Inspect `plainformAst` before apply. `legacy.statement` means the sentence
still uses the compatibility regex path. It is not approval and it is not a
failure. Query `plainformCatalog` for the migrated grammar.

Dry-run with `Preview these changes`. Promote with the **identical** source,
the same `baseRevision`, and the returned `candidateToken`. One character
change invalidates the token.

## 2. Two design frames — do not mix them

`using the right-up-forward design frame` is the AI header:

| Word | World axis |
| --- | --- |
| right / left | +X / −X |
| up / down | +Y / −Y |
| forward / backward | +Z / −Z |

The compiler then does two private remaps. Do not add a third by hand.

1. The design root is created with rotation `[-π/2, 0, 0]`
   (`designRootTransform` in `src/plainform/design-plainform-compiler.mjs`).
2. Loft / guide / section points go through `semanticWorldToLoft`:
   `[right, up, forward] → [right, −forward, up]`.
3. Primitive children of that root get a **relative** transform
   (`relativeEntityTransform`) so authored `[0, 10 cm up, 0]` still sits at
   world Y = 0.10 m. Capsules and tapered cylinders set
   `authoredInDesignFrame: true` for the same reason.

The short header without a frame is the legacy XZ-profile / Y-loft dialect.
Saved programs keep compiling. Mixing the two conventions, or rotating the
root to “fix” the −90°, doubles the remap and the form lands on its side.

Width, height, and depth always mean world right, up, and forward size.

## 3. A Design loft is always a capped solid

`loftRecipe()` hardcodes:

- `closedProfile: true`
- `capStart: true`
- `capEnd: true`

`Loft a watertight solid called Skull Bowl through all sections of …`
therefore emits an egg / loaf. There is no Design sentence that lofts an
open U and leaves the rim uncapped.

Open surfaces exist only as:

- constrained patches (`closedProfile: false`, `capStart: false`, `capEnd: false`)
- source-tangent boundary blends (same open-loft lowering)

Those need named `$boundaries` on already-created owners. They are skins,
not hollow plate.

## 4. `smooth` closes a profile; a guide may stay open

`Create a … smooth profile` runs `smoothClosedPoints()` — a closed
Catmull-Rom. An intended horseshoe becomes a loop.

`Create a smooth guide curve` runs `smoothOpenPoints()`. Guides are paths,
not sections.

`symmetric` mirrors the supplied half across the named centreline
(default up / Z in the semantic frame). Controlled sections keep **one**
profile topology. They scale, offset, and rotate that profile; they do not
invent a brow, cheek, or neck silhouette. Put landmarks in the base profile.

`Smooth profile <name> with N samples` also closes. Do not expect an open U.

## 5. Imprint / Open / Split follows existing triangles

```text
Create a closed surface curve called rim opening on Skull Form through
surface points nearest to design points …
Imprint $rim-opening into Skull Form.
Open Skull Form along $rim-opening.
Shell Skull Form inward by 3 millimetres, leaving $rim-opening open.
```

`Imprint` only records intent. It does not remesh.

`Open` calls `openSurfaceAlongCurve` in
`src/plainform/semantic-surface-split.mjs`: keep remainder, delete enclosed.

Two partition paths:

1. **Exact edge loop** — every curve anchor sits on a vertex
   (`barycentric` max ≥ `1 - 1e-7`) and every segment is an existing mesh
   edge. Flood-fill, smaller area is enclosed.
2. **Projected fallback** — flatten the curve to a 2D polygon and classify
   triangle centroids. On a closed solid, a planar loop whose 2D disk wraps
   more than a flat face hole opens the **smaller side of the rim plane**,
   so a latitude becomes a bowl. A rectangle on one box face still uses the
   2D hole.

The cut still follows existing triangle edges. A 12-triangle box therefore
loses a whole face, not an 80 cm CAD hole. The rim is sawtooth until the
source is denser. There is still no geodesic remesh.

`tests/plainform-example-outcomes.test.mjs` pins the bowl and box-face
outcomes.

## 6. Shell thickens; it does not repair a rim

`shellSurface` in `src/plainform/semantic-surface-shell.mjs`:

- realizes the current indexed mesh
- duplicates vertices and offsets them along vertex normals
- reverses the inner winding
- stitches **already genuine** boundary edges
- rejects thickness ≥ half the smallest non-zero AABB span
  (`plainform_shell_self_intersection_risk`)

`leaving $opening open` means CAD shell-with-opening: the rim is stitched
to the inner wall so the mouth stays a thick cavity. The result is
manifold-closed. It is not a raw unstitched hole.

Shell skips unused vertices when checking normals. Design spheres are
welded at the poles and seam, so `Create a sphere` then `Shell inward`
is a hollow ball.

Raise / bulge on a 12-triangle box often hits no vertices
(`plainform_surface_deformation_empty`). Use a denser realized surface.

Deform / Open / Shell require a supported realized surface. An extrude
often fails later with `plainform_surface_deformation_unavailable`. Prefer
a loft, primitive, or patch if the solid must be opened, mirrored, or
shelled in the same program.

## 7. Constrained patches are the open-surface primitive

Use named boundaries when two owners must meet:

```text
Name a boundary called roof front on Roof Panel through design points …
Create a constrained surface patch called Windshield with id entity/windshield
between $roof-front and $cowl-rear, with curvature continuity.
```

`design points` are in the design-root frame. `local points` are in the
owner’s pre-transform geometry space.

The compiler matches the second rail’s direction to the first, then
lowers an **open, uncapped** loft. Four-boundary and source-tangent
variants evaluate sections first so a second interpolation cannot move
the constrained edges.

This is compile-time, not a live solver. Moving a source later does not
regenerate the patch. Re-author the Design.

Surface-anchored boundaries and surface curves project seeds onto a
supported triangle surface (box, plane, cylinder, sphere, loft,
indexed / explicit / editable mesh). Budget: 1,000,000 point-triangle
tests per statement, then explicit failure.

A surface curve is intent. It does not change pixels until a later
Raise / Open / Split / Project / region deformation consumes it.

## 8. Sweeps, extrudes, mirrors, booleans

**Sweep** — `sweepProfileAlongGuide` transports a **closed** profile
(`closedProfile` defaults true) along an open guide. Small profile, long
guide. A 4 cm brow band around a 12 cm skull reads as a fat torus, not a
visor. Cap 65,536 profile-path vertices.

**Extrude** — bevelled watertight solid from a profile. Poor target for
later semantic surface ops.

**Mirror** — `Create X as the mirror of Y across the x centre plane`.
Works on profiles, guides, anchored references, patches, and generated
solids. Anchors reproject; winding reverses. Do not yaw a cheek loft
~70°+ and then mirror: the section rotation becomes side fins.

**Boolean** — `Subtract` / `Union` / `Intersect` on solids generated in
**this** program. Same-kind chains only. Mixed union+subtract on one
target rejects. Nested CSG rejects. Limits: 2–32 non-CSG operands, 512
tris/operand, 1,024 across the op, 64 tris for a curved loft operand,
2,000,000 output. Prove a cylinder annulus first. A Design sphere
realization is thousands of triangles — over budget as a CSG operand.

`Attach … over $join-rail` is positional CSG union plus hide-the-tool.
Tangent / curvature attach is an explicit reject
(`plainform_attach_continuity_unsupported`).

## 9. Design has no hemisphere

`Create a sphere` / `Create an ellipsoid` emit a full `sphere` recipe
(radius 0.5 unit mesh, then scale). There is no `thetaLength` in Design.

A typed `resource.create` sphere with `thetaLength: π/2` is valid MCP and
is not a Design-Plainform bowl. It is an open mesh, not a shelled plate.

## 10. Pine English is not a general composition language

`Create a mature mountain pine named …` and
`Frame the whole pine from slightly below…` are regex-bound botanical /
hero-shot families (`plainform-front-end.mjs`, `botanical-growth.mjs`).
They do not generalize to armor. Light and camera an armor set with
`lighting.rig.create` and `camera.frame`.

## 11. Materials that lie about the form

`brushedMetal` anisotropy on large flats flashes white or black under a
product rig. Use a dull plate look (anisotropy near 0, roughness ~0.55)
until the silhouette is curved. Judge the PNG, not the explorer tree.

## 12. What this means for manufactured armor

Honest Design tools for a galea-like object, given the heads above:

- **Skull volume** — ellipsoid or lofted solid. It will be closed.
- **Face opening** — Open along a closed rim on the ellipsoid. That now
  removes the smaller cap and keeps a bowl. The rim follows triangle
  edges, so keep the source reasonably dense.
- **Plate thickness** — Shell after that Open. The mouth stays a thick
  cavity. `Shell inward` also works on a closed sphere.
- **Cheek / neck / brow** — small lofts or sweeps that hang **down**
  (section offsets), mirrored across X. Landmarks in the base profile.
- **Open skins** — constrained patches between named rails (eyebrows,
  flanges as surfaces, not hollow stampings).
- **Greybox** — typed primitives (hemisphere, boxes) remain legal MCP.
  They are not Design-Plainform and they will look like primitives.

Do not keep stacking failed Design roots on the origin. Hide the group
and start a new id. Do not hide a group that still owns the visible
children you mean to show.

Runnable examples that compile each family, realize the mesh, and assert
what it actually is live in
`tests/plainform-example-outcomes.test.mjs`. Prefer those outcomes over
remembered English. Confirmed there:

- Design spheres are welded and manifold-watertight; `Shell inward` hollows them.
- Open on a box deletes whole triangles (often the entire face).
- Open on a sphere latitude removes the smaller cap and keeps a bowl.
- Galea-style Open+Shell keeps the crown as a thick bowl.
- `leaving $opening open` is a thick mouth (stitched rim), not a raw hole.
- Extrude and capsule recipes cannot later be surface-realized.
- Raise on a 12-triangle box finds no vertices; a sphere region does.
- Design emits `entity.createMany`, which the kernel rejects until flattened.

## 13. Vehicles are envelopes, not rigs

Live jeep build, 2026-09-02. Assembly sentences are now in the compiler;
the plan is `docs/ai/plainform-assembly-action-plan.md`.

Design Plainform can loft a boxy body in the semantic frame. The design
root is still `Rx(-π/2)`. Animation on a **mesh child of that root** does
not use world axes:

| Local axis on a design-root child | World axis |
| --- | --- |
| +X | +X (right) |
| +Y | −Z (backward) |
| +Z | +Y (up) |

Use the generic assembly sentences instead of typed MCP:

```text
Create a group called Front Hub with id entity/hub-fl, centred at [82 centimetres left, 42 centimetres up, 1.23 metres forward].
Put Front Left Tire under Front Hub, keeping world pose.
Continue the design entity/jeep using the right-up-forward design frame.
```

A group nested under another world-identity group stores local identity,
so Actions can yaw local Y and roll local X. `Put … under …` without
`keeping world pose` fails with `plainform_parent_world_pose_required`
when the child would jump. `entity.reparent` still keeps local TRS.

A second `Design a …` header still creates a sibling root. Continue.

A Design loft is a capped solid (notes §3). Interior parts that must be
photographed need Open/Shell; a camera inside the loaf is not an interior.

## Compiler map

| Head | File |
| --- | --- |
| Header, frames, loft recipe, primitives, Open/Shell/CSG sentences | `src/plainform/design-plainform-compiler.mjs` |
| Open / Split / projected imprint | `src/plainform/semantic-surface-split.mjs` |
| Shell offset + boundary stitch | `src/plainform/semantic-surface-shell.mjs` |
| Sphere / loft realization, nearest-surface project | `src/plainform/constrained-surface.mjs` |
| Sweep frames | `src/plainform/semantic-surface-reference.mjs` |
| Grammar catalog | `src/plainform/plainform-front-end.mjs` |
| Box-face Open+Shell contract | `tests/plainform.test.mjs` (`Opened Shell`) |
| Box-face advanced surface contract | `tests/runtime-application-boundary.test.mjs` |
