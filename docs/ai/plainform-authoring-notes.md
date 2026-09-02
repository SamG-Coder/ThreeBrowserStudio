# Plainform research notes

How Design Plainform actually works, from the compiler and one live
helmet attempt. Live `three_studio_status` and `AGENT_RULES.md` still win.

These are research heads, not a recipe book. The official sentence families
live in `skills/threebrowser-studio-mcp/references/plainform.md`. This file
records what those sentences compile to, and where the English over-promises.

## 1. Three dialects, one guarded compile

Plainform is controlled English for `three_studio_apply`. It never evals.

| Dialect | Starts with | Job |
| --- | --- | --- |
| Object | references, selections, layouts | Place and group existing IDs |
| Design | `Design a … called … with id …` | Manufacture solids, patches, surfaces |
| Shader | `Create a shader graph called …` | Bounded graph math |

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

## 5. Imprint / Open / Split is triangle classification, not CAD trim

This is the head that broke the galea bowl.

### What the English sounds like

```text
Create a closed surface curve called rim opening on Skull Form through
surface points nearest to design points …
Imprint $rim-opening into Skull Form.
Open Skull Form along $rim-opening.
Shell Skull Form inward by 3 millimetres, leaving $rim-opening open.
```

The docs and the advanced-surface test use this family. The test owner is a
**box**, and the curve is a **rectangle on one planar face**. That is the
supported case.

### What the compiler does

`Imprint` only records intent. It does not remesh.

`Open` calls `openSurfaceAlongCurve` in
`src/plainform/semantic-surface-split.mjs`, which is
`splitSurfaceAlongCurve` then **keep remainder, delete enclosed**.

Two partition paths:

1. **Exact edge loop** — every curve anchor sits on a vertex
   (`barycentric` max ≥ `1 - 1e-7`) and every segment is an existing mesh
   edge. Then flood-fill triangles, sort the two components by area, and
   treat the smaller as enclosed. A true UV-sphere latitude *is* such a
   loop, but nearest-surface seeds almost never land on vertices, so this
   path is rare.
2. **Projected fallback** — `splitByProjectedCurve`. Flatten the curve into
   a 2D polygon using the curve’s average frame, then classify each
   **triangle centroid** with point-in-polygon. The cut follows existing
   triangle edges. There is no new rim edge, no geodesic split, no
   remesh.

`plainform_surface_split_requires_edge_loop` is the honest failure when the
code refuses an interior-crossing exact split. The fallback exists so a
planar box-face outline still compiles.

### Why a latitude on an ellipsoid becomes a jagged band

A closed rim around a sphere, flattened to its own plane, is a **disk**.
Both the crown and the chin project into the interior of that disk. The
fallback therefore marks **both caps** as enclosed and deletes them. The
remainder is the equatorial belt. The belt’s boundary is the UV-sphere
tessellation (Design spheres use `widthSegments: 48`, `heightSegments: 24`
in `unitRecipe`; realization clamps to 8–64 / 4–32), so both rims are
sawtooth.

Live evidence, revision 17, `entity/gallic-bowl`: Open reported 122
boundary edges and Shell 135. A clean 48-segment latitude would be ~48
edges. 122 is a classified zigzag. The beauty frame
`artifacts/studio-1788323013893.png` is a shredded metal cuff, not a bowl.

World bounds of that result were Y ∈ [0.05, 0.16] on a 20 cm ellipsoid
centred at Y = 0.10 — a band, not a 14 cm remaining dome.

### What Open is actually for

Planar openings on a box or panel: intake cutout, door aperture, vent on
one face. The curve’s flatten-frame matches the face, only that face’s
triangles fall inside the polygon, and the opposite side stays put.

It is the wrong tool for a spherical cap, helmet rim, cup, or any cut
whose 2D projection overlaps more than one side of the solid.

## 6. Shell thickens; it does not repair a rim

`shellSurface` in `src/plainform/semantic-surface-shell.mjs`:

- realizes the current indexed mesh
- duplicates vertices and offsets them along vertex normals
- reverses the inner winding
- stitches **already genuine** boundary edges
- rejects thickness ≥ half the smallest non-zero AABB span
  (`plainform_shell_self_intersection_risk`)

`leaving $opening open` only checks that `Open … along $opening` already
ran. `shellSurface()` then stitches **every** remaining boundary edge to
the offset inner wall. The mouth stays as a cavity (a cup or hollow
ring), but the mesh is manifold-closed. It does not leave a raw hole.

Shell does not resample, fair, or snap to the authored curve. A sawtooth
Open stays a sawtooth plate.

A closed Design sphere cannot be shelled. The UV-sphere realization
leaves unused pole-seam vertices with zero normals, and Shell fails with
`plainform_shell_degenerate_surface`. Open the surface first so
`compactRecipe` drops unused vertices, or shell a box / loft instead.

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
- **Face opening** — not Open-on-latitude. A planar box cutout can Open.
  A spherical rim cannot, until an exact vertex edge-loop path exists.
- **Plate thickness** — Shell after a *planar* Open, or overlapping
  solids, or a swept thin closed profile. Shell will not turn a band into
  a bowl.
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

- UV-sphere recipes have a seam, so they are not manifold-watertight.
- Open on a box deletes whole triangles (often the entire face).
- Open on a sphere latitude deletes both poles and leaves a band.
- Galea-style Open+Shell is a hollow cuff, not a bowl.
- Shell stitches every rim; `leaving $opening open` does not keep a hole.
- Closed Design spheres cannot be shelled (`plainform_shell_degenerate_surface`).
- Extrude and capsule recipes cannot later be surface-realized.
- Raise on a 12-triangle box finds no vertices; a sphere region does.
- Design emits `entity.createMany`, which the kernel rejects until flattened.

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
