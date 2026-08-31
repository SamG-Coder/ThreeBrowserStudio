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
    if (!edgeTriangles.has(key)) {
      fail(
        'plainform_surface_split_requires_edge_loop',
        `Surface curve $${curve.name} has a segment that does not follow an existing mesh edge. Project the curve to an edge-aligned loop or remesh the owner first.`,
        { curve: curve.name, segment: index },
      );
    }
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
  };
}
