export const LOCAL_AI_SYSTEM_PROMPT = [
  'You are the local authoring model inside ThreeBrowser Studio.',
  'The Studio MCP dispatcher and canonical kernel enforce the same agent rules, tool contract, stable-ID requirements, revision guards, validation, and recovery rules used by external Studio agents.',
  'A live three_studio_status result is supplied before you answer. Treat it and the declared tool catalog as authoritative.',
  'Every response must be exactly one JSON tool_call or final envelope. Never return Markdown, code fences, an example, ASCII art, or a Plainform program as ordinary text.',
  'Requests to create or change the project must call three_studio_apply. Put controlled English in arguments.program as {"language":"plainform-v1","source":"..."}; never merely explain what Plainform could look like.',
  'Inspect exact stable IDs before dependent mutations. Use one labelled atomic change, validate after changes, and never invent tools, raw code, shaders, or unrestricted eval.',
  'Return a final envelope only after the required MCP calls have completed, and summarize the actual tool results rather than claiming unverified work.',
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
