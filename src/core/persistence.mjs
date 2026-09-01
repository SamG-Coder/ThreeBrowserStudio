import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FORMAT_VERSION, PROTOCOL_VERSION, RESOURCE_TYPES } from './constants.mjs';
import { assertValidProjectDocument, normalizeProjectDocument } from './documents.mjs';
import { StudioError } from './errors.mjs';
import { cloneJson, contentHash, stableStringify } from './util.mjs';

const MAX_PROJECT_JSON_BYTES = 64 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveInsideProject(projectRoot, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw new StudioError('invalid_project_path', 'Project paths must be non-empty relative paths', { relativePath });
  }
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, relativePath);
  if (!pathIsInside(root, resolved)) {
    throw new StudioError('project_path_escape', `Path escapes project root: ${relativePath}`, { root, relativePath });
  }
  return resolved;
}

async function exists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function assertNoSymlinkComponents(projectRoot, targetPath) {
  const root = path.resolve(projectRoot);
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root && process.platform !== 'win32') {
    throw new StudioError('project_symlink', 'Project root cannot be a symbolic link', { root, canonicalRoot });
  }
  const relative = path.relative(root, targetPath);
  let cursor = root;
  for (const segment of relative.split(path.sep).slice(0, -1)) {
    if (!segment) continue;
    cursor = path.join(cursor, segment);
    if (!(await exists(cursor))) break;
    const stats = await lstat(cursor);
    if (stats.isSymbolicLink()) {
      const destination = await realpath(cursor);
      if (!pathIsInside(canonicalRoot, destination)) {
        throw new StudioError('project_path_escape', 'Symbolic link escapes project root', { path: cursor, destination });
      }
      throw new StudioError('project_symlink', 'Writes through symbolic links are not allowed', { path: cursor });
    }
  }
}

async function assertReadRemainsInside(projectRoot, targetPath) {
  const canonicalRoot = await realpath(path.resolve(projectRoot));
  let canonicalTarget;
  try {
    canonicalTarget = await realpath(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!pathIsInside(canonicalRoot, canonicalTarget)) {
    throw new StudioError('project_path_escape', 'Symbolic link escapes project root', {
      path: targetPath,
      destination: canonicalTarget,
    });
  }
}

export async function atomicWriteFile(filePath, data, { projectRoot } = {}) {
  const target = path.resolve(filePath);
  if (projectRoot) await assertNoSymlinkComponents(projectRoot, target);
  await mkdir(path.dirname(target), { recursive: true });
  if (projectRoot) await assertNoSymlinkComponents(projectRoot, target);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw new StudioError('persistence_failed', `Could not atomically write ${target}`, { path: target, cause: error });
  }
}

export async function atomicWriteJson(filePath, value, options) {
  await atomicWriteFile(filePath, `${stableStringify(value, 2)}\n`, options);
}

function safeFileStem(id) {
  return encodeURIComponent(id).replaceAll('%', '_');
}

async function readJson(filePath, maxBytes = MAX_PROJECT_JSON_BYTES) {
  try {
    const info = await lstat(filePath);
    if (info.size > maxBytes) {
      throw new StudioError('project_file_too_large', `Project file exceeds ${maxBytes} bytes`, {
        path: filePath,
        size: info.size,
        maxBytes,
      });
    }
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new StudioError('invalid_json', `Invalid JSON in ${filePath}`, { path: filePath, cause: error });
    throw error;
  }
}

function toManifest(document, sceneIndex, resourceIndex) {
  return {
    kind: 'ThreeStudioProjectManifest',
    protocolVersion: PROTOCOL_VERSION,
    formatVersion: FORMAT_VERSION,
    projectId: document.projectId,
    name: document.name,
    revision: document.revision,
    savedRevision: document.revision,
    activeSceneId: document.activeSceneId,
    sceneOrder: [...document.sceneOrder],
    sceneIndex,
    resourceIndex,
    scripts: cloneJson(document.scripts),
    scriptTrustPolicy: document.scriptTrustPolicy,
    settings: cloneJson(document.settings),
    exportSettings: cloneJson(document.exportSettings),
    metadata: cloneJson(document.metadata),
    documentHash: contentHash({
      projectId: document.projectId,
      revision: document.revision,
      sceneIndex,
      resourceIndex,
      scripts: document.scripts,
    }),
  };
}

function managedManifestPaths(manifest) {
  const paths = [];
  for (const item of manifest?.sceneIndex ?? []) if (typeof item?.path === 'string') paths.push(item.path);
  for (const item of Object.values(manifest?.resourceIndex ?? {})) if (typeof item?.path === 'string') paths.push(item.path);
  return paths;
}

function isManagedBlobPath(relativePath) {
  const normalized = String(relativePath).replaceAll('\\', '/');
  return /^scenes\/[a-zA-Z0-9_.%-]+\.scene\.json$/.test(normalized)
    || /^resources\/[a-zA-Z0-9_.%-]+\.json$/.test(normalized);
}

export class AtomicProjectStore {
  constructor(projectRoot, { faultInjector = null } = {}) {
    this.root = path.resolve(projectRoot);
    this.faultInjector = typeof faultInjector === 'function' ? faultInjector : null;
    this.manifestPath = resolveInsideProject(this.root, 'project.threestudio.json');
    this.recoveryPath = resolveInsideProject(this.root, '.studio/recovery.json');
    this.viewPath = resolveInsideProject(this.root, '.studio/view.json');
    this.journalPath = resolveInsideProject(this.root, 'history/journal.ndjson');
  }

  async #fault(point, details = {}) {
    await this.faultInjector?.(point, details);
  }

  async initialize() {
    await mkdir(this.root, { recursive: true });
    const rootStats = await lstat(this.root);
    if (rootStats.isSymbolicLink()) throw new StudioError('project_symlink', 'Project root cannot be a symbolic link', { root: this.root });
    for (const directory of ['scenes', 'resources', 'graphs/shaders', 'graphs/textures', 'graphs/blueprints', 'scripts', 'assets', 'generated', 'renders', 'history/snapshots', '.studio']) {
      const target = resolveInsideProject(this.root, directory);
      const sentinel = path.join(target, '.three-studio-path-check');
      await assertNoSymlinkComponents(this.root, sentinel);
      await mkdir(target, { recursive: true });
      await assertNoSymlinkComponents(this.root, sentinel);
    }
    return this;
  }

  async writeRecovery(document, journalEntry) {
    assertValidProjectDocument(document);
    await this.initialize();
    let current = null;
    try {
      current = await readJson(this.recoveryPath);
    } catch (error) {
      if (error.code !== 'project_file_too_large') throw error;
    }
    if (current?.journalEntry) {
      const journal = await this.readJournal();
      if (!journal.some((item) => item.transactionId === current.journalEntry.transactionId)) {
        await this.appendJournal(current.journalEntry);
      }
    }
    const envelope = {
      kind: 'ThreeStudioRecovery',
      protocolVersion: PROTOCOL_VERSION,
      projectId: document.projectId,
      revision: document.revision,
      documentHash: contentHash(document),
      document: cloneJson(document),
      transactionId: journalEntry?.transactionId ?? null,
      journalEntry: journalEntry ? cloneJson(journalEntry) : null,
    };
    await this.#fault('apply.beforeRecoveryPublish', { document, journalEntry });
    await atomicWriteJson(this.recoveryPath, envelope, { projectRoot: this.root });
    const warnings = [];
    if (journalEntry) {
      try {
        await this.#fault('apply.afterRecoveryPublish.beforeJournalAppend', { document, journalEntry });
        await this.appendJournal(journalEntry);
      } catch (error) {
        warnings.push({
          code: 'journal_deferred',
          message: `Transaction ${journalEntry.transactionId} committed to recovery; journal repair is deferred.`,
        });
      }
    }
    return { envelope, warnings };
  }

  async appendJournal(entry) {
    await this.initialize();
    const existing = await this.readJournal();
    const duplicate = existing.find((item) => item.transactionId === entry.transactionId);
    if (duplicate) {
      if (contentHash(duplicate) !== contentHash(entry)) throw new StudioError('journal_conflict', `Transaction ${entry.transactionId} already has different journal content`);
      return duplicate;
    }
    const next = [...existing, cloneJson(entry)].map((item) => stableStringify(item)).join('\n');
    await this.#fault('journal.beforePublish', { entry });
    await atomicWriteFile(this.journalPath, `${next}\n`, { projectRoot: this.root });
    return entry;
  }

  async readJournal() {
    await assertReadRemainsInside(this.root, this.journalPath);
    let text;
    try {
      const info = await lstat(this.journalPath);
      if (info.size > MAX_JOURNAL_BYTES) {
        throw new StudioError('journal_too_large', `Project journal exceeds ${MAX_JOURNAL_BYTES} bytes`, {
          path: this.journalPath,
          size: info.size,
          maxBytes: MAX_JOURNAL_BYTES,
        });
      }
      text = await readFile(this.journalPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const entries = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch (error) {
        throw new StudioError('invalid_journal', `Invalid journal entry on line ${index + 1}`, { line: index + 1, cause: error });
      }
    }
    return entries;
  }

  async save(document) {
    assertValidProjectDocument(document);
    await this.initialize();
    const previousManifest = await readJson(this.manifestPath).catch(() => null);
    const saved = cloneJson(document);
    saved.savedRevision = saved.revision;
    const sceneIndex = [];
    for (const sceneId of saved.sceneOrder) {
      const scene = saved.scenes[sceneId];
      const hash = contentHash(scene);
      const relativePath = `scenes/${safeFileStem(sceneId)}.${hash}.scene.json`;
      await atomicWriteJson(resolveInsideProject(this.root, relativePath), scene, { projectRoot: this.root });
      sceneIndex.push({ id: sceneId, path: relativePath, hash });
    }
    const resourceIndex = {};
    for (const type of RESOURCE_TYPES) {
      const table = saved.resources[type];
      const hash = contentHash(table);
      const relativePath = `resources/${type}.${hash}.json`;
      await atomicWriteJson(resolveInsideProject(this.root, relativePath), table, { projectRoot: this.root });
      resourceIndex[type] = { path: relativePath, hash, count: Object.keys(table).length };
    }
    const manifest = toManifest(saved, sceneIndex, resourceIndex);
    await this.#fault('save.beforeManifestPublish', { document: saved, manifest });
    await atomicWriteJson(this.manifestPath, manifest, { projectRoot: this.root });
    const warnings = [];
    try {
      await this.#fault('save.afterManifestPublish', { document: saved, manifest });
      const recovery = await this.writeRecovery(saved, null);
      warnings.push(...recovery.warnings);
    } catch (error) {
      warnings.push({
        code: 'post_save_recovery_deferred',
        message: 'The named save committed, but its recovery mirror could not be refreshed.',
      });
    }
    const retained = new Set(managedManifestPaths(manifest));
    try {
      for (const relativePath of managedManifestPaths(previousManifest)) {
        if (!retained.has(relativePath) && isManagedBlobPath(relativePath)) {
          await rm(resolveInsideProject(this.root, relativePath), { force: true });
        }
      }
    } catch (error) {
      warnings.push({
        code: 'superseded_blob_cleanup_deferred',
        message: 'The named save committed, but superseded immutable blobs remain for later cleanup.',
      });
    }
    return { document: saved, manifest, path: this.manifestPath, warnings };
  }

  async #loadNamed() {
    await assertReadRemainsInside(this.root, this.manifestPath);
    const manifest = await readJson(this.manifestPath);
    if (!manifest) return null;
    if (manifest.kind !== 'ThreeStudioProjectManifest' || manifest.protocolVersion !== PROTOCOL_VERSION || manifest.formatVersion !== FORMAT_VERSION) {
      throw new StudioError('manifest_mismatch', 'Unsupported ThreeBrowser Studio project manifest');
    }
    const scenes = {};
    for (const item of manifest.sceneIndex ?? []) {
      const scenePath = resolveInsideProject(this.root, item.path);
      await assertReadRemainsInside(this.root, scenePath);
      const scene = await readJson(scenePath);
      if (!scene) throw new StudioError('missing_project_file', `Missing scene file ${item.path}`);
      if (contentHash(scene) !== item.hash) throw new StudioError('content_hash_mismatch', `Scene ${item.id} does not match its manifest hash`);
      scenes[item.id] = scene;
    }
    const resources = {};
    for (const type of RESOURCE_TYPES) {
      const item = manifest.resourceIndex?.[type];
      const resourcePath = item ? resolveInsideProject(this.root, item.path) : null;
      if (resourcePath) await assertReadRemainsInside(this.root, resourcePath);
      const table = item ? await readJson(resourcePath) : {};
      if (item && contentHash(table) !== item.hash) throw new StudioError('content_hash_mismatch', `Resource index ${type} does not match its manifest hash`);
      resources[type] = table ?? {};
    }
    return normalizeProjectDocument({
      kind: 'ThreeStudioProject',
      protocolVersion: manifest.protocolVersion,
      formatVersion: manifest.formatVersion,
      projectId: manifest.projectId,
      name: manifest.name,
      revision: manifest.revision,
      savedRevision: manifest.revision,
      activeSceneId: manifest.activeSceneId,
      sceneOrder: manifest.sceneOrder,
      scenes,
      resources,
      scripts: manifest.scripts ?? {},
      scriptTrustPolicy: manifest.scriptTrustPolicy,
      settings: manifest.settings,
      exportSettings: manifest.exportSettings,
      metadata: manifest.metadata,
    });
  }

  async load() {
    await this.initialize();
    let namedDocument;
    let namedError = null;
    try {
      namedDocument = await this.#loadNamed();
    } catch (error) {
      namedError = error;
      namedDocument = null;
    }
    await assertReadRemainsInside(this.root, this.recoveryPath);
    const recovery = await readJson(this.recoveryPath);
    let journal = await this.readJournal();
    let document = namedDocument;
    let recovered = false;
    if (recovery) {
      if (recovery.kind !== 'ThreeStudioRecovery' || recovery.protocolVersion !== PROTOCOL_VERSION) throw new StudioError('recovery_mismatch', 'Unsupported recovery document');
      if (contentHash(recovery.document) !== recovery.documentHash) throw new StudioError('content_hash_mismatch', 'Recovery document hash does not match');
      const candidate = normalizeProjectDocument(recovery.document);
      if (!namedDocument || (candidate.projectId === namedDocument.projectId && candidate.revision > namedDocument.revision)) {
        document = candidate;
        recovered = true;
      }
    }
    if (!document) {
      if (namedError) throw namedError;
      throw new StudioError('project_not_found', `No project exists at ${this.root}`, { root: this.root });
    }
    if (recovered && recovery?.journalEntry && !journal.some((entry) => entry.transactionId === recovery.journalEntry.transactionId)) {
      journal = [...journal, cloneJson(recovery.journalEntry)];
      await this.appendJournal(recovery.journalEntry).catch(() => {});
    }
    return {
      document,
      namedDocument,
      recovered,
      dirty: document.revision !== (namedDocument?.revision ?? -1),
      journal,
    };
  }

  async writeView(view) {
    await this.initialize();
    await atomicWriteJson(this.viewPath, view, { projectRoot: this.root });
  }

  async readView() {
    await this.initialize();
    await assertReadRemainsInside(this.root, this.viewPath);
    return (await readJson(this.viewPath)) ?? {};
  }
}
