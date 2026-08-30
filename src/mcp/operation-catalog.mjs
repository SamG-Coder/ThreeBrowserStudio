import { OPERATION_TYPES } from './tool-schemas.mjs';

const FAMILY_SUMMARIES = Object.freeze({
  scene: 'Create or configure scene-owned state.',
  entity: 'Manage exact scene entities and their authored transforms.',
  collection: 'Manage independent many-to-many scene organization.',
  camera: 'Compose and persist an authored camera shot.',
  layout: 'Create bounded deterministic instance layouts.',
  stroke: 'Apply a reusable sculpt, paint, curve, or scatter stroke.',
  lighting: 'Create or refine a semantic lighting rig.',
  modifier: 'Edit an exact guarded non-destructive modifier stack.',
  geometry: 'Edit or derive canonical geometry resources.',
  material: 'Create a reusable material variant or look.',
  resource: 'Create, patch, or delete a typed project resource.',
});

export const OPERATION_CATALOG = Object.freeze(OPERATION_TYPES.map((operation) => {
  const family = operation.split('.')[0];
  return Object.freeze({
    operation,
    family,
    summary: FAMILY_SUMMARIES[family] ?? 'Apply one typed canonical project mutation.',
  });
}));

export function queryOperationCatalog({ search, family, limit = 50 } = {}) {
  const needle = String(search ?? '').trim().toLowerCase();
  const entries = OPERATION_CATALOG.filter(entry => (
    (!family || entry.family === family)
    && (!needle || `${entry.operation} ${entry.summary}`.toLowerCase().includes(needle))
  )).slice(0, Math.max(1, Math.min(200, limit)));
  return Object.freeze({
    version: 1,
    total: OPERATION_CATALOG.length,
    matched: OPERATION_CATALOG.filter(entry => (
      (!family || entry.family === family)
      && (!needle || `${entry.operation} ${entry.summary}`.toLowerCase().includes(needle))
    )).length,
    returned: entries.length,
    entries,
  });
}
