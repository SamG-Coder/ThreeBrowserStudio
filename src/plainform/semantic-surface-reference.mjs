import { invertTransformMatrix, transformPointByMatrix } from '../core/transform-math.mjs';
import { projectSurfaceAnchors } from './constrained-surface.mjs';

const add = (left, right) => left.map((value, axis) => value + right[axis]);
const subtract = (left, right) => left.map((value, axis) => value - right[axis]);
const scale = (vector, amount) => vector.map(value => value * amount);
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

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  throw error;
}

function segments(reference) {
  const result = [];
  const count = reference.closed ? reference.points.length : reference.points.length - 1;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % reference.points.length;
    const length = Math.hypot(...subtract(reference.points[next], reference.points[index]));
    if (length > 1e-12) result.push({ index, next, length });
  }
  if (result.length === 0) fail('plainform_surface_reference_degenerate', `Surface reference $${reference.name} has no measurable length.`);
  return result;
}

/** Samples a semantic curve/boundary by normalized arc length and exposes its frame. */
export function sampleSurfaceReference(reference, factor) {
  if (!Number.isFinite(factor) || factor < 0 || factor > 1) {
    fail('plainform_surface_reference_factor', 'A surface-reference position must be between 0 and 100 percent.');
  }
  const spans = segments(reference);
  const total = spans.reduce((sum, item) => sum + item.length, 0);
  const target = total * factor;
  let traversed = 0;
  let selected = spans.at(-1);
  for (const item of spans) {
    if (target <= traversed + item.length + 1e-12) { selected = item; break; }
    traversed += item.length;
  }
  const local = Math.max(0, Math.min(1, (target - traversed) / selected.length));
  const point = add(reference.points[selected.index], scale(subtract(reference.points[selected.next], reference.points[selected.index]), local));
  const tangent = normalize(subtract(reference.points[selected.next], reference.points[selected.index]));
  const normals = reference.normals ?? reference.anchors?.map(anchor => anchor.normal);
  const normal = normals
    ? normalize(add(scale(normals[selected.index], 1 - local), scale(normals[selected.next], local)))
    : null;
  const outward = normal ? normalize(cross(normal, tangent)) : null;
  return { point, tangent, normal, outward, factor, segment: selected.index };
}

/** Mirrors authored points/vectors around a design-space centre plane. */
export function mirrorVector(vector, axis, { centre = 0, direction = false } = {}) {
  const coordinate = { x: 0, y: 1, z: 2 }[axis];
  if (coordinate === undefined) fail('plainform_mirror_axis', `Unknown mirror axis ${axis}.`);
  const result = [...vector];
  result[coordinate] = direction ? -result[coordinate] : centre - (result[coordinate] - centre);
  return result;
}

/** Builds a projected surface-space offset curve using each sample's normal and tangent. */
export function offsetSurfaceCurve({ owner, curve, distance, name, side = 'left' }) {
  if (!curve.normals?.length) {
    fail('plainform_surface_offset_requires_anchors', `Surface offset of $${curve.name} requires a surface-anchored curve with recorded normals.`);
  }
  const sign = side === 'right' ? -1 : 1;
  const seedPoints = curve.points.map((point, index) => {
    const previous = curve.points[curve.closed ? (index - 1 + curve.points.length) % curve.points.length : Math.max(0, index - 1)];
    const next = curve.points[curve.closed ? (index + 1) % curve.points.length : Math.min(curve.points.length - 1, index + 1)];
    const tangent = normalize(subtract(next, previous));
    const lateral = normalize(cross(curve.normals[index], tangent));
    if (Math.hypot(...lateral) <= 1e-12) {
      fail('plainform_surface_offset_degenerate', `Surface offset of $${curve.name} cannot derive a lateral direction at sample ${index}.`);
    }
    return add(point, scale(lateral, distance * sign));
  });
  const projected = projectSurfaceAnchors({ recipe: owner.recipe, matrix: owner.matrix, seedPoints, entityId: owner.entityId });
  return {
    name,
    ownerEntityId: owner.entityId,
    coordinateSpace: 'design',
    closed: Boolean(curve.closed),
    anchorMode: 'nearestSurface',
    authoredPoints: seedPoints.map(point => [...point]),
    points: projected.map(anchor => [...anchor.point]),
    normals: projected.map(anchor => [...anchor.normal]),
    anchors: projected.map((anchor, index) => ({
      seedPoint: [...seedPoints[index]], projectedPoint: [...anchor.point], normal: [...anchor.normal],
      triangleIndex: anchor.triangleIndex, barycentric: [...anchor.barycentric],
    })),
    projection: { kind: 'surfaceOffset', source: curve.name, distance: distance * sign, side },
  };
}

function resample(reference, count) {
  return Array.from({ length: count }, (_, index) => sampleSurfaceReference(reference, index / Math.max(1, count - 1)).point);
}

/** Correspondence statistics for uniform-gap constraints. */
export function surfaceReferenceSeparation(first, second) {
  const count = Math.max(8, first.points.length, second.points.length);
  const firstPoints = resample(first, count);
  let secondPoints = resample(second, count);
  const same = Math.hypot(...subtract(firstPoints[0], secondPoints[0])) + Math.hypot(...subtract(firstPoints.at(-1), secondPoints.at(-1)));
  const reversed = Math.hypot(...subtract(firstPoints[0], secondPoints.at(-1))) + Math.hypot(...subtract(firstPoints.at(-1), secondPoints[0]));
  if (reversed < same) secondPoints = [...secondPoints].reverse();
  const distances = firstPoints.map((point, index) => Math.hypot(...subtract(point, secondPoints[index])));
  return {
    minimum: Math.min(...distances), maximum: Math.max(...distances),
    mean: distances.reduce((sum, value) => sum + value, 0) / distances.length,
    sampleCount: count,
  };
}

function initialFrame(tangent) {
  const helper = Math.abs(tangent[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const x = normalize(cross(helper, tangent));
  return { x, z: normalize(cross(tangent, x)) };
}

function rotateAroundAxis(vector, axis, angle) {
  const cosine = Math.cos(angle); const sine = Math.sin(angle);
  return add(add(scale(vector, cosine), scale(cross(axis, vector), sine)), scale(axis, dot(axis, vector) * (1 - cosine)));
}

/** Deterministic bounded profile sweep with parallel-transport-style frames. */
export function sweepProfileAlongGuide({ profile, guide, scaleStart = 1, scaleEnd = 1, twist = 0, closedProfile = true }) {
  if (profile.points.length < 3 || guide.points.length < 2) {
    fail('plainform_sweep_input', 'A sweep requires a profile with at least three points and a guide with at least two points.');
  }
  if (profile.points.length * guide.points.length > 65_536) {
    fail('plainform_sweep_limit', 'A sweep supports at most 65,536 evaluated profile-path vertices.');
  }
  const sections = [];
  let previousFrame = null;
  for (let index = 0; index < guide.points.length; index += 1) {
    const previous = guide.points[Math.max(0, index - 1)];
    const next = guide.points[Math.min(guide.points.length - 1, index + 1)];
    const tangent = normalize(subtract(next, previous));
    let frame = previousFrame ?? initialFrame(tangent);
    if (previousFrame) {
      const projected = normalize(subtract(previousFrame.x, scale(tangent, dot(previousFrame.x, tangent))));
      frame = Math.hypot(...projected) > 1e-12 ? { x: projected, z: normalize(cross(tangent, projected)) } : initialFrame(tangent);
    }
    const progress = index / Math.max(1, guide.points.length - 1);
    const angle = twist * progress;
    const xAxis = rotateAroundAxis(frame.x, tangent, angle);
    const zAxis = rotateAroundAxis(frame.z, tangent, angle);
    const localScale = scaleStart + (scaleEnd - scaleStart) * progress;
    sections.push(profile.points.map(point => add(guide.points[index], add(scale(xAxis, point[0] * localScale), scale(zAxis, point[2] * localScale)))));
    previousFrame = { x: xAxis, z: zAxis };
  }
  const positions = sections.flat();
  const profileSize = profile.points.length;
  const indices = [];
  const edgeCount = closedProfile ? profileSize : profileSize - 1;
  for (let section = 0; section < sections.length - 1; section += 1) for (let edge = 0; edge < edgeCount; edge += 1) {
    const next = (edge + 1) % profileSize;
    const a = section * profileSize + edge; const b = section * profileSize + next;
    const c = (section + 1) * profileSize + next; const d = (section + 1) * profileSize + edge;
    indices.push(a, b, d, b, c, d);
  }
  for (let point = 1; point < profileSize - 1; point += 1) indices.push(0, point + 1, point);
  const end = (sections.length - 1) * profileSize;
  for (let point = 1; point < profileSize - 1; point += 1) indices.push(end, end + point, end + point + 1);
  return { kind: 'indexedMesh', positions: positions.flat(), indices };
}

/** Mirrors an existing evaluated owner into design-local indexed geometry. */
export function mirrorEvaluatedSurface({ mesh, ownerMatrix, axis }) {
  const inverse = invertTransformMatrix(ownerMatrix);
  const positions = mesh.worldPositions.map(point => transformPointByMatrix(inverse, mirrorVector(point, axis)));
  const indices = [];
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const [a, b, c] = mesh.indices.slice(offset, offset + 3);
    indices.push(a, c, b);
  }
  return { kind: 'indexedMesh', positions: positions.flat(), indices };
}
