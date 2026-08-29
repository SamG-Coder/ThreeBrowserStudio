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

function vertexAdjacency(mesh, edges) {
  const count = mesh.positions.length / 3;
  const states = Array.from({ length: count }, () => ({
    neighbours: new Set(),
    faces: new Set(),
    boundary: false,
  }));
  for (const edge of edges) {
    for (let endpoint = 0; endpoint < 2; endpoint += 1) {
      const state = states[edge.vertices[endpoint]];
      state.neighbours.add(edge.vertices[1 - endpoint]);
      for (const faceIndex of edge.faces) state.faces.add(faceIndex);
      if (edge.faces.length === 1) state.boundary = true;
    }
  }
  return states;
}

function vertexRecord(mesh, index, state) {
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
}

function vertexPage(mesh, edges, indices) {
  const selected = new Map();
  for (const index of indices) {
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
  return indices.map(index => vertexRecord(mesh, index, selected.get(index)));
}

function edgeRecord(mesh, edge, index) {
  const sharp = new Set((mesh.sharpEdges ?? []).map(pair => edgeKey(pair[0], pair[1])));
  const creases = new Map((mesh.edgeCreases ?? []).map(tupleValue => [
    edgeKey(tupleValue[0], tupleValue[1]),
    tupleValue[2],
  ]));
  return {
    index,
    vertices: edge.vertices,
    endpoints: edge.vertices.map(vertexIndex => vertexAttributes(mesh, vertexIndex)),
    incidentFaceCount: edge.faces.length,
    incidentFaces: edge.faces.slice(0, MAX_ADJACENCY_PER_ELEMENT),
    boundary: edge.faces.length === 1,
    nonManifold: edge.faces.length > 2,
    ...(mesh.topologyKind === 'polygons' ? {
      sharp: sharp.has(edge.key),
      crease: creases.get(edge.key) ?? 0,
    } : {}),
    truncatedAdjacency: edge.faces.length > MAX_ADJACENCY_PER_ELEMENT,
  };
}

function edgePage(mesh, edges, indices) {
  return indices.map(index => edgeRecord(mesh, edges[index], index));
}

function faceRecord(mesh, faceIndex) {
  const start = mesh.faceOffsets[faceIndex];
  const end = mesh.faceOffsets[faceIndex + 1];
  const vertices = mesh.cornerVertexIndices.slice(start, end);
  return {
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
  };
}

function facePage(mesh, indices) {
  return indices.map(faceIndex => faceRecord(mesh, faceIndex));
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

function cornerRecord(mesh, cornerIndex) {
  const faceIndex = faceIndexForCorner(mesh, cornerIndex);
  const vertexIndex = mesh.cornerVertexIndices[cornerIndex];
  return {
    index: cornerIndex,
    faceIndex,
    faceCorner: cornerIndex - mesh.faceOffsets[faceIndex],
    vertexIndex,
    ...cornerAttributes(mesh, cornerIndex),
  };
}

function cornerPage(mesh, indices) {
  return indices.map(cornerIndex => cornerRecord(mesh, cornerIndex));
}

function elementCount(mesh, element, edgeCount) {
  if (element === 'vertices') return mesh.positions.length / 3;
  if (element === 'faces') return mesh.faceOffsets.length - 1;
  if (element === 'corners') return mesh.cornerVertexIndices.length;
  return edgeCount;
}

function positionMatches(position, filter) {
  if (!position) return false;
  const [x, y, z] = position;
  if (filter.min && (x < filter.min[0] || y < filter.min[1] || z < filter.min[2])) return false;
  if (filter.max && (x > filter.max[0] || y > filter.max[1] || z > filter.max[2])) return false;
  if (filter.yMin !== undefined && y < filter.yMin) return false;
  if (filter.yMax !== undefined && y > filter.yMax) return false;
  return true;
}

function centroid(positions) {
  if (!positions.length) return null;
  const sum = [0, 0, 0];
  for (const position of positions) {
    sum[0] += position[0];
    sum[1] += position[1];
    sum[2] += position[2];
  }
  return [sum[0] / positions.length, sum[1] / positions.length, sum[2] / positions.length];
}

function normalizeMeshFilter(filter) {
  if (!isPlainFilter(filter)) return null;
  const normalized = {};
  if (filter.min) normalized.min = [...filter.min];
  if (filter.max) normalized.max = [...filter.max];
  if (filter.yMin !== undefined) normalized.yMin = filter.yMin;
  if (filter.yMax !== undefined) normalized.yMax = filter.yMax;
  if (filter.boundary !== undefined) normalized.boundary = filter.boundary;
  if (Array.isArray(filter.notAdjacentTo) && filter.notAdjacentTo.length) {
    normalized.notAdjacentTo = [...new Set(filter.notAdjacentTo)].sort((a, b) => a - b);
  }
  return Object.keys(normalized).length ? normalized : null;
}

function isPlainFilter(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).some(key => value[key] !== undefined);
}

function matchingIndices(mesh, element, edges, filter) {
  const excluded = new Set(filter.notAdjacentTo ?? []);
  if (element === 'vertices') {
    const states = vertexAdjacency(mesh, edges);
    const matches = [];
    for (let index = 0; index < states.length; index += 1) {
      const position = tuple(mesh.positions, index, 3);
      if (!positionMatches(position, filter)) continue;
      if (filter.boundary !== undefined && states[index].boundary !== filter.boundary) continue;
      if (excluded.size && (excluded.has(index) || [...states[index].neighbours].some(neighbour => excluded.has(neighbour)))) {
        continue;
      }
      matches.push(index);
    }
    return matches;
  }
  if (element === 'edges') {
    const matches = [];
    for (let index = 0; index < edges.length; index += 1) {
      const edge = edges[index];
      const midpoint = centroid(edge.vertices.map(vertexIndex => tuple(mesh.positions, vertexIndex, 3)));
      if (!positionMatches(midpoint, filter)) continue;
      if (filter.boundary !== undefined && (edge.faces.length === 1) !== filter.boundary) continue;
      if (excluded.size && edge.vertices.some(vertexIndex => excluded.has(vertexIndex))) continue;
      matches.push(index);
    }
    return matches;
  }
  if (element === 'faces') {
    const faceCount = mesh.faceOffsets.length - 1;
    const matches = [];
    for (let faceIndex = 0; faceIndex < faceCount; faceIndex += 1) {
      const start = mesh.faceOffsets[faceIndex];
      const end = mesh.faceOffsets[faceIndex + 1];
      const vertices = mesh.cornerVertexIndices.slice(start, end);
      const center = centroid(vertices.map(vertexIndex => tuple(mesh.positions, vertexIndex, 3)));
      if (!positionMatches(center, filter)) continue;
      if (filter.boundary !== undefined) {
        const boundary = vertices.some((vertex, local) => {
          const next = vertices[(local + 1) % vertices.length];
          const edge = edges.find(entry => entry.key === edgeKey(vertex, next));
          return edge?.faces.length === 1;
        });
        if (boundary !== filter.boundary) continue;
      }
      if (excluded.size && vertices.some(vertexIndex => excluded.has(vertexIndex))) continue;
      matches.push(faceIndex);
    }
    return matches;
  }
  const matches = [];
  for (let cornerIndex = 0; cornerIndex < mesh.cornerVertexIndices.length; cornerIndex += 1) {
    const vertexIndex = mesh.cornerVertexIndices[cornerIndex];
    if (!positionMatches(tuple(mesh.positions, vertexIndex, 3), filter)) continue;
    if (excluded.has(vertexIndex)) continue;
    if (filter.boundary !== undefined) {
      const states = vertexAdjacency(mesh, edges ?? deriveEdges(mesh));
      if (states[vertexIndex].boundary !== filter.boundary) continue;
    }
    matches.push(cornerIndex);
  }
  return matches;
}

function parseMeshCursor(cursor, resourceHash, topologyHash, element, filterHash) {
  const match = /^([a-f0-9]{64})\.([a-f0-9]{64})\.(vertices|edges|faces|corners)(?:\.([a-f0-9]{64}))?\.(\d+)$/.exec(cursor);
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
  const cursorFilterHash = match[4] ?? null;
  if (cursorFilterHash !== filterHash) {
    throw new StudioError('inspect_cursor_mismatch', 'Mesh cursor was issued for a different meshFilter.', {
      cursorFilterHash,
      requestedFilterHash: filterHash,
    });
  }
  return Number(match[5]);
}

function encodeMeshCursor(resourceHash, topologyHash, element, filterHash, offset) {
  return filterHash
    ? `${resourceHash}.${topologyHash}.${element}.${filterHash}.${offset}`
    : `${resourceHash}.${topologyHash}.${element}.${offset}`;
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
  meshFilter,
  responseByteBudget = MAX_INSPECT_RESPONSE_BYTES,
} = {}) {
  if (!MESH_ELEMENT_KINDS.includes(element)) {
    throw new StudioError('mesh_element_kind_invalid', `Unknown mesh element kind ${element}.`);
  }
  const mesh = recipeFrom(resource);
  const resourceHash = contentHash(resource);
  const topologyHash = mesh.topologyHash;
  const filter = normalizeMeshFilter(meshFilter);
  const filterHash = filter ? contentHash(filter) : null;
  const offset = cursor === undefined
    ? 0
    : parseMeshCursor(cursor, resourceHash, topologyHash, element, filterHash);
  const boundedLimit = Math.min(MAX_MESH_ELEMENTS_PER_PAGE, Math.max(1, limit));
  const edges = ['vertices', 'edges'].includes(element) || filter ? deriveEdges(mesh) : null;
  const indexList = filter
    ? matchingIndices(mesh, element, edges, filter)
    : Array.from({ length: elementCount(mesh, element, edges?.length) }, (_, index) => index);
  const total = indexList.length;
  const pageIndices = indexList.slice(offset, offset + boundedLimit);
  let elements;
  if (element === 'vertices') elements = vertexPage(mesh, edges, pageIndices);
  else if (element === 'edges') elements = edgePage(mesh, edges, pageIndices);
  else if (element === 'faces') elements = facePage(mesh, pageIndices);
  else elements = cornerPage(mesh, pageIndices);

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
    ...(filter ? { meshFilter: filter, filterHash, matchedCount: total } : {}),
    responseByteBudget,
  };
  const accepted = [];
  for (const record of elements) {
    const candidateNextOffset = offset + accepted.length + 1;
    const candidate = {
      ...base,
      elements: [...accepted, record],
      nextCursor: candidateNextOffset < total
        ? encodeMeshCursor(resourceHash, topologyHash, element, filterHash, candidateNextOffset)
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
    nextCursor: nextOffset < total
      ? encodeMeshCursor(resourceHash, topologyHash, element, filterHash, nextOffset)
      : null,
    truncatedByByteBudget: accepted.length < elements.length,
  };
}
