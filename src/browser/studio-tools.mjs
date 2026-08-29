/** Browser-safe copy of the nine MCP tools. Do not import tool-schemas here — that module uses Node crypto. */

export const STUDIO_TOOL_NAMES = Object.freeze([
  'three_studio_status',
  'three_studio_inspect',
  'three_studio_apply',
  'three_studio_validate',
  'three_studio_render',
  'three_studio_history',
  'three_studio_job',
  'three_studio_project',
  'three_studio_play',
]);

const GENERIC_ARGUMENTS = Object.freeze({
  type: 'object',
  additionalProperties: true,
  description: 'Exact arguments for this three_studio tool. Start a session with three_studio_status.',
});

export const STUDIO_BROWSER_TOOLS = Object.freeze([
  Object.freeze({
    name: 'three_studio_status',
    title: 'Three Studio Status',
    description: 'Cheap first call. Read the live session, project/scene/revision, dirty and history state, viewport camera, transient Author/Play state, and explicit capability flags.',
    inputSchema: GENERIC_ARGUMENTS,
  }),
  Object.freeze({
    name: 'three_studio_inspect',
    title: 'Inspect Three Studio',
    description: 'Read paginated scene summaries plus exact entity-set, hierarchy, collection, and modifier-stack guards; inspect transform, component, compiled bounds, references, bounded resources, exact mesh elements, graphs, and latest evidence.',
    inputSchema: GENERIC_ARGUMENTS,
  }),
  Object.freeze({
    name: 'three_studio_apply',
    title: 'Apply Three Studio Changeset',
    description: 'Apply one labelled atomic changeset against an exact base revision using stable IDs, a unique idempotencyKey, and one coherent label.',
    inputSchema: GENERIC_ARGUMENTS,
  }),
  Object.freeze({
    name: 'three_studio_validate',
    title: 'Validate Three Studio',
    description: 'Validate the complete canonical project without mutation at interactive strictness.',
    inputSchema: GENERIC_ARGUMENTS,
  }),
  Object.freeze({
    name: 'three_studio_render',
    title: 'Render Three Studio Evidence',
    description: 'Write WebGPU beauty evidence from a named compiled camera without changing canonical authoring state.',
    inputSchema: GENERIC_ARGUMENTS,
  }),
  Object.freeze({
    name: 'three_studio_history',
    title: 'Three Studio History',
    description: 'List or inspect transactions, or create a compensating undo/redo revision.',
    inputSchema: GENERIC_ARGUMENTS,
  }),
  Object.freeze({
    name: 'three_studio_job',
    title: 'Three Studio Jobs (Reserved)',
    description: 'Reserved nine-tool slot. Invoking this tool returns job_not_implemented until jobs are enabled.',
    inputSchema: GENERIC_ARGUMENTS,
  }),
  Object.freeze({
    name: 'three_studio_project',
    title: 'Three Studio Project',
    description: 'List, create, open, or atomically save Studio projects. Only the optional starter template is implemented.',
    inputSchema: GENERIC_ARGUMENTS,
  }),
  Object.freeze({
    name: 'three_studio_play',
    title: 'Three Studio Play State',
    description: 'Control or query the transient Author/Play boundary. Scripts, blueprints, physics, and game logic do not execute.',
    inputSchema: GENERIC_ARGUMENTS,
  }),
]);
