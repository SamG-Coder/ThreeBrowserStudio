import { RUNTIME_CONSTRAINT_TYPES, RUNTIME_MODIFIER_TYPES } from '../core/component-validation.mjs';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function warning(code, id, message) {
  return { severity: 'warning', code, id, message };
}

function transformMatrix(THREE, transform = {}) {
  const matrix = new THREE.Matrix4();
  const position = transform.position ?? [0, 0, 0];
  const rotation = transform.rotation ?? [0, 0, 0];
  const scale = transform.scale ?? [1, 1, 1];
  if (THREE.Vector3 && THREE.Euler && THREE.Quaternion && typeof matrix.compose === 'function') {
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation));
    return matrix.compose(new THREE.Vector3(...position), quaternion, new THREE.Vector3(...scale));
  }
  matrix.makeTranslation?.(...position);
  matrix.userData = { position: [...position], rotation: [...rotation], scale: [...scale] };
  return matrix;
}

function multiply(left, right) {
  if (typeof left.clone === 'function') return left.clone().multiply(right);
  return left;
}

/**
 * Lowers the executable subset of Blender's ordered modifier stack to instance
 * matrices. Base geometry remains untouched, so the authored operation is
 * non-destructive and can be reordered or removed.
 */
export function evaluateInstanceStack(THREE, entity, diagnostics = []) {
  const mesh = entity.components?.mesh ?? {};
  let matrices = Array.isArray(mesh.instances) && mesh.instances.length
    ? mesh.instances.slice(0, 8192).map(value => transformMatrix(THREE, value))
    : [new THREE.Matrix4()];
  for (const modifier of entity.components?.modifiers ?? []) {
    if (modifier.enabled === false || modifier.enabledViewport === false) continue;
    if (!RUNTIME_MODIFIER_TYPES.includes(modifier.type)) {
      diagnostics.push(warning(
        'runtime_modifier_bake_required',
        entity.id,
        `Modifier ${modifier.id} (${modifier.type}) is preserved but requires a geometry bake for WebGPU runtime evaluation.`,
      ));
      continue;
    }
    if (modifier.type === 'array') {
      const count = clamp(Math.trunc(modifier.count ?? 1), 1, 256);
      const offset = modifier.offset ?? [1, 0, 0];
      const expanded = [];
      for (const base of matrices) {
        for (let index = 0; index < count && expanded.length < 8192; index += 1) {
          const translation = new THREE.Matrix4().makeTranslation(
            offset[0] * index,
            offset[1] * index,
            offset[2] * index,
          );
          expanded.push(multiply(base, translation));
        }
      }
      matrices = expanded;
    } else if (modifier.type === 'mirror') {
      const axis = modifier.axis ?? 'x';
      const scale = axis === 'x' ? [-1, 1, 1] : axis === 'y' ? [1, -1, 1] : [1, 1, -1];
      const mirrored = new THREE.Matrix4().makeScale(...scale);
      matrices = matrices.flatMap(base => [base, multiply(base, mirrored)]).slice(0, 8192);
    }
  }
  return matrices;
}

function blendVector(owner, target, influence) {
  if (!owner || !target) return;
  if (typeof owner.lerp === 'function') owner.lerp(target, influence);
  else if (typeof owner.copy === 'function' && influence >= 1) owner.copy(target);
  else if (Array.isArray(owner.values) && Array.isArray(target.values)) {
    owner.values = owner.values.map((value, index) => value + (target.values[index] - value) * influence);
  }
}

function valuesOf(vector) {
  if (!vector) return [0, 0, 0];
  if (typeof vector.toArray === 'function') return vector.toArray();
  if (Array.isArray(vector.values)) return vector.values;
  return [vector.x ?? 0, vector.y ?? 0, vector.z ?? 0];
}

function applyLimitLocation(object, constraint) {
  const current = valuesOf(object.position);
  const minimum = constraint.min ?? [-Infinity, -Infinity, -Infinity];
  const maximum = constraint.max ?? [Infinity, Infinity, Infinity];
  const limited = current.map((value, index) => clamp(value, minimum[index], maximum[index]));
  object.position.fromArray?.(limited);
  if (Array.isArray(object.position.values)) object.position.values = limited;
}

function applyLookAt(THREE, object, target) {
  if (typeof object.lookAt !== 'function') return;
  if (typeof target.getWorldPosition === 'function' && THREE.Vector3) {
    object.lookAt(target.getWorldPosition(new THREE.Vector3()));
  } else object.lookAt(...valuesOf(target.position));
}

/** Applies the deterministic, context-free subset of Blender-like constraints. */
export function applyConstraintStacks(THREE, entities, objects, diagnostics = []) {
  for (const entity of entities) {
    const object = objects.get(entity.id);
    if (!object) continue;
    for (const constraint of entity.components?.constraints ?? []) {
      if (constraint.enabled === false || (constraint.influence ?? 1) === 0) continue;
      if (!RUNTIME_CONSTRAINT_TYPES.includes(constraint.type)) {
        diagnostics.push(warning(
          'runtime_constraint_bake_required',
          entity.id,
          `Constraint ${constraint.id} (${constraint.type}) is preserved but requires baking or a future solver.`,
        ));
        continue;
      }
      const target = constraint.targetId ? objects.get(constraint.targetId) : null;
      if (constraint.targetId && !target) {
        diagnostics.push(warning(
          'runtime_constraint_target_missing',
          entity.id,
          `Constraint ${constraint.id} could not resolve target ${constraint.targetId}.`,
        ));
        continue;
      }
      const influence = clamp(constraint.influence ?? 1, 0, 1);
      if (constraint.type === 'lookAt' || constraint.type === 'trackTo') applyLookAt(THREE, object, target);
      else if (constraint.type === 'copyLocation') blendVector(object.position, target?.position, influence);
      else if (constraint.type === 'copyRotation') blendVector(object.rotation, target?.rotation, influence);
      else if (constraint.type === 'copyScale') blendVector(object.scale, target?.scale, influence);
      else if (constraint.type === 'limitLocation') applyLimitLocation(object, constraint);
      object.updateMatrix?.();
      object.updateMatrixWorld?.(true);
    }
  }
}
