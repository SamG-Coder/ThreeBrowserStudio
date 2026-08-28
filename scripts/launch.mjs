import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeRoot } from "./runtime-path.mjs";
import { defaultSessionMarkerPath, readSessionMarker } from "../src/bridge/index.mjs";

const studioRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entry = path.join(studioRoot, "site-entry.mjs");
const runtime = await resolveRuntimeRoot({ studioRoot });
const projectArgument = process.argv.slice(2).find(argument => !argument.startsWith("--"));

console.error(`[ThreeBrowser Studio] runtime: ${runtime.root}`);
console.error(`[ThreeBrowser Studio] entry: ${entry}`);

const child = spawn(process.execPath, [runtime.launcher, entry], {
  cwd: studioRoot,
  env: {
    ...process.env,
    THREE_STUDIO_ROOT: studioRoot,
    ...(projectArgument ? { THREE_STUDIO_PROJECT: path.resolve(projectArgument) } : {}),
  },
  stdio: "inherit",
  windowsHide: false,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.once("error", error => {
  console.error(`[ThreeBrowser Studio] launch failed: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", async (code, signal) => {
  const markerPath = process.env.THREE_STUDIO_SESSION_MARKER || defaultSessionMarkerPath();
  const ownsMarker = await readSessionMarker(markerPath, { maxAgeMs: Infinity })
    .then(marker => marker.pid === child.pid)
    .catch(() => false);
  if (ownsMarker) await rm(markerPath, { force: true }).catch(() => {});
  if (signal) console.error(`[ThreeBrowser Studio] runtime exited on ${signal}`);
  process.exitCode = Number.isInteger(code) ? code : signal ? 1 : 0;
});
