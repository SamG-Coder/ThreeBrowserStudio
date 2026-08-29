import { MAX_INSPECT_RESPONSE_BYTES } from '../core/constants.mjs';
import { StudioError } from '../core/errors.mjs';
import { contentHash, isPlainRecord, stableStringify } from '../core/util.mjs';
import { getGraphNode } from './catalogs.mjs';
import { GRAPH_SOCKET_CONTRACT, describeSocketLiveness } from './live-sockets.mjs';
import { validateGraph } from './validator.mjs';

const ENCODER = new TextEncoder();
const CURSOR_VERSION = 1;
const MINIMUM_RESPONSE_BYTES = 1024;
const DEFAULT_NODE_LIMIT = 50;
const DEFAULT_EDGE_LIMIT = 100;
const MAX_DIAGNOSTIC_ITEMS = 16;
const MAX_COMPACT_DEPTH = 4;
const MAX_COMPACT_KEYS = 16;
const MAX_COMPACT_ARRAY_ITEMS = 32;
const MAX_COMPACT_VALUES = 256;
const MAX_COMPACT_STRING = 240;

function compareText(first, second) {
  return first < second ? -1 : first > second ? 1 : 0;
}

function serializedBytes(value) {
  return ENCODER.encode(JSON.stringify(value)).byteLength;
}

function finiteInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new StudioError('graph_digest_invalid_options', `Expected an integer from ${minimum} to ${maximum}.`, {
      value,
      minimum,
      maximum,
    });
  }
  return value;
}

function compactString(value, maximum = MAX_COMPACT_STRING) {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum - 1)}\u2026`;
}

/**
 * Preserves small authored values while replacing large or deeply nested values
 * with deterministic summaries. In particular, inspection can never echo a
 * full texture payload, lookup table, or other pathological parameter array.
 */
function compactValue(value, state, depth = 0) {
  if (state.remaining <= 0) return { truncated: true };
  state.remaining -= 1;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return compactString(value);
  if (Array.isArray(value)) {
    if (depth >= MAX_COMPACT_DEPTH || value.length > MAX_COMPACT_ARRAY_ITEMS) {
      return {
        kind: 'array',
        length: value.length,
        sample: value.slice(0, Math.min(3, value.length)).map(item => compactValue(item, state, depth + 1)),
        contentHash: contentHash(value),
      };
    }
    return value.map(item => compactValue(item, state, depth + 1));
  }
  if (!isPlainRecord(value)) return compactString(String(value));
  const keys = Object.keys(value).sort(compareText);
  if (depth >= MAX_COMPACT_DEPTH) {
    return { kind: 'object', keyCount: keys.length, contentHash: contentHash(value), truncated: keys.length > 0 };
  }
  const result = {};
  const includedKeys = keys.slice(0, MAX_COMPACT_KEYS);
  for (const key of includedKeys) {
    if (state.remaining <= 0) break;
    result[key] = compactValue(value[key], state, depth + 1);
  }
  const represented = Object.keys(result).length;
  if (represented < keys.length) {
    result.$summary = {
      keyCount: keys.length,
      omittedKeyCount: keys.length - represented,
      contentHash: contentHash(value),
    };
  }
  return result;
}

function compactSlice(value, remaining = MAX_COMPACT_VALUES) {
  return compactValue(value, { remaining });
}

function compactDiagnostic(item) {
  const result = {
    severity: item.severity ?? 'warning',
    code: compactString(String(item.code ?? 'warning'), 96),
    message: compactString(String(item.message ?? ''), 240),
    path: compactString(String(item.path ?? ''), 240),
  };
  for (const key of ['nodeId', 'port', 'parentFrameId']) {
    if (typeof item[key] === 'string') result[key] = compactString(item[key], 128);
  }
  return result;
}

function valuesEqual(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function incomingEdgesByPort(edges, nodeId) {
  const incoming = new Map();
  for (const edge of edges) {
    if (edge?.to?.nodeId !== nodeId) continue;
    incoming.set(edge.to.port, {
      nodeId: compactString(String(edge.from?.nodeId ?? ''), 128),
      port: compactString(String(edge.from?.port ?? ''), 96),
    });
  }
  return incoming;
}

/**
 * Full catalog socket contract. `inputs.$summary.omittedKeyCount` is display
 * truncation from compactValue, not missing sockets.
 */
function describeNodeSockets(node, domain, edges) {
  const definition = getGraphNode(domain, node.type);
  if (!definition) return undefined;
  const incoming = incomingEdgesByPort(edges, node.id);
  const sockets = Object.entries(definition.inputs).map(([port, spec]) => {
    const hasValue = Object.hasOwn(node.inputs ?? {}, port);
    const value = hasValue ? node.inputs[port] : undefined;
    const hasDefault = Object.hasOwn(spec, 'default');
    const connected = incoming.has(port);
    let source = 'default';
    if (connected) source = 'edge';
    else if (hasValue && (!hasDefault || !valuesEqual(value, spec.default))) source = 'authored';
    const liveness = describeSocketLiveness(node, domain, port, incoming);
    return {
      port,
      type: spec.type,
      source,
      connected,
      compiled: liveness.compiled,
      live: liveness.live,
      ...(liveness.reason ? { liveReason: liveness.reason } : {}),
      ...(connected ? { from: incoming.get(port) } : {}),
      ...(hasValue ? { value: compactSlice(value, 8) } : {}),
      ...(hasDefault ? { default: compactSlice(spec.default, 8) } : {}),
    };
  });
  return {
    sockets,
    authoredCount: sockets.filter(socket => socket.source === 'authored').length,
    defaultCount: sockets.filter(socket => socket.source === 'default').length,
    connectedCount: sockets.filter(socket => socket.source === 'edge').length,
  };
}

function compactNode(node, domain, edges) {
  const socketTruth = describeNodeSockets(node, domain, edges);
  return {
    id: compactString(String(node.id ?? ''), 128),
    type: compactString(String(node.type ?? ''), 128),
    ...(isPlainRecord(node.params) ? { params: compactSlice(node.params) } : {}),
    ...(isPlainRecord(node.inputs) ? { inputs: compactSlice(node.inputs) } : {}),
    ...(socketTruth ? socketTruth : {}),
    ...(isPlainRecord(node.layout) ? { layout: compactSlice(node.layout, 32) } : {}),
  };
}

function compactNodeFallback(node) {
  return {
    id: compactString(String(node.id ?? ''), 128),
    type: compactString(String(node.type ?? ''), 128),
    ...(isPlainRecord(node.params) ? { paramsHash: contentHash(node.params) } : {}),
    ...(isPlainRecord(node.inputs) ? { inputsHash: contentHash(node.inputs) } : {}),
    ...(isPlainRecord(node.layout) ? { layoutHash: contentHash(node.layout) } : {}),
    truncated: true,
  };
}

function compactEdge(edge) {
  return {
    from: {
      nodeId: compactString(String(edge?.from?.nodeId ?? ''), 128),
      port: compactString(String(edge?.from?.port ?? ''), 96),
    },
    to: {
      nodeId: compactString(String(edge?.to?.nodeId ?? ''), 128),
      port: compactString(String(edge?.to?.port ?? ''), 96),
    },
  };
}

function edgeKey(edge) {
  return `${edge?.from?.nodeId ?? ''}\u0000${edge?.from?.port ?? ''}\u0000${edge?.to?.nodeId ?? ''}\u0000${edge?.to?.port ?? ''}`;
}

function encodeCursor(graphHash, nodeOffset, edgeOffset) {
  const body = JSON.stringify({ v: CURSOR_VERSION, h: graphHash, n: nodeOffset, e: edgeOffset });
  return Buffer.from(body, 'utf8').toString('base64url');
}

function decodeCursor(cursor, graphHash, nodeCount, edgeCount) {
  if (cursor === undefined || cursor === null || cursor === '') return { nodeOffset: 0, edgeOffset: 0 };
  if (typeof cursor !== 'string' || cursor.length > 1024) {
    throw new StudioError('graph_digest_cursor_invalid', 'Graph digest cursor must be a bounded string.');
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new StudioError('graph_digest_cursor_invalid', 'Graph digest cursor is malformed.');
  }
  if (!isPlainRecord(decoded)
    || decoded.v !== CURSOR_VERSION
    || typeof decoded.h !== 'string'
    || !Number.isSafeInteger(decoded.n)
    || !Number.isSafeInteger(decoded.e)
    || decoded.n < 0
    || decoded.e < 0
    || decoded.n > nodeCount
    || decoded.e > edgeCount) {
    throw new StudioError('graph_digest_cursor_invalid', 'Graph digest cursor is malformed.');
  }
  if (decoded.h !== graphHash) {
    throw new StudioError('graph_digest_cursor_stale', 'Graph digest cursor no longer matches the graph content.', {
      expectedGraphHash: decoded.h,
      actualGraphHash: graphHash,
    });
  }
  return { nodeOffset: decoded.n, edgeOffset: decoded.e };
}

function graphFromResource(resourceOrGraph) {
  if (!isPlainRecord(resourceOrGraph)) {
    throw new StudioError('graph_digest_invalid_resource', 'Graph digest input must be a graph or graph resource object.');
  }
  if (isPlainRecord(resourceOrGraph.graph)) return resourceOrGraph.graph;
  return resourceOrGraph;
}

function sourceIdentity(resourceOrGraph, graph) {
  return {
    id: typeof graph.id === 'string' ? compactString(graph.id, 128) : null,
    resourceId: typeof resourceOrGraph.id === 'string' ? compactString(resourceOrGraph.id, 128) : null,
  };
}

function withPagingCursor(result, graphHash, nodeOffset, edgeOffset, nodeCount, edgeCount) {
  return {
    ...result,
    nextCursor: nodeOffset < nodeCount || edgeOffset < edgeCount
      ? encodeCursor(graphHash, nodeOffset, edgeOffset)
      : null,
  };
}

/**
 * Build a deterministic, read-only and byte-bounded digest for a canonical
 * graph or graph resource. Pages remain tied to the exact graph hash so a
 * cursor can never silently continue across a graph edit.
 */
export function buildGraphDigest(resourceOrGraph, options = {}) {
  const graph = graphFromResource(resourceOrGraph);
  const resourceHash = contentHash(resourceOrGraph);
  const validation = validateGraph(graph);
  const inspectedGraph = validation.graph ?? graph;
  const graphHash = contentHash(inspectedGraph);
  const nodes = (Array.isArray(inspectedGraph.nodes) ? inspectedGraph.nodes : [])
    .filter(isPlainRecord)
    .slice()
    .sort((first, second) => compareText(String(first.id ?? ''), String(second.id ?? '')));
  const edges = (Array.isArray(inspectedGraph.edges) ? inspectedGraph.edges : [])
    .filter(isPlainRecord)
    .slice()
    .sort((first, second) => compareText(edgeKey(first), edgeKey(second)));
  const nodeLimit = finiteInteger(options.nodeLimit, DEFAULT_NODE_LIMIT, 0, 256);
  const edgeLimit = finiteInteger(options.edgeLimit, DEFAULT_EDGE_LIMIT, 0, 1024);
  if (nodeLimit === 0 && edgeLimit === 0) {
    throw new StudioError('graph_digest_invalid_options', 'At least one of nodeLimit or edgeLimit must be greater than zero.');
  }
  const responseByteBudget = Math.min(
    MAX_INSPECT_RESPONSE_BYTES,
    finiteInteger(options.maxResponseBytes, MAX_INSPECT_RESPONSE_BYTES, MINIMUM_RESPONSE_BYTES, MAX_INSPECT_RESPONSE_BYTES),
  );
  const cursorOffsets = decodeCursor(options.cursor, graphHash, nodes.length, edges.length);
  // A zero limit explicitly excludes that slice from this paging stream. Mark
  // it complete so node-only and edge-only inspection can terminate cleanly.
  const nodeOffset = nodeLimit === 0 ? nodes.length : cursorOffsets.nodeOffset;
  const edgeOffset = edgeLimit === 0 ? edges.length : cursorOffsets.edgeOffset;
  const identity = sourceIdentity(resourceOrGraph, graph);
  let result = {
    ...identity,
    resourceHash,
    graphHash,
    domain: typeof inspectedGraph.domain === 'string' ? inspectedGraph.domain : null,
    socketContract: GRAPH_SOCKET_CONTRACT,
    validation: {
      valid: validation.valid,
      metrics: validation.metrics,
      warningCount: validation.warnings.length,
      warnings: [],
      errorCount: validation.errors.length,
      errors: [],
    },
    outputs: compactSlice(isPlainRecord(inspectedGraph.outputs) ? inspectedGraph.outputs : {}, 48),
    ...(inspectedGraph.settings === undefined ? {} : { settings: compactSlice(inspectedGraph.settings, 48) }),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    page: {
      nodeOffset,
      edgeOffset,
      nodeLimit,
      edgeLimit,
    },
    nodes: [],
    edges: [],
    responseByteBudget,
  };

  let nextNodeOffset = nodeOffset;
  let nextEdgeOffset = edgeOffset;
  const responseCandidate = (candidate) => {
    const enriched = structuredClone(candidate);
    enriched.validation.warningsTruncated = enriched.validation.warnings.length < validation.warnings.length;
    enriched.validation.errorsTruncated = enriched.validation.errors.length < validation.errors.length;
    enriched.page.returnedNodeCount = enriched.nodes.length;
    enriched.page.returnedEdgeCount = enriched.edges.length;
    enriched.estimatedResponseBytes = responseByteBudget;
    return withPagingCursor(
      enriched,
      graphHash,
      nextNodeOffset,
      nextEdgeOffset,
      nodes.length,
      edges.length,
    );
  };
  const fits = candidate => serializedBytes(responseCandidate(candidate)) <= responseByteBudget;

  for (const error of validation.errors.slice(0, MAX_DIAGNOSTIC_ITEMS)) {
    const candidate = structuredClone(result);
    candidate.validation.errors.push(compactDiagnostic(error));
    if (!fits(candidate)) break;
    result = candidate;
  }
  for (const warning of validation.warnings.slice(0, MAX_DIAGNOSTIC_ITEMS)) {
    const candidate = structuredClone(result);
    candidate.validation.warnings.push(compactDiagnostic(warning));
    if (!fits(candidate)) break;
    result = candidate;
  }

  const nodeEnd = Math.min(nodes.length, nodeOffset + nodeLimit);
  for (let index = nodeOffset; index < nodeEnd; index += 1) {
    const full = compactNode(nodes[index], inspectedGraph.domain, edges);
    let candidate = structuredClone(result);
    candidate.nodes.push(full);
    nextNodeOffset = index + 1;
    if (!fits(candidate)) {
      candidate = structuredClone(result);
      candidate.nodes.push(compactNodeFallback(nodes[index]));
      if (!fits(candidate)) {
        nextNodeOffset = index;
        break;
      }
    }
    result = candidate;
  }

  const edgeEnd = Math.min(edges.length, edgeOffset + edgeLimit);
  for (let index = edgeOffset; index < edgeEnd; index += 1) {
    const candidate = structuredClone(result);
    candidate.edges.push(compactEdge(edges[index]));
    nextEdgeOffset = index + 1;
    if (!fits(candidate)) {
      nextEdgeOffset = index;
      break;
    }
    result = candidate;
  }

  if (nextNodeOffset === nodeOffset && nextEdgeOffset === edgeOffset
    && (nodeOffset < nodes.length || edgeOffset < edges.length)) {
    throw new StudioError('graph_digest_response_budget_too_small', 'Graph digest response budget cannot fit one compact graph item.', {
      responseByteBudget,
    });
  }
  result = responseCandidate(result);
  result.estimatedResponseBytes = serializedBytes(result);
  // Adding the byte count can cross a digit boundary. Recalculate to a fixed
  // point, then assert the public invariant rather than returning an oversize
  // response silently.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = serializedBytes(result);
    if (result.estimatedResponseBytes === actual) break;
    result.estimatedResponseBytes = actual;
  }
  if (serializedBytes(result) > responseByteBudget) {
    throw new StudioError('graph_digest_response_budget_too_small', 'Graph digest response budget is too small for its fixed metadata.', {
      responseByteBudget,
    });
  }
  return result;
}
