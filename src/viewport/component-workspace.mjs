import { queryEntityComponentCatalog } from '../core/component-catalog.mjs';
import { createTransactionId, stableStringify } from '../core/util.mjs';

function activeEntity(document, entityId) {
  return document?.scenes?.[document.activeSceneId]?.entities?.[entityId] ?? null;
}

function requirementAvailable(document, requirement) {
  if (requirement === 'blueprint-graph') {
    return Object.values(document?.resources?.graphs ?? {}).some(resource => resource.graph?.domain === 'blueprint');
  }
  if (requirement === 'audio-resource') return Object.keys(document?.resources?.audio ?? {}).length > 0;
  return true;
}

function componentDefaults(document, definition) {
  const value = structuredClone(definition.defaults);
  if (definition.id === 'logic') {
    const graph = Object.values(document?.resources?.graphs ?? {})
      .find(resource => resource.graph?.domain === 'blueprint');
    value.graphIds = graph ? [graph.id] : [];
  }
  if (definition.id === 'audio') value.audioId = Object.keys(document?.resources?.audio ?? {})[0];
  if (definition.id === 'animation') value.actionId = Object.keys(document?.resources?.animations ?? {})[0];
  return value;
}

export function readComponentWorkspace(document, entityId) {
  const entity = activeEntity(document, entityId);
  if (!entity) return null;
  const components = structuredClone(entity.components ?? {});
  const catalog = queryEntityComponentCatalog({ entityKind: entity.kind, installed: Object.keys(components) })
    .map(definition => Object.freeze({
      ...definition,
      requirementsMet: definition.requires.every(requirement => requirementAvailable(document, requirement)),
      suggestedValue: componentDefaults(document, definition),
    }));
  return Object.freeze({
    projectId: document.projectId,
    revision: document.revision,
    entity: Object.freeze({ id: entity.id, name: entity.name, kind: entity.kind }),
    components: Object.freeze(components),
    catalog: Object.freeze(catalog),
  });
}

export async function applyComponentWorkspace(application, entityId, components) {
  if (!application?.dispatch || !application.document) throw new TypeError('A Studio application is required.');
  if (!activeEntity(application.document, entityId)) throw new Error(`Entity ${entityId} is no longer in the active scene.`);
  const current = activeEntity(application.document, entityId).components ?? {};
  const desired = components ?? {};
  const operations = [];
  for (const component of new Set([...Object.keys(current), ...Object.keys(desired)])) {
    if (current[component] === undefined) {
      operations.push({ op: 'entity.component.attach', entityId, component, value: structuredClone(desired[component]) });
    } else if (desired[component] === undefined) {
      operations.push({ op: 'entity.component.remove', entityId, component });
    } else if (stableStringify(current[component]) !== stableStringify(desired[component])) {
      operations.push({ op: 'entity.patch', entityId, patch: { components: { [component]: structuredClone(desired[component]) } } });
    }
  }
  if (operations.length === 0) return readComponentWorkspace(application.document, entityId);
  await application.dispatch('three_studio_apply', {
    baseRevision: application.document.revision,
    idempotencyKey: createTransactionId('ui-component'),
    label: `Update components on ${entityId}`,
    operations,
  });
  return readComponentWorkspace(application.document, entityId);
}
