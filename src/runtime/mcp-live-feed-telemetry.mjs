const DEFAULT_HISTORY_LIMIT = 64;
const MAX_HISTORY_LIMIT = 256;

export const STUDIO_LIVE_FEED_METHODS = Object.freeze([
  'three_studio_status',
  'three_studio_inspect',
  'three_studio_apply',
  'three_studio_validate',
  'three_studio_render',
  'three_studio_history',
  'three_studio_job',
  'three_studio_project',
  'three_studio_play',
]);

const METHOD_SET = new Set(STUDIO_LIVE_FEED_METHODS);
const BIDI_AND_DIRECTION_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const HTML_DELIMITERS = Object.freeze({ '<': '\u2039', '>': '\u203a', '&': '\uff06' });

const PROJECT_ACTIONS = Object.freeze({
  list: 'List projects',
  create: 'Create project',
  open: 'Open project',
  save: 'Save project',
});
const INSPECT_QUERIES = Object.freeze({
  selector: 'Inspect selected scene data',
  sceneDigest: 'Inspect scene digest',
  resourceDigest: 'Inspect resource digest',
  meshElements: 'Inspect exact mesh elements',
  graphDigest: 'Inspect graph digest',
  modifierDigest: 'Inspect exact modifier stack',
  rtxDigest: 'Inspect RTX digest',
  changedSinceRevision: 'Inspect recent changes',
  unresolvedResources: 'Inspect unresolved resources',
  unusedResources: 'Inspect unused resources',
  graphCatalog: 'Inspect graph catalog',
  playState: 'Inspect Play state',
  latestEvidence: 'Inspect latest evidence metadata',
  blenderCatalog: 'Inspect Blender catalog',
  beautyDigest: 'Inspect beauty evidence pixels',
  projectVisibility: 'Inspect camera projection visibility',
});
const HISTORY_ACTIONS = Object.freeze({
  list: 'List history',
  inspect: 'Inspect history entry',
  undo: 'Apply compensating undo',
  redo: 'Apply compensating redo',
});
const PLAY_ACTIONS = Object.freeze({
  enter: 'Enter Play',
  stop: 'Stop Play',
  pause: 'Pause Play',
  resume: 'Resume Play',
  step: 'Step Play',
  seek: 'Seek Play timeline',
  inject: 'Inject named input',
  query: 'Query Play state',
});
const VALIDATION_CHECKS = new Set([
  'schemas', 'references', 'hierarchy', 'graphs', 'animations', 'budgets',
]);

function boundedInteger(value, minimum, maximum, fallback) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function readField(value, key) {
  try {
    return value && typeof value === 'object' ? value[key] : undefined;
  } catch {
    return undefined;
  }
}

function safeNow(now) {
  try {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function truncateCodePoints(value, maximum) {
  const points = [...value];
  if (points.length <= maximum) return value;
  return `${points.slice(0, Math.max(1, maximum - 1)).join('')}\u2026`;
}

/**
 * Sanitizes the small pieces of display text accepted by the live feed. The
 * overlay still writes with textContent; delimiter replacement also prevents
 * untrusted labels from visually impersonating markup in logs or screenshots.
 */
export function sanitizeLiveFeedText(value, { maximum = 160, fallback = '' } = {}) {
  const limit = boundedInteger(maximum, 1, 512, 160);
  let text;
  try {
    text = typeof value === 'string' ? value : String(value ?? '');
  } catch {
    text = '';
  }
  text = text
    .normalize('NFKC')
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(BIDI_AND_DIRECTION_CONTROLS, '')
    .replace(/[<>&]/gu, character => HTML_DELIMITERS[character])
    .replace(/\s+/gu, ' ')
    .trim();
  if (!text) return fallback;
  return truncateCodePoints(text, limit);
}

export function isStudioLiveFeedMethod(method) {
  return typeof method === 'string'
    && method !== 'ping'
    && method !== 'three_studio_ping'
    && METHOD_SET.has(method);
}

function safeAction(params, table, fallback) {
  const action = readField(params, 'action');
  return typeof action === 'string' && Object.hasOwn(table, action) ? table[action] : fallback;
}

function operationCount(params) {
  const operations = readField(params, 'operations');
  try {
    return Array.isArray(operations) ? Math.min(128, operations.length) : 0;
  } catch {
    return 0;
  }
}

function validationSummary(params) {
  const checks = readField(params, 'checks');
  if (!Array.isArray(checks)) return 'Validate project';
  const safeChecks = [];
  try {
    for (const check of checks.slice(0, 6)) {
      if (typeof check === 'string' && VALIDATION_CHECKS.has(check) && !safeChecks.includes(check)) {
        safeChecks.push(check);
      }
    }
  } catch {
    return 'Validate project';
  }
  return safeChecks.length > 0 ? `Validate ${safeChecks.join(', ')}` : 'Validate project';
}

function renderSummary(params) {
  const width = readField(params, 'width');
  const height = readField(params, 'height');
  if (Number.isInteger(width) && width >= 16 && width <= 1920
      && Number.isInteger(height) && height >= 16 && height <= 1080) {
    return `Render beauty ${width}\u00d7${height}`;
  }
  return 'Render beauty';
}

/**
 * Produces a compact description from an explicit field allowlist. Labels,
 * selectors, IDs, paths, operation contents, evidence, and arbitrary values
 * are deliberately never copied into telemetry.
 */
export function summarizeStudioCommand(method, params = {}) {
  if (!isStudioLiveFeedMethod(method)) return null;
  let summary;
  switch (method) {
    case 'three_studio_status': summary = 'Read runtime status'; break;
    case 'three_studio_project': summary = safeAction(params, PROJECT_ACTIONS, 'Use project'); break;
    case 'three_studio_inspect': {
      const query = readField(params, 'query');
      summary = typeof query === 'string' && Object.hasOwn(INSPECT_QUERIES, query)
        ? INSPECT_QUERIES[query]
        : 'Inspect project';
      break;
    }
    case 'three_studio_apply': {
      const count = operationCount(params);
      const verb = readField(params, 'dryRun') === true ? 'Dry-run' : 'Apply';
      summary = `${verb} ${count} operation${count === 1 ? '' : 's'}`;
      break;
    }
    case 'three_studio_validate': summary = validationSummary(params); break;
    case 'three_studio_render': summary = renderSummary(params); break;
    case 'three_studio_history': summary = safeAction(params, HISTORY_ACTIONS, 'Use history'); break;
    case 'three_studio_job': summary = 'Request reserved job'; break;
    case 'three_studio_play': summary = safeAction(params, PLAY_ACTIONS, 'Use Play state'); break;
    default: summary = 'Use Studio tool';
  }
  return sanitizeLiveFeedText(summary, { maximum: 160, fallback: 'Use Studio tool' });
}

function revisionFrom(value, fields) {
  for (const field of fields) {
    const revision = readField(value, field);
    if (Number.isSafeInteger(revision) && revision >= 0) return revision;
  }
  return null;
}

function timestampFrom(milliseconds) {
  try {
    return new Date(milliseconds).toISOString().slice(11, 23);
  } catch {
    return '--:--:--.---';
  }
}

function reportSinkError(onSinkError, error) {
  if (typeof onSinkError !== 'function') return;
  try {
    onSinkError(error);
  } catch {
    // Telemetry must never change command execution semantics.
  }
}

/**
 * Creates a bounded, transport-agnostic lifecycle feed. Integration can call
 * begin()/complete()/fail() around dispatch or use track(). Subscribers receive
 * only frozen, redacted entries and are isolated from the command path.
 */
export function createStudioCommandTelemetry({
  now = () => Date.now(),
  historyLimit = DEFAULT_HISTORY_LIMIT,
  onSinkError,
} = {}) {
  const completedLimit = boundedInteger(historyLimit, 1, MAX_HISTORY_LIMIT, DEFAULT_HISTORY_LIMIT);
  const entries = new Map();
  const order = [];
  const subscribers = new Set();
  let nextId = 1;
  let disposed = false;

  const snapshot = () => Object.freeze(order
    .filter(id => entries.has(id))
    .map(id => entries.get(id)));

  const publish = entry => {
    if (disposed) return;
    const current = snapshot();
    const event = Object.freeze({ type: 'upsert', entry });
    for (const subscriber of subscribers) {
      try {
        subscriber(current, event);
      } catch (error) {
        reportSinkError(onSinkError, error);
      }
    }
  };

  const prune = () => {
    const completed = order
      .map(id => entries.get(id))
      .filter(entry => entry && entry.stage !== 'started')
      .sort((left, right) => (left.finishedAtMs - right.finishedAtMs) || (left.sequence - right.sequence));
    while (completed.length > completedLimit) {
      const removed = completed.shift();
      entries.delete(removed.id);
      const index = order.indexOf(removed.id);
      if (index >= 0) order.splice(index, 1);
    }
  };

  const begin = (method, params = {}) => {
    if (disposed || !isStudioLiveFeedMethod(method)) return null;
    const startedAtMs = safeNow(now);
    const id = `feed-${nextId}`;
    const sequence = nextId;
    nextId += 1;
    let current = Object.freeze({
      id,
      sequence,
      timestamp: timestampFrom(startedAtMs),
      tool: method,
      stage: 'started',
      startedAtMs,
      finishedAtMs: null,
      elapsedMs: 0,
      revision: revisionFrom(params, ['baseRevision']),
      summary: summarizeStudioCommand(method, params),
    });
    entries.set(id, current);
    order.push(id);
    publish(current);
    let finished = false;

    const finish = (stage, result) => {
      if (finished || disposed || !entries.has(id)) return current;
      finished = true;
      const finishedAtMs = safeNow(now);
      current = Object.freeze({
        ...current,
        stage,
        finishedAtMs,
        elapsedMs: Math.max(0, Math.round(finishedAtMs - startedAtMs)),
        revision: revisionFrom(result, ['revision', 'savedRevision']) ?? current.revision,
      });
      entries.set(id, current);
      prune();
      if (entries.has(id)) publish(current);
      return current;
    };

    return Object.freeze({
      id,
      complete: result => finish('completed', result),
      fail: () => finish('failed'),
    });
  };

  const track = async (method, params, work) => {
    if (typeof work !== 'function') throw new TypeError('work must be a function');
    const lifecycle = begin(method, params);
    try {
      const result = await work();
      lifecycle?.complete(result);
      return result;
    } catch (error) {
      lifecycle?.fail();
      throw error;
    }
  };

  const subscribe = (subscriber, { emitCurrent = true } = {}) => {
    if (typeof subscriber !== 'function') throw new TypeError('subscriber must be a function');
    if (disposed) return () => {};
    subscribers.add(subscriber);
    if (emitCurrent) {
      try {
        subscriber(snapshot(), Object.freeze({ type: 'snapshot', entry: null }));
      } catch (error) {
        reportSinkError(onSinkError, error);
      }
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      subscribers.delete(subscriber);
    };
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    subscribers.clear();
    entries.clear();
    order.length = 0;
  };

  return Object.freeze({ begin, track, subscribe, snapshot, dispose });
}
