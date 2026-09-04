import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { RpcError, safeError } from '../bridge/protocol.mjs';
import {
  MCP_SERVER_VERSION,
  STUDIO_TOOL_NAMES,
  TOOL_CONTRACT,
  TOOL_INPUT_SCHEMAS,
  computeToolContractHash,
} from './tool-schemas.mjs';

const INITIAL_SERVER_INSTRUCTIONS = `Studio is an LLM-first WebGPU editor. Start with three_studio_status; the live-refreshed schemas and capability contract are authoritative. Use exact inspection digests before dense mesh, modifier-stack, graph, material, or RTX edits. Play evaluates Actions, typed controllers, physics, and timeline geometry; arbitrary scripts do not run. File-producing jobs remain capability-gated. Never infer support from an earlier Studio session.`;

export const SERVER_INSTRUCTIONS = `${INITIAL_SERVER_INSTRUCTIONS.padEnd(512, ' ')}Inspect only bounded context. Mutate with exact stable IDs, the latest baseRevision, a unique idempotencyKey, and one coherent label. Carry selection and membership hashes into guarded bulk edits. Groups own transforms; collections are independent organization. Dry-run risky or large changes. Check controllerRuntime and logicRuntime for typed gameplay; behaviorRuntime describes arbitrary scripts only. Controller graph changes are runtime-dependent: activate, step, and inspect evidence before claiming behavior. Rehearsal jobs require machine-local configuration. Save verified milestones. Never edit project JSON, history, recovery, or session-marker files directly, and never enable trusted-project mode. Units are metres, radians, and seconds.`;

export const TOOL_DEFINITIONS = Object.freeze({
  three_studio_status: {
    title: 'Three Studio Status',
    description: 'Cheap first call. Read the live session, project/scene/revision, dirty and history state, viewport camera, transient Author/Play state, and explicit capability flags.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  three_studio_inspect: {
    title: 'Inspect Three Studio',
    description: 'Read paginated scene summaries plus exact entity-set, hierarchy, collection, and modifier-stack guards; inspect transform, component, compiled bounds, references, bounded resources, exact mesh elements, graphs, Plainform grammar/AST, modifier execution classifications, and RTX state without echoing unbounded arrays; query changes, catalogs, Play state, or latest evidence.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  three_studio_apply: {
    title: 'Apply Three Studio Changeset',
    description: 'Apply one labelled atomic changeset against an exact base revision. Supports exact guarded bulk entity and modifier-stack edits, world-preserving groups, independent organizational collections, strict bounded operations, idempotency, guarded deletes, aliases, and dry-run.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  three_studio_validate: {
    title: 'Validate Three Studio',
    description: 'Validate the complete canonical project without mutation at interactive strictness, including document schemas, references, hierarchy, typed graphs, Blender-style Actions/keyframes, and budgets.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  three_studio_render: {
    title: 'Render Three Studio Evidence',
    description: 'Optionally scrub to an exact animation frame, frame exact entities or bounds, or use a named compiled camera, then write WebGPU beauty evidence without changing canonical authoring state or the visible camera. A committed scene RTX request augments lighting only when status reports it active.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  three_studio_history: {
    title: 'Three Studio History',
    description: 'List or inspect transactions, or create a new compensating undo/redo revision. Diff/compare queries are not exposed. Revision numbers never move backward.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  three_studio_job: {
    title: 'Three Studio Jobs',
    description: 'Run a capability-gated job: bake a procedural texture; export a scene/subtree as glTF/GLB; import a checksum-verified local GLB into a new canonical scene with dry-run/promotion; or invoke a configured rehearsal. Import supports bounded rigid triangle geometry, transforms, PBR and embedded RGB/RGBA PNG; inspect status for exact limits. No command or shell input is accepted.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  three_studio_project: {
    title: 'Three Studio Project',
    description: 'List, create, open, or atomically save Studio projects while keeping the viewport alive; create blank or starter projects; import or guarded-export a configured external JSON artifact as canonical project data. Checkpoint/snapshot, close, whole-project export, duplication, rename, and deletion are not exposed.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  three_studio_play: {
    title: 'Three Studio Play State',
    description: 'Control or query the transient Author/Play boundary: enter, stop, pause, resume, seek Action animation, step animation and typed controllers at 60 Hz, or inject bounded keyDown/keyUp/releaseKeys input. Keyboard activation and Escape use the live controller path. Arbitrary behaviour scripts do not execute.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
});

const REGISTERED_TOOL_HANDLES = new WeakMap();

function assertRefreshableToolContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new RpcError('tool_contract_invalid', 'The native Studio returned an invalid tool contract.');
  }
  if (computeToolContractHash(contract) !== contract.hash) {
    throw new RpcError('tool_contract_invalid', 'The native Studio tool contract hash does not match its payload.', {
      actualHash: contract.hash ?? null,
    });
  }
  if (contract.protocolVersion !== TOOL_CONTRACT.protocolVersion) {
    throw new RpcError('protocol_mismatch', `Expected Studio protocol ${TOOL_CONTRACT.protocolVersion}.`, {
      expectedProtocolVersion: TOOL_CONTRACT.protocolVersion,
      actualProtocolVersion: contract.protocolVersion ?? null,
    });
  }
  const names = Object.keys(contract.inputSchemas ?? {});
  if (names.length !== STUDIO_TOOL_NAMES.length || STUDIO_TOOL_NAMES.some(name => !names.includes(name))) {
    throw new RpcError('tool_contract_invalid', 'The native Studio contract must preserve the nine stable MCP tools.', {
      expectedTools: STUDIO_TOOL_NAMES,
      actualTools: names,
    });
  }
}

/** Replaces registered input validators from a verified native contract. */
export function synchronizeThreeStudioToolContract(server, contract) {
  if (!(server instanceof McpServer)) throw new TypeError('server must be an official MCP McpServer.');
  assertRefreshableToolContract(contract);
  const registrations = REGISTERED_TOOL_HANDLES.get(server);
  if (!registrations) throw new TypeError('server was not created by createThreeStudioMcpServer.');
  if (registrations.contractHash === contract.hash) {
    return { changed: false, hash: contract.hash, contractVersion: contract.contractVersion };
  }
  const parsedSchemas = Object.fromEntries(STUDIO_TOOL_NAMES.map((name) => {
    try {
      return [name, fromJsonSchema(contract.inputSchemas[name])];
    } catch (error) {
      throw new RpcError('tool_contract_invalid', `Could not materialize the live schema for ${name}.`, {
        tool: name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }));
  for (const name of STUDIO_TOOL_NAMES) {
    registrations.handles[name].update({ paramsSchema: parsedSchemas[name] });
  }
  registrations.contractHash = contract.hash;
  return { changed: true, hash: contract.hash, contractVersion: contract.contractVersion };
}

export function normalizeStudioDispatch(dispatch) {
  if (typeof dispatch === 'function') return dispatch;
  if (dispatch && typeof dispatch.request === 'function') {
    return (method, params, context) => dispatch.request(method, params, { signal: context?.signal });
  }
  if (dispatch && typeof dispatch.dispatch === 'function') return dispatch.dispatch.bind(dispatch);
  if (dispatch && typeof dispatch === 'object') {
    return (method, params, context) => {
      const handler = dispatch[method];
      if (typeof handler !== 'function') throw new RpcError('method_not_found', `No dispatch handler for ${method}.`);
      return handler(params, context);
    };
  }
  throw new TypeError('dispatch must be a function, live client, dispatch object, or tool handler map.');
}

const MAX_EVIDENCE_IMAGE_BYTES = 12 * 1024 * 1024;

function imageBlocksFrom(result) {
  const candidates = [];
  if (result?.image) candidates.push(result.image);
  if (Array.isArray(result?.images)) candidates.push(...result.images);
  if (Array.isArray(result?.evidence)) candidates.push(...result.evidence.filter((item) => item?.data && item?.mimeType));
  return candidates
    .filter((item) => item && typeof item.data === 'string' && /^image\//.test(item.mimeType))
    .map((item) => ({ type: 'image', data: item.data, mimeType: item.mimeType }));
}

export async function hydrateEvidenceImageBlocks(result, {
  maxBytes = MAX_EVIDENCE_IMAGE_BYTES,
  statFile = stat,
  readFileBytes = readFile,
} = {}) {
  const mimeTypes = new Map([
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.webp', 'image/webp'],
  ]);
  const paths = [...new Set((result?.evidence ?? [])
    .map(item => item?.path)
    .filter(item => typeof item === 'string'))].slice(0, 4);
  const blocks = [];
  for (const filePath of paths) {
    const mimeType = mimeTypes.get(path.extname(filePath).toLowerCase());
    if (!mimeType) continue;
    try {
      const info = await statFile(filePath);
      if (!info.isFile() || info.size < 1 || info.size > maxBytes) continue;
      const data = await readFileBytes(filePath);
      blocks.push({ type: 'image', mimeType, data: Buffer.from(data).toString('base64') });
    } catch {
      // The compact artifact-path result remains useful if evidence hydration races deletion.
    }
  }
  return blocks;
}

export function toMcpToolResult(result, { imageBlocks = [] } = {}) {
  const structuredContent = result && typeof result === 'object' && !Array.isArray(result)
    ? result
    : { result: result ?? null };
  let text;
  try {
    text = JSON.stringify(structuredContent);
  } catch (error) {
    throw new RpcError('dispatch_error', 'Studio result was not JSON serializable.', undefined, { cause: error });
  }
  return {
    content: [{ type: 'text', text }, ...imageBlocksFrom(structuredContent), ...imageBlocks],
    structuredContent,
  };
}

export function toMcpToolError(error) {
  const payload = { success: false, error: safeError(error) };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

export function registerThreeStudioTools(server, dispatch) {
  if (!(server instanceof McpServer)) throw new TypeError('server must be an official MCP McpServer.');
  const invoke = normalizeStudioDispatch(dispatch);
  const registrations = {};
  for (const name of STUDIO_TOOL_NAMES) {
    const definition = TOOL_DEFINITIONS[name];
    registrations[name] = server.registerTool(name, {
      ...definition,
      inputSchema: fromJsonSchema(TOOL_INPUT_SCHEMAS[name]),
    }, async (args, context) => {
      try {
        const result = await invoke(name, args, {
          signal: context.mcpReq.signal,
          mcpRequestId: context.mcpReq.id,
          mcpSessionId: context.sessionId,
        });
        const imageBlocks = name === 'three_studio_render'
          ? await hydrateEvidenceImageBlocks(result)
          : [];
        return toMcpToolResult(result, { imageBlocks });
      } catch (error) {
        return toMcpToolError(error);
      }
    });
  }
  REGISTERED_TOOL_HANDLES.set(server, { handles: registrations, contractHash: TOOL_CONTRACT.hash });
  return registrations;
}

export function createThreeStudioMcpServer({ dispatch, name = 'threebrowser-studio', version = MCP_SERVER_VERSION } = {}) {
  const server = new McpServer({ name, version }, {
    capabilities: { tools: { listChanged: true } },
    instructions: SERVER_INSTRUCTIONS,
  });
  registerThreeStudioTools(server, dispatch);
  return server;
}
