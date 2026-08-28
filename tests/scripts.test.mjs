import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  normalizeScriptId,
  resolveScriptPath,
  upsertBehaviorScript,
  validateBehaviorSource,
} from "../src/scripts/index.mjs";

const SAFE_SOURCE = `
  import { Vector3 } from "three";
  const direction = new Vector3(1, 0, 0);
  export default defineBehavior({
    start(context) { context.state.speed = 2; },
    fixedUpdate(context, delta) {
      context.transform.translate(direction, context.state.speed * delta);
    },
    stop(context) { context.events.clear(); }
  });
`;

test("agent-safe behaviour accepts deterministic Studio/Three game code", () => {
  const result = validateBehaviorSource(SAFE_SOURCE);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.ok(result.bytes > 0);
});

test("agent-safe behaviour rejects host, network, renderer and dynamic-code access", () => {
  const cases = [
    `import fs from "node:fs"; export default {};`,
    `export default { update() { process.exit(1); } };`,
    `export default { async start() { await import("./other.mjs"); } };`,
    `export default { update() { fetch("https://example.com"); } };`,
    `import { WebGPURenderer } from "three/webgpu"; export default {};`,
    `export default { update() { eval("1 + 1"); } };`,
  ];
  for (const source of cases) {
    const result = validateBehaviorSource(source);
    assert.equal(result.valid, false, source);
    assert.ok(result.diagnostics.length >= 1);
  }
});

test("agent-safe behaviour rejects invalid trust, prototype escapes, namespace renderers, and transitive imports", () => {
  for (const source of [
    `export default ({ }).constructor.constructor("return process")();`,
    `import * as THREE from "three/webgpu"; export default () => new THREE.WebGPURenderer();`,
    `import helper from "./helper.mjs"; export default helper;`,
  ]) {
    assert.equal(validateBehaviorSource(source).valid, false);
  }
  assert.equal(validateBehaviorSource(`process.exit(); export default {};`, { trust: "typo" }).valid, false);
});

test("behaviour requires one default export and rejects top-level await", () => {
  assert.equal(validateBehaviorSource(`export const value = 2;`).valid, false);
  const result = validateBehaviorSource(`await Promise.resolve(); export default {};`);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some(item => item.code === "script_top_level_await_forbidden"));
});

test("script IDs remain inside the project scripts directory", () => {
  assert.equal(normalizeScriptId("player/door-controller"), "player/door-controller");
  assert.throws(() => normalizeScriptId("../escape"));
  assert.throws(() => normalizeScriptId("Player Door"));
  const resolved = resolveScriptPath("C:\\Projects\\Example", "player/door-controller");
  assert.match(resolved.replaceAll("\\", "/"), /\/scripts\/player\/door-controller\.mjs$/);
});

test("script store validates and atomically saves ordinary project code", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "three-studio-script-"));
  const saved = await upsertBehaviorScript(projectRoot, {
    id: "player/door-controller",
    source: SAFE_SOURCE,
  });
  assert.equal(saved.trust, "agent-safe");
  assert.equal(saved.sha256.length, 64);
  assert.equal(await readFile(saved.path, "utf8"), SAFE_SOURCE);
  await assert.rejects(
    () => upsertBehaviorScript(projectRoot, {
      id: "trusted",
      source: "export default {};",
      trust: "trusted-project",
    }),
    /explicit user authority/,
  );
  await assert.rejects(
    () => upsertBehaviorScript(projectRoot, {
      id: "bad-trust",
      trust: "typo",
      source: `process.exit(); export default {};`,
    }),
    /Unknown behaviour trust policy/,
  );
});
