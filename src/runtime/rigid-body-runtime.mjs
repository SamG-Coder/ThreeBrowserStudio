const MAX_BODIES = 256;
const MAX_COLLISION_PAIRS = 16_384;
const DEFAULT_GRAVITY = [0, -9.81, 0];

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const vector = (value, fallback = [0, 0, 0]) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? [...value] : [...fallback];
const add = (a, b) => a.map((value, index) => value + b[index]);
const subtract = (a, b) => a.map((value, index) => value - b[index]);
const multiply = (value, scalar) => value.map(item => item * scalar);
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const length = value => Math.hypot(...value);
const normalize = value => { const size = length(value); return size > 1e-9 ? multiply(value, 1 / size) : [1, 0, 0]; };

function readVector(target) {
  return target ? [finite(target.x), finite(target.y), finite(target.z)] : [0, 0, 0];
}

function writeVector(target, value) {
  if (!target) return;
  if (typeof target.set === 'function') target.set(...value);
  else [target.x, target.y, target.z] = value;
}

function bodyState(entity, object) {
  const source = entity.components?.rigidBody ?? {};
  return {
    id: entity.id,
    object,
    type: source.bodyType ?? 'dynamic',
    mass: finite(source.mass, 1),
    gravityScale: finite(source.gravityScale, 1),
    linearDamping: finite(source.linearDamping, 0.05),
    angularDamping: finite(source.angularDamping, 0.05),
    velocity: vector(source.velocity),
    angularVelocity: vector(source.angularVelocity),
    force: [0, 0, 0],
    lastAppliedForce: null,
    forceApplicationCount: 0,
    freezePosition: source.freezePosition ?? [false, false, false],
    freezeRotation: source.freezeRotation ?? [false, false, false],
  };
}

function colliderState(entity, object, bodyId = null) {
  const source = entity.components?.collider;
  if (!source || source.enabled === false) return null;
  return {
    id: entity.id,
    bodyId,
    object,
    shape: source.shape,
    offset: vector(source.offset),
    size: vector(source.size, [1, 1, 1]),
    radius: finite(source.radius, 0.5),
    restitution: finite(source.restitution, 0),
    friction: finite(source.friction, 0.5),
    isTrigger: source.isTrigger === true,
    layer: source.layer ?? 0,
    mask: (source.mask ?? 0xffffffff) >>> 0,
  };
}

function worldMatrix(object) {
  object?.updateWorldMatrix?.(true, false);
  const elements = object?.matrixWorld?.elements;
  return elements?.length >= 16 ? elements : null;
}

function worldScale(object) {
  const matrix = worldMatrix(object);
  if (matrix) return [
    Math.hypot(matrix[0], matrix[1], matrix[2]),
    Math.hypot(matrix[4], matrix[5], matrix[6]),
    Math.hypot(matrix[8], matrix[9], matrix[10]),
  ];
  const result = [1, 1, 1];
  for (let current = object; current; current = current.parent) {
    const scale = readVector(current.scale ?? { x: 1, y: 1, z: 1 });
    result[0] *= scale[0] || 1;
    result[1] *= scale[1] || 1;
    result[2] *= scale[2] || 1;
  }
  return result;
}

function colliderCenter(collider) {
  const matrix = worldMatrix(collider.object);
  if (matrix) {
    const [x, y, z] = collider.offset;
    return [
      matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
      matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
      matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    ];
  }
  let center = [...collider.offset];
  for (let current = collider.object; current; current = current.parent) center = add(center, readVector(current.position));
  return center;
}

function colliderSize(collider) {
  const scale = worldScale(collider.object);
  return collider.size.map((value, axis) => Math.abs(value * scale[axis]));
}

function colliderRadius(collider) {
  return collider.radius * Math.max(...worldScale(collider.object).map(Math.abs));
}

function boxBox(a, b) {
  const delta = subtract(colliderCenter(b), colliderCenter(a));
  const aSize = colliderSize(a);
  const bSize = colliderSize(b);
  const overlap = aSize.map((value, axis) => (value + bSize[axis]) * 0.5 - Math.abs(delta[axis]));
  if (overlap.some(value => value <= 0)) return null;
  const axis = overlap.indexOf(Math.min(...overlap));
  const normal = [0, 0, 0];
  normal[axis] = delta[axis] < 0 ? -1 : 1;
  return { normal, penetration: overlap[axis] };
}

function sphereSphere(a, b) {
  const delta = subtract(colliderCenter(b), colliderCenter(a));
  const distance = length(delta);
  const penetration = colliderRadius(a) + colliderRadius(b) - distance;
  return penetration > 0 ? { normal: normalize(delta), penetration } : null;
}

function sphereBox(sphere, box, flip = false) {
  const sphereCenter = colliderCenter(sphere);
  const boxCenter = colliderCenter(box);
  const boxSize = colliderSize(box);
  const radius = colliderRadius(sphere);
  const closest = sphereCenter.map((value, axis) => Math.max(boxCenter[axis] - boxSize[axis] * 0.5, Math.min(boxCenter[axis] + boxSize[axis] * 0.5, value)));
  const boxToSphere = subtract(sphereCenter, closest);
  const distance = length(boxToSphere);
  if (distance >= radius) return null;
  const normalBoxToSphere = normalize(boxToSphere);
  return { normal: flip ? normalBoxToSphere : multiply(normalBoxToSphere, -1), penetration: radius - distance };
}

function intersection(a, b) {
  if (a.shape === 'sphere' && b.shape === 'sphere') return sphereSphere(a, b);
  if (a.shape === 'box' && b.shape === 'box') return boxBox(a, b);
  if (a.shape === 'sphere') return sphereBox(a, b, false);
  return sphereBox(b, a, true);
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function createRigidBodyRuntime({ scene, objects } = {}) {
  const gravity = vector(scene?.settings?.physics?.gravity, DEFAULT_GRAVITY);
  const enabled = scene?.settings?.physics?.enabled !== false;
  const entities = Object.values(scene?.entities ?? {});
  const bodies = new Map();
  const colliders = [];
  const contacts = new Set();
  const diagnostics = [];
  const boundedEntities = entities.slice(0, MAX_BODIES);
  for (const entity of boundedEntities) {
    const object = objects?.get?.(entity.id);
    if (!object) continue;
    if (entity.components?.rigidBody?.enabled !== false && entity.components?.rigidBody) bodies.set(entity.id, bodyState(entity, object));
  }
  const bodyForObject = (entityId, object) => {
    if (bodies.has(entityId)) return entityId;
    for (let current = object?.parent; current; current = current.parent) {
      const id = current.userData?.studioEntityId;
      if (id && bodies.has(id)) return id;
    }
    return null;
  };
  for (const entity of boundedEntities) {
    const object = objects?.get?.(entity.id);
    if (!object) continue;
    const collider = colliderState(entity, object, bodyForObject(entity.id, object));
    if (collider) colliders.push(collider);
  }
  if (entities.length > MAX_BODIES) diagnostics.push({ code: 'physics_body_budget', message: `Physics is bounded to ${MAX_BODIES} entities.` });

  const inverseMass = body => body?.type === 'dynamic' ? 1 / body.mass : 0;
  function translate(body, delta) {
    if (!body?.object) return;
    const position = readVector(body.object.position);
    writeVector(body.object.position, position.map((value, axis) => value + (body.freezePosition[axis] ? 0 : delta[axis])));
    body.object.updateMatrix?.();
    body.object.updateMatrixWorld?.(true);
  }
  function resolve(aCollider, bCollider, hit, frictionPairs) {
    if (aCollider.isTrigger || bCollider.isTrigger) return;
    const a = bodies.get(aCollider.bodyId);
    const b = bodies.get(bCollider.bodyId);
    const inverseA = inverseMass(a);
    const inverseB = inverseMass(b);
    const total = inverseA + inverseB;
    if (total <= 0) return;
    const correction = Math.max(0, hit.penetration - 0.001) * 0.8;
    translate(a, multiply(hit.normal, -correction * inverseA / total));
    translate(b, multiply(hit.normal, correction * inverseB / total));
    const velocityA = a?.velocity ?? [0, 0, 0];
    const velocityB = b?.velocity ?? [0, 0, 0];
    const alongNormal = dot(subtract(velocityB, velocityA), hit.normal);
    if (alongNormal >= 0) return;
    const restitution = Math.abs(alongNormal) < 0.5 ? 0 : Math.max(aCollider.restitution, bCollider.restitution);
    const impulse = -(1 + restitution) * alongNormal / total;
    if (a) a.velocity = subtract(a.velocity, multiply(hit.normal, impulse * inverseA));
    if (b) b.velocity = add(b.velocity, multiply(hit.normal, impulse * inverseB));
    const postRelative = subtract(b?.velocity ?? velocityB, a?.velocity ?? velocityA);
    const tangentVector = subtract(postRelative, multiply(hit.normal, dot(postRelative, hit.normal)));
    const frictionKey = pairKey(aCollider.bodyId ?? aCollider.id, bCollider.bodyId ?? bCollider.id);
    if (length(tangentVector) > 1e-9 && !frictionPairs.has(frictionKey)) {
      frictionPairs.add(frictionKey);
      const tangent = normalize(tangentVector);
      const unclamped = -dot(postRelative, tangent) / total;
      const frictionLimit = impulse * Math.sqrt(aCollider.friction * bCollider.friction);
      const frictionImpulse = Math.max(-frictionLimit, Math.min(frictionLimit, unclamped));
      if (a) a.velocity = subtract(a.velocity, multiply(tangent, frictionImpulse * inverseA));
      if (b) b.velocity = add(b.velocity, multiply(tangent, frictionImpulse * inverseB));
    }
  }

  return Object.freeze({
    get available() { return enabled && (bodies.size > 0 || colliders.length > 0); },
    get status() { return { available: enabled && (bodies.size > 0 || colliders.length > 0), bodyCount: bodies.size, colliderCount: colliders.length, activeContactCount: contacts.size, activeContacts: [...contacts].slice(0, 16), diagnostics: diagnostics.slice(-16) }; },
    hasBody(id) { return bodies.has(id); },
    getVelocity(id) { return [...(bodies.get(id)?.velocity ?? [0, 0, 0])]; },
    getBodyState(id) {
      const body = bodies.get(id);
      return body ? {
        velocity: [...body.velocity],
        angularVelocity: [...body.angularVelocity],
        position: readVector(body.object?.position),
        speed: length(body.velocity),
        lastAppliedForce: body.lastAppliedForce ? [...body.lastAppliedForce] : null,
        forceApplicationCount: body.forceApplicationCount,
      } : null;
    },
    setVelocity(id, value) { const body = bodies.get(id); if (!body) return false; body.velocity = vector(value); return true; },
    setAngularVelocity(id, value) { const body = bodies.get(id); if (!body) return false; body.angularVelocity = vector(value); return true; },
    setGravityScale(id, value) { const body = bodies.get(id); if (!body || !Number.isFinite(value)) return false; body.gravityScale = Math.max(-100, Math.min(100, value)); return true; },
    addForce(id, value) {
      const body = bodies.get(id);
      if (!body || body.type !== 'dynamic') return false;
      const applied = vector(value);
      body.force = add(body.force, applied);
      body.lastAppliedForce = applied;
      body.forceApplicationCount += 1;
      return true;
    },
    addImpulse(id, value) { const body = bodies.get(id); if (!body || body.type !== 'dynamic') return false; body.velocity = add(body.velocity, multiply(vector(value), 1 / body.mass)); return true; },
    reset() {
      contacts.clear();
      for (const body of bodies.values()) {
        const source = scene.entities[body.id].components.rigidBody;
        body.velocity = vector(source.velocity);
        body.angularVelocity = vector(source.angularVelocity);
        body.gravityScale = finite(source.gravityScale, 1);
        body.force = [0, 0, 0];
        body.lastAppliedForce = null;
        body.forceApplicationCount = 0;
      }
    },
    step(delta) {
      if (!enabled) return [];
      for (const body of bodies.values()) {
        if (body.type === 'static') continue;
        if (body.type === 'dynamic') body.velocity = add(body.velocity, multiply(add(multiply(gravity, body.gravityScale), multiply(body.force, 1 / body.mass)), delta));
        const linearDecay = Math.exp(-body.linearDamping * delta);
        const angularDecay = Math.exp(-body.angularDamping * delta);
        body.velocity = multiply(body.velocity, linearDecay);
        body.angularVelocity = multiply(body.angularVelocity, angularDecay);
        translate(body, multiply(body.velocity, delta));
        const rotation = readVector(body.object.rotation).map((value, axis) => value + (body.freezeRotation[axis] ? 0 : body.angularVelocity[axis] * delta));
        writeVector(body.object.rotation, rotation);
        body.force = [0, 0, 0];
      }
      const nextContacts = new Set();
      const frictionPairs = new Set();
      const resolutionHits = new Map();
      const events = [];
      let tested = 0;
      for (let i = 0; i < colliders.length; i += 1) for (let j = i + 1; j < colliders.length; j += 1) {
        if (++tested > MAX_COLLISION_PAIRS) break;
        const a = colliders[i]; const b = colliders[j];
        if (a.bodyId && a.bodyId === b.bodyId) continue;
        if (((a.mask >>> b.layer) & 1) === 0 || ((b.mask >>> a.layer) & 1) === 0) continue;
        const hit = intersection(a, b);
        if (!hit) continue;
        const key = pairKey(a.id, b.id);
        nextContacts.add(key);
        if (!a.isTrigger && !b.isTrigger) {
          const resolutionKey = pairKey(a.bodyId ?? a.id, b.bodyId ?? b.id);
          const previous = resolutionHits.get(resolutionKey);
          if (!previous || hit.penetration > previous.hit.penetration) resolutionHits.set(resolutionKey, { a, b, hit });
        }
        if (!contacts.has(key)) {
          events.push({ type: 'enter', selfId: a.id, otherId: b.id, normal: hit.normal });
          events.push({ type: 'enter', selfId: b.id, otherId: a.id, normal: multiply(hit.normal, -1) });
        }
      }
      for (const { a, b, hit } of resolutionHits.values()) resolve(a, b, hit, frictionPairs);
      for (const key of contacts) if (!nextContacts.has(key)) {
        const [a, b] = key.split('|');
        events.push({ type: 'exit', selfId: a, otherId: b });
        events.push({ type: 'exit', selfId: b, otherId: a });
      }
      contacts.clear();
      for (const key of nextContacts) contacts.add(key);
      for (const body of bodies.values()) { body.object.updateMatrix?.(); body.object.updateMatrixWorld?.(true); }
      return events;
    },
  });
}

export const RIGID_BODY_LIMITS = Object.freeze({ maxBodies: MAX_BODIES, maxCollisionPairs: MAX_COLLISION_PAIRS, colliderShapes: Object.freeze(['box', 'sphere']) });
