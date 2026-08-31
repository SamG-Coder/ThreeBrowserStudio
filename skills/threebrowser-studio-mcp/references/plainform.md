# Plainform authoring reference

Plainform is a controlled-English input mode for `three_studio_apply`. It
compiles to canonical guarded operations; it does not execute JavaScript or
guess at unsupported prose. Always inspect status and the relevant project
slice first, then provide the latest base revision, a fresh idempotency key,
and a coherent label around this program envelope:

```json
{
  "program": {
    "language": "plainform-v1",
    "source": "Use entity/window-module as the module.\nLay out a 12 by 30 grid of copies of the module over the front face of entity/tower, spaced 1.5 metres horizontally and 1.2 metres vertically, preserving the prefab orientation."
  }
}
```

## Choose the dialect

Object Plainform is for exact references, selections, spatial relations,
transforms, bounded iteration, grouping, prefabs, and layouts. Refer to exact
entity IDs returned by inspect. A single named reference can be transformed
directly; use named selections for collective work. Convert a resolved object
or group into a named prefab, then reuse it with `$name`.

For grids over an object's face, state orientation independently from
placement. The default aligns local Z to the face normal. Use one of:

- `keeping each copy upright`
- `preserving the prefab orientation`
- `aligning each copy's local x axis with the face normal`
- `aligning each copy's local y axis with the face normal`
- `aligning each copy's local z axis with the face normal`

Shader Plainform begins with `Create a shader graph called ...`. Use natural
surface descriptors, typed Principled properties, and named math chains. It
supports bounded expressions such as `sin`, `cos`, `smoothstep`, `clamp`, and
`saturate`, including nested chains driven by time. Inspect `graphCatalog`
first and validate the generated graph before assigning or extending it.

Design Plainform begins with an exact design header:

```text
Design a tower called Parametric Tower with id entity/parametric-tower.
```

It creates a persistent design group and lowers mathematical solids to shared
geometry resources plus batched entities. Parameters are unit checked. Natural
operator words and symbols may be mixed, and named parameters may contain
spaces:

```text
Let tower height be 240 metres.
Let floor height be 3.75 metres.
Let floor count be floor(tower height / floor height).
Let taper be lerp(1, 0.84, smoothstep(0.15, 1, progress)).
Let measured span be the distance between entity/anchor-a and entity/anchor-b.
```

Supported dimensions are scalar, angle, length, area, and volume. Supported
units include millimetres, centimetres, metres, square/cubic variants, degrees,
radians, and percent. Design math includes arithmetic and powers plus `sin`,
`cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `sqrt`, `abs`, `floor`, `ceil`,
`round`, `min`, `max`, `clamp`, `saturate`, `lerp`, `inverse lerp`, `remap`, and
`smoothstep`. Invalid dimensional combinations fail instead of coercing.
Distance measurements resolve exact existing or already generated references
and become ordinary length variables for later dimensions and positions.

Create exact primitives directly:

```text
Create a box called Podium with id entity/podium, with width 50 metres, height 8 metres, and depth 40 metres, centred at [0, 4 metres, 0].
Create a cylinder called Column with id entity/column, with radius 40 centimetres and height 6 metres, centred at [0, 3 metres, 0].
```

Boxes and cylinders may append `rotated by [x, y, z]` and `using material
material/id`. Cylinder height follows local Y before rotation.

### Curved manufactured forms

Profiles lie in local XZ and loft along local Y. Define arbitrary control
points explicitly; `smooth` performs bounded closed Catmull-Rom resampling.
`symmetric` mirrors the supplied half profile across Z unless another
centreline is named:

```text
Create a symmetric smooth profile called body section through [0 metres, 42 centimetres], [50 centimetres, 30 centimetres], [62 centimetres, -18 centimetres], [0 metres, -38 centimetres], mirrored across the z centreline.
Smooth profile body section with 48 samples.
Move profile point 12 of body section by [2 centimetres, 0 metres, -1 centimetre].
```

Use controlled sections when width, profile depth, local scale, position, and
rotation must vary independently. `height` after `at` is the loft-path Y
coordinate; `width` controls local X; `depth` controls local Z. Vertical offset
adds local Y and lateral offset adds local Z:

```text
Add a controlled section of body section at height 0 metres, width 1.72 metres, depth 78 centimetres.
Add a controlled section of body section at height 1.4 metres, width 1.90 metres, depth 1.08 metres, offset vertically by 6 centimetres, offset laterally by 2 centimetres, rotated by [0 degrees, 1 degree, 0 degrees], and scaled locally by [1, 1, 0.96].
```

Every section keeps the same profile topology. More sections improve the
longitudinal transition, but they do not invent rocker, shoulder, beltline,
roof, hood, or deck landmarks. Put those landmarks in the base profile and use
spatially distinct guides to control them. Local modifiers are not mirrored
implicitly: author matching positive- and negative-Z bulges or pinches when the
form must remain bilateral.

Guide curves are open curves in loft-local XYZ. A guide binds to the closest
point on the first section and pulls the corresponding point across the loft.
Use spatially distinct first points for multiple rails:

```text
Create a smooth guide curve called shoulder line through [58 centimetres, 0 metres, 24 centimetres], [66 centimetres, 1.4 metres, 30 centimetres], [54 centimetres, 3 metres, 18 centimetres].
Loft a watertight solid called Body Shell with id entity/body-shell through all sections of body section, following shoulder line, with curvature continuity, using material material/body-paint.
```

Append `using material <material-id>` to a loft to assign an existing canonical
material during the same atomic Design program. The material must already
exist in the project.

Continuity is positional, tangent, or curvature within one loft. The latter
two insert smooth deterministic section interpolation. You may also write
`Blend the sections of Body Shell with curvature continuity`. Plainform rejects
cross-solid continuity; describe the transition as sections of the same loft
instead of assuming an edge blend.

Apply bounded local shaping to an authored loft before a boolean operation:

```text
Bulge Body Shell outward around [0 metres, 1.8 metres, 22 centimetres] by 4 centimetres within 65 centimetres.
Pinch Body Shell inward around [0 metres, 3.2 metres, 0 metres] by 2 centimetres within 40 centimetres.
Offset the surface of Body Shell by 5 millimetres.
```

### Named boundaries and constrained patches

Use named boundaries only when two independently authored objects need one
surface to meet both of them exactly. A boundary belongs to one exact entity
and contains 3–256 ordered points. Its `$name` is stable within the Design
program and is recorded with the owner ID in canonical metadata.

Use `design points` when the coordinates are already in the design root's
coordinate system. Use `local points` when the coordinates are in the owning
entity's pre-transform geometry space; the compiler applies that entity's
canonical transform:

```text
Name a boundary called roof front on Roof Panel through design points [-80 centimetres, 1.32 metres, 20 centimetres], [0 metres, 1.38 metres, 18 centimetres], [80 centimetres, 1.32 metres, 20 centimetres].
Name a boundary called cowl rear on Cowl Panel through design points [-86 centimetres, 82 centimetres, -42 centimetres], [0 metres, 86 centimetres, -45 centimetres], [86 centimetres, 82 centimetres, -42 centimetres].
Create a constrained surface patch called Windshield with id entity/windshield between $roof-front and $cowl-rear, with curvature continuity, using material material/glass.
```

The compiler matches the second boundary's endpoint direction to the first,
then lowers the result to a bounded open, uncapped loft. `positional` uses the
two authored rails directly; `tangent` and `curvature` add deterministic
intermediate sections. The named owner references, authored coordinates, and
resolved boundary references remain inspectable in project metadata.

The first boundary's point order determines the patch front face; the compiler
only reverses the second rail to prevent a twist. Reverse both authored point
orders when the surface normal must face the opposite side.

This is an atomic authored constraint, not executable code or a hidden live
solver. Moving an individual source object later does not silently regenerate
the patch; re-author the Design program when the source boundary changes. A
shared parent transform remains coherent because the source objects and patch
move together.

When manually authored coordinates must actually lie on the owner's current
compiled surface, request bounded nearest-surface anchors. The seed coordinates
may be in design or owner-local space. Studio projects each seed onto a
supported project-owned triangle surface and preserves the triangle,
barycentric coordinates, projected point, and surface normal in the design
metadata:

```text
Name a surface-anchored boundary called socket rail on Head Shell through surface points nearest to design points [-3 centimetres, 1.64 metres, 9 centimetres], [0 metres, 1.66 metres, 10 centimetres], [3 centimetres, 1.64 metres, 9 centimetres].
```

Surface anchoring is a bounded compile-time constraint, not a background
solver. It supports boxes, planes, cylinders, spheres, lofts, indexed/explicit
meshes, and editable meshes. Realize another procedural kind before projecting
onto it. The compiler performs at most 1,000,000 point-triangle tests per
boundary statement and fails explicitly instead of silently approximating an
over-budget projection.

Two rails leave the patch ends implicit. Name two additional connecting
boundaries when both ends must be controlled. Each end boundary must begin on
the first main rail and end on the second; the compiler may reverse and swap
the two end boundaries to match corners, but rejects disconnected corners:

```text
Create a constrained surface patch called Eyelid with id entity/eyelid between $socket-rail and $cornea-rail, bounded by $inner-canthus and $outer-canthus, with curvature continuity, using material material/skin.
```

Use source-aware tangency only when both main rails are surface anchored. It
derives bounded interior controls in each owner's tangent plane while
preserving the exact rail positions and recorded source normals:

```text
Create a constrained surface patch called Fairing with id entity/fairing between $body-rail and $panel-rail, meeting both owner surfaces tangentially, with curvature continuity.
```

Four-boundary and source-tangent patches lower to explicit bounded loft
sections. Their requested design continuity remains in metadata; the compiled
loft uses positional interpolation over those already evaluated sections so a
second implicit interpolation cannot move the constrained edges.

### Surface curves and semantic regions

Use a surface curve when a reusable design line must live on one existing
surface. Open curves require 2–256 seed points; closed curves require 3–256.
The compiler projects every seed with the same bounded nearest-surface process
as anchored boundaries and stores its owner, projected points, normals,
triangle anchors, and barycentric coordinates as design intent:

```text
Create a surface curve called shoulder line on Body Shell through surface points nearest to design points [-1.5 metres, 60 centimetres, 2 metres], [0 metres, 75 centimetres, 2 metres], [1.5 metres, 60 centimetres, 2 metres].
Create a closed surface curve called door outline on Body Shell through surface points nearest to design points [-80 centimetres, 50 centimetres, 2 metres], [80 centimetres, 50 centimetres, 2 metres], [80 centimetres, -50 centimetres, 2 metres], [-80 centimetres, -50 centimetres, 2 metres].
```

Name deterministic regions without selecting vertices or triangles:

```text
Name the surface between $shoulder-line and $sill-line as body side.
Name the surface within 20 centimetres of $shoulder-line as shoulder region.
Name the surface enclosed by $door-outline as door region.
Name the surface on Body Shell around [0 metres, 0 metres, 2 metres] within 30 centimetres as centre detail.
```

The two references in a `between` region must belong to the same owner. An
`enclosed by` region requires a curve declared `closed`. Distances and radii
must be positive lengths. `Name the region around $rail as shoulder` is
intentionally invalid because it omits a deterministic extent. Surface curves
and regions are persistent canonical intent, but this stage does not deform,
split, or shell their owner automatically; use only the regional operations
explicitly documented in later sections.

Curve-distance and surface-radius intent can drive a bounded normal
displacement while the compiler keeps topology bookkeeping private:

```text
Raise the surface along shoulder line by 18 millimetres with a smooth falloff of 12 centimetres.
Inset jaw region by 4 millimetres, falling off smoothly over 3 centimetres.
Bulge centre detail by 2 millimetres, falling off smoothly over 8 millimetres.
```

Supported verbs are `raise`, `lower`, `inset`, `bulge`, and `pinch`. Raise and
bulge follow the evaluated outward surface normal; lower, inset, and pinch use
its inverse. Amount and falloff must be positive lengths. The compiler realizes
the supported source surface internally, derives smooth influence without
exposing vertices, preserves the owner entity's stable ID and transform, and
stores the semantic operation plus affected-vertex count on the design root.

Every deformation requires an explicit falloff. For example, `Raise the
surface along shoulder line by 8 millimetres` fails with
`plainform_surface_deformation_falloff_required`. A falloff that reaches no
evaluated surface vertices fails instead of silently producing no change.
Curve deformation requires a `surface curve`, not an ordinary patch boundary.
This stage accepts curve-distance and surface-radius regions as deformation
masks. Between-curves and enclosed regions remain valid named intent for later
projection and split operations and currently fail with
`plainform_surface_region_deformation_unsupported` if used as deformation
masks.

Project a profile or an existing surface reference onto another owner when a
detail must follow the target surface rather than rely on world-space overlap:

```text
Project profile badge outline onto Housing as housing badge, centred at [0 metres, 0 metres, 1.2 metres], rotated by [0 degrees, 0 degrees, 0 degrees].
Project $source-badge onto Target Panel as target badge.
```

A profile projection becomes a closed surface curve. Its profile points are
placed in design space by the optional centre and XYZ rotation before bounded
nearest-surface projection. A `$reference` projection reprojects the already
evaluated world points and preserves whether a source surface curve is closed.
The resulting curve can be named as a region or consumed by later supported
surface operations. Projection records its source intent and all resolved
anchors; it does not create a floating duplicate mesh.

Create actual thickness with:

```text
Shell Body Panel inward by 1.2 millimetres.
Shell Housing outward by 3 millimetres.
```

Shelling realizes the supported source surface internally, duplicates and
offsets its skin along evaluated normals, reverses the inner winding, and
closes genuine topology boundary edges. The owner entity ID, transform, and
material assignment remain stable. A thickness at or above half the smallest
non-zero owner span fails conservatively with
`plainform_shell_self_intersection_risk`. `Shell Housing inward by 4
millimetres, leaving $opening open` is not accepted while `$opening` is only an
interior semantic curve: split it into a genuine topology boundary first.

### Evaluated surface measurements and persistent constraints

Surface measurements are typed values and can be reused by later expressions
in the same Design Plainform program:

```text
Let overall width be the width of Body Shell.
Let belt width be the width of Body Shell at height 80 centimetres.
Let panel clearance be the minimum distance between Body Shell and Door Skin.
Let rail angle be the angle between $shoulder-line and $sill-line.
```

Width, height, depth, and the height-specific width are evaluated in world
space. The minimum distance is a deterministic bidirectional
vertex-to-triangle distance between the evaluated surfaces. The angle uses the
end-to-end directions of the two resolved surface references and is a typed
angle in radians internally. Only width-at-height is supported for a
height-specific cross-section; asking for depth-at-height or height-at-height
fails with `plainform_surface_measurement_unsupported`.

Use compile-time constraints when a later semantic deformation must fail
rather than silently violate design intent:

```text
Keep Body Shell symmetric across its x centre plane.
Maintain at least 8 millimetres clearance between Body Shell and Door Skin.
```

The compiler validates new constraints before committing and stores them on
the design root. A later Design Plainform program revalidates an inherited
constraint when that program modifies one of its participating owners. Any
failure aborts the whole atomic apply with
`plainform_constraint_unsatisfied`. This is deliberately not a hidden live
solver and does not claim enforcement for unrelated direct MCP mutations.

### Attach, trim, and exact surface splitting

Join two intersecting solids created earlier in the same Design program with:

```text
Attach Mount Boss to Main Housing over $join-rail, removing hidden intersecting surfaces, with positional continuity.
```

The named boundary must belong to one attachment operand. Both solid bounds
must overlap in all three dimensions. The compiler performs a bounded CSG
union, removes hidden intersecting surfaces, keeps the target ID, hides the
consumed tool, and records the attachment relationship. This stage supports
`positional` continuity only. `with tangent continuity` and `with curvature
continuity` fail with `plainform_attach_continuity_unsupported` because a CSG
union cannot honestly guarantee either condition. Existing-scene operands
also reject: both operands must currently be generated within the same atomic
Design program.
If a stored or newly declared constraint participates in the pending CSG
target, the program fails with `plainform_constraint_validation_unavailable`.
Author and verify the topology stage separately; Plainform never validates the
pre-CSG operand and silently treats that as proof about the post-CSG result.
Input triangle limits are not the only CSG guard. The runtime also caps
intermediate BSP polygon tests, split vertices, and live polygons because a
small curved input can split combinatorially. A `CSG BSP work` or `CSG
intermediate` diagnostic means revise the authored attachment topology; the
runtime deliberately aborts before memory growth can threaten Studio.
Within those fixed budgets, the runtime chooses from a bounded set of BSP
splitter candidates to minimize polygon splitting and tree imbalance. Retry a
small curved attachment after reducing operand topology; never raise the guard
or assume triangle count alone predicts boolean cost.

Split one coherent surface along an existing semantic loop with two immediate
statements:

```text
Split Housing along $front-perimeter.
Call the enclosed surface Front Panel with id entity/front-panel.
```

The first statement requires a closed surface curve owned by the surface being
split. The second statement is mandatory and gives the enclosed result a
stable semantic identity. The owner keeps its ID and becomes the remainder;
the named result is a separate, non-overlapping indexed surface. The exact
solver currently accepts only a simple closed curve whose anchors and segments
coincide with existing topology vertices and edges and whose removal separates
the owner into exactly two components. Curves crossing triangle interiors fail
with `plainform_surface_split_requires_edge_loop`; open curves fail with
`plainform_surface_split_not_closed`; non-separating loops fail with
`plainform_surface_split_nonseparating_loop`. No approximate centroid cut,
overlapping duplicate, or raw topology command is emitted.

Arbitrary profiles can also become bevelled watertight extrusions:

```text
Extrude profile splitter outline by 18 centimetres as a solid called Front Splitter with id entity/front-splitter, centred at [0 metres, 3.8 metres, -30 centimetres], rotated by [90 degrees, 0 degrees, 0 degrees], using material material/carbon.
```

Boolean commands accept generated solids from the same Design program. The
tool is hidden and the target keeps its stable entity ID. Repeated commands of
the same kind form one deterministic bounded chain:

```text
Subtract Front Clearance from Body Shell.
Union Reinforcement with Chassis.
Intersect Crop Volume with Detail Shell.
```

A wheel or arch annulus is a useful bounded boolean test before attempting a
larger assembly:

```text
Create a cylinder called Outer Ring with id entity/outer-ring, with radius 54 centimetres and height 7 centimetres, centred at [0 metres, 0 metres, 0 metres], rotated by [90 degrees, 0 degrees, 0 degrees], using material material/carbon.
Create a cylinder called Inner Ring with id entity/inner-ring, with radius 47 centimetres and height 10 centimetres, centred at [0 metres, 0 metres, 0 metres], rotated by [90 degrees, 0 degrees, 0 degrees].
Subtract Inner Ring from Outer Ring.
```

Use booleans for real voids or fused silhouettes, not panel lines that can be
expressed with an overlapping trim solid. Mixed boolean chains on the same
target and nested imported CSG are deliberately rejected. A CSG recipe accepts
2–32 non-CSG operands, at most 512 input triangles per operand and 1,024 across
the operation, and has a 2,000,000-triangle output safety limit. Curved loft
operands have a stricter 64-triangle cap because general BSP fragmentation can
grow nonlinearly. For a denser shell, prefer surface overlays or realize and
simplify only the boolean region.

For a parametric envelope, define one profile, add transformed sections in a
bounded loop, and loft them. Floor plates share one unit-box geometry even when
their dimensions differ:

```text
Create a rectangular profile called floor profile with width tower width and depth tower depth, rounded by 1.2 metres.
For every floor i from 0 through floor count minus 1:
  Let progress be i / (floor count - 1).
  Let height be i * floor height.
  Let twist be 4 degrees * sin(progress * pi * 3).
  Add a section of the floor profile at height height, rotated around y by twist, and scaled horizontally by taper.
  Create a floor plate from the floor profile at height height, with thickness 20 centimetres, rotated around y by twist, and scaled horizontally by taper.
End.
Loft a watertight solid called Tower Envelope with id entity/tower-envelope through all sections of the floor profile.
Ensure the design is exactly tower height high.
```

Loops require ascending integer bounds and are limited to 128 iterations.
Design programs create at most 128 entities and define at most 128 named
boundaries. The root group's metadata retains the exact Plainform source,
evaluated top-level parameter values, and boundary declarations so the design
intent remains inspectable. End with the ordinary preview sentence for
candidate compilation before commit.

## Preview and promote

End either dialect with `Preview these changes` or `Show me a preview` to
request a dry run. Review the returned interpretation and diagnostics. To
commit, resend the identical source at the same base revision with the
returned `candidateToken`; the token promotes the already compiled candidate.

Plainform accepts at most 256 statements and lowers at most 128 operations.
Split a larger build into visible semantic stages. If the compiler rejects a
sentence, revise it from the diagnostic rather than paraphrasing repeatedly or
falling back to raw code.

For complex forms, inspect the compiled recipe before inventing a new feature.
Fix the authored section placement, guide binding, dimensions, or camera first.
Extend Plainform/runtime only when the required shape cannot reasonably be
expressed with arbitrary profiles, controlled sections, guide curves, local
modifiers, extrusions, primitives, and bounded booleans.

Design profiles loft along local Y. When a complete manufactured assembly must
lie along another world axis, keep the modelling program internally consistent,
then use Object Plainform to name and orient the generated root group. This is
composition, not a reason to duplicate the Design grammar with world-axis
variants.
