import { contentHash } from '../core/index.mjs';
import { invertTransformMatrix, transformPointByMatrix } from '../core/transform-math.mjs';
import { realizeSurfaceTriangles } from './constrained-surface.mjs';
import { surfaceRegionWeight } from './semantic-surface-deformation.mjs';
import {
  conformingSubdivideTriangles,
  relaxConformingRegion,
  validateConformingTriangleMesh,
} from './conforming-remesh.mjs';

function selectedFaces(mesh, region, resolveReference) {
  const selected = new Set();
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const indices = mesh.indices.slice(offset, offset + 3);
    const center = indices.reduce(
      (sum, index) => sum.map((value, axis) => value + mesh.worldPositions[index][axis] / 3), [0, 0, 0],
    );
    if (surfaceRegionWeight(center, region, resolveReference, Number.EPSILON) >= 0.5) selected.add(offset / 3);
  }
  return selected;
}

export function refineSurfaceRegion({ owner, region, resolveReference, levels = 1, relaxIterations = 0, relaxStrength = 0.5 }) {
  if (!Number.isSafeInteger(levels) || levels < 0 || levels > 4) throw new RangeError('Surface refinement supports 0 to 4 subdivision levels.');
  if (!Number.isSafeInteger(relaxIterations) || relaxIterations < 0 || relaxIterations > 16) throw new RangeError('Surface relaxation supports 0 to 16 iterations.');
  if (!(relaxStrength > 0 && relaxStrength <= 1)) throw new RangeError('Surface relaxation strength must be greater than 0 and at most 1.');
  let mesh = realizeSurfaceTriangles({ recipe: owner.recipe, matrix: owner.matrix, entityId: owner.entityId });
  const sourceMesh = structuredClone(mesh);
  let selected = selectedFaces(mesh, region, resolveReference);
  if (selected.size === 0) {
    const error = new Error(`Surface refinement region “${region.name}” selects no triangles on ${owner.entityId}.`);
    error.code = 'plainform_surface_refinement_empty'; throw error;
  }
  let selectedVertices = new Set(); let boundaryVertices = new Set(); let transitionFaceCount = 0; let boundaryLoops = [];
  if (levels === 0) {
    selectedVertices = new Set([...selected].flatMap(face => mesh.indices.slice(face * 3, face * 3 + 3)));
    const marked = conformingSubdivideTriangles(mesh, selected);
    boundaryVertices = new Set([...marked.boundaryLoops].flat()); boundaryLoops = marked.boundaryLoops;
  }
  for (let level = 0; level < levels; level += 1) {
    mesh = conformingSubdivideTriangles(mesh, selected);
    selected = mesh.refinedFaces; selectedVertices = mesh.refinedVertices;
    boundaryVertices = mesh.boundaryVertices; boundaryLoops = mesh.boundaryLoops;
    transitionFaceCount += mesh.transitionFaces.size;
    if (mesh.worldPositions.length > 250_000 || mesh.indices.length > 1_500_000) {
      const error = new Error('Surface refinement exceeds the bounded 250,000-vertex or 500,000-triangle limit.');
      error.code = 'plainform_surface_refinement_limit'; throw error;
    }
  }
  if (relaxIterations > 0) {
    mesh = relaxConformingRegion(mesh, selectedVertices, boundaryVertices, sourceMesh, relaxIterations, relaxStrength);
  }
  const quality = validateConformingTriangleMesh(mesh);
  const inverse = invertTransformMatrix(owner.matrix);
  return {
    recipe: {
      kind: 'indexedMesh',
      positions: mesh.worldPositions.flatMap(point => transformPointByMatrix(inverse, point)),
      indices: [...mesh.indices],
      ...(mesh.uvs ? { uvs: mesh.uvs.flat() } : {}),
    },
    refinedFaceCount: selected.size,
    refinedVertexCount: selectedVertices.size,
    transitionFaceCount,
    boundaryLoopCount: boundaryLoops.length,
    constrainedBoundaryVertexCount: boundaryVertices.size,
    maximumProjectionDistance: mesh.maximumProjectionDistance ?? 0,
    quality,
    semanticFaceSet: {
      faceCount: selected.size,
      faceIndicesHash: contentHash([...selected].sort((a, b) => a - b)),
      boundaryLoops,
    },
    anchorDrift: { status: 'boundary-constrained', maximumDistance: 0 },
  };
}
