import { contentHash } from '../core/index.mjs';
import {
  projectSurfaceAnchors as projectTriangles,
  realizeSurfaceTriangles,
  resolveParametricSurfaceAnchor,
} from './constrained-surface.mjs';

const subtract = (left, right) => left.map((value, axis) => value - right[axis]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = value => { const size = Math.hypot(...value); return size > 1e-12 ? value.map(item => item / size) : [0, 0, 0]; };

function frame(normal) {
  const helper = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]; const tangent = normalize(cross(helper, normal));
  return { tangent, bitangent: normalize(cross(normal, tangent)), normal: [...normal] };
}

export class EvaluatedSurface {
  constructor({ recipe, matrix, entityId }) {
    this.recipe = recipe; this.matrix = matrix; this.entityId = entityId;
    this.ancestryToken = contentHash({ entityId, recipeKind: recipe?.kind, recipe });
  }

  triangles() { return realizeSurfaceTriangles({ recipe: this.recipe, matrix: this.matrix, entityId: this.entityId }); }

  projectAnchors(seedPoints) {
    return projectTriangles({ recipe: this.recipe, matrix: this.matrix, entityId: this.entityId, seedPoints }).map((anchor, index) => ({
      ...anchor,
      surface: { id: this.entityId, ancestryToken: this.ancestryToken },
      tangentFrame: frame(anchor.normal),
      health: { status: 'projected', distance: Math.hypot(...subtract(anchor.point, seedPoints[index])) },
    }));
  }

  resolveAnchor(anchor, { projectionTolerance = 0.25 } = {}) {
    try {
      const resolved = resolveParametricSurfaceAnchor({ recipe: this.recipe, matrix: this.matrix, entityId: this.entityId, anchor });
      const status = anchor.surface?.ancestryToken === this.ancestryToken ? 'exact' : 'remapped';
      return { ...resolved, surface: { id: this.entityId, ancestryToken: this.ancestryToken }, tangentFrame: frame(resolved.normal), health: { status, distance: Math.hypot(...subtract(resolved.point, anchor.projectedPoint ?? resolved.point)) } };
    } catch (error) {
      if (!Array.isArray(anchor.seedPoint)) return { health: { status: 'broken', reason: error.code ?? 'plainform_anchor_unresolved' } };
      const [projected] = this.projectAnchors([anchor.seedPoint]);
      if (projected.health.distance > projectionTolerance) return { ...projected, health: { status: 'broken', distance: projected.health.distance, reason: 'projection_tolerance_exceeded' } };
      return { ...projected, health: { status: 'projected', distance: projected.health.distance, fallbackFrom: error.code } };
    }
  }
}

export function createEvaluatedSurface(options) { return new EvaluatedSurface(options); }
export function projectSurfaceAnchors(options) {
  const { seedPoints, ...surface } = options; return createEvaluatedSurface(surface).projectAnchors(seedPoints);
}
export function inspectSurfaceAnchorHealth(options) {
  const { anchors, ...surface } = options; const evaluated = createEvaluatedSurface(surface);
  return anchors.map(anchor => evaluated.resolveAnchor(anchor).health);
}
