import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "../core/persistence.mjs";
import { assertValidBehaviorSource, validateBehaviorSource } from "./behavior-validator.mjs";

const SCRIPT_ID = /^[a-z0-9](?:[a-z0-9/_-]{0,126}[a-z0-9])?$/;

export function normalizeScriptId(value) {
  const id = String(value ?? "").trim().replaceAll("\\", "/");
  if (!SCRIPT_ID.test(id) || id.includes("//") || id.split("/").includes("..")) {
    throw new TypeError("Script id must be a lowercase project path using letters, numbers, /, _ or -.");
  }
  return id;
}

export function resolveScriptPath(projectRoot, scriptId) {
  const root = path.resolve(String(projectRoot));
  const scriptsRoot = path.resolve(root, "scripts");
  const id = normalizeScriptId(scriptId);
  const resolved = path.resolve(scriptsRoot, `${id}.mjs`);
  const prefix = `${scriptsRoot}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new RangeError("Script path escaped the project scripts directory.");
  return resolved;
}

function digest(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export async function readBehaviorScript(projectRoot, scriptId) {
  const filePath = resolveScriptPath(projectRoot, scriptId);
  const [canonicalProject, canonicalScripts, canonicalFile, info] = await Promise.all([
    realpath(path.resolve(projectRoot)),
    realpath(path.resolve(projectRoot, "scripts")),
    realpath(filePath),
    lstat(filePath),
  ]);
  if (info.isSymbolicLink()
      || path.relative(canonicalProject, canonicalScripts).startsWith("..")
      || path.relative(canonicalScripts, canonicalFile).startsWith("..")) {
    throw new Error("Behaviour script path crosses a symbolic link outside the project.");
  }
  const source = await readFile(filePath, "utf8");
  return Object.freeze({
    id: normalizeScriptId(scriptId),
    path: filePath,
    source,
    bytes: Buffer.byteLength(source, "utf8"),
    sha256: digest(source),
  });
}

export async function upsertBehaviorScript(projectRoot, {
  id,
  source,
  trust = "agent-safe",
  allowTrusted = false,
} = {}) {
  if (trust !== "agent-safe" && trust !== "trusted-project") {
    throw new TypeError(`Unknown behaviour trust policy '${trust}'.`);
  }
  if (trust === "trusted-project" && !allowTrusted) {
    throw new Error("Enabling trusted-project code requires explicit user authority.");
  }
  const validation = trust === "agent-safe"
    ? assertValidBehaviorSource(source, { trust })
    : validateBehaviorSource(source, { trust });
  if (!validation.valid) {
    throw new SyntaxError(validation.diagnostics.map(item => item.message).join("\n"));
  }

  const scriptId = normalizeScriptId(id);
  const filePath = resolveScriptPath(projectRoot, scriptId);
  await atomicWriteFile(filePath, String(source), { projectRoot });
  return Object.freeze({
    id: scriptId,
    path: filePath,
    trust,
    bytes: validation.bytes,
    sha256: digest(String(source)),
    diagnostics: validation.diagnostics,
  });
}
