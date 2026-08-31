import { compileShaderGraph, isCompiledSurface } from './shader-graph-compiler.mjs';
import { normalizeEditableMeshRecipe, triangulateEditableMesh } from '../core/editable-mesh.mjs';
import { MAX_MATERIAL_SLOTS_PER_MESH } from '../core/constants.mjs';
import { createCsgGeometry } from './csg-geometry.mjs';
import {
  MATERIAL_TEXTURE_BINDINGS,
  MATERIAL_TEXTURE_MAP_AWARE_DEFAULTS,
  assertMaterialTextureCompatibility,
  assertMaterialTextureControls,
  materialRecipeKind,
  materialTextureGraphConflicts,
  materialTextureReferences,
} from '../core/material-textures.mjs';

export const GEOMETRY_PARAMETER_DEFAULTS = Object.freeze({
  box: { width: 1, height: 1, depth: 1, widthSegments: 1, heightSegments: 1, depthSegments: 1 },
  plane: { width: 1, height: 1, widthSegments: 1, heightSegments: 1 },
  sphere: { radius: 0.5, widthSegments: 32, heightSegments: 16, phiStart: 0, phiLength: Math.PI * 2, thetaStart: 0, thetaLength: Math.PI },
  capsule: { radius: 0.5, length: 1, capSegments: 8, radialSegments: 16 },
  circle: { radius: 0.5, segments: 32, thetaStart: 0, thetaLength: Math.PI * 2 },
  cone: { radius: 0.5, height: 1, radialSegments: 32, heightSegments: 1, openEnded: false, thetaStart: 0, thetaLength: Math.PI * 2 },
  cylinder: { radiusTop: 0.5, radiusBottom: 0.5, height: 1, radialSegments: 32, heightSegments: 1, openEnded: false, thetaStart: 0, thetaLength: Math.PI * 2 },
  torus: { radius: 0.5, tube: 0.18, radialSegments: 16, tubularSegments: 48, arc: Math.PI * 2 },
  torusKnot: { radius: 0.5, tube: 0.15, tubularSegments: 96, radialSegments: 16, p: 2, q: 3 },
  lathe: {
    points: [[0, -0.5], [0.36, -0.5], [0.5, -0.15], [0.5, 0.15], [0.36, 0.5], [0, 0.5]],
    segments: 24,
    phiStart: 0,
    phiLength: Math.PI * 2,
  },
  tube: {
    points: [[-0.5, 0, 0], [0, 0.25, 0], [0.5, 0, 0]],
    tubularSegments: 64,
    radius: 0.08,
    radialSegments: 8,
    closed: false,
    curveType: 'centripetal',
    tension: 0.5,
  },
  loft: {
    sections: [
      [[-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, 0.5, 0], [-0.5, 0.5, 0]],
      [[-0.35, -0.35, 1], [0.35, -0.35, 1], [0.35, 0.35, 1], [-0.35, 0.35, 1]],
    ],
    closedProfile: true,
    capStart: true,
    capEnd: true,
    profileResolution: null,
    subdivisions: 0,
    alignProfile: 'authored',
    continuity: 'positional',
    guideCurves: [],
    modifiers: [],
  },
  csg: {
    operation: 'union',
    operands: [],
  },
  shape: {
    points: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]],
    holes: [],
    curveSegments: 12,
  },
  extrude: {
    points: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]],
    holes: [],
    depth: 0.25,
    steps: 1,
    curveSegments: 12,
    bevelEnabled: false,
    bevelThickness: 0.1,
    bevelSize: 0.08,
    bevelOffset: 0,
    bevelSegments: 3,
  },
});

export const GEOMETRY_CONTROL_POINT_LIMITS = Object.freeze({
  lathe: 512,
  tube: 1024,
  shape: 2048,
  loftSections: 256,
  loftPointsPerSection: 256,
  loftTotalPoints: 65_536,
});
const MAX_SHAPE_HOLES = 64;
const MAX_COORDINATE = 1_000_000;
const MAX_RUNTIME_GEOMETRY_VERTICES = 1_000_000;
const MAX_RUNTIME_GEOMETRY_TRIANGLES = 2_000_000;

export const RUNTIME_GEOMETRY_LIMITS = Object.freeze({
  maxVertices: MAX_RUNTIME_GEOMETRY_VERTICES,
  maxTriangles: MAX_RUNTIME_GEOMETRY_TRIANGLES,
});

const DATA_GEOMETRY_KINDS = Object.freeze(['explicit', 'indexedMesh', 'editableMesh']);
const PROCEDURAL_GEOMETRY_KINDS = Object.freeze(Object.keys(GEOMETRY_PARAMETER_DEFAULTS));
export const GEOMETRY_RECIPE_KINDS = Object.freeze([
  ...PROCEDURAL_GEOMETRY_KINDS,
  ...DATA_GEOMETRY_KINDS,
]);

const GEOMETRY_KIND_NOTES = Object.freeze({
  lathe: 'Revolve a bounded 2D profile around the local Y axis.',
  tube: 'Sweep a circular profile along a bounded 3D Catmull-Rom path.',
  loft: 'Connect equal-size 3D profile rings into one continuous shell.',
  csg: 'Combine bounded procedural solids with deterministic BSP union, subtraction, or intersection.',
  shape: 'Triangulate one bounded 2D contour with optional holes.',
  extrude: 'Extrude one bounded 2D contour with optional holes and bevel.',
  explicit: 'Authored triangle soup with optional normals and UVs.',
  indexedMesh: 'Authored indexed triangles with optional normals, UVs, colors, and material groups.',
  editableMesh: 'Canonical polygon/corner topology supporting guarded geometry edits and attributes.',
});

export function queryGeometryCatalog({ search, kind, limit = 50 } = {}) {
  const needle = String(search ?? '').trim().toLowerCase();
  const all = GEOMETRY_RECIPE_KINDS.map((entryKind) => {
    const defaults = GEOMETRY_PARAMETER_DEFAULTS[entryKind] ?? {};
    const controlLimits = entryKind === 'loft'
      ? {
          sections: GEOMETRY_CONTROL_POINT_LIMITS.loftSections,
          pointsPerSection: GEOMETRY_CONTROL_POINT_LIMITS.loftPointsPerSection,
          totalPoints: GEOMETRY_CONTROL_POINT_LIMITS.loftTotalPoints,
        }
      : (GEOMETRY_CONTROL_POINT_LIMITS[entryKind]
          ? { controlPoints: GEOMETRY_CONTROL_POINT_LIMITS[entryKind] }
          : undefined);
    return Object.freeze({
      kind: entryKind,
      category: DATA_GEOMETRY_KINDS.includes(entryKind) ? 'authored-data' : 'procedural',
      editable: entryKind === 'editableMesh',
      realizable: entryKind !== 'editableMesh',
      meshElements: DATA_GEOMETRY_KINDS.includes(entryKind),
      fields: Object.keys(defaults),
      defaults,
      ...(controlLimits ? { controlLimits } : {}),
      runtimeLimits: RUNTIME_GEOMETRY_LIMITS,
      summary: GEOMETRY_KIND_NOTES[entryKind] ?? `Create bounded ${entryKind} geometry.`,
    });
  });
  const matched = all.filter(entry => (
    (!kind || entry.kind === kind || entry.category === kind)
    && (!needle || `${entry.kind} ${entry.summary} ${entry.fields.join(' ')}`.toLowerCase().includes(needle))
  ));
  const entries = matched.slice(0, Math.max(1, Math.min(200, limit)));
  return Object.freeze({ version: 1, total: all.length, matched: matched.length, returned: entries.length, entries });
}

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function integer(value, fallback, minimum = 1, maximum = 512) {
  return Math.min(maximum, Math.max(minimum, Math.trunc(finite(value, fallback))));
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function proceduralCountEstimate(recipe) {
  const segment = (key, fallback = 1) => Math.max(1, Math.trunc(recipe[key] ?? fallback));
  const pointCount = Array.isArray(recipe.points)
    ? recipe.points.length + (Array.isArray(recipe.holes)
        ? recipe.holes.reduce((count, hole) => count + (Array.isArray(hole) ? hole.length : 0), 0)
        : 0)
    : 0;
  if (recipe.kind === 'box') {
    const x = segment('widthSegments');
    const y = segment('heightSegments');
    const z = segment('depthSegments');
    return {
      vertices: 2 * ((x + 1) * (y + 1) + (x + 1) * (z + 1) + (y + 1) * (z + 1)),
      triangles: 4 * (x * y + x * z + y * z),
    };
  }
  if (recipe.kind === 'plane') {
    const x = segment('widthSegments');
    const y = segment('heightSegments');
    return { vertices: (x + 1) * (y + 1), triangles: 2 * x * y };
  }
  if (recipe.kind === 'sphere') {
    const x = segment('widthSegments', 32);
    const y = segment('heightSegments', 16);
    return { vertices: (x + 1) * (y + 1), triangles: 2 * x * y };
  }
  if (recipe.kind === 'capsule') {
    const radial = segment('radialSegments', 16);
    const rings = segment('capSegments', 8) * 2 + 2;
    return { vertices: (radial + 1) * (rings + 1), triangles: 2 * radial * rings };
  }
  if (recipe.kind === 'circle') {
    const segments = segment('segments', 32);
    return { vertices: segments + 2, triangles: segments };
  }
  if (recipe.kind === 'cone' || recipe.kind === 'cylinder') {
    const radial = segment('radialSegments', 32);
    const height = segment('heightSegments');
    const caps = recipe.openEnded === true ? 0 : 2;
    return {
      vertices: (radial + 1) * (height + 1) + caps * (2 * radial + 1),
      triangles: 2 * radial * height + caps * radial,
    };
  }
  if (recipe.kind === 'torus' || recipe.kind === 'torusKnot') {
    const radial = segment('radialSegments', 16);
    const tubular = segment('tubularSegments', 48);
    return { vertices: (radial + 1) * (tubular + 1), triangles: 2 * radial * tubular };
  }
  if (recipe.kind === 'lathe') {
    const segments = segment('segments', 24);
    return { vertices: (segments + 1) * pointCount, triangles: 2 * segments * Math.max(0, pointCount - 1) };
  }
  if (recipe.kind === 'tube') {
    const tubular = segment('tubularSegments', 64);
    const radial = segment('radialSegments', 8);
    return { vertices: (tubular + 1) * (radial + 1), triangles: 2 * tubular * radial };
  }
  if (recipe.kind === 'loft') {
    const sections = Array.isArray(recipe.sections) ? recipe.sections.length : 0;
    const firstPoints = Array.isArray(recipe.sections?.[0])
      ? recipe.sections[0]
      : recipe.sections?.[0]?.points;
    const profile = recipe.profileResolution ?? (Array.isArray(firstPoints) ? firstPoints.length : 0);
    const evaluatedSections = Math.max(0, sections - 1) * (Math.max(0, recipe.subdivisions ?? 0) + 1) + (sections > 0 ? 1 : 0);
    const sideTriangles = Math.max(0, evaluatedSections - 1) * profile * 2;
    const capTriangles = recipe.closedProfile === false ? 0
      : (recipe.capStart === false ? 0 : Math.max(0, profile - 2))
        + (recipe.capEnd === false ? 0 : Math.max(0, profile - 2));
    return { vertices: evaluatedSections * profile, triangles: sideTriangles + capTriangles };
  }
  if (recipe.kind === 'csg') {
    return { vertices: MAX_RUNTIME_GEOMETRY_VERTICES, triangles: MAX_RUNTIME_GEOMETRY_TRIANGLES };
  }
  if (recipe.kind === 'shape') return { vertices: pointCount, triangles: Math.max(0, pointCount * 2) };
  if (recipe.kind === 'extrude') {
    const layers = segment('steps') + 1 + (recipe.bevelEnabled ? 2 * (segment('bevelSegments', 3) + 1) : 0);
    return { vertices: pointCount * layers * 4, triangles: pointCount * Math.max(1, layers - 1) * 8 };
  }
  return null;
}

function assertRuntimeGeometryBudget(recipe) {
  const estimate = proceduralCountEstimate(recipe);
  if (!estimate) return;
  if (estimate.vertices <= MAX_RUNTIME_GEOMETRY_VERTICES
      && estimate.triangles <= MAX_RUNTIME_GEOMETRY_TRIANGLES) return;
  const error = new Error(
    `Geometry ${recipe.kind} is estimated at ${estimate.vertices} vertices and ${estimate.triangles} triangles, `
      + `exceeding the runtime budget of ${MAX_RUNTIME_GEOMETRY_VERTICES} vertices and ${MAX_RUNTIME_GEOMETRY_TRIANGLES} triangles.`,
  );
  error.code = 'geometry_budget_exceeded';
  error.details = { kind: recipe.kind, estimated: estimate, limits: RUNTIME_GEOMETRY_LIMITS };
  throw error;
}

function recipeOf(resource) {
  const enclosed = resource?.recipe !== undefined || resource?.parameters !== undefined;
  const recipe = resource?.recipe ?? resource?.parameters ?? resource ?? {};
  const directType = ['editableMesh', 'indexedMesh', 'explicit'].includes(resource?.type)
    ? resource.type
    : undefined;
  const kind = enclosed
    ? (recipe.kind ?? recipe.type ?? resource?.geometryKind ?? resource?.kind ?? 'box')
    : (directType ?? resource?.geometryKind ?? recipe.kind ?? recipe.type ?? 'box');
  return enclosed ? { kind, ...recipe } : { ...recipe, kind };
}

export function normalizeGeometryRecipe(resource = {}) {
  const source = recipeOf(resource);
  const defaults = GEOMETRY_PARAMETER_DEFAULTS[source.kind] ?? {};
  const recipe = { ...defaults, ...source };
  for (const key of Object.keys(recipe)) {
    if (key.endsWith('Segments') && !(source.kind === 'extrude' && key === 'bevelSegments')) {
      recipe[key] = integer(recipe[key], defaults[key] ?? 1);
    }
  }
  if (source.kind === 'lathe') {
    recipe.points = clonePoints(source.points ?? source.profile ?? defaults.points);
    recipe.segments = integer(recipe.segments, defaults.segments, 3, 256);
  } else if (source.kind === 'tube') {
    recipe.points = clonePoints(source.points ?? source.path ?? defaults.points);
    recipe.tubularSegments = integer(recipe.tubularSegments, defaults.tubularSegments, 1, 512);
    recipe.radialSegments = integer(recipe.radialSegments, defaults.radialSegments, 3, 128);
  } else if (source.kind === 'loft') {
    recipe.sections = Array.isArray(source.sections)
      ? source.sections.map(section => (Array.isArray(section)
          ? clonePoints(section)
          : { ...section, points: clonePoints(section?.points) }))
      : source.sections;
    recipe.closedProfile = bool(source.closedProfile, defaults.closedProfile);
    recipe.capStart = bool(source.capStart, defaults.capStart);
    recipe.capEnd = bool(source.capEnd, defaults.capEnd);
    recipe.profileResolution = source.profileResolution == null
      ? null
      : integer(source.profileResolution, 8, 3, GEOMETRY_CONTROL_POINT_LIMITS.loftPointsPerSection);
    recipe.subdivisions = integer(source.subdivisions, defaults.subdivisions, 0, 32);
    recipe.alignProfile = source.alignProfile ?? defaults.alignProfile;
    recipe.continuity = source.continuity ?? defaults.continuity;
    recipe.guideCurves = Array.isArray(source.guideCurves)
      ? source.guideCurves.map(guide => ({ ...guide, points: clonePoints(guide?.points) }))
      : [];
    recipe.modifiers = Array.isArray(source.modifiers)
      ? source.modifiers.map(modifier => ({ ...modifier, center: clonePoints([modifier?.center])?.[0] }))
      : [];
  } else if (source.kind === 'csg') {
    recipe.operation = source.operation ?? defaults.operation;
    recipe.operands = Array.isArray(source.operands)
      ? source.operands.map(operand => ({
          recipe: normalizeGeometryRecipe(operand?.recipe ?? {}),
          ...(operand?.transform ? { transform: {
            ...operand.transform,
            translation: clonePoints([operand.transform.translation ?? operand.transform.position])?.[0],
            rotation: clonePoints([operand.transform.rotation])?.[0],
            scale: clonePoints([operand.transform.scale])?.[0],
          } } : {}),
        }))
      : source.operands;
  } else if (source.kind === 'shape' || source.kind === 'extrude') {
    recipe.points = clonePoints(source.points ?? source.contour ?? defaults.points);
    recipe.holes = cloneContours(recipe.holes);
    recipe.curveSegments = integer(recipe.curveSegments, defaults.curveSegments, 1, 64);
    if (source.kind === 'extrude') {
      recipe.steps = integer(recipe.steps, defaults.steps, 1, 128);
      recipe.bevelSegments = integer(recipe.bevelSegments, defaults.bevelSegments, 0, 16);
    }
  }
  return recipe;
}

function clonePoints(points) {
  if (!Array.isArray(points)) return points;
  return points.map((point) => Array.isArray(point) ? [...point] : (point && typeof point === 'object' ? { ...point } : point));
}

function cloneContours(contours) {
  if (!Array.isArray(contours)) return contours;
  return contours.map((contour) => clonePoints(contour));
}

function boundedFinite(value, fallback, minimum, maximum, label) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return Math.min(maximum, Math.max(minimum, value));
}

function pointCoordinates(point, dimensions, label, index) {
  const keys = dimensions === 2 ? ['x', 'y'] : ['x', 'y', 'z'];
  const values = Array.isArray(point) ? point.slice(0, dimensions) : keys.map((key) => point?.[key]);
  if (values.length !== dimensions || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`${label}[${index}] must contain ${dimensions} finite coordinates.`);
  }
  if (values.some((value) => Math.abs(value) > MAX_COORDINATE)) {
    throw new Error(`${label}[${index}] exceeds the coordinate budget of ${MAX_COORDINATE}.`);
  }
  return values;
}

function validatedPoints(points, dimensions, minimum, maximum, label) {
  if (!Array.isArray(points) || points.length < minimum) {
    throw new Error(`${label} requires at least ${minimum} control points.`);
  }
  if (points.length > maximum) {
    throw new Error(`${label} exceeds the control-point budget of ${maximum}.`);
  }
  const values = points.map((point, index) => pointCoordinates(point, dimensions, label, index));
  const distinct = new Set(values.map((point) => point.join('\u0000')));
  if (distinct.size < minimum) throw new Error(`${label} requires at least ${minimum} distinct control points.`);
  return values;
}

function requireConstructor(THREE, name) {
  if (typeof THREE?.[name] !== 'function') throw new Error(`Three.js runtime does not expose ${name}.`);
  return THREE[name];
}

function finishProceduralGeometry(geometry) {
  if (!geometry?.getAttribute?.('normal') && typeof geometry?.computeVertexNormals === 'function') geometry.computeVertexNormals();
  if (typeof geometry?.computeBoundingBox === 'function') geometry.computeBoundingBox();
  if (typeof geometry?.computeBoundingSphere === 'function') geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Blender's Generated socket is the undeformed local bounding-box coordinate
 * normalized to 0..1. Store it as a geometry attribute so one shared material
 * remains correct across differently sized meshes.
 */
export function ensureGeneratedCoordinateAttribute(THREE, geometry) {
  const position = geometry?.getAttribute?.('position');
  if (!position || geometry.getAttribute('studioGenerated')) return geometry;
  geometry.computeBoundingBox?.();
  const bounds = geometry.boundingBox;
  if (!bounds || typeof THREE?.Float32BufferAttribute !== 'function') return geometry;
  const size = {
    x: Math.max(1e-7, bounds.max.x - bounds.min.x),
    y: Math.max(1e-7, bounds.max.y - bounds.min.y),
    z: Math.max(1e-7, bounds.max.z - bounds.min.z),
  };
  const values = new Float32Array(position.count * 3);
  for (let index = 0; index < position.count; index += 1) {
    values[index * 3] = (position.getX(index) - bounds.min.x) / size.x;
    values[index * 3 + 1] = (position.getY(index) - bounds.min.y) / size.y;
    values[index * 3 + 2] = (position.getZ(index) - bounds.min.z) / size.z;
  }
  geometry.setAttribute('studioGenerated', new THREE.Float32BufferAttribute(values, 3));
  return geometry;
}

function shapeFromRecipe(THREE, recipe) {
  const Shape = requireConstructor(THREE, 'Shape');
  const Path = requireConstructor(THREE, 'Path');
  const contour = validatedPoints(recipe.points, 2, 3, GEOMETRY_CONTROL_POINT_LIMITS.shape, 'Shape contour');
  if (!Array.isArray(recipe.holes)) throw new Error('Shape holes must be an array of contours.');
  if (recipe.holes.length > MAX_SHAPE_HOLES) throw new Error(`Shape exceeds the hole budget of ${MAX_SHAPE_HOLES}.`);

  let pointCount = contour.length;
  const holes = recipe.holes.map((hole, index) => {
    const points = validatedPoints(hole, 2, 3, GEOMETRY_CONTROL_POINT_LIMITS.shape, `Shape hole ${index}`);
    pointCount += points.length;
    if (pointCount > GEOMETRY_CONTROL_POINT_LIMITS.shape) {
      throw new Error(`Shape exceeds the total control-point budget of ${GEOMETRY_CONTROL_POINT_LIMITS.shape}.`);
    }
    return points;
  });

  const shape = new Shape();
  shape.moveTo(contour[0][0], contour[0][1]);
  for (const point of contour.slice(1)) shape.lineTo(point[0], point[1]);
  for (const hole of holes) {
    const path = new Path();
    path.moveTo(hole[0][0], hole[0][1]);
    for (const point of hole.slice(1)) path.lineTo(point[0], point[1]);
    shape.holes.push(path);
  }
  return shape;
}

function latheGeometry(THREE, recipe) {
  const Vector2 = requireConstructor(THREE, 'Vector2');
  const LatheGeometry = requireConstructor(THREE, 'LatheGeometry');
  const points = validatedPoints(recipe.points, 2, 2, GEOMETRY_CONTROL_POINT_LIMITS.lathe, 'Lathe profile');
  if (points.some(([radius]) => radius < 0)) throw new Error('Lathe profile radii must be non-negative.');
  const phiStart = boundedFinite(recipe.phiStart, 0, -Math.PI * 2, Math.PI * 2, 'Lathe phiStart');
  const phiLength = boundedFinite(recipe.phiLength, Math.PI * 2, Number.EPSILON, Math.PI * 2, 'Lathe phiLength');
  return finishProceduralGeometry(new LatheGeometry(
    points.map(([x, y]) => new Vector2(x, y)),
    integer(recipe.segments, 24, 3, 256),
    phiStart,
    phiLength,
  ));
}

function tubeGeometry(THREE, recipe) {
  const Vector3 = requireConstructor(THREE, 'Vector3');
  const CatmullRomCurve3 = requireConstructor(THREE, 'CatmullRomCurve3');
  const TubeGeometry = requireConstructor(THREE, 'TubeGeometry');
  const closed = bool(recipe.closed, false);
  const points = validatedPoints(recipe.points, 3, closed ? 3 : 2, GEOMETRY_CONTROL_POINT_LIMITS.tube, 'Tube path');
  const allowedCurveTypes = new Set(['centripetal', 'chordal', 'catmullrom']);
  if (!allowedCurveTypes.has(recipe.curveType)) {
    throw new Error('Tube curveType must be centripetal, chordal, or catmullrom.');
  }
  const radius = boundedFinite(recipe.radius, 0.08, Number.EPSILON, MAX_COORDINATE, 'Tube radius');
  const tension = boundedFinite(recipe.tension, 0.5, 0, 1, 'Tube tension');
  const curve = new CatmullRomCurve3(
    points.map(([x, y, z]) => new Vector3(x, y, z)),
    closed,
    recipe.curveType,
    tension,
  );
  return finishProceduralGeometry(new TubeGeometry(
    curve,
    integer(recipe.tubularSegments, 64, 1, 512),
    radius,
    integer(recipe.radialSegments, 8, 3, 128),
    closed,
  ));
}

function transformLoftPoint(point, transform = {}) {
  const scale = Array.isArray(transform.scale) ? transform.scale : [1, 1, 1];
  const rotation = Array.isArray(transform.rotation) ? transform.rotation : [0, 0, 0];
  const translation = Array.isArray(transform.translation) ? transform.translation : [0, 0, 0];
  for (const [name, value] of [['scale', scale], ['rotation', rotation], ['translation', translation]]) {
    if (value.length !== 3 || value.some(component => !Number.isFinite(component))) {
      throw new Error(`Loft section ${name} must contain three finite numbers.`);
    }
  }
  let [x, y, z] = point.map((value, axis) => value * scale[axis]);
  const [rx, ry, rz] = rotation;
  [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
  [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
  return [x + translation[0], y + translation[1], z + translation[2]];
}

function resampleLoftProfile(points, count, closed) {
  if (points.length === count) return points.map(point => [...point]);
  const segmentCount = closed ? points.length : points.length - 1;
  const lengths = [];
  let total = 0;
  for (let index = 0; index < segmentCount; index += 1) {
    const next = points[(index + 1) % points.length];
    const current = points[index];
    total += Math.hypot(next[0] - current[0], next[1] - current[1], next[2] - current[2]);
    lengths.push(total);
  }
  if (!(total > 0)) throw new Error('Loft profile perimeter must be greater than zero.');
  return Array.from({ length: count }, (_, sample) => {
    const distance = total * (closed ? sample / count : sample / Math.max(1, count - 1));
    let segment = lengths.findIndex(end => end >= distance);
    if (segment < 0) segment = lengths.length - 1;
    const startDistance = segment === 0 ? 0 : lengths[segment - 1];
    const span = Math.max(Number.EPSILON, lengths[segment] - startDistance);
    const factor = Math.min(1, Math.max(0, (distance - startDistance) / span));
    const start = points[segment];
    const end = points[(segment + 1) % points.length];
    return start.map((value, axis) => value + (end[axis] - value) * factor);
  });
}

function alignedLoftProfile(previous, current, enabled) {
  if (!enabled || previous.length !== current.length) return current;
  let bestOffset = 0;
  let bestDistance = Infinity;
  for (let offset = 0; offset < current.length; offset += 1) {
    let distance = 0;
    for (let index = 0; index < current.length; index += 1) {
      const point = current[(index + offset) % current.length];
      const prior = previous[index];
      distance += (point[0] - prior[0]) ** 2 + (point[1] - prior[1]) ** 2 + (point[2] - prior[2]) ** 2;
    }
    if (distance < bestDistance) [bestDistance, bestOffset] = [distance, offset];
  }
  return current.map((_, index) => current[(index + bestOffset) % current.length]);
}

export function evaluateLoftSections(recipe) {
  if (!Array.isArray(recipe.sections) || recipe.sections.length < 2
      || recipe.sections.length > GEOMETRY_CONTROL_POINT_LIMITS.loftSections) {
    throw new Error(`Loft requires 2 to ${GEOMETRY_CONTROL_POINT_LIMITS.loftSections} sections.`);
  }
  const closed = bool(recipe.closedProfile, true);
  const authored = recipe.sections.map((section, index) => {
    const descriptor = Array.isArray(section) ? { points: section } : section;
    if (!descriptor || typeof descriptor !== 'object') throw new Error(`Loft section ${index} must be a point array or descriptor.`);
    if (descriptor.id !== undefined && (typeof descriptor.id !== 'string' || !/^[A-Za-z][A-Za-z0-9/_-]{0,127}$/u.test(descriptor.id))) {
      throw new Error(`Loft section ${index} id is invalid.`);
    }
    const points = validatedPoints(
      descriptor.points, 3, 3, GEOMETRY_CONTROL_POINT_LIMITS.loftPointsPerSection, `Loft section ${index}`,
    );
    return points.map(point => transformLoftPoint(point, descriptor.transform));
  });
  const profileSize = recipe.profileResolution ?? authored[0].length;
  if (recipe.profileResolution == null && authored.some(section => section.length !== profileSize)) {
    throw new Error('Every loft section must contain the same number of profile points.');
  }
  let sections = authored.map((section, index) => alignedLoftProfile(
    index === 0 ? section : resampleLoftProfile(authored[index - 1], profileSize, closed),
    resampleLoftProfile(section, profileSize, closed),
    recipe.alignProfile === 'closest' && closed && index > 0,
  ));
  if (!['authored', 'closest'].includes(recipe.alignProfile)) throw new Error('Loft alignProfile must be authored or closest.');
  if (!['positional', 'tangent', 'curvature'].includes(recipe.continuity)) {
    throw new Error('Loft continuity must be positional, tangent, or curvature.');
  }
  if (!Array.isArray(recipe.guideCurves) || recipe.guideCurves.length > 32) {
    throw new Error('Loft supports at most 32 guide curves.');
  }
  for (let guideIndex = 0; guideIndex < recipe.guideCurves.length; guideIndex += 1) {
    const guide = recipe.guideCurves[guideIndex];
    const points = validatedPoints(guide?.points, 3, 2, 256, `Loft guide ${guideIndex}`);
    let profileIndex = guide?.profileIndex;
    if (profileIndex === undefined) {
      profileIndex = sections[0].reduce((best, point, index) => {
        const distance = point.reduce((sum, value, axis) => sum + (value - points[0][axis]) ** 2, 0);
        return distance < best.distance ? { index, distance } : best;
      }, { index: 0, distance: Infinity }).index;
    }
    if (!Number.isInteger(profileIndex) || profileIndex < 0 || profileIndex >= profileSize) {
      throw new Error(`Loft guide ${guideIndex} profileIndex must address the resampled profile.`);
    }
    sections = sections.map((section, sectionIndex) => {
      const factor = sectionIndex / Math.max(1, sections.length - 1);
      const scaled = factor * (points.length - 1);
      const pointIndex = Math.min(points.length - 2, Math.floor(scaled));
      const local = scaled - pointIndex;
      const guided = points[pointIndex].map((value, axis) => value + (points[pointIndex + 1][axis] - value) * local);
      const copy = section.map(point => [...point]);
      copy[profileIndex] = guided;
      return copy;
    });
  }
  if (!Array.isArray(recipe.modifiers) || recipe.modifiers.length > 32) {
    throw new Error('Loft supports at most 32 local form modifiers.');
  }
  for (const modifier of recipe.modifiers) {
    if (!['bulge', 'pinch', 'offset'].includes(modifier?.kind)) throw new Error(`Unsupported loft modifier ${modifier?.kind}.`);
    const amount = boundedFinite(modifier.amount, 0, -MAX_COORDINATE, MAX_COORDINATE, 'Loft modifier amount');
    const center = pointCoordinates(modifier.center ?? [0, 0, 0], 3, 'Loft modifier center', 0);
    const radius = modifier.kind === 'offset'
      ? Infinity
      : boundedFinite(modifier.radius, 1, Number.EPSILON, MAX_COORDINATE, 'Loft modifier radius');
    const signedAmount = modifier.kind === 'pinch' ? -Math.abs(amount) : amount;
    sections = sections.map((section) => {
      const sectionCenter = section.reduce((sum, point) => sum.map((value, axis) => value + point[axis] / section.length), [0, 0, 0]);
      return section.map((point) => {
        const distance = Math.hypot(...point.map((value, axis) => value - center[axis]));
        const falloff = radius === Infinity ? 1 : Math.max(0, 1 - distance / radius) ** 2;
        if (falloff === 0) return point;
        const radial = point.map((value, axis) => value - sectionCenter[axis]);
        const radialLength = Math.hypot(...radial) || 1;
        return point.map((value, axis) => value + radial[axis] / radialLength * signedAmount * falloff);
      });
    });
  }
  const subdivisions = integer(recipe.subdivisions, 0, 0, 32);
  const evaluated = [];
  for (let section = 0; section < sections.length - 1; section += 1) {
    evaluated.push(sections[section]);
    for (let step = 1; step <= subdivisions; step += 1) {
      const rawFactor = step / (subdivisions + 1);
      const factor = recipe.continuity === 'tangent'
        ? rawFactor * rawFactor * (3 - 2 * rawFactor)
        : recipe.continuity === 'curvature'
          ? rawFactor ** 3 * (rawFactor * (rawFactor * 6 - 15) + 10)
          : rawFactor;
      evaluated.push(sections[section].map((point, index) => point.map(
        (value, axis) => value + (sections[section + 1][index][axis] - value) * factor,
      )));
    }
  }
  evaluated.push(sections.at(-1));
  if (evaluated.length * profileSize > GEOMETRY_CONTROL_POINT_LIMITS.loftTotalPoints) {
    throw new Error(`Loft exceeds ${GEOMETRY_CONTROL_POINT_LIMITS.loftTotalPoints} total control points.`);
  }
  return { sections: evaluated, profileSize, closed };
}

function loftGeometry(THREE, recipe) {
  const { sections, profileSize, closed } = evaluateLoftSections(recipe);
  const positions = sections.flat(2);
  const uvs = [];
  for (let section = 0; section < sections.length; section += 1) {
    for (let point = 0; point < profileSize; point += 1) {
      uvs.push(closed ? point / profileSize : point / Math.max(1, profileSize - 1), section / (sections.length - 1));
    }
  }
  const indices = [];
  const edges = closed ? profileSize : profileSize - 1;
  let reverseWinding = false;
  if (closed) {
    let orientation = 0;
    for (let section = 0; section < sections.length - 1; section += 1) {
      const currentCenter = [0, 0, 0];
      const nextCenter = [0, 0, 0];
      for (let point = 0; point < profileSize; point += 1) {
        for (let axis = 0; axis < 3; axis += 1) {
          currentCenter[axis] += sections[section][point][axis] / profileSize;
          nextCenter[axis] += sections[section + 1][point][axis] / profileSize;
        }
      }
      const center = currentCenter.map((value, axis) => (value + nextCenter[axis]) * 0.5);
      for (let point = 0; point < profileSize; point += 1) {
        const next = (point + 1) % profileSize;
        const a = sections[section][point];
        const b = sections[section][next];
        const d = sections[section + 1][point];
        const edge = b.map((value, axis) => value - a[axis]);
        const span = d.map((value, axis) => value - a[axis]);
        const normal = [
          edge[1] * span[2] - edge[2] * span[1],
          edge[2] * span[0] - edge[0] * span[2],
          edge[0] * span[1] - edge[1] * span[0],
        ];
        const faceCenter = a.map((value, axis) => (
          value + b[axis] + sections[section + 1][next][axis] + d[axis]
        ) * 0.25);
        orientation += normal.reduce((sum, value, axis) => sum + value * (faceCenter[axis] - center[axis]), 0);
      }
    }
    reverseWinding = orientation < 0;
  }
  for (let section = 0; section < sections.length - 1; section += 1) {
    for (let point = 0; point < edges; point += 1) {
      const next = (point + 1) % profileSize;
      const a = section * profileSize + point;
      const b = section * profileSize + next;
      const c = (section + 1) * profileSize + next;
      const d = (section + 1) * profileSize + point;
      if (reverseWinding) indices.push(a, d, b, b, d, c);
      else indices.push(a, b, d, b, c, d);
    }
  }
  if (closed && recipe.capStart !== false) {
    for (let point = 1; point < profileSize - 1; point += 1) {
      if (reverseWinding) indices.push(0, point, point + 1);
      else indices.push(0, point + 1, point);
    }
  }
  if (closed && recipe.capEnd !== false) {
    const offset = (sections.length - 1) * profileSize;
    for (let point = 1; point < profileSize - 1; point += 1) {
      if (reverseWinding) indices.push(offset, offset + point + 1, offset + point);
      else indices.push(offset, offset + point, offset + point + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function shapeGeometry(THREE, recipe) {
  const ShapeGeometry = requireConstructor(THREE, 'ShapeGeometry');
  return finishProceduralGeometry(new ShapeGeometry(
    shapeFromRecipe(THREE, recipe),
    integer(recipe.curveSegments, 12, 1, 64),
  ));
}

function extrudeGeometry(THREE, recipe) {
  const ExtrudeGeometry = requireConstructor(THREE, 'ExtrudeGeometry');
  const options = {
    curveSegments: integer(recipe.curveSegments, 12, 1, 64),
    steps: integer(recipe.steps, 1, 1, 128),
    depth: boundedFinite(recipe.depth, 0.25, -MAX_COORDINATE, MAX_COORDINATE, 'Extrude depth'),
    bevelEnabled: bool(recipe.bevelEnabled, false),
    bevelThickness: boundedFinite(recipe.bevelThickness, 0.1, 0, MAX_COORDINATE, 'Extrude bevelThickness'),
    bevelSize: boundedFinite(recipe.bevelSize, 0.08, 0, MAX_COORDINATE, 'Extrude bevelSize'),
    bevelOffset: boundedFinite(recipe.bevelOffset, 0, -MAX_COORDINATE, MAX_COORDINATE, 'Extrude bevelOffset'),
    bevelSegments: integer(recipe.bevelSegments, 3, 0, 16),
  };
  return finishProceduralGeometry(new ExtrudeGeometry(shapeFromRecipe(THREE, recipe), options));
}

function explicitGeometry(THREE, recipe) {
  const geometry = new THREE.BufferGeometry();
  const positions = recipe.positions ?? recipe.attributes?.position;
  if (!Array.isArray(positions) || positions.length < 3 || positions.length % 3 !== 0) {
    throw new Error('Explicit geometry requires a positions array divisible by three.');
  }
  if (positions.length / 3 > MAX_RUNTIME_GEOMETRY_VERTICES) {
    const error = new Error(`Explicit geometry exceeds ${MAX_RUNTIME_GEOMETRY_VERTICES} vertices.`);
    error.code = 'geometry_budget_exceeded';
    throw error;
  }
  if (Array.isArray(recipe.indices) && recipe.indices.length / 3 > MAX_RUNTIME_GEOMETRY_TRIANGLES) {
    const error = new Error(`Explicit geometry exceeds ${MAX_RUNTIME_GEOMETRY_TRIANGLES} triangles.`);
    error.code = 'geometry_budget_exceeded';
    throw error;
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const normals = recipe.normals ?? recipe.attributes?.normal;
  const uvs = recipe.uvs ?? recipe.attributes?.uv;
  const colors = recipe.colors ?? recipe.attributes?.color;
  if (Array.isArray(normals) && normals.length === positions.length) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  if (Array.isArray(uvs) && uvs.length === positions.length / 3 * 2) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (Array.isArray(colors) && (colors.length === positions.length || colors.length === positions.length / 3 * 4)) {
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, colors.length / (positions.length / 3)));
  }
  if (Array.isArray(recipe.indices)) geometry.setIndex(recipe.indices);
  applyTriangleMaterialGroups(geometry, recipe);
  if (!geometry.getAttribute('normal') && recipe.computeNormals !== false) geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function triangleCountForRecipe(recipe) {
  if (Array.isArray(recipe.indices)) return recipe.indices.length / 3;
  const positions = recipe.positions ?? recipe.attributes?.position;
  return Array.isArray(positions) ? positions.length / 9 : 0;
}

function applyTriangleMaterialGroups(geometry, recipe) {
  const materialIndices = recipe.triangleMaterialIndices;
  if (materialIndices === undefined) return geometry;
  const triangleCount = triangleCountForRecipe(recipe);
  if (!Array.isArray(materialIndices) || materialIndices.length !== triangleCount) {
    throw new Error(`triangleMaterialIndices must contain exactly ${triangleCount} material slots.`);
  }
  for (let index = 0; index < materialIndices.length; index += 1) {
    const value = materialIndices[index];
    if (!Number.isInteger(value) || value < 0 || value >= MAX_MATERIAL_SLOTS_PER_MESH) {
      throw new Error(`triangleMaterialIndices[${index}] must be an integer from 0 to ${MAX_MATERIAL_SLOTS_PER_MESH - 1}.`);
    }
  }
  geometry.clearGroups?.();
  if (typeof geometry.addGroup === 'function' && materialIndices.length > 0) {
    let startTriangle = 0;
    let materialIndex = materialIndices[0];
    for (let triangle = 1; triangle <= materialIndices.length; triangle += 1) {
      const next = materialIndices[triangle];
      if (triangle < materialIndices.length && next === materialIndex) continue;
      geometry.addGroup(startTriangle * 3, (triangle - startTriangle) * 3, materialIndex);
      startTriangle = triangle;
      materialIndex = next;
    }
  }
  geometry.userData = {
    ...(geometry.userData ?? {}),
    studioTriangleMaterialIndices: [...materialIndices],
    studioMaterialSlotCount: materialIndices.length === 0 ? 0 : Math.max(...materialIndices) + 1,
  };
  return geometry;
}

function attributeValues(attribute, itemSize) {
  if (!attribute || attribute.count < 1) return null;
  const getters = ['getX', 'getY', 'getZ', 'getW'];
  const result = [];
  for (let index = 0; index < attribute.count; index += 1) {
    for (let component = 0; component < itemSize; component += 1) {
      const getter = attribute[getters[component]];
      const value = typeof getter === 'function'
        ? getter.call(attribute, index)
        : attribute.array?.[index * (attribute.itemSize ?? itemSize) + component];
      if (!Number.isFinite(value)) throw new Error('Buffer geometry contains a non-finite attribute value.');
      result.push(value);
    }
  }
  return result;
}

/**
 * Captures a Three.js BufferGeometry as an immutable canonical indexed mesh.
 * This is used only as a bounded bridge for applying pure geometry modifiers
 * to procedural resources; the source BufferGeometry is never modified.
 */
export function indexedMeshRecipeFromBufferGeometry(geometry, { captureMaterialGroups = false } = {}) {
  const position = geometry?.getAttribute?.('position');
  if (!position || position.count < 3) throw new Error('Buffer geometry requires at least three positions.');
  if (position.count > MAX_RUNTIME_GEOMETRY_VERTICES) {
    const error = new Error(`Buffer geometry exceeds ${MAX_RUNTIME_GEOMETRY_VERTICES} vertices before attribute readback.`);
    error.code = 'geometry_budget_exceeded';
    throw error;
  }
  let indices;
  const indexAttribute = geometry.getIndex?.() ?? geometry.index;
  const triangleCount = indexAttribute ? indexAttribute.count / 3 : position.count / 3;
  if (triangleCount > MAX_RUNTIME_GEOMETRY_TRIANGLES) {
    const error = new Error(`Buffer geometry exceeds ${MAX_RUNTIME_GEOMETRY_TRIANGLES} triangles before index readback.`);
    error.code = 'geometry_budget_exceeded';
    throw error;
  }
  const positions = attributeValues(position, 3);
  if (indexAttribute) {
    indices = [];
    for (let index = 0; index < indexAttribute.count; index += 1) {
      const value = typeof indexAttribute.getX === 'function'
        ? indexAttribute.getX(index)
        : indexAttribute.array?.[index];
      if (!Number.isInteger(value)) throw new Error('Buffer geometry index values must be integers.');
      indices.push(value);
    }
  } else {
    if (position.count % 3 !== 0) throw new Error('Non-indexed buffer geometry must contain complete triangles.');
    indices = Array.from({ length: position.count }, (_, index) => index);
  }
  if (indices.length < 3 || indices.length % 3 !== 0) {
    throw new Error('Buffer geometry index data must contain complete triangles.');
  }
  const recipe = { kind: 'indexedMesh', positions, indices, computeNormals: true };
  const normal = geometry.getAttribute?.('normal');
  const uv = geometry.getAttribute?.('uv');
  const color = geometry.getAttribute?.('color');
  if (normal?.count === position.count) recipe.normals = attributeValues(normal, 3);
  if (uv?.count === position.count) recipe.uvs = attributeValues(uv, 2);
  if (color?.count === position.count && [3, 4].includes(color.itemSize)) {
    recipe.colors = attributeValues(color, color.itemSize);
  }
  const authoredMaterialIndices = geometry.userData?.studioTriangleMaterialIndices;
  if (authoredMaterialIndices !== undefined) {
    if (!Array.isArray(authoredMaterialIndices)
        || authoredMaterialIndices.length !== indices.length / 3) {
      throw new Error('Authored Studio material provenance must match the exact triangle count.');
    }
    recipe.triangleMaterialIndices = [...authoredMaterialIndices];
  } else if (captureMaterialGroups && Array.isArray(geometry.groups) && geometry.groups.length > 0) {
    const groups = [...geometry.groups].sort((left, right) => left.start - right.start);
    const triangleMaterialIndices = [];
    let cursor = 0;
    for (const group of groups) {
      const valid = Number.isInteger(group.start) && Number.isInteger(group.count)
        && group.start === cursor && group.start % 3 === 0
        && group.count > 0 && group.count % 3 === 0
        && group.start + group.count <= indices.length
        && Number.isInteger(group.materialIndex) && group.materialIndex >= 0
        && group.materialIndex < MAX_MATERIAL_SLOTS_PER_MESH;
      if (!valid) {
        const error = new Error('Procedural material groups must cover the indexed draw range exactly with bounded slots.');
        error.code = 'geometry_material_groups_invalid';
        throw error;
      }
      for (let offset = 0; offset < group.count; offset += 3) {
        triangleMaterialIndices.push(group.materialIndex);
      }
      cursor += group.count;
    }
    if (cursor !== indices.length) {
      const error = new Error('Procedural material groups do not cover the complete indexed draw range.');
      error.code = 'geometry_material_groups_incomplete';
      throw error;
    }
    recipe.triangleMaterialIndices = triangleMaterialIndices;
  }
  return recipe;
}

export function createGeometry(THREE, resource = {}) {
  const p = normalizeGeometryRecipe(resource);
  assertRuntimeGeometryBudget(p);
  switch (p.kind) {
    case 'box': return new THREE.BoxGeometry(finite(p.width, 1), finite(p.height, 1), finite(p.depth, 1), integer(p.widthSegments, 1), integer(p.heightSegments, 1), integer(p.depthSegments, 1));
    case 'plane': return new THREE.PlaneGeometry(finite(p.width, 1), finite(p.height, 1), integer(p.widthSegments, 1), integer(p.heightSegments, 1));
    case 'sphere': return new THREE.SphereGeometry(finite(p.radius, 0.5), integer(p.widthSegments, 32, 3), integer(p.heightSegments, 16, 2), finite(p.phiStart, 0), finite(p.phiLength, Math.PI * 2), finite(p.thetaStart, 0), finite(p.thetaLength, Math.PI));
    case 'capsule': {
      const Constructor = THREE.CapsuleGeometry ?? THREE.CylinderGeometry;
      if (THREE.CapsuleGeometry) return new Constructor(finite(p.radius, 0.5), finite(p.length, 1), integer(p.capSegments, 8, 1), integer(p.radialSegments, 16, 3));
      return new Constructor(finite(p.radius, 0.5), finite(p.radius, 0.5), finite(p.length, 1), integer(p.radialSegments, 16, 3));
    }
    case 'circle': return new THREE.CircleGeometry(finite(p.radius, 0.5), integer(p.segments, 32, 3), finite(p.thetaStart, 0), finite(p.thetaLength, Math.PI * 2));
    case 'cone': return new THREE.ConeGeometry(finite(p.radius, 0.5), finite(p.height, 1), integer(p.radialSegments, 32, 3), integer(p.heightSegments, 1), bool(p.openEnded, false), finite(p.thetaStart, 0), finite(p.thetaLength, Math.PI * 2));
    case 'cylinder': return new THREE.CylinderGeometry(finite(p.radiusTop, 0.5), finite(p.radiusBottom, 0.5), finite(p.height, 1), integer(p.radialSegments, 32, 3), integer(p.heightSegments, 1), bool(p.openEnded, false), finite(p.thetaStart, 0), finite(p.thetaLength, Math.PI * 2));
    case 'torus': return new THREE.TorusGeometry(finite(p.radius, 0.5), finite(p.tube, 0.18), integer(p.radialSegments, 16, 3), integer(p.tubularSegments, 48, 3), finite(p.arc, Math.PI * 2));
    case 'torusKnot': return new THREE.TorusKnotGeometry(finite(p.radius, 0.5), finite(p.tube, 0.15), integer(p.tubularSegments, 96, 3), integer(p.radialSegments, 16, 3), integer(p.p, 2), integer(p.q, 3));
    case 'lathe': return latheGeometry(THREE, p);
    case 'tube': return tubeGeometry(THREE, p);
    case 'loft': return loftGeometry(THREE, p);
    case 'csg': return createCsgGeometry(THREE, p, operand => createGeometry(THREE, operand));
    case 'shape': return shapeGeometry(THREE, p);
    case 'extrude': return extrudeGeometry(THREE, p);
    case 'explicit':
    case 'indexedMesh': return explicitGeometry(THREE, p);
    case 'editableMesh': {
      const compiled = triangulateEditableMesh(recipeOf(resource));
      return explicitGeometry(THREE, {
        ...compiled.recipe,
        triangleMaterialIndices: compiled.triangleMaterialIndices,
      });
    }
    default: throw new Error(`Unsupported geometry recipe: ${p.kind}`);
  }
}

/**
 * Converts any live procedural/indexed recipe into canonical editable triangle
 * topology. This is an explicit authoring boundary: generated Three.js objects
 * remain disposable, while the returned recipe is stable project-owned data.
 */
export function realizeGeometryRecipe(THREE, resource = {}) {
  const geometry = createGeometry(THREE, resource);
  try {
    const position = geometry.getAttribute?.('position');
    if (!position || position.itemSize !== 3 || position.count < 3) {
      throw new Error('Geometry realization requires a finite position attribute with at least three vertices.');
    }
    if (position.count > MAX_RUNTIME_GEOMETRY_VERTICES) {
      throw new Error(`Geometry realization exceeds ${MAX_RUNTIME_GEOMETRY_VERTICES} vertices.`);
    }
    const positions = [];
    for (let index = 0; index < position.count; index += 1) {
      positions.push(position.getX(index), position.getY(index), position.getZ(index));
    }
    const sourceIndex = geometry.getIndex?.();
    const cornerVertexIndices = sourceIndex
      ? Array.from({ length: sourceIndex.count }, (_, index) => sourceIndex.getX(index))
      : Array.from({ length: position.count }, (_, index) => index);
    if (cornerVertexIndices.length % 3 !== 0) {
      throw new Error('Geometry realization requires triangle-list topology.');
    }
    const faceCount = cornerVertexIndices.length / 3;
    if (faceCount > MAX_RUNTIME_GEOMETRY_TRIANGLES) {
      throw new Error(`Geometry realization exceeds ${MAX_RUNTIME_GEOMETRY_TRIANGLES} triangles.`);
    }
    const faceOffsets = Array.from({ length: faceCount + 1 }, (_, index) => index * 3);
    const uv = geometry.getAttribute?.('uv');
    const uvLayers = {};
    if (uv?.itemSize === 2 && uv.count === position.count) {
      uvLayers.UVMap = cornerVertexIndices.flatMap(index => [uv.getX(index), uv.getY(index)]);
    }
    const faceMaterialIndices = Array(faceCount).fill(0);
    for (const group of geometry.groups ?? []) {
      const firstFace = Math.max(0, Math.floor(group.start / 3));
      const finalFace = Math.min(faceCount, Math.ceil((group.start + group.count) / 3));
      for (let face = firstFace; face < finalFace; face += 1) faceMaterialIndices[face] = group.materialIndex ?? 0;
    }
    return normalizeEditableMeshRecipe({
      kind: 'editableMesh',
      positions,
      faceOffsets,
      cornerVertexIndices,
      uvLayers,
      activeUvLayer: Object.keys(uvLayers)[0] ?? null,
      faceMaterialIndices,
      sharpEdges: [],
      edgeCreases: [],
    });
  } finally {
    geometry.dispose?.();
  }
}

function linearColor(THREE, value, fallback = [0.7, 0.7, 0.7]) {
  const color = new THREE.Color();
  if (Array.isArray(value) && value.length >= 3) color.setRGB(finite(value[0], fallback[0]), finite(value[1], fallback[1]), finite(value[2], fallback[2]));
  else if (typeof value === 'number' || typeof value === 'string') color.set(value);
  else color.setRGB(...fallback);
  return color;
}

function materialConstructor(THREE, kind, graphBacked = false) {
  const classic = {
    basic: THREE.MeshBasicMaterial ?? THREE.MeshBasicNodeMaterial,
    standard: THREE.MeshStandardMaterial ?? THREE.MeshStandardNodeMaterial,
    physical: THREE.MeshPhysicalMaterial ?? THREE.MeshPhysicalNodeMaterial,
    toon: THREE.MeshToonMaterial ?? THREE.MeshStandardMaterial ?? THREE.MeshStandardNodeMaterial,
  };
  const node = {
    basic: THREE.MeshBasicNodeMaterial ?? classic.basic,
    standard: THREE.MeshStandardNodeMaterial ?? classic.standard,
    physical: THREE.MeshPhysicalNodeMaterial ?? classic.physical,
    toon: THREE.MeshToonNodeMaterial ?? classic.toon,
  };
  const table = graphBacked ? node : classic;
  if (!table[kind]) throw new Error(`Unsupported material recipe: ${kind}`);
  return table[kind];
}

export function createMaterial(THREE, resource = {}, options = {}) {
  // Persisted Studio resources wrap their authored material values in `recipe`.
  // Graph-backed materials previously masked this omission because colorNode was
  // supplied by the graph, while ordinary materials silently used fallback
  // values and the default Standard material.
  const values = resource.recipe ?? resource.parameters ?? resource.values ?? resource;
  const requestedKind = materialRecipeKind(resource);
  const graphId = resource.graphId ?? values.graphId;
  const graphResource = resource.graph ?? (graphId ? options.graphs?.[graphId] : null);
  if (graphId && !graphResource) {
    throw new Error(`Material ${resource.id ?? '<unnamed>'} references missing graph ${graphId}.`);
  }
  const graphCompilation = graphResource ? compileShaderGraph({
    TSL: options.TSL,
    graph: graphResource,
    parameterValues: values.graphParameters ?? values.parameters ?? {},
    textureResolver: options.textureResolver,
  }) : null;
  const graphOutputs = graphCompilation?.outputs ?? {};
  const graphOutputNames = new Set(graphCompilation?.outputNames ?? []);
  const graphTransparency = graphCompilation?.features?.transparent === true
    || graphOutputNames.has('opacity')
    || graphOutputNames.has('mask');
  const graphTransmission = graphCompilation?.features?.transmission === true
    || graphOutputNames.has('transmission');
  const kind = isCompiledSurface(graphOutputs.surface) && ['standard', 'physical'].includes(requestedKind) ? 'physical' : requestedKind;
  const rawMap = MATERIAL_TEXTURE_BINDINGS.find(binding => (
    values[binding.property] !== undefined || resource[binding.property] !== undefined
  ));
  if (rawMap) {
    throw new Error(
      `Material ${resource.id ?? '<unnamed>'} uses raw ${rawMap.property}; author a stable ${rawMap.idKey} texture reference instead.`,
    );
  }
  assertMaterialTextureCompatibility(resource);
  const textureReferences = materialTextureReferences(resource);
  if (textureReferences.length > 0) assertMaterialTextureControls(resource);
  const graphConflicts = materialTextureGraphConflicts(resource, graphResource);
  if (graphConflicts.length > 0) {
    const [conflict] = graphConflicts;
    const error = new Error(
      `${conflict.idKey} is overridden by graph output ${conflict.graphOutput}; sample ${conflict.textureId} inside the graph instead.`,
    );
    error.code = 'material_texture_graph_conflict';
    error.details = { materialId: resource.id ?? null, graphId: graphId ?? null, conflicts: graphConflicts };
    throw error;
  }
  const resolvedTextureBindings = textureReferences.map(reference => {
    const texture = options.textureResolver?.(reference.textureId);
    if (!texture) {
      const error = new Error(
        `Material ${resource.id ?? '<unnamed>'} references unavailable texture ${reference.textureId} through ${reference.idKey}.`,
      );
      error.code = 'material_texture_unavailable';
      error.details = { materialId: resource.id ?? null, textureId: reference.textureId, idKey: reference.idKey };
      throw error;
    }
    const sourceChannels = texture.userData?.studioSourceChannels;
    if (sourceChannels !== undefined && !reference.allowedChannels.includes(sourceChannels)) {
      const error = new Error(
        `${reference.idKey} requires source channels ${reference.allowedChannels.join(' or ')}, but ${reference.textureId} has ${sourceChannels}.`,
      );
      error.code = 'material_texture_channel_mismatch';
      error.details = {
        materialId: resource.id ?? null,
        textureId: reference.textureId,
        idKey: reference.idKey,
        sourceChannels,
        allowedChannels: reference.allowedChannels,
      };
      throw error;
    }
    const sourceColorSpace = texture.userData?.studioColorSpace;
    if (sourceColorSpace !== undefined && !reference.colorSpaces.includes(sourceColorSpace)) {
      const error = new Error(
        `${reference.idKey} requires texture color space ${reference.colorSpaces.join(' or ')}, but ${reference.textureId} is ${sourceColorSpace}.`,
      );
      error.code = 'material_texture_color_space_mismatch';
      error.details = {
        materialId: resource.id ?? null,
        textureId: reference.textureId,
        idKey: reference.idKey,
        sourceColorSpace,
        allowedColorSpaces: reference.colorSpaces,
      };
      throw error;
    }
    return { reference, texture };
  });
  // A NodeMaterial without node overrides is not a harmless substitute in the
  // native WebGPU runtime: its unbound base-colour path resolves to black.
  // Keep ordinary/default materials on Three's classic material pipeline and
  // enter the node pipeline only for a successfully compiled graph.
  const Constructor = materialConstructor(THREE, kind, graphCompilation !== null);
  const color = values.baseColor ?? values.color;
  const mappedBaseColor = textureReferences.some(reference => reference.property === 'map');
  const material = new Constructor({
    color: linearColor(THREE, color, mappedBaseColor ? [1, 1, 1] : [0.7, 0.7, 0.7]),
  });
  const mapAwareDefaults = {};
  for (const reference of textureReferences) {
    for (const [key, value] of Object.entries(MATERIAL_TEXTURE_MAP_AWARE_DEFAULTS[reference.property] ?? {})) {
      if (Number.isFinite(value) && values[key] === undefined && key in material) {
        material[key] = value;
        mapAwareDefaults[key] = value;
      }
    }
  }
  const numericKeys = [
    'roughness', 'metalness', 'opacity', 'alphaTest', 'emissiveIntensity',
    'clearcoat', 'clearcoatRoughness', 'ior', 'transmission', 'thickness',
    'sheen', 'sheenRoughness', 'specularIntensity', 'anisotropy', 'iridescence',
    'aoMapIntensity', 'bumpScale', 'displacementScale', 'displacementBias',
  ];
  for (const key of numericKeys) if (Number.isFinite(values[key]) && key in material) material[key] = values[key];
  const mappedEmissive = textureReferences.some(reference => reference.property === 'emissiveMap');
  if ((values.emissive !== undefined || mappedEmissive) && 'emissive' in material) {
    material.emissive = linearColor(
      THREE,
      values.emissive,
      mappedEmissive ? MATERIAL_TEXTURE_MAP_AWARE_DEFAULTS.emissiveMap.emissive : [0, 0, 0],
    );
    if (values.emissive === undefined && mappedEmissive) mapAwareDefaults.emissive = [1, 1, 1];
  }
  const mappedSheen = textureReferences.some(reference => (
    reference.property === 'sheenColorMap' || reference.property === 'sheenRoughnessMap'
  ));
  if ((values.sheenColor !== undefined || mappedSheen) && 'sheenColor' in material) {
    material.sheenColor = linearColor(
      THREE,
      values.sheenColor,
      mappedSheen ? MATERIAL_TEXTURE_MAP_AWARE_DEFAULTS.sheenColorMap.sheenColor : [0, 0, 0],
    );
    if (values.sheenColor === undefined && mappedSheen) mapAwareDefaults.sheenColor = [1, 1, 1];
  }
  const mappedSpecularColor = textureReferences.some(reference => reference.property === 'specularColorMap');
  if ((values.specularColor !== undefined || mappedSpecularColor) && 'specularColor' in material) {
    material.specularColor = linearColor(
      THREE,
      values.specularColor,
      MATERIAL_TEXTURE_MAP_AWARE_DEFAULTS.specularColorMap.specularColor,
    );
    if (values.specularColor === undefined && mappedSpecularColor) {
      mapAwareDefaults.specularColor = [1, 1, 1];
    }
  }
  for (const { reference, texture } of resolvedTextureBindings) {
    material[reference.property] = texture;
  }
  for (const [key, property] of [['normalScale', 'normalScale'], ['clearcoatNormalScale', 'clearcoatNormalScale']]) {
    if (values[key] === undefined) continue;
    if (!Array.isArray(values[key]) || values[key].length !== 2 || values[key].some(value => !Number.isFinite(value))) {
      throw new Error(`${key} must contain exactly two finite numbers.`);
    }
    if (material[property]?.fromArray) material[property].fromArray(values[key]);
    else if (material[property]?.set) material[property].set(...values[key]);
    else if (THREE.Vector2) material[property] = new THREE.Vector2(...values[key]);
    else material[property] = { x: values[key][0], y: values[key][1] };
  }
  if (typeof values.vertexColors === 'boolean') material.vertexColors = values.vertexColors;
  if (graphOutputs.baseColor ?? graphOutputs.albedo) material.colorNode = graphOutputs.baseColor ?? graphOutputs.albedo;
  if (graphOutputs.roughness) material.roughnessNode = graphOutputs.roughness;
  if (graphOutputs.metalness) material.metalnessNode = graphOutputs.metalness;
  if (graphOutputs.normal) material.normalNode = graphOutputs.normal;
  else if (graphOutputs.height && options.TSL?.bumpMap) material.normalNode = options.TSL.bumpMap(graphOutputs.height, values.heightStrength ?? 1);
  if (graphOutputs.emissive) material.emissiveNode = graphOutputs.emissive;
  if (graphOutputs.subsurfaceWeight && options.TSL?.normalWorld && options.TSL?.cameraPosition) {
    const view = options.TSL.cameraPosition.sub(options.TSL.positionWorld).normalize();
    const rim = options.TSL.float(1).sub(options.TSL.abs(options.TSL.dot(options.TSL.normalWorld, view))).saturate();
    const scatter = (graphOutputs.baseColor ?? graphOutputs.albedo ?? options.TSL.vec3(1, 1, 1))
      .mul(options.TSL.clamp(graphOutputs.subsurfaceRadius ?? options.TSL.vec3(1, 0.2, 0.1), 0, 1))
      .mul(graphOutputs.subsurfaceWeight)
      .mul(options.TSL.clamp((graphOutputs.subsurfaceScale ?? options.TSL.float(0.05)).mul(20), 0, 1))
      .mul(rim.mul(0.3).add(0.04));
    material.emissiveNode = material.emissiveNode?.add?.(scatter) ?? scatter;
    material.userData = {
      ...(material.userData ?? {}),
      studioSubsurfaceApproximation: 'view-rim-wrap',
    };
  }
  if (graphOutputs.opacity ?? graphOutputs.mask) material.opacityNode = graphOutputs.opacity ?? graphOutputs.mask;
  if (graphOutputs.alphaTest) material.alphaTestNode = graphOutputs.alphaTest;
  if (graphOutputs.positionOffset) material.positionNode = options.TSL.positionLocal.add(graphOutputs.positionOffset);
  if (graphOutputs.ior && 'iorNode' in material) material.iorNode = graphOutputs.ior;
  if (graphOutputs.clearcoat && 'clearcoatNode' in material) material.clearcoatNode = graphOutputs.clearcoat;
  if (graphOutputs.clearcoatRoughness && 'clearcoatRoughnessNode' in material) material.clearcoatRoughnessNode = graphOutputs.clearcoatRoughness;
  if (graphTransmission && graphOutputs.transmission && 'transmissionNode' in material) {
    material.transmissionNode = graphOutputs.transmission;
  }
  if (graphOutputs.sheen && 'sheenNode' in material) {
    material.sheenNode = graphOutputs.sheen;
    if ('sheen' in material && values.sheen === undefined) material.sheen = 1;
  }
  if (graphOutputs.sheenRoughness && 'sheenRoughnessNode' in material) {
    material.sheenRoughnessNode = graphOutputs.sheenRoughness;
  }
  if (graphOutputs.sheenColor && 'sheenColorNode' in material) {
    material.sheenColorNode = graphOutputs.sheenColor;
  }
  if (graphOutputs.specularIntensity && 'specularIntensityNode' in material) {
    material.specularIntensityNode = graphOutputs.specularIntensity;
  }
  if (graphOutputs.specularColor && 'specularColorNode' in material) {
    material.specularColorNode = graphOutputs.specularColor;
  }
  if (graphOutputs.anisotropy && 'anisotropyNode' in material) {
    material.anisotropyNode = graphOutputs.anisotropy;
    if ('anisotropy' in material && values.anisotropy === undefined) material.anisotropy = 1;
  }
  if (graphOutputs.anisotropyRotation && 'anisotropyRotationNode' in material) {
    material.anisotropyRotationNode = graphOutputs.anisotropyRotation;
  }
  if (graphOutputs.clearcoatNormal && 'clearcoatNormalNode' in material) {
    material.clearcoatNormalNode = graphOutputs.clearcoatNormal;
  }
  if (graphOutputs.iridescence && 'iridescenceNode' in material) {
    material.iridescenceNode = graphOutputs.iridescence;
    if ('iridescence' in material && values.iridescence === undefined) material.iridescence = 1;
  }
  if (graphOutputs.iridescenceIOR && 'iridescenceIORNode' in material) {
    material.iridescenceIORNode = graphOutputs.iridescenceIOR;
  }
  if (graphOutputs.iridescenceThickness && 'iridescenceThicknessNode' in material) {
    material.iridescenceThicknessNode = graphOutputs.iridescenceThickness;
  }
  const hasAlphaMap = textureReferences.some(reference => reference.property === 'alphaMap');
  const usesAlphaCutout = Number.isFinite(values.alphaTest) && values.alphaTest > 0;
  const inferredTransparency = (Number.isFinite(values.opacity) && values.opacity < 1)
    || graphTransparency
    || (hasAlphaMap && !usesAlphaCutout);
  material.transparent = typeof values.transparent === 'boolean'
    ? values.transparent
    : inferredTransparency;
  material.depthWrite = values.depthWrite ?? !material.transparent;
  material.depthTest = values.depthTest ?? true;
  material.wireframe = values.wireframe ?? false;
  const sides = { front: THREE.FrontSide, back: THREE.BackSide, double: THREE.DoubleSide };
  if (values.side in sides) material.side = sides[values.side];
  if (textureReferences.length > 0) material.needsUpdate = true;
  material.name = resource.name ?? resource.id ?? 'Studio material';
  material.userData = {
    ...(material.userData ?? {}),
    studioResourceId: resource.id ?? null,
    ...(graphCompilation ? {
      studioGraphId: graphCompilation.graphId,
      studioGraphCompilation: graphCompilation.mode,
      studioGraphNodesCompiled: graphCompilation.nodesCompiled,
      studioGraphTextureIds: graphCompilation.textureIds,
      studioRequiresGeometryUv: graphCompilation.requiresGeometryUv,
    } : {}),
    studioTextureBindings: textureReferences.map(reference => ({
      slot: reference.property,
      textureId: reference.textureId,
      colorSpace: reference.colorSpace,
      preferredColorSpace: reference.colorSpace,
      allowedColorSpaces: reference.colorSpaces,
      allowedChannels: reference.allowedChannels,
    })),
    studioMapAwareDefaults: mapAwareDefaults,
  };
  return material;
}

export function createFallbackMaterial(THREE) {
  return createMaterial(THREE, {
    id: 'studio/fallback-material',
    kind: 'standard',
    color: [0.65, 0.16, 0.32],
    roughness: 0.72,
    metalness: 0.05,
  });
}
