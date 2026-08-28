import { McpServer } from '@modelcontextprotocol/server';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { RpcError, safeError } from '../bridge/protocol.mjs';
import { STUDIO_TOOL_NAMES, TOOL_SCHEMAS } from './tool-schemas.mjs';

const INITIAL_SERVER_INSTRUCTIONS = `Studio is an LLM-first WebGPU editor. Start with three_studio_status; its capabilities and schemas are authoritative. Use stable IDs. camera.frame persists exact-aspect shots. layout.pattern supports live linear, grid, and radial instancing. geometry.edit performs bounded indexed-mesh edits. Query graphCatalog. Play evaluates Action animation only. RTX lighting is capability-gated. Jobs, scripts, other layout generators, diagnostic passes, export, and behavior simulation are unavailable.`;

export const SERVER_INSTRUCTIONS = `${INITIAL_SERVER_INSTRUCTIONS.padEnd(512, ' ')}Inspect only bounded context. Mutate with exact stable IDs, the latest baseRevision, a unique idempotencyKey, and one coherent label. Dry-run risky or large changes. Never claim gameplay works while behaviorRuntime is false. Save verified milestones. Never edit project JSON, history, recovery, or session-marker files directly, and never enable trusted-project mode. Units are metres, radians, and seconds.`;

export const TOOL_DEFINITIONS = Object.freeze({
  three_studio_status: {
    title: 'Three Studio Status',
    description: 'Cheap first call. Read the live session, project/scene/revision, dirty and history state, viewport camera, transient Author/Play state, and explicit capability flags.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  three_studio_inspect: {
    title: 'Inspect Three Studio',
    description: 'Read paginated scene summaries plus tree/guard hashes, transform, component, compiled bounds, and incoming-reference slices; query changes, unresolved/unused resources, graph and Blender compatibility catalogs, animation Play state, or latest beauty evidence.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  three_studio_apply: {
    title: 'Apply Three Studio Changeset',
    description: 'Apply one labelled atomic changeset against an exact base revision. The schema exposes only the 18 implemented scene, RTX-lighting, entity, persistent-camera, layout-pattern, indexed-geometry, and resource operations. Supports up to 128 strict operations, idempotency, guarded deletes, aliases, and dry-run.',
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
    title: 'Three Studio Jobs (Reserved)',
    description: 'Reserved nine-tool slot only. No job action is currently exposed; status.capabilities.jobs is false and invoking this tool returns job_not_implemented.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  three_studio_project: {
    title: 'Three Studio Project',
    description: 'List, create, open, or atomically save Studio projects while keeping the viewport alive. Only the optional starter template is implemented; checkpoint/snapshot, close, export, duplication, rename, and deletion are not exposed.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  three_studio_play: {
    title: 'Three Studio Play State',
    description: 'Control or query the transient Author/Play boundary: enter, stop, pause, resume, seek/step deterministic Action animation, or record a named input. Scripts, blueprints, physics, and game logic do not execute.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
});

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
      inputSchema: TOOL_SCHEMAS[name],
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
  return registrations;
}

export function createThreeStudioMcpServer({ dispatch, name = 'threebrowser-studio', version = '0.1.0' } = {}) {
  const server = new McpServer({ name, version }, {
    capabilities: { tools: {} },
    instructions: SERVER_INSTRUCTIONS,
  });
  registerThreeStudioTools(server, dispatch);
  return server;
}
