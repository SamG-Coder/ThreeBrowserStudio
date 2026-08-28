import { createFallbackMaterial, createGeometry, createMaterial, ensureGeneratedCoordinateAttribute } from './resource-factories.mjs';
import { applyConstraintStacks, evaluateInstanceStack } from './object-evaluation.mjs';
import { createAnimationRuntime, validateAnimationResource } from './animation-runtime.mjs';

function colorFrom(THREE, value, fallback = [0.035, 0.045, 0.06]) {
  const color = new THREE.Color();
  if (Array.isArray(value) && value.length >= 3) color.setRGB(value[0], value[1], value[2]);
  else if (typeof value === 'number' || typeof value === 'string') color.set(value);
  else color.setRGB(...fallback);
  return color;
}

function applyTransform(object, transform = {}) {
  object.position.fromArray(transform.position ?? [0, 0, 0]);
  object.rotation.fromArray(transform.rotation ?? [0, 0, 0]);
  object.scale.fromArray(transform.scale ?? [1, 1, 1]);
  object.updateMatrix?.();
}

function cameraFor(THREE, entity, aspect) {
  const values = entity.components?.camera ?? {};
  if (entity.kind === 'orthographicCamera') {
    const height = Number.isFinite(values.height) ? values.height : 10;
    const halfHeight = height * 0.5;
    const halfWidth = halfHeight * aspect;
    return new THREE.OrthographicCamera(
      values.left ?? -halfWidth,
      values.right ?? halfWidth,
      values.top ?? halfHeight,
      values.bottom ?? -halfHeight,
      values.near ?? 0.05,
      values.far ?? 2000,
    );
  }
  const camera = new THREE.PerspectiveCamera(values.fov ?? 46, values.aspect ?? aspect, values.near ?? 0.05, values.far ?? 2000);
  if (Number.isFinite(values.focalLength) && typeof camera.setFocalLength === 'function') camera.setFocalLength(values.focalLength);
  if (Number.isFinite(values.focus) && 'focus' in camera) camera.focus = values.focus;
  if (Number.isFinite(values.zoom)) camera.zoom = values.zoom;
  camera.updateProjectionMatrix?.();
  return camera;
}

function lightFor(THREE, entity) {
  const values = entity.components?.light ?? {};
  const color = colorFrom(THREE, values.color, [1, 1, 1]);
  switch (entity.kind) {
    case 'ambientLight': return new THREE.AmbientLight(color, values.intensity ?? 1);
    case 'hemisphereLight': return new THREE.HemisphereLight(
      color,
      colorFrom(THREE, values.groundColor, [0.12, 0.1, 0.08]),
      values.intensity ?? 1,
    );
    case 'directionalLight': return new THREE.DirectionalLight(color, values.intensity ?? 3);
    case 'pointLight': return new THREE.PointLight(color, values.intensity ?? 10, values.distance ?? 0, values.decay ?? 2);
    case 'spotLight': return new THREE.SpotLight(color, values.intensity ?? 10, values.distance ?? 0, values.angle ?? Math.PI / 3, values.penumbra ?? 0, values.decay ?? 2);
    case 'areaLight': return THREE.RectAreaLight
      ? new THREE.RectAreaLight(color, values.intensity ?? 10, values.width ?? 1, values.height ?? 1)
      : null;
    default: return null;
  }
}

function applyShadowSettings(object, values = {}) {
  if (!('castShadow' in object)) return;
  object.castShadow = values.castShadow ?? true;
  if (!object.shadow) return;
  const size = Math.min(2048, Math.max(256, Math.trunc(values.shadowMapSize ?? 1024)));
  object.shadow.mapSize?.set?.(size, size);
  object.shadow.bias = values.shadowBias ?? object.shadow.bias;
  object.shadow.normalBias = values.shadowNormalBias ?? object.shadow.normalBias;
  const camera = object.shadow.camera;
  if (camera && values.shadowCamera) {
    for (const key of ['near', 'far', 'left', 'right', 'top', 'bottom']) {
      if (Number.isFinite(values.shadowCamera[key]) && key in camera) camera[key] = values.shadowCamera[key];
    }
    camera.updateProjectionMatrix?.();
  }
}

function compileError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canonicalEntities(document) {
  const ordered = [];
  const visited = new Set();
  const visit = id => {
    if (visited.has(id)) return;
    const entity = document.entities?.[id];
    if (!entity) return;
    visited.add(id);
    ordered.push(entity);
    for (const childId of entity.children ?? []) visit(childId);
  };
  for (const rootId of document.rootEntityIds ?? []) visit(rootId);
  for (const id of Object.keys(document.entities ?? {}).sort()) visit(id);
  return ordered;
}

function instantiateEntity(THREE, entity, context) {
  const meshValues = entity.components?.mesh ?? {};
  let object;
  if (entity.kind === 'mesh' || entity.kind === 'instancedMesh') {
    const materialIds = meshValues.materialIds ?? (meshValues.materialId ? [meshValues.materialId] : []);
    if (materialIds.length > 1) {
      throw compileError(
        'runtime_multi_material_unsupported',
        `Entity ${entity.id} uses ${materialIds.length} materials; the lean runtime currently supports one material per mesh.`,
      );
    }
    const requestedCount = Math.min(8192, Math.max(1, Math.trunc(Number(meshValues.count ?? 1) || 1)));
    const hasAuthoredInstances = Array.isArray(meshValues.instances) && meshValues.instances.length > 0;
    if (entity.kind === 'instancedMesh' && requestedCount > 1 && !hasAuthoredInstances) {
      throw compileError(
        'runtime_instancing_unsupported',
        `Entity ${entity.id} requests ${requestedCount} instances but does not provide mesh.instances transforms.`,
      );
    }
    const geometry = context.geometry(meshValues.geometryId);
    const materials = materialIds.map(context.material).filter(Boolean);
    const material = materials[0] ?? context.fallbackMaterial();
    const instanceMatrices = evaluateInstanceStack(THREE, entity, context.diagnostics);
    const shouldInstance = entity.kind === 'instancedMesh' || instanceMatrices.length > 1 || hasAuthoredInstances;
    if (shouldInstance) {
      object = new THREE.InstancedMesh(geometry, material, instanceMatrices.length);
      if (typeof object.setMatrixAt === 'function') {
        instanceMatrices.forEach((matrix, index) => object.setMatrixAt(index, matrix));
        if (object.instanceMatrix) object.instanceMatrix.needsUpdate = true;
      }
    } else object = new THREE.Mesh(geometry, material);
    object.castShadow = meshValues.castShadow ?? true;
    object.receiveShadow = meshValues.receiveShadow ?? true;
  } else if (entity.kind === 'perspectiveCamera' || entity.kind === 'orthographicCamera') {
    object = cameraFor(THREE, entity, context.aspect);
  } else {
    object = lightFor(THREE, entity);
    if (!object && ['scene', 'group', 'empty', 'gameObject'].includes(entity.kind)) object = new THREE.Group();
    if (!object) throw new Error(`Entity kind ${entity.kind} is not compiled by the lean runtime yet.`);
    if (object.isLight) {
      const lightValues = entity.components?.light ?? {};
      if (object.shadow && lightValues.castShadow !== false) {
        if (context.shadowLights.count >= context.shadowLights.limit) {
          throw compileError(
            'runtime_shadow_budget_exceeded',
            `Scene exceeds the ${context.shadowLights.limit} shadow-light budget.`,
          );
        }
        context.shadowLights.count += 1;
      }
      applyShadowSettings(object, lightValues);
    }
  }
  object.name = entity.name;
  object.visible = entity.visible;
  object.userData = {
    ...(object.userData ?? {}),
    studioEntityId: entity.id,
    studioKind: entity.kind,
    tags: [...(entity.tags ?? [])],
  };
  applyTransform(object, entity.transform);
  if (entity.kind === 'hemisphereLight' && object.position?.lengthSq?.() < 1e-12) {
    object.position.set(0, 1, 0);
    context.diagnostics.push({
      severity: 'warning',
      code: 'runtime_hemisphere_direction_defaulted',
      id: entity.id,
      message: 'Hemisphere light had a zero direction; runtime defaulted it to world up.',
    });
    object.updateMatrix?.();
  }
  return object;
}

function sceneAppearance(THREE, _TSL, settings = {}) {
  let background = null;
  let backgroundNode = null;
  if (settings.background?.mode === 'color') {
    background = colorFrom(THREE, settings.background.color);
    // The native WebGPU output pass preserves swapchain transparency and does
    // not guarantee that an attachment clear becomes an output fragment.
    // An authored scene colour therefore needs an opaque background node so
    // both the persistent viewport and evidence target receive RGBA colour.
    if (typeof _TSL?.vec4 === 'function') {
      backgroundNode = _TSL.vec4(background.r, background.g, background.b, 1);
    }
  }
  let fog = null;
  if (settings.fog?.mode === 'exp2') fog = new THREE.FogExp2(colorFrom(THREE, settings.fog.color), settings.fog.density ?? 0.01);
  if (settings.fog?.mode === 'linear') fog = new THREE.Fog(colorFrom(THREE, settings.fog.color), settings.fog.near ?? 10, settings.fog.far ?? 1000);
  return { background, backgroundNode, fog };
}

/**
 * Compiles a canonical Studio scene into an isolated Three.js subtree. Nothing
 * is attached to the live viewport until the caller swaps this result.
 */
export function compileSceneDocument({ THREE, TSL, project, sceneId = project.activeSceneId, aspect = 16 / 9 }) {
  const document = project.scenes?.[sceneId];
  if (!document) throw new Error(`Scene ${sceneId} does not exist.`);
  const diagnostics = [];
  const geometries = new Map();
  const materials = new Map();
  let fallback = null;
  const geometry = id => {
    if (geometries.has(id)) return geometries.get(id);
    const resource = project.resources?.geometries?.[id];
    if (!resource) throw new Error(`Geometry resource ${id} does not exist.`);
    const value = ensureGeneratedCoordinateAttribute(THREE, createGeometry(THREE, resource));
    value.name = resource.name ?? id;
    value.userData = { ...(value.userData ?? {}), studioResourceId: id };
    geometries.set(id, value);
    return value;
  };
  const material = id => {
    if (!id) return null;
    if (materials.has(id)) return materials.get(id);
    const resource = project.resources?.materials?.[id];
    if (!resource) throw new Error(`Material resource ${id} does not exist.`);
    const value = createMaterial(THREE, resource, {
      TSL,
      graphs: project.resources?.graphs ?? {},
    });
    materials.set(id, value);
    return value;
  };
  const fallbackMaterial = () => {
    fallback ??= createFallbackMaterial(THREE);
    return fallback;
  };

  const root = new THREE.Group();
  root.name = document.name;
  root.userData = { studioSceneId: document.id, studioRevision: project.revision };
  const objects = new Map();
  const entities = canonicalEntities(document);
  const shadowLights = { count: 0, limit: 16 };
  for (const entity of entities) {
    try {
      objects.set(entity.id, instantiateEntity(THREE, entity, {
        geometry,
        material,
        fallbackMaterial,
        aspect,
        shadowLights,
        diagnostics,
      }));
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        code: error.code ?? 'runtime_compile_failed',
        id: entity.id,
        message: error.message,
      });
    }
  }
  const attached = new Set();
  const attach = (parent, entityId) => {
    if (attached.has(entityId)) return;
    const entity = document.entities?.[entityId];
    const object = objects.get(entityId);
    if (!entity || !object) return;
    attached.add(entityId);
    parent.add(object);
    for (const childId of entity.children ?? []) attach(object, childId);
  };
  for (const rootId of document.rootEntityIds ?? []) attach(root, rootId);
  for (const entity of entities) {
    const object = objects.get(entity.id);
    const targetId = entity.components?.light?.targetId;
    if (object?.isLight && targetId && objects.has(targetId) && 'target' in object) object.target = objects.get(targetId);
  }
  root.updateMatrixWorld?.(true);
  const animationResources = [];
  for (const resource of Object.values(project.resources?.animations ?? {})) {
    const validation = validateAnimationResource(resource);
    if (!validation.valid) {
      diagnostics.push(...validation.diagnostics.map(item => ({
        ...item,
        severity: 'error',
        resourceId: resource.id,
      })));
      continue;
    }
    const targetIds = [...new Set(validation.action.tracks.map(track => track.targetId))];
    const presentTargets = targetIds.filter(id => objects.has(id));
    if (presentTargets.length > 0 && presentTargets.length !== targetIds.length) {
      diagnostics.push({
        severity: 'error',
        code: 'animation_cross_scene_targets',
        resourceId: resource.id,
        message: `Animation ${resource.id} mixes targets from different scenes.`,
      });
      continue;
    }
    if (presentTargets.length > 0) animationResources.push(validation.action);
  }
  let animationRuntime = null;
  try {
    animationRuntime = createAnimationRuntime({ objects, actions: animationResources });
  } catch (error) {
    const animationDiagnostics = error.diagnostics ?? [{
      severity: 'error',
      code: error.code ?? 'animation_compile_failed',
      message: error.message,
    }];
    diagnostics.push(...animationDiagnostics.map(item => ({ ...item, severity: 'error' })));
  }
  const timeline = document.settings?.timeline ?? {};
  const timelineFps = Number.isFinite(timeline.framesPerSecond) ? timeline.framesPerSecond : 24;
  const initialAnimationTime = ((timeline.currentFrame ?? timeline.frameStart ?? 1) - (timeline.frameStart ?? 1)) / timelineFps;
  let animationTime = initialAnimationTime;
  const authoredPose = new Map(entities.map(entity => [entity.id, {
    transform: entity.transform,
    visible: entity.visible,
  }]));
  const restoreAuthoredPose = () => {
    for (const [id, pose] of authoredPose) {
      const object = objects.get(id);
      if (!object) continue;
      applyTransform(object, pose.transform);
      object.visible = pose.visible;
    }
  };
  let reportConstraintDiagnostics = true;
  const evaluateConstraints = () => {
    root.updateMatrixWorld?.(true);
    applyConstraintStacks(THREE, entities, objects, reportConstraintDiagnostics ? diagnostics : []);
    reportConstraintDiagnostics = false;
  };
  restoreAuthoredPose();
  if (animationRuntime) animationRuntime.setTime(animationTime);
  evaluateConstraints();
  const appearance = sceneAppearance(THREE, TSL, document.settings);
  const activeCamera = objects.get(document.settings?.activeCameraId) ?? null;
  const ownedMaterials = new Set([...materials.values(), ...(fallback ? [fallback] : [])]);
  const ownedDisposableObjects = new Set(
    [...objects.values()].filter(value => value.isLight || value.isInstancedMesh),
  );
  let disposed = false;
  return {
    root,
    objects,
    activeCamera,
    background: appearance.background,
    backgroundNode: appearance.backgroundNode,
    fog: appearance.fog,
    diagnostics,
    animationRuntime,
    get animationTime() { return animationTime; },
    animationActions: animationRuntime ? [...animationRuntime.actions.keys()] : [],
    setAnimationTime(timeSeconds) {
      if (!animationRuntime) return [];
      animationTime = timeSeconds;
      restoreAuthoredPose();
      const evaluations = animationRuntime.setTime(timeSeconds);
      evaluateConstraints();
      return evaluations;
    },
    advanceAnimation(deltaSeconds) {
      if (!animationRuntime) return [];
      animationTime += deltaSeconds;
      restoreAuthoredPose();
      const evaluations = animationRuntime.advance(deltaSeconds);
      evaluateConstraints();
      return evaluations;
    },
    animationStates() {
      if (!animationRuntime) return [];
      return [...animationRuntime.actions.keys()].map(id => animationRuntime.getState(id));
    },
    revision: project.revision,
    sceneId: document.id,
    dispose() {
      if (disposed) return;
      disposed = true;
      root.removeFromParent();
      root.clear();
      for (const value of ownedDisposableObjects) value.dispose?.();
      for (const value of geometries.values()) value.dispose?.();
      for (const value of ownedMaterials) value.dispose?.();
      ownedDisposableObjects.clear();
      ownedMaterials.clear();
      geometries.clear();
      materials.clear();
      objects.clear();
      authoredPose.clear();
      appearance.backgroundNode?.dispose?.();
      animationRuntime?.actions.clear();
      animationRuntime?.states.clear();
      animationRuntime = null;
    },
  };
}
