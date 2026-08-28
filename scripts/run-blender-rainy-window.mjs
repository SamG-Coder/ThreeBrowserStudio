import { LiveBridgeClient, defaultSessionMarkerPath, readSessionMarker } from '../src/bridge/index.mjs';
import {
  BLENDER_RAINY_WINDOW_AUTHOR,
  BLENDER_RAINY_WINDOW_LICENSE,
  BLENDER_RAINY_WINDOW_SOURCE,
  buildRainyWindowOperations,
  summarizeRainyWindowOperations,
} from '../src/tutorials/blender-rainy-window.mjs';

const marker = await readSessionMarker(defaultSessionMarkerPath());
const projectDirectory = process.argv[2] ?? 'blender-rainy-window';
const client = new LiveBridgeClient(marker);
const call = (method, params = {}) => client.request(method, { sessionId: marker.sessionId, ...params });

try {
  await client.connect();
  await call('three_studio_project', {
    action: 'create', path: projectDirectory,
    name: 'Blender Procedural Shading — Rainy Window',
    idempotencyKey: `rainy-window-create:${projectDirectory}`,
    label: 'Create isolated Blender Rainy Window translation project',
  });
  const status = await call('three_studio_status');
  const operations = buildRainyWindowOperations();
  const request = {
    protocolVersion: marker.protocolVersion,
    projectId: status.projectId,
    baseRevision: status.revision,
    label: 'Recreate Blender Studio Rainy Window with live TSL WebGPU shaders',
    operations,
  };
  await call('three_studio_apply', {
    ...request,
    idempotencyKey: `rainy-window-dry-run:${projectDirectory}`,
    dryRun: true,
  });
  const applied = await call('three_studio_apply', {
    ...request,
    idempotencyKey: `rainy-window-apply:${projectDirectory}`,
    dryRun: false,
  });
  const validation = await call('three_studio_validate', {
    projectId: status.projectId,
    checks: ['schemas', 'references', 'hierarchy', 'graphs', 'animations', 'budgets'],
  });
  if (!validation.success) {
    throw new Error(`Rainy Window validation failed: ${JSON.stringify(validation.diagnostics)}`);
  }
  const evidence = [];
  for (const timelineFrame of [0, 336, 672]) {
    const render = await call('three_studio_render', {
      projectId: status.projectId,
      cameraId: 'entity/rainy-window/camera',
      timelineFrame,
      width: 1280,
      height: 720,
      passes: ['beauty'],
      renderer: 'webgpu',
    });
    evidence.push(...render.evidence);
  }
  const saved = await call('three_studio_project', {
    action: 'save', projectId: status.projectId, baseRevision: applied.revision,
    idempotencyKey: `rainy-window-save:${projectDirectory}`,
    label: 'Save verified Blender Rainy Window tutorial translation',
  });
  process.stdout.write(`${JSON.stringify({
    success: validation.success,
    projectId: status.projectId,
    projectPath: status.projectPath,
    revision: applied.revision,
    savedRevision: saved.savedRevision,
    source: BLENDER_RAINY_WINDOW_SOURCE,
    author: BLENDER_RAINY_WINDOW_AUTHOR,
    license: BLENDER_RAINY_WINDOW_LICENSE,
    summary: summarizeRainyWindowOperations(operations),
    evidence,
    diagnostics: validation.diagnostics,
  }, null, 2)}\n`);
} finally {
  await client.close();
}
