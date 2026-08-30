import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { LAYOUT_PATTERN_MODES } from '../src/core/layout-patterns.mjs';
import { AUTHORABLE_MODIFIER_TYPES } from '../src/core/modifier-stack.mjs';
import { BLENDER_MODIFIER_INVENTORY } from '../src/blender/modifier-inventory.mjs';
import {
  INSPECT_SLICES,
  INSPECT_QUERIES,
  MAX_RESOURCE_ARRAY_ITEMS,
  OPERATION_TYPES,
  STUDIO_TOOL_NAMES,
  TOOL_DEFINITIONS,
  TOOL_CONTRACT,
  TOOL_CONTRACT_SUMMARY,
  TOOL_SCHEMAS,
  applySchema,
  createThreeStudioMcpServer,
  computeToolContractHash,
  hydrateEvidenceImageBlocks,
  historySchema,
  inspectSchema,
  jobSchema,
  modifierDocumentSchema,
  modifierPatchSchema,
  playSchema,
  projectSchema,
  renderSchema,
  synchronizeThreeStudioToolContract,
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

function modifierDocumentBranches(schema, output = []) {
  if (schema?.properties?.id && schema?.properties?.type?.const) output.push(schema);
  for (const key of ['oneOf', 'anyOf']) {
    for (const child of schema?.[key] ?? []) modifierDocumentBranches(child, output);
  }
  return output;
}

function modifierBranchSummary(schema) {
  return Object.fromEntries(modifierDocumentBranches(schema).map((branch) => {
    const type = branch.properties.type.const;
    const mode = branch.properties.mode?.const;
    return [`${type}${mode ? `:${mode}` : ''}`, {
      properties: Object.keys(branch.properties).sort(),
      required: [...(branch.required ?? [])].sort(),
      additionalProperties: branch.additionalProperties,
    }];
  }));
}

function modifierPatchBranchSummary(schema) {
  return schema.anyOf.map(branch => ({
    description: branch.description,
    properties: Object.keys(branch.properties).sort(),
    additionalProperties: branch.additionalProperties,
    minProperties: branch.minProperties,
  }));
}

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

test('tool contract hash covers the exact registered MCP input schemas', () => {
  const server = createThreeStudioMcpServer({ dispatch: async () => ({ success: true }) });
  const inputSchemas = Object.fromEntries(
    STUDIO_TOOL_NAMES.map(name => [name, z.toJSONSchema(TOOL_SCHEMAS[name], { io: 'input' })]),
  );
  for (const name of STUDIO_TOOL_NAMES) {
    assert.deepEqual(inputSchemas[name], server.toolInputSchemaJson(name));
  }
  const { hash, ...metadata } = TOOL_CONTRACT;
  const expected = createHash('sha256').update(JSON.stringify({
    ...metadata,
    inputSchemas,
  })).digest('hex');
  assert.equal(hash, expected);
  assert.deepEqual(TOOL_CONTRACT.inputSchemas, inputSchemas);
  assert.equal(TOOL_CONTRACT.features.liveSchemaRefresh, true);
  assert.equal(computeToolContractHash(TOOL_CONTRACT), TOOL_CONTRACT.hash);
  assert.equal(TOOL_CONTRACT_SUMMARY.hash, TOOL_CONTRACT.hash);
  assert.equal(Object.hasOwn(TOOL_CONTRACT_SUMMARY, 'inputSchemas'), false);
});

test('registered MCP schemas refresh atomically from a verified native contract', () => {
  const server = createThreeStudioMcpServer({ dispatch: async () => ({ success: true }) });
  const refreshed = structuredClone(TOOL_CONTRACT);
  refreshed.contractVersion = 'three-studio-tools/future-test';
  refreshed.inputSchemas.three_studio_status.properties.contractProbe = { type: 'string', maxLength: 32 };
  refreshed.hash = computeToolContractHash(refreshed);

  const result = synchronizeThreeStudioToolContract(server, refreshed);
  assert.deepEqual(result, {
    changed: true,
    hash: refreshed.hash,
    contractVersion: refreshed.contractVersion,
  });
  assert.deepEqual(
    server.toolInputSchemaJson('three_studio_status').properties.contractProbe,
    { type: 'string', maxLength: 32 },
  );
  for (const name of STUDIO_TOOL_NAMES) {
    assert.deepEqual(server.toolInputSchemaJson(name), refreshed.inputSchemas[name]);
  }
  assert.equal(synchronizeThreeStudioToolContract(server, refreshed).changed, false);

  const tampered = structuredClone(refreshed);
  tampered.inputSchemas.three_studio_status.properties.unhashed = { type: 'boolean' };
  assert.throws(
    () => synchronizeThreeStudioToolContract(server, tampered),
    error => error?.code === 'tool_contract_invalid',
  );
});

test('all tool inputs reject undeclared top-level fields', () => {
  for (const [name, schema] of Object.entries(TOOL_SCHEMAS)) {
    const result = schema.safeParse({ unexpected: name });
    assert.equal(result.success, false, `${name} must be strict`);
  }
});

test('tool annotations reflect read-only versus stateful live effects', () => {
  for (const name of ['three_studio_status', 'three_studio_inspect', 'three_studio_validate']) {
    assert.equal(TOOL_DEFINITIONS[name].annotations.readOnlyHint, true, name);
  }
  for (const name of ['three_studio_apply', 'three_studio_render', 'three_studio_history', 'three_studio_project', 'three_studio_play']) {
    assert.equal(TOOL_DEFINITIONS[name].annotations.readOnlyHint, false, name);
  }
  assert.equal(TOOL_DEFINITIONS.three_studio_job.annotations.readOnlyHint, false);
  assert.match(TOOL_DEFINITIONS.three_studio_job.title, /Texture/);
  assert.match(TOOL_DEFINITIONS.three_studio_play.description, /do not execute/);
});

test('checked-in JSON contract mirrors the lean capability enums', async () => {
  const contract = JSON.parse(await readFile(new URL('../schemas/tools-v1.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(contract.$defs.operation.properties.op.enum, OPERATION_TYPES);
  assert.deepEqual(contract.$defs.inspect.properties.include.items.enum, INSPECT_SLICES);
  assert.deepEqual(contract.$defs.inspect.properties.query.enum, INSPECT_QUERIES);
  assert.deepEqual(contract.$defs.project.properties.action.enum, ['list', 'create', 'open', 'save']);
  assert.deepEqual(contract.$defs.history.properties.action.enum, ['list', 'inspect', 'undo', 'redo']);
  assert.deepEqual(contract.$defs.render.properties.passes.items, { enum: ['beauty', 'raster', 'objectId', 'albedo', 'roughness', 'normal', 'uv'] });
  assert.equal(contract.$defs.render.properties.passes.maxItems, 7);
  assert.deepEqual(contract.$defs.render.properties.renderer, { const: 'webgpu' });
  assert.deepEqual(Object.keys(contract.$defs.job.properties), [
    'protocolVersion', 'sessionId', 'action', 'projectId', 'graphId', 'textureId',
    'output', 'resolution', 'name', 'baseRevision', 'idempotencyKey', 'label',
  ]);
  assert.deepEqual(
    contract.$defs.layoutPattern.oneOf.map(pattern => pattern.properties.mode.const),
    [...LAYOUT_PATTERN_MODES],
  );
});

test('modifier schemas expose every strict per-type control and mirror the checked-in contract', async () => {
  const runtimeDocument = z.toJSONSchema(modifierDocumentSchema, { io: 'input' });
  const runtimeBranches = modifierDocumentBranches(runtimeDocument);
  assert.equal(runtimeDocument.oneOf.length, 15, 'array, mirror, nested pattern, eleven geometry types, and bakeBoundary');
  assert.deepEqual(
    [...new Set(runtimeBranches.map(branch => branch.properties.type.const))],
    [...AUTHORABLE_MODIFIER_TYPES],
  );
  assert.ok(runtimeBranches.every(branch => branch.additionalProperties === false));

  const byType = type => runtimeBranches.find(branch => branch.properties.type.const === type);
  assert.ok(byType('array').required.includes('count'));
  assert.equal(byType('array').properties.count.maximum, 256);
  assert.equal(byType('weld').properties.tolerance.minimum, 1e-9);
  assert.equal(byType('smooth').properties.iterations.maximum, 100);
  assert.deepEqual(byType('weightedNormal').properties.weighting.enum, ['area', 'cornerAngle', 'areaAngle']);
  assert.equal(byType('edgeSplit').properties.splitAngle.maximum, Math.PI);
  assert.equal(byType('subdivision').properties.levels.maximum, 6);
  assert.deepEqual(byType('subdivision').properties.scheme.enum, ['simple', 'loop']);
  assert.equal(byType('decimate').properties.targetTriangles.maximum, 2_000_000);
  assert.deepEqual(byType('decimate').not, { required: ['ratio', 'targetTriangles'] });
  assert.deepEqual(
    byType('displace').properties.source.oneOf.map(source => source.properties.type.const),
    ['constant', 'wave', 'noise'],
  );
  assert.deepEqual(byType('simpleDeform').properties.mode.enum, ['bend', 'twist', 'taper', 'stretch']);
  assert.deepEqual(byType('simpleDeform').properties.axis.enum, ['x', 'y', 'z']);
  assert.equal(byType('ocean').properties.mode.const, 'displace');
  assert.equal(byType('ocean').properties.waveCount.maximum, 32);
  assert.equal(byType('ocean').properties.timelineScale.minimum, -64);
  assert.equal(
    byType('bakeBoundary').properties.operatorType.enum.length,
    BLENDER_MODIFIER_INVENTORY.entries.length,
  );

  const contract = JSON.parse(await readFile(new URL('../schemas/tools-v1.schema.json', import.meta.url), 'utf8'));
  const checkedInDocument = contract.$defs.modifierDocument;
  assert.equal(checkedInDocument.description, runtimeDocument.description);
  assert.deepEqual(modifierBranchSummary(checkedInDocument), modifierBranchSummary(runtimeDocument));
  assert.deepEqual(
    modifierDocumentBranches(checkedInDocument).find(branch => branch.properties.type.const === 'decimate').not,
    byType('decimate').not,
  );
  assert.equal(contract.$defs.blenderModifierOperatorType.enum.length, BLENDER_MODIFIER_INVENTORY.entries.length);
  assert.deepEqual(
    contract.$defs.modifierDisplacementSource.oneOf.map(source => source.properties.type.const),
    ['constant', 'wave', 'noise'],
  );
  assert.deepEqual(contract.$defs.operation.properties.modifier, { $ref: '#/$defs/modifierDocument' });
  assert.deepEqual(
    contract.$defs.modifierStackChange.oneOf[0].properties.modifier,
    { $ref: '#/$defs/modifierDocument' },
  );
  assert.deepEqual(
    contract.$defs.modifierStackChange.oneOf[1].properties.patch,
    { $ref: '#/$defs/modifierPatch' },
  );
});

test('modifier patch schemas expose bounded partial controls without permitting identity or unknown-key edits', async () => {
  for (const patch of [
    { enabledViewport: false },
    { count: 4, offset: [1, 0, 0] },
    { axis: 'z' },
    { radius: 5, orientation: 'radial' },
    { tolerance: 1e-5 },
    { iterations: 3, factor: 0.25 },
    { weighting: 'areaAngle', influence: 0.8 },
    { splitAngle: Math.PI / 4 },
    { thickness: 0.1, offset: -0.5 },
    { levels: 3, scheme: 'loop' },
    { ratio: 0.5 },
    { source: { type: 'noise', seed: 42, octaves: 4 }, strength: 0.2 },
    { mode: 'bend', axis: 'z', factor: 0.5, origin: [0, 0, 0] },
    { waveScale: 1.5, windVelocity: 28, waveCount: 24, timelineScale: 0.8 },
    { operatorType: 'BEVEL', parameters: { width: 0.04 } },
    { enabled: null },
  ]) assert.equal(modifierPatchSchema.safeParse(patch).success, true, JSON.stringify(patch));

  for (const patch of [
    {},
    { id: 'modifier/replacement' },
    { type: 'smooth' },
    { levles: 3 },
    { levels: 7 },
    { ratio: 0.5, targetTriangles: 100 },
    { splitAngle: Math.PI + 0.01 },
    { source: { type: 'noise', octaves: 9 } },
    { waveCount: 33 },
  ]) assert.equal(modifierPatchSchema.safeParse(patch).success, false, JSON.stringify(patch));

  const emitted = z.toJSONSchema(modifierPatchSchema, { io: 'input' });
  assert.ok(emitted.anyOf.every(branch => branch.additionalProperties === false));
  assert.ok(emitted.anyOf.every(branch => branch.minProperties === 1));
  assert.ok(emitted.anyOf.every(branch => !Object.hasOwn(branch.properties, 'id')));
  assert.ok(emitted.anyOf.every(branch => !Object.hasOwn(branch.properties, 'type')));

  const contract = JSON.parse(await readFile(new URL('../schemas/tools-v1.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    modifierPatchBranchSummary(contract.$defs.modifierPatch),
    modifierPatchBranchSummary(emitted),
  );
  const staticArray = contract.$defs.modifierPatch.anyOf.find(branch => branch.description.includes('for array;'));
  const staticSubdivision = contract.$defs.modifierPatch.anyOf.find(branch => branch.description.includes('for subdivision;'));
  const staticDecimate = contract.$defs.modifierPatch.anyOf.find(branch => branch.description.includes('for decimate;'));
  assert.equal(staticArray.properties.count.maximum, 256);
  assert.equal(staticSubdivision.properties.levels.oneOf[0].maximum, 6);
  assert.deepEqual(staticSubdivision.properties.scheme.oneOf[0].enum, ['simple', 'loop']);
  assert.equal(staticDecimate.properties.targetTriangles.oneOf[0].maximum, 2_000_000);
  assert.deepEqual(staticDecimate.not.required, ['ratio', 'targetTriangles']);
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
  assert.deepEqual(INSPECT_QUERIES, [
    'selector', 'sceneDigest', 'resourceDigest', 'meshElements', 'graphDigest', 'modifierDigest', 'rtxDigest', 'changedSinceRevision',
    'unresolvedResources', 'unusedResources', 'graphCatalog', 'playState',
    'latestEvidence', 'blenderCatalog', 'beautyDigest', 'projectVisibility',
  ]);
  assert.deepEqual(OPERATION_TYPES, [
    'scene.create', 'scene.patch', 'scene.delete', 'scene.setActive',
    'scene.settings.patch', 'scene.rtx.patch', 'scene.setActiveCamera',
    'entity.create', 'entity.patch', 'entity.patchMany', 'entity.transformMany',
    'entity.group', 'entity.ungroup', 'entity.duplicate', 'entity.reparent', 'entity.delete',
    'collection.create', 'collection.patch', 'collection.membership.patch', 'collection.reparent', 'collection.delete',
    'camera.frame', 'layout.pattern', 'stroke.apply',
    'modifier.create', 'modifier.patch', 'modifier.move', 'modifier.delete', 'modifier.stack.edit',
    'geometry.edit',
    'resource.create', 'resource.patch', 'resource.delete',
  ]);
  assert.equal(inspectSchema.safeParse({ query: 'selector', selector: { tag: 'hero' }, include: ['tree', 'transform', 'bounds', 'references'] }).success, true);
  assert.equal(inspectSchema.safeParse({ query: 'selector', selector: { collectionId: 'collection/environment' } }).success, true);
  assert.equal(inspectSchema.safeParse({ query: 'graphCatalog', selector: { kind: 'shader', status: 'live-tsl' } }).success, true);
  assert.equal(inspectSchema.safeParse({ query: 'graphCatalog', selector: { kind: 'shader', status: 'api-only' } }).success, true);
  assert.equal(inspectSchema.safeParse({ query: 'unresolvedResources' }).success, true);
  assert.equal(inspectSchema.safeParse({ query: 'unusedResources' }).success, true);
  assert.equal(inspectSchema.safeParse({ query: 'resourceDigest', selector: { ids: ['geometry/dense'] }, include: ['components', 'bounds', 'references'] }).success, true);
  assert.equal(inspectSchema.safeParse({ query: 'meshElements', selector: { ids: ['geometry/dense'] }, element: 'faces' }).success, true);
  assert.equal(inspectSchema.safeParse({ query: 'meshElements', selector: { ids: ['geometry/a', 'geometry/b'] } }).success, false);
  assert.equal(inspectSchema.safeParse({ query: 'graphDigest', selector: { ids: ['graph/surface'] } }).success, true);
  assert.equal(inspectSchema.safeParse({ query: 'modifierDigest', selector: { ids: ['entity/wall'] } }).success, true);
  assert.equal(inspectSchema.safeParse({ query: 'modifierDigest', selector: { ids: ['entity/a', 'entity/b'] } }).success, false);
  assert.equal(inspectSchema.safeParse({ query: 'rtxDigest' }).success, true);
  assert.equal(inspectSchema.safeParse({
    query: 'beautyDigest',
    evidence: { path: 'studio-1.png', probes: [{ name: 'hot', x: 10, y: 20 }], comparePath: 'studio-2.png' },
  }).success, true);
  assert.equal(inspectSchema.safeParse({
    query: 'sceneDigest',
    evidence: { path: 'studio-1.png' },
  }).success, false);
  assert.equal(inspectSchema.safeParse({
    query: 'projectVisibility',
    projection: { entityIds: ['entity/pear'], width: 1280, height: 720 },
  }).success, true);
  assert.equal(inspectSchema.safeParse({ query: 'projectVisibility' }).success, false);
  assert.equal(inspectSchema.safeParse({
    query: 'meshElements',
    selector: { ids: ['geometry/cloth'] },
    meshFilter: { yMin: 0.74, yMax: 0.76, boundary: false, notAdjacentTo: [3, 8] },
  }).success, true);
  assert.equal(inspectSchema.safeParse({
    query: 'graphDigest',
    selector: { ids: ['graph/surface'] },
    meshFilter: { yMin: 0 },
  }).success, false);
  assert.equal(inspectSchema.safeParse({ query: 'codeDiagnostics' }).success, false);
  assert.equal(inspectSchema.safeParse({ query: 'selector', selector: { resourceId: 'material/hero' } }).success, false);
  assert.equal(inspectSchema.safeParse({ query: 'sceneDigest', include: ['script'] }).success, false);
  assert.equal(inspectSchema.safeParse({ query: 'sceneDigest', depth: 3 }).success, false);
  const modifierMutation = {
    protocolVersion: 'three-studio/1', sessionId: 'live-session', projectId: 'project/test', baseRevision: 4,
    idempotencyKey: 'change-modifiers', label: 'Edit exact modifier stack',
  };
  assert.equal(applySchema.safeParse({
    ...modifierMutation,
    operations: [{
      op: 'modifier.create', entityId: 'entity/wall', expectedStackHash: 'a'.repeat(64),
      modifier: { id: 'modifier/subdivision', type: 'subdivision', levels: 2, scheme: 'loop' },
    }],
  }).success, true);
  assert.equal(applySchema.safeParse({
    ...modifierMutation,
    operations: [{
      op: 'modifier.create', entityId: 'entity/wall', expectedStackHash: 'a'.repeat(64),
      modifier: { id: 'modifier/typo', type: 'subdivison', levels: 2 },
    }],
  }).success, false);
  assert.equal(applySchema.safeParse({
    ...modifierMutation,
    operations: [{
      op: 'modifier.stack.edit', entityId: 'entity/wall', expectedStackHash: 'a'.repeat(64),
      changes: [
        { type: 'create', modifier: { id: 'modifier/bevel', type: 'bakeBoundary', operatorType: 'BEVEL', parameters: { width: 0.03 } } },
        { type: 'move', modifierId: 'modifier/bevel', index: 0 },
      ],
    }],
  }).success, true);
  assert.equal(applySchema.safeParse({
    ...modifierMutation,
    operations: [{
      op: 'modifier.stack.edit', entityId: 'entity/wall', expectedStackHash: 'a'.repeat(64),
      changes: [{ type: 'create', modifier: { id: 'modifier/bevel', type: 'bakeBoundary', operatorType: 'BEVELL' } }],
    }],
  }).success, false);
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
  const parseOperation = operation => applySchema.safeParse({ ...mutation, operations: [operation] }).success;
  assert.equal(parseOperation({
    op: 'entity.patchMany', entityIds: ['entity/a', 'entity/b'], patch: { visible: false },
    expectedEntitySetHash: 'a'.repeat(64),
  }), true);
  assert.equal(parseOperation({
    op: 'entity.transformMany', entityIds: ['entity/a'], mode: 'delta', transform: { position: [1, 0, 0] },
    expectedEntitySetHash: 'a'.repeat(64),
  }), true);
  assert.equal(parseOperation({
    op: 'entity.group', sceneId: 'scene/main', entityIds: ['entity/a'], group: { id: 'entity/group', kind: 'group' },
    expectedEntitySetHash: 'a'.repeat(64),
  }), true);
  assert.equal(parseOperation({ op: 'entity.ungroup', entityId: 'entity/group', expectedSubtreeHash: 'a'.repeat(64) }), true);
  assert.equal(parseOperation({ op: 'collection.create', sceneId: 'scene/main', collection: { id: 'collection/environment' } }), true);
  assert.equal(parseOperation({
    op: 'collection.membership.patch', collectionId: 'collection/environment', addEntityIds: ['entity/a'],
    expectedMembershipHash: 'a'.repeat(64),
  }), true);
  assert.equal(parseOperation({
    op: 'collection.membership.patch', collectionId: 'collection/environment', addEntityIds: ['entity/a'],
    removeEntityIds: ['entity/a'], expectedMembershipHash: 'a'.repeat(64),
  }), false);
  assert.equal(parseOperation({
    op: 'entity.patchMany', entityIds: ['entity/a', 'entity/a'], patch: { visible: false },
    expectedEntitySetHash: 'a'.repeat(64),
  }), false);
  assert.equal(MAX_RESOURCE_ARRAY_ITEMS, 6_000_000);
  const denseIndices = new Array(20_001).fill(0);
  assert.equal(applySchema.safeParse({
    ...mutation,
    operations: [{
      op: 'resource.create',
      resourceType: 'geometries',
      resource: {
        id: 'geometry/dense',
        recipe: { kind: 'indexedMesh', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: denseIndices },
      },
    }],
  }).success, true);
  assert.equal(applySchema.safeParse({
    ...mutation,
    operations: [{ op: 'scene.create', scene: { id: 'scene/dense', values: denseIndices } }],
  }).success, false);
});

test('layout.pattern exposes strict bounded linear, grid, radial, and seeded scatter payloads', () => {
  const mutation = {
    protocolVersion: 'three-studio/1',
    sessionId: 'live-session',
    projectId: 'project/test',
    baseRevision: 4,
    idempotencyKey: 'layout-pattern-0001',
    label: 'Arrange source mesh',
  };
  const parse = pattern => applySchema.safeParse({
    ...mutation,
    operations: [{ op: 'layout.pattern', entityId: 'entity/source', pattern }],
  });

  assert.equal(parse({
    id: 'modifier/linear', mode: 'linear', count: 12, offset: [1.5, 0, -0.25],
  }).success, true);
  assert.equal(parse({
    id: 'modifier/grid', mode: 'grid', counts: [8, 4, 2], spacing: [2, 3, 4],
  }).success, true);
  assert.equal(parse({
    id: 'modifier/radial', mode: 'radial', count: 16, axis: 'y', center: [1, 2, 3],
    radius: 10, startAngle: 0.25, arc: Math.PI * 2, closed: true, orientation: 'tangent',
  }).success, true);
  assert.equal(parse({
    id: 'modifier/scatter-minimal', mode: 'scatter', count: 256, seed: -2147483648,
    bounds: { min: [-20, 0, -10], max: [20, 4, 10] },
  }).success, true);
  assert.equal(parse({
    id: 'modifier/scatter-ranges', mode: 'scatter', count: 128, seed: 2147483647,
    bounds: { min: [-20, 0, -10], max: [20, 4, 10] },
    rotationMin: [-0.1, -Math.PI, -0.1], rotationMax: [0.1, Math.PI, 0.1],
    scaleMin: [0.7, 0.7, 0.7], scaleMax: [1.3, 1.5, 1.3],
  }).success, true);

  assert.equal(parse({
    id: 'modifier/grid-too-large', mode: 'grid', counts: [64, 64, 3], spacing: [1, 1, 1],
  }).success, false);
  assert.equal(parse({
    id: 'modifier/unknown', mode: 'linear', count: 2, offset: [1, 0, 0], typo: true,
  }).success, false);
  assert.equal(parse({
    id: 'modifier/typed', type: 'pattern', mode: 'linear', count: 2, offset: [1, 0, 0],
  }).success, false);
  assert.equal(parse({
    id: 'modifier/scatter-float-seed', mode: 'scatter', count: 2, seed: 1.5,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  }).success, false);
  assert.equal(parse({
    id: 'modifier/scatter-too-large', mode: 'scatter', count: 8193, seed: 7,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  }).success, false);
  assert.equal(parse({
    id: 'modifier/scatter-inverted', mode: 'scatter', count: 2, seed: 7,
    bounds: { min: [0, 2, 0], max: [1, 1, 1] },
  }).success, false);
  assert.equal(parse({
    id: 'modifier/scatter-range-inverted', mode: 'scatter', count: 2, seed: 7,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    scaleMin: [1, 2, 1], scaleMax: [2, 1, 2],
  }).success, false);
  assert.equal(parse({
    id: 'modifier/scatter-zero-scale', mode: 'scatter', count: 2, seed: 7,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    scaleMin: [0, 1, 1], scaleMax: [1, 2, 2],
  }).success, false);
  assert.equal(parse({
    id: 'modifier/scatter-unknown', mode: 'scatter', count: 2, seed: 7,
    bounds: { min: [0, 0, 0], max: [1, 1, 1], radius: 3 },
  }).success, false);
  assert.equal(applySchema.safeParse({
    ...mutation,
    operations: [{ op: 'layout.pattern', entityId: 'entity/source' }],
  }).success, false);
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
  assert.equal(jobSchema.safeParse({}).success, false);
  assert.equal(jobSchema.safeParse({
    action: 'textureBake', projectId: 'project/demo', graphId: 'graph/skin', textureId: 'texture/skin',
    output: 'albedo', resolution: [256, 256], baseRevision: 0,
    idempotencyKey: 'bake-skin', label: 'Bake skin',
  }).success, true);
  assert.equal(jobSchema.safeParse({
    action: 'textureBake', projectId: 'project/demo', graphId: 'graph/skin', textureId: 'texture/skin',
    output: 'albedo', resolution: [512, 512], baseRevision: 0,
    idempotencyKey: 'bake-skin-large', label: 'Bake skin',
  }).success, false);
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
