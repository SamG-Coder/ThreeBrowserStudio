import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function cleanRoot(value) {
  const text = String(value ?? "").trim();
  return text ? path.resolve(text) : null;
}

export async function resolveRuntimeRoot({
  studioRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  environment = process.env,
  fallback = null,
} = {}) {
  const candidates = [];
  const configuredEnvironment = cleanRoot(environment.THREEBROWSER_RUNTIME_ROOT);
  if (configuredEnvironment) candidates.push({ source: "environment", root: configuredEnvironment });

  const localConfigPath = path.join(studioRoot, ".studio-local.json");
  if (await exists(localConfigPath)) {
    try {
      const config = JSON.parse(await readFile(localConfigPath, "utf8"));
      const configuredFile = cleanRoot(config.runtimeRoot);
      if (configuredFile) candidates.push({ source: ".studio-local.json", root: configuredFile });
    } catch (error) {
      throw new Error(`Invalid ${localConfigPath}: ${error.message}`);
    }
  }

  const packaged = path.resolve(studioRoot, "..", "host");
  candidates.push({ source: "packaged host", root: packaged });
  const sibling = path.resolve(studioRoot, "..", "ThreeBrowser", "ThreeBrowserRuntime");
  candidates.push({ source: "sibling checkout", root: sibling });
  const fallbackRoot = cleanRoot(fallback);
  if (fallbackRoot && !candidates.some(candidate => candidate.root === fallbackRoot)) {
    candidates.push({ source: "fallback", root: fallbackRoot });
  }

  for (const candidate of candidates) {
    const launcher = path.join(candidate.root, "build", "bin", "runtime", "launch.mjs");
    if (await exists(launcher)) return Object.freeze({ ...candidate, launcher });
  }

  const checked = candidates.map(candidate => `- ${candidate.source}: ${candidate.root}`).join("\n");
  throw new Error(
    `ThreeBrowser Runtime launcher was not found. Set THREEBROWSER_RUNTIME_ROOT or .studio-local.json.\n${checked}`,
  );
}
