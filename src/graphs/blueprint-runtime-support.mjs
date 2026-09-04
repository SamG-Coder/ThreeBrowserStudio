import { getGraphNode } from './catalogs.mjs';

/** Exact bounded controller branches, independent from the larger authoring catalog. */
export const LIVE_BLUEPRINT_NODE_TYPES = Object.freeze(new Set([
  'event.onStart', 'event.onActivate', 'event.onDeactivate', 'event.onFixedUpdate', 'event.onUpdate',
  'event.onKeyPressed', 'event.onKeyDown', 'event.onKeyUp', 'event.onCollisionEnter', 'event.onCollisionExit',
  'event.onInput', 'event.onEvent', 'event.payloadNumber', 'event.emit', 'event.emitOnce',
  'flow.branch', 'value.constant', 'value.add', 'value.math', 'value.select', 'compare.values', 'vector.compose', 'vector.component',
  'input.keyHeld', 'state.get', 'state.set', 'entity.self', 'entity.reference', 'component.has',
  'entity.getProperty', 'entity.setProperty', 'transform.set', 'transform.translate', 'transform.rotate',
  'motion.setSpeed', 'motion.getSpeed', 'motion.addSpeed', 'motion.setAngularSpeed',
  'physics.getVelocity', 'physics.setVelocity', 'physics.setAngularVelocity', 'physics.addForce', 'physics.addImpulse', 'physics.setGravityScale',
  'visibility.set', 'animation.play', 'animation.stop', 'audio.play', 'audio.stop',
  'camera.setActive', 'camera.lookAt', 'camera.lookAtEntity', 'camera.followEntity', 'camera.clearFollow', 'camera.setFov',
]));

export function describeBlueprintRuntimeSupport(node, port) {
  const definition = getGraphNode('blueprint', node?.type);
  const compiled = LIVE_BLUEPRINT_NODE_TYPES.has(definition?.canonicalType ?? node?.type);
  if (!compiled) return { compiled: false, live: false, reason: 'catalog-only-controller-node' };
  if (port !== undefined && !Object.hasOwn(definition?.inputs ?? {}, port)) return { compiled: true, live: false, reason: 'unknown-controller-socket' };
  return { compiled: true, live: true, reason: 'live-controller-runtime' };
}

/**
 * Event roots traverse only execution edges. Their reachable actions then pull
 * data ancestors backwards, never unrelated predecessors over execution edges.
 * Branches represent possible runtime paths; key state and values are not run.
 */
export function blueprintReachability(nodes = [], edges = []) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const definitions = new Map(nodes.map(node => [node.id, getGraphNode('blueprint', node.type)]));
  const outgoingExec = new Map();
  const incomingData = new Map();
  for (const edge of edges) {
    const from = edge?.from; const to = edge?.to;
    if (!byId.has(from?.nodeId) || !byId.has(to?.nodeId)) continue;
    const sourcePort = definitions.get(from.nodeId)?.outputs?.[from.port];
    const targetPort = definitions.get(to.nodeId)?.inputs?.[to.port];
    if (!sourcePort || !targetPort) continue;
    if (sourcePort.type === 'exec' && targetPort.type === 'exec') {
      const list = outgoingExec.get(from.nodeId) ?? []; list.push(to.nodeId); outgoingExec.set(from.nodeId, list);
    } else if (sourcePort.type !== 'exec' && targetPort.type !== 'exec') {
      const list = incomingData.get(to.nodeId) ?? []; list.push(from.nodeId); incomingData.set(to.nodeId, list);
    }
  }
  const byEvent = new Map(); const reachable = new Set(); const execution = new Set();
  for (const root of nodes.filter(node => definitions.get(node.id)?.tags?.includes('event-root'))) {
    const flow = new Set(); const pending = [root.id];
    while (pending.length) {
      const id = pending.pop(); if (flow.has(id)) continue;
      flow.add(id); execution.add(id);
      pending.push(...(outgoingExec.get(id) ?? []));
    }
    const used = new Set(flow); pending.push(...flow);
    while (pending.length) {
      const id = pending.pop();
      for (const source of incomingData.get(id) ?? []) if (!used.has(source)) { used.add(source); pending.push(source); }
    }
    byEvent.set(root.id, { nodeIds: used, executionNodeIds: flow });
    for (const id of used) reachable.add(id);
  }
  return { byEvent, reachable, execution };
}
