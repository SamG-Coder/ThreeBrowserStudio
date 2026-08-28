import { compileShaderGraph, isCompiledSurface } from './shader-graph-compiler.mjs';

const GEOMETRY_PARAMETER_DEFAULTS = Object.freeze({
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

const CONTROL_POINT_LIMITS = Object.freeze({
  lathe: 512,
  tube: 1024,
  shape: 2048,
});
const MAX_SHAPE_HOLES = 64;
const MAX_COORDINATE = 1_000_000;

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function integer(value, fallback, minimum = 1, maximum = 512) {
  return Math.min(maximum, Math.max(minimum, Math.trunc(finite(value, fallback))));
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function recipeOf(resource) {
  const enclosed = resource?.recipe !== undefined || resource?.parameters !== undefined;
  const recipe = resource?.recipe ?? resource?.parameters ?? resource ?? {};
  const kind = recipe.kind ?? recipe.type ?? resource?.geometryKind ?? resource?.kind ?? 'box';
  return enclosed ? { kind, ...recipe } : { ...recipe, kind };
}

export function normalizeGeometryRecipe(resource = {}) {
  const source = recipeOf(resource);
  const defaults = GEOMETRY_PARAMETER_DEFAULTS[source.kind] ?? GEOMETRY_PARAMETER_DEFAULTS.box;
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
  const contour = validatedPoints(recipe.points, 2, 3, CONTROL_POINT_LIMITS.shape, 'Shape contour');
  if (!Array.isArray(recipe.holes)) throw new Error('Shape holes must be an array of contours.');
  if (recipe.holes.length > MAX_SHAPE_HOLES) throw new Error(`Shape exceeds the hole budget of ${MAX_SHAPE_HOLES}.`);

  let pointCount = contour.length;
  const holes = recipe.holes.map((hole, index) => {
    const points = validatedPoints(hole, 2, 3, CONTROL_POINT_LIMITS.shape, `Shape hole ${index}`);
    pointCount += points.length;
    if (pointCount > CONTROL_POINT_LIMITS.shape) {
      throw new Error(`Shape exceeds the total control-point budget of ${CONTROL_POINT_LIMITS.shape}.`);
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
  const points = validatedPoints(recipe.points, 2, 2, CONTROL_POINT_LIMITS.lathe, 'Lathe profile');
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
  const points = validatedPoints(recipe.points, 3, closed ? 3 : 2, CONTROL_POINT_LIMITS.tube, 'Tube path');
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
  if (!geometry.getAttribute('normal') && recipe.computeNormals !== false) geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function createGeometry(THREE, resource = {}) {
  const p = normalizeGeometryRecipe(resource);
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
    case 'shape': return shapeGeometry(THREE, p);
    case 'extrude': return extrudeGeometry(THREE, p);
    case 'explicit':
    case 'indexedMesh': return explicitGeometry(THREE, p);
    default: throw new Error(`Unsupported geometry recipe: ${p.kind}`);
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
  const requestedKind = resource.materialKind
    ?? values.materialKind
    ?? values.type
    ?? (resource.kind === 'material' ? 'standard' : resource.kind)
    ?? 'standard';
  const graphResource = resource.graph ?? (resource.graphId ? options.graphs?.[resource.graphId] : null);
  if (resource.graphId && !graphResource) {
    throw new Error(`Material ${resource.id ?? '<unnamed>'} references missing graph ${resource.graphId}.`);
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
  const mapKeys = [
    'map', 'mapId', 'normalMap', 'normalMapId', 'roughnessMap', 'roughnessMapId',
    'metalnessMap', 'metalnessMapId', 'emissiveMap', 'emissiveMapId',
    'alphaMap', 'alphaMapId', 'aoMap', 'aoMapId', 'bumpMap', 'bumpMapId',
  ];
  const uncompiledMap = mapKeys.find(key => values[key] !== undefined || resource[key] !== undefined);
  if (uncompiledMap) throw new Error(`Material ${resource.id ?? '<unnamed>'} uses ${uncompiledMap}; image texture resources are not bound by the live graph compiler yet.`);
  // A NodeMaterial without node overrides is not a harmless substitute in the
  // native WebGPU runtime: its unbound base-colour path resolves to black.
  // Keep ordinary/default materials on Three's classic material pipeline and
  // enter the node pipeline only for a successfully compiled graph.
  const Constructor = materialConstructor(THREE, kind, graphCompilation !== null);
  const color = values.baseColor ?? values.color;
  const material = new Constructor({ color: linearColor(THREE, color) });
  const numericKeys = [
    'roughness', 'metalness', 'opacity', 'alphaTest', 'emissiveIntensity',
    'clearcoat', 'clearcoatRoughness', 'ior', 'transmission', 'thickness',
    'sheen', 'sheenRoughness', 'specularIntensity',
  ];
  for (const key of numericKeys) if (Number.isFinite(values[key]) && key in material) material[key] = values[key];
  if (values.emissive !== undefined && 'emissive' in material) material.emissive = linearColor(THREE, values.emissive, [0, 0, 0]);
  if (graphOutputs.baseColor ?? graphOutputs.albedo) material.colorNode = graphOutputs.baseColor ?? graphOutputs.albedo;
  if (graphOutputs.roughness) material.roughnessNode = graphOutputs.roughness;
  if (graphOutputs.metalness) material.metalnessNode = graphOutputs.metalness;
  if (graphOutputs.normal) material.normalNode = graphOutputs.normal;
  else if (graphOutputs.height && options.TSL?.bumpMap) material.normalNode = options.TSL.bumpMap(graphOutputs.height, values.heightStrength ?? 1);
  if (graphOutputs.emissive) material.emissiveNode = graphOutputs.emissive;
  if (graphOutputs.opacity ?? graphOutputs.mask) material.opacityNode = graphOutputs.opacity ?? graphOutputs.mask;
  if (graphOutputs.alphaTest) material.alphaTestNode = graphOutputs.alphaTest;
  if (graphOutputs.positionOffset) material.positionNode = options.TSL.positionLocal.add(graphOutputs.positionOffset);
  if (graphOutputs.ior && 'iorNode' in material) material.iorNode = graphOutputs.ior;
  if (graphOutputs.clearcoat && 'clearcoatNode' in material) material.clearcoatNode = graphOutputs.clearcoat;
  if (graphOutputs.clearcoatRoughness && 'clearcoatRoughnessNode' in material) material.clearcoatRoughnessNode = graphOutputs.clearcoatRoughness;
  if (graphTransmission && graphOutputs.transmission && 'transmissionNode' in material) {
    material.transmissionNode = graphOutputs.transmission;
  }
  const inferredTransparency = (Number.isFinite(values.opacity) && values.opacity < 1)
    || graphTransparency;
  material.transparent = typeof values.transparent === 'boolean'
    ? values.transparent
    : inferredTransparency;
  material.depthWrite = values.depthWrite ?? !material.transparent;
  material.depthTest = values.depthTest ?? true;
  material.wireframe = values.wireframe ?? false;
  const sides = { front: THREE.FrontSide, back: THREE.BackSide, double: THREE.DoubleSide };
  if (values.side in sides) material.side = sides[values.side];
  material.name = resource.name ?? resource.id ?? 'Studio material';
  material.userData = {
    ...(material.userData ?? {}),
    studioResourceId: resource.id ?? null,
    ...(graphCompilation ? {
      studioGraphId: graphCompilation.graphId,
      studioGraphCompilation: graphCompilation.mode,
      studioGraphNodesCompiled: graphCompilation.nodesCompiled,
    } : {}),
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
