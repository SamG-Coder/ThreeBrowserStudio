import path from 'node:path';

import { LiveBridgeClient, defaultSessionMarkerPath, readSessionMarker } from '../src/bridge/index.mjs';
import {
  RAINY_WINDOW_LIVE_BUILD_PROJECT,
  buildRainyWindowLiveStages,
  summarizeRainyWindowLiveStages,
} from '../src/tutorials/blender-rainy-window-live.mjs';

const marker = await readSessionMarker(defaultSessionMarkerPath());
const args = process.argv.slice(2);
const mode = args.find(argument => ['prepare', 'build', 'all'].includes(argument)) ?? 'all';
const positional = args.find(argument => !argument.startsWith('--') && !['prepare', 'build', 'all'].includes(argument));
const projectDirectory = positional ?? RAINY_WINDOW_LIVE_BUILD_PROJECT;
const delayOption = args.find(argument => argument.startsWith('--delay-scale='));
const delayScale = delayOption ? Number(delayOption.split('=').at(-1)) : 1;
if (!Number.isFinite(delayScale) || delayScale < 0 || delayScale > 10) {
  throw new Error('--delay-scale must be a number from 0 through 10.');
}

const client = new LiveBridgeClient(marker);
const call = (method, params = {}) => client.request(method, { sessionId: marker.sessionId, ...params });
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds * delayScale));
const stages = buildRainyWindowLiveStages();

async function applyStage(status, item) {
  const applied = await call('three_studio_apply', {
    protocolVersion: marker.protocolVersion,
    projectId: status.projectId,
    baseRevision: status.revision,
    idempotencyKey: `rainy-window-live:${projectDirectory}:${item.id}`,
    label: item.label,
    operations: item.operations,
  });
  await wait(item.holdMs);
  return { ...status, revision: applied.revision };
}

try {
  await client.connect();
  let status;
  if (mode === 'prepare' || mode === 'all') {
    await call('three_studio_project', {
      action: 'create', path: projectDirectory,
      name: 'Blender Rainy Window — Live MCP Build',
      idempotencyKey: `rainy-window-live:create:${projectDirectory}`,
      label: 'Create a blank project for the visible MCP build',
    });
    status = await call('three_studio_status');
    await call('three_studio_play', {
      action: 'stop', projectId: status.projectId, baseRevision: status.revision,
      idempotencyKey: `rainy-window-live:stop:${projectDirectory}`,
      label: 'Hold the blank project in Author mode while MCP builds visibly',
    });
    status = await applyStage(status, stages[0]);
    await call('three_studio_project', {
      action: 'save', projectId: status.projectId, baseRevision: status.revision,
      idempotencyKey: `rainy-window-live:save-foundation:${projectDirectory}`,
      label: 'Save the blank authored-camera foundation before recording',
    });
  }

  if (mode === 'build' || mode === 'all') {
    if (mode === 'build') {
      await call('three_studio_project', {
        action: 'open', path: projectDirectory,
        idempotencyKey: `rainy-window-live:open:${projectDirectory}`,
        label: 'Open the prepared Rainy Window live-build project',
      });
      status = await call('three_studio_status');
    }
    await wait(250);
    for (const item of stages.slice(1)) status = await applyStage(status, item);

    const validation = await call('three_studio_validate', {
      projectId: status.projectId,
      checks: ['schemas', 'references', 'hierarchy', 'graphs', 'animations', 'budgets'],
    });
    if (!validation.success) throw new Error(`Live Rainy Window validation failed: ${JSON.stringify(validation.diagnostics)}`);
    await call('three_studio_project', {
      action: 'save', projectId: status.projectId, baseRevision: status.revision,
      idempotencyKey: `rainy-window-live:save-final:${projectDirectory}`,
      label: 'Save the completed live-built Rainy Window scene',
    });
    await call('three_studio_play', {
      action: 'enter', projectId: status.projectId, baseRevision: status.revision,
      idempotencyKey: `rainy-window-live:play:${projectDirectory}`,
      label: 'Play the completed Rainy Window camera and rain Action',
    });
  }

  const finalStatus = await call('three_studio_status');
  process.stdout.write(`${JSON.stringify({
    success: true,
    mode,
    projectId: finalStatus.projectId,
    projectPath: path.resolve(finalStatus.projectPath),
    revision: finalStatus.revision,
    play: finalStatus.play,
    summary: summarizeRainyWindowLiveStages(stages),
  }, null, 2)}\n`);
} finally {
  await client.close();
}
