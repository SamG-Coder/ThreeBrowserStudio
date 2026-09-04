import {
  createFallbackMaterial,
  createGeometry,
  createMaterial,
  ensureGeneratedCoordinateAttribute,
  indexedMeshRecipeFromBufferGeometry,
  normalizeGeometryRecipe,
} from './resource-factories.mjs';
import { createDataTexture } from './image-texture-resources.mjs';
import { applyConstraintStacks, evaluateInstanceStack } from './object-evaluation.mjs';
import { createAnimationRuntime, validateAnimationResource } from './animation-runtime.mjs';
import {
  GEOMETRY_MODIFIER_LIMITS,
  evaluateGeometryModifierStack,
} from '../core/geometry-modifier-evaluator.mjs';
import { analyzeViewportModifierStack } from '../core/modifier-stack.mjs';
import {
  entityWorldMatrix,
  invertTransformMatrix,
  multiplyTransformMatrices,
  transformPointByMatrix,
} from '../core/transform-math.mjs';
import { normalizeEditableMeshRecipe, triangulateEditableMesh } from '../core/editable-mesh.mjs';
import { createAudioRuntime } from '../audio/audio-runtime.mjs';

const EDITABLE_PRESEAM_MODIFIERS = new Set(['smooth', 'simpleDeform', 'displace']);

function editablePreseamRecipe(sourceRecipe) {
  const mesh = normalizeEditableMeshRecipe(sourceRecipe);
  const triangulated = triangulateEditableMesh(mesh);
  return {
    mesh,
    indexed: {
      kind: 'indexedMesh',
      positions: [...mesh.positions],
      indices: triangulated.sourceCornerIndices.map(cornerIndex => mesh.cornerVertexIndices[cornerIndex]),
    },
  };
}

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
    case 'hemisphereLight': {
      // Authored HemisphereLight objects currently invalidate the shared
      // WebGPU lighting pipeline when they are compiled with project material
      // resources, leaving every lit surface black. Keep the canonical light
      // semantic intact and use a stable ambient approximation at runtime,
      // blending some ground colour into the dominant sky colour.
      const ground = colorFrom(THREE, values.groundColor, [0.12, 0.1, 0.08]);
      const approximationColor = color.clone?.().lerp?.(ground, 0.35) ?? color;
      const light = new THREE.AmbientLight(approximationColor, values.intensity ?? 1);
      light.userData = { studioHemisphereLightApproximation: { groundInfluence: 0.35 } };
      return light;
    }
    case 'directionalLight': return new THREE.DirectionalLight(color, values.intensity ?? 3);
    case 'pointLight': return new THREE.PointLight(color, values.intensity ?? 10, values.distance ?? 0, values.decay ?? 2);
    case 'spotLight': return new THREE.SpotLight(color, values.intensity ?? 10, values.distance ?? 0, values.angle ?? Math.PI / 3, values.penumbra ?? 0, values.decay ?? 2);
    case 'areaLight': {
      // RectAreaLight currently poisons the native WebGPU lighting pipeline and
      // presents every material as black. Preserve the authored area-light
      // entity, but compile a bounded point-light approximation until the
      // native renderer can support the rectangular emitter safely.
      const width = values.width ?? 1;
      const height = values.height ?? 1;
      const light = new THREE.PointLight(
        color,
        values.intensity ?? 10,
        values.distance ?? Math.max(width, height) * 8,
        values.decay ?? 2,
      );
      light.userData = { studioAreaLightApproximation: { width, height } };
      return light;
    }
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

function compileError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function transformSurfaceRecipe(recipe, matrix) {
  const inverse = invertTransformMatrix(matrix);
  const positions = [];
  for (let offset = 0; offset < recipe.positions.length; offset += 3) {
    positions.push(...transformPointByMatrix(matrix, recipe.positions.slice(offset, offset + 3)));
  }
  let normals;
  if (Array.isArray(recipe.normals) && recipe.normals.length === recipe.positions.length) {
    normals = [];
    for (let offset = 0; offset < recipe.normals.length; offset += 3) {
      const [x, y, z] = recipe.normals.slice(offset, offset + 3);
      const transformed = [
        inverse[0] * x + inverse[1] * y + inverse[2] * z,
        inverse[4] * x + inverse[5] * y + inverse[6] * z,
        inverse[8] * x + inverse[9] * y + inverse[10] * z,
      ];
      const magnitude = Math.hypot(...transformed) || 1;
      normals.push(...transformed.map(value => value / magnitude));
    }
  }
  return { ...recipe, positions, ...(normals ? { normals } : {}) };
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

function viewportModifierPlan(entity, sourceKind, diagnostics) {
  const plan = analyzeViewportModifierStack(entity, { sourceKind });
  if (plan.blocked) {
    diagnostics.push({
      severity: 'warning',
      code: plan.blocked.reasonCode,
      id: entity.id,
      modifierId: plan.blocked.modifierId,
      message: `${plan.blocked.message} The viewport shows only the exact evaluable prefix of the stack.`,
    });
  }
  return plan;
}

function assertCompleteMaterialGroups(geometry, materialCount, entityId) {
  const groups = Array.isArray(geometry.groups) ? geometry.groups : [];
  if (groups.length === 0) {
    throw compileError(
      'runtime_material_groups_missing',
      `Entity ${entityId} assigns ${materialCount} materials, but its geometry has no face material groups.`,
    );
  }
  const drawCount = geometry.getIndex?.()?.count
    ?? geometry.index?.count
    ?? geometry.getAttribute?.('position')?.count
    ?? 0;
  const ordered = [...groups].sort((left, right) => left.start - right.start);
  let cursor = 0;
  for (const group of ordered) {
    const valid = Number.isInteger(group.start) && Number.isInteger(group.count)
      && group.start === cursor && group.count > 0
      && Number.isInteger(group.materialIndex) && group.materialIndex >= 0
      && group.materialIndex < materialCount
      && group.start + group.count <= drawCount;
    if (!valid) {
      throw compileError(
        'runtime_material_groups_invalid',
        `Entity ${entityId} geometry material groups must cover the draw range exactly with valid material slots.`,
      );
    }
    cursor += group.count;
  }
  if (cursor !== drawCount) {
    throw compileError(
      'runtime_material_groups_incomplete',
      `Entity ${entityId} geometry material groups cover ${cursor} of ${drawCount} draw elements.`,
    );
  }
}

function instantiateEntity(THREE, entity, context) {
  const meshValues = entity.components?.mesh ?? {};
  let object;
  if (entity.kind === 'mesh' || entity.kind === 'instancedMesh') {
    const materialIds = meshValues.materialIds ?? (meshValues.materialId ? [meshValues.materialId] : []);
    const requestedCount = Math.min(8192, Math.max(1, Math.trunc(Number(meshValues.count ?? 1) || 1)));
    const hasAuthoredInstances = Array.isArray(meshValues.instances) && meshValues.instances.length > 0;
    if (entity.kind === 'instancedMesh' && requestedCount > 1 && !hasAuthoredInstances) {
      throw compileError(
        'runtime_instancing_unsupported',
        `Entity ${entity.id} requests ${requestedCount} instances but does not provide mesh.instances transforms.`,
      );
    }
    const geometryResult = context.geometry(meshValues.geometryId, entity);
    const geometry = geometryResult.value;
    const materials = materialIds.map(context.material).filter(Boolean);
    const uvDependentMaterials = materials.filter(material => (
      material.userData?.studioTextureBindings?.length > 0
      || material.userData?.studioRequiresGeometryUv === true
    ));
    if (uvDependentMaterials.length > 0 && !geometry.getAttribute?.('uv')) {
      throw compileError(
        'runtime_texture_uv_missing',
        `Entity ${entity.id} uses raster material maps but geometry ${meshValues.geometryId} has no active UV attribute.`,
      );
    }
    const groupMaterialSlotCount = Array.isArray(geometry.groups) && geometry.groups.length > 0
      ? Math.max(...geometry.groups.map(group => group.materialIndex ?? 0)) + 1
      : 0;
    // Procedural Three.js geometries may carry built-in groups for optional
    // material arrays while still rendering correctly with one scalar
    // material. Only authored face-slot provenance is binding in scalar mode.
    const authoredMaterialSlotCount = Number.isInteger(geometry.userData?.studioMaterialSlotCount)
      ? geometry.userData.studioMaterialSlotCount
      : 0;
    const materialSlotCount = materials.length > 1
      ? Math.max(authoredMaterialSlotCount, groupMaterialSlotCount)
      : authoredMaterialSlotCount;
    const availableMaterialSlotCount = Math.max(1, materials.length);
    if (materialSlotCount > availableMaterialSlotCount) {
      throw compileError(
        'runtime_material_slot_missing',
        `Entity ${entity.id} geometry addresses ${materialSlotCount} material slots but only ${availableMaterialSlotCount} are available.`,
      );
    }
    if (materials.length > 1) assertCompleteMaterialGroups(geometry, materials.length, entity.id);
    const material = materials.length > 1
      ? materials
      : (materials[0] ?? context.fallbackMaterial());
    const instanceMatrices = evaluateInstanceStack(
      THREE,
      entity,
      context.diagnostics,
      geometryResult.plan.previewModifiers,
      {
        resolveSurface: context.resolveSurface,
        onSurfaceShortfall(pattern, accepted) {
          context.diagnostics.push({
            severity: 'warning',
            code: 'runtime_surface_pattern_spacing_shortfall',
            id: entity.id,
            modifierId: pattern.id,
            message: `Surface pattern ${pattern.id} placed ${accepted} of ${pattern.count} instances because minDistance exhausted the bounded sampler.`,
          });
        },
      },
    );
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
    if (!object && ['scene', 'group', 'empty', 'gameObject', 'audioSource'].includes(entity.kind)) object = new THREE.Group();
    if (!object) throw new Error(`Entity kind ${entity.kind} is not compiled by the lean runtime yet.`);
    if (object.isLight) {
      const lightValues = entity.components?.light ?? {};
      if (object.userData?.studioAreaLightApproximation) {
        context.diagnostics.push({
          severity: 'warning',
          code: 'runtime_area_light_approximated',
          id: entity.id,
          message: 'Native WebGPU compiles area lights as safe point-light approximations.',
        });
      }
      if (object.userData?.studioHemisphereLightApproximation) {
        context.diagnostics.push({
          severity: 'warning',
          code: 'runtime_hemisphere_light_approximated',
          id: entity.id,
          message: 'WebGPU compiles hemisphere lights as safe ambient approximations.',
        });
      }
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
    ...(['perspectiveCamera', 'orthographicCamera'].includes(entity.kind)
      && Number.isFinite(entity.components?.camera?.presentationAspect)
      && entity.components.camera.presentationAspect >= 0.1
      && entity.components.camera.presentationAspect <= 10
      ? { studioPresentationAspect: entity.components.camera.presentationAspect }
      : {}),
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
export function compileSceneDocument({ THREE, TSL, project, sceneId = project.activeSceneId, aspect = 16 / 9, audioPreview } = {}) {
  const document = project.scenes?.[sceneId];
  if (!document) throw new Error(`Scene ${sceneId} does not exist.`);
  const timeline = document.settings?.timeline ?? {};
  const timelineFps = Number.isFinite(timeline.framesPerSecond) ? timeline.framesPerSecond : 24;
  const initialAnimationTime = ((timeline.currentFrame ?? timeline.frameStart ?? 1) - (timeline.frameStart ?? 1)) / timelineFps;
  let animationTime = initialAnimationTime;
  const diagnostics = [];
  const geometries = new Map();
  const materials = new Map();
  const textures = new Map();
  const dynamicRtxDiagnosticEntities = new Set();
  const maxTimelineGeometrySamples = GEOMETRY_MODIFIER_LIMITS.maxOceanTimelineSamples;
  let timelineGeometrySampleCount = 0;
  let fallback = null;
  const reportDynamicRtxExclusion = (entity, modifierIds) => {
    if (dynamicRtxDiagnosticEntities.has(entity.id)) return;
    dynamicRtxDiagnosticEntities.add(entity.id);
    diagnostics.push({
      severity: 'warning',
      code: 'runtime_dynamic_geometry_rtx_excluded',
      id: entity.id,
      modifierIds: [...modifierIds],
      message: `Entity ${entity.id} has timeline-driven geometry and is excluded from the static RTX triangle scene. Raster WebGPU rendering remains live.`,
    });
  };
  const geometry = (id, entity) => {
    const target = 'viewport';
    const resource = project.resources?.geometries?.[id];
    if (!resource) throw new Error(`Geometry resource ${id} does not exist.`);
    const sourceRecipe = normalizeGeometryRecipe(resource);
    const plan = viewportModifierPlan(entity, sourceRecipe.kind, diagnostics);
    const cacheKey = JSON.stringify([id, plan.stackHash, target]);
    if (geometries.has(cacheKey)) {
      const cached = geometries.get(cacheKey);
      if (cached.dynamicModifierIds?.length > 0) {
        reportDynamicRtxExclusion(entity, cached.dynamicModifierIds);
      }
      return { ...cached, plan };
    }
    let evaluation = null;
    let dynamicBaseRecipe = null;
    let dynamicModifiers = [];
    let dynamicSampleCount = 0;
    let value;
    if (plan.hasActiveGeometryModifiers) {
      const evaluateBeforeSeams = sourceRecipe.kind === 'editableMesh'
        && plan.geometryModifiers.every(modifier => EDITABLE_PRESEAM_MODIFIERS.has(modifier.type));
      if (evaluateBeforeSeams) {
        const preseam = editablePreseamRecipe(sourceRecipe);
        evaluation = evaluateGeometryModifierStack(preseam.indexed, plan.geometryModifiers, {
          target,
          unsupported: 'error',
          timeSeconds: animationTime,
        });
        value = createGeometry(THREE, { recipe: { ...preseam.mesh, positions: evaluation.recipe.positions } });
      } else {
      let baseGeometry = null;
      try {
        baseGeometry = createGeometry(THREE, resource);
        const authoredMaterialIds = entity.components?.mesh?.materialIds
          ?? (entity.components?.mesh?.materialId ? [entity.components.mesh.materialId] : []);
        const baseRecipe = indexedMeshRecipeFromBufferGeometry(baseGeometry, {
          captureMaterialGroups: authoredMaterialIds.length > 1,
        });
        const dynamicIndex = plan.geometryModifiers.findIndex(
          modifier => modifier.type === 'ocean' && (modifier.timelineScale ?? 1) !== 0,
        );
        if (dynamicIndex >= 0) {
          const prefixEvaluation = evaluateGeometryModifierStack(
            baseRecipe,
            plan.geometryModifiers.slice(0, dynamicIndex),
            { target, unsupported: 'error' },
          );
          dynamicBaseRecipe = prefixEvaluation.recipe;
          dynamicModifiers = plan.geometryModifiers.slice(dynamicIndex);
          dynamicSampleCount = dynamicModifiers.reduce((total, modifier) => (
            total + (dynamicBaseRecipe.positions.length / 3) * (modifier.waveCount ?? 16)
          ), 0);
          const requestedTimelineSamples = timelineGeometrySampleCount + dynamicSampleCount;
          if (requestedTimelineSamples > maxTimelineGeometrySamples) {
            throw compileError(
              'runtime_timeline_geometry_budget_exceeded',
              `Timeline geometry requests ${requestedTimelineSamples} vertex-wave samples per update; the scene limit is ${maxTimelineGeometrySamples}.`,
              {
                entityId: entity.id,
                modifierIds: dynamicModifiers.map(modifier => modifier.id),
                requested: requestedTimelineSamples,
                maximum: maxTimelineGeometrySamples,
              },
            );
          }
          const dynamicEvaluation = evaluateGeometryModifierStack(
            dynamicBaseRecipe,
            dynamicModifiers,
            { target, unsupported: 'error', timeSeconds: animationTime },
          );
          evaluation = {
            ...dynamicEvaluation,
            applied: [...prefixEvaluation.applied, ...dynamicEvaluation.applied],
            skipped: [...prefixEvaluation.skipped, ...dynamicEvaluation.skipped],
            blocked: [...prefixEvaluation.blocked, ...dynamicEvaluation.blocked],
            diagnostics: [...prefixEvaluation.diagnostics, ...dynamicEvaluation.diagnostics],
          };
        } else {
          evaluation = evaluateGeometryModifierStack(baseRecipe, plan.geometryModifiers, {
            target,
            unsupported: 'error',
            timeSeconds: animationTime,
          });
        }
        value = createGeometry(THREE, { recipe: evaluation.recipe });
      } finally {
        baseGeometry?.dispose?.();
      }
      }
    } else {
      value = createGeometry(THREE, resource);
    }
    try {
      ensureGeneratedCoordinateAttribute(THREE, value);
      const dynamicModifierIds = plan.geometryModifiers
        .filter(modifier => modifier.type === 'ocean' && (modifier.timelineScale ?? 1) !== 0)
        .map(modifier => modifier.id);
      timelineGeometrySampleCount += dynamicSampleCount;
      value.name = resource.name ?? id;
      value.userData = {
        ...(value.userData ?? {}),
        studioResourceId: id,
        studioModifierStackHash: plan.stackHash,
        studioGeometryTarget: target,
        studioAppliedGeometryModifiers: evaluation?.applied.map(item => item.id) ?? [],
        ...(dynamicModifierIds.length > 0 ? {
          studioTimelineGeometryModifierIds: [...dynamicModifierIds],
          studioRtxExclusionReason: 'timeline-driven geometry is not representable by the static RTX triangle scene',
          rtxIgnore: true,
        } : {}),
      };
      if (dynamicModifierIds.length > 0) reportDynamicRtxExclusion(entity, dynamicModifierIds);
      const result = {
        value,
        evaluation,
        stackHash: plan.stackHash,
        target,
        plan,
        dynamicModifierIds,
        ...(dynamicModifierIds.length > 0 ? {
          dynamic: {
            baseRecipe: dynamicBaseRecipe,
            modifiers: dynamicModifiers,
          },
        } : {}),
      };
      geometries.set(cacheKey, result);
      return result;
    } catch (error) {
      value?.dispose?.();
      throw error;
    }
  };
  const texture = id => {
    if (!id) return null;
    if (textures.has(id)) return textures.get(id);
    const resource = project.resources?.textures?.[id];
    if (!resource) return null;
    const authored = resource.recipe ?? resource.parameters ?? resource;
    if ((authored?.kind ?? authored?.type) !== 'dataTexture') {
      throw compileError(
        'texture_not_live_raster',
        `Texture ${id} is a preserved legacy placeholder; patch it to a canonical dataTexture recipe before binding it to a live material or graph.`,
      );
    }
    const value = createDataTexture({ THREE, resource });
    textures.set(id, value);
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
      textureResolver: texture,
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
  const surfaceRecipeCache = new Map();
  const resolveSurface = (sourceEntity, targetEntityId) => {
    if (sourceEntity.id === targetEntityId) {
      throw compileError('runtime_surface_pattern_self_target', `Entity ${sourceEntity.id} cannot scatter onto itself.`);
    }
    const targetEntity = document.entities?.[targetEntityId];
    const geometryId = targetEntity?.components?.mesh?.geometryId;
    if (!targetEntity || !geometryId) {
      throw compileError('runtime_surface_pattern_target_invalid', `Surface target ${targetEntityId} must be a mesh in the active scene.`);
    }
    const sourceWorld = entityWorldMatrix(document, sourceEntity.id);
    const targetWorld = entityWorldMatrix(document, targetEntity.id);
    const relative = multiplyTransformMatrices(invertTransformMatrix(sourceWorld), targetWorld);
    const targetGeometry = geometry(geometryId, targetEntity).value;
    const cacheKey = JSON.stringify([sourceEntity.id, targetEntity.id, relative, targetGeometry.userData?.studioModifierStackHash]);
    if (!surfaceRecipeCache.has(cacheKey)) {
      surfaceRecipeCache.set(cacheKey, transformSurfaceRecipe(indexedMeshRecipeFromBufferGeometry(targetGeometry), relative));
    }
    return surfaceRecipeCache.get(cacheKey);
  };
  for (const entity of entities) {
    try {
      objects.set(entity.id, instantiateEntity(THREE, entity, {
        geometry,
        material,
        fallbackMaterial,
        aspect,
        shadowLights,
        diagnostics,
        resolveSurface: targetEntityId => resolveSurface(entity, targetEntityId),
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
  const timelineGeometryModifierIds = [...new Set(
    [...geometries.values()].flatMap(entry => entry.dynamicModifierIds ?? []),
  )];
  const updateFloatAttribute = (geometryValue, name, values, itemSize) => {
    if (!Array.isArray(values)) {
      geometryValue.deleteAttribute?.(name);
      return;
    }
    const current = geometryValue.getAttribute?.(name);
    if (!current || current.itemSize !== itemSize || current.array?.length !== values.length) {
      geometryValue.setAttribute(name, new THREE.Float32BufferAttribute(values, itemSize));
      return;
    }
    if (typeof current.array.set === 'function') current.array.set(values);
    else for (let index = 0; index < values.length; index += 1) current.array[index] = values[index];
    current.needsUpdate = true;
  };
  const updateTimelineGeometry = (timeSeconds) => {
    const evaluations = [];
    for (const entry of geometries.values()) {
      if (!entry.dynamic) continue;
      const evaluation = evaluateGeometryModifierStack(
        entry.dynamic.baseRecipe,
        entry.dynamic.modifiers,
        { target: entry.target, unsupported: 'error', timeSeconds },
      );
      const currentIndexCount = entry.value.getIndex?.()?.count ?? entry.value.index?.count ?? 0;
      if (currentIndexCount !== evaluation.recipe.indices.length) {
        throw compileError(
          'runtime_dynamic_geometry_topology_changed',
          `Timeline-driven modifiers changed topology for ${entry.dynamicModifierIds.join(', ')}; Ocean must be the final live geometry modifier.`,
        );
      }
      updateFloatAttribute(entry.value, 'position', evaluation.recipe.positions, 3);
      updateFloatAttribute(entry.value, 'normal', evaluation.recipe.normals, 3);
      entry.value.computeBoundingBox?.();
      entry.value.computeBoundingSphere?.();
      entry.value.userData.studioTimelineTime = timeSeconds;
      entry.evaluation = evaluation;
      evaluations.push({
        modifierIds: [...entry.dynamicModifierIds],
        timeSeconds,
        vertices: evaluation.recipe.positions.length / 3,
      });
    }
    return evaluations;
  };
  const audioRuntime = createAudioRuntime({
    project,
    scene: document,
    cacheDirectory: audioPreview?.cacheDirectory,
    writeFile: audioPreview?.writeFile,
    audioFactory: audioPreview?.audioFactory,
  });
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
    audioRuntime,
    timelineGeometryModifierIds,
    timelineGeometrySampleCount,
    maxTimelineGeometrySamples,
    get animationTime() { return animationTime; },
    animationActions: animationRuntime ? [...animationRuntime.actions.keys()] : [],
    setAnimationTime(timeSeconds) {
      if (!Number.isFinite(timeSeconds) || Math.abs(timeSeconds) > 1_000_000_000) {
        throw compileError('runtime_animation_time_invalid', 'Timeline time must be a finite number with magnitude at most 1000000000 seconds.');
      }
      animationTime = timeSeconds;
      restoreAuthoredPose();
      const evaluations = animationRuntime?.setTime(timeSeconds) ?? [];
      updateTimelineGeometry(timeSeconds);
      evaluateConstraints();
      return evaluations;
    },
    advanceAnimation(deltaSeconds, { restorePose = true } = {}) {
      if (!Number.isFinite(deltaSeconds) || Math.abs(deltaSeconds) > 1_000_000_000) {
        throw compileError('runtime_animation_delta_invalid', 'Timeline delta must be a finite number with magnitude at most 1000000000 seconds.');
      }
      animationTime += deltaSeconds;
      if (restorePose) restoreAuthoredPose();
      const evaluations = animationRuntime?.advance(deltaSeconds) ?? [];
      updateTimelineGeometry(animationTime);
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
      for (const value of geometries.values()) value.value.dispose?.();
      for (const value of ownedMaterials) value.dispose?.();
      for (const value of textures.values()) value.dispose?.();
      ownedDisposableObjects.clear();
      ownedMaterials.clear();
      geometries.clear();
      materials.clear();
      textures.clear();
      objects.clear();
      authoredPose.clear();
      appearance.backgroundNode?.dispose?.();
      animationRuntime?.actions.clear();
      animationRuntime?.states.clear();
      animationRuntime = null;
      audioRuntime?.stop?.();
    },
  };
}
