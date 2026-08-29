import { StudioError } from './errors.mjs';
import { assertStableId } from './ids.mjs';
import { ProjectIndex, buildProjectIndex } from './indexes.mjs';
import { contentHash } from './util.mjs';

export const MAX_EXACT_ENTITY_SELECTION = 200;

function resolveIndex(projectOrIndex) {
  return projectOrIndex instanceof ProjectIndex
    ? projectOrIndex
    : buildProjectIndex(projectOrIndex);
}

function validateSelectionLimit(maxEntities) {
  if (!Number.isSafeInteger(maxEntities)
    || maxEntities < 1
    || maxEntities > MAX_EXACT_ENTITY_SELECTION) {
    throw new StudioError(
      'invalid_selection_limit',
      `maxEntities must be an integer from 1 to ${MAX_EXACT_ENTITY_SELECTION}`,
      { maxEntities, maximum: MAX_EXACT_ENTITY_SELECTION },
    );
  }
  return maxEntities;
}

/**
 * Resolve a bounded list of exact, globally stable entity IDs.
 *
 * Input order is retained for callers that need ordered edits. The returned
 * entity-set hash is intentionally order-independent: it hashes canonical
 * entity snapshots after sorting by stable ID.
 */
export function resolveExactEntitySelection(projectOrIndex, entityIds, {
  allowEmpty = false,
  maxEntities = MAX_EXACT_ENTITY_SELECTION,
  requireSameScene = false,
  sceneId = undefined,
} = {}) {
  const limit = validateSelectionLimit(maxEntities);
  if (!Array.isArray(entityIds)) {
    throw new StudioError('invalid_entity_selection', 'entityIds must be an array of exact stable IDs');
  }
  if (!allowEmpty && entityIds.length === 0) {
    throw new StudioError('empty_entity_selection', 'entityIds must contain at least one exact stable ID');
  }
  if (entityIds.length > limit) {
    throw new StudioError(
      'entity_selection_too_large',
      `entityIds contains ${entityIds.length} IDs; the maximum is ${limit}`,
      { count: entityIds.length, maximum: limit },
    );
  }

  const expectedSceneId = sceneId === undefined ? undefined : assertStableId(sceneId, 'sceneId');
  const seen = new Set();
  const index = resolveIndex(projectOrIndex);
  const entries = entityIds.map((candidate, position) => {
    const entityId = assertStableId(candidate, `entityIds[${position}]`);
    if (seen.has(entityId)) {
      throw new StudioError(
        'duplicate_entity_selection',
        `entityIds contains duplicate exact ID ${entityId}`,
        { entityId, position },
      );
    }
    seen.add(entityId);
    const resolved = index.getEntity(entityId);
    if (expectedSceneId !== undefined && resolved.sceneId !== expectedSceneId) {
      throw new StudioError(
        'entity_scene_mismatch',
        `Entity ${entityId} belongs to ${resolved.sceneId}, not ${expectedSceneId}`,
        { entityId, actualSceneId: resolved.sceneId, expectedSceneId },
      );
    }
    return {
      entityId,
      sceneId: resolved.sceneId,
      scene: resolved.scene,
      entity: resolved.entity,
    };
  });

  const sceneIds = [...new Set(entries.map((entry) => entry.sceneId))].sort();
  if (requireSameScene && sceneIds.length > 1) {
    throw new StudioError(
      'mixed_scene_entity_selection',
      'All selected entities must belong to the same scene',
      { sceneIds },
    );
  }

  const sortedEntries = [...entries].sort((left, right) => left.entityId.localeCompare(right.entityId));
  return {
    entityIds: entries.map((entry) => entry.entityId),
    sortedEntityIds: sortedEntries.map((entry) => entry.entityId),
    entries,
    sceneIds,
    sceneId: sceneIds.length === 1 ? sceneIds[0] : null,
    entitySetHash: contentHash(sortedEntries.map((entry) => entry.entity)),
  };
}

export function hashExactEntitySet(projectOrIndex, entityIds, options = {}) {
  return resolveExactEntitySelection(projectOrIndex, entityIds, options).entitySetHash;
}

export function assertExpectedEntitySetHash(actualHash, expectedHash) {
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new StudioError(
      'invalid_entity_set_hash',
      'expectedEntitySetHash must be a lowercase SHA-256 hash',
      { expectedEntitySetHash: expectedHash },
    );
  }
  if (actualHash !== expectedHash) {
    throw new StudioError(
      'entity_set_conflict',
      'The selected entities changed after they were inspected',
      { expectedEntitySetHash: expectedHash, actualEntitySetHash: actualHash },
    );
  }
  return actualHash;
}
