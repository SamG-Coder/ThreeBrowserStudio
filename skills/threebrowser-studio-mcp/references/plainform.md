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
Design programs create at most 128 entities. The root group's metadata retains
the exact Plainform source and evaluated top-level parameter values so the
design intent remains inspectable. End with the ordinary preview sentence for
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
