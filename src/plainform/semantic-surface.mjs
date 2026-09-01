const MAX_SURFACE_CURVES = 128;
const MAX_SURFACE_REGIONS = 128;

function cloneAnchor(anchor) {
  return {
    seedPoint: [...anchor.seedPoint],
    projectedPoint: [...anchor.projectedPoint],
    normal: [...anchor.normal],
    triangleIndex: anchor.triangleIndex,
    barycentric: [...anchor.barycentric],
    ...(anchor.parametric ? { parametric: structuredClone(anchor.parametric) } : {}),
  };
}

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  throw error;
}

/**
 * Keeps semantic surface intent separate from Design Plainform's solid builder.
 * Curves and regions reference stable owner entities and compile-time anchors;
 * they never expose mesh indices as authoring inputs.
 */
export class SemanticSurfaceRegistry {
  constructor({ boundaries, referenceKey }) {
    this.boundaries = boundaries;
    this.referenceKey = referenceKey;
    this.curves = new Map();
    this.regions = new Map();
    this.deformations = [];
  }

  hasReference(name) {
    const normalized = this.referenceKey(name);
    return this.curves.has(normalized) || this.boundaries.has(normalized);
  }

  addCurve(curve) {
    const name = this.referenceKey(curve.name);
    if (this.hasReference(name)) {
      fail('plainform_surface_reference_exists', `Surface reference “${name}” is already defined in this design.`);
    }
    if (this.curves.size >= MAX_SURFACE_CURVES) {
      fail('plainform_surface_curve_limit', `Design Plainform supports at most ${MAX_SURFACE_CURVES} surface curves.`);
    }
    const minimum = curve.closed ? 3 : 2;
    if (curve.points.length < minimum || curve.points.length > 256) {
      fail('plainform_surface_curve_points', `${curve.closed ? 'Closed' : 'Open'} surface curve “${name}” requires ${minimum} to 256 points.`);
    }
    this.curves.set(name, { ...curve, name });
    return this.curves.get(name);
  }

  resolveReference(value) {
    const name = this.referenceKey(value);
    const curve = this.curves.get(name);
    if (curve) return { ...curve, referenceKind: 'surfaceCurve' };
    const boundary = this.boundaries.get(name);
    if (boundary) return { ...boundary, referenceKind: 'boundary' };
    fail('plainform_unknown_surface_reference', `Unknown surface reference $${name}. Define its boundary or surface curve first.`);
  }

  addRegion(region) {
    const name = this.referenceKey(region.name);
    if (this.regions.has(name)) {
      fail('plainform_surface_region_exists', `Surface region “${name}” is already defined in this design.`);
    }
    if (this.regions.size >= MAX_SURFACE_REGIONS) {
      fail('plainform_surface_region_limit', `Design Plainform supports at most ${MAX_SURFACE_REGIONS} surface regions.`);
    }
    this.regions.set(name, { ...region, name });
    return this.regions.get(name);
  }

  resolveRegion(value) {
    const name = this.referenceKey(value);
    const region = this.regions.get(name);
    if (!region) fail('plainform_unknown_surface_region', `Unknown surface region “${name}”. Define it before deforming it.`);
    return region;
  }

  addDeformation(deformation) {
    this.deformations.push(structuredClone(deformation));
  }

  addCurveDistanceRegion({ name, reference, distance }) {
    const source = this.resolveReference(reference);
    return this.addRegion({
      name,
      ownerEntityId: source.ownerEntityId,
      definition: {
        kind: 'curveDistance',
        reference: { name: source.name, kind: source.referenceKind },
        distance,
      },
    });
  }

  addBetweenRegion({ name, firstReference, secondReference }) {
    const first = this.resolveReference(firstReference);
    const second = this.resolveReference(secondReference);
    if (first.ownerEntityId !== second.ownerEntityId) {
      fail(
        'plainform_surface_region_owner_mismatch',
        `A surface region between $${first.name} and $${second.name} requires both references to belong to the same owner surface.`,
        { firstOwnerEntityId: first.ownerEntityId, secondOwnerEntityId: second.ownerEntityId },
      );
    }
    return this.addRegion({
      name,
      ownerEntityId: first.ownerEntityId,
      definition: {
        kind: 'betweenCurves',
        references: [
          { name: first.name, kind: first.referenceKind },
          { name: second.name, kind: second.referenceKind },
        ],
      },
    });
  }

  addEnclosedRegion({ name, reference }) {
    const source = this.resolveReference(reference);
    if (source.referenceKind !== 'surfaceCurve' || !source.closed) {
      fail('plainform_surface_region_not_closed', `Surface region “${name}” requires a closed surface curve; $${source.name} is not closed.`);
    }
    return this.addRegion({
      name,
      ownerEntityId: source.ownerEntityId,
      definition: {
        kind: 'enclosedCurve',
        reference: { name: source.name, kind: source.referenceKind },
      },
    });
  }

  toMetadata() {
    return {
      surfaceCurves: [...this.curves.values()].map(curve => ({
        name: curve.name,
        ownerEntityId: curve.ownerEntityId,
        coordinateSpace: curve.coordinateSpace,
        closed: curve.closed,
        anchorMode: curve.anchorMode,
        authoredPoints: curve.authoredPoints.map(point => [...point]),
        anchors: curve.anchors.map(cloneAnchor),
        ...(curve.projection ? { projection: structuredClone(curve.projection) } : {}),
      })),
      surfaceRegions: [...this.regions.values()].map(region => ({
        name: region.name,
        ownerEntityId: region.ownerEntityId,
        definition: structuredClone(region.definition),
        ...(region.anchor ? { anchor: cloneAnchor(region.anchor) } : {}),
      })),
      surfaceDeformations: this.deformations.map(deformation => structuredClone(deformation)),
    };
  }
}
