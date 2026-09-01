import { PROTOCOL_VERSION } from '../core/constants.mjs';
import { createBlankProjectDocument } from '../core/documents.mjs';
import { createBrowserPreviewDocument } from '../core/project-pack.mjs';
import { createTransactionId } from '../core/util.mjs';

function freshSuffix(clock) {
  const value = Number(clock());
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : Date.now())).toString(36);
}

function targetFrom(application) {
  const status = application?.status?.();
  if (!status?.projectId || !status?.activeSceneId) {
    throw new Error('The Studio project is not ready yet.');
  }
  return status;
}

export function createProjectWorkspaceActions({
  application: getApplication,
  native = false,
  exportProject,
  importProject,
  clock = Date.now,
} = {}) {
  const application = () => {
    const value = typeof getApplication === 'function' ? getApplication() : getApplication;
    if (!value) throw new Error('The Studio project is not ready yet.');
    return value;
  };

  async function createProject(template) {
    const studio = application();
    const suffix = freshSuffix(clock);
    const starter = template === 'starter';
    const name = starter ? 'Starter Project' : 'Untitled Project';
    if (native) {
      const current = targetFrom(studio);
      await studio.dispatch('three_studio_project', {
        protocolVersion: PROTOCOL_VERSION,
        sessionId: current.sessionId,
        action: 'create',
        path: `${starter ? 'starter' : 'untitled'}-${suffix}`,
        name,
        template,
        idempotencyKey: createTransactionId('toolbar-create'),
        label: `Create ${template} project from Studio toolbar`,
      });
    } else {
      const document = starter
        ? { ...createBrowserPreviewDocument(), projectId: `project/starter-${suffix}`, name }
        : createBlankProjectDocument({ projectId: `project/untitled-${suffix}`, name, clock });
      await studio.importProjectDocument(document);
    }
    return `Started ${name}.`;
  }

  async function clearScene() {
    const studio = application();
    const current = targetFrom(studio);
    const digest = await studio.dispatch('three_studio_inspect', {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: current.sessionId,
      projectId: current.projectId,
      sceneId: current.activeSceneId,
      query: 'sceneDigest',
      include: ['summary'],
      limit: 1,
    });
    const sceneId = digest.scene?.id ?? current.activeSceneId;
    const expectedSceneHash = digest.scene?.sceneHash;
    if (!expectedSceneHash) throw new Error('Studio could not verify the active scene before clearing it.');
    await studio.dispatch('three_studio_apply', {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: current.sessionId,
      projectId: current.projectId,
      baseRevision: digest.revision ?? current.revision,
      idempotencyKey: createTransactionId('toolbar-clear'),
      label: 'Clear active scene from Studio toolbar',
      operations: [{ op: 'scene.clear', sceneId, expectedSceneHash }],
    });
    return `Cleared ${digest.scene?.name ?? 'the active scene'}.`;
  }

  async function saveProject() {
    const studio = application();
    if (!native) {
      if (typeof exportProject !== 'function') throw new Error('Save is unavailable in this browser.');
      return exportProject();
    }
    const current = targetFrom(studio);
    await studio.dispatch('three_studio_project', {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: current.sessionId,
      action: 'save',
      projectId: current.projectId,
      baseRevision: current.revision,
      idempotencyKey: createTransactionId('toolbar-save'),
      label: 'Save project from Studio toolbar',
    });
    return `Saved ${current.projectName ?? 'project'}.`;
  }

  return Object.freeze({
    async run(action) {
      if (action === 'new-blank') return createProject('blank');
      if (action === 'new-starter') return createProject('starter');
      if (action === 'clear-scene') return clearScene();
      if (action === 'save') return saveProject();
      if (action === 'save-as' || action === 'export') {
        if (typeof exportProject !== 'function') throw new Error('Export is unavailable in this host.');
        return exportProject();
      }
      if (action === 'import') {
        if (typeof importProject !== 'function') throw new Error('Import is unavailable in this host.');
        return importProject();
      }
      throw new Error(`Unknown project action ${action}.`);
    },
  });
}
