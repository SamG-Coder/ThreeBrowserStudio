import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveRuntimeRoot } from "./runtime-path.mjs";
import {
  copyLeanHost,
  copyProductionNodeModules,
  copyStudioApp,
  releaseFolderName,
} from "./release-layout.mjs";

const studioRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseArguments(argv) {
  const values = {
    withDlss: false,
    skipZip: false,
    withNode: false,
    output: path.join(studioRoot, "dist"),
    runtimeRoot: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--with-dlss") values.withDlss = true;
    else if (argument === "--skip-zip") values.skipZip = true;
    else if (argument === "--with-node") values.withNode = true;
    else if (argument === "--skip-node") values.withNode = false;
    else if (argument === "--output" || argument === "--runtime") {
      if (!argv[index + 1]) throw new Error(`${argument} requires a path.`);
      values[argument === "--output" ? "output" : "runtimeRoot"] = path.resolve(argv[++index]);
    } else {
      throw new Error(`Unknown release argument: ${argument}`);
    }
  }
  return values;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true, ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal || code}`));
    });
  });
}

function nodeMajor(execPath = process.execPath) {
  const version = process.versions?.node;
  if (execPath === process.execPath && version) return Number(version.split(".")[0]);
  return null;
}

async function compileWindowsLauncher(destination) {
  const project = path.join(studioRoot, "packaging", "win-launcher", "ThreeBrowserStudio.Launcher.csproj");
  const publishDirectory = path.join(studioRoot, "packaging", "win-launcher", "bin", "Release", "publish");
  await rm(publishDirectory, { recursive: true, force: true });
  await run("dotnet", [
    "publish",
    project,
    "-c", "Release",
    "-r", "win-x64",
    "--self-contained", "true",
    "-p:PublishSingleFile=true",
    "-p:PublishTrimmed=true",
    "-o", publishDirectory,
  ]);
  const published = path.join(publishDirectory, "ThreeBrowserStudio.exe");
  await cp(published, destination);
}

function releaseReadme({ version, withDlss }) {
  return `# ThreeBrowser Studio ${version}

This is the lean Windows x64 release. Double-click \`ThreeBrowserStudio.exe\`.

The folder contains Studio and only the compiled ThreeBrowser host binaries
needed to open the native WebGPU viewport. It does **not** ship Node.js,
ThreeC++ / threepp source, CMake projects, samples, games, smoke tests, or the
site-puller / Vite tooling.

The first launch uses Node.js 24+ from PATH, or asks to download the official
Windows x64 node.exe from nodejs.org into
\`%LOCALAPPDATA%\\ThreeBrowserStudio\\node\`. Set \`THREE_STUDIO_NODE\` to pick
an exact binary, or \`THREE_STUDIO_DOWNLOAD_NODE=1\` to download without a prompt.

Projects are stored at:

\`%LOCALAPPDATA%\\ThreeBrowserStudio\\projects\`

MCP (after the window is open):

- command: \`node\` (or \`%LOCALAPPDATA%\\ThreeBrowserStudio\\node\\node.exe\`)
- arguments: \`app\\src\\mcp\\server.mjs\`
- working directory: \`app\`

The compiled \`host\\build\\bin\\three_native.dll\` is required by the current
host addon. It is the built library, not the ThreeC++ source tree.
${withDlss ? "\nThis pack includes the optional NVIDIA DLSS / Streamline binaries.\n" : "\nNVIDIA DLSS / Streamline binaries are omitted from this lean pack.\n"}
Studio source in this pack is MIT licensed; see LICENSE. Compiled host
binaries and npm dependencies keep their own licenses; see
THIRD_PARTY_NOTICES.md.
`;
}

async function writeReleaseDocs(folder, { version, withDlss }) {
  await writeFile(path.join(folder, "README.txt"), releaseReadme({ version, withDlss }), "utf8");
  await cp(path.join(studioRoot, "LICENSE"), path.join(folder, "LICENSE"));
  await cp(path.join(studioRoot, "THIRD_PARTY_NOTICES.md"), path.join(folder, "THIRD_PARTY_NOTICES.md"));
  await writeFile(path.join(folder, "mcp.example.toml"), `# Replace EXTRACT with the unpacked release folder.
# command can be PATH node, or %LOCALAPPDATA%\\ThreeBrowserStudio\\node\\node.exe
[mcp_servers.threebrowser-studio]
command = "node"
args = [
  "EXTRACT\\\\app\\\\src\\\\mcp\\\\server.mjs",
]
cwd = "EXTRACT\\\\app"
startup_timeout_sec = 10
tool_timeout_sec = 120
default_tools_approval_mode = "writes"
`, "utf8");
}

export async function packageRelease({
  outputDirectory = path.join(studioRoot, "dist"),
  runtimeRoot = null,
  withDlss = false,
  skipZip = false,
  withNode = false,
} = {}) {
  const packageJson = JSON.parse(await readFile(path.join(studioRoot, "package.json"), "utf8"));
  const version = packageJson.version;
  const folderName = releaseFolderName(version);
  const folder = path.join(outputDirectory, folderName);
  const runtime = runtimeRoot
    ? { root: path.resolve(runtimeRoot), source: "argument" }
    : await resolveRuntimeRoot({ studioRoot });

  console.error(`[ThreeBrowser Studio] packaging ${folderName}`);
  console.error(`[ThreeBrowser Studio] host source: ${runtime.root}`);
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });

  const app = path.join(folder, "app");
  const host = path.join(folder, "host");
  await copyStudioApp(studioRoot, app);
  await copyProductionNodeModules(studioRoot, app);
  const hostPlan = await copyLeanHost(runtime.root, host, { withDlss });

  if (withNode) {
    if (nodeMajor() < 24) throw new Error("Packaging --with-node requires Node.js 24 or newer.");
    await mkdir(path.join(folder, "node"), { recursive: true });
    await cp(process.execPath, path.join(folder, "node", "node.exe"));
  }

  const exe = path.join(folder, "ThreeBrowserStudio.exe");
  await compileWindowsLauncher(exe);
  await writeReleaseDocs(folder, { version, withDlss });
  const manifest = {
    name: "ThreeBrowserStudio",
    version,
    platform: "win-x64",
    lean: true,
    withDlss,
    withNode,
    hostSource: runtime.source ?? "resolved",
    excluded: hostPlan.excluded,
    layout: [
      "ThreeBrowserStudio.exe",
      "app/",
      "host/",
      "README.txt",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "mcp.example.toml",
      "release-manifest.json",
      ...(withNode ? ["node/"] : []),
    ],
  };
  await writeFile(path.join(folder, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  let zipPath = null;
  let checksumPath = null;
  if (!skipZip) {
    zipPath = path.join(outputDirectory, `${folderName}.zip`);
    await rm(zipPath, { force: true });
    await run("tar", ["-a", "-cf", zipPath, "-C", outputDirectory, folderName]);
    const digest = await sha256File(zipPath);
    checksumPath = `${zipPath}.sha256`;
    await writeFile(checksumPath, `${digest}  ${folderName}.zip\n`, "utf8");
  }

  console.error(`[ThreeBrowser Studio] wrote ${folder}`);
  if (zipPath) console.error(`[ThreeBrowser Studio] wrote ${zipPath}`);
  if (checksumPath) console.error(`[ThreeBrowser Studio] wrote ${checksumPath}`);
  return { folder, zipPath, checksumPath, manifest, hostPlan };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    await packageRelease({
      outputDirectory: options.output,
      runtimeRoot: options.runtimeRoot,
      withDlss: options.withDlss,
      skipZip: options.skipZip,
      withNode: options.withNode,
    });
  } catch (error) {
    console.error(`[ThreeBrowser Studio] release pack failed: ${error.message}`);
    process.exitCode = 1;
  }
}
