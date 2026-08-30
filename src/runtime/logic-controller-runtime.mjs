import { createRigidBodyRuntime } from './rigid-body-runtime.mjs';

const FIXED_STEP = 1 / 60;
const MAX_FIXED_STEPS = 8;
const MAX_EXECUTIONS_PER_EVENT = 512;
const MAX_EMITTED_EVENTS = 64;

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const cloneValue = value => value === undefined ? undefined : structuredClone(value);

function keyCode(value) {
  const text = String(value ?? '').trim();
  if (text === ' ') return 'Space';
  return text;
}

function vec3(value, fallback = [0, 0, 0]) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
    ? value
    : fallback;
}

const addVectors = (a, b) => a.map((value, axis) => value + b[axis]);

function rotateLocalYaw(value, object) {
  const [x, y, z] = vec3(value);
  const yaw = finite(object?.rotation?.y);
  const cosine = Math.cos(yaw);
  const sine = Math.sin(yaw);
  return [cosine * x + sine * z, y, -sine * x + cosine * z];
}

function readVector(object, property) {
  const value = object?.[property];
  if (!value) return [0, 0, 0];
  // THREE.Euler#toArray includes its rotation-order string as a fourth item.
  // Read numeric vector fields directly so restoration never rejects a valid
  // nested object's rotation and silently replaces it with zero.
  return [finite(value.x), finite(value.y), finite(value.z)];
}

function writeVector(object, property, value) {
  const target = object?.[property];
  if (!target) return;
  const [x, y, z] = vec3(value);
  if (typeof target.set === 'function') target.set(x, y, z);
  else Object.assign(target, { x, y, z });
}

function snapshotObject(object) {
  return {
    position: readVector(object, 'position'),
    rotation: readVector(object, 'rotation'),
    scale: readVector(object, 'scale'),
    visible: object?.visible !== false,
  };
}

function restoreObject(object, snapshot) {
  if (!object || !snapshot) return;
  writeVector(object, 'position', snapshot.position);
  writeVector(object, 'rotation', snapshot.rotation);
  writeVector(object, 'scale', snapshot.scale);
  object.visible = snapshot.visible;
  object.updateMatrix?.();
  object.updateMatrixWorld?.(true);
}

function normalizeControllerSettings(scene) {
  const source = scene?.settings?.controller;
  if (!source || source.enabled === false || typeof source.entityId !== 'string') return null;
  return Object.freeze({
    entityId: source.entityId,
    activationKey: keyCode(source.activationKey || 'Enter'),
    restoreOnExit: source.restoreOnExit !== false,
    capture: Object.freeze({
      keyboard: source.capture?.keyboard !== false,
      pointer: source.capture?.pointer === true,
      hideHud: source.capture?.hideHud === true,
      hideCursor: source.capture?.hideCursor === true,
    }),
  });
}

function graphResources(project, entity) {
  if (entity?.components?.logic?.enabled === false) return [];
  const ids = entity?.components?.logic?.graphIds ?? [];
  return ids.map(id => project?.resources?.graphs?.[id])
    .filter(resource => resource?.graph?.domain === 'blueprint')
    .map(resource => resource.graph);
}

function makeGraphPlan(graph) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const incoming = new Map();
  const outgoing = new Map();
  for (const edge of graph.edges) {
    const toKey = `${edge.to.nodeId}:${edge.to.port}`;
    incoming.set(toKey, edge.from);
    const fromKey = `${edge.from.nodeId}:${edge.from.port}`;
    const list = outgoing.get(fromKey) ?? [];
    list.push(edge.to);
    outgoing.set(fromKey, list);
  }
  return { graph, nodes, incoming, outgoing };
}

export function createLogicControllerRuntime({ project, scene, objects, animationRuntime, setActiveCamera } = {}) {
  const settings = normalizeControllerSettings(scene);
  const controlledEntity = settings ? scene?.entities?.[settings.entityId] : null;
  const plans = controlledEntity ? graphResources(project, controlledEntity).map(makeGraphPlan) : [];
  const snapshots = new Map();
  const states = new Map();
  const motion = new Map();
  const heldKeys = new Set();
  const diagnostics = [];
  const emitted = [];
  const cameraBehaviors = new Map();
  const physics = createRigidBodyRuntime({ scene, objects });
  let active = false;
  let fixedAccumulator = 0;
  let eventExecutions = 0;

  const entityObject = id => objects?.get?.(id) ?? null;
  const stateFor = selfId => {
    const state = states.get(selfId) ?? new Map();
    states.set(selfId, state);
    return state;
  };
  const motionFor = id => {
    const value = motion.get(id) ?? { speed: 0, angularSpeed: [0, 0, 0] };
    motion.set(id, value);
    return value;
  };

  function dataValue(plan, nodeId, port, context, stack = new Set()) {
    const source = plan.incoming.get(`${nodeId}:${port}`);
    if (!source) return plan.nodes.get(nodeId)?.inputs?.[port];
    const key = `${source.nodeId}:${source.port}`;
    if (stack.has(key)) return undefined;
    stack.add(key);
    const node = plan.nodes.get(source.nodeId);
    let value;
    switch (node?.type) {
      case 'value.constant': value = node.params?.value; break;
      case 'entity.self': value = context.selfId; break;
      case 'entity.reference': value = node.params?.entityId; break;
      case 'component.has': {
        const entityId = dataValue(plan, node.id, 'entity', context, stack);
        value = scene?.entities?.[entityId]?.components?.[node.params?.component] !== undefined;
        break;
      }
      case 'physics.getVelocity': {
        const entityId = dataValue(plan, node.id, 'entity', context, stack);
        value = physics.getVelocity(entityId);
        break;
      }
      case 'state.get': value = stateFor(context.selfId).get(node.params?.key); break;
      case 'entity.getProperty': {
        const entityId = dataValue(plan, node.id, 'entity', context, stack);
        const object = entityObject(entityId);
        value = node.params?.property === 'visible'
          ? object?.visible !== false
          : readVector(object, node.params?.property);
        break;
      }
      case 'event.onFixedUpdate':
      case 'event.onUpdate': value = source.port === 'delta' ? context.delta : undefined; break;
      case 'event.onInput': value = source.port === 'pressed' ? context.pressed : context.value; break;
      case 'event.onEvent': value = context.payload; break;
      case 'event.onCollisionEnter': value = source.port === 'other' ? context.otherId : context.normal; break;
      case 'event.onCollisionExit': value = context.otherId; break;
      default: value = node?.outputs?.[source.port];
    }
    stack.delete(key);
    return cloneValue(value);
  }

  function execTargets(plan, nodeId, port) {
    return (plan.outgoing.get(`${nodeId}:${port}`) ?? []).filter(target => target.port === 'in');
  }

  function executeNode(plan, nodeId, context, queue) {
    const node = plan.nodes.get(nodeId);
    if (!node) return;
    eventExecutions += 1;
    if (eventExecutions > MAX_EXECUTIONS_PER_EVENT) {
      diagnostics.push({ code: 'logic_execution_budget', message: `Logic execution exceeded ${MAX_EXECUTIONS_PER_EVENT} nodes.` });
      return;
    }
    const targetId = dataValue(plan, node.id, 'entity', context) ?? context.selfId;
    const object = entityObject(targetId);
    let outputPort = 'out';
    switch (node.type) {
      case 'flow.branch': outputPort = dataValue(plan, node.id, 'condition', context) === true ? 'true' : 'false'; break;
      case 'state.set': stateFor(context.selfId).set(node.params?.key, cloneValue(dataValue(plan, node.id, 'value', context))); break;
      case 'entity.setProperty': {
        const value = dataValue(plan, node.id, 'value', context);
        if (node.params?.property === 'visible') object.visible = value === true;
        else writeVector(object, node.params?.property, value);
        break;
      }
      case 'transform.set': {
        for (const property of ['position', 'rotation', 'scale']) {
          const value = dataValue(plan, node.id, property, context);
          if (value !== undefined) writeVector(object, property, value);
        }
        break;
      }
      case 'transform.translate': {
        const offset = vec3(dataValue(plan, node.id, 'offset', context));
        if (node.params?.space === 'world') {
          const current = readVector(object, 'position');
          writeVector(object, 'position', current.map((value, axis) => value + offset[axis]));
        } else {
          object?.translateX?.(offset[0]);
          object?.translateY?.(offset[1]);
          object?.translateZ?.(offset[2]);
        }
        break;
      }
      case 'transform.rotate': {
        const radians = vec3(dataValue(plan, node.id, 'radians', context));
        if (node.params?.space === 'world') {
          const current = readVector(object, 'rotation');
          writeVector(object, 'rotation', current.map((value, axis) => value + radians[axis]));
        } else {
          object?.rotateX?.(radians[0]);
          object?.rotateY?.(radians[1]);
          object?.rotateZ?.(radians[2]);
        }
        break;
      }
      case 'visibility.set': if (object) object.visible = dataValue(plan, node.id, 'visible', context) === true; break;
      case 'motion.setSpeed': motionFor(targetId).speed = finite(dataValue(plan, node.id, 'speed', context)); break;
      case 'motion.addSpeed': motionFor(targetId).speed += finite(dataValue(plan, node.id, 'speed', context)); break;
      case 'motion.setAngularSpeed': motionFor(targetId).angularSpeed = vec3(dataValue(plan, node.id, 'radiansPerSecond', context)); break;
      case 'physics.setVelocity': physics.setVelocity(targetId, dataValue(plan, node.id, 'velocity', context)); break;
      case 'physics.setAngularVelocity': physics.setAngularVelocity(targetId, dataValue(plan, node.id, 'velocity', context)); break;
      case 'physics.addForce': {
        const force = dataValue(plan, node.id, 'force', context);
        physics.addForce(targetId, node.params?.space === 'local' ? rotateLocalYaw(force, object) : force);
        break;
      }
      case 'physics.addImpulse': {
        const impulse = dataValue(plan, node.id, 'impulse', context);
        physics.addImpulse(targetId, node.params?.space === 'local' ? rotateLocalYaw(impulse, object) : impulse);
        break;
      }
      case 'physics.applyBrake': physics.applyBrake(targetId, finite(dataValue(plan, node.id, 'deceleration', context))); break;
      case 'physics.setSteering': physics.setSteering(targetId, finite(dataValue(plan, node.id, 'angle', context))); break;
      case 'physics.setGravityScale': physics.setGravityScale(targetId, finite(dataValue(plan, node.id, 'scale', context), 1)); break;
      case 'animation.play': animationRuntime?.play?.(node.params?.clipId, { restart: node.params?.restart !== false }); break;
      case 'animation.stop': animationRuntime?.pause?.(node.params?.clipId); break;
      case 'camera.setActive': setActiveCamera?.(dataValue(plan, node.id, 'camera', context)); break;
      case 'camera.lookAt': {
        const camera = entityObject(dataValue(plan, node.id, 'camera', context));
        camera?.lookAt?.(...vec3(dataValue(plan, node.id, 'target', context)));
        break;
      }
      case 'camera.lookAtEntity': {
        const camera = entityObject(dataValue(plan, node.id, 'camera', context));
        const target = entityObject(dataValue(plan, node.id, 'target', context));
        if (camera && target) camera.lookAt?.(...readVector(target, 'position'));
        break;
      }
      case 'camera.followEntity': {
        const cameraId = dataValue(plan, node.id, 'camera', context);
        cameraBehaviors.set(cameraId, {
          targetId: dataValue(plan, node.id, 'target', context),
          offset: vec3(dataValue(plan, node.id, 'offset', context)),
          smoothing: Math.max(0, finite(dataValue(plan, node.id, 'smoothing', context))),
          space: node.params?.space ?? 'world',
        });
        break;
      }
      case 'camera.clearFollow': cameraBehaviors.delete(dataValue(plan, node.id, 'camera', context)); break;
      case 'camera.setFov': {
        const camera = entityObject(dataValue(plan, node.id, 'camera', context));
        if (camera?.isPerspectiveCamera) {
          camera.fov = Math.max(1, Math.min(179, finite(dataValue(plan, node.id, 'degrees', context), camera.fov)));
          camera.updateProjectionMatrix?.();
        }
        break;
      }
      case 'event.emit': {
        if (emitted.length < MAX_EMITTED_EVENTS) emitted.push({
          eventId: node.params?.eventId,
          payload: dataValue(plan, node.id, 'payload', context),
        });
        break;
      }
      default:
        diagnostics.push({ code: 'logic_node_not_executable', nodeId: node.id, nodeType: node.type, message: `${node.type} is validated but not executable in the controller runtime.` });
        return;
    }
    for (const target of execTargets(plan, node.id, outputPort)) queue.push(target.nodeId);
  }

  function dispatch(eventType, context = {}) {
    if (!active && !['event.onStart', 'event.onActivate'].includes(eventType)) return;
    eventExecutions = 0;
    for (const plan of plans) {
      const roots = [...plan.nodes.values()].filter(node => {
        if (node.type !== eventType) return false;
        if (eventType === 'event.onEvent') return node.params?.eventId === context.eventId;
        const configuredKey = keyCode(node.params?.key ?? node.params?.action);
        return configuredKey === '' || context.key === undefined || configuredKey === context.key;
      });
      for (const root of roots) {
        const queue = execTargets(plan, root.id, 'out').map(target => target.nodeId);
        while (queue.length > 0 && eventExecutions <= MAX_EXECUTIONS_PER_EVENT) {
          const nodeId = queue.shift();
          try {
            executeNode(plan, nodeId, { selfId: settings.entityId, ...context }, queue);
          } catch (error) {
            diagnostics.push({
              code: 'logic_node_failed',
              nodeId,
              message: error?.message ?? String(error),
            });
          }
        }
      }
    }
  }

  function integrateMotion(delta) {
    for (const [entityId, value] of motion) {
      const object = entityObject(entityId);
      if (!object) continue;
      if (physics.hasBody(entityId)) {
        const yaw = finite(object.rotation.y);
        const current = physics.getVelocity(entityId);
        physics.setVelocity(entityId, [-Math.sin(yaw) * value.speed, current[1], -Math.cos(yaw) * value.speed]);
        physics.setAngularVelocity(entityId, value.angularSpeed);
        continue;
      }
      object.rotation.x += value.angularSpeed[0] * delta;
      object.rotation.y += value.angularSpeed[1] * delta;
      object.rotation.z += value.angularSpeed[2] * delta;
      const yaw = finite(object.rotation.y);
      object.position.x += -Math.sin(yaw) * value.speed * delta;
      object.position.z += -Math.cos(yaw) * value.speed * delta;
      object.updateMatrix?.();
      object.updateMatrixWorld?.(true);
    }
  }

  function updateCameras(delta) {
    for (const [cameraId, behavior] of cameraBehaviors) {
      const camera = entityObject(cameraId);
      const target = entityObject(behavior.targetId);
      if (!camera || !target) continue;
      const offset = behavior.space === 'local' ? rotateLocalYaw(behavior.offset, target) : behavior.offset;
      const desired = addVectors(readVector(target, 'position'), offset);
      const current = readVector(camera, 'position');
      const alpha = behavior.smoothing > 0 ? 1 - Math.exp(-behavior.smoothing * delta) : 1;
      writeVector(camera, 'position', current.map((value, axis) => value + (desired[axis] - value) * alpha));
      camera.lookAt?.(...readVector(target, 'position'));
      camera.updateMatrix?.();
      camera.updateMatrixWorld?.(true);
    }
  }

  return Object.freeze({
    settings,
    get available() { return Boolean(settings && controlledEntity && plans.length > 0 && entityObject(settings.entityId)); },
    get active() { return active; },
    get status() {
      return Object.freeze({
        available: Boolean(settings && controlledEntity && plans.length > 0 && entityObject(settings.entityId)),
        active,
        entityId: settings?.entityId ?? null,
        activationKey: settings?.activationKey ?? null,
        heldKeys: Object.freeze([...heldKeys]),
        graphCount: plans.length,
        physics: Object.freeze({ ...physics.status, controlledBody: settings?.entityId ? physics.getBodyState?.(settings.entityId) ?? null : null }),
        diagnostics: Object.freeze(diagnostics.slice(-32)),
        capture: settings?.capture ?? null,
      });
    },
    activate() {
      if (active || !settings || !controlledEntity || plans.length === 0 || !entityObject(settings.entityId)) return false;
      snapshots.clear();
      for (const [id, object] of objects) snapshots.set(id, snapshotObject(object));
      active = true;
      fixedAccumulator = 0;
      heldKeys.clear();
      dispatch('event.onStart');
      dispatch('event.onActivate');
      return true;
    },
    keyDown(code, { repeat = false } = {}) {
      if (!active) return false;
      const key = keyCode(code);
      if (!heldKeys.has(key)) {
        heldKeys.add(key);
        dispatch('event.onKeyPressed', { key, pressed: true, value: 1 });
      } else if (!repeat) return true;
      dispatch('event.onInput', { key, pressed: true, value: 1 });
      return true;
    },
    keyUp(code) {
      if (!active) return false;
      const key = keyCode(code);
      heldKeys.delete(key);
      dispatch('event.onKeyUp', { key, pressed: false, value: 0 });
      dispatch('event.onInput', { key, pressed: false, value: 0 });
      return true;
    },
    releaseKeys() { heldKeys.clear(); },
    update(deltaSeconds) {
      if (!active || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
      const delta = Math.min(0.1, deltaSeconds);
      fixedAccumulator = Math.min(FIXED_STEP * MAX_FIXED_STEPS, fixedAccumulator + delta);
      let steps = 0;
      while (fixedAccumulator >= FIXED_STEP && steps < MAX_FIXED_STEPS) {
        for (const key of heldKeys) dispatch('event.onKeyDown', { key, pressed: true, value: 1, delta: FIXED_STEP });
        dispatch('event.onFixedUpdate', { delta: FIXED_STEP });
        integrateMotion(FIXED_STEP);
        for (const collision of physics.step(FIXED_STEP)) {
          if (collision.selfId !== settings.entityId) continue;
          dispatch(collision.type === 'enter' ? 'event.onCollisionEnter' : 'event.onCollisionExit', collision);
        }
        fixedAccumulator -= FIXED_STEP;
        steps += 1;
      }
      dispatch('event.onUpdate', { delta });
      updateCameras(delta);
      while (emitted.length > 0) {
        const event = emitted.shift();
        dispatch('event.onEvent', { payload: event.payload, eventId: event.eventId });
      }
    },
    stop({ restore = settings?.restoreOnExit !== false } = {}) {
      if (!active) return false;
      dispatch('event.onDeactivate');
      active = false;
      heldKeys.clear();
      motion.clear();
      cameraBehaviors.clear();
      physics.reset();
      states.clear();
      emitted.length = 0;
      fixedAccumulator = 0;
      if (restore) for (const [id, snapshot] of snapshots) restoreObject(entityObject(id), snapshot);
      snapshots.clear();
      return true;
    },
  });
}

export const LOGIC_CONTROLLER_LIMITS = Object.freeze({
  fixedStep: FIXED_STEP,
  maxFixedStepsPerFrame: MAX_FIXED_STEPS,
  maxExecutionsPerEvent: MAX_EXECUTIONS_PER_EVENT,
  maxEmittedEvents: MAX_EMITTED_EVENTS,
});
