import { triangulateEditableMesh } from '../core/editable-mesh.mjs';
import { transformPointByMatrix } from '../core/transform-math.mjs';
import { evaluateLoftSections } from '../runtime/resource-factories.mjs';

export const MAX_SURFACE_PROJECTION_TESTS = 1_000_000;

function subtract(left, right) { return left.map((value, axis) => value - right[axis]); }
function add(left, right) { return left.map((value, axis) => value + right[axis]); }
function scale(vector, amount) { return vector.map(value => value * amount); }
function dot(left, right) { return left.reduce((sum, value, axis) => sum + value * right[axis], 0); }
function lengthSquared(vector) { return dot(vector, vector); }
function normalize(vector) {
  const magnitude = Math.hypot(...vector);
  return magnitude > 1e-12 ? vector.map(value => value / magnitude) : [0, 0, 0];
}
function cross(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function closestPointOnTriangle(point, a, b, c) {
  const ab = subtract(b, a); const ac = subtract(c, a); const ap = subtract(point, a);
  const d1 = dot(ab, ap); const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = subtract(point, b); const d3 = dot(ab, bp); const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
  const cp = subtract(point, c); const d5 = dot(ab, cp); const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    return add(b, scale(subtract(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
  }
  const denominator = 1 / (va + vb + vc);
  return add(a, add(scale(ab, vb * denominator), scale(ac, vc * denominator)));
}

function barycentric(point, a, b, c) {
  const v0 = subtract(b, a); const v1 = subtract(c, a); const v2 = subtract(point, a);
  const d00 = dot(v0, v0); const d01 = dot(v0, v1); const d11 = dot(v1, v1);
  const d20 = dot(v2, v0); const d21 = dot(v2, v1);
  const denominator = d00 * d11 - d01 * d01;
  if (Math.abs(denominator) <= 1e-18) return [1, 0, 0];
  const second = (d11 * d20 - d01 * d21) / denominator;
  const third = (d00 * d21 - d01 * d20) / denominator;
  return [1 - second - third, second, third];
}

function boxMesh(recipe) {
  const x = (recipe.width ?? 1) / 2; const y = (recipe.height ?? 1) / 2; const z = (recipe.depth ?? 1) / 2;
  return {
    positions: [[-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z], [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]],
    indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5],
  };
}

function planeMesh(recipe) {
  const x = (recipe.width ?? 1) / 2; const y = (recipe.height ?? 1) / 2;
  return { positions: [[-x, -y, 0], [x, -y, 0], [x, y, 0], [-x, y, 0]], indices: [0, 1, 2, 0, 2, 3] };
}

function cylinderMesh(recipe) {
  const segments = Math.max(3, Math.min(64, recipe.radialSegments ?? 32));
  const half = (recipe.height ?? 1) / 2;
  const top = recipe.radiusTop ?? recipe.radius ?? 0.5;
  const bottom = recipe.radiusBottom ?? recipe.radius ?? 0.5;
  const positions = [[0, half, 0], [0, -half, 0]];
  for (let index = 0; index < segments; index += 1) {
    const angle = index / segments * Math.PI * 2;
    positions.push([Math.sin(angle) * top, half, Math.cos(angle) * top]);
    positions.push([Math.sin(angle) * bottom, -half, Math.cos(angle) * bottom]);
  }
  const indices = [];
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    const topA = 2 + index * 2; const bottomA = topA + 1;
    const topB = 2 + next * 2; const bottomB = topB + 1;
    indices.push(topA, bottomA, bottomB, topA, bottomB, topB, 0, topB, topA, 1, bottomA, bottomB);
  }
  return { positions, indices };
}

function sphereMesh(recipe) {
  const widthSegments = Math.max(8, Math.min(64, recipe.widthSegments ?? 24));
  const heightSegments = Math.max(4, Math.min(32, recipe.heightSegments ?? 12));
  const radius = recipe.radius ?? 0.5;
  const positions = [];
  for (let row = 0; row <= heightSegments; row += 1) {
    const theta = row / heightSegments * Math.PI;
    for (let column = 0; column <= widthSegments; column += 1) {
      const phi = column / widthSegments * Math.PI * 2;
      positions.push([radius * Math.sin(theta) * Math.sin(phi), radius * Math.cos(theta), radius * Math.sin(theta) * Math.cos(phi)]);
    }
  }
  const indices = [];
  const stride = widthSegments + 1;
  for (let row = 0; row < heightSegments; row += 1) {
    for (let column = 0; column < widthSegments; column += 1) {
      const a = row * stride + column; const b = a + stride;
      if (row > 0) indices.push(a, b, a + 1);
      if (row < heightSegments - 1) indices.push(a + 1, b, b + 1);
    }
  }
  return { positions, indices };
}

function loftMesh(recipe) {
  const { sections, profileSize, closed } = evaluateLoftSections(recipe);
  const positions = sections.flat();
  const indices = [];
  const edgeCount = closed ? profileSize : profileSize - 1;
  let reverseWinding = false;
  if (closed) {
    let orientation = 0;
    for (let section = 0; section < sections.length - 1; section += 1) {
      const currentCenter = [0, 0, 0]; const nextCenter = [0, 0, 0];
      for (let point = 0; point < profileSize; point += 1) {
        for (let axis = 0; axis < 3; axis += 1) {
          currentCenter[axis] += sections[section][point][axis] / profileSize;
          nextCenter[axis] += sections[section + 1][point][axis] / profileSize;
        }
      }
      const center = currentCenter.map((value, axis) => (value + nextCenter[axis]) * 0.5);
      for (let point = 0; point < profileSize; point += 1) {
        const next = (point + 1) % profileSize;
        const a = sections[section][point]; const b = sections[section][next]; const d = sections[section + 1][point];
        const normal = cross(subtract(b, a), subtract(d, a));
        const faceCenter = a.map((value, axis) => (value + b[axis] + sections[section + 1][next][axis] + d[axis]) * 0.25);
        orientation += dot(normal, subtract(faceCenter, center));
      }
    }
    reverseWinding = orientation < 0;
  }
  for (let section = 0; section < sections.length - 1; section += 1) {
    for (let edge = 0; edge < edgeCount; edge += 1) {
      const next = (edge + 1) % profileSize;
      const a = section * profileSize + edge; const b = section * profileSize + next;
      const c = (section + 1) * profileSize + next; const d = (section + 1) * profileSize + edge;
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
  return { positions, indices };
}

function triangleMesh(recipe) {
  switch (recipe?.kind) {
    case 'box': return boxMesh(recipe);
    case 'plane': return planeMesh(recipe);
    case 'cylinder': return cylinderMesh(recipe);
    case 'sphere': return sphereMesh(recipe);
    case 'loft': return loftMesh(recipe);
    case 'explicit':
    case 'indexedMesh': return {
      positions: Array.from({ length: recipe.positions.length / 3 }, (_, index) => recipe.positions.slice(index * 3, index * 3 + 3)),
      indices: [...recipe.indices],
    };
    case 'editableMesh': {
      const result = triangulateEditableMesh(recipe).recipe;
      return {
        positions: Array.from({ length: result.positions.length / 3 }, (_, index) => result.positions.slice(index * 3, index * 3 + 3)),
        indices: [...result.indices],
      };
    }
    default: return null;
  }
}

export function realizeSurfaceTriangles({ recipe, matrix, entityId }) {
  const mesh = triangleMesh(recipe);
  if (!mesh) {
    const error = new Error(`Semantic surface deformation is unavailable for ${recipe?.kind ?? 'unknown'} geometry on ${entityId}. Realize it to indexed or editable geometry first.`);
    error.code = 'plainform_surface_deformation_unavailable'; throw error;
  }
  if (mesh.positions.length > 250_000 || mesh.indices.length > 1_500_000) {
    const error = new Error(`Semantic surface deformation on ${entityId} exceeds the bounded 250,000-vertex or 500,000-triangle limit.`);
    error.code = 'plainform_surface_deformation_limit'; throw error;
  }
  return {
    localPositions: mesh.positions.map(point => [...point]),
    worldPositions: mesh.positions.map(point => transformPointByMatrix(matrix, point)),
    indices: [...mesh.indices],
  };
}

export function projectSurfaceAnchors({ recipe, matrix, seedPoints, entityId }) {
  const mesh = triangleMesh(recipe);
  if (!mesh) {
    const error = new Error(`Surface anchoring is unavailable for ${recipe?.kind ?? 'unknown'} geometry on ${entityId}. Realize it to indexed or editable geometry first.`);
    error.code = 'plainform_surface_anchor_unavailable'; throw error;
  }
  const triangleCount = mesh.indices.length / 3;
  if (triangleCount * seedPoints.length > MAX_SURFACE_PROJECTION_TESTS) {
    const error = new Error(`Surface anchoring ${seedPoints.length} points against ${triangleCount} triangles exceeds the bounded ${MAX_SURFACE_PROJECTION_TESTS}-test limit.`);
    error.code = 'plainform_surface_anchor_limit'; throw error;
  }
  const positions = mesh.positions.map(point => transformPointByMatrix(matrix, point));
  return seedPoints.map((seedPoint) => {
    let best = null;
    for (let offset = 0; offset < mesh.indices.length; offset += 3) {
      const vertices = mesh.indices.slice(offset, offset + 3);
      const [a, b, c] = vertices.map(index => positions[index]);
      const point = closestPointOnTriangle(seedPoint, a, b, c);
      const distanceSquared = lengthSquared(subtract(seedPoint, point));
      if (best && distanceSquared >= best.distanceSquared) continue;
      const normal = normalize(cross(subtract(b, a), subtract(c, a)));
      best = { point, normal, distanceSquared, triangleIndex: offset / 3, barycentric: barycentric(point, a, b, c) };
    }
    if (!best) {
      const error = new Error(`Surface anchoring found no non-empty triangle surface on ${entityId}.`);
      error.code = 'plainform_surface_anchor_empty'; throw error;
    }
    return best;
  });
}

function endpointDistanceSquared(left, right) { return lengthSquared(subtract(left, right)); }

export function matchBoundaryDirection(first, second) {
  const same = endpointDistanceSquared(first[0], second[0]) + endpointDistanceSquared(first.at(-1), second.at(-1));
  const reversed = endpointDistanceSquared(first[0], second.at(-1)) + endpointDistanceSquared(first.at(-1), second[0]);
  return reversed < same ? [...second].reverse() : [...second];
}

function matchBoundary(first, second) {
  const points = matchBoundaryDirection(first.points, second.points);
  const reversed = points.length > 1
    && endpointDistanceSquared(points[0], second.points.at(-1))
      < endpointDistanceSquared(points[0], second.points[0]);
  return {
    ...second,
    points,
    ...(second.normals ? { normals: reversed ? [...second.normals].reverse() : [...second.normals] } : {}),
    ...(second.anchors ? { anchors: reversed ? [...second.anchors].reverse() : [...second.anchors] } : {}),
  };
}

function resampleBoundary(boundary, count) {
  if (boundary.points.length === count) return {
    ...boundary,
    points: boundary.points.map(point => [...point]),
    ...(boundary.normals ? { normals: boundary.normals.map(normal => [...normal]) } : {}),
  };
  const lengths = [0];
  for (let index = 1; index < boundary.points.length; index += 1) {
    lengths.push(lengths.at(-1) + Math.hypot(...subtract(boundary.points[index], boundary.points[index - 1])));
  }
  const total = lengths.at(-1);
  if (!(total > 0)) throw new Error(`Boundary $${boundary.name} has zero length.`);
  const points = []; const normals = boundary.normals ? [] : null;
  for (let sample = 0; sample < count; sample += 1) {
    const distance = total * sample / Math.max(1, count - 1);
    let segment = 0;
    while (segment < lengths.length - 2 && lengths[segment + 1] < distance) segment += 1;
    const span = Math.max(Number.EPSILON, lengths[segment + 1] - lengths[segment]);
    const factor = (distance - lengths[segment]) / span;
    points.push(boundary.points[segment].map((value, axis) => value + (boundary.points[segment + 1][axis] - value) * factor));
    if (normals) normals.push(normalize(boundary.normals[segment].map((value, axis) => value + (boundary.normals[segment + 1][axis] - value) * factor)));
  }
  return { ...boundary, points, ...(normals ? { normals } : {}) };
}

function reverseBoundary(boundary) {
  return {
    ...boundary,
    points: [...boundary.points].reverse(),
    ...(boundary.normals ? { normals: [...boundary.normals].reverse() } : {}),
  };
}

function orientEndBoundaries(first, second, ends) {
  const candidates = [];
  for (const swapped of [false, true]) {
    const pair = swapped ? [ends[1], ends[0]] : ends;
    for (const reverseFirst of [false, true]) for (const reverseSecond of [false, true]) {
      const left = reverseFirst ? reverseBoundary(pair[0]) : pair[0];
      const right = reverseSecond ? reverseBoundary(pair[1]) : pair[1];
      const distance = endpointDistanceSquared(first.points[0], left.points[0])
        + endpointDistanceSquared(second.points[0], left.points.at(-1))
        + endpointDistanceSquared(first.points.at(-1), right.points[0])
        + endpointDistanceSquared(second.points.at(-1), right.points.at(-1));
      candidates.push({ left, right, distance });
    }
  }
  candidates.sort((left, right) => left.distance - right.distance);
  const result = candidates[0];
  const span = Math.max(
    Math.hypot(...subtract(first.points[0], second.points[0])),
    Math.hypot(...subtract(first.points.at(-1), second.points.at(-1))),
    1,
  );
  const tolerance = span * 1e-5;
  if (Math.sqrt(result.distance) > tolerance * 2) {
    const error = new Error('The four constrained patch boundaries do not share matching corners. End boundaries must begin and end on the two main rails.');
    error.code = 'plainform_patch_corner_mismatch';
    error.details = { rootMeanCornerDistance: Math.sqrt(result.distance / 4), tolerance };
    throw error;
  }
  return [result.left, result.right];
}

function continuityFactor(value, continuity) {
  if (continuity === 'tangent') return value * value * (3 - 2 * value);
  if (continuity === 'curvature') return value ** 3 * (value * (value * 6 - 15) + 10);
  return value;
}

function boundaryTangent(points, index) {
  const previous = points[Math.max(0, index - 1)];
  const next = points[Math.min(points.length - 1, index + 1)];
  return normalize(subtract(next, previous));
}

function tangentOffset(from, to, normal, railTangent, amount) {
  const span = subtract(to, from);
  let direction = normalize(subtract(span, scale(normal, dot(span, normal))));
  if (Math.hypot(...direction) <= 1e-12) {
    direction = normalize(cross(railTangent, normal));
    if (dot(direction, span) < 0) direction = scale(direction, -1);
  }
  if (Math.hypot(...direction) <= 1e-12) {
    const error = new Error('A source-tangent patch cannot derive an across-boundary tangent from a degenerate rail and surface normal.');
    error.code = 'plainform_patch_tangent_direction'; throw error;
  }
  return add(from, scale(direction, Math.hypot(...span) * amount));
}

export function buildConstrainedPatchSections({ first, second, ends = null, continuity = 'positional', sourceTangency = false }) {
  const columnCount = Math.max(first.points.length, second.points.length);
  const firstRail = resampleBoundary(first, columnCount);
  const secondRail = resampleBoundary(matchBoundary(first, second), columnCount);
  if (sourceTangency && (!firstRail.normals || !secondRail.normals)) {
    const error = new Error('Source-surface tangency requires both main boundaries to use surface-anchored points.');
    error.code = 'plainform_patch_tangency_requires_surface_anchors'; throw error;
  }
  let rowCount = sourceTangency ? 4 : (continuity === 'positional' ? 2 : 5);
  let endRails = null;
  if (ends) {
    endRails = orientEndBoundaries(firstRail, secondRail, ends);
    rowCount = Math.max(rowCount, endRails[0].points.length, endRails[1].points.length);
    endRails = endRails.map(boundary => resampleBoundary(boundary, rowCount));
  }
  const sections = [];
  for (let row = 0; row < rowCount; row += 1) {
    const v = row / Math.max(1, rowCount - 1);
    const blend = continuityFactor(v, continuity);
    const points = [];
    for (let column = 0; column < columnCount; column += 1) {
      const top = firstRail.points[column]; const bottom = secondRail.points[column];
      let point;
      if (sourceTangency && row === 1) point = tangentOffset(
        top, bottom, firstRail.normals[column], boundaryTangent(firstRail.points, column), 1 / 3,
      );
      else if (sourceTangency && row === rowCount - 2) point = tangentOffset(
        bottom, top, secondRail.normals[column], boundaryTangent(secondRail.points, column), 1 / 3,
      );
      else point = top.map((value, axis) => value + (bottom[axis] - value) * blend);
      if (endRails && column > 0 && column < columnCount - 1) {
        const u = column / (columnCount - 1);
        const linearLeft = firstRail.points[0].map((value, axis) => value + (secondRail.points[0][axis] - value) * blend);
        const linearRight = firstRail.points.at(-1).map((value, axis) => value + (secondRail.points.at(-1)[axis] - value) * blend);
        const leftCorrection = subtract(endRails[0].points[row], linearLeft);
        const rightCorrection = subtract(endRails[1].points[row], linearRight);
        point = add(point, add(scale(leftCorrection, 1 - u), scale(rightCorrection, u)));
      }
      points.push(point);
    }
    if (endRails) {
      points[0] = [...endRails[0].points[row]];
      points[points.length - 1] = [...endRails[1].points[row]];
    }
    sections.push({ id: `patch-section-${String(row + 1).padStart(3, '0')}`, points });
  }
  return { sections, profileResolution: columnCount, rowCount };
}
