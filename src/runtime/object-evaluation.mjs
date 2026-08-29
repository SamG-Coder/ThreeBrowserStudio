import { RUNTIME_CONSTRAINT_TYPES, RUNTIME_MODIFIER_TYPES } from '../core/component-validation.mjs';
import { isGeometryModifierType } from '../core/geometry-modifier-evaluator.mjs';
import { MAX_LAYOUT_PATTERN_INSTANCES, normalizeLayoutPattern } from '../core/layout-patterns.mjs';

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

function patternTransformMatrix(THREE, position, axis, angle) {
  const translation = new THREE.Matrix4().makeTranslation(...position);
  if (angle === null) return translation;
  const rotation = new THREE.Matrix4();
  if (axis === 'x') rotation.makeRotationX(angle);
  else if (axis === 'y') rotation.makeRotationY(angle);
  else rotation.makeRotationZ(angle);
  return multiply(translation, rotation);
}

function patternAngle(pattern, index) {
  if (pattern.count <= 1) return pattern.startAngle;
  const denominator = pattern.closed ? pattern.count : pattern.count - 1;
  return pattern.startAngle + pattern.arc * index / denominator;
}

function radialPosition(pattern, angle) {
  const cosine = Math.cos(angle) * pattern.radius;
  const sine = Math.sin(angle) * pattern.radius;
  const [x, y, z] = pattern.center;
  if (pattern.axis === 'x') return [x, y + cosine, z + sine];
  if (pattern.axis === 'y') return [x + cosine, y, z - sine];
  return [x + cosine, y + sine, z];
}

function scatterUnit(seed, index, channel) {
  // Fixed integer channels make the layout independent of iteration order.
  // Keep these constants and channel assignments stable: they are part of the
  // canonical seeded-scatter result, not an implementation detail.
  let value = (seed >>> 0)
    ^ Math.imul((index + 1) >>> 0, 0x9e3779b1)
    ^ Math.imul((channel + 1) >>> 0, 0x85ebca77);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x1_0000_0000;
}

function sampleScatterVector(seed, index, channelOffset, minimum, maximum) {
  return minimum.map((value, component) => (
    value + (maximum[component] - value) * scatterUnit(seed, index, channelOffset + component)
  ));
}

function scatterTransformMatrix(THREE, position, rotation, scale) {
  const matrix = new THREE.Matrix4().makeTranslation(...position);
  const rotations = [
    ['makeRotationX', rotation[0]],
    ['makeRotationY', rotation[1]],
    ['makeRotationZ', rotation[2]],
  ];
  for (const [method, angle] of rotations) {
    if (angle === 0) continue;
    const rotationMatrix = new THREE.Matrix4();
    if (typeof rotationMatrix[method] === 'function') matrix.multiply(rotationMatrix[method](angle));
  }
  if (scale.some(value => value !== 1)) {
    matrix.multiply(new THREE.Matrix4().makeScale(...scale));
  }
  return matrix;
}

function scatterMatrices(THREE, pattern) {
  return Array.from({ length: pattern.count }, (_, index) => {
    const position = sampleScatterVector(pattern.seed, index, 0, pattern.bounds.min, pattern.bounds.max);
    const rotation = sampleScatterVector(pattern.seed, index, 3, pattern.rotationMin, pattern.rotationMax);
    const scale = sampleScatterVector(pattern.seed, index, 6, pattern.scaleMin, pattern.scaleMax);
    return scatterTransformMatrix(THREE, position, rotation, scale);
  });
}

function patternMatrices(THREE, authoredPattern) {
  const pattern = normalizeLayoutPattern(authoredPattern, { modifier: true });
  if (pattern.mode === 'linear') {
    return Array.from({ length: pattern.count }, (_, index) => patternTransformMatrix(
      THREE,
      pattern.offset.map(value => value * index),
      'x',
      null,
    ));
  }
  if (pattern.mode === 'grid') {
    const matrices = [];
    for (let z = 0; z < pattern.counts[2]; z += 1) {
      for (let y = 0; y < pattern.counts[1]; y += 1) {
        for (let x = 0; x < pattern.counts[0]; x += 1) {
          matrices.push(patternTransformMatrix(THREE, [
            x * pattern.spacing[0],
            y * pattern.spacing[1],
            z * pattern.spacing[2],
          ], 'x', null));
        }
      }
    }
    return matrices;
  }
  if (pattern.mode === 'scatter') return scatterMatrices(THREE, pattern);
  return Array.from({ length: pattern.count }, (_, index) => {
    const angle = patternAngle(pattern, index);
    const orientationAngle = pattern.orientation === 'keep'
      ? null
      : angle + (pattern.orientation === 'tangent' ? Math.PI * 0.5 : 0);
    return patternTransformMatrix(THREE, radialPosition(pattern, angle), pattern.axis, orientationAngle);
  });
}

/**
 * Lowers the executable subset of Blender's ordered modifier stack to instance
 * matrices. Base geometry remains untouched, so the authored operation is
 * non-destructive and can be reordered or removed.
 */
export function evaluateInstanceStack(THREE, entity, diagnostics = [], modifierOverride) {
  const mesh = entity.components?.mesh ?? {};
  let matrices = Array.isArray(mesh.instances) && mesh.instances.length
    ? mesh.instances.slice(0, 8192).map(value => transformMatrix(THREE, value))
    : [new THREE.Matrix4()];
  for (const modifier of modifierOverride ?? entity.components?.modifiers ?? []) {
    if (modifier.enabled === false || modifier.enabledViewport === false || modifier.showViewport === false) continue;
    if (isGeometryModifierType(modifier.type)) continue;
    if (!RUNTIME_MODIFIER_TYPES.includes(modifier.type)) {
      const error = new Error(
        `Modifier ${modifier.id} (${modifier.type}) has no deterministic viewport evaluator and must be baked.`,
      );
      error.code = 'runtime_modifier_bake_required';
      error.entityId = entity.id;
      error.modifierId = modifier.id;
      throw error;
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
    } else if (modifier.type === 'pattern') {
      let generated;
      try {
        generated = patternMatrices(THREE, modifier);
      } catch (error) {
        diagnostics.push(warning(
          error.code ?? 'runtime_layout_pattern_invalid',
          entity.id,
          `Pattern ${modifier.id} could not be evaluated: ${error.message}`,
        ));
        continue;
      }
      const requested = matrices.length * generated.length;
      const expanded = [];
      for (const base of matrices) {
        for (const instance of generated) {
          if (expanded.length >= MAX_LAYOUT_PATTERN_INSTANCES) break;
          expanded.push(multiply(base, instance));
        }
        if (expanded.length >= MAX_LAYOUT_PATTERN_INSTANCES) break;
      }
      if (requested > MAX_LAYOUT_PATTERN_INSTANCES) {
        diagnostics.push(warning(
          'runtime_instance_budget_truncated',
          entity.id,
          `Pattern ${modifier.id} requested ${requested} instances; runtime kept ${MAX_LAYOUT_PATTERN_INSTANCES}.`,
        ));
      }
      matrices = expanded;
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
