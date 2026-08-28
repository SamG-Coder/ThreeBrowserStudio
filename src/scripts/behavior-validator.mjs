import { parse } from "acorn";
import * as walk from "acorn-walk";

export const MAX_BEHAVIOR_BYTES = 256 * 1024;

export const AGENT_SAFE_IMPORTS = Object.freeze([
  "@threebrowser/studio",
  "three",
  "three/webgpu",
  "three/tsl",
]);

const FORBIDDEN_GLOBALS = new Set([
  "process",
  "require",
  "module",
  "exports",
  "global",
  "globalThis",
  "window",
  "document",
  "navigator",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "Worker",
  "SharedWorker",
  "Deno",
  "Bun",
  "eval",
  "Function",
]);

const FORBIDDEN_THREE_IMPORTS = new Set([
  "WebGLRenderer",
  "WebGPURenderer",
]);

function diagnostic(code, message, node = null) {
  return Object.freeze({
    severity: "error",
    code,
    message,
    line: node?.loc?.start?.line ?? null,
    column: node?.loc?.start?.column ?? null,
  });
}

function isAllowedImport(specifier) {
  return AGENT_SAFE_IMPORTS.includes(specifier);
}

function isPropertyName(identifier, parent) {
  if (!parent) return false;
  if ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression")
      && parent.property === identifier && !parent.computed) return true;
  if ((parent.type === "Property" || parent.type === "MethodDefinition")
      && parent.key === identifier && !parent.computed) return true;
  return false;
}

function hasFunctionAncestor(ancestors) {
  return ancestors.some(node => [
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
  ].includes(node.type));
}

/**
 * Validate an ordinary Studio behaviour module before it can be saved or
 * loaded as agent-safe project code. This is a capability-policy validator;
 * the runtime still executes accepted code inside a restricted context.
 */
export function validateBehaviorSource(source, {
  trust = "agent-safe",
  maxBytes = MAX_BEHAVIOR_BYTES,
} = {}) {
  const text = String(source ?? "");
  const bytes = Buffer.byteLength(text, "utf8");
  const diagnostics = [];

  if (trust !== "agent-safe" && trust !== "trusted-project") {
    diagnostics.push(diagnostic(
      "script_trust_invalid",
      `Unknown behaviour trust policy '${trust}'.`,
    ));
    return Object.freeze({ valid: false, trust, bytes, diagnostics: Object.freeze(diagnostics) });
  }

  if (bytes > maxBytes) {
    diagnostics.push(diagnostic(
      "script_size_limit",
      `Behaviour source is ${bytes} bytes; the limit is ${maxBytes}.`,
    ));
    return Object.freeze({ valid: false, trust, bytes, diagnostics: Object.freeze(diagnostics) });
  }

  let ast;
  try {
    ast = parse(text, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
      allowHashBang: false,
    });
  } catch (error) {
    diagnostics.push(Object.freeze({
      severity: "error",
      code: "script_syntax",
      message: error.message,
      line: error.loc?.line ?? null,
      column: error.loc?.column ?? null,
    }));
    return Object.freeze({ valid: false, trust, bytes, diagnostics: Object.freeze(diagnostics) });
  }

  let defaultExportCount = 0;
  const threeNamespaces = new Set();
  walk.ancestor(ast, {
    ImportDeclaration(node) {
      const specifier = String(node.source?.value ?? "");
      if (trust === "agent-safe" && !isAllowedImport(specifier)) {
        diagnostics.push(diagnostic(
          "script_import_forbidden",
          `Agent-safe behaviour cannot import '${specifier}'.`,
          node,
        ));
      }
      if (trust === "agent-safe" && specifier.startsWith("three")) {
        for (const imported of node.specifiers ?? []) {
          const name = imported.imported?.name ?? imported.local?.name;
          if (imported.type === "ImportNamespaceSpecifier") threeNamespaces.add(imported.local.name);
          if (FORBIDDEN_THREE_IMPORTS.has(name)) {
            diagnostics.push(diagnostic(
              "script_renderer_forbidden",
              `Agent-safe behaviour cannot create or import ${name}; Studio owns the renderer.`,
              imported,
            ));
          }
        }
      }
    },
    ExportNamedDeclaration(node) {
      const specifier = node.source?.value;
      if (trust === "agent-safe" && specifier && !isAllowedImport(String(specifier))) {
        diagnostics.push(diagnostic(
          "script_export_forbidden",
          `Agent-safe behaviour cannot re-export '${specifier}'.`,
          node,
        ));
      }
    },
    ExportAllDeclaration(node) {
      if (trust === "agent-safe") {
        diagnostics.push(diagnostic(
          "script_export_all_forbidden",
          "Agent-safe behaviour cannot use export *.",
          node,
        ));
      }
    },
    ExportDefaultDeclaration() {
      defaultExportCount += 1;
    },
    ImportExpression(node) {
      if (trust === "agent-safe") {
        diagnostics.push(diagnostic(
          "script_dynamic_import_forbidden",
          "Agent-safe behaviour cannot use dynamic import().",
          node,
        ));
      }
    },
    MetaProperty(node) {
      if (trust === "agent-safe" && node.meta?.name === "import") {
        diagnostics.push(diagnostic(
          "script_import_meta_forbidden",
          "Agent-safe behaviour cannot access import.meta.",
          node,
        ));
      }
    },
    AwaitExpression(node, ancestors) {
      if (trust === "agent-safe" && !hasFunctionAncestor(ancestors)) {
        diagnostics.push(diagnostic(
          "script_top_level_await_forbidden",
          "Agent-safe behaviour cannot use top-level await.",
          node,
        ));
      }
    },
    Identifier(node, ancestors) {
      if (trust !== "agent-safe" || !FORBIDDEN_GLOBALS.has(node.name)) return;
      const parent = ancestors.at(-2);
      if (isPropertyName(node, parent)) return;
      diagnostics.push(diagnostic(
        "script_global_forbidden",
        `Agent-safe behaviour cannot reference or shadow '${node.name}'.`,
        node,
      ));
    },
    MemberExpression(node) {
      if (trust !== "agent-safe") return;
      const property = node.computed && node.property?.type === "Literal"
        ? String(node.property.value)
        : node.property?.name;
      if (["constructor", "__proto__", "prototype"].includes(property)) {
        diagnostics.push(diagnostic(
          "script_prototype_escape_forbidden",
          `Agent-safe behaviour cannot access '${property}'.`,
          node,
        ));
      }
      if (node.object?.type === "Identifier"
          && threeNamespaces.has(node.object.name)
          && FORBIDDEN_THREE_IMPORTS.has(property)) {
        diagnostics.push(diagnostic(
          "script_renderer_forbidden",
          `Agent-safe behaviour cannot access ${property}; Studio owns the renderer.`,
          node,
        ));
      }
    },
  });

  if (defaultExportCount !== 1) {
    diagnostics.push(diagnostic(
      "script_default_export_required",
      "A behaviour module must have exactly one default export.",
    ));
  }

  return Object.freeze({
    valid: diagnostics.length === 0,
    trust,
    bytes,
    ast,
    diagnostics: Object.freeze(diagnostics),
  });
}

export function assertValidBehaviorSource(source, options) {
  const result = validateBehaviorSource(source, options);
  if (!result.valid) {
    throw new SyntaxError(result.diagnostics.map(item => item.message).join("\n"));
  }
  return result;
}
