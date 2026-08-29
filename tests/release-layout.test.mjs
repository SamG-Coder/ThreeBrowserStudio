import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyHostBinary,
  copyLeanHost,
  copyReleaseMcpBundle,
  copyStudioApp,
  includeHostRuntimeRelative,
  includeStudioAppRelative,
  includeThreeJsRelative,
  releaseFolderName,
} from "../scripts/release-layout.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("lean host keeps compiled runtime binaries and drops samples, tools, and DLSS", () => {
  assert.equal(classifyHostBinary("three_native.dll"), "include");
  assert.equal(classifyHostBinary("three_browser_runtime.node"), "include");
  assert.equal(classifyHostBinary("wgpu_native.dll"), "include");
  assert.equal(classifyHostBinary("three_native_cubes.exe"), "exclude-sample-or-tool");
  assert.equal(classifyHostBinary("glslangValidator.exe"), "exclude-sample-or-tool");
  assert.equal(classifyHostBinary("summer-scenes.log"), "exclude-sample-or-tool");
  assert.equal(classifyHostBinary("nvngx_dlss.dll"), "exclude-dlss");
  assert.equal(classifyHostBinary("sl.common.dll"), "exclude-dlss");
  assert.equal(classifyHostBinary("nvngx_dlss.dll", { withDlss: true }), "include");
});

test("lean runtime JS keeps the host launcher and drops puller, tests, and samples", () => {
  assert.equal(includeHostRuntimeRelative("launch.mjs"), true);
  assert.equal(includeHostRuntimeRelative("browser-host.mjs"), true);
  assert.equal(includeHostRuntimeRelative("three/10-renderer.js"), true);
  assert.equal(includeHostRuntimeRelative("three/exports/10-renderer.txt"), false);
  assert.equal(includeHostRuntimeRelative("site-puller.mjs"), false);
  assert.equal(includeHostRuntimeRelative("vite-relinker.mjs"), false);
  assert.equal(includeHostRuntimeRelative("webgpu-msaa-store.test.mjs"), false);
  assert.equal(includeHostRuntimeRelative("mars-rtx-lighting.mjs"), false);
});

test("lean Studio app keeps the viewport and drops tutorials and extra scripts", () => {
  assert.equal(includeStudioAppRelative("site-entry.mjs"), true);
  assert.equal(includeStudioAppRelative("threebrowser.pull.json"), true);
  assert.equal(includeStudioAppRelative("src/viewport/main.mjs"), true);
  assert.equal(includeStudioAppRelative("scripts/launch.mjs"), true);
  assert.equal(includeStudioAppRelative("scripts/runtime-path.mjs"), true);
  assert.equal(includeStudioAppRelative("src/tutorials/blender-fundamentals.mjs"), false);
  assert.equal(includeStudioAppRelative("scripts/obs-showcase.mjs"), false);
  assert.equal(includeStudioAppRelative("tests/core-kernel.test.mjs"), false);
});

test("lean Three.js copy keeps only the WebGPU/TSL builds", () => {
  assert.equal(includeThreeJsRelative("build/three.webgpu.js"), true);
  assert.equal(includeThreeJsRelative("build/three.tsl.js"), true);
  assert.equal(includeThreeJsRelative("build/three.module.js"), true);
  assert.equal(includeThreeJsRelative("build/three.core.js"), true);
  assert.equal(includeThreeJsRelative("src/Three.js"), false);
  assert.equal(includeThreeJsRelative("examples/jsm/controls/OrbitControls.js"), false);
  assert.equal(includeThreeJsRelative("build/three.cjs"), false);
});

test("release folder name is versioned and platform-specific", () => {
  assert.equal(releaseFolderName("0.2.0"), "ThreeBrowserStudio-0.2.0-win-x64");
});

test("copyLeanHost stages required binaries and omits cubes and DLSS", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "three-studio-lean-host-"));
  const runtimeRoot = path.join(temporary, "runtime");
  const destination = path.join(temporary, "host");
  const bin = path.join(runtimeRoot, "build", "bin");
  await mkdir(path.join(bin, "runtime", "three"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "node_modules", "three", "build"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "node_modules", "three", "src"), { recursive: true });
  for (const name of [
    "three_browser_runtime.node",
    "three_native.dll",
    "three_webgpu.dll",
    "wgpu_native.dll",
    "libstdc++-6.dll",
    "libgcc_s_seh-1.dll",
    "libwinpthread-1.dll",
    "three_native_cubes.exe",
    "nvngx_dlss.dll",
  ]) {
    await writeFile(path.join(bin, name), name, "utf8");
  }
  await writeFile(path.join(bin, "runtime", "launch.mjs"), "export {}\n", "utf8");
  await writeFile(path.join(bin, "runtime", "browser-host.mjs"), "export {}\n", "utf8");
  await writeFile(path.join(bin, "runtime", "module-loader.mjs"), "export {}\n", "utf8");
  await writeFile(path.join(bin, "runtime", "lil-gui-stub.mjs"), "export {}\n", "utf8");
  await writeFile(path.join(bin, "runtime", "three-webgpu-gpu.js"), "", "utf8");
  await writeFile(path.join(bin, "runtime", "three-webgpu-cmd.js"), "", "utf8");
  await writeFile(path.join(bin, "runtime", "site-puller.mjs"), "export {}\n", "utf8");
  await writeFile(path.join(bin, "runtime", "three", "01-constants.js"), "", "utf8");
  await writeFile(path.join(runtimeRoot, "node_modules", "three", "package.json"), "{}", "utf8");
  await writeFile(path.join(runtimeRoot, "node_modules", "three", "LICENSE"), "MIT\n", "utf8");
  await writeFile(path.join(runtimeRoot, "node_modules", "three", "build", "three.core.js"), "", "utf8");
  await writeFile(path.join(runtimeRoot, "node_modules", "three", "build", "three.webgpu.js"), "", "utf8");
  await writeFile(path.join(runtimeRoot, "node_modules", "three", "build", "three.tsl.js"), "", "utf8");
  await writeFile(path.join(runtimeRoot, "node_modules", "three", "build", "three.module.js"), "", "utf8");
  await writeFile(path.join(runtimeRoot, "node_modules", "three", "build", "three.cjs"), "", "utf8");
  await writeFile(path.join(runtimeRoot, "node_modules", "three", "src", "Three.js"), "", "utf8");

  const plan = await copyLeanHost(runtimeRoot, destination);
  const copiedCubes = await readFile(path.join(destination, "build", "bin", "three_native.dll"), "utf8");
  assert.equal(copiedCubes, "three_native.dll");
  await assert.rejects(() => readFile(path.join(destination, "build", "bin", "three_native_cubes.exe")));
  await assert.rejects(() => readFile(path.join(destination, "build", "bin", "nvngx_dlss.dll")));
  await assert.rejects(() => readFile(path.join(destination, "build", "bin", "runtime", "site-puller.mjs")));
  await assert.rejects(() => readFile(path.join(destination, "node_modules", "three", "src", "Three.js")));
  await assert.rejects(() => readFile(path.join(destination, "node_modules", "three", "build", "three.cjs")));
  assert.equal(await readFile(path.join(destination, "node_modules", "three", "build", "three.core.js"), "utf8"), "");
  assert.equal(await readFile(path.join(destination, "build", "bin", "runtime", "launch.mjs"), "utf8"), "export {}\n");
  assert.ok(plan.excluded.some(item => item.path.endsWith("three_native_cubes.exe")));
  assert.ok(plan.excluded.some(item => item.reason === "exclude-dlss"));
});

test("copyStudioApp omits tutorial modules from the packaged app", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "three-studio-lean-app-"));
  const destination = path.join(temporary, "app");
  await copyStudioApp(root, destination);
  await readFile(path.join(destination, "site-entry.mjs"), "utf8");
  await readFile(path.join(destination, "threebrowser.pull.json"), "utf8");
  await readFile(path.join(destination, "src", "viewport", "main.mjs"), "utf8");
  await readFile(path.join(destination, "scripts", "launch.mjs"), "utf8");
  await assert.rejects(() => readFile(path.join(destination, "src", "tutorials", "blender-fundamentals.mjs")));
  await assert.rejects(() => readFile(path.join(destination, "scripts", "package-release.mjs")));
});

test("release MCP bundle copies agent rules and Cursor, Grok, and Codex templates", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "three-studio-mcp-bundle-"));
  const folder = path.join(temporary, "pack");
  await mkdir(path.join(folder, "app"), { recursive: true });
  await copyReleaseMcpBundle(root, folder);
  assert.match(await readFile(path.join(folder, "AGENT_RULES.md"), "utf8"), /three_studio_status/);
  assert.match(await readFile(path.join(folder, "app", "AGENT_RULES.md"), "utf8"), /three_studio_status/);
  assert.match(
    await readFile(path.join(folder, "skills", "threebrowser-studio-mcp", "SKILL.md"), "utf8"),
    /three_studio_\*/,
  );
  const cursor = JSON.parse(await readFile(path.join(folder, "mcp", "cursor", "mcp.json"), "utf8"));
  assert.equal(cursor.mcpServers["threebrowser-studio"].args[0], "EXTRACT/app/src/mcp/server.mjs");
  const workspace = JSON.parse(await readFile(path.join(folder, "mcp", "cursor", "workspace.mcp.json"), "utf8"));
  assert.equal(workspace.mcpServers["threebrowser-studio"].args[0], "${workspaceFolder}/app/src/mcp/server.mjs");
  const grok = await readFile(path.join(folder, "mcp", "grok", "config.toml"), "utf8");
  assert.match(grok, /EXTRACT\\\\app\\\\src\\\\mcp\\\\server\.mjs/);
  const codex = await readFile(path.join(folder, "mcp", "codex.toml"), "utf8");
  assert.match(codex, /EXTRACT\\\\app\\\\src\\\\mcp\\\\server\.mjs/);
  assert.match(await readFile(path.join(folder, "mcp", "README.txt"), "utf8"), /Cursor/);
  assert.match(await readFile(path.join(folder, "docs", "README.md"), "utf8"), /MCP is the editor/);
  assert.match(await readFile(path.join(folder, "docs", "ai", "patterns.md"), "utf8"), /pixelForecast/);
  assert.match(await readFile(path.join(folder, "docs", "users", "getting-started.md"), "utf8"), /ThreeBrowserStudio\.exe/);
});
