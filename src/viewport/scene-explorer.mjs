import { sanitizeLiveFeedText } from '../runtime/mcp-live-feed-telemetry.mjs';

const KIND_LABELS = Object.freeze({
  scene: 'Scene',
  group: 'Group',
  empty: 'Empty',
  mesh: 'Mesh',
  instancedMesh: 'Mesh',
  perspectiveCamera: 'Camera',
  orthographicCamera: 'Camera',
  directionalLight: 'Light',
  pointLight: 'Light',
  spotLight: 'Light',
  ambientLight: 'Light',
  areaLight: 'Light',
  hemisphereLight: 'Light',
  collection: 'Collection',
  section: 'Section',
});

function kindLabel(kind) {
  return KIND_LABELS[kind] ?? sanitizeLiveFeedText(kind, { maximum: 16, fallback: 'Object' });
}

function compactNode(record, extra = {}) {
  return Object.freeze({
    id: record.id,
    name: sanitizeLiveFeedText(record.name ?? record.id, { maximum: 64, fallback: record.id }),
    kind: record.kind ?? 'empty',
    children: Object.freeze([...(record.children ?? [])]),
    ...extra,
  });
}

export function buildExplorerOutline(document) {
  const scene = document?.scenes?.[document.activeSceneId];
  if (!scene) {
    return Object.freeze({
      revision: Number.isSafeInteger(document?.revision) ? document.revision : 0,
      sceneId: null,
      sceneName: 'No scene',
      rootEntityIds: Object.freeze([]),
      entities: Object.freeze({}),
      rootCollectionIds: Object.freeze([]),
      collections: Object.freeze({}),
    });
  }
  const entities = {};
  for (const entity of Object.values(scene.entities ?? {})) {
    entities[entity.id] = compactNode(entity, { visible: entity.visible !== false });
  }
  const collections = {};
  for (const collection of Object.values(scene.collections ?? {})) {
    collections[collection.id] = compactNode({
      ...collection,
      kind: 'collection',
    }, {
      memberCount: Array.isArray(collection.entityIds) ? collection.entityIds.length : 0,
    });
  }
  return Object.freeze({
    revision: Number.isSafeInteger(document.revision) ? document.revision : 0,
    sceneId: scene.id,
    sceneName: sanitizeLiveFeedText(scene.name ?? scene.id, { maximum: 64, fallback: scene.id }),
    rootEntityIds: Object.freeze([...(scene.rootEntityIds ?? [])]),
    entities: Object.freeze(entities),
    rootCollectionIds: Object.freeze([...(scene.rootCollectionIds ?? [])]),
    collections: Object.freeze(collections),
  });
}

export function defaultExpandedIds(outline) {
  const expanded = new Set();
  if (outline?.sceneId) expanded.add(outline.sceneId);
  for (const node of Object.values(outline?.entities ?? {})) {
    if (node.children.length > 0) expanded.add(node.id);
  }
  if ((outline?.rootCollectionIds ?? []).length > 0) expanded.add('section/collections');
  for (const node of Object.values(outline?.collections ?? {})) {
    if (node.children.length > 0) expanded.add(node.id);
  }
  return expanded;
}

function walk(ids, table, depth, expanded, rows, section) {
  for (const id of ids) {
    const node = table[id];
    if (!node) continue;
    const expandable = node.children.length > 0;
    const open = expandable && expanded.has(id);
    rows.push(Object.freeze({
      id: node.id,
      name: node.name,
      kind: node.kind,
      kindLabel: kindLabel(node.kind),
      depth,
      expandable,
      expanded: open,
      section,
      visible: node.visible !== false,
      memberCount: node.memberCount,
    }));
    if (open) walk(node.children, table, depth + 1, expanded, rows, section);
  }
}

export function flattenExplorerRows(outline, expanded = defaultExpandedIds(outline)) {
  const rows = [];
  if (outline?.sceneId) {
    rows.push(Object.freeze({
      id: outline.sceneId,
      name: outline.sceneName,
      kind: 'scene',
      kindLabel: kindLabel('scene'),
      depth: 0,
      expandable: outline.rootEntityIds.length > 0,
      expanded: expanded.has(outline.sceneId),
      section: 'scene',
      visible: true,
    }));
    if (expanded.has(outline.sceneId)) {
      walk(outline.rootEntityIds, outline.entities, 1, expanded, rows, 'entity');
    }
  }
  if ((outline?.rootCollectionIds ?? []).length > 0) {
    const sectionId = 'section/collections';
    const open = expanded.has(sectionId);
    rows.push(Object.freeze({
      id: sectionId,
      name: 'Collections',
      kind: 'section',
      kindLabel: kindLabel('section'),
      depth: 0,
      expandable: true,
      expanded: open,
      section: 'collections',
      visible: true,
    }));
    if (open) walk(outline.rootCollectionIds, outline.collections, 1, expanded, rows, 'collections');
  }
  return Object.freeze(rows);
}
