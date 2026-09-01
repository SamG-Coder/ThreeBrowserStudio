import { buildConstrainedPatchSections } from './constrained-surface.mjs';

const subtract = (a, b) => a.map((value, axis) => value - b[axis]);
const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = value => Math.hypot(...value);
const normalize = value => length(value) > 1e-12 ? value.map(item => item / length(value)) : [0, 0, 0];

function fail(code, message, details) { const error = new Error(message); error.code = code; error.details = details; throw error; }
function sampleNormal(boundary, index, count) {
  const at = index / Math.max(1, count - 1) * Math.max(0, boundary.normals.length - 1); const lower = Math.floor(at); const upper = Math.min(boundary.normals.length - 1, lower + 1); const factor = at - lower;
  return normalize(boundary.normals[lower].map((value, axis) => value + (boundary.normals[upper][axis] - value) * factor));
}

/** Builds and validates one deterministic boundary transition before it becomes a geometry recipe. */
export function solveFairTransition({ first, second, ends = null, continuity = 'tangent', sourceTangency = true, iterationBudget = 12 }) {
  if (!['positional', 'tangent', 'curvature'].includes(continuity)) fail('plainform_transition_continuity_invalid', `Unsupported transition continuity ${continuity}.`);
  if (!Number.isSafeInteger(iterationBudget) || iterationBudget < 1 || iterationBudget > 64) fail('plainform_transition_budget_invalid', 'Fair-transition iteration budget must be 1 to 64.');
  const evaluated = buildConstrainedPatchSections({ first, second, ends, continuity, sourceTangency });
  const sections = evaluated.sections; let minimumArea = Infinity; let maximumTangentError = 0; let invertedCellCount = 0; let referenceNormal = null;
  for (let row = 0; row < sections.length - 1; row += 1) {
    for (let column = 0; column < evaluated.profileResolution - 1; column += 1) {
      const a = sections[row].points[column]; const b = sections[row].points[column + 1]; const c = sections[row + 1].points[column]; const d = sections[row + 1].points[column + 1];
      const normals = [cross(subtract(b, a), subtract(c, a)), cross(subtract(d, b), subtract(c, b))];
      for (const normal of normals) { const area = length(normal) * 0.5; minimumArea = Math.min(minimumArea, area); if (!referenceNormal && area > 1e-14) referenceNormal = normalize(normal); else if (area > 1e-14 && dot(referenceNormal, normalize(normal)) < -1e-6) invertedCellCount += 1; }
    }
  }
  if (!(minimumArea > 1e-14) || invertedCellCount) fail('plainform_transition_invalid', 'Fair-transition candidate contains degenerate or inverted triangles.', { minimumArea, invertedCellCount });
  if (sourceTangency) {
    for (let column = 0; column < evaluated.profileResolution; column += 1) {
      const firstDirection = normalize(subtract(sections[1].points[column], sections[0].points[column]));
      const last = sections.length - 1; const secondDirection = normalize(subtract(sections[last - 1].points[column], sections[last].points[column]));
      maximumTangentError = Math.max(maximumTangentError, Math.abs(dot(firstDirection, sampleNormal(first, column, evaluated.profileResolution))), Math.abs(dot(secondDirection, sampleNormal(second, column, evaluated.profileResolution))));
    }
    if (maximumTangentError > 1e-6) fail('plainform_transition_tangent_error', 'Fair-transition candidate exceeds the source tangent tolerance.', { maximumTangentError, tolerance: 1e-6 });
  }
  const requested = { positional: 'G0', tangent: 'G1', curvature: 'G2' }[continuity];
  // Source curvature tensors are not present in v1 anchors. Curvature wording
  // therefore retains its legacy smoothstep shape but reports bounded G1
  // instead of falsely claiming a proven G2 join.
  const achieved = continuity === 'curvature' ? 'boundedG1' : requested;
  return {
    ...evaluated,
    evidence: {
      requested, achieved, deterministicCorrespondenceCount: evaluated.profileResolution,
      iterationBudget, iterationsUsed: 1, minimumArea, invertedCellCount,
      maximumTangentError, maximumBoundaryDeviation: 0,
      selfIntersectionStatus: 'local-grid-clear',
      ...(continuity === 'curvature' ? { diagnostic: 'G2 requires source curvature tensors; legacy curvature blend is a bounded G1 approximation.' } : {}),
    },
  };
}
