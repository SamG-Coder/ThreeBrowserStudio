import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import { resolveRuntimeRoot } from "../scripts/runtime-path.mjs";

async function fakeRuntime(root) {
  const launcher = path.join(root, "build", "bin", "runtime", "launch.mjs");
  await mkdir(path.dirname(launcher), { recursive: true });
  await writeFile(launcher, "", "utf8");
  return launcher;
}

test("runtime resolver prefers the explicit environment without copying runtime code", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "three-studio-runtime-"));
  const studioRoot = path.join(temporary, "studio");
  const runtimeRoot = path.join(temporary, "runtime");
  await mkdir(studioRoot, { recursive: true });
  const launcher = await fakeRuntime(runtimeRoot);
  const result = await resolveRuntimeRoot({
    studioRoot,
    environment: { THREEBROWSER_RUNTIME_ROOT: runtimeRoot },
    fallback: path.join(temporary, "missing"),
  });
  assert.equal(result.source, "environment");
  assert.equal(result.root, path.resolve(runtimeRoot));
  assert.equal(result.launcher, launcher);
});

test("runtime resolver accepts a machine-local configuration", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "three-studio-config-"));
  const studioRoot = path.join(temporary, "studio");
  const runtimeRoot = path.join(temporary, "runtime");
  await mkdir(studioRoot, { recursive: true });
  await fakeRuntime(runtimeRoot);
  await writeFile(
    path.join(studioRoot, ".studio-local.json"),
    JSON.stringify({ runtimeRoot }),
    "utf8",
  );
  const result = await resolveRuntimeRoot({
    studioRoot,
    environment: {},
    fallback: path.join(temporary, "missing"),
  });
  assert.equal(result.source, ".studio-local.json");
  assert.equal(result.root, path.resolve(runtimeRoot));
});
