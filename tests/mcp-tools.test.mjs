import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { McpServer } from '@modelcontextprotocol/server';
import {
  INSPECT_SLICES,
  OPERATION_TYPES,
  STUDIO_TOOL_NAMES,
  TOOL_DEFINITIONS,
  TOOL_SCHEMAS,
  applySchema,
  createThreeStudioMcpServer,
  hydrateEvidenceImageBlocks,
  historySchema,
  inspectSchema,
  jobSchema,
  playSchema,
  projectSchema,
  renderSchema,
  toMcpToolResult,
  validateSchema,
} from '../src/mcp/index.mjs';

const EXPECTED_TOOLS = [
  'three_studio_status',
  'three_studio_inspect',
  'three_studio_apply',
  'three_studio_validate',
  'three_studio_render',
  'three_studio_history',
  'three_studio_job',
  'three_studio_project',
  'three_studio_play',
];

test('MCP surface is deliberately bounded and uses the official v2 server', () => {
  const server = createThreeStudioMcpServer({ dispatch: async () => ({ success: true }) });
  assert.ok(server instanceof McpServer);
  assert.deepEqual(STUDIO_TOOL_NAMES, EXPECTED_TOOLS);
  assert.deepEqual(Object.keys(server._registeredTools), EXPECTED_TOOLS);
  for (const name of EXPECTED_TOOLS) {
    const jsonSchema = server.toolInputSchemaJson(name);
    assert.equal(jsonSchema.type, 'object');
    assert.equal(jsonSchema.additionalProperties, false);
  }
});

test('all tool inputs reject undeclared top-level fields', () => {
  for (const [name, schema] of Object.entries(TOOL_SCHEMAS)) {
    const result = schema.safeParse({ unexpected: name });
    assert.equal(result.success, false, `${name} must be strict`);
  }
});

test('tool annotations reflect read-only versus stateful live effects', () => {
  for (const name of ['three_studio_status', 'three_studio_inspect', 'three_studio_validate', 'three_studio_job']) {
    assert.equal(TOOL_DEFINITIONS[name].annotations.readOnlyHint, true, name);
  }
  for (const name of ['three_studio_apply', 'three_studio_render', 'three_studio_history', 'three_studio_project', 'three_studio_play']) {
    assert.equal(TOOL_DEFINITIONS[name].annotations.readOnlyHint, false, name);
  }
  assert.match(TOOL_DEFINITIONS.three_studio_job.title, /Reserved/);
  assert.match(TOOL_DEFINITIONS.three_studio_play.description, /do not execute/);
});

test('checked-in JSON contract mirrors the lean capability enums', async () => {
  const contract = JSON.parse(await readFile(new URL('../schemas/tools-v1.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(contract.$defs.operation.properties.op.enum, OPERATION_TYPES);
  assert.deepEqual(contract.$defs.inspect.properties.include.items.enum, INSPECT_SLICES);
  assert.deepEqual(contract.$defs.project.properties.action.enum, ['list', 'create', 'open', 'save']);
  assert.deepEqual(contract.$defs.history.properties.action.enum, ['list', 'inspect', 'undo', 'redo']);
  assert.deepEqual(contract.$defs.render.properties.passes.items, { const: 'beauty' });
  assert.deepEqual(contract.$defs.render.properties.renderer, { const: 'webgpu' });
  assert.deepEqual(Object.keys(contract.$defs.job.properties), ['protocolVersion', 'sessionId']);
});

test('apply enforces shared mutation metadata and the 128-operation bound', () => {
  const valid = {
    protocolVersion: 'three-studio/1',
    sessionId: 'live-session',
    projectId: 'project/test',
    baseRevision: 4,
    idempotencyKey: 'change-0001',
    label: 'Create courtyard ground',
    operations: [{
      op: 'entity.create',
      sceneId: 'scene/main',
      alias: '$ground',
      entity: { id: 'courtyard/ground', kind: 'mesh', name: 'Ground' },
    }],
  };
  assert.equal(applySchema.safeParse(valid).success, true);
  assert.equal(applySchema.safeParse({ ...valid, baseRevision: -1 }).success, false);
  assert.equal(applySchema.safeParse({ ...valid, operations: Array(129).fill(valid.operations[0]) }).success, false);
  assert.equal(applySchema.safeParse({ ...valid, operations: [{ ...valid.operations[0], typo: true }] }).success, false);
});

test('MCP contract exposes only the live inspect and mutation slice', () => {
  assert.deepEqual(INSPECT_SLICES, ['summary', 'tree', 'transform', 'components', 'bounds', 'references']);
  assert.deepEqual(OPERATION_TYPES, [
    'scene.create', 'scene.patch', 'scene.delete', 'scene.setActive',
    'scene.settings.patch', 'scene.setActiveCamera',
    'entity.create', 'entity.patch', 'entity.duplicate', 'entity.reparent', 'entity.delete',
    'resource.create', 'resource.patch', 'resource.delete',
  ]);
  assert.equal(inspectSchema.safeParse({ query: 'selector', selector: { tag: 'hero' }, include: ['tree', 'transform', 'bounds', 'references'] }).success, true);
  assert.equal(inspectSchema.safeParse({ query: 'graphCatalog', selector: { kind: 'shader', status: 'live-tsl' } }).success, true);
  assert.equal(inspectSchema.safeParse({ query: 'unresolvedResources' }).success, true);
  assert.equal(inspectSchema.safeParse({ query: 'unusedResources' }).success, true);
  assert.equal(inspectSchema.safeParse({ query: 'codeDiagnostics' }).success, false);
  assert.equal(inspectSchema.safeParse({ query: 'selector', selector: { resourceId: 'material/hero' } }).success, false);
  assert.equal(inspectSchema.safeParse({ query: 'sceneDigest', include: ['script'] }).success, false);
  assert.equal(inspectSchema.safeParse({ query: 'sceneDigest', depth: 3 }).success, false);
  assert.equal(applySchema.safeParse({
    protocolVersion: 'three-studio/1', sessionId: 'live-session', projectId: 'project/test', baseRevision: 4,
    idempotencyKey: 'change-layout', label: 'Try unavailable layout',
    operations: [{ op: 'layout.grid', parameters: {} }],
  }).success, false);
  assert.equal(applySchema.safeParse({
    protocolVersion: 'three-studio/1', sessionId: 'live-session', projectId: 'project/test', baseRevision: 4,
    idempotencyKey: 'change-script', label: 'Try unavailable script',
    operations: [{ op: 'script.attach', scriptId: 'script/door', scope: 'entity', targetId: 'door/main' }],
  }).success, false);
  const mutation = {
    protocolVersion: 'three-studio/1', sessionId: 'live-session', projectId: 'project/test', baseRevision: 4,
    idempotencyKey: 'guarded-delete', label: 'Delete inspected scene',
  };
  assert.equal(applySchema.safeParse({
    ...mutation,
    operations: [{ op: 'scene.delete', sceneId: 'scene/old', expectedSceneHash: 'a'.repeat(64) }],
  }).success, true);
  assert.equal(applySchema.safeParse({
    ...mutation,
    operations: [{ op: 'scene.delete', sceneId: 'scene/old', expectedSceneHash: 'A'.repeat(64) }],
  }).success, false);
  assert.equal(applySchema.safeParse({
    ...mutation,
    operations: [{ op: 'resource.create', resourceType: 'audio', resource: { id: 'audio/chime', kind: 'audio' } }],
  }).success, true);
});

test('validation and rendering schemas reject advertised-but-unimplemented modes', () => {
  assert.equal(validateSchema.safeParse({ checks: ['schemas', 'references', 'hierarchy', 'graphs', 'budgets'] }).success, true);
  assert.equal(validateSchema.safeParse({ strictness: 'rtx' }).success, false);
  assert.equal(validateSchema.safeParse({ scope: 'scene', sceneId: 'scene/main' }).success, false);
  assert.equal(validateSchema.safeParse({ checks: ['shaders'] }).success, false);

  assert.equal(renderSchema.safeParse({ renderer: 'webgpu', passes: ['beauty'], frame: { targetIds: ['entity/hero'] } }).success, true);
  assert.equal(renderSchema.safeParse({ renderer: 'rtx' }).success, false);
  assert.equal(renderSchema.safeParse({ passes: ['depth'] }).success, false);
  assert.equal(renderSchema.safeParse({ time: 2 }).success, false);
  assert.equal(renderSchema.safeParse({ frame: {} }).success, false);
  assert.equal(renderSchema.safeParse({ frame: { bounds: { min: [0, 0, 0], max: [1, 1, 1] }, padding: 1 } }).success, false);
});

test('project, play, and history mutation actions require correlation metadata', () => {
  assert.equal(projectSchema.safeParse({ action: 'list' }).success, true);
  assert.equal(projectSchema.safeParse({ action: 'save', projectId: 'project/test' }).success, false);
  assert.equal(projectSchema.safeParse({ action: 'checkpoint' }).success, false);
  assert.equal(projectSchema.safeParse({ action: 'close' }).success, false);
  assert.equal(projectSchema.safeParse({ action: 'create', template: 'unknown' }).success, false);
  assert.equal(playSchema.safeParse({ action: 'query', projectId: 'project/test' }).success, true);
  assert.equal(playSchema.safeParse({ action: 'query', query: ['door/open'] }).success, false);
  assert.equal(playSchema.safeParse({ action: 'inject', inputAction: 'door/open' }).success, false);
  assert.equal(historySchema.safeParse({ action: 'list' }).success, true);
  assert.equal(historySchema.safeParse({ action: 'inspect' }).success, false);
  assert.equal(historySchema.safeParse({ action: 'diff' }).success, false);
  assert.equal(historySchema.safeParse({ action: 'undo' }).success, false);
  assert.equal(jobSchema.safeParse({}).success, true);
  assert.equal(jobSchema.safeParse({ action: 'start' }).success, false);
});

test('registered handler forwards exact tool name and cancellation signal', async () => {
  const calls = [];
  const server = createThreeStudioMcpServer({
    dispatch: async (method, params, context) => {
      calls.push({ method, params, signal: context.signal });
      return { success: true, revision: 3 };
    },
  });
  const controller = new AbortController();
  const result = await server._registeredTools.three_studio_status.executor(
    {},
    {
      sessionId: 'mcp-session',
      mcpReq: { id: 1, method: 'tools/call', signal: controller.signal },
    },
  );
  assert.equal(calls[0].method, 'three_studio_status');
  assert.equal(calls[0].signal, controller.signal);
  assert.deepEqual(result.structuredContent, { success: true, revision: 3 });
});

test('render-shaped results expose image content without replacing structured metadata', () => {
  const result = toMcpToolResult({
    success: true,
    revision: 2,
    artifactPath: 'C:\\evidence\\beauty.png',
    image: { mimeType: 'image/png', data: 'aGVsbG8=' },
  });
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(result.content[1], { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' });
  assert.equal(result.structuredContent.revision, 2);
});

test('render evidence paths hydrate into MCP image blocks without bloating structured metadata', async () => {
  const blocks = await hydrateEvidenceImageBlocks({ evidence: [{ path: 'C:\\evidence\\beauty.png' }] }, {
    statFile: async () => ({ isFile: () => true, size: 5 }),
    readFileBytes: async () => Buffer.from('hello'),
  });
  assert.deepEqual(blocks, [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }]);
  const result = toMcpToolResult({ success: true, evidence: [{ path: 'C:\\evidence\\beauty.png' }] }, { imageBlocks: blocks });
  assert.equal(result.content[1].type, 'image');
  assert.equal(JSON.stringify(result.structuredContent).includes('aGVsbG8='), false);
});
