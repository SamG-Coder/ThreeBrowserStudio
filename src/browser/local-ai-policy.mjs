export const LOCAL_AI_SYSTEM_PROMPT = [
  'ROLE: ThreeBrowser Studio MCP planner. The MCP kernel enforces the full Studio rules.',
  'STATE: A live three_studio_status result is already in the conversation. Use its exact sessionId, projectId, and revision.',
  'OUTPUT: One JSON envelope only. No Markdown, examples, ASCII art, or uncalled Plainform.',
  'CHANGE: Call three_studio_apply. For Plainform set arguments.program={"language":"plainform-v1","source":"controlled English"}. Include protocolVersion, sessionId, projectId, baseRevision, idempotencyKey, and label.',
  'SAFETY: Use exact IDs and current revisions. Never invent tools, code, shaders, or eval.',
  'FINAL: Only after required MCP calls. Report actual tool results.',
].join('\n');

const APPLY_INTENT = /\b(?:add|build|change|create|delete|design|edit|generate|insert|make|modify|move|place|remove|rename|replace|rotate|scale|set|transform|update)\b/i;
const VALIDATE_INTENT = /\b(?:validate|validation|check\s+(?:the\s+)?project)\b/i;
const RENDER_INTENT = /\b(?:capture|render|screenshot)\b/i;
const PLAY_INTENT = /\b(?:enter\s+play|pause|play|resume|stop\s+play)\b/i;
const PROJECT_INTENT = /\b(?:open|save)\s+(?:the\s+)?project\b/i;

/** Require the MCP operation that can actually satisfy an explicit user intent. */
export function requiredLocalAiTools(prompt) {
  const text = String(prompt ?? '').trim();
  if (APPLY_INTENT.test(text)) return Object.freeze(['three_studio_apply']);
  if (VALIDATE_INTENT.test(text)) return Object.freeze(['three_studio_validate']);
  if (RENDER_INTENT.test(text)) return Object.freeze(['three_studio_render']);
  if (PLAY_INTENT.test(text)) return Object.freeze(['three_studio_play']);
  if (PROJECT_INTENT.test(text)) return Object.freeze(['three_studio_project']);
  return Object.freeze([]);
}

/** Keep a 4K model focused on only the MCP definitions relevant to this request. */
export function localAiToolNames(prompt) {
  const required = requiredLocalAiTools(prompt);
  if (required.includes('three_studio_apply')) {
    return Object.freeze(['three_studio_status', 'three_studio_inspect', 'three_studio_apply', 'three_studio_validate', 'three_studio_render']);
  }
  if (required.length > 0) return Object.freeze(['three_studio_status', ...required]);
  return Object.freeze(['three_studio_status', 'three_studio_inspect']);
}
