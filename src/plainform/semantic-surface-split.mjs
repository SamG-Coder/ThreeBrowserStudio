import { realizeSurfaceTriangles } from './constrained-surface.mjs';

function edgeKey(first, second) {
  return first < second ? `${first}:${second}` : `${second}:${first}`;
}

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  throw error;
}

function compactRecipe(mesh, triangleIds, positionsSource = mesh.localPositions) {
  const remap = new Map();
  const positions = [];
  const indices = [];
  for (const triangleId of triangleIds) {
    for (const sourceIndex of mesh.indices.slice(triangleId * 3, triangleId * 3 + 3)) {
      if (!remap.has(sourceIndex)) {
        remap.set(sourceIndex, remap.size);
        positions.push(...positionsSource[sourceIndex]);
      }
      indices.push(remap.get(sourceIndex));
    }
  }
  return { kind: 'indexedMesh', positions, indices };
}

function triangleArea(mesh, triangleId) {
  const [a, b, c] = mesh.indices.slice(triangleId * 3, triangleId * 3 + 3).map(index => mesh.worldPositions[index]);
  const ab = b.map((value, axis) => value - a[axis]);
  const ac = c.map((value, axis) => value - a[axis]);
  const cross = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  return Math.hypot(...cross) * 0.5;
}

function anchorVertex(mesh, anchor, curveName) {
  const triangle = mesh.indices.slice(anchor.triangleIndex * 3, anchor.triangleIndex * 3 + 3);
  if (triangle.length !== 3) {
    fail('plainform_surface_split_anchor_invalid', `Surface curve $${curveName} contains an anchor outside its owner topology.`);
  }
  let coordinate = 0;
  for (let index = 1; index < 3; index += 1) if (anchor.barycentric[index] > anchor.barycentric[coordinate]) coordinate = index;
  if (anchor.barycentric[coordinate] < 1 - 1e-7) {
    fail(
      'plainform_surface_split_requires_edge_loop',
      `Surface curve $${curveName} crosses a triangle interior. Exact splitting currently requires every curve point and segment to follow an existing closed mesh edge loop.`,
      { curve: curveName, triangleIndex: anchor.triangleIndex, barycentric: [...anchor.barycentric] },
    );
  }
  return triangle[coordinate];
}

const subtract = (left, right) => left.map((value, axis) => value - right[axis]);
const add = (left, right) => left.map((value, axis) => value + right[axis]);
const dot = (left, right) => left.reduce((sum, value, axis) => sum + value * right[axis], 0);
const cross = (left, right) => [
  left[1] * right[2] - left[2] * right[1],
  left[2] * right[0] - left[0] * right[2],
  left[0] * right[1] - left[1] * right[0],
];
const normalize = (vector) => {
  const magnitude = Math.hypot(...vector);
  return magnitude > 1e-12 ? vector.map(value => value / magnitude) : [0, 0, 0];
};

function curveFrame(curve) {
  const center = curve.points.reduce((sum, point) => add(sum, point), [0, 0, 0]).map(value => value / curve.points.length);
  let normal = curve.normals?.reduce((sum, value) => add(sum, value), [0, 0, 0]);
  if (!normal || Math.hypot(...normal) <= 1e-12) {
    normal = [0, 0, 0];
    for (let index = 0; index < curve.points.length; index += 1) {
      normal = add(normal, cross(subtract(curve.points[index], center), subtract(curve.points[(index + 1) % curve.points.length], center)));
    }
  }
  normal = normalize(normal);
  const helper = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const x = normalize(cross(helper, normal));
  const y = normalize(cross(normal, x));
  return { center, x, y };
}

function flatten(point, frame) {
  const relative = subtract(point, frame.center);
  return [dot(relative, frame.x), dot(relative, frame.y)];
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let first = 0, second = polygon.length - 1; first < polygon.length; second = first++) {
    const [xi, yi] = polygon[first]; const [xj, yj] = polygon[second];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function triangleAdjacency(mesh) {
  const triangleCount = mesh.indices.length / 3;
  const edgeTriangles = new Map();
  for (let triangleId = 0; triangleId < triangleCount; triangleId += 1) {
    const triangle = mesh.indices.slice(triangleId * 3, triangleId * 3 + 3);
    for (let edge = 0; edge < 3; edge += 1) {
      const key = edgeKey(triangle[edge], triangle[(edge + 1) % 3]);
      const owners = edgeTriangles.get(key) ?? [];
      owners.push(triangleId);
      edgeTriangles.set(key, owners);
    }
  }
  const adjacency = Array.from({ length: triangleCount }, () => []);
  for (const owners of edgeTriangles.values()) {
    if (owners.length !== 2) continue;
    adjacency[owners[0]].push(owners[1]);
    adjacency[owners[1]].push(owners[0]);
  }
  return adjacency;
}

function componentsAmong(triangleIds, adjacency, mesh) {
  const allowed = new Set(triangleIds);
  const visited = new Set();
  const components = [];
  for (const start of triangleIds) {
    if (visited.has(start)) continue;
    const component = [];
    const pending = [start];
    visited.add(start);
    while (pending.length > 0) {
      const current = pending.pop();
      component.push(current);
      for (const next of adjacency[current]) {
        if (!allowed.has(next) || visited.has(next)) continue;
        visited.add(next);
        pending.push(next);
      }
    }
    components.push({
      triangles: component,
      area: component.reduce((sum, triangleId) => sum + triangleArea(mesh, triangleId), 0),
    });
  }
  return components.sort((left, right) => left.area - right.area || left.triangles[0] - right.triangles[0]);
}

function curvePlane(curve) {
  const center = curve.points.reduce((sum, point) => add(sum, point), [0, 0, 0]).map(value => value / curve.points.length);
  let normal = [0, 0, 0];
  for (let index = 0; index < curve.points.length; index += 1) {
    normal = add(normal, cross(
      subtract(curve.points[index], center),
      subtract(curve.points[(index + 1) % curve.points.length], center),
    ));
  }
  return { center, normal: normalize(normal) };
}

function isPlanarCurve(curve, tolerance = 0.12) {
  const { center, normal } = curvePlane(curve);
  if (Math.hypot(...normal) <= 1e-12) return false;
  const radius = Math.max(...curve.points.map(point => Math.hypot(...subtract(point, center))), 0);
  if (radius <= 1e-9) return false;
  const deviation = Math.max(...curve.points.map(point => Math.abs(dot(subtract(point, center), normal))));
  return deviation <= tolerance * radius;
}

function triangleNormal(mesh, triangleId) {
  const [a, b, c] = mesh.indices.slice(triangleId * 3, triangleId * 3 + 3).map(index => mesh.worldPositions[index]);
  return normalize(cross(subtract(b, a), subtract(c, a)));
}

function enclosedNormalCoherence(mesh, triangleIds) {
  if (triangleIds.length === 0) return 1;
  const normals = triangleIds.map(triangleId => triangleNormal(mesh, triangleId));
  const average = normalize(normals.reduce((sum, normal) => add(sum, normal), [0, 0, 0]));
  if (Math.hypot(...average) <= 1e-12) return -1;
  return Math.min(...normals.map(normal => dot(normal, average)));
}

function meshIsClosed(mesh) {
  const owners = new Map();
  const triangleCount = mesh.indices.length / 3;
  for (let triangleId = 0; triangleId < triangleCount; triangleId += 1) {
    const triangle = mesh.indices.slice(triangleId * 3, triangleId * 3 + 3);
    for (let edge = 0; edge < 3; edge += 1) {
      const key = edgeKey(triangle[edge], triangle[(edge + 1) % 3]);
      owners.set(key, (owners.get(key) ?? 0) + 1);
    }
  }
  return [...owners.values()].every(count => count === 2);
}

function splitByCurvePlane(mesh, curve) {
  const { center, normal } = curvePlane(curve);
  if (Math.hypot(...normal) <= 1e-12) return null;
  const positive = [];
  const negative = [];
  const triangleCount = mesh.indices.length / 3;
  for (let triangleId = 0; triangleId < triangleCount; triangleId += 1) {
    const points = mesh.indices.slice(triangleId * 3, triangleId * 3 + 3).map(index => mesh.worldPositions[index]);
    const centroid = points[0].map((value, axis) => (value + points[1][axis] + points[2][axis]) / 3);
    (dot(subtract(centroid, center), normal) >= 0 ? positive : negative).push(triangleId);
  }
  if (positive.length === 0 || negative.length === 0) return null;
  const sides = [
    { triangles: positive, area: positive.reduce((sum, triangleId) => sum + triangleArea(mesh, triangleId), 0) },
    { triangles: negative, area: negative.reduce((sum, triangleId) => sum + triangleArea(mesh, triangleId), 0) },
  ].sort((left, right) => left.area - right.area || left.triangles[0] - right.triangles[0]);
  return partitionFromEnclosed(mesh, sides[0].triangles);
}

function classifyProjectedTriangles(mesh, curve) {
  const frame = curveFrame(curve);
  const polygon = curve.points.map(point => flatten(point, frame));
  const enclosed = [];
  const remainder = [];
  const triangleClass = [];
  const triangleCount = mesh.indices.length / 3;
  for (let triangleId = 0; triangleId < triangleCount; triangleId += 1) {
    const points = mesh.indices.slice(triangleId * 3, triangleId * 3 + 3).map(index => mesh.worldPositions[index]);
    const center = points[0].map((value, axis) => (value + points[1][axis] + points[2][axis]) / 3);
    const isEnclosed = pointInPolygon(flatten(center, frame), polygon);
    triangleClass.push(isEnclosed);
    (isEnclosed ? enclosed : remainder).push(triangleId);
  }
  return { enclosed, remainder, triangleClass, triangleCount };
}

function partitionFromEnclosed(mesh, enclosed) {
  const opening = new Set(enclosed);
  const remainder = [];
  const triangleClass = [];
  const triangleCount = mesh.indices.length / 3;
  for (let triangleId = 0; triangleId < triangleCount; triangleId += 1) {
    const isEnclosed = opening.has(triangleId);
    triangleClass.push(isEnclosed);
    if (!isEnclosed) remainder.push(triangleId);
  }
  const edgeClasses = new Map();
  for (let triangleId = 0; triangleId < triangleCount; triangleId += 1) {
    const triangle = mesh.indices.slice(triangleId * 3, triangleId * 3 + 3);
    for (let edge = 0; edge < 3; edge += 1) {
      const key = edgeKey(triangle[edge], triangle[(edge + 1) % 3]);
      const classes = edgeClasses.get(key) ?? new Set();
      classes.add(triangleClass[triangleId]);
      edgeClasses.set(key, classes);
    }
  }
  const boundaryEdgeCount = [...edgeClasses.values()].filter(classes => classes.size === 2).length;
  return { enclosed, remainder, boundaryEdgeCount };
}

function splitByProjectedCurve(mesh, curve) {
  const classified = classifyProjectedTriangles(mesh, curve);
  if (classified.enclosed.length === 0 || classified.remainder.length === 0) {
    fail('plainform_surface_imprint_empty', `Surface curve $${curve.name} does not enclose a bounded set of evaluated surface triangles. Add curve samples or use a denser source surface.`);
  }
  const adjacency = triangleAdjacency(mesh);
  const enclosedParts = componentsAmong(classified.enclosed, adjacency, mesh);
  const remainderParts = componentsAmong(classified.remainder, adjacency, mesh);
  const enclosedArea = enclosedParts.reduce((sum, part) => sum + part.area, 0);
  const remainderArea = remainderParts.reduce((sum, part) => sum + part.area, 0);
  let enclosed = classified.enclosed;
  // A latitude flattened to a disk marks both poles as inside. English “Open
  // along this loop” removes the smaller cap of the rim plane.
  const enclosedFraction = enclosedArea / Math.max(enclosedArea + remainderArea, 1e-12);
  const faceLikeHole = enclosedNormalCoherence(mesh, classified.enclosed) >= 0.45 && enclosedFraction < 0.2;
  const wrappedCap = meshIsClosed(mesh) && isPlanarCurve(curve) && !faceLikeHole;
  if (wrappedCap || (isPlanarCurve(curve) && (enclosedParts.length > 1 || enclosedArea > remainderArea))) {
    const planar = splitByCurvePlane(mesh, curve);
    if (planar) {
      if (planar.remainder.length === 0 || planar.boundaryEdgeCount < 3) {
        fail('plainform_surface_imprint_nonseparating', `Surface curve $${curve.name} does not produce a closed imprinted boundary on the evaluated topology.`);
      }
      return {
        enclosedRecipe: compactRecipe(mesh, planar.enclosed),
        enclosedWorldRecipe: compactRecipe(mesh, planar.enclosed, mesh.worldPositions),
        remainderRecipe: compactRecipe(mesh, planar.remainder),
        enclosedTriangleCount: planar.enclosed.length,
        remainderTriangleCount: planar.remainder.length,
        boundaryEdgeCount: planar.boundaryEdgeCount,
        imprinted: true,
      };
    }
  } else if (enclosedParts.length > 1) {
    enclosed = enclosedParts[0].triangles;
  }
  const partitioned = partitionFromEnclosed(mesh, enclosed);
  if (partitioned.remainder.length === 0) {
    fail('plainform_surface_imprint_empty', `Surface curve $${curve.name} does not enclose a bounded set of evaluated surface triangles. Add curve samples or use a denser source surface.`);
  }
  if (partitioned.boundaryEdgeCount < 3) {
    fail('plainform_surface_imprint_nonseparating', `Surface curve $${curve.name} does not produce a closed imprinted boundary on the evaluated topology.`);
  }
  return {
    enclosedRecipe: compactRecipe(mesh, partitioned.enclosed),
    enclosedWorldRecipe: compactRecipe(mesh, partitioned.enclosed, mesh.worldPositions),
    remainderRecipe: compactRecipe(mesh, partitioned.remainder),
    enclosedTriangleCount: partitioned.enclosed.length,
    remainderTriangleCount: partitioned.remainder.length,
    boundaryEdgeCount: partitioned.boundaryEdgeCount,
    imprinted: true,
  };
}

/**
 * Partitions one indexed surface along a semantic closed curve only when that
 * curve is already an exact topology edge loop. No mesh indices enter the
 * language: they are recovered deterministically from stored surface anchors.
 */
export function splitSurfaceAlongCurve({ owner, curve }) {
  if (!curve.closed) {
    fail('plainform_surface_split_not_closed', `Splitting ${owner.entityId} requires a closed surface curve; $${curve.name} is open.`);
  }
  if (curve.ownerEntityId !== owner.entityId) {
    fail('plainform_surface_split_owner_mismatch', `Surface curve $${curve.name} belongs to ${curve.ownerEntityId}, not ${owner.entityId}.`);
  }
  const mesh = realizeSurfaceTriangles({ recipe: owner.recipe, matrix: owner.matrix, entityId: owner.entityId });
  if (!curve.anchors?.every(anchor => Math.max(...anchor.barycentric) >= 1 - 1e-7)) {
    return splitByProjectedCurve(mesh, curve);
  }
  const loop = curve.anchors.map(anchor => anchorVertex(mesh, anchor, curve.name));
  if (new Set(loop).size !== loop.length) {
    fail('plainform_surface_split_loop_invalid', `Surface curve $${curve.name} repeats a topology vertex and cannot define one simple split loop.`);
  }

  const edgeTriangles = new Map();
  const triangleCount = mesh.indices.length / 3;
  for (let triangleId = 0; triangleId < triangleCount; triangleId += 1) {
    const triangle = mesh.indices.slice(triangleId * 3, triangleId * 3 + 3);
    for (let edge = 0; edge < 3; edge += 1) {
      const key = edgeKey(triangle[edge], triangle[(edge + 1) % 3]);
      const owners = edgeTriangles.get(key) ?? [];
      owners.push(triangleId);
      edgeTriangles.set(key, owners);
    }
  }
  const cutEdges = new Set();
  for (let index = 0; index < loop.length; index += 1) {
    const key = edgeKey(loop[index], loop[(index + 1) % loop.length]);
    if (!edgeTriangles.has(key)) return splitByProjectedCurve(mesh, curve);
    cutEdges.add(key);
  }

  const adjacency = Array.from({ length: triangleCount }, () => []);
  for (const [key, owners] of edgeTriangles) {
    if (cutEdges.has(key) || owners.length !== 2) continue;
    adjacency[owners[0]].push(owners[1]);
    adjacency[owners[1]].push(owners[0]);
  }
  const components = [];
  const visited = new Set();
  for (let triangleId = 0; triangleId < triangleCount; triangleId += 1) {
    if (visited.has(triangleId)) continue;
    const component = [];
    const pending = [triangleId];
    visited.add(triangleId);
    while (pending.length > 0) {
      const current = pending.pop();
      component.push(current);
      for (const next of adjacency[current]) if (!visited.has(next)) {
        visited.add(next);
        pending.push(next);
      }
    }
    components.push(component);
  }
  if (components.length !== 2) {
    fail(
      'plainform_surface_split_nonseparating_loop',
      `Surface curve $${curve.name} does not separate ${owner.entityId} into exactly two coherent surface components.`,
      { curve: curve.name, componentCount: components.length },
    );
  }
  const byArea = components.map(triangles => ({
    triangles,
    area: triangles.reduce((sum, triangleId) => sum + triangleArea(mesh, triangleId), 0),
  })).sort((left, right) => left.area - right.area || left.triangles[0] - right.triangles[0]);
  if (byArea[0].area <= 1e-12 || byArea[1].area <= 1e-12) {
    fail('plainform_surface_split_empty', `Surface curve $${curve.name} produces an empty or degenerate split component.`);
  }
  return {
    enclosedRecipe: compactRecipe(mesh, byArea[0].triangles),
    enclosedWorldRecipe: compactRecipe(mesh, byArea[0].triangles, mesh.worldPositions),
    remainderRecipe: compactRecipe(mesh, byArea[1].triangles),
    enclosedTriangleCount: byArea[0].triangles.length,
    remainderTriangleCount: byArea[1].triangles.length,
    boundaryEdgeCount: cutEdges.size,
    imprinted: false,
  };
}

/** Opens an actual topology boundary by removing the enclosed surface. */
export function openSurfaceAlongCurve({ owner, curve }) {
  const result = splitSurfaceAlongCurve({ owner, curve });
  return {
    recipe: result.remainderRecipe,
    removedTriangleCount: result.enclosedTriangleCount,
    remainingTriangleCount: result.remainderTriangleCount,
    boundaryEdgeCount: result.boundaryEdgeCount,
    imprinted: result.imprinted,
  };
}
