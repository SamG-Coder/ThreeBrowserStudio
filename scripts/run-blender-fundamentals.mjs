import { LiveBridgeClient, defaultSessionMarkerPath, readSessionMarker } from '../src/bridge/index.mjs';
import {
  BLENDER_FUNDAMENTALS_SOURCES,
  buildBlenderFundamentalsOperations,
  summarizeBlenderFundamentalsOperations,
} from '../src/tutorials/blender-fundamentals.mjs';

const marker = await readSessionMarker(defaultSessionMarkerPath());
const projectDirectory = process.argv[2] ?? 'blender-fundamentals';
const client = new LiveBridgeClient(marker);
const call = (method, params = {}) => client.request(method, {
  sessionId: marker.sessionId,
  ...params,
});

try {
  await client.connect();
  await call('three_studio_project', {
    action: 'create',
    path: projectDirectory,
    name: 'Blender Fundamentals — MCP Translation',
    idempotencyKey: `tutorial-create:${projectDirectory}`,
    label: 'Create the official Blender Fundamentals translation project',
  });
  const status = await call('three_studio_status');
  const operations = buildBlenderFundamentalsOperations();
  const request = {
    protocolVersion: marker.protocolVersion,
    projectId: status.projectId,
    baseRevision: status.revision,
    label: 'Translate Blender watering-can, lighting, camera, modifiers, and keyframes to MCP',
    operations,
  };
  const dryRun = await call('three_studio_apply', {
    ...request,
    idempotencyKey: `tutorial-dry-run:${projectDirectory}`,
    dryRun: true,
  });
  const applied = await call('three_studio_apply', {
    ...request,
    idempotencyKey: `tutorial-apply:${projectDirectory}`,
    dryRun: false,
  });
  const validation = await call('three_studio_validate', {
    projectId: status.projectId,
    checks: ['schemas', 'references', 'hierarchy', 'graphs', 'animations', 'budgets'],
  });
  const renders = [];
  for (const timelineFrame of [1, 7, 13]) {
    renders.push(await call('three_studio_render', {
      projectId: status.projectId,
      cameraId: 'entity/fundamentals/camera',
      timelineFrame,
      width: 1200,
      height: 800,
      passes: ['beauty'],
      renderer: 'webgpu',
    }));
  }
  const saved = await call('three_studio_project', {
    action: 'save',
    projectId: status.projectId,
    baseRevision: applied.revision,
    idempotencyKey: `tutorial-save:${projectDirectory}`,
    label: 'Save verified Blender Fundamentals MCP project',
  });
  process.stdout.write(`${JSON.stringify({
    success: validation.success,
    projectId: status.projectId,
    projectPath: status.projectPath,
    dryRunRevision: dryRun.revision,
    revision: applied.revision,
    savedRevision: saved.savedRevision,
    tutorial: summarizeBlenderFundamentalsOperations(operations),
    sources: BLENDER_FUNDAMENTALS_SOURCES,
    renders: renders.map(render => ({
      timelineFrame: render.timelineFrame,
      evidence: render.evidence,
    })),
    diagnostics: validation.diagnostics,
  }, null, 2)}\n`);
} finally {
  await client.close();
}
