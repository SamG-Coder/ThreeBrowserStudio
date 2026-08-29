import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import { StudioApplication } from "../src/runtime/studio-application.mjs";

test("Studio keeps checkout projects beside the app unless THREE_STUDIO_PROJECTS is set", async () => {
  const studioRoot = await mkdtemp(path.join(os.tmpdir(), "three-studio-projects-"));
  const packagedProjects = path.join(studioRoot, "user-projects");
  const checkout = new StudioApplication({
    environment: { THREE_STUDIO_ROOT: studioRoot },
    markerPath: path.join(studioRoot, "live-session.json"),
  });
  assert.equal(checkout.projectsRoot, path.join(studioRoot, "projects"));

  const packaged = new StudioApplication({
    environment: {
      THREE_STUDIO_ROOT: studioRoot,
      THREE_STUDIO_PROJECTS: packagedProjects,
    },
    markerPath: path.join(studioRoot, "live-session.json"),
  });
  assert.equal(packaged.projectsRoot, path.resolve(packagedProjects));
});
