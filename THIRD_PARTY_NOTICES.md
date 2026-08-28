# Third-party notices

ThreeBrowser Studio is an independent JavaScript implementation. It does not
redistribute Blender binaries, Blender source files, Blender artwork, Blender
Studio media, or Blender `.blend` files.

## Blender compatibility references

Blender names, public RNA/API identifiers, documented data-model concepts, and
observable workflow behaviour are referenced for compatibility. The source in
this repository does not include Blender's Python implementations. Public API
names and functional menu placement are recorded as compatibility metadata.
References are:

- [Blender source and licensing](https://www.blender.org/about/license/) — the
  Blender source code is made available under the GNU General Public License,
  version 2 or later.
- [Blender Developer Documentation](https://developer.blender.org/docs/license/)
  — generally CC BY-SA 4.0; attribution: Blender Developer Documentation Team.
  The linked page lists its exceptions.
- [Blender Manual](https://docs.blender.org/manual/en/latest/) — generally
  CC BY-SA 4.0; attribution: Blender Documentation Team. ThreeBrowser Studio's
  compatibility prose is an original summary of documented factual behaviour,
  with links back to the relevant manual pages.
- [Blender Python API](https://docs.blender.org/api/current/) — public RNA/API
  identifier and behavioural reference.
- [Blender 5.2 shader-node Add menu](https://projects.blender.org/blender/blender/src/branch/blender-v5.2-release/scripts/startup/bl_ui/node_add_menu_shader.py)
  — functional node inventory reference; Blender source is GPL-2.0-or-later.

The tutorial translations reference
[Blender Fundamentals 4.5 LTS](https://studio.blender.org/training/blender-fundamentals-45-lts/),
copyright Blender Foundation and published by Blender Studio under CC BY 4.0
unless a page states otherwise. The modeling, lighting, camera, materials, and
watering-can shading lessons are by Beau Gerbrands; the keyframes lesson is by
Rik Schutte. Attribution and licensing are described in Blender Studio's
[terms](https://studio.blender.org/terms-and-conditions/) and
[remixing guidance](https://studio.blender.org/remixing/).

Changes made here: the referenced lesson workflows, recognizable watering-can
subject, material relationships, camera/light setup, and keyframe exercise were
translated into independently written, typed MCP operations and procedural
Three.js/WebGPU resources. Geometry, values, stable IDs, staging, and graph
layout were adapted for ThreeBrowser Studio. No lesson prose, screenshots,
videos, downloadable models, or `.blend` project files are included.

“Blender” is used descriptively to identify compatibility targets. This project
is not affiliated with or endorsed by the Blender Foundation.

## npm dependencies

The runtime dependencies are pinned in `package-lock.json`:

- `@modelcontextprotocol/server` 2.0.0 and `@modelcontextprotocol/core` 2.0.0
  ship a transition notice covering Apache-2.0 and remaining MIT-licensed code,
  plus CC BY 4.0 for documentation other than specifications.
- `acorn` 8.15.0, `acorn-walk` 8.3.4, and `zod` 4.2.1 are MIT licensed.

Their complete license texts are included with the installed packages supplied
by their respective publishers. This notice does not replace those licenses.

ThreeBrowser Runtime and Three.js are external runtime prerequisites and are
not bundled in this repository. Their licenses apply when they are obtained or
distributed separately.
