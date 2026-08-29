import { MAX_INSPECT_RESPONSE_BYTES } from './constants.mjs';
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

function recipeFrom(resource) {
  const recipe = resource?.recipe ?? resource?.parameters ?? resource;
  const kind = recipe?.kind ?? recipe?.type ?? resource?.geometryKind;
  if (!['indexedMesh', 'explicit'].includes(kind)) {
    throw new StudioError(
      'mesh_elements_unavailable',
      `Mesh elements require an authored indexedMesh or explicit recipe; ${resource?.id ?? 'resource'} uses ${kind ?? 'unknown'}.`,
      { resourceId: resource?.id ?? null, recipeKind: kind ?? null },
    );
  }
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
    positions,
    indices,
    normals: recipe.normals ?? recipe.attributes?.normal,
    uvs: recipe.uvs ?? recipe.attributes?.uv,
    colors: recipe.colors ?? recipe.attributes?.color,
  };
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

function vertexAttributes(mesh, vertexIndex, stride) {
  return {
    position: tuple(mesh.positions, vertexIndex, 3),
    ...(tuple(mesh.normals, vertexIndex, 3) ? { normal: tuple(mesh.normals, vertexIndex, 3) } : {}),
    ...(tuple(mesh.uvs, vertexIndex, 2) ? { uv: tuple(mesh.uvs, vertexIndex, 2) } : {}),
    ...(stride ? { color: tuple(mesh.colors, vertexIndex, stride) } : {}),
  };
}

function addEdge(edgeMap, first, second, faceIndex) {
  if (first === second) return;
  const vertices = first < second ? [first, second] : [second, first];
  const key = `${vertices[0]}:${vertices[1]}`;
  let edge = edgeMap.get(key);
  if (!edge) {
    if (edgeMap.size >= MAX_DERIVED_EDGES) {
      throw new StudioError('mesh_inspect_budget_exceeded', `Derived edge count exceeds ${MAX_DERIVED_EDGES}.`);
    }
    edge = { vertices, faces: [] };
    edgeMap.set(key, edge);
  }
  edge.faces.push(faceIndex);
}

function deriveEdges(indices) {
  const edges = new Map();
  for (let offset = 0; offset < indices.length; offset += 3) {
    const faceIndex = offset / 3;
    const [a, b, c] = indices.slice(offset, offset + 3);
    addEdge(edges, a, b, faceIndex);
    addEdge(edges, b, c, faceIndex);
    addEdge(edges, c, a, faceIndex);
  }
  return [...edges.values()].sort((first, second) => (
    first.vertices[0] - second.vertices[0] || first.vertices[1] - second.vertices[1]
  ));
}

function vertexPage(mesh, offset, limit) {
  const end = Math.min(mesh.positions.length / 3, offset + limit);
  const selected = new Map();
  for (let index = offset; index < end; index += 1) {
    selected.set(index, { neighbours: new Map(), faces: [] });
  }
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const faceIndex = index / 3;
    const face = mesh.indices.slice(index, index + 3);
    for (let corner = 0; corner < 3; corner += 1) {
      const vertexIndex = face[corner];
      const state = selected.get(vertexIndex);
      if (!state) continue;
      state.faces.push(faceIndex);
      for (const neighbour of [face[(corner + 1) % 3], face[(corner + 2) % 3]]) {
        state.neighbours.set(neighbour, (state.neighbours.get(neighbour) ?? 0) + 1);
      }
    }
  }
  const stride = colorStride(mesh.colors, mesh.positions.length / 3);
  return [...selected].map(([index, state]) => {
    const adjacentVertices = [...state.neighbours.keys()].sort((a, b) => a - b);
    return {
      index,
      ...vertexAttributes(mesh, index, stride),
      adjacentVertexCount: adjacentVertices.length,
      adjacentVertices: adjacentVertices.slice(0, MAX_ADJACENCY_PER_ELEMENT),
      incidentFaceCount: state.faces.length,
      incidentFaces: state.faces.slice(0, MAX_ADJACENCY_PER_ELEMENT),
      boundary: [...state.neighbours.values()].some(count => count === 1),
      truncatedAdjacency: adjacentVertices.length > MAX_ADJACENCY_PER_ELEMENT
        || state.faces.length > MAX_ADJACENCY_PER_ELEMENT,
    };
  });
}

function facePage(mesh, offset, limit) {
  const triangleCount = mesh.indices.length / 3;
  const stride = colorStride(mesh.colors, mesh.positions.length / 3);
  const records = [];
  for (let faceIndex = offset; faceIndex < Math.min(triangleCount, offset + limit); faceIndex += 1) {
    const vertices = mesh.indices.slice(faceIndex * 3, faceIndex * 3 + 3);
    records.push({
      index: faceIndex,
      vertices,
      corners: vertices.map(vertexIndex => vertexAttributes(mesh, vertexIndex, stride)),
    });
  }
  return records;
}

function cornerPage(mesh, offset, limit) {
  const stride = colorStride(mesh.colors, mesh.positions.length / 3);
  const records = [];
  for (let cornerIndex = offset; cornerIndex < Math.min(mesh.indices.length, offset + limit); cornerIndex += 1) {
    const vertexIndex = mesh.indices[cornerIndex];
    records.push({
      index: cornerIndex,
      faceIndex: Math.floor(cornerIndex / 3),
      faceCorner: cornerIndex % 3,
      vertexIndex,
      ...vertexAttributes(mesh, vertexIndex, stride),
    });
  }
  return records;
}

function elementCount(mesh, element, edgeCount) {
  if (element === 'vertices') return mesh.positions.length / 3;
  if (element === 'faces') return mesh.indices.length / 3;
  if (element === 'corners') return mesh.indices.length;
  return edgeCount;
}

/** Returns one deterministic, exact, byte-bounded page of authored mesh elements. */
export function buildMeshElements(resource, {
  element = 'vertices',
  cursor,
  limit = 50,
  responseByteBudget = MAX_INSPECT_RESPONSE_BYTES,
} = {}) {
  if (!MESH_ELEMENT_KINDS.includes(element)) throw new StudioError('mesh_element_kind_invalid', `Unknown mesh element kind ${element}.`);
  const mesh = recipeFrom(resource);
  const resourceHash = contentHash(resource);
  const topologyHash = contentHash({ vertexCount: mesh.positions.length / 3, indices: mesh.indices });
  let offset = 0;
  if (cursor !== undefined) {
    const match = /^([a-f0-9]{64})\.([a-f0-9]{64})\.(\d+)$/.exec(cursor);
    if (!match) throw new StudioError('inspect_cursor_invalid', 'Mesh cursor is malformed.');
    if (match[1] !== resourceHash || match[2] !== topologyHash) {
      throw new StudioError('inspect_cursor_stale', 'Mesh changed after this cursor was issued.', {
        expectedResourceHash: match[1],
        actualResourceHash: resourceHash,
        expectedTopologyHash: match[2],
        actualTopologyHash: topologyHash,
      });
    }
    offset = Number(match[3]);
  }
  const boundedLimit = Math.min(MAX_MESH_ELEMENTS_PER_PAGE, Math.max(1, limit));
  const edges = element === 'edges' ? deriveEdges(mesh.indices) : null;
  const total = elementCount(mesh, element, edges?.length);
  let elements;
  if (element === 'vertices') elements = vertexPage(mesh, offset, boundedLimit);
  else if (element === 'edges') {
    const stride = colorStride(mesh.colors, mesh.positions.length / 3);
    elements = edges.slice(offset, offset + boundedLimit).map((edge, localIndex) => ({
      index: offset + localIndex,
      vertices: edge.vertices,
      endpoints: edge.vertices.map(index => vertexAttributes(mesh, index, stride)),
      incidentFaceCount: edge.faces.length,
      incidentFaces: edge.faces.slice(0, MAX_ADJACENCY_PER_ELEMENT),
      boundary: edge.faces.length === 1,
      nonManifold: edge.faces.length > 2,
      truncatedAdjacency: edge.faces.length > MAX_ADJACENCY_PER_ELEMENT,
    }));
  } else if (element === 'faces') elements = facePage(mesh, offset, boundedLimit);
  else elements = cornerPage(mesh, offset, boundedLimit);

  const base = {
    resourceId: resource.id,
    resourceHash,
    topologyHash,
    recipeKind: mesh.kind,
    vertexCount: mesh.positions.length / 3,
    triangleCount: mesh.indices.length / 3,
    cornerCount: mesh.indices.length,
    ...(edges ? { edgeCount: edges.length } : {}),
    attributes: {
      position: { itemSize: 3, count: mesh.positions.length / 3 },
      ...(Array.isArray(mesh.normals) ? { normal: { itemSize: 3, count: mesh.normals.length / 3 } } : {}),
      ...(Array.isArray(mesh.uvs) ? { uv: { itemSize: 2, count: mesh.uvs.length / 2 } } : {}),
      ...(colorStride(mesh.colors, mesh.positions.length / 3)
        ? { color: { itemSize: colorStride(mesh.colors, mesh.positions.length / 3), count: mesh.positions.length / 3 } }
        : {}),
    },
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
        ? `${resourceHash}.${topologyHash}.${candidateNextOffset}`
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
    nextCursor: nextOffset < total ? `${resourceHash}.${topologyHash}.${nextOffset}` : null,
    truncatedByByteBudget: accepted.length < elements.length,
  };
}
