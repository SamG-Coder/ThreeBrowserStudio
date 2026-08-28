import { LiveBridgeClient, defaultSessionMarkerPath, readSessionMarker } from '../src/bridge/index.mjs';
import {
  BLENDER_MODELING_REFERENCE_SOURCE,
  buildBlenderModelingReferenceOperations,
} from '../src/tutorials/blender-modeling-reference.mjs';

const marker = await readSessionMarker(defaultSessionMarkerPath());
const projectDirectory = process.argv[2] ?? 'blender-modeling-reference';
const client = new LiveBridgeClient(marker);
const call = (method, params = {}) => client.request(method, {
  sessionId: marker.sessionId,
  ...params,
});

try {
  await client.connect();
  await call('three_studio_project', {
    action: 'create', path: projectDirectory,
    name: 'Blender Modeling — Watering Can Match',
    idempotencyKey: `modeling-reference-create:${projectDirectory}`,
    label: 'Create isolated Blender watering-can comparison project',
  });
  const status = await call('three_studio_status');
  const operations = buildBlenderModelingReferenceOperations();
  const request = {
    protocolVersion: marker.protocolVersion,
    projectId: status.projectId,
    baseRevision: status.revision,
    label: 'Recreate the Blender Fundamentals watering-can modeling endpoint',
    operations,
  };
  await call('three_studio_apply', {
    ...request,
    idempotencyKey: `modeling-reference-dry-run:${projectDirectory}`,
    dryRun: true,
  });
  const applied = await call('three_studio_apply', {
    ...request,
    idempotencyKey: `modeling-reference-apply:${projectDirectory}`,
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
    idempotencyKey: `modeling-reference-save:${projectDirectory}`,
    label: 'Save verified Blender watering-can comparison project',
  });
  process.stdout.write(`${JSON.stringify({
    success: validation.success,
    projectId: status.projectId,
    projectPath: status.projectPath,
    revision: applied.revision,
    savedRevision: saved.savedRevision,
    source: BLENDER_MODELING_REFERENCE_SOURCE,
    evidence: render.evidence,
    diagnostics: validation.diagnostics,
  }, null, 2)}\n`);
} finally {
  await client.close();
}
