import {
  BLENDER_RAINY_WINDOW_ACTION_ID,
  BLENDER_RAINY_WINDOW_GLASS_GRAPH_ID,
  BLENDER_RAINY_WINDOW_WOOD_GRAPH_ID,
  buildRainyWindowOperations,
} from './blender-rainy-window.mjs';

export const RAINY_WINDOW_LIVE_BUILD_PROJECT = 'blender-rainy-window-live-build';

const ROOT_ID = 'entity/rainy-window/showcase';
const WOOD_MATERIAL_ID = 'material/rainy-window/wood';
const GLASS_MATERIAL_ID = 'material/rainy-window/glass';

const clone = value => structuredClone(value);
const entityId = operation => operation.entity?.id;
const resourceId = operation => operation.resource?.id;

function placeholderMaterial(operation) {
  const staged = clone(operation);
  delete staged.resource.graphId;
  if (staged.resource.id === WOOD_MATERIAL_ID) {
    staged.resource.baseColor = [0.13, 0.075, 0.035];
    staged.resource.roughness = 0.9;
    staged.resource.clearcoat = 0;
  } else if (staged.resource.id === GLASS_MATERIAL_ID) {
    staged.resource.baseColor = [0.08, 0.13, 0.18];
    staged.resource.roughness = 0.28;
    staged.resource.transmission = 0.72;
    staged.resource.clearcoat = 0.1;
  }
  return staged;
}

function materialUpgrade(operation) {
  const resource = clone(operation.resource);
  const resourceId = resource.id;
  delete resource.id;
  return { op: 'resource.patch', resourceType: 'materials', resourceId, patch: resource };
}

function rootWithoutAnimation(operation) {
  const staged = clone(operation);
  delete staged.entity.components;
  return staged;
}

function stage(id, label, operations, holdMs) {
  return Object.freeze({ id, label, operations: Object.freeze(operations), holdMs });
}

export function buildRainyWindowLiveStages() {
  const operations = buildRainyWindowOperations();
  const sceneOperations = operations.filter(operation => operation.op.startsWith('scene.') && operation.op !== 'scene.setActiveCamera');
  const setActiveCamera = operations.find(operation => operation.op === 'scene.setActiveCamera');
  const geometries = operations.filter(operation => operation.op === 'resource.create' && operation.resourceType === 'geometries');
  const graphs = operations.filter(operation => operation.op === 'resource.create' && operation.resourceType === 'graphs');
  const materials = operations.filter(operation => operation.op === 'resource.create' && operation.resourceType === 'materials');
  const animation = operations.find(operation => operation.op === 'resource.create' && operation.resourceType === 'animations');
  const entities = operations.filter(operation => operation.op === 'entity.create');
  const byEntityId = new Map(entities.map(operation => [entityId(operation), operation]));
  const siblingCounts = new Map();
  const originalSiblingIndex = new Map();
  for (const operation of entities) {
    const parentId = operation.entity.parentId ?? 'scene/main:root';
    const index = siblingCounts.get(parentId) ?? 0;
    originalSiblingIndex.set(entityId(operation), index);
    siblingCounts.set(parentId, index + 1);
  }
  const takeEntities = ids => ids.map(id => ({
    ...clone(byEntityId.get(id)),
    index: originalSiblingIndex.get(id),
  }));

  const foundationIds = [
    ROOT_ID,
    'entity/rainy-window/frame',
    'entity/rainy-window/outside',
    'entity/rainy-window/bokeh',
    'entity/rainy-window/rain-a',
    'entity/rainy-window/rain-b',
    'entity/rainy-window/rain-c',
  ];
  const cameraAndLightIds = [
    'entity/rainy-window/aim',
    'entity/rainy-window/camera',
    'entity/rainy-window/key',
    'entity/rainy-window/warm-rim',
    'entity/rainy-window/backlight',
    'entity/rainy-window/ambient',
  ];
  const foundationEntities = takeEntities(foundationIds).map(operation => entityId(operation) === ROOT_ID
    ? rootWithoutAnimation(operation)
    : operation);

  const frameShellIds = [
    'entity/rainy-window/outer-left',
    'entity/rainy-window/outer-right',
    'entity/rainy-window/outer-top',
    'entity/rainy-window/outer-bottom',
  ];
  const joineryIds = [
    'entity/rainy-window/mullion-vertical',
    'entity/rainy-window/mullion-horizontal',
    'entity/rainy-window/trim-left',
    'entity/rainy-window/trim-right',
    'entity/rainy-window/trim-top',
    'entity/rainy-window/trim-bottom',
    'entity/rainy-window/sill',
  ];
  const exteriorIds = [
    'entity/rainy-window/night',
    'entity/rainy-window/branch-a',
    'entity/rainy-window/branch-b',
  ];
  const paneIds = ['entity/rainy-window/glass', 'entity/rainy-window/mist'];
  const bokehIds = entities.map(entityId).filter(id => /^entity\/rainy-window\/bokeh-\d+$/.test(id));
  const rainIds = entities.map(entityId).filter(id => /\/rainy-window\/(?:droplet|rivulet)-\d+$/.test(id));
  const rainFor = layerId => rainIds.filter(id => byEntityId.get(id).entity.parentId === layerId);
  const shaderMaterials = materials.filter(operation => [WOOD_MATERIAL_ID, GLASS_MATERIAL_ID].includes(resourceId(operation)));

  return Object.freeze([
    stage('foundation', 'Prepare an authored camera and invisible build resources', [
      ...sceneOperations.map(clone),
      ...geometries.map(clone),
      ...materials.map(placeholderMaterial),
      ...foundationEntities,
      ...takeEntities(cameraAndLightIds),
      clone(setActiveCamera),
    ], 0),
    stage('frame-shell', 'MCP build 1/9 — block out the four-pane timber frame', takeEntities(frameShellIds), 1_100),
    stage('joinery', 'MCP build 2/9 — add mullions, iron trim, and the sill', takeEntities(joineryIds), 1_100),
    stage('storm-exterior', 'MCP build 3/9 — place the storm backing and branch silhouettes', takeEntities(exteriorIds), 1_100),
    stage('distant-light', 'MCP build 4/9 — compose distant defocused lights', takeEntities(bokehIds), 1_000),
    stage('shader-graphs', 'MCP build 5/9 — compile Blender-shaped wood and rain shader graphs', [
      ...graphs.map(clone),
      ...shaderMaterials.map(materialUpgrade),
    ], 1_600),
    stage('glass-panes', 'MCP build 6/9 — fit the finished transmissive glass and condensation', takeEntities(paneIds), 1_100),
    stage('rain-layer-a', 'MCP build 7/9 — grow the first bead and rivulet layer', takeEntities(rainFor('entity/rainy-window/rain-a')), 900),
    stage('rain-layer-b', 'MCP build 8/9 — grow the second bead and rivulet layer', takeEntities(rainFor('entity/rainy-window/rain-b')), 900),
    stage('rain-layer-c', 'MCP build 9/9 — finish the layered rain surface', takeEntities(rainFor('entity/rainy-window/rain-c')), 900),
    stage('animation', 'Attach the 28-second camera and rain Action', [
      clone(animation),
      {
        op: 'entity.patch',
        entityId: ROOT_ID,
        patch: { components: { animation: { actionId: BLENDER_RAINY_WINDOW_ACTION_ID } } },
      },
    ], 600),
  ]);
}

export function summarizeRainyWindowLiveStages(stages = buildRainyWindowLiveStages()) {
  return Object.freeze({
    stages: stages.length,
    visibleStages: stages.length - 2,
    operations: stages.reduce((total, item) => total + item.operations.length, 0),
    holdMilliseconds: stages.reduce((total, item) => total + item.holdMs, 0),
    woodGraphId: BLENDER_RAINY_WINDOW_WOOD_GRAPH_ID,
    glassGraphId: BLENDER_RAINY_WINDOW_GLASS_GRAPH_ID,
  });
}
