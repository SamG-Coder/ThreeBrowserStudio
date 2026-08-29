import { MAX_CONTROL_REQUEST_BYTES, PROTOCOL_VERSION } from './constants.mjs';
import { assertValidProjectDocument, normalizeProjectDocument } from './documents.mjs';
import { changedIdsSince, computeCompactDiff } from './diff.mjs';
import { StudioError, studioAssert } from './errors.mjs';
import { applyOperations } from './operations.mjs';
import { AtomicProjectStore } from './persistence.mjs';
import {
  assertJsonValue,
  cloneJson,
  contentHash,
  createTransactionId,
  nowIso,
} from './util.mjs';

const APPLY_KEYS = new Set([
  'protocolVersion', 'projectId', 'label', 'baseRevision', 'idempotencyKey',
  'dryRun', 'operations',
]);
const HISTORY_KEYS = new Set([
  'protocolVersion', 'projectId', 'label', 'baseRevision', 'idempotencyKey',
  'transactionId',
]);

function assertRequestKeys(request, allowed) {
  studioAssert(request && typeof request === 'object' && !Array.isArray(request), 'invalid_request', 'Request must be an object');
  assertJsonValue(request);
  studioAssert(Buffer.byteLength(JSON.stringify(request), 'utf8') <= MAX_CONTROL_REQUEST_BYTES, 'request_too_large', `Control requests cannot exceed ${MAX_CONTROL_REQUEST_BYTES} bytes`);
  for (const key of Object.keys(request)) {
    if (!allowed.has(key)) throw new StudioError('unknown_property', `Request contains unknown property ${key}`, { key });
  }
}

function boundedLabel(label) {
  studioAssert(typeof label === 'string' && label.trim().length > 0 && label.length <= 160, 'invalid_label', 'A non-empty label of at most 160 characters is required');
  return label.trim();
}

function validateIdempotencyKey(key) {
  studioAssert(typeof key === 'string' && key.length >= 8 && key.length <= 160, 'invalid_idempotency_key', 'idempotencyKey must contain 8 to 160 characters');
  return key;
}

function cloneResponse(response) {
  return cloneJson(response);
}

export class AuthoringKernel {
  #document;
  #history;
  #idempotency = new Map();
  #undoStack = [];
  #redoStack = [];
  #listeners = new Set();
  #tail = Promise.resolve();
  #clock;
  #transactionIdFactory;
  #prepare;

  constructor(document, {
    store = null,
    history = [],
    clock = Date,
    transactionIdFactory = createTransactionId,
    prepare = null,
  } = {}) {
    this.#document = normalizeProjectDocument(document);
    assertValidProjectDocument(this.#document);
    this.store = store;
    this.#history = cloneJson(history);
    this.#clock = clock;
    this.#transactionIdFactory = transactionIdFactory;
    this.#prepare = prepare;
    this.#rebuildHistoryState();
  }

  static async open(projectRoot, options = {}) {
    const store = options.store ?? new AtomicProjectStore(projectRoot);
    const loaded = await store.load();
    const kernel = new AuthoringKernel(loaded.document, {
      ...options,
      store,
      history: loaded.journal,
    });
    return { kernel, ...loaded };
  }

  #rebuildHistoryState() {
    this.#undoStack = [];
    this.#redoStack = [];
    const byId = new Map();
    for (const entry of this.#history) {
      byId.set(entry.transactionId, entry);
      if (entry.idempotencyKey && entry.requestFingerprint && entry.response) {
        this.#idempotency.set(entry.idempotencyKey, {
          fingerprint: entry.requestFingerprint,
          response: cloneResponse(entry.response),
        });
      }
      if (entry.kind === 'apply') {
        this.#undoStack.push(entry.transactionId);
        this.#redoStack = [];
      } else if (entry.kind === 'undo') {
        this.#undoStack = this.#undoStack.filter((id) => id !== entry.compensates);
        this.#redoStack.push(entry.compensates);
      } else if (entry.kind === 'redo') {
        this.#redoStack = this.#redoStack.filter((id) => id !== entry.replays);
        this.#undoStack.push(entry.replays);
      }
    }
    this.#transactions = byId;
  }

  #transactions = new Map();

  #enqueue(work) {
    const result = this.#tail.then(work, work);
    this.#tail = result.catch(() => {});
    return result;
  }

  #checkCommon(request, allowedKeys) {
    assertRequestKeys(request, allowedKeys);
    if (request.protocolVersion !== undefined && request.protocolVersion !== PROTOCOL_VERSION) {
      throw new StudioError('protocol_mismatch', `Expected ${PROTOCOL_VERSION}`);
    }
    if (request.projectId !== undefined && request.projectId !== this.#document.projectId) {
      throw new StudioError('project_mismatch', `Kernel owns ${this.#document.projectId}, not ${request.projectId}`);
    }
    boundedLabel(request.label);
    validateIdempotencyKey(request.idempotencyKey);
    studioAssert(Number.isSafeInteger(request.baseRevision) && request.baseRevision >= 0, 'invalid_revision', 'baseRevision must be a non-negative safe integer');
  }

  #checkRevision(baseRevision) {
    if (baseRevision !== this.#document.revision) {
      throw new StudioError('revision_conflict', `Base revision ${baseRevision} does not match current revision ${this.#document.revision}`, {
        baseRevision,
        currentRevision: this.#document.revision,
        ...changedIdsSince(this.#history, baseRevision),
      });
    }
  }

  #existingIdempotent(request, fingerprint) {
    const completed = this.#idempotency.get(request.idempotencyKey);
    if (!completed) return null;
    if (completed.fingerprint !== fingerprint) {
      throw new StudioError('idempotency_conflict', `Idempotency key ${request.idempotencyKey} was already used for a different request`);
    }
    return cloneResponse(completed.response);
  }

  get revision() {
    return this.#document.revision;
  }

  get projectId() {
    return this.#document.projectId;
  }

  get document() {
    return cloneJson(this.#document);
  }

  get dirty() {
    return this.#document.revision !== this.#document.savedRevision;
  }

  status() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      projectId: this.#document.projectId,
      projectName: this.#document.name,
      revision: this.#document.revision,
      savedRevision: this.#document.savedRevision,
      dirty: this.dirty,
      activeSceneId: this.#document.activeSceneId,
      sceneCount: this.#document.sceneOrder.length,
      entityCount: Object.values(this.#document.scenes).reduce((sum, scene) => sum + Object.keys(scene.entities).length, 0),
      collectionCount: Object.values(this.#document.scenes).reduce((sum, scene) => sum + Object.keys(scene.collections).length, 0),
      undoAvailable: this.#undoStack.length > 0,
      redoAvailable: this.#redoStack.length > 0,
      latestTransactionId: this.#history.at(-1)?.transactionId ?? null,
    };
  }

  subscribe(listener) {
    studioAssert(typeof listener === 'function', 'invalid_listener', 'Listener must be a function');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #notify(event) {
    const warnings = [];
    for (const listener of this.#listeners) {
      try {
        await listener(cloneJson(event));
      } catch (error) {
        warnings.push({ code: 'listener_failed', message: error?.message ?? String(error) });
      }
    }
    return warnings;
  }

  apply(request) {
    return this.#enqueue(async () => {
      this.#checkCommon(request, APPLY_KEYS);
      const fingerprint = contentHash(request);
      const repeated = this.#existingIdempotent(request, fingerprint);
      if (repeated) return repeated;
      this.#checkRevision(request.baseRevision);
      const before = this.#document;
      const applied = applyOperations(before, request.operations);
      const diff = computeCompactDiff(before, applied.document);
      if (request.dryRun === true) {
        const candidate = cloneJson(applied.document);
        candidate.revision = before.revision + 1;
        candidate.metadata.updatedAt = nowIso(this.#clock);
        assertValidProjectDocument(candidate);
        if (this.#prepare) {
          await this.#prepare(cloneJson(candidate), {
            transactionId: null,
            kind: 'apply',
            label: boundedLabel(request.label),
            invalidations: cloneJson(applied.invalidations),
            dryRun: true,
          });
        }
        return {
          success: true,
          dryRun: true,
          revision: before.revision,
          expectedRevision: before.revision + 1,
          transactionId: null,
          resolvedIds: applied.resolvedIds,
          changedIds: diff.changedIds,
          deletedIds: diff.deletedIds,
          invalidations: applied.invalidations,
          diff: diff.changes,
          diagnostics: [],
          warnings: [],
          dirty: this.dirty,
        };
      }
      return this.#commit({
        kind: 'apply',
        label: boundedLabel(request.label),
        idempotencyKey: request.idempotencyKey,
        requestFingerprint: fingerprint,
        before,
        applied,
        diff,
      });
    });
  }

  async #commit({
    kind,
    label,
    idempotencyKey,
    requestFingerprint,
    before,
    applied,
    diff,
    compensates,
    replays,
  }) {
    const transactionId = this.#transactionIdFactory(kind === 'apply' ? 'tx' : kind);
    studioAssert(typeof transactionId === 'string' && transactionId.length > 0, 'invalid_transaction_id', 'transactionIdFactory returned an invalid ID');
    studioAssert(!this.#transactions.has(transactionId), 'duplicate_transaction_id', `Transaction ID ${transactionId} is already in use`);
    const candidate = applied.document;
    candidate.revision = before.revision + 1;
    candidate.metadata.updatedAt = nowIso(this.#clock);
    assertValidProjectDocument(candidate);
    if (this.#prepare) {
      await this.#prepare(cloneJson(candidate), {
        transactionId,
        kind,
        label,
        invalidations: cloneJson(applied.invalidations),
      });
    }
    const response = {
      success: true,
      dryRun: false,
      revision: candidate.revision,
      transactionId,
      resolvedIds: cloneJson(applied.resolvedIds),
      changedIds: diff.changedIds,
      deletedIds: diff.deletedIds,
      invalidations: applied.invalidations,
      diff: diff.changes,
      diagnostics: [],
      warnings: [],
      dirty: candidate.revision !== candidate.savedRevision,
      ...(compensates ? { compensatedTransactionId: compensates } : {}),
      ...(replays ? { replayedTransactionId: replays } : {}),
    };
    const entry = {
      kind,
      transactionId,
      revision: candidate.revision,
      baseRevision: before.revision,
      label,
      timestamp: candidate.metadata.updatedAt,
      idempotencyKey,
      requestFingerprint,
      forwardOperations: cloneJson(applied.resolvedOperations),
      inverseOperations: cloneJson(applied.inverseOperations),
      resolvedIds: cloneJson(applied.resolvedIds),
      changedIds: diff.changedIds,
      deletedIds: diff.deletedIds,
      invalidations: applied.invalidations,
      diff: diff.changes,
      ...(compensates ? { compensates } : {}),
      ...(replays ? { replays } : {}),
      response: cloneJson(response),
    };
    const persistence = this.store ? await this.store.writeRecovery(candidate, entry) : null;
    this.#document = candidate;
    this.#history.push(entry);
    this.#transactions.set(transactionId, entry);
    this.#idempotency.set(idempotencyKey, { fingerprint: requestFingerprint, response: cloneResponse(response) });
    if (persistence?.warnings?.length) response.warnings.push(...persistence.warnings);
    if (kind === 'apply') {
      this.#undoStack.push(transactionId);
      this.#redoStack = [];
    }
    response.warnings.push(...await this.#notify({
      type: 'commit',
      transactionId,
      revision: candidate.revision,
      changedIds: diff.changedIds,
      deletedIds: diff.deletedIds,
      invalidations: applied.invalidations,
    }));
    return cloneResponse(response);
  }

  undo(request) {
    return this.#enqueue(async () => {
      this.#checkCommon(request, HISTORY_KEYS);
      const fingerprint = contentHash({ action: 'undo', ...request });
      const repeated = this.#existingIdempotent(request, fingerprint);
      if (repeated) return repeated;
      this.#checkRevision(request.baseRevision);
      const targetId = request.transactionId ?? this.#undoStack.at(-1);
      studioAssert(targetId, 'nothing_to_undo', 'There is no transaction to undo');
      studioAssert(this.#undoStack.includes(targetId), 'history_conflict', `Transaction ${targetId} is not currently undoable`);
      const target = this.#transactions.get(targetId);
      studioAssert(target?.kind === 'apply', 'history_conflict', `Transaction ${targetId} is not an authoring transaction`);
      const before = this.#document;
      const applied = applyOperations(before, target.inverseOperations, { allowInternal: true });
      const diff = computeCompactDiff(before, applied.document);
      const response = await this.#commit({
        kind: 'undo',
        label: boundedLabel(request.label),
        idempotencyKey: request.idempotencyKey,
        requestFingerprint: fingerprint,
        before,
        applied,
        diff,
        compensates: targetId,
      });
      this.#undoStack = this.#undoStack.filter((id) => id !== targetId);
      this.#redoStack.push(targetId);
      return response;
    });
  }

  redo(request) {
    return this.#enqueue(async () => {
      this.#checkCommon(request, HISTORY_KEYS);
      const fingerprint = contentHash({ action: 'redo', ...request });
      const repeated = this.#existingIdempotent(request, fingerprint);
      if (repeated) return repeated;
      this.#checkRevision(request.baseRevision);
      const targetId = request.transactionId ?? this.#redoStack.at(-1);
      studioAssert(targetId, 'nothing_to_redo', 'There is no transaction to redo');
      studioAssert(this.#redoStack.includes(targetId), 'history_conflict', `Transaction ${targetId} is not currently redoable`);
      const target = this.#transactions.get(targetId);
      studioAssert(target?.kind === 'apply', 'history_conflict', `Transaction ${targetId} is not an authoring transaction`);
      const before = this.#document;
      const applied = applyOperations(before, target.forwardOperations, { allowInternal: true });
      const diff = computeCompactDiff(before, applied.document);
      const response = await this.#commit({
        kind: 'redo',
        label: boundedLabel(request.label),
        idempotencyKey: request.idempotencyKey,
        requestFingerprint: fingerprint,
        before,
        applied,
        diff,
        replays: targetId,
      });
      this.#redoStack = this.#redoStack.filter((id) => id !== targetId);
      this.#undoStack.push(targetId);
      return response;
    });
  }

  history({ limit = 50, beforeRevision = Number.POSITIVE_INFINITY, includeOperations = false } = {}) {
    const boundedLimit = Math.max(1, Math.min(200, limit));
    return this.#history
      .filter((entry) => entry.revision < beforeRevision)
      .slice(-boundedLimit)
      .reverse()
      .map((entry) => {
        const copy = cloneJson(entry);
        delete copy.response;
        if (!includeOperations) {
          delete copy.forwardOperations;
          delete copy.inverseOperations;
        }
        return copy;
      });
  }

  changedSince(revision) {
    studioAssert(Number.isSafeInteger(revision) && revision >= 0, 'invalid_revision', 'revision must be a non-negative safe integer');
    return changedIdsSince(this.#history, revision);
  }

  save() {
    return this.#enqueue(async () => {
      studioAssert(this.store, 'persistence_unavailable', 'Kernel has no project store');
      const result = await this.store.save(this.#document);
      this.#document = result.document;
      return {
        success: true,
        revision: this.#document.revision,
        savedRevision: this.#document.savedRevision,
        dirty: false,
        path: result.path,
        manifest: result.manifest,
        warnings: result.warnings ?? [],
      };
    });
  }
}
