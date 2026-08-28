import { RESOURCE_TYPES } from './constants.mjs';
import { StudioError } from './errors.mjs';
import { assertStableId } from './ids.mjs';
import { contentHash } from './util.mjs';
import { entityComponentReferences } from './component-validation.mjs';

export class ProjectIndex {
  constructor(project) {
    this.project = project;
    this.scenes = new Map();
    this.entities = new Map();
    this.resources = new Map();
    this.scripts = new Map();
    this.referencesTo = new Map();
    this.#build();
  }

  #addReference(targetId, reference) {
    if (!targetId) return;
    const list = this.referencesTo.get(targetId) ?? [];
    list.push(Object.freeze(reference));
    this.referencesTo.set(targetId, list);
  }

  #build() {
    for (const scene of Object.values(this.project.scenes ?? {})) {
      this.scenes.set(scene.id, scene);
      for (const entity of Object.values(scene.entities ?? {})) {
        if (this.entities.has(entity.id)) {
          throw new StudioError('duplicate_id', `Duplicate entity ID ${entity.id}`);
        }
        this.entities.set(entity.id, { sceneId: scene.id, scene, entity });
        if (entity.parentId) this.#addReference(entity.parentId, { kind: 'parent', sourceId: entity.id, sceneId: scene.id });
        for (const scriptId of entity.scriptIds ?? []) this.#addReference(scriptId, { kind: 'entityScript', sourceId: entity.id, sceneId: scene.id });
        for (const reference of entityComponentReferences(entity)) {
          this.#addReference(reference.targetId, {
            kind: reference.kind,
            sourceId: entity.id,
            sceneId: scene.id,
            path: reference.path,
          });
        }
      }
      for (const scriptId of scene.scriptIds ?? []) this.#addReference(scriptId, { kind: 'sceneScript', sourceId: scene.id, sceneId: scene.id });
      if (scene.settings?.activeCameraId) this.#addReference(scene.settings.activeCameraId, { kind: 'activeCamera', sourceId: scene.id, sceneId: scene.id });
    }
    for (const type of RESOURCE_TYPES) {
      for (const resource of Object.values(this.project.resources?.[type] ?? {})) {
        if (this.resources.has(resource.id)) throw new StudioError('duplicate_id', `Duplicate resource ID ${resource.id}`);
        this.resources.set(resource.id, { type, resource });
        if (type === 'materials') {
          this.#addReference(resource.graphId, { kind: 'materialGraph', sourceId: resource.id });
          const values = resource.parameters ?? resource.values ?? resource;
          for (const key of ['mapId', 'normalMapId', 'roughnessMapId', 'metalnessMapId', 'emissiveMapId', 'alphaMapId']) {
            this.#addReference(values?.[key], { kind: 'materialTexture', sourceId: resource.id, path: key });
          }
        }
        if (type === 'animations') {
          for (const track of resource.tracks ?? resource.channels ?? []) {
            this.#addReference(track?.targetId, { kind: 'animationTarget', sourceId: resource.id, path: 'tracks.targetId' });
          }
        }
      }
    }
    for (const script of Object.values(this.project.scripts ?? {})) {
      this.scripts.set(script.id, script);
    }
  }

  getScene(sceneId) {
    assertStableId(sceneId, 'sceneId');
    const scene = this.scenes.get(sceneId);
    if (!scene) throw new StudioError('not_found', `Scene ${sceneId} does not exist`, { id: sceneId, kind: 'scene' });
    return scene;
  }

  getEntity(entityId) {
    assertStableId(entityId, 'entityId');
    const result = this.entities.get(entityId);
    if (!result) throw new StudioError('not_found', `Entity ${entityId} does not exist`, { id: entityId, kind: 'entity' });
    return result;
  }

  getResource(resourceId, expectedType) {
    assertStableId(resourceId, 'resourceId');
    const result = this.resources.get(resourceId);
    if (!result) throw new StudioError('not_found', `Resource ${resourceId} does not exist`, { id: resourceId, kind: 'resource' });
    if (expectedType && result.type !== expectedType) {
      throw new StudioError('resource_type_mismatch', `${resourceId} is ${result.type}, not ${expectedType}`);
    }
    return result;
  }

  getReferencesTo(id) {
    return [...(this.referencesTo.get(id) ?? [])];
  }

  collectSubtree(entityId) {
    const { scene, entity } = this.getEntity(entityId);
    const result = [];
    const visit = (current) => {
      result.push(current.id);
      for (const childId of current.children) {
        const child = scene.entities[childId];
        if (child) visit(child);
      }
    };
    visit(entity);
    return result;
  }

  subtreeHash(entityId) {
    const { scene } = this.getEntity(entityId);
    const ids = this.collectSubtree(entityId).sort();
    return contentHash(ids.map((id) => scene.entities[id]));
  }
}

export function buildProjectIndex(project) {
  return new ProjectIndex(project);
}

export function findEntity(project, entityId) {
  return buildProjectIndex(project).getEntity(entityId);
}

export function findResource(project, resourceId, expectedType) {
  return buildProjectIndex(project).getResource(resourceId, expectedType);
}

export function collectEntitySubtree(project, entityId) {
  return buildProjectIndex(project).collectSubtree(entityId);
}

export function hashEntitySubtree(project, entityId) {
  return buildProjectIndex(project).subtreeHash(entityId);
}
