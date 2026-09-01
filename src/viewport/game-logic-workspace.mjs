import { GRAPH_CATALOGS } from '../graphs/catalogs.mjs';
import { validateGraph } from '../graphs/validator.mjs';
import { createTransactionId } from '../core/util.mjs';

const blueprintCatalog = GRAPH_CATALOGS.blueprint;

function activeEntity(document, entityId) {
  return document?.scenes?.[document.activeSceneId]?.entities?.[entityId] ?? null;
}

function slug(value, fallback = 'logic') {
  const cleaned = String(value ?? '').toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return cleaned || fallback;
}

function uniqueGraphId(document, entity) {
  const base = `blueprint/${slug(entity.name ?? entity.id)}-logic`;
  if (!document.resources?.graphs?.[base]) return base;
  for (let index = 2; index <= 999; index += 1) {
    const candidate = `${base}-${index}`;
    if (!document.resources.graphs[candidate]) return candidate;
  }
  throw new Error('Could not allocate a unique blueprint graph ID.');
}

function compactDefinition(definition) {
  return Object.freeze({
    type: definition.type,
    label: definition.label,
    category: definition.category,
    description: definition.description,
    inputs: structuredClone(definition.inputs),
    outputs: structuredClone(definition.outputs),
    params: structuredClone(definition.params),
    tags: Object.freeze([...definition.tags]),
    event: definition.tags.includes('event-root'),
    executable: Object.values(definition.inputs).some(port => port.type === 'exec'),
  });
}

export const GAME_LOGIC_NODE_CATALOG = Object.freeze(
  Object.values(blueprintCatalog.nodes)
    .map(compactDefinition)
    .sort((left, right) => left.category.localeCompare(right.category) || left.label.localeCompare(right.label)),
);

function graphRecord(document, graphId) {
  const resource = document?.resources?.graphs?.[graphId];
  return resource?.graph?.domain === 'blueprint' ? resource : null;
}

function graphSummary(resource) {
  const validation = validateGraph(resource.graph);
  return Object.freeze({
    id: resource.id,
    name: resource.name ?? resource.id,
    graph: structuredClone(resource.graph),
    valid: validation.valid,
    errors: Object.freeze((validation.errors ?? []).map(entry => Object.freeze({ ...entry }))),
    warnings: Object.freeze((validation.warnings ?? []).map(entry => Object.freeze({ ...entry }))),
  });
}

export function readGameLogicWorkspace(document, entityId) {
  const entity = activeEntity(document, entityId);
  if (!entity) return null;
  const graphIds = entity.components?.logic?.graphIds ?? [];
  const attached = graphIds.map(id => graphRecord(document, id)).filter(Boolean).map(graphSummary);
  return Object.freeze({
    projectId: document.projectId,
    revision: document.revision,
    entity: Object.freeze({ id: entity.id, name: entity.name, kind: entity.kind }),
    graphIds: Object.freeze([...graphIds]),
    graphs: Object.freeze(attached),
    catalog: GAME_LOGIC_NODE_CATALOG,
  });
}

function defaultParam(name, definition) {
  if (definition.default !== undefined) return structuredClone(definition.default);
  if (!definition.required) return undefined;
  if (definition.type === 'identifier') return name === 'key' ? 'KeyW' : name;
  if (definition.type === 'stableId') return `${slug(name)}/replace-me`;
  if (definition.type === 'enum') return definition.values?.[0];
  if (definition.type === 'boolean') return false;
  if (definition.type === 'integer' || definition.type === 'number') return definition.min ?? 0;
  if (definition.type === 'typedValue') return 0;
  return undefined;
}

function defaultInput(type, entityId) {
  if (type === 'entityId') return entityId;
  if (type === 'boolean') return false;
  if (type === 'integer' || type === 'float' || type === 'numeric' || type === 'sameValue') return 0;
  if (type === 'vec2') return [0, 0];
  if (type === 'vec3' || type === 'entityProperty') return [0, 0, 0];
  if (type === 'vec4' || type === 'color') return [0, 0, 0, 1];
  if (type === 'eventPayload') return {};
  return null;
}

function uniqueNodeId(graph, definition) {
  const stem = `${definition.category}/${slug(definition.label, slug(definition.type))}`;
  const ids = new Set(graph.nodes.map(node => node.id));
  if (!ids.has(stem)) return stem;
  for (let index = 2; index <= 9999; index += 1) {
    const candidate = `${stem}-${index}`;
    if (!ids.has(candidate)) return candidate;
  }
  throw new Error('Could not allocate a unique node ID.');
}

export function addGameLogicNode(graphValue, nodeType, { entityId } = {}) {
  const graph = structuredClone(graphValue);
  const definition = blueprintCatalog.nodes[nodeType];
  if (!definition) throw new Error(`Unknown blueprint node ${nodeType}.`);
  const params = {};
  for (const [name, parameter] of Object.entries(definition.params)) {
    const value = defaultParam(name, parameter);
    if (value !== undefined) params[name] = value;
  }
  const inputs = {};
  for (const [name, port] of Object.entries(definition.inputs)) {
    if (port.type === 'exec' || !port.required) continue;
    inputs[name] = defaultInput(port.type, entityId);
  }
  const node = {
    id: uniqueNodeId(graph, definition),
    type: definition.type,
    params,
    ...(Object.keys(inputs).length ? { inputs } : {}),
  };
  if (definition.inputs.in?.type === 'exec') {
    const occupied = new Set(graph.edges.filter(edge => edge.from.port === 'out').map(edge => edge.from.nodeId));
    const source = [...graph.nodes].reverse().find(candidate => {
      const sourceDefinition = blueprintCatalog.nodes[candidate.type];
      return sourceDefinition?.outputs?.out?.type === 'exec' && !occupied.has(candidate.id);
    });
    if (source) graph.edges.push({ from: { nodeId: source.id, port: 'out' }, to: { nodeId: node.id, port: 'in' } });
  }
  graph.nodes.push(node);
  return Object.freeze({ graph, nodeId: node.id, validation: validateGraph(graph) });
}

export function removeGameLogicNode(graphValue, nodeId) {
  const graph = structuredClone(graphValue);
  graph.nodes = graph.nodes.filter(node => node.id !== nodeId);
  graph.edges = graph.edges.filter(edge => edge.from.nodeId !== nodeId && edge.to.nodeId !== nodeId);
  return Object.freeze({ graph, validation: validateGraph(graph) });
}

export function patchGameLogicNode(graphValue, nodeId, value) {
  const graph = structuredClone(graphValue);
  const index = graph.nodes.findIndex(node => node.id === nodeId);
  if (index < 0) throw new Error(`Node ${nodeId} is no longer in the graph.`);
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  graph.nodes[index] = {
    ...graph.nodes[index],
    params: structuredClone(source.params ?? {}),
    ...(source.inputs && Object.keys(source.inputs).length ? { inputs: structuredClone(source.inputs) } : {}),
  };
  if (!source.inputs || Object.keys(source.inputs).length === 0) delete graph.nodes[index].inputs;
  return Object.freeze({ graph, validation: validateGraph(graph) });
}

export async function createGameLogicGraph(application, entityId) {
  const document = application?.document;
  const entity = activeEntity(document, entityId);
  if (!entity) throw new Error(`Entity ${entityId} is no longer in the active scene.`);
  const graphId = uniqueGraphId(document, entity);
  const graph = {
    formatVersion: 1, id: graphId, domain: 'blueprint',
    nodes: [{ id: 'event/on-start', type: 'event.onStart', params: {} }],
    edges: [], outputs: {},
  };
  const graphIds = [...(entity.components?.logic?.graphIds ?? []), graphId];
  const operations = [{
    op: 'resource.create', resourceType: 'graphs',
    resource: { id: graphId, kind: 'graph', name: `${entity.name} Logic`, graph },
  }];
  if (entity.components?.logic) {
    operations.push({ op: 'entity.patch', entityId, patch: { components: { logic: { ...entity.components.logic, graphIds } } } });
  } else {
    operations.push({ op: 'entity.component.attach', entityId, component: 'logic', value: { enabled: true, graphIds } });
  }
  await application.dispatch('three_studio_apply', {
    baseRevision: document.revision,
    idempotencyKey: createTransactionId('ui-logic-create'),
    label: `Create GameMaker logic for ${entityId}`,
    operations,
  });
  return readGameLogicWorkspace(application.document, entityId);
}

export async function applyGameLogicGraph(application, entityId, graphId, graph) {
  const document = application?.document;
  if (!activeEntity(document, entityId)) throw new Error(`Entity ${entityId} is no longer in the active scene.`);
  const resource = graphRecord(document, graphId);
  if (!resource) throw new Error(`Blueprint graph ${graphId} is no longer available.`);
  const validation = validateGraph(graph);
  if (!validation.valid) {
    const first = validation.errors[0];
    throw new Error(first?.message ?? 'The blueprint graph is invalid.');
  }
  await application.dispatch('three_studio_apply', {
    baseRevision: document.revision,
    idempotencyKey: createTransactionId('ui-logic-apply'),
    label: `Update GameMaker logic ${graphId}`,
    operations: [{ op: 'resource.patch', resourceType: 'graphs', resourceId: graphId, patch: { graph } }],
  });
  return readGameLogicWorkspace(application.document, entityId);
}
