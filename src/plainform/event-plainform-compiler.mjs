import { validateGraph } from '../graphs/index.mjs';

const clean = value => value.trim().replace(/[.;]+$/u, '').trim();
const slug = value => clean(value).toLowerCase().replace(/^(?:the|a|an)\s+/u, '').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
const stable = (prefix, value) => `${prefix}/${slug(value)}`;

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function activeScene(project) { return project?.scenes?.[project.activeSceneId] ?? fail('plainform_project_required', 'Event Plainform requires an active canonical scene.'); }
function entityFor(scene, value) {
  const query = clean(value); const wanted = slug(query);
  const matches = Object.values(scene.entities).filter(entity => entity.id === query || slug(entity.name) === wanted || slug(entity.id.split('/').at(-1)) === wanted);
  if (matches.length !== 1) fail(matches.length ? 'plainform_event_entity_ambiguous' : 'plainform_event_entity_missing', `Event subject “${query}” must resolve exactly once.`);
  return matches[0];
}
function keyCode(value) { return ({ left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', space: 'Space', enter: 'Enter' })[slug(value)] ?? value; }

function builder(id) {
  const graph = { formatVersion: 1, id, domain: 'blueprint', nodes: [], edges: [], outputs: {} };
  const add = (idValue, type, params = {}, inputs = {}) => { graph.nodes.push({ id: idValue, type, params, ...(Object.keys(inputs).length ? { inputs } : {}) }); return idValue; };
  const edge = (from, fromPort, to, toPort) => graph.edges.push({ from: { nodeId: from, port: fromPort }, to: { nodeId: to, port: toPort } });
  return { graph, add, edge };
}

export class EventPlainformCompiler {
  compile(source, { project } = {}) {
    const scene = activeScene(project); const statements = source.split(/\r?\n/u).map(clean).filter(Boolean);
    if (statements.length < 1 || statements.length > 64) fail('plainform_event_statement_limit', 'Event Plainform accepts 1 to 64 event rows.');
    const firstSubject = statements[0].match(/^for (.+?),\s*when /iu)?.[1] ?? statements[0].match(/^when (.+?) (?:collides|receives|is destroyed)/iu)?.[1];
    if (!firstSubject) fail('plainform_event_header', 'Begin with “For <object>, when …” or “When <object> …”.');
    const subject = entityFor(scene, firstSubject); const graphId = `blueprint/${slug(subject.name)}-events`; const build = builder(graphId);
    const labels = []; const supported = new Set();
    const self = build.add('entity/self', 'entity.self');

    for (let row = 0; row < statements.length; row += 1) {
      const statement = statements[row]; const rowId = String(row + 1).padStart(3, '0');
      const movement = statement.match(/^for (.+?),\s*when (.+?) is held, move (left|right|up|down) at (\d+(?:\.\d+)?) metres? per second$/iu);
      if (movement) {
        if (entityFor(scene, movement[1]).id !== subject.id) fail('plainform_event_subject_mismatch', 'One event sheet may author only one subject at a time.');
        const speed = Number(movement[4]); const axis = ({ left: [-speed, 0, 0], right: [speed, 0, 0], up: [0, 0, -speed], down: [0, 0, speed] })[movement[3].toLowerCase()];
        const event = build.add(`event/${rowId}-key-held`, 'event.onKeyDown', { key: keyCode(movement[2]) });
        const action = build.add(`action/${rowId}-move-${movement[3].toLowerCase()}`, 'physics.setVelocity', {}, { velocity: axis });
        build.edge(event, 'out', action, 'in'); build.edge(self, 'entity', action, 'entity');
        labels.push({ id: `row/${rowId}`, label: statement, eventId: event, conditionIds: [], actionIds: [action] }); supported.add('keyboard'); supported.add('movement'); continue;
      }
      const collision = statement.match(/^when (.+?) collides with (.+?), stop horizontal movement$/iu);
      if (collision) {
        if (entityFor(scene, collision[1]).id !== subject.id) fail('plainform_event_subject_mismatch', 'One event sheet may author only one subject at a time.');
        const other = entityFor(scene, collision[2]); const event = build.add(`event/${rowId}-collision`, 'event.onCollisionEnter');
        const reference = build.add(`value/${rowId}-other`, 'entity.reference', { entityId: other.id });
        const compare = build.add(`condition/${rowId}-is-${slug(other.name)}`, 'compare.values', { valueType: 'entityId', operation: 'equal' });
        const branch = build.add(`condition/${rowId}-branch`, 'flow.branch'); const action = build.add(`action/${rowId}-stop-horizontal`, 'motion.setSpeed', {}, { speed: 0 });
        build.edge(event, 'other', compare, 'a'); build.edge(reference, 'entity', compare, 'b'); build.edge(compare, 'result', branch, 'condition');
        build.edge(event, 'out', branch, 'in'); build.edge(branch, 'true', action, 'in'); build.edge(self, 'entity', action, 'entity');
        labels.push({ id: `row/${rowId}`, label: statement, eventId: event, conditionIds: [compare], actionIds: [action] }); supported.add('collision'); supported.add('conditions'); continue;
      }
      const message = statement.match(/^when (?:the )?(.+?) receives (.+?) with strength at least (\d+(?:\.\d+)?), add (\d+(?:\.\d+)?) to (.+?) and play the (.+?) animation(?:\. if (.+?) reaches (\d+(?:\.\d+)?), send (.+?) once)?$/iu);
      if (message) {
        if (entityFor(scene, message[1]).id !== subject.id) fail('plainform_event_subject_mismatch', 'One event sheet may author only one subject at a time.');
        const eventName = slug(message[2]); const stateName = slug(message[5]); const event = build.add(`event/${rowId}-${eventName}`, 'event.onEvent', { eventId: `event/${eventName}` });
        const payload = build.add(`value/${rowId}-strength`, 'event.payloadNumber', { field: 'strength' }); build.edge(event, 'payload', payload, 'payload');
        const threshold = build.add(`value/${rowId}-strength-minimum`, 'value.constant', { valueType: 'float', value: Number(message[3]) });
        const strength = build.add(`condition/${rowId}-strength`, 'compare.values', { valueType: 'float', operation: 'greaterEqual' }); build.edge(payload, 'value', strength, 'a'); build.edge(threshold, 'value', strength, 'b');
        const branch = build.add(`condition/${rowId}-branch`, 'flow.branch'); build.edge(event, 'out', branch, 'in'); build.edge(strength, 'result', branch, 'condition');
        const current = build.add(`value/${rowId}-${stateName}`, 'state.get', { key: `state/${stateName}`, valueType: 'float' });
        const increment = build.add(`value/${rowId}-increment`, 'value.constant', { valueType: 'float', value: Number(message[4]) });
        const sum = build.add(`value/${rowId}-sum`, 'value.add'); build.edge(current, 'value', sum, 'a'); build.edge(increment, 'value', sum, 'b');
        const set = build.add(`action/${rowId}-set-${stateName}`, 'state.set', { key: `state/${stateName}`, valueType: 'float' }); build.edge(sum, 'value', set, 'value'); build.edge(branch, 'true', set, 'in');
        const animation = build.add(`action/${rowId}-animation`, 'animation.play', { clipId: `animation/${slug(message[6])}`, loop: false, speed: 1, restart: true }); build.edge(self, 'entity', animation, 'entity'); build.edge(set, 'out', animation, 'in');
        const actions = [set, animation]; const conditions = [strength];
        if (message[7]) {
          if (slug(message[7]) !== stateName) fail('plainform_event_state_mismatch', 'The follow-up threshold must reference the state changed by the preceding action.');
          const target = build.add(`value/${rowId}-state-target`, 'value.constant', { valueType: 'float', value: Number(message[8]) });
          const reached = build.add(`condition/${rowId}-state-reached`, 'compare.values', { valueType: 'float', operation: 'greaterEqual' }); build.edge(sum, 'value', reached, 'a'); build.edge(target, 'value', reached, 'b');
          const reachedBranch = build.add(`condition/${rowId}-reached-branch`, 'flow.branch'); build.edge(animation, 'out', reachedBranch, 'in'); build.edge(reached, 'result', reachedBranch, 'condition');
          const emit = build.add(`action/${rowId}-emit-once`, 'event.emitOnce', { eventId: `event/${slug(message[9])}` }); build.edge(reachedBranch, 'true', emit, 'in'); actions.push(emit); conditions.push(reached);
        }
        labels.push({ id: `row/${rowId}`, label: statement, eventId: event, conditionIds: conditions, actionIds: actions }); supported.add('messages'); supported.add('state'); supported.add('animation'); continue;
      }
      fail('plainform_event_unsupported', `Event Plainform does not understand “${statement}”.`);
    }
    const validation = validateGraph(build.graph); if (!validation.valid) fail('plainform_event_graph_invalid', validation.errors[0]?.message ?? 'The event sheet candidate is invalid.');
    const existing = project.resources.graphs?.[graphId];
    if (existing && existing.metadata?.plainform?.kind !== 'eventSheet') fail('plainform_event_ownership_conflict', `Graph ${graphId} exists and is not owned by Event Plainform.`);
    const resource = { id: graphId, kind: 'graph', name: `${subject.name} Events`, metadata: { plainform: { kind: 'eventSheet', source, subjectId: subject.id, rows: labels, capabilities: { shared: [...supported].sort(), unavailable: ['draw-event', 'destroy-event', 'pointer-event', 'scene-change'] } } }, graph: validation.graph };
    const graphIds = [...new Set([...(subject.components?.logic?.graphIds ?? []), graphId])];
    const operations = [existing ? { op: 'resource.patch', resourceType: 'graphs', resourceId: graphId, patch: { graph: resource.graph, metadata: resource.metadata, name: resource.name } } : { op: 'resource.create', resourceType: 'graphs', resource }];
    if (subject.components?.logic) operations.push({ op: 'entity.patch', entityId: subject.id, patch: { components: { logic: { ...subject.components.logic, graphIds } } } });
    else operations.push({ op: 'entity.component.attach', entityId: subject.id, component: 'logic', value: { enabled: true, graphIds } });
    return Object.freeze({ language: 'plainform-v1', dialect: 'event', source, operations: Object.freeze(operations), interpretation: Object.freeze(labels.map(row => `Author ${row.label}`)), aliases: Object.freeze({}), requestedPreview: false, eventSheet: Object.freeze({ graphId, subjectId: subject.id, rowCount: labels.length, metrics: validation.metrics }) });
  }
}
