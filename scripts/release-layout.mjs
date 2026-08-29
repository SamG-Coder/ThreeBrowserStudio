import { cp, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

export const REQUIRED_HOST_BINARIES = Object.freeze([
  "three_browser_runtime.node",
  "three_native.dll",
  "three_webgpu.dll",
  "wgpu_native.dll",
  "libstdc++-6.dll",
  "libgcc_s_seh-1.dll",
  "libwinpthread-1.dll",
]);

export const LEAN_THREE_JS_FILES = Object.freeze([
  "package.json",
  "LICENSE",
  "build/three.core.js",
  "build/three.webgpu.js",
  "build/three.tsl.js",
  "build/three.module.js",
]);

export const PRODUCTION_NODE_PACKAGES = Object.freeze([
  "@modelcontextprotocol/server",
  "@modelcontextprotocol/core",
  "acorn",
  "acorn-walk",
  "zod",
]);

export const STUDIO_APP_FILES = Object.freeze([
  "site-entry.mjs",
  "package.json",
  "threebrowser.pull.json",
]);

export const HOST_RUNTIME_FILES = Object.freeze([
  "launch.mjs",
  "browser-host.mjs",
  "module-loader.mjs",
  "lil-gui-stub.mjs",
  "three-webgpu-gpu.js",
  "three-webgpu-cmd.js",
]);

export const RELEASE_AGENT_DOCUMENTS = Object.freeze([
  "AGENT_RULES.md",
]);

export const RELEASE_SKILL_FILES = Object.freeze([
  "skills/threebrowser-studio-mcp/SKILL.md",
]);

export function toPosix(relativePath) {
  return String(relativePath ?? "").replaceAll("\\", "/");
}

export function releaseFolderName(version, platform = "win-x64") {
  return `ThreeBrowserStudio-${version}-${platform}`;
}

export function packagedHostRoot(studioRoot) {
  return path.resolve(studioRoot, "..", "host");
}

export function isOptionalDlssBinary(name) {
  const lower = String(name ?? "").toLowerCase();
  return lower.startsWith("nvngx_dlss") || lower.startsWith("sl.") || lower === "nvlowlatencyvk.dll";
}

export function classifyHostBinary(name, { withDlss = false } = {}) {
  const lower = String(name ?? "").toLowerCase();
  if (REQUIRED_HOST_BINARIES.some(binary => binary.toLowerCase() === lower)) return "include";
  if (isOptionalDlssBinary(name)) return withDlss ? "include" : "exclude-dlss";
  if (lower.endsWith(".exe") || lower.endsWith(".log") || lower.endsWith(".pdb") || lower.endsWith(".ilk")) {
    return "exclude-sample-or-tool";
  }
  return "exclude-unknown";
}

export function includeHostRuntimeRelative(relativePath) {
  const posix = toPosix(relativePath);
  if (!posix || posix === ".") return true;
  if (HOST_RUNTIME_FILES.includes(posix)) return true;
  if (posix === "three") return true;
  if (posix.startsWith("three/")) return /^\d\d-.+\.js$/.test(posix.slice("three/".length));
  return false;
}

export function includeStudioAppRelative(relativePath) {
  const posix = toPosix(relativePath);
  if (!posix || posix === ".") return true;
  if (STUDIO_APP_FILES.includes(posix)) return true;
  if (posix === "templates" || posix.startsWith("templates/")) return true;
  if (posix === "src") return true;
  if (posix === "src/tutorials" || posix.startsWith("src/tutorials/")) return false;
  if (posix.startsWith("src/")) return true;
  if (posix === "scripts") return true;
  return posix === "scripts/launch.mjs" || posix === "scripts/runtime-path.mjs";
}

export function includeThreeJsRelative(relativePath) {
  const posix = toPosix(relativePath);
  if (!posix || posix === ".") return true;
  if (LEAN_THREE_JS_FILES.includes(posix)) return true;
  return LEAN_THREE_JS_FILES.some(file => file.startsWith(`${posix}/`));
}

export async function copyDirectoryFiltered(source, destination, includeRelative) {
  await cp(source, destination, {
    recursive: true,
    filter(current) {
      const relative = path.relative(source, current);
      return includeRelative(relative);
    },
  });
}

export async function copyLeanHost(runtimeRoot, destinationRoot, { withDlss = false } = {}) {
  const binSource = path.join(runtimeRoot, "build", "bin");
  const runtimeSource = path.join(binSource, "runtime");
  const threeSource = path.join(runtimeRoot, "node_modules", "three");
  const binDestination = path.join(destinationRoot, "build", "bin");
  const runtimeDestination = path.join(binDestination, "runtime");
  const threeDestination = path.join(destinationRoot, "node_modules", "three");
  const included = [];
  const excluded = [];

  await mkdir(binDestination, { recursive: true });
  const binEntries = await readdir(binSource, { withFileTypes: true });
  for (const entry of binEntries) {
    if (!entry.isFile()) continue;
    const decision = classifyHostBinary(entry.name, { withDlss });
    const from = path.join(binSource, entry.name);
    if (decision === "include") {
      await cp(from, path.join(binDestination, entry.name));
      included.push(`build/bin/${entry.name}`);
    } else {
      excluded.push({ path: `build/bin/${entry.name}`, reason: decision });
    }
  }

  const missing = REQUIRED_HOST_BINARIES.filter(name => !included.includes(`build/bin/${name}`));
  if (missing.length) {
    throw new Error(`Lean host is missing required compiled binaries: ${missing.join(", ")}`);
  }

  await copyDirectoryFiltered(runtimeSource, runtimeDestination, includeHostRuntimeRelative);
  included.push("build/bin/runtime/");
  await copyDirectoryFiltered(threeSource, threeDestination, includeThreeJsRelative);
  included.push("node_modules/three/");
  return { included, excluded };
}

export async function copyStudioApp(studioRoot, destinationRoot) {
  await mkdir(destinationRoot, { recursive: true });
  for (const file of STUDIO_APP_FILES) {
    await cp(path.join(studioRoot, file), path.join(destinationRoot, file));
  }
  await copyDirectoryFiltered(
    path.join(studioRoot, "templates"),
    path.join(destinationRoot, "templates"),
    () => true,
  );
  await copyDirectoryFiltered(
    path.join(studioRoot, "src"),
    path.join(destinationRoot, "src"),
    relative => includeStudioAppRelative(path.posix.join("src", toPosix(relative))),
  );
  await mkdir(path.join(destinationRoot, "scripts"), { recursive: true });
  await cp(path.join(studioRoot, "scripts", "launch.mjs"), path.join(destinationRoot, "scripts", "launch.mjs"));
  await cp(path.join(studioRoot, "scripts", "runtime-path.mjs"), path.join(destinationRoot, "scripts", "runtime-path.mjs"));
}

export async function copyReleaseMcpBundle(studioRoot, folder) {
  const mcpSource = path.join(studioRoot, "packaging", "mcp");
  await copyDirectoryFiltered(mcpSource, path.join(folder, "mcp"), () => true);
  await copyDirectoryFiltered(path.join(studioRoot, "docs"), path.join(folder, "docs"), () => true);
  for (const file of RELEASE_AGENT_DOCUMENTS) {
    await cp(path.join(studioRoot, file), path.join(folder, file));
    await mkdir(path.join(folder, "app"), { recursive: true });
    await cp(path.join(studioRoot, file), path.join(folder, "app", file));
  }
  for (const file of RELEASE_SKILL_FILES) {
    const destination = path.join(folder, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(studioRoot, file), destination);
  }
}

export async function copyProductionNodeModules(studioRoot, destinationRoot) {
  for (const name of PRODUCTION_NODE_PACKAGES) {
    const from = path.join(studioRoot, "node_modules", name);
    const info = await stat(from);
    if (!info.isDirectory()) throw new Error(`Production package is missing: ${name}`);
    await cp(from, path.join(destinationRoot, "node_modules", name), { recursive: true });
  }
}

export function defaultUserProjectsRoot({
  env = process.env,
  platform = process.platform,
  homeDirectory = process.env.USERPROFILE || process.env.HOME || "",
} = {}) {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(homeDirectory, "AppData", "Local");
    return path.join(localAppData, "ThreeBrowserStudio", "projects");
  }
  if (platform === "darwin") {
    return path.join(homeDirectory, "Library", "Application Support", "ThreeBrowserStudio", "projects");
  }
  const stateRoot = env.XDG_STATE_HOME || path.join(homeDirectory, ".local", "state");
  return path.join(stateRoot, "threebrowser-studio", "projects");
}
