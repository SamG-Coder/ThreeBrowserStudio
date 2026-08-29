import { MAX_INSPECT_RESPONSE_BYTES } from './constants.mjs';
import { editableMeshTopologyHash, normalizeEditableMeshRecipe } from './editable-mesh.mjs';
import { StudioError } from './errors.mjs';
import { contentHash } from './util.mjs';

export const MESH_ELEMENT_KINDS = Object.freeze(['vertices', 'edges', 'faces', 'corners']);
export const MAX_MESH_ELEMENTS_PER_PAGE = 200;
const MAX_ADJACENCY_PER_ELEMENT = 64;
const MAX_DERIVED_EDGES = 1_000_000;
const ENCODER = new TextEncoder();
export const MESH_INSPECTION_LIMITS = Object.freeze({
  maxElementsPerPage: MAX_MESH_ELEMENTS_PER_PAGE,
  maxAdjacencyPerElement: MAX_ADJACENCY_PER_ELEMENT,
  maxDerivedEdges: MAX_DERIVED_EDGES,
});

function indexedRecipe(recipe, kind) {
  const positions = recipe.positions ?? recipe.attributes?.position;
  const sourceIndices = recipe.indices ?? recipe.index;
  if (!Array.isArray(positions) || positions.length < 9 || positions.length % 3 !== 0) {
    throw new StudioError('mesh_elements_invalid', 'Mesh positions must contain complete XYZ vertices.');
  }
  const vertexCount = positions.length / 3;
  const indices = Array.isArray(sourceIndices) && sourceIndices.length
    ? sourceIndices
    : Array.from({ length: vertexCount }, (_, index) => index);
  if (indices.length < 3 || indices.length % 3 !== 0) {
    throw new StudioError('mesh_elements_invalid', 'Mesh indices must contain complete triangles.');
  }
  for (let index = 0; index < indices.length; index += 1) {
    if (!Number.isInteger(indices[index]) || indices[index] < 0 || indices[index] >= vertexCount) {
      throw new StudioError('mesh_elements_invalid', `Mesh index ${index} is outside the vertex range.`);
    }
  }
  return {
    kind,
    topologyKind: 'triangles',
    positions,
    faceOffsets: Array.from({ length: indices.length / 3 + 1 }, (_, index) => index * 3),
    cornerVertexIndices: indices,
    normals: recipe.normals ?? recipe.attributes?.normal,
    uvs: recipe.uvs ?? recipe.attributes?.uv,
    colors: recipe.colors ?? recipe.attributes?.color,
    triangleMaterialIndices: recipe.triangleMaterialIndices,
    topologyHash: contentHash({ vertexCount, indices }),
  };
}

function recipeFrom(resource) {
  const enclosed = resource?.recipe !== undefined || resource?.parameters !== undefined;
  const recipe = resource?.recipe ?? resource?.parameters ?? resource;
  const directType = ['editableMesh', 'indexedMesh', 'explicit'].includes(resource?.type)
    ? resource.type
    : undefined;
  const kind = enclosed
    ? (recipe?.kind ?? recipe?.type ?? resource?.geometryKind)
    : (directType ?? resource?.geometryKind ?? recipe?.kind ?? recipe?.type);
  if (kind === 'editableMesh') {
    try {
      const mesh = normalizeEditableMeshRecipe({ ...recipe, kind: 'editableMesh' });
      return {
        ...mesh,
        topologyKind: 'polygons',
        topologyHash: editableMeshTopologyHash(mesh),
      };
    } catch (error) {
      throw new StudioError('mesh_elements_invalid', `Editable mesh recipe is invalid: ${error.message}`);
    }
  }
  if (['indexedMesh', 'explicit'].includes(kind)) return indexedRecipe(recipe, kind);
  throw new StudioError(
    'mesh_elements_unavailable',
    `Mesh elements require an authored editableMesh, indexedMesh, or explicit recipe; ${resource?.id ?? 'resource'} uses ${kind ?? 'unknown'}.`,
    { resourceId: resource?.id ?? null, recipeKind: kind ?? null },
  );
}

function tuple(values, index, size) {
  if (!Array.isArray(values) || values.length < (index + 1) * size) return undefined;
  return values.slice(index * size, index * size + size);
}

function colorStride(colors, vertexCount) {
  if (!Array.isArray(colors) || vertexCount === 0) return 0;
  const stride = colors.length / vertexCount;
  return stride === 3 || stride === 4 ? stride : 0;
}

function vertexAttributes(mesh, vertexIndex) {
  const stride = colorStride(mesh.colors, mesh.positions.length / 3);
  return {
    position: tuple(mesh.positions, vertexIndex, 3),
    ...(tuple(mesh.normals, vertexIndex, 3) ? { normal: tuple(mesh.normals, vertexIndex, 3) } : {}),
    ...(tuple(mesh.uvs, vertexIndex, 2) ? { uv: tuple(mesh.uvs, vertexIndex, 2) } : {}),
    ...(stride ? { color: tuple(mesh.colors, vertexIndex, stride) } : {}),
  };
}

function cornerAttributes(mesh, cornerIndex) {
  const vertexIndex = mesh.cornerVertexIndices[cornerIndex];
  if (mesh.topologyKind !== 'polygons') return vertexAttributes(mesh, vertexIndex);
  return {
    position: tuple(mesh.positions, vertexIndex, 3),
    uvLayers: Object.fromEntries(Object.entries(mesh.uvLayers).map(([name, values]) => [
      name,
      tuple(values, cornerIndex, 2),
    ])),
    colorLayers: Object.fromEntries(Object.entries(mesh.colorLayers).map(([name, values]) => [
      name,
      tuple(values, cornerIndex, 4),
    ])),
  };
}

function edgeKey(first, second) {
  return first < second ? `${first}:${second}` : `${second}:${first}`;
}

function deriveEdges(mesh) {
  const edges = new Map();
  for (let faceIndex = 0; faceIndex < mesh.faceOffsets.length - 1; faceIndex += 1) {
    const start = mesh.faceOffsets[faceIndex];
    const end = mesh.faceOffsets[faceIndex + 1];
    for (let corner = start; corner < end; corner += 1) {
      const first = mesh.cornerVertexIndices[corner];
      const second = mesh.cornerVertexIndices[corner + 1 === end ? start : corner + 1];
      if (first === second) continue;
      const vertices = first < second ? [first, second] : [second, first];
      const key = edgeKey(first, second);
      let edge = edges.get(key);
      if (!edge) {
        if (edges.size >= MAX_DERIVED_EDGES) {
          throw new StudioError('mesh_inspect_budget_exceeded', `Derived edge count exceeds ${MAX_DERIVED_EDGES}.`);
        }
        edge = { key, vertices, faces: [] };
        edges.set(key, edge);
      }
      edge.faces.push(faceIndex);
    }
  }
  return [...edges.values()].sort((first, second) => (
    first.vertices[0] - second.vertices[0] || first.vertices[1] - second.vertices[1]
  ));
}

function vertexPage(mesh, edges, offset, limit) {
  const end = Math.min(mesh.positions.length / 3, offset + limit);
  const selected = new Map();
  for (let index = offset; index < end; index += 1) {
    selected.set(index, { neighbours: new Set(), faces: new Set(), boundary: false });
  }
  for (const edge of edges) {
    for (let endpoint = 0; endpoint < 2; endpoint += 1) {
      const state = selected.get(edge.vertices[endpoint]);
      if (!state) continue;
      state.neighbours.add(edge.vertices[1 - endpoint]);
      for (const faceIndex of edge.faces) state.faces.add(faceIndex);
      if (edge.faces.length === 1) state.boundary = true;
    }
  }
  return [...selected].map(([index, state]) => {
    const adjacentVertices = [...state.neighbours].sort((a, b) => a - b);
    const incidentFaces = [...state.faces].sort((a, b) => a - b);
    return {
      index,
      ...vertexAttributes(mesh, index),
      adjacentVertexCount: adjacentVertices.length,
      adjacentVertices: adjacentVertices.slice(0, MAX_ADJACENCY_PER_ELEMENT),
      incidentFaceCount: incidentFaces.length,
      incidentFaces: incidentFaces.slice(0, MAX_ADJACENCY_PER_ELEMENT),
      boundary: state.boundary,
      truncatedAdjacency: adjacentVertices.length > MAX_ADJACENCY_PER_ELEMENT
        || incidentFaces.length > MAX_ADJACENCY_PER_ELEMENT,
    };
  });
}

function edgePage(mesh, edges, offset, limit) {
  const sharp = new Set((mesh.sharpEdges ?? []).map(pair => edgeKey(pair[0], pair[1])));
  const creases = new Map((mesh.edgeCreases ?? []).map(tupleValue => [
    edgeKey(tupleValue[0], tupleValue[1]),
    tupleValue[2],
  ]));
  return edges.slice(offset, offset + limit).map((edge, localIndex) => ({
    index: offset + localIndex,
    vertices: edge.vertices,
    endpoints: edge.vertices.map(index => vertexAttributes(mesh, index)),
    incidentFaceCount: edge.faces.length,
    incidentFaces: edge.faces.slice(0, MAX_ADJACENCY_PER_ELEMENT),
    boundary: edge.faces.length === 1,
    nonManifold: edge.faces.length > 2,
    ...(mesh.topologyKind === 'polygons' ? {
      sharp: sharp.has(edge.key),
      crease: creases.get(edge.key) ?? 0,
    } : {}),
    truncatedAdjacency: edge.faces.length > MAX_ADJACENCY_PER_ELEMENT,
  }));
}

function facePage(mesh, offset, limit) {
  const faceCount = mesh.faceOffsets.length - 1;
  const records = [];
  for (let faceIndex = offset; faceIndex < Math.min(faceCount, offset + limit); faceIndex += 1) {
    const start = mesh.faceOffsets[faceIndex];
    const end = mesh.faceOffsets[faceIndex + 1];
    const vertices = mesh.cornerVertexIndices.slice(start, end);
    records.push({
      index: faceIndex,
      vertices,
      ...(mesh.topologyKind === 'polygons'
        ? { materialIndex: mesh.faceMaterialIndices[faceIndex] }
        : (Array.isArray(mesh.triangleMaterialIndices)
            ? { materialIndex: mesh.triangleMaterialIndices[faceIndex] }
            : {})),
      corners: vertices.map((vertexIndex, localCorner) => ({
        ...(mesh.topologyKind === 'polygons' ? { vertexIndex } : {}),
        ...cornerAttributes(mesh, start + localCorner),
      })),
    });
  }
  return records;
}

function faceIndexForCorner(mesh, cornerIndex) {
  let lower = 0;
  let upper = mesh.faceOffsets.length - 1;
  while (lower < upper - 1) {
    const middle = Math.floor((lower + upper) / 2);
    if (mesh.faceOffsets[middle] <= cornerIndex) lower = middle;
    else upper = middle;
  }
  return lower;
}

function cornerPage(mesh, offset, limit) {
  const records = [];
  const end = Math.min(mesh.cornerVertexIndices.length, offset + limit);
  for (let cornerIndex = offset; cornerIndex < end; cornerIndex += 1) {
    const faceIndex = faceIndexForCorner(mesh, cornerIndex);
    const vertexIndex = mesh.cornerVertexIndices[cornerIndex];
    records.push({
      index: cornerIndex,
      faceIndex,
      faceCorner: cornerIndex - mesh.faceOffsets[faceIndex],
      vertexIndex,
      ...cornerAttributes(mesh, cornerIndex),
    });
  }
  return records;
}

function elementCount(mesh, element, edgeCount) {
  if (element === 'vertices') return mesh.positions.length / 3;
  if (element === 'faces') return mesh.faceOffsets.length - 1;
  if (element === 'corners') return mesh.cornerVertexIndices.length;
  return edgeCount;
}

function attributeDigest(mesh) {
  if (mesh.topologyKind === 'polygons') {
    return {
      position: { itemSize: 3, count: mesh.positions.length / 3, domain: 'vertex' },
      uvLayers: Object.fromEntries(Object.keys(mesh.uvLayers).map(name => [
        name,
        { itemSize: 2, count: mesh.cornerVertexIndices.length, domain: 'corner' },
      ])),
      colorLayers: Object.fromEntries(Object.keys(mesh.colorLayers).map(name => [
        name,
        { itemSize: 4, count: mesh.cornerVertexIndices.length, domain: 'corner' },
      ])),
      faceMaterialIndex: { itemSize: 1, count: mesh.faceOffsets.length - 1, domain: 'face' },
    };
  }
  const vertexCount = mesh.positions.length / 3;
  const stride = colorStride(mesh.colors, vertexCount);
  return {
    position: { itemSize: 3, count: vertexCount },
    ...(Array.isArray(mesh.normals) ? { normal: { itemSize: 3, count: mesh.normals.length / 3 } } : {}),
    ...(Array.isArray(mesh.uvs) ? { uv: { itemSize: 2, count: mesh.uvs.length / 2 } } : {}),
    ...(stride ? { color: { itemSize: stride, count: vertexCount } } : {}),
    ...(Array.isArray(mesh.triangleMaterialIndices) ? {
      triangleMaterialIndex: { itemSize: 1, count: mesh.triangleMaterialIndices.length, domain: 'face' },
    } : {}),
  };
}

/** Returns one deterministic, exact, byte-bounded page of authored mesh elements. */
export function buildMeshElements(resource, {
  element = 'vertices',
  cursor,
  limit = 50,
  responseByteBudget = MAX_INSPECT_RESPONSE_BYTES,
} = {}) {
  if (!MESH_ELEMENT_KINDS.includes(element)) {
    throw new StudioError('mesh_element_kind_invalid', `Unknown mesh element kind ${element}.`);
  }
  const mesh = recipeFrom(resource);
  const resourceHash = contentHash(resource);
  const topologyHash = mesh.topologyHash;
  let offset = 0;
  if (cursor !== undefined) {
    const match = /^([a-f0-9]{64})\.([a-f0-9]{64})\.(vertices|edges|faces|corners)\.(\d+)$/.exec(cursor);
    if (!match) throw new StudioError('inspect_cursor_invalid', 'Mesh cursor is malformed.');
    if (match[1] !== resourceHash || match[2] !== topologyHash) {
      throw new StudioError('inspect_cursor_stale', 'Mesh changed after this cursor was issued.', {
        expectedResourceHash: match[1],
        actualResourceHash: resourceHash,
        expectedTopologyHash: match[2],
        actualTopologyHash: topologyHash,
      });
    }
    if (match[3] !== element) {
      throw new StudioError('inspect_cursor_mismatch', `Mesh cursor belongs to ${match[3]}, not ${element}.`, {
        cursorElement: match[3],
        requestedElement: element,
      });
    }
    offset = Number(match[4]);
  }
  const boundedLimit = Math.min(MAX_MESH_ELEMENTS_PER_PAGE, Math.max(1, limit));
  const edges = ['vertices', 'edges'].includes(element) ? deriveEdges(mesh) : null;
  const total = elementCount(mesh, element, edges?.length);
  let elements;
  if (element === 'vertices') elements = vertexPage(mesh, edges, offset, boundedLimit);
  else if (element === 'edges') elements = edgePage(mesh, edges, offset, boundedLimit);
  else if (element === 'faces') elements = facePage(mesh, offset, boundedLimit);
  else elements = cornerPage(mesh, offset, boundedLimit);

  const faceCount = mesh.faceOffsets.length - 1;
  const base = {
    resourceId: resource.id,
    resourceHash,
    topologyHash,
    recipeKind: mesh.kind,
    ...(mesh.topologyKind === 'polygons' ? { topologyKind: mesh.topologyKind } : {}),
    vertexCount: mesh.positions.length / 3,
    ...(mesh.topologyKind === 'triangles' ? { triangleCount: faceCount } : { faceCount }),
    cornerCount: mesh.cornerVertexIndices.length,
    ...(edges ? { edgeCount: edges.length } : {}),
    attributes: attributeDigest(mesh),
    ...(mesh.topologyKind === 'polygons' ? {
      activeUvLayer: mesh.activeUvLayer,
      activeColorLayer: mesh.activeColorLayer,
      sharpEdgeCount: mesh.sharpEdges.length,
      creasedEdgeCount: mesh.edgeCreases.length,
    } : {}),
    element,
    offset,
    total,
    responseByteBudget,
  };
  const accepted = [];
  for (const record of elements) {
    const candidateNextOffset = offset + accepted.length + 1;
    const candidate = {
      ...base,
      elements: [...accepted, record],
      nextCursor: candidateNextOffset < total
        ? `${resourceHash}.${topologyHash}.${element}.${candidateNextOffset}`
        : null,
      truncatedByByteBudget: candidateNextOffset < offset + elements.length,
    };
    if (ENCODER.encode(JSON.stringify(candidate)).byteLength > responseByteBudget) break;
    accepted.push(record);
  }
  const nextOffset = offset + accepted.length;
  if (accepted.length === 0 && offset < total) {
    throw new StudioError('inspect_response_budget_too_small', 'The response budget cannot fit one mesh element.');
  }
  return {
    ...base,
    elements: accepted,
    nextCursor: nextOffset < total ? `${resourceHash}.${topologyHash}.${element}.${nextOffset}` : null,
    truncatedByByteBudget: accepted.length < elements.length,
  };
}
