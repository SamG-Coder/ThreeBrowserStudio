import { queryEntityComponentCatalog } from '../core/component-catalog.mjs';
import { createTransactionId, stableStringify } from '../core/util.mjs';

const STYLE_ID = 'tbs-component-composer-style';

function ensureStyle(document) {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .tbs-component-composer { position: fixed; z-index: 45; right: 16px; top: 58px; width: min(390px, calc(100vw - 32px)); max-height: calc(100vh - 76px); overflow: auto; color: #dce8f7; background: rgba(10,17,27,.96); border: 1px solid rgba(137,177,218,.36); border-radius: 13px; box-shadow: 0 18px 54px rgba(0,0,0,.45); font: 13px/1.4 "Segoe UI",sans-serif; }
    .tbs-component-composer[hidden] { display: none; }
    .tbs-component-composer header { position: sticky; top: 0; z-index: 1; display:flex; align-items:center; gap:8px; padding:12px 14px; background:#0d1825; border-bottom:1px solid rgba(137,177,218,.22); }
    .tbs-component-composer h2 { flex:1; margin:0; font-size:14px; }
    .tbs-component-composer header button { border:0; color:#a9bdd3; background:transparent; cursor:pointer; font-size:18px; }
    .tbs-component-composer section { padding:12px 14px; }
    .tbs-component-composer h3 { margin:0 0 8px; color:#91bde9; font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    .tbs-component-list { min-height:58px; display:grid; gap:7px; padding:7px; border:1px dashed rgba(137,177,218,.28); border-radius:9px; }
    .tbs-component-card { display:grid; grid-template-columns:1fr auto; gap:3px 8px; padding:9px 10px; border:1px solid rgba(137,177,218,.24); border-radius:8px; background:#132235; cursor:grab; }
    .tbs-component-card strong { font-size:13px; }
    .tbs-component-card small { grid-column:1; color:#849ab1; }
    .tbs-component-card button { grid-column:2; grid-row:1 / span 2; align-self:center; border:0; border-radius:6px; padding:5px 8px; color:#e6f2ff; background:#244968; cursor:pointer; }
    .tbs-component-card[aria-disabled="true"] { opacity:.48; cursor:not-allowed; }
    .tbs-component-actions { position:sticky; bottom:0; display:flex; align-items:center; gap:8px; padding:11px 14px; background:#0d1825; border-top:1px solid rgba(137,177,218,.22); }
    .tbs-component-actions span { flex:1; color:#8ba1b8; font-size:12px; }
    .tbs-component-actions button { border:0; border-radius:7px; padding:7px 12px; color:#e8f3ff; background:#244968; cursor:pointer; }
    .tbs-component-actions button:last-child { background:#2d6b50; }
  `;
  document.head.appendChild(style);
}

function element(document, name, props = {}, text = '') {
  const node = document.createElement(name);
  Object.assign(node, props);
  if (text) node.textContent = text;
  return node;
}

export function createComponentComposer({ document = globalThis.document, application } = {}) {
  if (!document?.body || !application?.dispatch) throw new TypeError('document and browser Studio application are required.');
  ensureStyle(document);
  const host = element(document, 'aside', { className: 'tbs-component-composer', hidden: true });
  const header = element(document, 'header');
  const title = element(document, 'h2', {}, 'Object Components');
  const close = element(document, 'button', { type: 'button', ariaLabel: 'Close' }, '×');
  header.append(title, close);
  const attachedSection = element(document, 'section');
  attachedSection.append(element(document, 'h3', {}, 'Attached'));
  const attachedList = element(document, 'div', { className: 'tbs-component-list' });
  attachedSection.append(attachedList);
  const availableSection = element(document, 'section');
  availableSection.append(element(document, 'h3', {}, 'Available — drag to attach'));
  const availableList = element(document, 'div', { className: 'tbs-component-list' });
  availableSection.append(availableList);
  const actions = element(document, 'div', { className: 'tbs-component-actions' });
  const status = element(document, 'span', {}, 'Select an object in Explorer.');
  const cancel = element(document, 'button', { type: 'button' }, 'Cancel');
  const apply = element(document, 'button', { type: 'button' }, 'Apply');
  actions.append(status, cancel, apply);
  host.append(header, attachedSection, availableSection, actions);
  document.body.appendChild(host);

  let entityId = null;
  let original = {};
  let staged = {};

  function activeEntity() {
    const project = application.document;
    return project.scenes[project.activeSceneId]?.entities?.[entityId] ?? null;
  }

  function canSatisfy(item) {
    const project = application.document;
    if (item.requires.includes('blueprint-graph')) {
      return Object.values(project.resources?.graphs ?? {}).some(resource => resource.graph?.domain === 'blueprint');
    }
    if (item.requires.includes('audio-resource')) return Object.keys(project.resources?.audio ?? {}).length > 0;
    return true;
  }

  function valueFor(item) {
    const value = structuredClone(item.defaults);
    const project = application.document;
    if (item.id === 'logic') {
      const graph = Object.values(project.resources.graphs).find(resource => resource.graph?.domain === 'blueprint');
      value.graphIds = graph ? [graph.id] : [];
    }
    if (item.id === 'audio') value.audioId = Object.keys(project.resources.audio)[0];
    return value;
  }

  function addComponent(id) {
    const entity = activeEntity();
    const item = queryEntityComponentCatalog({ entityKind: entity?.kind }).find(entry => entry.id === id);
    if (!item?.compatible || !canSatisfy(item)) return;
    staged[id] = valueFor(item);
    render();
  }

  function removeComponent(id) {
    delete staged[id];
    render();
  }

  function card(item, attached) {
    const enabled = item.compatible && (attached || canSatisfy(item));
    const node = element(document, 'div', { className: 'tbs-component-card', draggable: enabled, ariaDisabled: String(!enabled) });
    node.dataset.component = item.id;
    node.append(element(document, 'strong', {}, item.label), element(document, 'small', {}, enabled ? item.description : `Requires ${item.requires.join(', ') || 'a compatible object'}.`));
    const button = element(document, 'button', { type: 'button', disabled: !enabled }, attached ? 'Remove' : 'Add');
    button.addEventListener('click', () => attached ? removeComponent(item.id) : addComponent(item.id));
    node.append(button);
    node.addEventListener('dragstart', event => event.dataTransfer?.setData('text/x-three-studio-component', item.id));
    return node;
  }

  function render() {
    attachedList.replaceChildren();
    availableList.replaceChildren();
    const entity = activeEntity();
    if (!entity) {
      host.hidden = true;
      return;
    }
    title.textContent = `${entity.name} · Components`;
    const catalog = queryEntityComponentCatalog({ entityKind: entity.kind, installed: Object.keys(staged) });
    for (const item of catalog) {
      if (staged[item.id] !== undefined) attachedList.append(card(item, true));
      else availableList.append(card(item, false));
    }
    if (attachedList.childElementCount === 0) attachedList.append(element(document, 'small', {}, 'Drop a component here.'));
    const changed = stableStringify(original) !== stableStringify(staged);
    status.textContent = changed ? 'Staged changes are not saved.' : `${Object.keys(staged).length} components attached.`;
    apply.disabled = !changed;
  }

  attachedList.addEventListener('dragover', event => event.preventDefault());
  attachedList.addEventListener('drop', event => {
    event.preventDefault();
    addComponent(event.dataTransfer?.getData('text/x-three-studio-component'));
  });
  close.addEventListener('click', () => { host.hidden = true; });
  cancel.addEventListener('click', () => { staged = structuredClone(original); render(); });
  apply.addEventListener('click', async () => {
    const operations = [];
    for (const id of new Set([...Object.keys(original), ...Object.keys(staged)])) {
      if (original[id] === undefined && staged[id] !== undefined) operations.push({ op: 'entity.component.attach', entityId, component: id, value: staged[id] });
      else if (original[id] !== undefined && staged[id] === undefined) operations.push({ op: 'entity.component.remove', entityId, component: id });
    }
    if (!operations.length) return;
    apply.disabled = true;
    status.textContent = 'Compiling and applying…';
    try {
      await application.dispatch('three_studio_apply', {
        baseRevision: application.document.revision,
        idempotencyKey: createTransactionId('ui-component'),
        label: `Update components on ${entityId}`,
        operations,
      });
      const entity = activeEntity();
      original = structuredClone(entity?.components ?? {});
      staged = structuredClone(original);
      render();
    } catch (error) {
      status.textContent = error?.message ?? String(error);
      apply.disabled = false;
    }
  });

  return Object.freeze({
    open(nextEntityId) {
      entityId = nextEntityId;
      const entity = activeEntity();
      if (!entity) return false;
      original = structuredClone(entity.components ?? {});
      staged = structuredClone(original);
      host.hidden = false;
      render();
      return true;
    },
    close() { host.hidden = true; },
    dispose() { host.remove(); },
  });
}
