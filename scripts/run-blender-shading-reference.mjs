import { LiveBridgeClient, defaultSessionMarkerPath, readSessionMarker } from '../src/bridge/index.mjs';
import {
  BLENDER_PROCEDURAL_SHADING_SOURCE,
  BLENDER_SHADING_REFERENCE_SOURCE,
  buildBlenderShadingReferenceOperations,
} from '../src/tutorials/blender-shading-reference.mjs';

const marker = await readSessionMarker(defaultSessionMarkerPath());
const client = new LiveBridgeClient(marker);
const call = (method, params = {}) => client.request(method, { sessionId: marker.sessionId, ...params });

try {
  await client.connect();
  const status = await call('three_studio_status');
  if (status.projectId !== 'project/blender-modeling-reference') {
    throw new Error(`Open project/blender-modeling-reference before applying the shading reference; active project is ${status.projectId}.`);
  }
  const update = process.argv.includes('--update');
  const operations = buildBlenderShadingReferenceOperations({ update });
  const common = {
    protocolVersion: marker.protocolVersion,
    projectId: status.projectId,
    baseRevision: status.revision,
    label: 'Translate Blender procedural shading nodes to live TSL/WebGPU',
    operations,
  };
  await call('three_studio_apply', {
    ...common,
    idempotencyKey: `blender-shading-dry-run:${status.revision}`,
    dryRun: true,
  });
  const applied = await call('three_studio_apply', {
    ...common,
    idempotencyKey: `blender-shading-apply:${status.revision}`,
    dryRun: false,
  });
  const validation = await call('three_studio_validate', {
    projectId: status.projectId,
    checks: ['schemas', 'references', 'hierarchy', 'graphs', 'animations', 'budgets'],
  });
  const render = await call('three_studio_render', {
    projectId: status.projectId,
    cameraId: 'entity/modeling-reference/camera',
    width: 1280,
    height: 720,
    passes: ['beauty'],
    renderer: 'webgpu',
  });
  const saved = await call('three_studio_project', {
    action: 'save', projectId: status.projectId, baseRevision: applied.revision,
    idempotencyKey: `blender-shading-save:${applied.revision}`,
    label: 'Save verified procedural watering-can shader graph',
  });
  process.stdout.write(`${JSON.stringify({
    success: validation.success,
    projectId: status.projectId,
    revision: applied.revision,
    savedRevision: saved.savedRevision,
    sources: [BLENDER_SHADING_REFERENCE_SOURCE, BLENDER_PROCEDURAL_SHADING_SOURCE],
    evidence: render.evidence,
    diagnostics: validation.diagnostics,
  }, null, 2)}\n`);
} finally {
  await client.close();
}
