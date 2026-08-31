import { applyGraphNodeInputs } from './documents.mjs';
import { isPlainRecord, stableStringify } from './util.mjs';
import { getGraphNode } from '../graphs/catalogs.mjs';
import {
  bumpEffectiveScale,
  canonicalGraphNodeType,
  describeSocketLiveness,
  isBelowPixelQuantum,
} from '../graphs/live-sockets.mjs';

const VISUAL_OPERATIONS = new Set([
  'entity.create', 'entity.delete', 'entity.duplicate', 'entity.reparent',
  'entity.patch', 'entity.patchMany', 'entity.transformMany', 'entity.group', 'entity.ungroup',
  'geometry.edit',
  'modifier.create', 'modifier.patch', 'modifier.move', 'modifier.delete', 'modifier.stack.edit',
  'scene.create', 'scene.delete', 'scene.clear', 'scene.setActive', 'scene.settings.patch', 'scene.rtx.patch',
  'scene.setActiveCamera',
  'camera.frame', 'layout.pattern',
  'resource.create', 'resource.createMany', 'resource.delete',
  'geometry.put', 'geometry.delete',
  'material.put', 'material.delete',
  'texture.put', 'texture.delete',
  'graph.put', 'graph.delete',
  'animation.put', 'animation.delete',
]);

const METADATA_OPERATIONS = new Set([
  'collection.create', 'collection.patch', 'collection.membership.patch',
  'collection.reparent', 'collection.delete',
]);

function valuesEqual(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function operationType(operation) {
  return operation?.type ?? operation?.op ?? null;
}

function incomingPorts(edges, nodeId) {
  const incoming = new Set();
  for (const edge of edges ?? []) {
    if (edge?.to?.nodeId === nodeId && typeof edge.to.port === 'string') incoming.add(edge.to.port);
  }
  return incoming;
}

function resourceOf(document, resourceId) {
  const tables = document?.resources ?? {};
  for (const table of Object.values(tables)) {
    if (table?.[resourceId]) return table[resourceId];
  }
  return null;
}

function graphsFromOperation(before, operation) {
  const resourceId = operation.resourceId;
  if (typeof resourceId !== 'string') return null;
  const resourceType = operation.resourceType;
  if (resourceType && resourceType !== 'graphs' && resourceType !== 'graph') return null;
  const beforeResource = before?.resources?.graphs?.[resourceId] ?? resourceOf(before, resourceId);
  const beforeGraph = beforeResource?.graph;
  if (isPlainRecord(operation.patch?.graph)) {
    return { resourceId, beforeGraph, afterGraph: operation.patch.graph };
  }
  if (isPlainRecord(operation.patch?.nodeInputs) && isPlainRecord(beforeGraph)) {
    return {
      resourceId,
      beforeGraph,
      afterGraph: applyGraphNodeInputs(beforeGraph, operation.patch.nodeInputs),
    };
  }
  return null;
}

function forecastBumpScale(beforeNode, afterNode, port, afterValue) {
  const beforeStrength = beforeNode?.inputs?.strength ?? 1;
  const beforeDistance = beforeNode?.inputs?.distance ?? 0.001;
  const afterStrength = port === 'strength' ? afterValue : (afterNode?.inputs?.strength ?? beforeStrength);
  const afterDistance = port === 'distance' ? afterValue : (afterNode?.inputs?.distance ?? beforeDistance);
  const beforeScale = bumpEffectiveScale(beforeStrength, beforeDistance);
  const afterScale = bumpEffectiveScale(afterStrength, afterDistance);
  if (isBelowPixelQuantum(beforeScale) && isBelowPixelQuantum(afterScale)) {
    return { verdict: 'will-not-move', reason: 'below-8bit' };
  }
  return null;
}

function forecastChangedSocket(resourceId, domain, beforeNode, afterNode, port, incoming) {
  const liveness = describeSocketLiveness(afterNode, domain, port, incoming);
  const beforeValue = beforeNode?.inputs?.[port];
  const afterValue = afterNode?.inputs?.[port];
  const base = {
    resourceId,
    nodeId: afterNode.id,
    port,
    compiled: liveness.compiled,
    live: liveness.live,
  };
  if (!liveness.compiled || !liveness.live) {
    return { ...base, verdict: 'will-not-move', reason: liveness.reason };
  }
  const canonical = canonicalGraphNodeType(domain, afterNode.type);
  if (canonical === 'blender.bump' && (port === 'strength' || port === 'distance')) {
    const bump = forecastBumpScale(beforeNode, afterNode, port, afterValue);
    if (bump) return { ...base, ...bump };
  }
  if (valuesEqual(beforeValue, afterValue)) {
    return { ...base, verdict: 'will-not-move', reason: 'unchanged' };
  }
  return { ...base, verdict: 'will-move', reason: 'live-delta' };
}

function diffGraphSockets(resourceId, beforeGraph, afterGraph) {
  if (!isPlainRecord(beforeGraph) || !isPlainRecord(afterGraph)) {
    return [{ resourceId, nodeId: null, port: '*', live: true, compiled: true, verdict: 'will-move', reason: 'graph-replaced' }];
  }
  const domain = afterGraph.domain ?? beforeGraph.domain;
  const beforeById = new Map((beforeGraph.nodes ?? []).filter(isPlainRecord).map(node => [node.id, node]));
  const afterById = new Map((afterGraph.nodes ?? []).filter(isPlainRecord).map(node => [node.id, node]));
  const sockets = [];
  if (beforeById.size !== afterById.size || (beforeGraph.edges?.length ?? 0) !== (afterGraph.edges?.length ?? 0)) {
    sockets.push({
      resourceId,
      nodeId: null,
      port: '*',
      live: true,
      compiled: true,
      verdict: 'will-move',
      reason: 'graph-topology',
    });
  }
  for (const [nodeId, afterNode] of afterById) {
    const beforeNode = beforeById.get(nodeId);
    if (!beforeNode) {
      sockets.push({
        resourceId,
        nodeId,
        port: '*',
        live: true,
        compiled: true,
        verdict: 'will-move',
        reason: 'node-added',
      });
      continue;
    }
    const definition = getGraphNode(domain, afterNode.type);
    if (!definition) continue;
    const incoming = incomingPorts(afterGraph.edges, nodeId);
    const beforeIncoming = incomingPorts(beforeGraph.edges, nodeId);
    for (const port of Object.keys(definition.inputs)) {
      const valueChanged = !valuesEqual(beforeNode.inputs?.[port], afterNode.inputs?.[port]);
      const edgeChanged = incoming.has(port) !== beforeIncoming.has(port);
      if (!valueChanged && !edgeChanged) continue;
      sockets.push(forecastChangedSocket(resourceId, domain, beforeNode, afterNode, port, incoming));
    }
  }
  return sockets;
}

function forecastOperation(before, operation) {
  const type = operationType(operation);
  const sockets = [];
  const reasons = [];
  const graphs = graphsFromOperation(before, operation);
  if (graphs) {
    sockets.push(...diffGraphSockets(graphs.resourceId, graphs.beforeGraph, graphs.afterGraph));
    if (sockets.length === 0) {
      reasons.push({ code: 'graph-unchanged', operation: type, verdict: 'will-not-move' });
    }
    return { sockets, reasons };
  }
  if (type === 'resource.patch') {
    const resourceType = operation.resourceType;
    if (['materials', 'material', 'geometries', 'geometry', 'textures', 'texture', 'animations', 'animation'].includes(resourceType)) {
      reasons.push({ code: 'visual-resource-patch', operation: type, verdict: 'will-move' });
    } else {
      reasons.push({ code: 'unclassified-resource-patch', operation: type, verdict: 'unknown' });
    }
    return { sockets, reasons };
  }
  if (type === 'geometry.edit') {
    const edits = Array.isArray(operation.edits) ? operation.edits : [];
    if (edits.length > 0 && edits.every(edit => edit?.type === 'recalculateNormals')) {
      reasons.push({ code: 'derived-normals-noop', operation: type, verdict: 'will-not-move' });
      return { sockets, reasons };
    }
  }
  if (VISUAL_OPERATIONS.has(type)) {
    reasons.push({ code: 'visual-operation', operation: type, verdict: 'will-move' });
    return { sockets, reasons };
  }
  if (METADATA_OPERATIONS.has(type)) {
    reasons.push({ code: 'metadata-only', operation: type, verdict: 'will-not-move' });
    return { sockets, reasons };
  }
  reasons.push({ code: 'unclassified', operation: type, verdict: 'unknown' });
  return { sockets, reasons };
}

function aggregateVerdict(sockets, reasons) {
  const verdicts = [...sockets.map(item => item.verdict), ...reasons.map(item => item.verdict)];
  if (verdicts.includes('will-move')) return 'will-move';
  if (verdicts.length === 0) return 'unknown';
  if (verdicts.every(verdict => verdict === 'will-not-move')) return 'will-not-move';
  return 'unknown';
}

/**
 * Document-level forecast of whether an apply will change 8-bit beauty pixels.
 * Socket liveness is the same contract as graphDigest / TSL compile.
 */
export function forecastPixelImpact({ before, operations } = {}) {
  const sockets = [];
  const reasons = [];
  for (const operation of operations ?? []) {
    const forecast = forecastOperation(before, operation);
    sockets.push(...forecast.sockets);
    reasons.push(...forecast.reasons);
  }
  return {
    verdict: aggregateVerdict(sockets, reasons),
    reasons,
    sockets,
  };
}
