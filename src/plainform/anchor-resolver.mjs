import {
  composeTransformMatrix,
  entityWorldMatrix,
  invertTransformMatrix,
  transformPointByMatrix,
} from '../core/transform-math.mjs';

function axisIndex(axis, fail) {
  const index = axis.findIndex(value => Math.abs(value) > 0.999999);
  if (index < 0 || axis.some((value, candidate) => candidate !== index && Math.abs(value) > 1e-9)) {
    fail('plainform_axis_not_cardinal', 'Growth anchors currently require a positive or negative X, Y, or Z axis.');
  }
  return index;
}

function recipeOf(project, record, fail) {
  const geometryId = record.entity.components?.mesh?.geometryId;
  const geometry = geometryId ? project.resources.geometries[geometryId] : null;
  if (!geometry) fail('plainform_geometry_required', `${record.entity.id} needs mesh geometry for anchor-aware growth.`);
  return geometry.recipe ?? geometry;
}

function rawDimensions(recipe) {
  switch (recipe.kind) {
    case 'cylinder': {
      const radii = [recipe.radius, recipe.radiusTop, recipe.radiusBottom].filter(Number.isFinite);
      const radius = radii.length > 0 ? Math.max(...radii) : 1;
      return { size: [radius * 2, recipe.height ?? 1, radius * 2], thickness: radius * 2 };
    }
    case 'sphere': {
      const diameter = (recipe.radius ?? 1) * 2;
      return { size: [diameter, diameter, diameter], thickness: diameter };
    }
    case 'box':
      return {
        size: [recipe.width ?? 1, recipe.height ?? 1, recipe.depth ?? 1],
        thickness: Math.min(recipe.width ?? 1, recipe.height ?? 1, recipe.depth ?? 1),
      };
    default:
      return { size: [1, 1, 1], thickness: 1 };
  }
}

const NAMED_ANCHORS = Object.freeze({
  center: Object.freeze([0, 0, 0]),
  centre: Object.freeze([0, 0, 0]),
  left: Object.freeze([-1, 0, 0]),
  right: Object.freeze([1, 0, 0]),
  bottom: Object.freeze([0, -1, 0]),
  base: Object.freeze([0, -1, 0]),
  top: Object.freeze([0, 1, 0]),
  back: Object.freeze([0, 0, -1]),
  rear: Object.freeze([0, 0, -1]),
  front: Object.freeze([0, 0, 1]),
});

/** Geometry-aware base/tip anchors and bounded analytic surface attachment. */
export class PlainformAnchorResolver {
  constructor({ project, spatial, fail }) {
    this.project = project;
    this.spatial = spatial;
    this.fail = fail;
  }

  dimensions(record, axis) {
    const recipe = recipeOf(this.project, record, this.fail);
    const raw = rawDimensions(recipe);
    const index = axisIndex(axis, this.fail);
    const length = raw.size[index] * Math.abs(record.entity.transform.scale[index]);
    const transverse = [0, 1, 2].filter(candidate => candidate !== index);
    const thickness = raw.thickness
      * Math.sqrt(Math.abs(record.entity.transform.scale[transverse[0]] * record.entity.transform.scale[transverse[1]]));
    return { recipe, raw, axisIndex: index, length, thickness };
  }

  localAnchor(record, axis, anchor) {
    const { raw, axisIndex: index } = this.dimensions(record, axis);
    const sign = Math.sign(axis[index]);
    const value = (anchor === 'tip' ? 0.5 : -0.5) * raw.size[index] * sign;
    const point = [0, 0, 0];
    point[index] = value;
    return point;
  }

  worldAnchor(record, axis, anchor, transform = record.entity.transform) {
    return transformPointByMatrix(this.spatial.worldMatrix(record, transform), this.localAnchor(record, axis, anchor));
  }

  namedDirection(name) {
    const direction = NAMED_ANCHORS[String(name).toLowerCase()];
    if (!direction) this.fail('plainform_unknown_anchor', `“${name}” is not a supported object anchor.`);
    return [...direction];
  }

  localNamedAnchor(record, name) {
    const direction = this.namedDirection(name);
    if (direction.every(value => value === 0)) return [0, 0, 0];
    const { raw } = this.dimensions(record, direction);
    return direction.map((value, index) => value * raw.size[index] * 0.5);
  }

  worldNamedAnchor(record, name, transform = record.entity.transform) {
    return transformPointByMatrix(this.spatial.worldMatrix(record, transform), this.localNamedAnchor(record, name));
  }

  placeNamedAnchorAtWorld(record, name, worldTarget, transform) {
    const target = this.parentSpacePoint(record, worldTarget);
    const offsetMatrix = composeTransformMatrix({ ...transform, position: [0, 0, 0] });
    const anchorOffset = transformPointByMatrix(offsetMatrix, this.localNamedAnchor(record, name));
    return target.map((value, index) => value - anchorOffset[index]);
  }

  alignNamedAnchors(record, ownName, reference, referenceName, transform) {
    const target = this.worldNamedAnchor(reference, referenceName);
    return this.placeNamedAnchorAtWorld(record, ownName, target, transform);
  }

  gridOriginOnFace(
    reference,
    face,
    columns,
    rows,
    horizontalSpacing,
    verticalSpacing,
    outwardOffset = 0,
    { patternRecord, patternTransform } = {},
  ) {
    const direction = this.namedDirection(face);
    if (direction.every(value => value === 0)) this.fail('plainform_face_required', 'A grid requires a front, back, left, right, top, or bottom face.');
    if (!patternRecord || !patternTransform) {
      this.fail('plainform_grid_basis_required', 'A face grid requires the final transformed pattern source so its origin and repetitions share one local basis.');
    }
    const world = this.spatial.worldMatrix(reference);
    const centre = this.worldNamedAnchor(reference, face);
    const worldOrigin = transformPointByMatrix(world, [0, 0, 0]);
    const patternWorld = this.spatial.worldMatrix(patternRecord, {
      ...patternTransform,
      position: [0, 0, 0],
    });
    const patternOrigin = transformPointByMatrix(patternWorld, [0, 0, 0]);
    const patternDirection = localAxis => {
      const point = [0, 0, 0];
      point[localAxis] = 1;
      const transformed = transformPointByMatrix(patternWorld, point);
      const vector = transformed.map((value, index) => value - patternOrigin[index]);
      const length = Math.hypot(...vector) || 1;
      return vector.map(value => value / length);
    };
    const horizontal = patternDirection(0);
    const vertical = patternDirection(1);
    const outward = centre.map((value, index) => value - worldOrigin[index]);
    const outwardLength = Math.hypot(...outward) || 1;
    return centre.map((value, index) => (
      value
      - horizontal[index] * (columns - 1) * horizontalSpacing * 0.5
      - vertical[index] * (rows - 1) * verticalSpacing * 0.5
      + outward[index] / outwardLength * outwardOffset
    ));
  }

  surfacePoint(reference, towardWorld) {
    const recipe = recipeOf(this.project, reference, this.fail);
    const world = this.spatial.worldMatrix(reference);
    const local = transformPointByMatrix(invertTransformMatrix(world), towardWorld);
    let point;
    if (recipe.kind === 'cylinder') {
      const height = recipe.height ?? 1;
      const y = Math.max(-height / 2, Math.min(height / 2, local[1]));
      const fraction = Math.max(0, Math.min(1, (y / height) + 0.5));
      const bottom = recipe.radiusBottom ?? recipe.radius ?? 1;
      const top = recipe.radiusTop ?? recipe.radius ?? 1;
      const radius = bottom + (top - bottom) * fraction;
      const radialLength = Math.hypot(local[0], local[2]);
      const radial = radialLength > 1e-9 ? [local[0] / radialLength, local[2] / radialLength] : [1, 0];
      point = [radial[0] * radius, y, radial[1] * radius];
    } else if (recipe.kind === 'sphere') {
      const radius = recipe.radius ?? 1;
      const length = Math.hypot(...local) || 1;
      point = local.map(value => value / length * radius);
    } else if (recipe.kind === 'box') {
      const half = [(recipe.width ?? 1) / 2, (recipe.height ?? 1) / 2, (recipe.depth ?? 1) / 2];
      point = local.map((value, index) => Math.max(-half[index], Math.min(half[index], value)));
      const distances = point.map((value, index) => half[index] - Math.abs(value));
      const face = distances.indexOf(Math.min(...distances));
      point[face] = Math.sign(point[face] || 1) * half[face];
    } else {
      this.fail('plainform_surface_unsupported', `Surface attachment does not support ${recipe.kind ?? 'unknown'} geometry yet.`);
    }
    return transformPointByMatrix(world, point);
  }

  parentSpacePoint(record, worldPoint) {
    if (!record.entity.parentId) return worldPoint;
    const parentWorld = entityWorldMatrix(record.scene, record.entity.parentId);
    return transformPointByMatrix(invertTransformMatrix(parentWorld), worldPoint);
  }

  placeAnchorAtWorld(record, axis, anchor, worldTarget, transform) {
    const target = this.parentSpacePoint(record, worldTarget);
    const offsetMatrix = composeTransformMatrix({ ...transform, position: [0, 0, 0] });
    const anchorOffset = transformPointByMatrix(offsetMatrix, this.localAnchor(record, axis, anchor));
    return target.map((value, index) => value - anchorOffset[index]);
  }

  attachToSurface(record, axis, reference, transform, inset = 0) {
    const origin = this.spatial.worldMatrix(record, transform).slice(12, 15);
    const surface = this.surfacePoint(reference, origin);
    const centre = this.spatial.position(reference);
    const outward = surface.map((value, index) => value - centre[index]);
    const length = Math.hypot(...outward) || 1;
    const target = surface.map((value, index) => value - outward[index] / length * inset);
    return this.placeAnchorAtWorld(record, axis, 'base', target, transform);
  }

  attachAlongParent(record, axis, parent, parentAxis, fraction, transform) {
    const base = this.worldAnchor(parent, parentAxis, 'base');
    const tip = this.worldAnchor(parent, parentAxis, 'tip');
    const target = base.map((value, index) => value + (tip[index] - value) * fraction);
    return this.placeAnchorAtWorld(record, axis, 'base', target, transform);
  }
}
