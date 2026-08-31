import { contentHash } from '../core/util.mjs';

function slug(value) {
  return String(value).toLowerCase().replace(/^\$/u, '').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'prefab';
}

/** Named prefab discourse backed by canonical prefab resources and source snapshots. */
export class PlainformPrefabContext {
  constructor({ project, index, references, fail }) {
    this.project = project;
    this.index = index;
    this.references = references;
    this.fail = fail;
    this.prefabs = new Map();
    for (const resource of Object.values(project.resources.prefabs ?? {})) {
      const record = index.entities.get(resource.sourceEntityId);
      if (!record) continue;
      const name = this.normalizeName(resource.metadata?.plainform?.name ?? resource.id);
      const selection = { records: [record], ids: [record.entity.id], hash: null };
      references.nameSelection(name, selection);
      references.nameReference(name, record);
      this.prefabs.set(name, { prefabId: resource.id, record, resource });
    }
  }

  normalizeName(value) {
    return `$${slug(value)}`;
  }

  define(record, requestedName) {
    const name = this.normalizeName(requestedName);
    const prefabId = `prefab/${name.slice(1)}`;
    if (this.project.resources.prefabs?.[prefabId] || this.prefabs.has(name)) {
      this.fail('plainform_prefab_exists', `Prefab ${prefabId} already exists.`);
    }
    const descendants = [...this.index.entities.values()]
      .filter(candidate => candidate.scene.id === record.scene.id && this.#isInSubtree(candidate.entity, record.entity.id))
      .map(candidate => structuredClone(candidate.entity))
      .sort((left, right) => left.id.localeCompare(right.id));
    const snapshot = {
      sceneId: record.scene.id,
      rootEntityId: record.entity.id,
      entities: [structuredClone(record.entity), ...descendants],
    };
    const resource = {
      id: prefabId,
      kind: 'prefab',
      name: name.slice(1).replaceAll('-', ' '),
      sourceEntityId: record.entity.id,
      sourceSubtreeHash: this.index.subtreeHash(record.entity.id),
      template: snapshot,
      metadata: { plainform: { name, snapshotHash: contentHash(snapshot) } },
    };
    const selection = { records: [record], ids: [record.entity.id], hash: null };
    this.references.nameSelection(name, selection);
    this.references.nameReference(name, record);
    this.prefabs.set(name, { prefabId, record, resource });
    return {
      name,
      prefabId,
      record,
      operations: [
        { op: 'resource.create', resourceType: 'prefabs', resource },
        { op: 'entity.patch', entityId: record.entity.id, patch: { components: { prefab: { prefabId } } } },
      ],
    };
  }

  resolve(value) {
    const name = this.normalizeName(value);
    const local = this.prefabs.get(name);
    if (local) return local.record;
    return this.references.one(name);
  }

  #isInSubtree(entity, rootId) {
    let parentId = entity.parentId;
    while (parentId) {
      if (parentId === rootId) return true;
      parentId = this.index.entities.get(parentId)?.entity.parentId ?? null;
    }
    return false;
  }
}
