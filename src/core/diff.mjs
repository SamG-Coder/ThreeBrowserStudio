import { RESOURCE_TYPES } from './constants.mjs';
import { changedTopLevelFields, stableStringify, uniqueSorted } from './util.mjs';

function compareTable(before, after, kind, containerId, output, deletedIds, changedIds) {
  for (const id of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    const prior = before?.[id];
    const next = after?.[id];
    if (!prior) {
      output.push({ kind, id, change: 'create', ...(containerId ? { containerId } : {}) });
      changedIds.push(id);
    } else if (!next) {
      output.push({ kind, id, change: 'delete', ...(containerId ? { containerId } : {}) });
      changedIds.push(id);
      deletedIds.push(id);
    } else if (stableStringify(prior) !== stableStringify(next)) {
      output.push({
        kind,
        id,
        change: 'patch',
        fields: changedTopLevelFields(prior, next),
        ...(containerId ? { containerId } : {}),
      });
      changedIds.push(id);
    }
  }
}

export function computeCompactDiff(before, after) {
  const changes = [];
  const changedIds = [];
  const deletedIds = [];
  const projectFields = changedTopLevelFields(before, after, new Set([
    'scenes', 'resources', 'scripts', 'revision', 'savedRevision', 'metadata',
  ]));
  if (projectFields.length) {
    changes.push({ kind: 'project', id: after.projectId, change: 'patch', fields: projectFields });
    changedIds.push(after.projectId);
  }

  for (const sceneId of new Set([...Object.keys(before.scenes ?? {}), ...Object.keys(after.scenes ?? {})])) {
    const prior = before.scenes?.[sceneId];
    const next = after.scenes?.[sceneId];
    if (!prior) {
      changes.push({ kind: 'scene', id: sceneId, change: 'create' });
      changedIds.push(sceneId, ...Object.keys(next.entities ?? {}));
      continue;
    }
    if (!next) {
      changes.push({ kind: 'scene', id: sceneId, change: 'delete' });
      changedIds.push(sceneId, ...Object.keys(prior.entities ?? {}));
      deletedIds.push(sceneId, ...Object.keys(prior.entities ?? {}));
      continue;
    }
    const sceneFields = changedTopLevelFields(prior, next, new Set(['entities']));
    if (sceneFields.length) {
      changes.push({ kind: 'scene', id: sceneId, change: 'patch', fields: sceneFields });
      changedIds.push(sceneId);
    }
    compareTable(prior.entities, next.entities, 'entity', sceneId, changes, deletedIds, changedIds);
  }

  for (const type of RESOURCE_TYPES) compareTable(before.resources?.[type], after.resources?.[type], type, undefined, changes, deletedIds, changedIds);
  compareTable(before.scripts, after.scripts, 'script', undefined, changes, deletedIds, changedIds);
  return {
    changes: changes.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`)),
    changedIds: uniqueSorted(changedIds),
    deletedIds: uniqueSorted(deletedIds),
  };
}

export function changedIdsSince(historyEntries, revision) {
  const entries = historyEntries.filter((entry) => entry.revision > revision);
  return {
    changedIds: uniqueSorted(entries.flatMap((entry) => entry.changedIds ?? [])),
    deletedIds: uniqueSorted(entries.flatMap((entry) => entry.deletedIds ?? [])),
  };
}
