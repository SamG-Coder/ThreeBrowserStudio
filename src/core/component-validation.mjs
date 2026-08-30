import { isStableId } from './ids.mjs';
import { MAX_MATERIAL_SLOTS_PER_MESH } from './constants.mjs';
import { normalizeModifierDocument } from './modifier-stack.mjs';
import { isPlainRecord } from './util.mjs';

export const RUNTIME_MODIFIER_TYPES = Object.freeze(['array', 'mirror', 'pattern']);
export const RUNTIME_CONSTRAINT_TYPES = Object.freeze([
  'lookAt', 'trackTo', 'copyLocation', 'copyRotation', 'copyScale', 'limitLocation',
]);

const vector3 = value => Array.isArray(value)
  && value.length === 3
  && value.every(number => Number.isFinite(number));

const controllerKey = value => typeof value === 'string'
  && value.length >= 1
  && value.length <= 64
  && /^[A-Za-z0-9]+$/u.test(value);

function diagnostic(diagnostics, code, path, message) {
  diagnostics.push({ severity: 'error', code, path, message });
}

function validateModifier(modifier, index, path, diagnostics, ids) {
  const at = `${path}.modifiers.${index}`;
  if (!isPlainRecord(modifier)) {
    diagnostic(diagnostics, 'invalid_modifier', at, 'Modifier must be an object');
    return;
  }
  try {
    // Format-v1 projects historically accepted arbitrary modifier types. Keep
    // those documents loadable as explicit bake-required boundaries; ordinary
    // authoring operations still validate newly supplied modifiers strictly.
    normalizeModifierDocument(modifier, { allowLegacyUnknown: true });
  } catch (error) {
    diagnostic(diagnostics, error.code ?? 'invalid_modifier', at, error.message);
    return;
  }
  if (ids.has(modifier.id)) diagnostic(diagnostics, 'duplicate_modifier_id', `${at}.id`, `Duplicate modifier ID ${modifier.id}`);
  else ids.add(modifier.id);
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

function validateMeshComponent(mesh, path, diagnostics) {
  const at = `${path}.components.mesh`;
  if (!isPlainRecord(mesh)) {
    diagnostic(diagnostics, 'invalid_mesh_component', at, 'mesh must be an object');
    return;
  }
  if (mesh.geometryId !== undefined && !isStableId(mesh.geometryId)) {
    diagnostic(diagnostics, 'invalid_mesh_geometry', `${at}.geometryId`, 'geometryId must be a stable ID');
  }
  const hasMaterialId = Object.hasOwn(mesh, 'materialId');
  const hasMaterialIds = Object.hasOwn(mesh, 'materialIds');
  if (hasMaterialId && hasMaterialIds) {
    diagnostic(diagnostics, 'ambiguous_mesh_materials', at, 'Use materialId or materialIds, not both');
  }
  if (hasMaterialId && !isStableId(mesh.materialId)) {
    diagnostic(diagnostics, 'invalid_mesh_material', `${at}.materialId`, 'materialId must be a stable ID');
  }
  if (hasMaterialIds) {
    if (!Array.isArray(mesh.materialIds) || mesh.materialIds.length > MAX_MATERIAL_SLOTS_PER_MESH) {
      diagnostic(
        diagnostics,
        'invalid_mesh_materials',
        `${at}.materialIds`,
        `materialIds must be an array with at most ${MAX_MATERIAL_SLOTS_PER_MESH} entries`,
      );
    } else {
      mesh.materialIds.forEach((materialId, index) => {
        if (!isStableId(materialId)) {
          diagnostic(diagnostics, 'invalid_mesh_material', `${at}.materialIds.${index}`, 'Each materialIds entry must be a stable ID');
        }
      });
    }
  }
}

function validateLogicComponent(logic, path, diagnostics) {
  const at = `${path}.components.logic`;
  if (!isPlainRecord(logic)) {
    diagnostic(diagnostics, 'invalid_logic_component', at, 'logic must be an object');
    return;
  }
  if (logic.enabled !== undefined && typeof logic.enabled !== 'boolean') {
    diagnostic(diagnostics, 'invalid_logic_enabled', `${at}.enabled`, 'enabled must be boolean');
  }
  if (!Array.isArray(logic.graphIds) || logic.graphIds.length < 1 || logic.graphIds.length > 16) {
    diagnostic(diagnostics, 'invalid_logic_graphs', `${at}.graphIds`, 'graphIds must contain 1 to 16 graph IDs');
    return;
  }
  if (new Set(logic.graphIds).size !== logic.graphIds.length || logic.graphIds.some(id => !isStableId(id))) {
    diagnostic(diagnostics, 'invalid_logic_graphs', `${at}.graphIds`, 'graphIds must contain unique stable IDs');
  }
}

function boundedNumber(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function booleanVector3(value) {
  return Array.isArray(value) && value.length === 3 && value.every(item => typeof item === 'boolean');
}

function validateRigidBodyComponent(body, path, diagnostics) {
  const at = `${path}.components.rigidBody`;
  if (!isPlainRecord(body)) {
    diagnostic(diagnostics, 'invalid_rigid_body', at, 'rigidBody must be an object');
    return;
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') diagnostic(diagnostics, 'invalid_rigid_body_enabled', `${at}.enabled`, 'enabled must be boolean');
  if (body.bodyType !== undefined && !['dynamic', 'kinematic', 'static'].includes(body.bodyType)) diagnostic(diagnostics, 'invalid_rigid_body_type', `${at}.bodyType`, 'bodyType must be dynamic, kinematic, or static');
  if (body.mass !== undefined && !boundedNumber(body.mass, 0.0001, 1_000_000)) diagnostic(diagnostics, 'invalid_rigid_body_mass', `${at}.mass`, 'mass must be from 0.0001 to 1000000');
  for (const key of ['linearDamping', 'angularDamping']) {
    if (body[key] !== undefined && !boundedNumber(body[key], 0, 100)) diagnostic(diagnostics, 'invalid_rigid_body_damping', `${at}.${key}`, `${key} must be from 0 to 100`);
  }
  if (body.gravityScale !== undefined && !boundedNumber(body.gravityScale, -100, 100)) diagnostic(diagnostics, 'invalid_gravity_scale', `${at}.gravityScale`, 'gravityScale must be from -100 to 100');
  if (body.maxLinearSpeed !== undefined && !boundedNumber(body.maxLinearSpeed, 0.1, 1_000)) diagnostic(diagnostics, 'invalid_max_linear_speed', `${at}.maxLinearSpeed`, 'maxLinearSpeed must be from 0.1 to 1000');
  if (body.wheelBase !== undefined && !boundedNumber(body.wheelBase, 0.1, 100)) diagnostic(diagnostics, 'invalid_vehicle_wheel_base', `${at}.wheelBase`, 'wheelBase must be from 0.1 to 100');
  if (body.steeringWheelIds !== undefined && (!Array.isArray(body.steeringWheelIds) || body.steeringWheelIds.length > 8 || new Set(body.steeringWheelIds).size !== body.steeringWheelIds.length || body.steeringWheelIds.some(id => !isStableId(id)))) diagnostic(diagnostics, 'invalid_steering_wheel_ids', `${at}.steeringWheelIds`, 'steeringWheelIds must contain up to eight unique stable entity IDs');
  for (const key of ['velocity', 'angularVelocity']) {
    if (body[key] !== undefined && !vector3(body[key])) diagnostic(diagnostics, 'invalid_rigid_body_velocity', `${at}.${key}`, `${key} must contain three finite numbers`);
  }
  for (const key of ['freezePosition', 'freezeRotation']) {
    if (body[key] !== undefined && !booleanVector3(body[key])) diagnostic(diagnostics, 'invalid_rigid_body_constraints', `${at}.${key}`, `${key} must contain three booleans`);
  }
}

function validateColliderComponent(collider, path, diagnostics) {
  const at = `${path}.components.collider`;
  if (!isPlainRecord(collider)) {
    diagnostic(diagnostics, 'invalid_collider', at, 'collider must be an object');
    return;
  }
  if (collider.enabled !== undefined && typeof collider.enabled !== 'boolean') diagnostic(diagnostics, 'invalid_collider_enabled', `${at}.enabled`, 'enabled must be boolean');
  if (!['box', 'sphere'].includes(collider.shape)) diagnostic(diagnostics, 'invalid_collider_shape', `${at}.shape`, 'shape must be box or sphere');
  if (collider.offset !== undefined && !vector3(collider.offset)) diagnostic(diagnostics, 'invalid_collider_offset', `${at}.offset`, 'offset must contain three finite numbers');
  if (collider.shape === 'box' && (!vector3(collider.size) || collider.size.some(value => value <= 0 || value > 1_000_000))) diagnostic(diagnostics, 'invalid_collider_size', `${at}.size`, 'box size must contain three positive bounded numbers');
  if (collider.shape === 'sphere' && !boundedNumber(collider.radius, 0.0001, 1_000_000)) diagnostic(diagnostics, 'invalid_collider_radius', `${at}.radius`, 'sphere radius must be from 0.0001 to 1000000');
  for (const key of ['friction', 'restitution']) {
    if (collider[key] !== undefined && !boundedNumber(collider[key], 0, 1)) diagnostic(diagnostics, 'invalid_collider_material', `${at}.${key}`, `${key} must be from 0 to 1`);
  }
  if (collider.isTrigger !== undefined && typeof collider.isTrigger !== 'boolean') diagnostic(diagnostics, 'invalid_collider_trigger', `${at}.isTrigger`, 'isTrigger must be boolean');
  if (collider.layer !== undefined && (!Number.isInteger(collider.layer) || collider.layer < 0 || collider.layer > 31)) diagnostic(diagnostics, 'invalid_collider_layer', `${at}.layer`, 'layer must be an integer from 0 to 31');
  if (collider.mask !== undefined && (!Number.isInteger(collider.mask) || collider.mask < 0 || collider.mask > 1_000_000_000)) diagnostic(diagnostics, 'invalid_collider_mask', `${at}.mask`, 'mask must be an MCP-safe integer from 0 to 1000000000');
}

export function validateScenePhysicsSettings(physics, path, diagnostics) {
  if (physics === undefined || physics === null) return;
  if (!isPlainRecord(physics)) {
    diagnostic(diagnostics, 'invalid_physics_settings', path, 'physics must be an object or null');
    return;
  }
  if (physics.enabled !== undefined && typeof physics.enabled !== 'boolean') diagnostic(diagnostics, 'invalid_physics_enabled', `${path}.enabled`, 'enabled must be boolean');
  if (physics.gravity !== undefined && !vector3(physics.gravity)) diagnostic(diagnostics, 'invalid_physics_gravity', `${path}.gravity`, 'gravity must contain three finite numbers');
}

export function validateSceneControllerSettings(controller, path, diagnostics) {
  if (controller === undefined || controller === null) return;
  if (!isPlainRecord(controller)) {
    diagnostic(diagnostics, 'invalid_controller', path, 'controller must be an object or null');
    return;
  }
  if (controller.enabled !== undefined && typeof controller.enabled !== 'boolean') {
    diagnostic(diagnostics, 'invalid_controller_enabled', `${path}.enabled`, 'enabled must be boolean');
  }
  if (!isStableId(controller.entityId)) {
    diagnostic(diagnostics, 'invalid_controller_entity', `${path}.entityId`, 'entityId must be a stable entity ID');
  }
  if (controller.activationKey !== undefined && !controllerKey(controller.activationKey)) {
    diagnostic(diagnostics, 'invalid_controller_key', `${path}.activationKey`, 'activationKey must be a bounded keyboard code');
  }
  if (controller.activationKey === 'Escape') {
    diagnostic(diagnostics, 'reserved_controller_key', `${path}.activationKey`, 'Escape is globally reserved for leaving Control mode');
  }
  if (controller.restoreOnExit !== undefined && typeof controller.restoreOnExit !== 'boolean') {
    diagnostic(diagnostics, 'invalid_controller_restore', `${path}.restoreOnExit`, 'restoreOnExit must be boolean');
  }
  if (controller.capture !== undefined) {
    if (!isPlainRecord(controller.capture)) {
      diagnostic(diagnostics, 'invalid_controller_capture', `${path}.capture`, 'capture must be an object');
    } else {
      for (const key of ['keyboard', 'pointer', 'hideHud', 'hideCursor']) {
        if (controller.capture[key] !== undefined && typeof controller.capture[key] !== 'boolean') {
          diagnostic(diagnostics, 'invalid_controller_capture', `${path}.capture.${key}`, `${key} must be boolean`);
        }
      }
    }
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
  if (components.mesh !== undefined) validateMeshComponent(components.mesh, path, diagnostics);
  if (components.logic !== undefined) validateLogicComponent(components.logic, path, diagnostics);
  if (components.rigidBody !== undefined) validateRigidBodyComponent(components.rigidBody, path, diagnostics);
  if (components.collider !== undefined) validateColliderComponent(components.collider, path, diagnostics);
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
  const mesh = isPlainRecord(components.mesh) ? components.mesh : {};
  add(mesh.geometryId, 'geometry', 'components.mesh.geometryId');
  add(mesh.materialId, 'material', 'components.mesh.materialId');
  if (Array.isArray(mesh.materialIds)) {
    mesh.materialIds.forEach((id, index) => add(id, 'material', `components.mesh.materialIds.${index}`));
  }
  add(components.animation?.actionId, 'animation', 'components.animation.actionId');
  add(components.prefab?.prefabId, 'prefab', 'components.prefab.prefabId');
  add(components.audio?.audioId, 'audio', 'components.audio.audioId');
  for (const graphId of components.logic?.graphIds ?? []) add(graphId, 'logicGraph', 'components.logic.graphIds');
  add(components.light?.targetId, 'lightTarget', 'components.light.targetId');
  for (const constraint of components.constraints ?? []) add(constraint?.targetId, 'constraintTarget', 'components.constraints.targetId');
  for (const modifier of components.modifiers ?? []) {
    if (modifier?.type === 'pattern' && modifier.mode === 'surface') {
      add(modifier.targetEntityId, 'surfaceTarget', 'components.modifiers.targetEntityId');
    }
  }
  return references;
}
