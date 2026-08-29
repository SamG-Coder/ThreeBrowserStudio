import { FORMAT_VERSION, PROTOCOL_VERSION, RESOURCE_TYPES } from './constants.mjs';
import { normalizeProjectDocument } from './documents.mjs';
import geometries from '../../templates/starter-project/resources/geometries.json' with { type: 'json' };
import materials from '../../templates/starter-project/resources/materials.json' with { type: 'json' };
import starterScene from '../../templates/starter-project/scenes/scene_2Fstarter-stage.scene.json' with { type: 'json' };

function emptyResources() {
  const resources = {};
  for (const type of RESOURCE_TYPES) resources[type] = {};
  return resources;
}

/** Same authored starter the desktop host opens for a new project. */
export function createStarterProjectDocument({
  name = 'Starter Project',
  projectId = 'project/browser-preview',
} = {}) {
  const resources = emptyResources();
  resources.geometries = geometries;
  resources.materials = materials;
  return normalizeProjectDocument({
    kind: 'ThreeStudioProject',
    protocolVersion: PROTOCOL_VERSION,
    formatVersion: FORMAT_VERSION,
    projectId,
    name,
    revision: 0,
    savedRevision: 0,
    activeSceneId: starterScene.id,
    sceneOrder: [starterScene.id],
    scenes: { [starterScene.id]: starterScene },
    resources,
    scripts: {},
    scriptTrustPolicy: 'agent-safe',
    settings: {
      lengthUnit: 'metre',
      angleUnit: 'radian',
      timeUnit: 'second',
      workingColorSpace: 'linear-srgb',
    },
    exportSettings: {},
    metadata: {
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
      description: 'Lean WebGPU starter stage with a lit primitive composition and soft shadows.',
    },
  });
}
