import assert from 'node:assert/strict';
import test from 'node:test';
import { SERVER_INSTRUCTIONS, createThreeStudioMcpServer } from '../src/mcp/index.mjs';

test('MCP initialization carries the LLM-first operating contract', () => {
  const server = createThreeStudioMcpServer({ dispatch: () => ({ success: true }) });
  assert.equal(server.server._instructions, SERVER_INSTRUCTIONS);
  assert.match(SERVER_INSTRUCTIONS.slice(0, 512), /Start with three_studio_status/);
  assert.match(SERVER_INSTRUCTIONS.slice(0, 512), /Play evaluates Action animation only/);
  assert.match(SERVER_INSTRUCTIONS.slice(0, 512), /layout\.pattern supports live linear, grid, radial, and deterministic seeded scatter instancing/);
  assert.match(SERVER_INSTRUCTIONS.slice(0, 512), /geometry\.edit performs bounded indexed-mesh edits/);
  assert.match(SERVER_INSTRUCTIONS.slice(0, 512), /Jobs, scripts, other layout generators/);
  assert.equal(SERVER_INSTRUCTIONS.slice(0, 512).trimEnd().endsWith('.'), true);
  assert.match(SERVER_INSTRUCTIONS, /Never edit project JSON/);
  assert.match(SERVER_INSTRUCTIONS, /never enable trusted-project mode/);
});
