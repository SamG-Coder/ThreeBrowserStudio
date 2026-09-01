import { evaluateDesignExpression, evaluateDesignVector } from './design-expression.mjs';
import { ProjectIndex } from '../core/indexes.mjs';
import { PlainformSpatialResolver } from './spatial-relations.mjs';
import { composeTransformMatrix, relativeEntityTransform, transformPointByMatrix } from '../core/transform-math.mjs';
import {
  buildConstrainedPatchSections,
  matchBoundaryDirection,
  projectSurfaceAnchors,
  realizeSurfaceTriangles,
} from './constrained-surface.mjs';
import { SemanticSurfaceRegistry } from './semantic-surface.mjs';
import { deformAlongSurfaceCurve, deformSurfaceRegion } from './semantic-surface-deformation.mjs';
import { shellSurface } from './semantic-surface-shell.mjs';
import { refineSurfaceRegion } from './semantic-surface-refinement.mjs';
import { openSurfaceAlongCurve, splitSurfaceAlongCurve } from './semantic-surface-split.mjs';
import {
  angleBetweenSurfaceReferences,
  assertSurfaceSymmetry,
  minimumSurfaceDistance,
  surfaceBounds,
  surfaceWidthAtHeight,
} from './semantic-surface-query.mjs';
import {
  mirrorEvaluatedSurface,
  mirrorVector,
  offsetSurfaceCurve,
  sampleSurfaceReference,
  surfaceReferenceSeparation,
  sweepProfileAlongGuide,
} from './semantic-surface-reference.mjs';

const MAX_DESIGN_ENTITIES = 128;
const MAX_LOOP_ITERATIONS = 128;
const MAX_BOUNDARIES = 128;
const MAX_BOUNDARY_POINTS = 256;
const LEGACY_DESIGN_FRAME = 'legacy-xz-y';
const SEMANTIC_DESIGN_FRAME = 'right-up-forward';

function identityTransform() {
  return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
}

function designRootTransform(frame) {
  return frame === SEMANTIC_DESIGN_FRAME
    ? { position: [0, 0, 0], rotation: [-Math.PI / 2, 0, 0], scale: [1, 1, 1] }
    : identityTransform();
}

function clean(value) {
  return value.trim().replace(/[.:;]+$/u, '').trim();
}

function key(value) {
  return clean(value).toLowerCase().replace(/^(?:the|a|an)\s+/u, '').replace(/\s+/gu, ' ');
}

function slug(value) {
  return key(value).replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'design';
}

function quoteName(value) {
  return value.trim().replace(/^"|"$/gu, '');
}

function expectDimension(result, dimension, phrase) {
  if (result.dimension !== dimension && !(result.dimension === 'scalar' && result.value === 0)) {
    const error = new Error(`${phrase} must be ${dimension}, received ${result.dimension}.`);
    error.code = 'plainform_dimension_mismatch';
    throw error;
  }
  return result.value;
}

function finitePositive(value, phrase) {
  if (!Number.isFinite(value) || value <= 0) {
    const error = new Error(`${phrase} must be greater than zero.`);
    error.code = 'plainform_design_dimension';
    throw error;
  }
  return value;
}

function interpolate(value, variables) {
  return value.replace(/\{([^}]+)\}/gu, (_match, expression) => {
    const result = evaluateDesignExpression(expression, variables);
    if (result.dimension !== 'scalar') {
      const error = new Error(`ID interpolation “${expression}” must be scalar.`);
      error.code = 'plainform_dimension_mismatch';
      throw error;
    }
    return Number.isInteger(result.value) ? String(result.value) : String(result.value).replace('.', '-');
  });
}

function rectangularPoints(width, depth, radius = 0) {
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const boundedRadius = Math.max(0, Math.min(radius, halfWidth, halfDepth));
  if (boundedRadius === 0) return [
    [-halfWidth, 0, -halfDepth], [halfWidth, 0, -halfDepth],
    [halfWidth, 0, halfDepth], [-halfWidth, 0, halfDepth],
  ];
  const points = [];
  for (const [cx, cz, start] of [
    [halfWidth - boundedRadius, halfDepth - boundedRadius, 0],
    [-halfWidth + boundedRadius, halfDepth - boundedRadius, Math.PI / 2],
    [-halfWidth + boundedRadius, -halfDepth + boundedRadius, Math.PI],
    [halfWidth - boundedRadius, -halfDepth + boundedRadius, Math.PI * 1.5],
  ]) {
    for (let step = 0; step <= 3; step += 1) {
      const angle = start + step * Math.PI / 6;
      points.push([cx + Math.cos(angle) * boundedRadius, 0, cz + Math.sin(angle) * boundedRadius]);
    }
  }
  return points;
}

function parseVectorGroups(source, variables, { dimensions = 3, dimension = 'length', phrase = 'Point list' } = {}) {
  const groups = [...source.matchAll(/\[([^\[\]]+)\]/gu)];
  if (groups.length === 0) {
    const error = new Error(`${phrase} requires bracketed coordinate vectors.`);
    error.code = 'plainform_profile_points';
    throw error;
  }
  return groups.map((match, pointIndex) => {
    const parts = match[1].split(',').map(value => value.trim()).filter(Boolean);
    if (parts.length !== dimensions) {
      const error = new Error(`${phrase} point ${pointIndex + 1} requires ${dimensions} coordinates.`);
      error.code = 'plainform_profile_points';
      throw error;
    }
    return parts.map((part) => expectDimension(evaluateDesignExpression(part, variables), dimension, phrase));
  });
}

function directionalCoordinate(source, variables, { axis, phrase }) {
  const match = source.trim().match(/^(.+?)\s+(right|left|up|down|forward|backward)$/iu);
  const directions = axis === 'right'
    ? new Map([['right', 1], ['left', -1]])
    : axis === 'up'
      ? new Map([['up', 1], ['down', -1]])
      : new Map([['forward', 1], ['backward', -1]]);
  if (!match) return expectDimension(evaluateDesignExpression(source, variables), 'length', phrase);
  const direction = match[2].toLowerCase();
  if (!directions.has(direction)) {
    const error = new Error(`${phrase} uses ${direction} in the ${axis} coordinate; expected ${[...directions.keys()].join(' or ')}.`);
    error.code = 'plainform_design_frame_axis';
    throw error;
  }
  return directions.get(direction) * expectDimension(evaluateDesignExpression(match[1], variables), 'length', phrase);
}

function semanticVector(source, variables, { dimensions = 3, phrase = 'Semantic vector' } = {}) {
  const match = source.trim().match(/^\[([^\[\]]+)\]$/u);
  if (!match) {
    const error = new Error(`${phrase} requires one bracketed ${dimensions}-coordinate vector.`);
    error.code = 'plainform_profile_points';
    throw error;
  }
  const parts = match[1].split(',').map(value => value.trim()).filter(Boolean);
  if (parts.length !== dimensions) {
    const error = new Error(`${phrase} requires ${dimensions} coordinates.`);
    error.code = 'plainform_profile_points';
    throw error;
  }
  if (dimensions === 2) return [
    directionalCoordinate(parts[0], variables, { axis: 'right', phrase }),
    directionalCoordinate(parts[1], variables, { axis: 'up', phrase }),
  ];
  return [
    directionalCoordinate(parts[0], variables, { axis: 'right', phrase }),
    directionalCoordinate(parts[1], variables, { axis: 'up', phrase }),
    directionalCoordinate(parts[2], variables, { axis: 'forward', phrase }),
  ];
}

function semanticVectorGroups(source, variables, { dimensions = 3, phrase = 'Semantic point list' } = {}) {
  const groups = [...source.matchAll(/\[([^\[\]]+)\]/gu)];
  if (groups.length === 0) {
    const error = new Error(`${phrase} requires bracketed coordinate vectors.`);
    error.code = 'plainform_profile_points';
    throw error;
  }
  return groups.map(match => semanticVector(`[${match[1]}]`, variables, { dimensions, phrase }));
}

function semanticWorldToLoft(point) {
  return [point[0], -point[2], point[1]];
}

function semanticAxisRotation(direction) {
  switch (direction) {
    case 'right': return [0, 0, -Math.PI / 2];
    case 'left': return [0, 0, Math.PI / 2];
    case 'up': return [0, 0, 0];
    case 'down': return [Math.PI, 0, 0];
    case 'forward': return [Math.PI / 2, 0, 0];
    case 'backward': return [-Math.PI / 2, 0, 0];
    default: return [0, 0, 0];
  }
}

function profilePoints(source, variables, phrase = 'Profile', frame = LEGACY_DESIGN_FRAME) {
  if (frame === SEMANTIC_DESIGN_FRAME) {
    return semanticVectorGroups(source, variables, { dimensions: 2, phrase })
      .map(([right, up]) => [right, 0, up]);
  }
  return parseVectorGroups(source, variables, { dimensions: 2, dimension: 'length', phrase })
    .map(([x, z]) => [x, 0, z]);
}

function smoothClosedPoints(points, samples = Math.min(128, Math.max(12, points.length * 4))) {
  if (points.length < 3) return points.map(point => [...point]);
  const result = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const scaled = sample / samples * points.length;
    const index = Math.floor(scaled);
    const t = scaled - index;
    const p0 = points[(index - 1 + points.length) % points.length];
    const p1 = points[index % points.length];
    const p2 = points[(index + 1) % points.length];
    const p3 = points[(index + 2) % points.length];
    result.push(p1.map((value, axis) => 0.5 * (
      2 * value
      + (-p0[axis] + p2[axis]) * t
      + (2 * p0[axis] - 5 * value + 4 * p2[axis] - p3[axis]) * t ** 2
      + (-p0[axis] + 3 * value - 3 * p2[axis] + p3[axis]) * t ** 3
    )));
  }
  return result;
}

function smoothOpenPoints(points, samples = Math.min(128, Math.max(8, points.length * 4))) {
  if (points.length < 3) return points.map(point => [...point]);
  const result = [];
  const segmentCount = points.length - 1;
  for (let sample = 0; sample < samples; sample += 1) {
    const scaled = sample / (samples - 1) * segmentCount;
    const index = Math.min(segmentCount - 1, Math.floor(scaled));
    const t = scaled - index;
    const p0 = points[Math.max(0, index - 1)];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[Math.min(points.length - 1, index + 2)];
    result.push(p1.map((value, axis) => 0.5 * (
      2 * value
      + (-p0[axis] + p2[axis]) * t
      + (2 * p0[axis] - 5 * value + 4 * p2[axis] - p3[axis]) * t ** 2
      + (-p0[axis] + 3 * value - 3 * p2[axis] + p3[axis]) * t ** 3
    )));
  }
  return result;
}

function mirroredProfile(points, axis = 'z') {
  // The named centreline is the axis retained by the reflection: a Z/up
  // centreline mirrors X/right, while an X/right centreline mirrors Z/up.
  const coordinate = axis === 'z' ? 0 : 2;
  const mirrored = [...points].reverse().map(point => point.map((value, index) => index === coordinate ? -value : value));
  const result = points.map(point => [...point]);
  for (const point of mirrored) {
    if (result.some(existing => existing.every((value, index) => Math.abs(value - point[index]) <= 1e-9))) continue;
    result.push(point);
  }
  return result;
}

function profileBounds(points) {
  const xs = points.map(point => point[0]);
  const zs = points.map(point => point[2]);
  return { width: Math.max(...xs) - Math.min(...xs), depth: Math.max(...zs) - Math.min(...zs) };
}

function hairCardRecipe(points, width, tipScale = 0.1) {
  if (!Array.isArray(points) || points.length < 2) {
    const error = new Error('A hair card requires a guide with at least two points.');
    error.code = 'plainform_hair_guide'; throw error;
  }
  const positions = []; const uvs = []; const indices = [];
  let previousSide = [1, 0, 0];
  for (let index = 0; index < points.length; index += 1) {
    const before = points[Math.max(0, index - 1)]; const after = points[Math.min(points.length - 1, index + 1)];
    const tangent = normalizeVector(after.map((value, axis) => value - before[axis]));
    const helper = Math.abs(tangent[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
    let side = normalizeVector([
      tangent[1] * helper[2] - tangent[2] * helper[1],
      tangent[2] * helper[0] - tangent[0] * helper[2],
      tangent[0] * helper[1] - tangent[1] * helper[0],
    ]);
    if (side.reduce((sum, value, axis) => sum + value * previousSide[axis], 0) < 0) side = side.map(value => -value);
    previousSide = side;
    const progress = index / Math.max(1, points.length - 1); const halfWidth = width * 0.5 * (1 + (tipScale - 1) * progress);
    positions.push(...points[index].map((value, axis) => value - side[axis] * halfWidth));
    positions.push(...points[index].map((value, axis) => value + side[axis] * halfWidth));
    uvs.push(0, progress, 1, progress);
    if (index > 0) {
      const previous = (index - 1) * 2; const current = index * 2;
      indices.push(previous, previous + 1, current, previous + 1, current + 1, current);
    }
  }
  return { kind: 'indexedMesh', positions, indices, uvs };
}

function normalizeVector(vector) {
  const magnitude = Math.hypot(...vector);
  return magnitude > 1e-12 ? vector.map(value => value / magnitude) : [1, 0, 0];
}

function splitNames(value) {
  return value.split(/\s*(?:,|\band\b)\s*/iu).map(key).filter(Boolean);
}

function boundaryReferenceKey(value) {
  return slug(value.replace(/^\$/u, ''));
}

function endpointDistanceSquared(left, right) {
  return left.reduce((sum, value, axis) => sum + (value - right[axis]) ** 2, 0);
}

function activeScene(project) {
  const sceneId = project.activeSceneId ?? project.sceneOrder?.[0] ?? Object.keys(project.scenes ?? {})[0];
  if (!sceneId || !project.scenes?.[sceneId]) {
    const error = new Error('Design Plainform requires an active scene.');
    error.code = 'plainform_scene_required';
    throw error;
  }
  return project.scenes[sceneId];
}

function occupiedIds(project) {
  const ids = new Set();
  Object.keys(project.scenes ?? {}).forEach(id => ids.add(id));
  for (const scene of Object.values(project.scenes ?? {})) Object.keys(scene.entities ?? {}).forEach(id => ids.add(id));
  for (const resources of Object.values(project.resources ?? {})) Object.keys(resources ?? {}).forEach(id => ids.add(id));
  return ids;
}

/** A bounded parametric solid-design dialect that lowers to canonical resources and batched entities. */
export class DesignPlainformCompiler {
  static canCompile(source) {
    return /^\s*(?:begin\s+)?design\b/iu.test(source);
  }

  compile(source, { project }) {
    const lines = source.split(/\r?\n/u).map(value => value.trim()).filter(Boolean);
    const header = clean(lines[0]).match(/^(?:begin\s+)?design (?:a |an )?(.+?) called (?:(?:"([^"]+)")|(.+?)) with id ([a-z0-9][a-z0-9._/-]*)(?: using the (right-up-forward|legacy-xz-y) design frame)?$/iu);
    if (!header) {
      const error = new Error('A design must begin with “Design a <kind> called <name> with id entity/<id>.” Append “using the right-up-forward design frame” for canonical AI-oriented coordinates.');
      error.code = 'plainform_design_header';
      throw error;
    }
    const scene = activeScene(project);
    const projectIndex = new ProjectIndex(project);
    const spatial = new PlainformSpatialResolver({
      fail(code, message, details) {
        const error = new Error(message); error.code = code; error.details = details; throw error;
      },
    });
    const designKind = header[1].trim();
    const designName = header[2] ?? header[3];
    const rootId = header[4];
    const designFrame = header[5]?.toLowerCase() ?? LEGACY_DESIGN_FRAME;
    const rootTransform = designRootTransform(designFrame);
    const semanticFrame = designFrame === SEMANTIC_DESIGN_FRAME;
    const designSlug = slug(designName);
    const occupied = occupiedIds(project);
    if (occupied.has(rootId)) {
      const error = new Error(`The design root ID ${rootId} already exists.`);
      error.code = 'plainform_id_conflict';
      throw error;
    }

    const variables = new Map();
    const vectorVariables = new Map();
    const profiles = new Map();
    const guides = new Map();
    const boundaries = new Map();
    const semanticSurfaces = new SemanticSurfaceRegistry({ boundaries, referenceKey: boundaryReferenceKey });
    const entities = [];
    const aliases = { [key(designName)]: [rootId] };
    const interpretations = [`Will create the ${designKind} design “${designName}” as ${rootId}.`];
    if (semanticFrame) interpretations.push('Will use the semantic right/up/forward frame mapped to canonical X/Y/Z world axes.');
    const geometryKinds = new Set();
    const lofts = [];
    const surfacePatches = [];
    const generatedResources = [];
    const booleanCommands = [];
    const semanticDeformationStates = new Map();
    const constraints = [];
    const imprintedCurves = new Set();
    const openedSurfaceCurves = new Map();
    let pendingSurfaceSplit = null;
    const ids = new Set([rootId]);
    let requestedPreview = false;
    let autoNumber = 0;

    const evaluate = (expression, scope) => evaluateDesignExpression(clean(expression), scope);
    const length = (expression, scope, phrase) => expectDimension(evaluate(expression, scope), 'length', phrase);
    const scalar = (expression, scope, phrase) => expectDimension(evaluate(expression, scope), 'scalar', phrase);
    const angle = (expression, scope, phrase) => {
      const result = evaluate(expression, scope);
      if (!['angle', 'scalar'].includes(result.dimension)) {
        const error = new Error(`${phrase} must be an angle.`); error.code = 'plainform_dimension_mismatch'; throw error;
      }
      return result.value;
    };
    const designVector = (expression, scope, dimension, phrase = 'Vector') => {
      const normalized = key(expression);
      const named = vectorVariables.get(normalized);
      if (named) {
        if (named.dimension !== dimension) {
          const error = new Error(`${phrase} “${normalized}” must be ${dimension}, received ${named.dimension}.`);
          error.code = 'plainform_dimension_mismatch'; throw error;
        }
        return [...named.value];
      }
      if (semanticFrame && dimension === 'length') return semanticVector(expression, scope, { dimensions: 3, phrase });
      return evaluateDesignVector(expression, scope, dimension);
    };
    const loftVector = (expression, scope, phrase = 'Loft-local vector') => semanticFrame
      ? semanticWorldToLoft(semanticVector(expression, scope, { dimensions: 3, phrase }))
      : evaluateDesignVector(expression, scope, 'length');
    const loftPointGroups = (expression, scope, phrase) => semanticFrame
      ? semanticVectorGroups(expression, scope, { dimensions: 3, phrase }).map(semanticWorldToLoft)
      : parseVectorGroups(expression, scope, { dimensions: 3, dimension: 'length', phrase });
    const referencePoint = phrase => {
      const name = key(phrase);
      const exact = projectIndex.entities.get(clean(phrase)) ?? projectIndex.entities.get(name);
      if (exact) return spatial.position(exact);
      const generatedId = aliases[name]?.[0] ?? clean(phrase);
      const generated = entities.find(entity => entity.id === generatedId);
      if (generated) return [...generated.transform.position];
      const error = new Error(`No exact design reference matches “${phrase}”.`);
      error.code = 'plainform_reference_not_found';
      throw error;
    };
    const generatedEntity = phrase => {
      const normalized = key(phrase);
      const generatedId = aliases[normalized]?.[0] ?? clean(phrase);
      return entities.find(entity => entity.id === generatedId)
        ?? lofts.find(loft => loft.entityId === generatedId)
        ?? surfacePatches.find(patch => patch.entityId === generatedId);
    };
    const persistentAnchor = (anchor, seedPoint) => ({
      seedPoint: [...seedPoint], projectedPoint: [...anchor.point], normal: [...anchor.normal],
      triangleIndex: anchor.triangleIndex, barycentric: [...anchor.barycentric],
      ...(anchor.parametric ? { parametric: structuredClone(anchor.parametric) } : {}),
    });
    const unitRecipe = primitiveKind => {
      switch (primitiveKind) {
        case 'box': return { kind: 'box', width: 1, height: 1, depth: 1 };
        case 'cylinder': return { kind: 'cylinder', radiusTop: 1, radiusBottom: 1, height: 1, radialSegments: 32 };
        case 'sphere': return { kind: 'sphere', radius: 0.5, widthSegments: 48, heightSegments: 24 };
        case 'cone': return { kind: 'cone', radius: 0.5, height: 1, radialSegments: 32 };
        default: return { kind: 'plane', width: 1, height: 1 };
      }
    };
    const loftRecipe = loft => ({
      kind: 'loft', sections: loft.profile.sections, closedProfile: true, capStart: true, capEnd: true,
      capRings: loft.capRings ?? 0,
      profileResolution: loft.profile.points.length,
      subdivisions: loft.continuity === 'positional' ? 0 : 3,
      alignProfile: 'closest', continuity: loft.continuity,
      guideCurves: loft.guideCurves, modifiers: loft.modifiers,
    });
    const boundaryOwner = phrase => {
      const generated = generatedEntity(phrase);
      if (generated) {
        if (generated.entityId) return {
          entityId: generated.entityId,
          matrix: composeTransformMatrix({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
          recipe: generated.profile ? loftRecipe(generated) : {
            kind: 'loft',
            sections: generated.sections ?? generated.boundaries.map(boundary => ({
              id: `boundary/${slug(boundary.name)}`, points: boundary.points.map(point => [...point]),
            })),
            closedProfile: false, capStart: false, capEnd: false,
            profileResolution: generated.profileResolution ?? Math.max(...generated.boundaries.map(boundary => boundary.points.length)),
            subdivisions: generated.sections ? 0 : (generated.continuity === 'positional' ? 0 : 3),
            alignProfile: 'authored', continuity: generated.sections ? 'positional' : generated.continuity,
            guideCurves: [], modifiers: [],
          },
          geometryId: generated.geometryId,
        };
        const geometryId = generated.components?.mesh?.geometryId;
        const generatedResource = generatedResources.find(item => item.resource.id === geometryId)?.resource;
        return {
          entityId: generated.id,
          matrix: composeTransformMatrix(generated.transform),
          recipe: generatedResource?.recipe ?? unitRecipe(
            generated.metadata?.plainformDesign?.geometryKind ?? generated.metadata?.plainformDesign?.primitive,
          ),
          geometryId,
        };
      }
      const exactId = clean(phrase);
      const exact = projectIndex.entities.get(exactId);
      if (exact) {
        if (exact.sceneId !== scene.id) {
          const error = new Error(`Boundary owner ${exact.entity.id} belongs to ${exact.sceneId}, not the active scene ${scene.id}.`);
          error.code = 'plainform_cross_scene_boundary'; throw error;
        }
        const geometryId = exact.entity.components?.mesh?.geometryId;
        const resource = geometryId ? projectIndex.resources.get(geometryId)?.resource : null;
        return {
          entityId: exact.entity.id,
          matrix: spatial.worldMatrix(exact),
          recipe: resource?.recipe ?? resource?.parameters ?? resource,
          geometryId,
          meshComponent: exact.entity.components?.mesh,
        };
      }
      const error = new Error(`Boundary owner “${phrase}” must be an exact entity ID or an object created earlier in this design.`);
      error.code = 'plainform_boundary_owner_not_found';
      throw error;
    };
    const semanticDeformationOwner = phrase => {
      const owner = boundaryOwner(phrase);
      const existing = semanticDeformationStates.get(owner.entityId);
      if (existing) return existing;
      const state = { ...owner, originalGeometryId: owner.geometryId };
      semanticDeformationStates.set(owner.entityId, state);
      return state;
    };
    const semanticSurfaceOwner = phrase => {
      const owner = boundaryOwner(phrase);
      return semanticDeformationStates.get(owner.entityId) ?? owner;
    };
    const addEntity = ({
      id, name, kind: primitiveKind, shape = primitiveKind, dimensions, position, rotation = [0, 0, 0], materialId,
      parentId = rootId, extraComponents = {}, metadata = {},
    }) => {
      if (entities.length >= MAX_DESIGN_ENTITIES) {
        const error = new Error(`Design Plainform creates at most ${MAX_DESIGN_ENTITIES} entities per program.`);
        error.code = 'plainform_design_entity_limit';
        throw error;
      }
      if (!/^[a-z0-9][a-z0-9._/-]*$/u.test(id)) {
        const error = new Error(`Generated entity ID “${id}” is not a stable ID.`); error.code = 'plainform_invalid_id'; throw error;
      }
      if (occupied.has(id) || ids.has(id)) {
        const error = new Error(`Generated entity ID ${id} already exists.`); error.code = 'plainform_id_conflict'; throw error;
      }
      Object.entries(dimensions).forEach(([dimension, value]) => finitePositive(value, `${name} ${dimension}`));
      ids.add(id);
      geometryKinds.add(primitiveKind);
      const geometryId = `geometry/plainform-design/${designSlug}/${primitiveKind}-unit`;
      const scale = primitiveKind === 'box'
        ? [dimensions.width, dimensions.height, dimensions.depth]
        : primitiveKind === 'cylinder'
          ? [dimensions.radius, dimensions.height, dimensions.radius]
          : primitiveKind === 'sphere'
            ? [dimensions.width, dimensions.height, dimensions.depth]
            : primitiveKind === 'cone'
              ? [dimensions.diameter, dimensions.height, dimensions.diameter]
              : [dimensions.width, dimensions.height, 1];
      const transform = semanticFrame && parentId === rootId
        ? relativeEntityTransform(composeTransformMatrix(rootTransform), composeTransformMatrix({ position, rotation, scale }))
        : { position, rotation, scale };
      entities.push({
        id, kind: 'mesh', name, parentId,
        transform,
        components: { mesh: { geometryId, ...(materialId ? { materialId } : {}) }, ...extraComponents },
        metadata: { plainformDesign: {
          primitive: shape,
          ...(shape === primitiveKind ? {} : { geometryKind: primitiveKind }),
          dimensions,
          ...metadata,
        } },
      });
      aliases[key(name)] = [id];
    };

    const addGeneratedSolid = ({
      id, name, recipe, position = [0, 0, 0], rotation = [0, 0, 0], materialId,
      authoredInDesignFrame = false, metadata = {},
    }) => {
      if (entities.length >= MAX_DESIGN_ENTITIES) {
        const error = new Error(`Design Plainform creates at most ${MAX_DESIGN_ENTITIES} entities per program.`);
        error.code = 'plainform_design_entity_limit'; throw error;
      }
      if (occupied.has(id) || ids.has(id)) {
        const error = new Error(`Generated entity ID ${id} already exists.`); error.code = 'plainform_id_conflict'; throw error;
      }
      const geometryId = `geometry/plainform-design/${designSlug}/${slug(name)}`;
      if (occupied.has(geometryId) || ids.has(geometryId)) {
        const error = new Error(`Generated geometry ID ${geometryId} already exists.`); error.code = 'plainform_id_conflict'; throw error;
      }
      ids.add(id); ids.add(geometryId);
      generatedResources.push({ resourceType: 'geometries', resource: { id: geometryId, recipe } });
      const transform = authoredInDesignFrame && semanticFrame
        ? relativeEntityTransform(
          composeTransformMatrix(rootTransform),
          composeTransformMatrix({ position, rotation, scale: [1, 1, 1] }),
        )
        : { position, rotation, scale: [1, 1, 1] };
      entities.push({
        id, kind: 'mesh', name, parentId: rootId,
        transform,
        components: { mesh: { geometryId, ...(materialId ? { materialId } : {}) } },
        metadata: { plainformDesign: { primitive: recipe.kind, ...metadata } },
      });
      aliases[key(name)] = [id];
    };

    const execute = (start, end, scope) => {
      for (let lineIndex = start; lineIndex < end; lineIndex += 1) {
        const statement = clean(lines[lineIndex]);
        if (/^(?:preview these changes|show me a preview)$/iu.test(statement)) {
          requestedPreview = true;
          interpretations.push('Will request a guarded dry-run preview.');
          continue;
        }
        if (pendingSurfaceSplit && !/^call the enclosed (?:surface|region) /iu.test(statement)) {
          const error = new Error(`Split ${pendingSurfaceSplit.owner.entityId} along $${pendingSurfaceSplit.curve.name} must be followed immediately by “Call the enclosed surface <name>” so both results receive stable semantic identity.`);
          error.code = 'plainform_surface_split_name_required'; throw error;
        }
        const minimumDistanceStatement = statement.match(/^let (.+?) be (?:the )?minimum distance between (.+?) and (.+)$/iu);
        if (minimumDistanceStatement) {
          const first = semanticSurfaceOwner(minimumDistanceStatement[2]);
          const second = semanticSurfaceOwner(minimumDistanceStatement[3]);
          const value = minimumSurfaceDistance(first, second);
          const name = key(minimumDistanceStatement[1]);
          scope.set(name, Object.freeze({ value, dimension: 'length' }));
          if (scope === variables) interpretations.push(`Measured ${name} as ${value} metres between evaluated surfaces.`);
          continue;
        }
        const surfaceDimensionStatement = statement.match(/^let (.+?) be (?:the )?(width|height|depth) of (.+?)(?: at height (.+))?$/iu);
        if (surfaceDimensionStatement) {
          const owner = semanticSurfaceOwner(surfaceDimensionStatement[3]);
          const dimension = surfaceDimensionStatement[2].toLowerCase();
          let value;
          if (surfaceDimensionStatement[4]) {
            if (dimension !== 'width') {
              const error = new Error('A height-specific surface cross-section currently measures width only.');
              error.code = 'plainform_surface_measurement_unsupported'; throw error;
            }
            value = surfaceWidthAtHeight(owner, length(surfaceDimensionStatement[4], scope, 'Surface measurement height'));
          } else {
            value = surfaceBounds(owner).dimensions[{ width: 0, height: 1, depth: 2 }[dimension]];
          }
          const name = key(surfaceDimensionStatement[1]);
          scope.set(name, Object.freeze({ value, dimension: 'length' }));
          if (scope === variables) interpretations.push(`Measured ${name} as ${value} metres from ${owner.entityId}.`);
          continue;
        }
        const surfaceAngleStatement = statement.match(/^let (.+?) be (?:the )?angle between (\$[a-z0-9][a-z0-9._/-]*) and (\$[a-z0-9][a-z0-9._/-]*)$/iu);
        if (surfaceAngleStatement) {
          const first = semanticSurfaces.resolveReference(surfaceAngleStatement[2]);
          const second = semanticSurfaces.resolveReference(surfaceAngleStatement[3]);
          const value = angleBetweenSurfaceReferences(first, second);
          const name = key(surfaceAngleStatement[1]);
          scope.set(name, Object.freeze({ value, dimension: 'angle' }));
          if (scope === variables) interpretations.push(`Measured ${name} as ${value} radians between two surface references.`);
          continue;
        }
        const surfacePointStatement = statement.match(/^let (.+?) be (?:the )?point (.+?) along (\$[a-z0-9][a-z0-9._/-]*)$/iu);
        if (surfacePointStatement) {
          const factor = scalar(surfacePointStatement[2], scope, 'Surface-reference position');
          const reference = semanticSurfaces.resolveReference(surfacePointStatement[3]);
          const sample = sampleSurfaceReference(reference, factor);
          const name = key(surfacePointStatement[1]);
          vectorVariables.set(name, Object.freeze({ value: Object.freeze([...sample.point]), dimension: 'length', source: reference.name, factor }));
          interpretations.push(`Sampled ${name} at ${factor * 100} percent along $${reference.name}.`);
          continue;
        }
        const surfaceFrameStatement = statement.match(/^let (.+?) be (?:the )?(tangent|normal|outward direction) of (\$[a-z0-9][a-z0-9._/-]*)(?: at (.+?))?$/iu);
        if (surfaceFrameStatement) {
          const reference = semanticSurfaces.resolveReference(surfaceFrameStatement[3]);
          const factor = surfaceFrameStatement[4] ? scalar(surfaceFrameStatement[4], scope, 'Surface-reference frame position') : 0.5;
          const sample = sampleSurfaceReference(reference, factor);
          const component = surfaceFrameStatement[2].toLowerCase() === 'outward direction' ? 'outward' : surfaceFrameStatement[2].toLowerCase();
          const value = sample[component];
          if (!value) {
            const error = new Error(`Surface reference $${reference.name} has no anchored ${component}; use a surface-anchored curve or boundary.`);
            error.code = 'plainform_surface_reference_frame_unavailable'; throw error;
          }
          const name = key(surfaceFrameStatement[1]);
          vectorVariables.set(name, Object.freeze({ value: Object.freeze([...value]), dimension: 'scalar', source: reference.name, factor, component }));
          interpretations.push(`Derived ${component} vector ${name} at ${factor * 100} percent along $${reference.name}.`);
          continue;
        }
        const distanceStatement = statement.match(/^let (.+?) be (?:the )?distance between (.+?) and (.+)$/iu);
        if (distanceStatement) {
          const from = referencePoint(distanceStatement[2]);
          const to = referencePoint(distanceStatement[3]);
          const distance = Math.hypot(...from.map((value, axis) => value - to[axis]));
          const name = key(distanceStatement[1]);
          scope.set(name, Object.freeze({ value: distance, dimension: 'length' }));
          if (scope === variables) interpretations.push(`Measured ${name} as ${distance} metres between exact references.`);
          continue;
        }
        const letStatement = statement.match(/^let (.+?) be (.+)$/iu);
        if (letStatement) {
          const name = key(letStatement[1]);
          const result = evaluate(letStatement[2], scope);
          scope.set(name, result);
          if (scope === variables) interpretations.push(`Defined ${name} as ${result.value} ${result.dimension}.`);
          continue;
        }
        const profileStatement = statement.match(/^create a rectangular profile called (.+?) with width (.+?) and (?:depth|height) (.+?)(?:,? rounded by (.+))?$/iu);
        if (profileStatement) {
          const name = key(profileStatement[1]);
          const width = finitePositive(length(profileStatement[2], scope, 'Profile width'), 'Profile width');
          const depth = finitePositive(length(profileStatement[3], scope, 'Profile depth'), 'Profile depth');
          const radius = profileStatement[4] ? length(profileStatement[4], scope, 'Profile corner radius') : 0;
          profiles.set(name, { name, width, depth, radius, points: rectangularPoints(width, depth, radius), sections: [] });
          interpretations.push(`Defined rectangular profile “${name}” at ${width} by ${depth} metres.`);
          continue;
        }
        const curvedProfile = statement.match(/^create a (?:(symmetric)\s+)?(?:(smooth)\s+)?profile called (.+?) through (.+?)(?:,? mirrored across the?\s*(x|z|right|up)(?:\s+centreline)?)?$/iu);
        if (curvedProfile) {
          const name = key(curvedProfile[3]);
          let points = profilePoints(curvedProfile[4], scope, `Profile ${name}`, designFrame);
          if (points.length < 3) {
            const error = new Error(`Profile “${name}” requires at least three points.`);
            error.code = 'plainform_profile_points'; throw error;
          }
          const authoredMirrorAxis = curvedProfile[5]?.toLowerCase() ?? (curvedProfile[1] ? (semanticFrame ? 'up' : 'z') : null);
          const mirrorAxis = authoredMirrorAxis === 'up' ? 'z' : authoredMirrorAxis === 'right' ? 'x' : authoredMirrorAxis;
          if (mirrorAxis) points = mirroredProfile(points, mirrorAxis);
          if (curvedProfile[2]) points = smoothClosedPoints(points);
          if (points.length > 256) {
            const error = new Error('Profiles support at most 256 evaluated points.');
            error.code = 'plainform_profile_points'; throw error;
          }
          const bounds = profileBounds(points);
          profiles.set(name, { name, width: bounds.width, depth: bounds.depth, radius: 0, points, sections: [], smooth: Boolean(curvedProfile[2]) });
          interpretations.push(`Defined ${curvedProfile[2] ? 'smooth ' : ''}${mirrorAxis ? `symmetric ${authoredMirrorAxis}-centreline ` : ''}profile “${name}” through ${points.length} evaluated points.`);
          continue;
        }
        const guideStatement = statement.match(/^create a (?:(smooth)\s+)?guide curve called (.+?) through (.+?)(?:,? following point (\d+) of (?:the )?profile (.+))?$/iu);
        if (guideStatement) {
          const name = key(guideStatement[2]);
          let points = loftPointGroups(guideStatement[3], scope, `Guide ${name}`);
          if (points.length < 2) {
            const error = new Error(`Guide curve “${name}” requires at least two points.`); error.code = 'plainform_guide_points'; throw error;
          }
          if (guideStatement[1]) {
            points = smoothOpenPoints(points);
          }
          let profileName;
          let profileIndex;
          if (guideStatement[4]) {
            profileName = key(guideStatement[5]);
            const profile = profiles.get(profileName);
            if (!profile) {
              const error = new Error(`Unknown profile “${guideStatement[5]}” for guide “${name}”.`);
              error.code = 'plainform_unknown_profile'; throw error;
            }
            const oneBasedIndex = Number(guideStatement[4]);
            if (!Number.isSafeInteger(oneBasedIndex) || oneBasedIndex < 1 || oneBasedIndex > profile.points.length) {
              const error = new Error(`Guide “${name}” must follow a profile point from 1 through ${profile.points.length}.`);
              error.code = 'plainform_guide_profile_point'; throw error;
            }
            profileIndex = oneBasedIndex - 1;
          }
          guides.set(name, { name, points, ...(profileName ? { profileName, profileIndex } : {}) });
          interpretations.push(`Defined guide curve “${name}” through ${points.length} evaluated points${profileName ? `, following point ${profileIndex + 1} of profile “${profileName}”` : ''}.`);
          continue;
        }
        const surfaceCurveStatement = statement.match(/^create a (?:(closed)\s+)?surface curve called (.+?) on (.+?) through surface points nearest to (local|design) points (.+)$/iu);
        if (surfaceCurveStatement) {
          const name = boundaryReferenceKey(surfaceCurveStatement[2]);
          const closed = Boolean(surfaceCurveStatement[1]);
          const owner = boundaryOwner(surfaceCurveStatement[3]);
          if (!owner.recipe) {
            const error = new Error(`Surface curve owner ${owner.entityId} has no project-owned mesh geometry to anchor against.`);
            error.code = 'plainform_surface_anchor_unavailable'; throw error;
          }
          const coordinateSpace = surfaceCurveStatement[4].toLowerCase();
          const authoredPoints = loftPointGroups(surfaceCurveStatement[5], scope, `Surface curve ${name}`);
          const minimum = closed ? 3 : 2;
          if (authoredPoints.length < minimum || authoredPoints.length > MAX_BOUNDARY_POINTS) {
            const error = new Error(`${closed ? 'Closed' : 'Open'} surface curve “${name}” requires ${minimum} to ${MAX_BOUNDARY_POINTS} points.`);
            error.code = 'plainform_surface_curve_points'; throw error;
          }
          const seedPoints = coordinateSpace === 'local'
            ? authoredPoints.map(point => transformPointByMatrix(owner.matrix, point))
            : authoredPoints.map(point => [...point]);
          const projected = projectSurfaceAnchors({
            recipe: owner.recipe, matrix: owner.matrix, seedPoints, entityId: owner.entityId,
          });
          const points = projected.map(anchor => anchor.point);
          if (new Set(points.map(point => point.map(value => value.toPrecision(12)).join('\u0000'))).size < minimum) {
            const error = new Error(`Surface curve “${name}” projects to fewer than ${minimum} distinct surface points.`);
            error.code = 'plainform_surface_curve_points'; throw error;
          }
          semanticSurfaces.addCurve({
            name, ownerEntityId: owner.entityId, coordinateSpace, closed,
            anchorMode: 'nearestSurface', authoredPoints: authoredPoints.map(point => [...point]),
            points, normals: projected.map(anchor => anchor.normal),
            anchors: projected.map((anchor, index) => persistentAnchor(anchor, seedPoints[index])),
          });
          interpretations.push(`Created ${closed ? 'closed ' : ''}surface curve $${name} on ${owner.entityId} with ${points.length} bounded anchors.`);
          continue;
        }
        const profileProjectionStatement = statement.match(/^project profile (.+?) onto (.+?) as (.+?)(?:,? centred at (\[[^\]]+\]))?(?:,? rotated by (\[[^\]]+\]))?$/iu);
        if (profileProjectionStatement) {
          const profile = profiles.get(key(profileProjectionStatement[1]));
          if (!profile) {
            const error = new Error(`Unknown profile “${profileProjectionStatement[1]}”.`);
            error.code = 'plainform_unknown_profile'; throw error;
          }
          const owner = boundaryOwner(profileProjectionStatement[2]);
          if (!owner.recipe) {
            const error = new Error(`Projection owner ${owner.entityId} has no project-owned mesh geometry to project onto.`);
            error.code = 'plainform_surface_anchor_unavailable'; throw error;
          }
          const position = profileProjectionStatement[4]
            ? loftVector(profileProjectionStatement[4], scope, 'Profile projection centre') : [0, 0, 0];
          const rotation = profileProjectionStatement[5]
            ? evaluateDesignVector(profileProjectionStatement[5], scope, 'angle') : [0, 0, 0];
          const projectionMatrix = composeTransformMatrix({ position, rotation, scale: [1, 1, 1] });
          const seedPoints = profile.points.map(point => transformPointByMatrix(projectionMatrix, point));
          const projected = projectSurfaceAnchors({ recipe: owner.recipe, matrix: owner.matrix, seedPoints, entityId: owner.entityId });
          const name = boundaryReferenceKey(profileProjectionStatement[3]);
          semanticSurfaces.addCurve({
            name, ownerEntityId: owner.entityId, coordinateSpace: 'design', closed: true,
            anchorMode: 'nearestSurface', authoredPoints: seedPoints.map(point => [...point]),
            points: projected.map(anchor => anchor.point), normals: projected.map(anchor => anchor.normal),
            anchors: projected.map((anchor, index) => persistentAnchor(anchor, seedPoints[index])),
            projection: { kind: 'profile', profile: profile.name, position, rotation },
          });
          interpretations.push(`Projected profile “${profile.name}” onto ${owner.entityId} as closed surface curve $${name}.`);
          continue;
        }
        const referenceProjectionStatement = statement.match(/^project (\$[a-z0-9][a-z0-9._/-]*) onto (.+?) as (.+)$/iu);
        if (referenceProjectionStatement) {
          const sourceReference = semanticSurfaces.resolveReference(referenceProjectionStatement[1]);
          const owner = boundaryOwner(referenceProjectionStatement[2]);
          if (!owner.recipe) {
            const error = new Error(`Projection owner ${owner.entityId} has no project-owned mesh geometry to project onto.`);
            error.code = 'plainform_surface_anchor_unavailable'; throw error;
          }
          const seedPoints = sourceReference.points.map(point => [...point]);
          const projected = projectSurfaceAnchors({ recipe: owner.recipe, matrix: owner.matrix, seedPoints, entityId: owner.entityId });
          const name = boundaryReferenceKey(referenceProjectionStatement[3]);
          semanticSurfaces.addCurve({
            name, ownerEntityId: owner.entityId, coordinateSpace: 'design', closed: Boolean(sourceReference.closed),
            anchorMode: 'nearestSurface', authoredPoints: seedPoints.map(point => [...point]),
            points: projected.map(anchor => anchor.point), normals: projected.map(anchor => anchor.normal),
            anchors: projected.map((anchor, index) => persistentAnchor(anchor, seedPoints[index])),
            projection: { kind: 'surfaceReference', source: { name: sourceReference.name, kind: sourceReference.referenceKind } },
          });
          interpretations.push(`Projected $${sourceReference.name} onto ${owner.entityId} as surface curve $${name}.`);
          continue;
        }
        const surfaceOffsetStatement = statement.match(/^create a surface offset curve called (.+?) from (\$[a-z0-9][a-z0-9._/-]*) by (.+?)(?: to the (left|right))?$/iu);
        if (surfaceOffsetStatement) {
          const sourceReference = semanticSurfaces.resolveReference(surfaceOffsetStatement[2]);
          if (sourceReference.referenceKind !== 'surfaceCurve') {
            const error = new Error(`Surface offset requires a surface curve; $${sourceReference.name} is a patch boundary.`);
            error.code = 'plainform_surface_curve_required'; throw error;
          }
          const owner = semanticSurfaceOwner(sourceReference.ownerEntityId);
          const distance = finitePositive(length(surfaceOffsetStatement[3], scope, 'Surface offset distance'), 'Surface offset distance');
          const name = boundaryReferenceKey(surfaceOffsetStatement[1]);
          const curve = offsetSurfaceCurve({
            owner, curve: sourceReference, distance, name, side: surfaceOffsetStatement[4]?.toLowerCase() ?? 'left',
          });
          semanticSurfaces.addCurve(curve);
          interpretations.push(`Created surface-space offset curve $${name} ${distance} metres from $${sourceReference.name}.`);
          continue;
        }
        const refineRegionStatement = statement.match(/^subdivide (?:the )?surface region (.+?) locally by (\d+) levels?(?:,? then relax it for (\d+) iterations? with strength (.+))?$/iu);
        if (refineRegionStatement) {
          const region = semanticSurfaces.resolveRegion(refineRegionStatement[1]);
          const owner = semanticDeformationOwner(region.ownerEntityId);
          const levels = Number(refineRegionStatement[2]);
          const relaxIterations = refineRegionStatement[3] ? Number(refineRegionStatement[3]) : 0;
          const relaxStrength = refineRegionStatement[4]
            ? scalar(refineRegionStatement[4], scope, 'Surface relaxation strength') : 0.5;
          const result = refineSurfaceRegion({
            owner, region, levels, relaxIterations, relaxStrength,
            resolveReference: name => semanticSurfaces.resolveReference(name),
          });
          owner.recipe = result.recipe;
          const intent = {
            kind: 'localRefinement', ownerEntityId: owner.entityId, region: region.name,
            levels, relaxIterations, relaxStrength,
            refinedFaceCount: result.refinedFaceCount, refinedVertexCount: result.refinedVertexCount,
          };
          semanticSurfaces.addDeformation(intent);
          interpretations.push(`Subdivided surface region “${region.name}” by ${levels} levels and relaxed it for ${relaxIterations} iterations.`);
          continue;
        }
        const mirrorStatement = statement.match(/^create (.+?) as the mirror of (.+?) across the (x|y|z|right|up|forward) centre plane(?: with id ([a-z0-9][a-z0-9._/-]*))?$/iu);
        if (mirrorStatement) {
          const targetName = clean(mirrorStatement[1]);
          const sourceName = clean(mirrorStatement[2]);
          const targetKey = key(targetName); const sourceKey = key(sourceName);
          const authoredAxis = mirrorStatement[3].toLowerCase();
          const axis = semanticFrame
            ? ({ right: 'x', up: 'z', forward: 'y' }[authoredAxis] ?? authoredAxis)
            : authoredAxis;
          const profile = profiles.get(sourceKey);
          const guide = guides.get(sourceKey);
          if (profile) {
            const points = profile.points.map(point => mirrorVector(point, axis));
            profiles.set(targetKey, { ...structuredClone(profile), name: targetKey, points, sections: [] });
          } else if (guide) {
            guides.set(targetKey, { name: targetKey, points: guide.points.map(point => mirrorVector(point, axis)) });
          } else if (semanticSurfaces.hasReference(sourceName)) {
            const reference = semanticSurfaces.resolveReference(sourceName);
            const owner = semanticSurfaceOwner(reference.ownerEntityId);
            const seedPoints = reference.points.map(point => mirrorVector(point, axis));
            const projected = projectSurfaceAnchors({ recipe: owner.recipe, matrix: owner.matrix, seedPoints, entityId: owner.entityId });
            const mirrored = {
              name: boundaryReferenceKey(targetName), ownerEntityId: owner.entityId,
              coordinateSpace: 'design', closed: Boolean(reference.closed), anchorMode: 'nearestSurface',
              authoredPoints: seedPoints.map(point => [...point]), points: projected.map(anchor => anchor.point),
              normals: projected.map(anchor => anchor.normal),
              anchors: projected.map((anchor, index) => persistentAnchor(anchor, seedPoints[index])),
              projection: { kind: 'mirror', source: reference.name, axis },
            };
            if (reference.referenceKind === 'surfaceCurve') semanticSurfaces.addCurve(mirrored);
            else boundaries.set(mirrored.name, mirrored);
          } else {
            const source = generatedEntity(sourceName);
            if (!source) {
              const error = new Error(`No profile, guide, surface reference, or generated object named “${sourceName}” can be mirrored.`);
              error.code = 'plainform_mirror_source'; throw error;
            }
            const owner = boundaryOwner(source.id ?? source.entityId);
            const mesh = realizeSurfaceTriangles({ recipe: owner.recipe, matrix: owner.matrix, entityId: owner.entityId });
            const identity = composeTransformMatrix({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
            addGeneratedSolid({
              id: mirrorStatement[4] ?? `entity/${designSlug}/${slug(targetName)}`,
              name: targetName,
              recipe: mirrorEvaluatedSurface({ mesh, ownerMatrix: identity, axis }),
              materialId: source.components?.mesh?.materialId ?? source.materialId,
            });
          }
          interpretations.push(`Created “${targetName}” as the exact ${authoredAxis}-centre-plane mirror of “${sourceName}”.`);
          continue;
        }
        const betweenRegionStatement = statement.match(/^name the surface between (\$[a-z0-9][a-z0-9._/-]*) and (\$[a-z0-9][a-z0-9._/-]*) as (.+)$/iu);
        if (betweenRegionStatement) {
          const region = semanticSurfaces.addBetweenRegion({
            name: betweenRegionStatement[3],
            firstReference: betweenRegionStatement[1],
            secondReference: betweenRegionStatement[2],
          });
          interpretations.push(`Named surface region “${region.name}” between $${boundaryReferenceKey(betweenRegionStatement[1])} and $${boundaryReferenceKey(betweenRegionStatement[2])}.`);
          continue;
        }
        const curveDistanceRegionStatement = statement.match(/^name the surface within (.+?) of (\$[a-z0-9][a-z0-9._/-]*) as (.+)$/iu);
        if (curveDistanceRegionStatement) {
          const distance = finitePositive(length(curveDistanceRegionStatement[1], scope, 'Surface region distance'), 'Surface region distance');
          const region = semanticSurfaces.addCurveDistanceRegion({
            name: curveDistanceRegionStatement[3], reference: curveDistanceRegionStatement[2], distance,
          });
          interpretations.push(`Named surface region “${region.name}” within ${distance} metres of $${boundaryReferenceKey(curveDistanceRegionStatement[2])}.`);
          continue;
        }
        const enclosedRegionStatement = statement.match(/^name the surface enclosed by (\$[a-z0-9][a-z0-9._/-]*) as (.+)$/iu);
        if (enclosedRegionStatement) {
          const region = semanticSurfaces.addEnclosedRegion({
            name: enclosedRegionStatement[2], reference: enclosedRegionStatement[1],
          });
          interpretations.push(`Named surface region “${region.name}” enclosed by $${boundaryReferenceKey(enclosedRegionStatement[1])}.`);
          continue;
        }
        const pointRegionStatement = statement.match(/^name the surface on (.+?) around (\[[^\]]+\]) within (.+?) as (.+)$/iu);
        if (pointRegionStatement) {
          const owner = boundaryOwner(pointRegionStatement[1]);
          if (!owner.recipe) {
            const error = new Error(`Surface region owner ${owner.entityId} has no project-owned mesh geometry to anchor against.`);
            error.code = 'plainform_surface_anchor_unavailable'; throw error;
          }
          const seedPoint = loftVector(pointRegionStatement[2], scope, 'Surface-region centre');
          const radius = finitePositive(length(pointRegionStatement[3], scope, 'Surface region radius'), 'Surface region radius');
          const [projected] = projectSurfaceAnchors({ recipe: owner.recipe, matrix: owner.matrix, seedPoints: [seedPoint], entityId: owner.entityId });
          const region = semanticSurfaces.addRegion({
            name: pointRegionStatement[4], ownerEntityId: owner.entityId,
            definition: { kind: 'surfaceRadius', center: [...projected.point], radius },
            anchor: {
              seedPoint: [...seedPoint], projectedPoint: [...projected.point], normal: [...projected.normal],
              triangleIndex: projected.triangleIndex, barycentric: [...projected.barycentric],
            },
          });
          interpretations.push(`Named surface region “${region.name}” within ${radius} metres of one anchored point on ${owner.entityId}.`);
          continue;
        }
        const ambiguousRegionStatement = statement.match(/^name the (?:surface )?region around (\$[a-z0-9][a-z0-9._/-]*) as (.+)$/iu);
        if (ambiguousRegionStatement) {
          const error = new Error(`Surface region “${ambiguousRegionStatement[2]}” needs an explicit extent. Use “Name the surface within <distance> of ${ambiguousRegionStatement[1]} as <name>.”`);
          error.code = 'plainform_surface_region_extent_required'; throw error;
        }
        const curveDeformationStatement = statement.match(/^(raise|lower|inset|bulge|pinch) the surface along (.+?) by (.+?) with a smooth falloff of (.+)$/iu);
        if (curveDeformationStatement) {
          const operation = curveDeformationStatement[1].toLowerCase();
          const curve = semanticSurfaces.resolveReference(curveDeformationStatement[2]);
          if (curve.referenceKind !== 'surfaceCurve') {
            const error = new Error(`Surface deformation along $${curve.name} requires a surface curve, not a patch boundary.`);
            error.code = 'plainform_surface_curve_required'; throw error;
          }
          const magnitude = finitePositive(length(curveDeformationStatement[3], scope, 'Surface deformation amount'), 'Surface deformation amount');
          const falloff = finitePositive(length(curveDeformationStatement[4], scope, 'Surface deformation falloff'), 'Surface deformation falloff');
          const amount = ['lower', 'inset', 'pinch'].includes(operation) ? -magnitude : magnitude;
          const owner = semanticDeformationOwner(curve.ownerEntityId);
          const result = deformAlongSurfaceCurve({ owner, curve, amount, falloff });
          owner.recipe = result.recipe;
          semanticSurfaces.addDeformation({
            kind: 'curveDisplacement', operation, ownerEntityId: owner.entityId,
            reference: { name: curve.name, kind: curve.referenceKind }, amount, falloff,
            affectedVertexCount: result.affectedVertexCount,
          });
          interpretations.push(`${operation[0].toUpperCase()}${operation.slice(1)}d the surface along $${curve.name} by ${magnitude} metres with ${falloff} metres of smooth falloff.`);
          continue;
        }
        const regionDeformationStatement = statement.match(/^(raise|lower|inset|bulge|pinch) (.+?) by (.+?),? falling off smoothly over (.+)$/iu);
        if (regionDeformationStatement) {
          const operation = regionDeformationStatement[1].toLowerCase();
          const region = semanticSurfaces.resolveRegion(regionDeformationStatement[2]);
          const magnitude = finitePositive(length(regionDeformationStatement[3], scope, 'Surface deformation amount'), 'Surface deformation amount');
          const falloff = finitePositive(length(regionDeformationStatement[4], scope, 'Surface deformation falloff'), 'Surface deformation falloff');
          const amount = ['lower', 'inset', 'pinch'].includes(operation) ? -magnitude : magnitude;
          const owner = semanticDeformationOwner(region.ownerEntityId);
          const result = deformSurfaceRegion({
            owner, region, amount, falloff,
            resolveReference: name => semanticSurfaces.resolveReference(name),
          });
          owner.recipe = result.recipe;
          semanticSurfaces.addDeformation({
            kind: 'regionDisplacement', operation, ownerEntityId: owner.entityId,
            region: region.name, amount, falloff, affectedVertexCount: result.affectedVertexCount,
          });
          interpretations.push(`${operation[0].toUpperCase()}${operation.slice(1)}d surface region “${region.name}” by ${magnitude} metres with ${falloff} metres of smooth falloff.`);
          continue;
        }
        const boundaryStatement = statement.match(/^name a boundary called (.+?) on (.+?) through (local|design) points (.+)$/iu);
        const surfaceBoundaryStatement = statement.match(/^name a (?:surface-anchored )?boundary called (.+?) on (.+?) through surface points nearest to (local|design) points (.+)$/iu);
        if (surfaceBoundaryStatement) {
          const name = boundaryReferenceKey(surfaceBoundaryStatement[1]);
          if (semanticSurfaces.hasReference(name)) {
            const error = new Error(`Boundary “${name}” is already defined in this design.`);
            error.code = 'plainform_boundary_exists'; throw error;
          }
          if (boundaries.size >= MAX_BOUNDARIES) {
            const error = new Error(`Design Plainform supports at most ${MAX_BOUNDARIES} named boundaries.`);
            error.code = 'plainform_boundary_limit'; throw error;
          }
          const owner = boundaryOwner(surfaceBoundaryStatement[2]);
          if (!owner.recipe) {
            const error = new Error(`Boundary owner ${owner.entityId} has no project-owned mesh geometry to anchor against.`);
            error.code = 'plainform_surface_anchor_unavailable'; throw error;
          }
          const coordinateSpace = surfaceBoundaryStatement[3].toLowerCase();
          const authoredPoints = loftPointGroups(surfaceBoundaryStatement[4], scope, `Surface boundary ${name}`);
          if (authoredPoints.length < 3 || authoredPoints.length > MAX_BOUNDARY_POINTS) {
            const error = new Error(`Boundary “${name}” requires 3 to ${MAX_BOUNDARY_POINTS} points.`);
            error.code = 'plainform_boundary_points'; throw error;
          }
          const seedPoints = coordinateSpace === 'local'
            ? authoredPoints.map(point => transformPointByMatrix(owner.matrix, point))
            : authoredPoints.map(point => [...point]);
          const projected = projectSurfaceAnchors({
            recipe: owner.recipe, matrix: owner.matrix, seedPoints, entityId: owner.entityId,
          });
          const points = projected.map(anchor => anchor.point);
          if (new Set(points.map(point => point.map(value => value.toPrecision(12)).join('\u0000'))).size < 3) {
            const error = new Error(`Boundary “${name}” projects to fewer than three distinct surface points.`);
            error.code = 'plainform_boundary_points'; throw error;
          }
          boundaries.set(name, {
            name, ownerEntityId: owner.entityId, coordinateSpace, anchorMode: 'nearestSurface',
            authoredPoints: authoredPoints.map(point => [...point]),
            points, normals: projected.map(anchor => anchor.normal),
            anchors: projected.map((anchor, index) => persistentAnchor(anchor, seedPoints[index])),
          });
          interpretations.push(`Anchored boundary $${name} to the nearest surface of ${owner.entityId} at ${points.length} bounded samples.`);
          continue;
        }
        if (boundaryStatement) {
          const name = boundaryReferenceKey(boundaryStatement[1]);
          if (semanticSurfaces.hasReference(name)) {
            const error = new Error(`Boundary “${name}” is already defined in this design.`);
            error.code = 'plainform_boundary_exists'; throw error;
          }
          if (boundaries.size >= MAX_BOUNDARIES) {
            const error = new Error(`Design Plainform supports at most ${MAX_BOUNDARIES} named boundaries.`);
            error.code = 'plainform_boundary_limit'; throw error;
          }
          const owner = boundaryOwner(boundaryStatement[2]);
          const coordinateSpace = boundaryStatement[3].toLowerCase();
          const authoredPoints = loftPointGroups(boundaryStatement[4], scope, `Boundary ${name}`);
          if (authoredPoints.length < 3 || authoredPoints.length > MAX_BOUNDARY_POINTS) {
            const error = new Error(`Boundary “${name}” requires 3 to ${MAX_BOUNDARY_POINTS} points.`);
            error.code = 'plainform_boundary_points'; throw error;
          }
          if (new Set(authoredPoints.map(point => point.join('\u0000'))).size < 3) {
            const error = new Error(`Boundary “${name}” requires at least three distinct points.`);
            error.code = 'plainform_boundary_points'; throw error;
          }
          const points = coordinateSpace === 'local'
            ? authoredPoints.map(point => transformPointByMatrix(owner.matrix, point))
            : authoredPoints.map(point => [...point]);
          boundaries.set(name, {
            name, ownerEntityId: owner.entityId,
            coordinateSpace,
            authoredPoints: authoredPoints.map(point => [...point]),
            points,
          });
          interpretations.push(`Named boundary $${name} on ${owner.entityId} through ${points.length} constrained ${coordinateSpace}-space points.`);
          continue;
        }
        const smoothProfileStatement = statement.match(/^(?:smooth|round the transitions of) (?:profile )?(.+?)(?: with (\d+) samples)?$/iu);
        if (smoothProfileStatement) {
          const profile = profiles.get(key(smoothProfileStatement[1]));
          if (!profile) { const error = new Error(`Unknown profile “${smoothProfileStatement[1]}”.`); error.code = 'plainform_unknown_profile'; throw error; }
          const samples = smoothProfileStatement[2] ? Number(smoothProfileStatement[2]) : Math.min(128, Math.max(12, profile.points.length * 4));
          if (!Number.isSafeInteger(samples) || samples < 3 || samples > 256) {
            const error = new Error('Profile smoothing requires 3 to 256 samples.'); error.code = 'plainform_profile_points'; throw error;
          }
          profile.points = smoothClosedPoints(profile.points, samples);
          Object.assign(profile, profileBounds(profile.points), { smooth: true });
          interpretations.push(`Smoothed profile “${profile.name}” to ${samples} deterministic samples.`);
          continue;
        }
        const moveProfilePoint = statement.match(/^move profile point (\d+) of (.+?) by (\[.+\])$/iu);
        if (moveProfilePoint) {
          const profile = profiles.get(key(moveProfilePoint[2]));
          if (!profile) { const error = new Error(`Unknown profile “${moveProfilePoint[2]}”.`); error.code = 'plainform_unknown_profile'; throw error; }
          const pointIndex = Number(moveProfilePoint[1]);
          if (!Number.isSafeInteger(pointIndex) || pointIndex < 0 || pointIndex >= profile.points.length) {
            const error = new Error(`Profile point ${pointIndex} is outside profile “${profile.name}”.`); error.code = 'plainform_profile_point_index'; throw error;
          }
          const offset = loftVector(moveProfilePoint[3], scope, 'Profile point offset');
          profile.points[pointIndex] = profile.points[pointIndex].map((value, axis) => value + offset[axis]);
          Object.assign(profile, profileBounds(profile.points));
          interpretations.push(`Moved profile point ${pointIndex} of “${profile.name}” by ${offset.join(', ')} metres.`);
          continue;
        }
        const loop = statement.match(/^for every (?:floor|level|item)?\s*([a-z][a-z0-9_]*) from (.+?) through (.+)$/iu);
        if (loop) {
          let depth = 1;
          let close = lineIndex + 1;
          for (; close < end; close += 1) {
            const nested = clean(lines[close]);
            if (/^for every\b/iu.test(nested)) depth += 1;
            else if (/^end$/iu.test(nested)) depth -= 1;
            if (depth === 0) break;
          }
          if (depth !== 0) { const error = new Error(`Loop on statement ${lineIndex + 1} has no End.`); error.code = 'plainform_missing_end'; throw error; }
          const first = scalar(loop[2], scope, 'Loop start');
          const last = scalar(loop[3], scope, 'Loop end');
          if (![first, last].every(Number.isSafeInteger) || last < first || last - first + 1 > MAX_LOOP_ITERATIONS) {
            const error = new Error(`Design loops require ascending integer bounds and at most ${MAX_LOOP_ITERATIONS} iterations.`);
            error.code = 'plainform_loop_bounds'; throw error;
          }
          for (let index = first; index <= last; index += 1) {
            const inner = new Map(scope);
            inner.set(key(loop[1]), Object.freeze({ value: index, dimension: 'scalar' }));
            inner.set('index', Object.freeze({ value: index, dimension: 'scalar' }));
            inner.set('number', Object.freeze({ value: index - first + 1, dimension: 'scalar' }));
            execute(lineIndex + 1, close, inner);
          }
          interpretations.push(`Evaluated ${last - first + 1} bounded iterations for ${loop[1]}.`);
          lineIndex = close;
          continue;
        }
        if (/^end$/iu.test(statement)) continue;

        const semanticControlledSection = semanticFrame
          ? statement.match(/^add a controlled section of (.+?) at ([^,]+?)\s+(forward|backward)(?:,\s*(.+))?$/iu)
          : null;
        const legacyControlledSection = statement.match(/^add a controlled section of (.+?) at height ([^,]+)(?:,\s*(.+))?$/iu);
        if (semanticFrame && legacyControlledSection) {
          const error = new Error('A semantic design section cannot use “at height” for a path station. Use “at <length> forward” or “at <length> backward”.');
          error.code = 'plainform_design_frame_ambiguous_station'; throw error;
        }
        const controlledSection = semanticControlledSection ?? legacyControlledSection;
        if (controlledSection) {
          const profile = profiles.get(key(controlledSection[1]));
          if (!profile) { const error = new Error(`Unknown profile “${controlledSection[1]}”.`); error.code = 'plainform_unknown_profile'; throw error; }
          const authoredStation = length(controlledSection[2], scope, 'Section station');
          const pathHeight = semanticControlledSection
            ? authoredStation * (controlledSection[3].toLowerCase() === 'forward' ? -1 : 1)
            : authoredStation;
          const options = semanticControlledSection ? (controlledSection[4] ?? '') : (controlledSection[3] ?? '');
          const widthMatch = options.match(/(?:set )?width (?:to )?([^,]+)/iu);
          const depthMatch = options.match(/(?:set )?(?:depth|height) (?:to )?([^,]+)/iu);
          const offsetMatch = options.match(/offset by (\[[^\]]+\])/iu);
          const verticalMatch = options.match(/offset vertically by ([^,]+)/iu);
          const lateralMatch = options.match(/offset laterally by ([^,]+)/iu);
          const rotationMatch = options.match(/rotated by (\[[^\]]+\])/iu);
          const scaleMatch = options.match(/scaled locally by (\[[^\]]+\])/iu);
          const desiredWidth = widthMatch ? finitePositive(length(widthMatch[1], scope, 'Section width'), 'Section width') : profile.width;
          const desiredDepth = depthMatch ? finitePositive(length(depthMatch[1], scope, 'Section depth'), 'Section depth') : profile.depth;
          const authoredScale = scaleMatch ? evaluateDesignVector(scaleMatch[1], scope, 'scalar') : [1, 1, 1];
          const independentScale = semanticFrame ? [authoredScale[0], authoredScale[2], authoredScale[1]] : authoredScale;
          if (independentScale.some(value => !Number.isFinite(value) || value <= 0)) {
            const error = new Error('Local section scales must be greater than zero.'); error.code = 'plainform_design_dimension'; throw error;
          }
          const offset = offsetMatch ? loftVector(offsetMatch[1], scope, 'Section offset') : [0, 0, 0];
          if (verticalMatch) offset[semanticFrame ? 2 : 1] += length(verticalMatch[1], scope, 'Vertical section offset');
          if (lateralMatch) offset[semanticFrame ? 0 : 2] += length(lateralMatch[1], scope, 'Lateral section offset');
          const rotation = rotationMatch ? evaluateDesignVector(rotationMatch[1], scope, 'angle') : [0, 0, 0];
          profile.sections.push({
            id: `section/${slug(profile.name)}-${String(profile.sections.length + 1).padStart(3, '0')}`,
            points: profile.points.map(point => [...point]),
            transform: {
              translation: [offset[0], pathHeight + offset[1], offset[2]],
              rotation,
              scale: [desiredWidth / profile.width * independentScale[0], independentScale[1], desiredDepth / profile.depth * independentScale[2]],
            },
          });
          continue;
        }

        const semanticSection = semanticFrame
          ? statement.match(/^add a section of (.+?) at (.+?)\s+(forward|backward)(?:,? rotated around (?:up|y) by (.+?))?(?:,? and scaled horizontally by (.+))?$/iu)
          : null;
        const legacySection = statement.match(/^add a section of (.+?) at height (.+?)(?:,? rotated around y by (.+?))?(?:,? and scaled horizontally by (.+))?$/iu);
        if (semanticFrame && legacySection) {
          const error = new Error('A semantic design section cannot use “at height” for a path station. Use “at <length> forward” or “at <length> backward”.');
          error.code = 'plainform_design_frame_ambiguous_station'; throw error;
        }
        const section = semanticSection ?? legacySection;
        if (section) {
          const profile = profiles.get(key(section[1]));
          if (!profile) { const error = new Error(`Unknown profile “${section[1]}”.`); error.code = 'plainform_unknown_profile'; throw error; }
          const authoredStation = length(section[2], scope, 'Section station');
          const height = semanticSection ? authoredStation * (section[3].toLowerCase() === 'forward' ? -1 : 1) : authoredStation;
          const rotationSource = semanticSection ? section[4] : section[3];
          const scaleSource = semanticSection ? section[5] : section[4];
          const rotation = rotationSource ? angle(rotationSource, scope, 'Section rotation') : 0;
          const scale = scaleSource ? finitePositive(scalar(scaleSource, scope, 'Section scale'), 'Section scale') : 1;
          profile.sections.push({
            id: `section/${slug(profile.name)}-${String(profile.sections.length + 1).padStart(3, '0')}`,
            points: profile.points.map(point => [...point]),
            transform: { translation: [0, height, 0], rotation: [0, rotation, 0], scale: [scale, 1, scale] },
          });
          continue;
        }

        const plate = statement.match(/^create a floor plate from (.+?) at height (.+?)(?:,? with thickness (.+?))?(?:,? rotated around y by (.+?))?(?:,? and scaled horizontally by (.+))?$/iu);
        if (plate) {
          const profile = profiles.get(key(plate[1]));
          if (!profile) { const error = new Error(`Unknown profile “${plate[1]}”.`); error.code = 'plainform_unknown_profile'; throw error; }
          const height = length(plate[2], scope, 'Floor height');
          const thickness = plate[3] ? finitePositive(length(plate[3], scope, 'Floor thickness'), 'Floor thickness') : 0.2;
          const rotation = plate[4] ? angle(plate[4], scope, 'Floor rotation') : 0;
          const scale = plate[5] ? finitePositive(scalar(plate[5], scope, 'Floor scale'), 'Floor scale') : 1;
          autoNumber += 1;
          addEntity({
            id: `entity/${designSlug}/floor-${String(autoNumber).padStart(3, '0')}`,
            name: `${designName} floor ${autoNumber}`, kind: 'box',
            dimensions: { width: profile.width * scale, height: thickness, depth: profile.depth * scale },
            position: [0, height, 0], rotation: [0, rotation, 0],
          });
          continue;
        }

        const box = statement.match(/^create a box called (.+?)(?: with id ([a-z0-9{}._/-]+))?,? with width (.+?)(?=,\s*height),\s*height (.+?)(?=,\s*(?:and )?depth),\s*(?:and )?depth (.+?)(?=,\s*cent(?:er|r)ed|,\s*rotated|,\s*using material|$)(?:,? cent(?:er|r)ed at (\[.+?\]))?(?:,? rotated by (\[.+?\]))?(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu);
        if (box) {
          autoNumber += 1;
          const name = interpolate(quoteName(box[1]), scope);
          addEntity({
            id: box[2] ? interpolate(box[2], scope) : `entity/${designSlug}/${slug(name)}-${String(autoNumber).padStart(3, '0')}`,
            name, kind: 'box',
            dimensions: {
              width: length(box[3], scope, 'Box width'), height: length(box[4], scope, 'Box height'), depth: length(box[5], scope, 'Box depth'),
            },
            position: box[6] ? designVector(box[6], scope, 'length', 'Box centre') : [0, 0, 0],
            rotation: box[7] ? evaluateDesignVector(box[7], scope, 'angle') : [0, 0, 0],
            materialId: box[8],
          });
          continue;
        }

        const sphere = statement.match(/^create a sphere called (.+?)(?: with id ([a-z0-9{}._/-]+))?,? with radius (.+?)(?=,\s*cent(?:er|r)ed|,\s*using material|$)(?:,? cent(?:er|r)ed at (\[.+?\]))?(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu);
        if (sphere) {
          autoNumber += 1;
          const name = interpolate(quoteName(sphere[1]), scope);
          const radius = finitePositive(length(sphere[3], scope, 'Sphere radius'), 'Sphere radius');
          addEntity({
            id: sphere[2] ? interpolate(sphere[2], scope) : `entity/${designSlug}/${slug(name)}-${String(autoNumber).padStart(3, '0')}`,
            name, kind: 'sphere', shape: 'sphere',
            dimensions: { width: radius * 2, height: radius * 2, depth: radius * 2, radius },
            position: sphere[4] ? designVector(sphere[4], scope, 'length', 'Sphere centre') : [0, 0, 0],
            materialId: sphere[5],
          });
          continue;
        }

        const ellipsoid = statement.match(/^create an ellipsoid called (.+?)(?: with id ([a-z0-9{}._/-]+))?,? with width (.+?)(?=,\s*height),\s*height (.+?)(?=,\s*(?:and )?depth),\s*(?:and )?depth (.+?)(?=,\s*cent(?:er|r)ed|,\s*rotated|,\s*using material|$)(?:,? cent(?:er|r)ed at (\[.+?\]))?(?:,? rotated by (\[.+?\]))?(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu);
        if (ellipsoid) {
          autoNumber += 1;
          const name = interpolate(quoteName(ellipsoid[1]), scope);
          addEntity({
            id: ellipsoid[2] ? interpolate(ellipsoid[2], scope) : `entity/${designSlug}/${slug(name)}-${String(autoNumber).padStart(3, '0')}`,
            name, kind: 'sphere', shape: 'ellipsoid',
            dimensions: {
              width: length(ellipsoid[3], scope, 'Ellipsoid width'),
              height: length(ellipsoid[4], scope, 'Ellipsoid height'),
              depth: length(ellipsoid[5], scope, 'Ellipsoid depth'),
            },
            position: ellipsoid[6] ? designVector(ellipsoid[6], scope, 'length', 'Ellipsoid centre') : [0, 0, 0],
            rotation: ellipsoid[7] ? evaluateDesignVector(ellipsoid[7], scope, 'angle') : [0, 0, 0],
            materialId: ellipsoid[8],
          });
          continue;
        }

        const eyePair = statement.match(/^create a coordinated eye pair called (.+?) with id ([a-z0-9][a-z0-9._/-]*),? cent(?:er|r)ed at (\[.+?\]), separated by (.+?), with eye width (.+?), eye height (.+?), (?:and )?eye depth (.+?), looking at (\[.+?\])(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu);
        if (eyePair) {
          const name = quoteName(eyePair[1]); const assemblyId = eyePair[2];
          const centre = designVector(eyePair[3], scope, 'length', 'Eye-pair centre');
          const separation = finitePositive(length(eyePair[4], scope, 'Eye separation'), 'Eye separation');
          const dimensions = {
            width: finitePositive(length(eyePair[5], scope, 'Eye width'), 'Eye width'),
            height: finitePositive(length(eyePair[6], scope, 'Eye height'), 'Eye height'),
            depth: finitePositive(length(eyePair[7], scope, 'Eye depth'), 'Eye depth'),
          };
          const targetPosition = designVector(eyePair[8], scope, 'length', 'Shared gaze target');
          const targetId = `${assemblyId}/gaze-target`; const leftId = `${assemblyId}/left`; const rightId = `${assemblyId}/right`;
          for (const id of [assemblyId, targetId, leftId, rightId]) {
            if (occupied.has(id) || ids.has(id)) {
              const error = new Error(`Coordinated eye ID ${id} already exists.`); error.code = 'plainform_id_conflict'; throw error;
            }
          }
          ids.add(assemblyId); ids.add(targetId);
          const rootMatrix = composeTransformMatrix(rootTransform);
          const groupTransform = semanticFrame
            ? relativeEntityTransform(rootMatrix, composeTransformMatrix({ position: centre, rotation: [0, 0, 0], scale: [1, 1, 1] }))
            : { position: centre, rotation: [0, 0, 0], scale: [1, 1, 1] };
          const targetTransform = semanticFrame
            ? relativeEntityTransform(rootMatrix, composeTransformMatrix({ position: targetPosition, rotation: [0, 0, 0], scale: [1, 1, 1] }))
            : { position: targetPosition, rotation: [0, 0, 0], scale: [1, 1, 1] };
          entities.push({ id: assemblyId, kind: 'group', name, parentId: rootId, transform: groupTransform, metadata: { plainformDesign: { primitive: 'coordinatedEyePair', targetId, separation, dimensions } } });
          entities.push({ id: targetId, kind: 'group', name: `${name} gaze target`, parentId: rootId, transform: targetTransform, visible: false, metadata: { plainformDesign: { primitive: 'gazeTarget', eyePairId: assemblyId } } });
          addEntity({
            id: leftId, name: `${name} left eye`, kind: 'sphere', shape: 'ellipsoid', dimensions,
            position: [-separation / 2, 0, 0], parentId: assemblyId, materialId: eyePair[9],
            extraComponents: { constraints: [{ id: `${leftId}/look-at`, type: 'lookAt', targetId }] },
            metadata: { eyePairId: assemblyId, gazeTargetId: targetId, side: 'left' },
          });
          addEntity({
            id: rightId, name: `${name} right eye`, kind: 'sphere', shape: 'ellipsoid', dimensions,
            position: [separation / 2, 0, 0], parentId: assemblyId, materialId: eyePair[9],
            extraComponents: { constraints: [{ id: `${rightId}/look-at`, type: 'lookAt', targetId }] },
            metadata: { eyePairId: assemblyId, gazeTargetId: targetId, side: 'right' },
          });
          aliases[key(name)] = [leftId, rightId];
          interpretations.push(`Created coordinated eye pair “${name}” with shared gaze target ${targetId}.`);
          continue;
        }

        const capsule = statement.match(/^create a capsule called (.+?)(?: with id ([a-z0-9{}._/-]+))?,? with radius (.+?) and body length (.+?)(?=,\s*cent(?:er|r)ed|,\s*rotated|,\s*aligned|,\s*using material|$)(?:,? cent(?:er|r)ed at (\[.+?\]))?(?:,? rotated by (\[.+?\]))?(?:,? aligned along (?:the )?(right|left|up|down|forward|backward)(?: axis| direction)?)?(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu);
        if (capsule) {
          autoNumber += 1;
          const name = interpolate(quoteName(capsule[1]), scope);
          const radius = finitePositive(length(capsule[3], scope, 'Capsule radius'), 'Capsule radius');
          const bodyLength = finitePositive(length(capsule[4], scope, 'Capsule body length'), 'Capsule body length');
          addGeneratedSolid({
            id: capsule[2] ? interpolate(capsule[2], scope) : `entity/${designSlug}/${slug(name)}-${String(autoNumber).padStart(3, '0')}`,
            name,
            recipe: { kind: 'capsule', radius, length: bodyLength, capSegments: 12, radialSegments: 24 },
            position: capsule[5] ? designVector(capsule[5], scope, 'length', 'Capsule centre') : [0, 0, 0],
            rotation: capsule[6]
              ? evaluateDesignVector(capsule[6], scope, 'angle')
              : capsule[7] ? semanticAxisRotation(capsule[7].toLowerCase()) : [0, 0, 0],
            materialId: capsule[8], authoredInDesignFrame: true,
            metadata: { dimensions: { radius, bodyLength, totalHeight: bodyLength + radius * 2 } },
          });
          continue;
        }

        const taperedCylinder = statement.match(/^create a tapered cylinder called (.+?)(?: with id ([a-z0-9{}._/-]+))?,? with bottom radius (.+?),\s*top radius (.+?),\s*(?:and )?height (.+?)(?=,\s*cent(?:er|r)ed|,\s*rotated|,\s*aligned|,\s*using material|$)(?:,? cent(?:er|r)ed at (\[.+?\]))?(?:,? rotated by (\[.+?\]))?(?:,? aligned along (?:the )?(right|left|up|down|forward|backward)(?: axis| direction)?)?(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu);
        if (taperedCylinder) {
          autoNumber += 1;
          const name = interpolate(quoteName(taperedCylinder[1]), scope);
          const radiusBottom = finitePositive(length(taperedCylinder[3], scope, 'Tapered cylinder bottom radius'), 'Tapered cylinder bottom radius');
          const radiusTop = finitePositive(length(taperedCylinder[4], scope, 'Tapered cylinder top radius'), 'Tapered cylinder top radius');
          const height = finitePositive(length(taperedCylinder[5], scope, 'Tapered cylinder height'), 'Tapered cylinder height');
          addGeneratedSolid({
            id: taperedCylinder[2] ? interpolate(taperedCylinder[2], scope) : `entity/${designSlug}/${slug(name)}-${String(autoNumber).padStart(3, '0')}`,
            name,
            recipe: { kind: 'cylinder', radiusTop, radiusBottom, height, radialSegments: 32 },
            position: taperedCylinder[6] ? designVector(taperedCylinder[6], scope, 'length', 'Tapered cylinder centre') : [0, 0, 0],
            rotation: taperedCylinder[7]
              ? evaluateDesignVector(taperedCylinder[7], scope, 'angle')
              : taperedCylinder[8] ? semanticAxisRotation(taperedCylinder[8].toLowerCase()) : [0, 0, 0],
            materialId: taperedCylinder[9], authoredInDesignFrame: true,
            metadata: { primitive: 'taperedCylinder', dimensions: { radiusBottom, radiusTop, height } },
          });
          continue;
        }

        const cylinder = statement.match(/^create a cylinder called (.+?)(?: with id ([a-z0-9{}._/-]+))?,? with radius (.+?)(?=\s+and height)\s+and height (.+?)(?=,\s*cent(?:er|r)ed|,\s*rotated|,\s*aligned|,\s*using material|$)(?:,? cent(?:er|r)ed at (\[.+?\]))?(?:,? rotated by (\[.+?\]))?(?:,? aligned along (?:the )?(right|left|up|down|forward|backward)(?: axis| direction)?)?(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu);
        if (cylinder) {
          autoNumber += 1;
          const name = interpolate(quoteName(cylinder[1]), scope);
          addEntity({
            id: cylinder[2] ? interpolate(cylinder[2], scope) : `entity/${designSlug}/${slug(name)}-${String(autoNumber).padStart(3, '0')}`,
            name, kind: 'cylinder',
            dimensions: { radius: length(cylinder[3], scope, 'Cylinder radius'), height: length(cylinder[4], scope, 'Cylinder height') },
            position: cylinder[5] ? designVector(cylinder[5], scope, 'length', 'Cylinder centre') : [0, 0, 0],
            rotation: cylinder[6]
              ? evaluateDesignVector(cylinder[6], scope, 'angle')
              : cylinder[7] ? semanticAxisRotation(cylinder[7].toLowerCase()) : [0, 0, 0],
            materialId: cylinder[8],
          });
          continue;
        }

        const extrude = statement.match(/^extrude (?:the )?profile (.+?) by (.+?) as a (?:watertight )?(?:solid )?called (.+?) with id ([a-z0-9][a-z0-9._/-]*)(?:,? cent(?:er|r)ed at (\[.+?\]))?(?:,? rotated by (\[.+?\]))?(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu);
        if (extrude) {
          const profile = profiles.get(key(extrude[1]));
          if (!profile) { const error = new Error(`Unknown profile “${extrude[1]}”.`); error.code = 'plainform_unknown_profile'; throw error; }
          const depth = finitePositive(length(extrude[2], scope, 'Extrusion depth'), 'Extrusion depth');
          const centre = extrude[5] ? loftVector(extrude[5], scope, 'Extrusion centre') : [0, 0, 0];
          const position = [centre[0], centre[1], centre[2] - depth / 2];
          addGeneratedSolid({
            id: extrude[4], name: quoteName(extrude[3]),
            recipe: {
              kind: 'extrude', points: profile.points.map(point => [point[0], point[2]]), holes: [], depth,
              steps: 1, curveSegments: 24, bevelEnabled: true, bevelThickness: Math.min(depth * 0.04, 0.05),
              bevelSize: Math.min(depth * 0.04, 0.05), bevelOffset: 0, bevelSegments: 4,
            },
            position,
            rotation: extrude[6] ? evaluateDesignVector(extrude[6], scope, 'angle') : [0, 0, 0],
            materialId: extrude[7],
          });
          interpretations.push(`Will extrude profile “${profile.name}” by ${depth} metres as ${extrude[4]}.`);
          continue;
        }

        const sweep = statement.match(/^sweep profile (.+?) along (?:guide )?(.+?) as a (?:watertight )?(?:solid )?called (.+?) with id ([a-z0-9][a-z0-9._/-]*)(?:,? scaling from (.+?) to (.+?))?(?:,? rotating by (.+?) along the path)?(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu);
        if (sweep) {
          const profile = profiles.get(key(sweep[1]));
          const guide = guides.get(key(sweep[2]));
          if (!profile) { const error = new Error(`Unknown profile “${sweep[1]}”.`); error.code = 'plainform_unknown_profile'; throw error; }
          if (!guide) { const error = new Error(`Unknown guide curve “${sweep[2]}”.`); error.code = 'plainform_unknown_guide'; throw error; }
          const scaleStart = sweep[5] ? finitePositive(scalar(sweep[5], scope, 'Sweep start scale'), 'Sweep start scale') : 1;
          const scaleEnd = sweep[6] ? finitePositive(scalar(sweep[6], scope, 'Sweep end scale'), 'Sweep end scale') : 1;
          const twist = sweep[7] ? angle(sweep[7], scope, 'Sweep twist') : 0;
          addGeneratedSolid({
            id: sweep[4], name: quoteName(sweep[3]),
            recipe: sweepProfileAlongGuide({ profile, guide, scaleStart, scaleEnd, twist }),
            materialId: sweep[8],
          });
          const generated = entities.find(entity => entity.id === sweep[4]);
          generated.metadata.plainformDesign = {
            primitive: 'sweep', profile: profile.name, guide: guide.name, scaleStart, scaleEnd, twist,
          };
          interpretations.push(`Swept profile “${profile.name}” along guide “${guide.name}” as ${sweep[4]}.`);
          continue;
        }

        const hairCard = statement.match(/^groom a hair card called (.+?) with id ([a-z0-9][a-z0-9._/-]*) along (?:guide )?(.+?), with width (.+?), tapering to (.+?)(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu);
        if (hairCard) {
          const guide = guides.get(key(hairCard[3]));
          if (!guide) { const error = new Error(`Unknown hair-card guide “${hairCard[3]}”.`); error.code = 'plainform_unknown_guide'; throw error; }
          const width = finitePositive(length(hairCard[4], scope, 'Hair-card width'), 'Hair-card width');
          const tipScale = scalar(hairCard[5], scope, 'Hair-card tip scale');
          if (tipScale < 0 || tipScale > 1) { const error = new Error('Hair-card tip scale must be from 0 to 100 percent.'); error.code = 'plainform_hair_taper'; throw error; }
          addGeneratedSolid({
            id: hairCard[2], name: quoteName(hairCard[1]), recipe: hairCardRecipe(guide.points, width, tipScale),
            materialId: hairCard[6], metadata: { primitive: 'hairCard', guide: guide.name, width, tipScale, deterministicUvs: true },
          });
          interpretations.push(`Groomed UV-mapped hair card “${quoteName(hairCard[1])}” along guide “${guide.name}”.`);
          continue;
        }

        const hairStrand = statement.match(/^groom a hair strand called (.+?) with id ([a-z0-9][a-z0-9._/-]*) along (?:guide )?(.+?), with radius (.+?)(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu);
        if (hairStrand) {
          const guide = guides.get(key(hairStrand[3]));
          if (!guide) { const error = new Error(`Unknown hair-strand guide “${hairStrand[3]}”.`); error.code = 'plainform_unknown_guide'; throw error; }
          const radius = finitePositive(length(hairStrand[4], scope, 'Hair-strand radius'), 'Hair-strand radius');
          addGeneratedSolid({
            id: hairStrand[2], name: quoteName(hairStrand[1]),
            recipe: { kind: 'tube', points: guide.points.map(point => [...point]), tubularSegments: Math.min(256, Math.max(16, guide.points.length * 8)), radius, radialSegments: 6, closed: false, curveType: 'centripetal', tension: 0.5 },
            materialId: hairStrand[5], metadata: { primitive: 'hairStrand', guide: guide.name, radius, deterministicUvs: true },
          });
          interpretations.push(`Groomed tubular hair strand “${quoteName(hairStrand[1])}” along guide “${guide.name}”.`);
          continue;
        }

        const loft = statement.match(/^loft a (?:watertight )?(?:solid )?called (.+?) with id ([a-z0-9][a-z0-9._/-]*) through all sections of (.+?)(?:,? with (\d+) cap rings)?(?:,? following (.+?))?(?:,? with (positional|tangent|curvature) continuity)?(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu);
        if (loft) {
          const profile = profiles.get(key(loft[3]));
          if (!profile || profile.sections.length < 2) {
            const error = new Error(`Loft profile “${loft[3]}” requires at least two sections.`); error.code = 'plainform_loft_sections'; throw error;
          }
          const entityId = loft[2];
          const geometryId = `geometry/plainform-design/${designSlug}/${slug(loft[1])}`;
          if (occupied.has(entityId) || ids.has(entityId) || occupied.has(geometryId) || ids.has(geometryId)) {
            const error = new Error(`Loft ID ${entityId} or ${geometryId} already exists.`); error.code = 'plainform_id_conflict'; throw error;
          }
          ids.add(entityId); ids.add(geometryId);
          const capRings = loft[4] ? Number(loft[4]) : 0;
          if (!Number.isSafeInteger(capRings) || capRings < 0 || capRings > 32) {
            const error = new Error('A loft supports 0 to 32 regularly tessellated cap rings.');
            error.code = 'plainform_loft_cap_rings'; throw error;
          }
          const guideNames = loft[5] ? splitNames(loft[5]) : [];
          const guideCurves = guideNames.map((name) => {
            const guide = guides.get(name);
            if (!guide) { const error = new Error(`Unknown guide curve “${name}”.`); error.code = 'plainform_unknown_guide'; throw error; }
            if (guide.profileName && guide.profileName !== profile.name) {
              const error = new Error(`Guide “${guide.name}” follows profile “${guide.profileName}”, so it cannot guide loft profile “${profile.name}”.`);
              error.code = 'plainform_guide_profile_mismatch'; throw error;
            }
            return {
              name: guide.name,
              points: guide.points.map(point => [...point]),
              ...(guide.profileIndex === undefined ? {} : { profileIndex: guide.profileIndex }),
            };
          });
          lofts.push({
            entityId, geometryId, name: quoteName(loft[1]), profile,
            guideCurves, capRings, continuity: loft[6]?.toLowerCase() ?? 'positional', materialId: loft[7], modifiers: [],
          });
          aliases[key(loft[1])] = [entityId];
          interpretations.push(`Will loft “${quoteName(loft[1])}” with ${capRings} cap rings, ${guideCurves.length} guide curves, and ${loft[6]?.toLowerCase() ?? 'positional'} continuity.`);
          continue;
        }

        const patch = statement.match(/^create a constrained surface patch called (.+?) with id ([a-z0-9][a-z0-9._/-]*) between (\$[a-z0-9][a-z0-9._/-]*) and (\$[a-z0-9][a-z0-9._/-]*)(?:,? bounded by (\$[a-z0-9][a-z0-9._/-]*) and (\$[a-z0-9][a-z0-9._/-]*))?(,? meeting both owner surfaces tangentially)?(?:,? with (positional|tangent|curvature) continuity)?(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu);
        if (patch) {
          const firstName = boundaryReferenceKey(patch[3]);
          const secondName = boundaryReferenceKey(patch[4]);
          const first = boundaries.get(firstName);
          const second = boundaries.get(secondName);
          if (!first || !second) {
            const missing = [!first ? `$${firstName}` : null, !second ? `$${secondName}` : null].filter(Boolean);
            const error = new Error(`Unknown named boundary ${missing.join(' and ')}. Define each boundary before creating its patch.`);
            error.code = 'plainform_unknown_boundary'; throw error;
          }
          const entityId = patch[2];
          const geometryId = `geometry/plainform-design/${designSlug}/${slug(patch[1])}`;
          if (occupied.has(entityId) || ids.has(entityId) || occupied.has(geometryId) || ids.has(geometryId)) {
            const error = new Error(`Surface patch ID ${entityId} or ${geometryId} already exists.`);
            error.code = 'plainform_id_conflict'; throw error;
          }
          ids.add(entityId); ids.add(geometryId);
          const secondPoints = matchBoundaryDirection(first.points, second.points);
          const maximumSpanSquared = first.points.reduce((maximum, point, index) => {
            const factor = index / Math.max(1, first.points.length - 1);
            const scaled = factor * (secondPoints.length - 1);
            const lower = Math.min(secondPoints.length - 2, Math.floor(scaled));
            const local = scaled - lower;
            const matched = secondPoints[lower].map((value, axis) => (
              value + (secondPoints[lower + 1][axis] - value) * local
            ));
            return Math.max(maximum, endpointDistanceSquared(point, matched));
          }, 0);
          if (maximumSpanSquared <= 1e-18) {
            const error = new Error('A constrained surface patch requires two spatially distinct boundaries.');
            error.code = 'plainform_degenerate_surface_patch'; throw error;
          }
          const endNames = patch[5] && patch[6]
            ? [boundaryReferenceKey(patch[5]), boundaryReferenceKey(patch[6])]
            : [];
          const endBoundaries = endNames.map(name => boundaries.get(name));
          if (endBoundaries.some(boundary => !boundary)) {
            const missing = endNames.filter((name, index) => !endBoundaries[index]).map(name => `$${name}`);
            const error = new Error(`Unknown named boundary ${missing.join(' and ')}. Define each boundary before creating its patch.`);
            error.code = 'plainform_unknown_boundary'; throw error;
          }
          const sourceTangency = Boolean(patch[7]);
          const continuity = patch[8]?.toLowerCase() ?? 'positional';
          const enhanced = sourceTangency || endBoundaries.length > 0;
          const evaluated = enhanced ? buildConstrainedPatchSections({
            first, second, ends: endBoundaries.length > 0 ? endBoundaries : null,
            continuity, sourceTangency,
          }) : null;
          surfacePatches.push({
            entityId, geometryId, name: quoteName(patch[1]), continuity, materialId: patch[9], sourceTangency,
            boundaries: [first, { ...second, points: secondPoints }], endBoundaries,
            ...(evaluated ? { sections: evaluated.sections, profileResolution: evaluated.profileResolution } : {}),
          });
          aliases[key(patch[1])] = [entityId];
          interpretations.push(`Will span $${first.name} and $${second.name} with constrained patch “${quoteName(patch[1])}” using ${continuity} continuity${endBoundaries.length ? `, bounded by $${endBoundaries[0].name} and $${endBoundaries[1].name}` : ''}${sourceTangency ? ', tangent to both owner surfaces' : ''}.`);
          continue;
        }

        const blendSections = statement.match(/^blend the sections of (.+?) with (positional|tangent|curvature) continuity$/iu);
        if (blendSections) {
          const entityId = aliases[key(blendSections[1])]?.[0];
          const loft = lofts.find(item => item.entityId === entityId);
          if (!loft) {
            const error = new Error(`Continuity can only be applied to one generated loft; “${blendSections[1]}” is not such a loft.`);
            error.code = 'plainform_continuity_unsupported'; throw error;
          }
          loft.continuity = blendSections[2].toLowerCase();
          interpretations.push(`Will blend the sections of “${loft.name}” with ${loft.continuity} continuity.`);
          continue;
        }

        const boundaryBlend = statement.match(/^blend (\$[a-z0-9][a-z0-9._/-]*) into (\$[a-z0-9][a-z0-9._/-]*) over (.+?) as a surface called (.+?) with id ([a-z0-9][a-z0-9._/-]*)(?:,? with (tangent|curvature) continuity)?(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu);
        if (boundaryBlend) {
          const first = semanticSurfaces.resolveReference(boundaryBlend[1]);
          const second = semanticSurfaces.resolveReference(boundaryBlend[2]);
          if (!first.normals || !second.normals) {
            const error = new Error('A boundary blend requires two surface-anchored references with recorded source normals.');
            error.code = 'plainform_patch_tangency_requires_surface_anchors'; throw error;
          }
          const blendWidth = finitePositive(length(boundaryBlend[3], scope, 'Boundary blend width'), 'Boundary blend width');
          const continuity = boundaryBlend[6]?.toLowerCase() ?? 'curvature';
          const entityId = boundaryBlend[5];
          const geometryId = `geometry/plainform-design/${designSlug}/${slug(boundaryBlend[4])}`;
          if (occupied.has(entityId) || ids.has(entityId) || occupied.has(geometryId) || ids.has(geometryId)) {
            const error = new Error(`Boundary blend ID ${entityId} or ${geometryId} already exists.`); error.code = 'plainform_id_conflict'; throw error;
          }
          ids.add(entityId); ids.add(geometryId);
          const evaluated = buildConstrainedPatchSections({ first, second, continuity, sourceTangency: true });
          surfacePatches.push({
            entityId, geometryId, name: quoteName(boundaryBlend[4]), continuity,
            materialId: boundaryBlend[7], sourceTangency: true, blendWidth,
            boundaries: [first, second], endBoundaries: [],
            sections: evaluated.sections, profileResolution: evaluated.profileResolution,
          });
          aliases[key(boundaryBlend[4])] = [entityId];
          interpretations.push(`Created a bounded ${continuity} surface blend between $${first.name} and $${second.name} over ${blendWidth} metres.`);
          continue;
        }

        const crossBlend = statement.match(/^blend (.+?) into (.+?) with (positional|tangent|curvature) continuity$/iu);
        if (crossBlend) {
          const error = new Error(
            `Cross-solid ${crossBlend[3].toLowerCase()} continuity is not deterministic for unrelated solids. `
            + 'Describe the transition as sections of one loft or use positional union.',
          );
          error.code = 'plainform_continuity_unsupported';
          throw error;
        }

        const localModifier = statement.match(/^(bulge|pinch) (.+?) (?:outward|inward) around (\[[^\]]+\]) by (.+?) within (.+)$/iu);
        if (localModifier) {
          const entityId = aliases[key(localModifier[2])]?.[0];
          const loft = lofts.find(item => item.entityId === entityId);
          if (!loft) { const error = new Error(`Local form modifiers currently require a generated loft; “${localModifier[2]}” is not one.`); error.code = 'plainform_modifier_target'; throw error; }
          loft.modifiers.push({
            kind: localModifier[1].toLowerCase(),
            center: loftVector(localModifier[3], scope, 'Local modifier centre'),
            amount: finitePositive(length(localModifier[4], scope, 'Modifier amount'), 'Modifier amount'),
            radius: finitePositive(length(localModifier[5], scope, 'Modifier radius'), 'Modifier radius'),
          });
          interpretations.push(`Will ${localModifier[1].toLowerCase()} “${loft.name}” around a bounded local region.`);
          continue;
        }

        const offsetSurface = statement.match(/^offset the surface of (.+?) by (.+)$/iu);
        if (offsetSurface) {
          const entityId = aliases[key(offsetSurface[1])]?.[0];
          const loft = lofts.find(item => item.entityId === entityId);
          if (!loft) { const error = new Error(`Surface offset currently requires a generated loft; “${offsetSurface[1]}” is not one.`); error.code = 'plainform_modifier_target'; throw error; }
          loft.modifiers.push({ kind: 'offset', center: [0, 0, 0], amount: length(offsetSurface[2], scope, 'Surface offset') });
          interpretations.push(`Will offset the surface of “${loft.name}” by ${loft.modifiers.at(-1).amount} metres.`);
          continue;
        }

        const shellStatement = statement.match(/^shell (.+?) (inward|outward) by (.+)$/iu);
        if (shellStatement) {
          const owner = semanticDeformationOwner(shellStatement[1]);
          const direction = shellStatement[2].toLowerCase();
          const openMatch = shellStatement[3].match(/^(.+?),? leaving (\$[a-z0-9][a-z0-9._/-]*) open$/iu);
          if (/\bleaving\b.+\bopen$/iu.test(shellStatement[3]) && !openMatch) {
            const error = new Error('Shell openings require an exact closed surface-curve reference that has already been opened into topology.');
            error.code = 'plainform_shell_open_boundary_requires_split'; throw error;
          }
          if (openMatch && openedSurfaceCurves.get(owner.entityId) !== boundaryReferenceKey(openMatch[2])) {
            const error = new Error(`Shell opening ${openMatch[2]} must first become actual topology with “Open ${owner.entityId} along ${openMatch[2]}.”`);
            error.code = 'plainform_shell_open_boundary_requires_split'; throw error;
          }
          const thickness = finitePositive(length(openMatch?.[1] ?? shellStatement[3], scope, 'Shell thickness'), 'Shell thickness');
          const result = shellSurface({ owner, thickness, direction });
          owner.recipe = result.recipe;
          semanticSurfaces.addDeformation({
            kind: 'shell', operation: direction, ownerEntityId: owner.entityId, thickness,
            sourceVertexCount: result.sourceVertexCount, boundaryEdgeCount: result.boundaryEdgeCount,
          });
          interpretations.push(`Shelled ${owner.entityId} ${direction} by ${thickness} metres with ${result.boundaryEdgeCount} actual topology boundary edges closed.`);
          continue;
        }

        const imprintStatement = statement.match(/^imprint (\$[a-z0-9][a-z0-9._/-]*) into (.+)$/iu);
        if (imprintStatement) {
          const curve = semanticSurfaces.resolveReference(imprintStatement[1]);
          const owner = semanticSurfaceOwner(imprintStatement[2]);
          if (curve.referenceKind !== 'surfaceCurve' || !curve.closed) {
            const error = new Error(`Imprinting requires a closed surface curve; ${imprintStatement[1]} is not one.`);
            error.code = 'plainform_surface_split_not_closed'; throw error;
          }
          if (curve.ownerEntityId !== owner.entityId) {
            const error = new Error(`${imprintStatement[1]} belongs to ${curve.ownerEntityId}, not ${owner.entityId}.`);
            error.code = 'plainform_surface_split_owner_mismatch'; throw error;
          }
          imprintedCurves.add(curve.name);
          semanticSurfaces.addDeformation({ kind: 'imprint', ownerEntityId: owner.entityId, reference: curve.name });
          interpretations.push(`Marked $${curve.name} as a bounded topology imprint on ${owner.entityId}.`);
          continue;
        }

        const openStatement = statement.match(/^open (.+?) along (\$[a-z0-9][a-z0-9._/-]*)$/iu);
        if (openStatement) {
          const owner = semanticDeformationOwner(openStatement[1]);
          const curve = semanticSurfaces.resolveReference(openStatement[2]);
          if (curve.referenceKind !== 'surfaceCurve' || !curve.closed) {
            const error = new Error(`Opening ${owner.entityId} requires a closed surface curve; ${openStatement[2]} is not one.`);
            error.code = 'plainform_surface_split_not_closed'; throw error;
          }
          if (curve.ownerEntityId !== owner.entityId) {
            const error = new Error(`${openStatement[2]} belongs to ${curve.ownerEntityId}, not ${owner.entityId}.`);
            error.code = 'plainform_surface_split_owner_mismatch'; throw error;
          }
          const result = openSurfaceAlongCurve({ owner, curve });
          owner.recipe = result.recipe;
          imprintedCurves.add(curve.name);
          openedSurfaceCurves.set(owner.entityId, curve.name);
          semanticSurfaces.addDeformation({
            kind: 'open', ownerEntityId: owner.entityId, reference: curve.name,
            removedTriangleCount: result.removedTriangleCount, remainingTriangleCount: result.remainingTriangleCount,
            boundaryEdgeCount: result.boundaryEdgeCount, imprinted: result.imprinted,
          });
          interpretations.push(`Opened ${owner.entityId} along $${curve.name}, creating ${result.boundaryEdgeCount} actual topology boundary edges.`);
          continue;
        }

        const splitStatement = statement.match(/^split (.+?) along (\$[a-z0-9][a-z0-9._/-]*)$/iu);
        if (splitStatement) {
          const owner = semanticDeformationOwner(splitStatement[1]);
          const curve = semanticSurfaces.resolveReference(splitStatement[2]);
          if (curve.referenceKind !== 'surfaceCurve' || !curve.closed) {
            const error = new Error(`Splitting ${owner.entityId} requires a closed surface curve; ${splitStatement[2]} is not one.`);
            error.code = 'plainform_surface_split_not_closed'; throw error;
          }
          if (curve.ownerEntityId !== owner.entityId) {
            const error = new Error(`${splitStatement[2]} belongs to ${curve.ownerEntityId}, not ${owner.entityId}.`);
            error.code = 'plainform_surface_split_owner_mismatch'; throw error;
          }
          pendingSurfaceSplit = { owner, curve };
          interpretations.push(`Will split ${owner.entityId} along the bounded topology imprint $${curve.name}.`);
          continue;
        }

        const callSplitStatement = statement.match(/^call the enclosed (?:surface|region) (.+?)(?: with id ([a-z0-9][a-z0-9._/-]*))?(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu);
        if (callSplitStatement) {
          if (!pendingSurfaceSplit) {
            const error = new Error('“Call the enclosed surface” must immediately follow a supported Split statement.');
            error.code = 'plainform_surface_split_missing'; throw error;
          }
          const name = clean(callSplitStatement[1]);
          const id = callSplitStatement[2] ?? `entity/${slug(name)}`;
          const { owner, curve } = pendingSurfaceSplit;
          const result = splitSurfaceAlongCurve({ owner, curve });
          owner.recipe = result.remainderRecipe;
          const generatedOwner = generatedEntity(owner.entityId);
          const materialId = callSplitStatement[3] ?? owner.meshComponent?.materialId ?? generatedOwner?.components?.mesh?.materialId;
          addGeneratedSolid({ id, name, recipe: result.enclosedWorldRecipe, materialId });
          const enclosed = entities.find(entity => entity.id === id);
          enclosed.metadata.plainformDesign = {
            primitive: 'splitSurface', splitFrom: owner.entityId, boundaryReference: curve.name,
            enclosedTriangleCount: result.enclosedTriangleCount, boundaryEdgeCount: result.boundaryEdgeCount,
            imprinted: result.imprinted,
          };
          semanticSurfaces.addDeformation({
            kind: 'split', ownerEntityId: owner.entityId, resultEntityId: id, reference: curve.name,
            enclosedTriangleCount: result.enclosedTriangleCount,
            remainderTriangleCount: result.remainderTriangleCount,
            boundaryEdgeCount: result.boundaryEdgeCount, imprinted: result.imprinted,
          });
          interpretations.push(`Split ${owner.entityId} into its remainder and enclosed surface ${id} along ${result.boundaryEdgeCount} exact topology edges.`);
          pendingSurfaceSplit = null;
          continue;
        }

        const symmetryConstraintStatement = statement.match(/^keep (.+?) symmetric across (?:its |the )?(x|y|z|right|up|forward) centre plane$/iu);
        if (symmetryConstraintStatement) {
          const owner = semanticSurfaceOwner(symmetryConstraintStatement[1]);
          const authoredAxis = symmetryConstraintStatement[2].toLowerCase();
          const axis = semanticFrame
            ? ({ right: 'x', up: 'z', forward: 'y' }[authoredAxis] ?? authoredAxis)
            : authoredAxis;
          constraints.push({ kind: 'symmetry', entityId: owner.entityId, axis });
          interpretations.push(`Will keep ${owner.entityId} symmetric across its ${authoredAxis} centre plane or fail validation.`);
          continue;
        }

        const uniformClearanceStatement = statement.match(/^maintain (.+?) uniform clearance between (\$[a-z0-9][a-z0-9._/-]*) and (\$[a-z0-9][a-z0-9._/-]*) within (.+?) tolerance$/iu);
        if (uniformClearanceStatement) {
          const target = finitePositive(length(uniformClearanceStatement[1], scope, 'Uniform clearance'), 'Uniform clearance');
          const tolerance = finitePositive(length(uniformClearanceStatement[4], scope, 'Uniform clearance tolerance'), 'Uniform clearance tolerance');
          const first = semanticSurfaces.resolveReference(uniformClearanceStatement[2]);
          const second = semanticSurfaces.resolveReference(uniformClearanceStatement[3]);
          constraints.push({ kind: 'uniformBoundaryClearance', firstReference: first.name, secondReference: second.name, target, tolerance });
          interpretations.push(`Will keep $${first.name} and $${second.name} at ${target} metres uniform clearance within ${tolerance} metres.`);
          continue;
        }

        const clearanceConstraintStatement = statement.match(/^maintain at least (.+?) clearance between (.+?) and (.+)$/iu);
        if (clearanceConstraintStatement) {
          const minimum = finitePositive(length(clearanceConstraintStatement[1], scope, 'Minimum clearance'), 'Minimum clearance');
          const first = semanticSurfaceOwner(clearanceConstraintStatement[2]);
          const second = semanticSurfaceOwner(clearanceConstraintStatement[3]);
          constraints.push({ kind: 'minimumClearance', firstEntityId: first.entityId, secondEntityId: second.entityId, minimum });
          interpretations.push(`Will maintain at least ${minimum} metres clearance between ${first.entityId} and ${second.entityId} or fail validation.`);
          continue;
        }

        const ambiguousDeformationStatement = statement.match(/^(?:raise|lower|inset|bulge|pinch) (?:the surface along )?(.+?) by (.+)$/iu);
        if (ambiguousDeformationStatement) {
          const error = new Error('Semantic surface deformation requires an explicit smooth falloff. Use “with a smooth falloff of <distance>” for a curve or “falling off smoothly over <distance>” for a region.');
          error.code = 'plainform_surface_deformation_falloff_required'; throw error;
        }

        const booleanStatement = statement.match(/^(subtract|union|intersect) (.+?) (?:from|with) (.+)$/iu);
        if (booleanStatement) {
          const operation = booleanStatement[1].toLowerCase();
          const toolId = aliases[key(booleanStatement[2])]?.[0] ?? clean(booleanStatement[2]);
          const targetId = aliases[key(booleanStatement[3])]?.[0] ?? clean(booleanStatement[3]);
          if (!ids.has(toolId) || !ids.has(targetId)) {
            const error = new Error(`Boolean operands must be generated solids in this design: ${toolId}, ${targetId}.`);
            error.code = 'plainform_boolean_operand'; throw error;
          }
          if (toolId === targetId) { const error = new Error('A solid cannot be combined with itself.'); error.code = 'plainform_boolean_operand'; throw error; }
          booleanCommands.push({ operation, toolId, targetId });
          interpretations.push(`Will ${operation} ${toolId} ${operation === 'subtract' ? 'from' : 'with'} ${targetId}.`);
          continue;
        }

        const attachStatement = statement.match(/^attach (.+?) to (.+?) over (\$[a-z0-9][a-z0-9._/-]*), removing hidden intersecting surfaces, with (positional|tangent|curvature) continuity$/iu);
        if (attachStatement) {
          const tool = generatedEntity(attachStatement[1]);
          const target = generatedEntity(attachStatement[2]);
          if (!tool || !target) {
            const error = new Error('Attach currently requires both solids to be generated earlier in the same Design Plainform program so the bounded topology result can be compiled atomically.');
            error.code = 'plainform_attach_operand'; throw error;
          }
          const continuity = attachStatement[4].toLowerCase();
          if (continuity !== 'positional') {
            const error = new Error(`Attach with ${continuity} continuity requires a boundary-aware blend solver. Use positional continuity for intersecting solids; Plainform will not mislabel a CSG union as ${continuity} continuity.`);
            error.code = 'plainform_attach_continuity_unsupported'; throw error;
          }
          const boundary = semanticSurfaces.resolveReference(attachStatement[3]);
          if (![tool.id ?? tool.entityId, target.id ?? target.entityId].includes(boundary.ownerEntityId)) {
            const error = new Error(`${attachStatement[3]} belongs to ${boundary.ownerEntityId}; an attachment boundary must belong to one of its two solids.`);
            error.code = 'plainform_attach_boundary_owner'; throw error;
          }
          const toolBounds = surfaceBounds(boundaryOwner(tool.id ?? tool.entityId));
          const targetBounds = surfaceBounds(boundaryOwner(target.id ?? target.entityId));
          const overlap = toolBounds.max.map((value, axis) => Math.min(value, targetBounds.max[axis]) - Math.max(toolBounds.min[axis], targetBounds.min[axis]));
          if (overlap.some(value => value <= 1e-9)) {
            const error = new Error(`Attach requires intersecting solid bounds; ${tool.id ?? tool.entityId} and ${target.id ?? target.entityId} do not overlap in all three dimensions.`);
            error.code = 'plainform_attach_no_intersection'; throw error;
          }
          booleanCommands.push({
            operation: 'union', toolId: tool.id ?? tool.entityId, targetId: target.id ?? target.entityId,
            attachment: { boundaryReference: boundary.name, continuity, removesHiddenIntersectingSurfaces: true },
          });
          interpretations.push(`Will attach ${tool.id ?? tool.entityId} to ${target.id ?? target.entityId} by bounded CSG union over $${boundary.name} with positional continuity.`);
          continue;
        }

        const fairUnionStatement = statement.match(/^fair (.+?) into (.+?) over (\$[a-z0-9][a-z0-9._/-]*) within (.+?), removing hidden intersecting surfaces, with (tangent|curvature) continuity$/iu);
        if (fairUnionStatement) {
          const tool = generatedEntity(fairUnionStatement[1]); const target = generatedEntity(fairUnionStatement[2]);
          if (!tool || !target) {
            const error = new Error('Fair union requires both intersecting solids to be generated earlier in the same Design program.');
            error.code = 'plainform_fair_union_operand'; throw error;
          }
          const boundary = semanticSurfaces.resolveReference(fairUnionStatement[3]);
          if (![tool.id ?? tool.entityId, target.id ?? target.entityId].includes(boundary.ownerEntityId)) {
            const error = new Error(`${fairUnionStatement[3]} must belong to one fair-union operand.`);
            error.code = 'plainform_attach_boundary_owner'; throw error;
          }
          const radius = finitePositive(length(fairUnionStatement[4], scope, 'Fair-union radius'), 'Fair-union radius');
          const continuity = fairUnionStatement[5].toLowerCase();
          const toolBounds = surfaceBounds(boundaryOwner(tool.id ?? tool.entityId));
          const targetBounds = surfaceBounds(boundaryOwner(target.id ?? target.entityId));
          const overlap = toolBounds.max.map((value, axis) => Math.min(value, targetBounds.max[axis]) - Math.max(toolBounds.min[axis], targetBounds.min[axis]));
          if (overlap.some(value => value <= 1e-9)) {
            const error = new Error('Fair union requires genuinely intersecting solid bounds.');
            error.code = 'plainform_attach_no_intersection'; throw error;
          }
          booleanCommands.push({
            operation: 'union', toolId: tool.id ?? tool.entityId, targetId: target.id ?? target.entityId,
            attachment: { boundaryReference: boundary.name, continuity, removesHiddenIntersectingSurfaces: true, fairingRadius: radius },
            fairing: { points: boundary.points.map(point => [...point]), radius, iterations: continuity === 'curvature' ? 6 : 3, strength: continuity === 'curvature' ? 0.4 : 0.25, continuity },
          });
          interpretations.push(`Will fair ${tool.id ?? tool.entityId} into ${target.id ?? target.entityId} over $${boundary.name} within ${radius} metres.`);
          continue;
        }

        const relationalPlacement = statement.match(/^place (.+?) cent(?:er|r)ed at (.+?)(?:,? aligning its local (x|y|z) axis with (.+))?$/iu);
        if (relationalPlacement) {
          const generated = generatedEntity(relationalPlacement[1]);
          if (!generated?.transform) {
            const error = new Error(`Relational placement currently requires a generated solid or primitive; “${relationalPlacement[1]}” is not directly placeable.`);
            error.code = 'plainform_placement_target'; throw error;
          }
          generated.transform.position = designVector(relationalPlacement[2], scope, 'length', 'Placement centre');
          if (relationalPlacement[3]) {
            const direction = designVector(relationalPlacement[4], scope, 'scalar', 'Placement direction');
            const localAxis = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[relationalPlacement[3].toLowerCase()];
            generated.transform.rotation = spatial.rotationAligningAxis(localAxis, direction);
          }
          interpretations.push(`Placed ${generated.id} from a named surface-reference frame.`);
          continue;
        }

        const ensureHeight = statement.match(/^ensure the design is exactly (.+?) high$/iu);
        if (ensureHeight) {
          const expected = length(ensureHeight[1], scope, 'Design height');
          const spans = [
            ...entities.map(entity => [entity.transform.position[1] - entity.transform.scale[1] / 2, entity.transform.position[1] + entity.transform.scale[1] / 2]),
            ...[...profiles.values()].flatMap(profile => profile.sections.map(item => [item.transform.translation[1], item.transform.translation[1]])),
          ];
          if (spans.length === 0) { const error = new Error('Design height cannot be checked before geometry is defined.'); error.code = 'plainform_assertion_empty'; throw error; }
          const actual = Math.max(...spans.map(value => value[1])) - Math.min(...spans.map(value => value[0]));
          if (Math.abs(actual - expected) > 1e-6) {
            const error = new Error(`Design height assertion failed: expected ${expected} metres, calculated ${actual} metres.`);
            error.code = 'plainform_assertion_failed'; error.details = { expected, actual, dimension: 'length' }; throw error;
          }
          interpretations.push(`Verified the design height is ${expected} metres.`);
          continue;
        }
        if (/^ensure every generated object has positive dimensions$/iu.test(statement)) {
          interpretations.push(`Verified positive dimensions for ${entities.length} generated objects.`);
          continue;
        }
        const error = new Error(`I could not understand Design Plainform statement ${lineIndex + 1}: “${statement}”.`);
        error.code = 'plainform_unknown_design_statement'; error.details = { statement: lineIndex + 1, source: statement }; throw error;
      }
    };

    execute(1, lines.length, variables);
    if (pendingSurfaceSplit) {
      const error = new Error(`Split ${pendingSurfaceSplit.owner.entityId} requires a following “Call the enclosed surface <name>” statement.`);
      error.code = 'plainform_surface_split_name_required'; throw error;
    }
    const inheritedConstraints = Object.values(scene.entities ?? {}).flatMap(entity => (
      Array.isArray(entity.metadata?.plainformDesign?.constraints) ? entity.metadata.plainformDesign.constraints : []
    ));
    const modifiedEntityIds = new Set(semanticDeformationStates.keys());
    const constraintsToValidate = [
      ...constraints,
      ...inheritedConstraints.filter(constraint => (
        modifiedEntityIds.has(constraint.entityId)
        || modifiedEntityIds.has(constraint.firstEntityId)
        || modifiedEntityIds.has(constraint.secondEntityId)
      )),
    ];
    const postValidationTopologyOwners = new Set(booleanCommands.map(command => command.targetId));
    for (const constraint of constraintsToValidate) {
      const participants = [constraint.entityId, constraint.firstEntityId, constraint.secondEntityId].filter(Boolean);
      const unavailable = participants.find(entityId => postValidationTopologyOwners.has(entityId));
      if (unavailable) {
        const error = new Error(`Constraint validation for ${unavailable} cannot run before its pending CSG or attachment topology is evaluated. Split the topology change and constraint into verified stages; Plainform will not silently accept an unvalidated post-CSG constraint.`);
        error.code = 'plainform_constraint_validation_unavailable';
        error.details = { constraint: structuredClone(constraint), entityId: unavailable, reason: 'postCsgTopology' };
        throw error;
      }
    }
    const constraintOwner = entityId => semanticSurfaceOwner(entityId);
    for (const constraint of constraintsToValidate) {
      if (constraint.kind === 'symmetry') assertSurfaceSymmetry(constraintOwner(constraint.entityId), constraint.axis);
      else if (constraint.kind === 'minimumClearance') {
        const actual = minimumSurfaceDistance(constraintOwner(constraint.firstEntityId), constraintOwner(constraint.secondEntityId));
        if (actual + 1e-9 < constraint.minimum) {
          const error = new Error(`Minimum clearance constraint failed: ${actual} metres is less than ${constraint.minimum} metres between ${constraint.firstEntityId} and ${constraint.secondEntityId}.`);
          error.code = 'plainform_constraint_unsatisfied';
          error.details = { ...constraint, actual };
          throw error;
        }
      } else if (constraint.kind === 'uniformBoundaryClearance') {
        const first = semanticSurfaces.resolveReference(constraint.firstReference);
        const second = semanticSurfaces.resolveReference(constraint.secondReference);
        const separation = surfaceReferenceSeparation(first, second);
        const deviation = Math.max(Math.abs(separation.minimum - constraint.target), Math.abs(separation.maximum - constraint.target));
        if (deviation > constraint.tolerance + 1e-9) {
          const error = new Error(`Uniform boundary clearance failed: $${first.name} and $${second.name} deviate by ${deviation} metres from ${constraint.target} metres, exceeding ${constraint.tolerance} metres tolerance.`);
          error.code = 'plainform_constraint_unsatisfied';
          error.details = { ...constraint, separation, deviation };
          throw error;
        }
      }
    }
    if (entities.length + lofts.length + surfacePatches.length + semanticSurfaces.curves.size + semanticSurfaces.regions.size + constraints.length === 0) {
      const error = new Error('A design must create at least one solid, primitive, surface intent, or persistent constraint.'); error.code = 'plainform_empty_design'; throw error;
    }

    const resources = [...geometryKinds].map(kind => ({
      resourceType: 'geometries',
      resource: { id: `geometry/plainform-design/${designSlug}/${kind}-unit`, recipe: unitRecipe(kind) },
    }));
    for (const loft of lofts) resources.push({
      resourceType: 'geometries',
      resource: { id: loft.geometryId, recipe: {
        ...loftRecipe(loft),
      } },
    });
    for (const patch of surfacePatches) resources.push({
      resourceType: 'geometries',
      resource: {
        id: patch.geometryId,
        metadata: { plainformDesign: {
          primitive: 'surfacePatch',
          boundaryRefs: [...patch.boundaries, ...patch.endBoundaries].map(boundary => ({
            name: boundary.name, ownerEntityId: boundary.ownerEntityId,
          })),
          sourceTangency: patch.sourceTangency,
          ...(patch.blendWidth ? { blendWidth: patch.blendWidth } : {}),
        } },
        recipe: {
          kind: 'loft',
          sections: patch.sections ?? patch.boundaries.map(boundary => ({
            id: `boundary/${slug(boundary.name)}`,
            points: boundary.points.map(point => [...point]),
          })),
          closedProfile: false,
          capStart: false,
          capEnd: false,
          profileResolution: patch.profileResolution ?? Math.max(...patch.boundaries.map(boundary => boundary.points.length)),
          subdivisions: patch.sections ? 0 : (patch.continuity === 'positional' ? 0 : 3),
          alignProfile: 'authored',
          continuity: patch.sections ? 'positional' : patch.continuity,
          guideCurves: [],
          modifiers: [],
        },
      },
    });
    resources.push(...generatedResources);
    for (const state of semanticDeformationStates.values()) {
      const geometryId = `geometry/plainform-design/${designSlug}/${slug(state.entityId)}-semantic-surface`;
      if (occupied.has(geometryId) || resources.some(item => item.resource.id === geometryId)) {
        const error = new Error(`Generated semantic surface geometry ID ${geometryId} already exists.`);
        error.code = 'plainform_id_conflict'; throw error;
      }
      state.derivedGeometryId = geometryId;
      resources.push({ resourceType: 'geometries', resource: {
        id: geometryId,
        metadata: { plainformDesign: { primitive: 'semanticSurfaceResult', ownerEntityId: state.entityId } },
        recipe: state.recipe,
      } });
    }
    for (const resource of resources) {
      if (occupied.has(resource.resource.id)) {
        const error = new Error(`Generated geometry ID ${resource.resource.id} already exists.`); error.code = 'plainform_id_conflict'; throw error;
      }
    }
    const variableMetadata = Object.fromEntries([
      ...[...variables].map(([name, value]) => [name, value]),
      ...[...vectorVariables].map(([name, value]) => [name, {
        value: [...value.value], dimension: value.dimension, source: value.source, factor: value.factor,
        ...(value.component ? { component: value.component } : {}),
      }]),
    ]);
    const allEntities = [...entities, ...lofts.map(loft => ({
      id: loft.entityId, kind: 'mesh', name: loft.name, parentId: rootId,
      components: { mesh: { geometryId: loft.geometryId, ...(loft.materialId ? { materialId: loft.materialId } : {}) } },
      metadata: { plainformDesign: {
        primitive: 'loft', profile: loft.profile.name, continuity: loft.continuity, capRings: loft.capRings,
        guides: loft.guideCurves.map(guide => guide.name), modifiers: loft.modifiers,
      } },
    })), ...surfacePatches.map(patch => ({
      id: patch.entityId, kind: 'mesh', name: patch.name, parentId: rootId,
      components: { mesh: { geometryId: patch.geometryId, ...(patch.materialId ? { materialId: patch.materialId } : {}) } },
      metadata: { plainformDesign: {
        primitive: 'surfacePatch', continuity: patch.continuity,
        sourceTangency: patch.sourceTangency,
        ...(patch.blendWidth ? { blendWidth: patch.blendWidth } : {}),
        boundaryRefs: [...patch.boundaries, ...patch.endBoundaries].map(boundary => ({
          name: boundary.name, ownerEntityId: boundary.ownerEntityId,
        })),
      } },
    }))];
    for (const state of semanticDeformationStates.values()) {
      const generated = allEntities.find(entity => entity.id === state.entityId);
      if (generated) generated.components.mesh.geometryId = state.derivedGeometryId;
    }
    if (booleanCommands.length > 0) {
      const resourceById = new Map(resources.map(item => [item.resource.id, item]));
      const entityById = new Map(allEntities.map(entity => [entity.id, entity]));
      const usageCount = geometryId => allEntities.filter(entity => entity.components?.mesh?.geometryId === geometryId).length;
      for (const command of booleanCommands) {
        const target = entityById.get(command.targetId);
        const tool = entityById.get(command.toolId);
        if (!target?.components?.mesh?.geometryId || !tool?.components?.mesh?.geometryId) {
          const error = new Error('Boolean operands must resolve to generated mesh solids.'); error.code = 'plainform_boolean_operand'; throw error;
        }
        const targetResource = resourceById.get(target.components.mesh.geometryId);
        const toolResource = resourceById.get(tool.components.mesh.geometryId);
        if (!targetResource?.resource?.recipe || !toolResource?.resource?.recipe) {
          const error = new Error('Boolean operands require generated procedural geometry recipes.'); error.code = 'plainform_boolean_operand'; throw error;
        }
        if (toolResource.resource.recipe.kind === 'csg') {
          const error = new Error('A consumed boolean tool cannot be reused as another boolean operand.'); error.code = 'plainform_boolean_operand'; throw error;
        }
        const targetRecipe = targetResource.resource.recipe;
        const targetTransform = target.transform ?? { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
        const toolTransform = tool.transform ?? { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
        let operands;
        if (targetRecipe.kind === 'csg') {
          if (targetRecipe.operation !== command.operation) {
            const error = new Error('Mixed boolean chains require an explicit intermediate design solid.'); error.code = 'plainform_boolean_chain'; throw error;
          }
          operands = [...targetRecipe.operands, { recipe: toolResource.resource.recipe, transform: toolTransform }];
        } else {
          operands = [
            { recipe: targetRecipe, transform: targetTransform },
            { recipe: toolResource.resource.recipe, transform: toolTransform },
          ];
        }
        const sharedTarget = usageCount(target.components.mesh.geometryId) > 1;
        const resultGeometryId = sharedTarget
          ? `geometry/plainform-design/${designSlug}/${slug(target.name)}-boolean`
          : target.components.mesh.geometryId;
        const resultResource = { resourceType: 'geometries', resource: {
          id: resultGeometryId,
          recipe: { kind: 'csg', operation: command.operation, operands, ...(command.fairing ? { fairing: command.fairing } : {}) },
        } };
        if (sharedTarget) {
          if (resourceById.has(resultGeometryId)) {
            const error = new Error(`Generated boolean geometry ID ${resultGeometryId} already exists.`); error.code = 'plainform_id_conflict'; throw error;
          }
          resources.push(resultResource);
          resourceById.set(resultGeometryId, resultResource);
        } else {
          const resourceIndex = resources.indexOf(targetResource);
          resources[resourceIndex] = resultResource;
          resourceById.set(resultGeometryId, resultResource);
        }
        target.components.mesh.geometryId = resultGeometryId;
        target.transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
        if (command.attachment) target.metadata.plainformDesign.attachment = { ...command.attachment, toolId: tool.id };
        else target.metadata.plainformDesign.boolean = { operation: command.operation, toolId: tool.id };
        tool.visible = false;
        tool.metadata.plainformDesign.booleanToolFor = target.id;
      }
    }
    if (allEntities.length > MAX_DESIGN_ENTITIES) {
      const error = new Error(`Design Plainform creates at most ${MAX_DESIGN_ENTITIES} entities per program.`);
      error.code = 'plainform_design_entity_limit';
      throw error;
    }
    const semanticSurfaceMetadata = semanticSurfaces.toMetadata();
    const operations = [
      ...(resources.length > 0 ? [{ op: 'resource.createMany', items: resources }] : []),
      { op: 'entity.create', sceneId: scene.id, entity: {
        id: rootId, kind: 'group', name: designName,
        transform: rootTransform,
        metadata: { plainformDesign: {
          version: 1, kind: designKind, source, variables: variableMetadata,
          designFrame: {
            name: designFrame,
            worldAxes: { right: '+X', up: '+Y', forward: '+Z' },
            internalLoftAxes: { right: '+X', up: '+Z', forward: '-Y' },
          },
          boundaries: [...boundaries.values()].map(boundary => ({
            name: boundary.name,
            ownerEntityId: boundary.ownerEntityId,
            coordinateSpace: boundary.coordinateSpace,
            authoredPoints: boundary.authoredPoints.map(point => [...point]),
            ...(boundary.anchorMode ? {
              anchorMode: boundary.anchorMode,
              anchors: boundary.anchors.map(anchor => ({
                seedPoint: [...anchor.seedPoint], projectedPoint: [...anchor.projectedPoint], normal: [...anchor.normal],
                triangleIndex: anchor.triangleIndex, barycentric: [...anchor.barycentric],
                ...(anchor.parametric ? { parametric: structuredClone(anchor.parametric) } : {}),
              })),
            } : {}),
          })),
          ...semanticSurfaceMetadata,
          constraints: constraints.map(constraint => structuredClone(constraint)),
        } },
      } },
      ...(allEntities.length > 0 ? [{ op: 'entity.createMany', sceneId: scene.id, items: allEntities.map(entity => ({ entity })) }] : []),
      ...[...semanticDeformationStates.values()]
        .filter(state => !allEntities.some(entity => entity.id === state.entityId))
        .map(state => ({ op: 'entity.patch', entityId: state.entityId, patch: {
          components: { mesh: { ...state.meshComponent, geometryId: state.derivedGeometryId } },
        } })),
    ];
    interpretations.push(`Will create ${allEntities.length} meshes using ${resources.length} shared or procedural geometries.`);
    return Object.freeze({
      language: 'plainform-v1', dialect: 'design', source,
      operations: Object.freeze(operations), interpretation: Object.freeze(interpretations),
      aliases: Object.freeze(aliases), requestedPreview,
      design: Object.freeze({ rootId, entityCount: allEntities.length, resourceCount: resources.length, variableCount: variables.size + vectorVariables.size }),
    });
  }
}
