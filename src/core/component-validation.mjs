import { isStableId } from './ids.mjs';
import { isPlainRecord } from './util.mjs';

export const RUNTIME_MODIFIER_TYPES = Object.freeze(['array', 'mirror']);
export const RUNTIME_CONSTRAINT_TYPES = Object.freeze([
  'lookAt', 'trackTo', 'copyLocation', 'copyRotation', 'copyScale', 'limitLocation',
]);

const vector3 = value => Array.isArray(value)
  && value.length === 3
  && value.every(number => Number.isFinite(number));

function diagnostic(diagnostics, code, path, message) {
  diagnostics.push({ severity: 'error', code, path, message });
}

function validateModifier(modifier, index, path, diagnostics, ids) {
  const at = `${path}.modifiers.${index}`;
  if (!isPlainRecord(modifier)) {
    diagnostic(diagnostics, 'invalid_modifier', at, 'Modifier must be an object');
    return;
  }
  if (!isStableId(modifier.id)) diagnostic(diagnostics, 'invalid_modifier_id', `${at}.id`, 'Modifier requires a stable ID');
  else if (ids.has(modifier.id)) diagnostic(diagnostics, 'duplicate_modifier_id', `${at}.id`, `Duplicate modifier ID ${modifier.id}`);
  else ids.add(modifier.id);
  if (typeof modifier.type !== 'string' || modifier.type.length === 0) {
    diagnostic(diagnostics, 'invalid_modifier_type', `${at}.type`, 'Modifier type is required');
  }
  if (modifier.enabled !== undefined && typeof modifier.enabled !== 'boolean') {
    diagnostic(diagnostics, 'invalid_modifier_enabled', `${at}.enabled`, 'enabled must be boolean');
  }
  if (modifier.enabledViewport !== undefined && typeof modifier.enabledViewport !== 'boolean') {
    diagnostic(diagnostics, 'invalid_modifier_enabled', `${at}.enabledViewport`, 'enabledViewport must be boolean');
  }
  if (modifier.enabledRender !== undefined && typeof modifier.enabledRender !== 'boolean') {
    diagnostic(diagnostics, 'invalid_modifier_enabled', `${at}.enabledRender`, 'enabledRender must be boolean');
  }
  if (modifier.type === 'array') {
    if (!Number.isInteger(modifier.count) || modifier.count < 1 || modifier.count > 256) {
      diagnostic(diagnostics, 'invalid_array_count', `${at}.count`, 'Array count must be an integer from 1 to 256');
    }
    if (modifier.offset !== undefined && !vector3(modifier.offset)) {
      diagnostic(diagnostics, 'invalid_array_offset', `${at}.offset`, 'Array offset must contain three finite numbers');
    }
  }
  if (modifier.type === 'mirror' && !['x', 'y', 'z'].includes(modifier.axis ?? 'x')) {
    diagnostic(diagnostics, 'invalid_mirror_axis', `${at}.axis`, 'Mirror axis must be x, y, or z');
  }
}

function validateConstraint(constraint, index, path, diagnostics, ids) {
  const at = `${path}.constraints.${index}`;
  if (!isPlainRecord(constraint)) {
    diagnostic(diagnostics, 'invalid_constraint', at, 'Constraint must be an object');
    return;
  }
  if (!isStableId(constraint.id)) diagnostic(diagnostics, 'invalid_constraint_id', `${at}.id`, 'Constraint requires a stable ID');
  else if (ids.has(constraint.id)) diagnostic(diagnostics, 'duplicate_constraint_id', `${at}.id`, `Duplicate constraint ID ${constraint.id}`);
  else ids.add(constraint.id);
  if (typeof constraint.type !== 'string' || constraint.type.length === 0) {
    diagnostic(diagnostics, 'invalid_constraint_type', `${at}.type`, 'Constraint type is required');
  }
  if (constraint.enabled !== undefined && typeof constraint.enabled !== 'boolean') {
    diagnostic(diagnostics, 'invalid_constraint_enabled', `${at}.enabled`, 'enabled must be boolean');
  }
  if (constraint.influence !== undefined
      && (!Number.isFinite(constraint.influence) || constraint.influence < 0 || constraint.influence > 1)) {
    diagnostic(diagnostics, 'invalid_constraint_influence', `${at}.influence`, 'Constraint influence must be from 0 to 1');
  }
  if (constraint.targetId !== undefined && !isStableId(constraint.targetId)) {
    diagnostic(diagnostics, 'invalid_constraint_target', `${at}.targetId`, 'Constraint targetId must be a stable ID');
  }
  if (['lookAt', 'trackTo', 'copyLocation', 'copyRotation', 'copyScale'].includes(constraint.type)
      && !isStableId(constraint.targetId)) {
    diagnostic(diagnostics, 'missing_constraint_target', `${at}.targetId`, `${constraint.type} requires targetId`);
  }
  if (constraint.type === 'limitLocation') {
    if (constraint.min !== undefined && !vector3(constraint.min)) diagnostic(diagnostics, 'invalid_constraint_limit', `${at}.min`, 'min must contain three finite numbers');
    if (constraint.max !== undefined && !vector3(constraint.max)) diagnostic(diagnostics, 'invalid_constraint_limit', `${at}.max`, 'max must contain three finite numbers');
  }
}

/**
 * Validates only the component contracts Studio understands. Unknown component
 * namespaces remain forward-compatible authored data and are capability-gated
 * by the runtime instead of being silently interpreted.
 */
export function validateEntityComponents(entity, path, diagnostics) {
  const components = entity.components;
  if (!isPlainRecord(components)) return;
  if (components.modifiers !== undefined) {
    if (!Array.isArray(components.modifiers) || components.modifiers.length > 64) {
      diagnostic(diagnostics, 'invalid_modifiers', `${path}.components.modifiers`, 'modifiers must be an array with at most 64 entries');
    } else {
      const ids = new Set();
      components.modifiers.forEach((modifier, index) => validateModifier(
        modifier,
        index,
        `${path}.components`,
        diagnostics,
        ids,
      ));
    }
  }
  if (components.constraints !== undefined) {
    if (!Array.isArray(components.constraints) || components.constraints.length > 64) {
      diagnostic(diagnostics, 'invalid_constraints', `${path}.components.constraints`, 'constraints must be an array with at most 64 entries');
    } else {
      const ids = new Set();
      components.constraints.forEach((constraint, index) => validateConstraint(
        constraint,
        index,
        `${path}.components`,
        diagnostics,
        ids,
      ));
    }
  }
}

export function entityComponentReferences(entity) {
  const references = [];
  const add = (targetId, kind, path) => {
    if (isStableId(targetId)) references.push({ targetId, kind, path });
  };
  const components = entity.components ?? {};
  const mesh = components.mesh ?? {};
  add(mesh.geometryId, 'geometry', 'components.mesh.geometryId');
  add(mesh.materialId, 'material', 'components.mesh.materialId');
  for (const id of mesh.materialIds ?? []) add(id, 'material', 'components.mesh.materialIds');
  add(components.animation?.actionId, 'animation', 'components.animation.actionId');
  add(components.prefab?.prefabId, 'prefab', 'components.prefab.prefabId');
  add(components.audio?.audioId, 'audio', 'components.audio.audioId');
  add(components.light?.targetId, 'lightTarget', 'components.light.targetId');
  for (const constraint of components.constraints ?? []) add(constraint?.targetId, 'constraintTarget', 'components.constraints.targetId');
  return references;
}
