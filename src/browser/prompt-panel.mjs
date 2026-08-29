const DOCK_ID = 'tbs-prompt-dock';
const MODAL_ID = 'tbs-prompt-modal';
const STYLE_ID = 'tbs-prompt-dock-style';

const STYLE_TEXT = `
#${DOCK_ID}, #${MODAL_ID} { box-sizing: border-box; }
#${DOCK_ID} *, #${MODAL_ID} * { box-sizing: border-box; }
#${DOCK_ID} {
  position: fixed;
  left: 50%;
  bottom: 20px;
  z-index: 30;
  display: none;
  width: min(880px, calc(100vw - 32px));
  transform: translateX(-50%);
  color: #e8eef6;
  background: rgba(10, 15, 24, 0.92);
  border: 1px solid rgba(150, 186, 226, 0.22);
  border-radius: 16px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.46);
  font: 14px/1.4 "Segoe UI", sans-serif;
  backdrop-filter: blur(18px);
}
#${DOCK_ID}.is-visible { display: block; }
#${DOCK_ID} .tbs-dock-bar {
  display: grid;
  grid-template-columns: auto minmax(140px, 200px) 1fr auto auto;
  gap: 10px;
  align-items: center;
  padding: 12px 14px;
}
#${DOCK_ID} .tbs-dock-brand {
  padding: 0 2px 0 4px;
  font: 650 11px/1 "Segoe UI", sans-serif;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #9fc6f2;
}
#${DOCK_ID} input, #${DOCK_ID} select, #${DOCK_ID} textarea,
#${MODAL_ID} input, #${MODAL_ID} select, #${MODAL_ID} textarea {
  width: 100%;
  margin: 0;
  padding: 10px 12px;
  color: #e8eef6;
  background: rgba(7, 12, 20, 0.96);
  border: 1px solid rgba(150, 186, 226, 0.28);
  border-radius: 10px;
  font: inherit;
}
#${DOCK_ID} textarea { min-height: 42px; max-height: 88px; resize: none; }
#${DOCK_ID} button, #${MODAL_ID} button {
  margin: 0;
  padding: 10px 14px;
  color: #e8eef6;
  background: rgba(28, 46, 70, 0.96);
  border: 1px solid rgba(126, 176, 232, 0.28);
  border-radius: 10px;
  font: 600 13px/1.2 "Segoe UI", sans-serif;
  cursor: pointer;
}
#${DOCK_ID} button.primary, #${MODAL_ID} button.primary {
  background: #2f6aa3;
  border-color: #8ebef0;
}
#${DOCK_ID} button.secondary, #${MODAL_ID} button.secondary {
  background: rgba(16, 26, 40, 0.96);
}
#${MODAL_ID} {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: none;
  place-items: center;
  padding: 24px;
}
#${MODAL_ID}.is-open { display: grid; }
#${MODAL_ID} .tbs-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(4, 8, 14, 0.62);
}
#${MODAL_ID} .tbs-dialog {
  position: relative;
  width: min(520px, 100%);
  max-height: min(80vh, 640px);
  overflow: auto;
  padding: 22px 22px 18px;
  color: #e8eef6;
  background: #101722;
  border: 1px solid rgba(150, 186, 226, 0.24);
  border-radius: 16px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
  font: 14px/1.45 "Segoe UI", sans-serif;
}
#${MODAL_ID} .tbs-dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
#${MODAL_ID} h2 {
  margin: 0;
  font: 650 18px/1.2 "Segoe UI", sans-serif;
  color: #f3f7fc;
}
#${MODAL_ID} .tbs-lead {
  margin: 6px 0 0;
  color: #8ea2b8;
  font-size: 13px;
}
#${MODAL_ID} .tbs-field { margin: 0 0 14px; }
#${MODAL_ID} label {
  display: block;
  margin: 0 0 6px;
  color: #9fb1c6;
  font: 600 12px/1.2 "Segoe UI", sans-serif;
}
#${MODAL_ID} .tbs-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
#${MODAL_ID} .tbs-status { margin: 12px 0 0; color: #8eb4dc; font-size: 13px; }
#${MODAL_ID} .tbs-status.is-error { color: #ffadba; }
#${MODAL_ID} .tbs-log {
  min-height: 72px;
  max-height: 140px;
  margin: 12px 0 0;
  padding: 10px 12px;
  overflow: auto;
  color: #9fb1c6;
  background: #0b111a;
  border-radius: 10px;
  white-space: pre-wrap;
  word-break: break-word;
}
#${DOCK_ID} textarea,
#${MODAL_ID} .tbs-dialog,
#${MODAL_ID} .tbs-log {
  scrollbar-width: thin;
  scrollbar-color: #6d8aab rgba(12, 20, 32, 0.92);
}
#${DOCK_ID} textarea::-webkit-scrollbar,
#${MODAL_ID} .tbs-dialog::-webkit-scrollbar,
#${MODAL_ID} .tbs-log::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
#${DOCK_ID} textarea::-webkit-scrollbar-track,
#${MODAL_ID} .tbs-dialog::-webkit-scrollbar-track,
#${MODAL_ID} .tbs-log::-webkit-scrollbar-track {
  background: rgba(8, 13, 22, 0.96);
  border-radius: 8px;
}
#${DOCK_ID} textarea::-webkit-scrollbar-thumb,
#${MODAL_ID} .tbs-dialog::-webkit-scrollbar-thumb,
#${MODAL_ID} .tbs-log::-webkit-scrollbar-thumb {
  background: #6d8aab;
  border: 2px solid rgba(8, 13, 22, 0.96);
  border-radius: 8px;
}
#${DOCK_ID} textarea::-webkit-scrollbar-thumb:hover,
#${MODAL_ID} .tbs-dialog::-webkit-scrollbar-thumb:hover,
#${MODAL_ID} .tbs-log::-webkit-scrollbar-thumb:hover {
  background: #8eb4dc;
}
#${DOCK_ID} textarea::-webkit-scrollbar-button,
#${MODAL_ID} .tbs-dialog::-webkit-scrollbar-button,
#${MODAL_ID} .tbs-log::-webkit-scrollbar-button {
  display: none;
  width: 0;
  height: 0;
}
#${DOCK_ID} textarea::-webkit-scrollbar-corner,
#${MODAL_ID} .tbs-dialog::-webkit-scrollbar-corner,
#${MODAL_ID} .tbs-log::-webkit-scrollbar-corner {
  background: transparent;
}
@media (max-width: 760px) {
  #${DOCK_ID} .tbs-dock-bar {
    grid-template-columns: 1fr auto auto;
  }
  #${DOCK_ID} .tbs-dock-brand { display: none; }
}
`;

function el(document, name, attrs = {}, text = '') {
  const node = document.createElement(name);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') node.className = value;
    else if (key === 'type') node.type = value;
    else node.setAttribute(key, value);
  }
  if (text) node.textContent = text;
  return node;
}

function field(document, { label, name, type = 'text', placeholder = '' }) {
  const wrap = el(document, 'div', { className: 'tbs-field' });
  wrap.append(el(document, 'label', { for: name }, label));
  const input = el(document, 'input', {
    id: name,
    name,
    type,
    autocomplete: 'off',
    placeholder,
  });
  wrap.append(input);
  return { wrap, input };
}

/**
 * Bottom composer plus a settings modal. Native ThreeRuntime never mounts this.
 */
export function createBrowserPromptPanel({
  document: suppliedDocument,
  session,
} = {}) {
  const document = suppliedDocument ?? globalThis.document;
  if (!document?.body?.appendChild || !document.createElement) {
    throw new TypeError('A DOM document is required for the Prompt dock.');
  }
  if (!session) throw new TypeError('A browser prompt session is required.');

  if (!document.getElementById?.(STYLE_ID)) {
    const style = el(document, 'style', { id: STYLE_ID });
    style.textContent = STYLE_TEXT;
    (document.head ?? document.body).appendChild(style);
  }

  const dock = el(document, 'footer', {
    id: DOCK_ID,
    'data-studio-overlay': 'prompt',
    'aria-label': 'Studio prompt',
  });
  const modal = el(document, 'div', {
    id: MODAL_ID,
    'data-studio-overlay': 'prompt',
    'aria-hidden': 'true',
  });
  const backdrop = el(document, 'div', { className: 'tbs-backdrop' });
  const dialog = el(document, 'div', { className: 'tbs-dialog', role: 'dialog', 'aria-labelledby': 'tbs-models-title' });
  const lockView = el(document, 'div');
  const appView = el(document, 'div');
  modal.append(backdrop, dialog);
  document.body.append(dock, modal);

  const connectionSelect = el(document, 'select', { 'aria-label': 'Saved model' });
  const promptInput = el(document, 'textarea', {
    rows: '1',
    'aria-label': 'Prompt',
    placeholder: 'Ask the connected model…',
  });
  const runButton = el(document, 'button', { type: 'button', className: 'primary' }, 'Run');
  const modelsButton = el(document, 'button', { type: 'button', className: 'secondary' }, 'Models');
  const bar = el(document, 'div', { className: 'tbs-dock-bar' });
  bar.append(el(document, 'span', { className: 'tbs-dock-brand' }, 'Prompt'), connectionSelect, promptInput, runButton, modelsButton);
  dock.append(bar);

  const closeButton = el(document, 'button', { type: 'button', className: 'secondary' }, 'Close');
  const head = el(document, 'div', { className: 'tbs-dialog-head' });
  const titleBlock = el(document, 'div');
  titleBlock.append(
    el(document, 'h2', { id: 'tbs-models-title' }, 'Models'),
    el(document, 'p', { className: 'tbs-lead' }, 'Connect an HTTP chat API. Tokens stay PIN-encrypted in this browser.'),
  );
  head.append(titleBlock, closeButton);

  const pin = field(document, { label: 'PIN', name: 'tbs-pin', type: 'password' });
  const confirm = field(document, { label: 'Confirm PIN', name: 'tbs-pin-confirm', type: 'password' });
  const lockHint = el(document, 'p', { className: 'tbs-lead' });
  const unlockButton = el(document, 'button', { type: 'button', className: 'primary' }, 'Unlock');
  const createButton = el(document, 'button', { type: 'button', className: 'secondary' }, 'Create PIN');
  const lockRow = el(document, 'div', { className: 'tbs-row' });
  lockRow.append(unlockButton, createButton);
  lockView.append(lockHint, pin.wrap, confirm.wrap, lockRow);

  const kindSelect = el(document, 'select', { id: 'tbs-kind', 'aria-label': 'Provider kind' });
  for (const kind of session.listProviderKinds()) {
    kindSelect.appendChild(el(document, 'option', { value: kind.id }, kind.label));
  }
  const kindWrap = el(document, 'div', { className: 'tbs-field' });
  kindWrap.append(el(document, 'label', { for: 'tbs-kind' }, 'Provider'), kindSelect);
  const label = field(document, { label: 'Label', name: 'tbs-label', placeholder: 'OpenRouter' });
  const url = field(document, { label: 'Base URL', name: 'tbs-url', placeholder: 'https://openrouter.ai/api/v1' });
  const model = field(document, { label: 'Model', name: 'tbs-model', placeholder: 'openai/gpt-4.1-mini' });
  const token = field(document, { label: 'Token', name: 'tbs-token', type: 'password' });
  const saveButton = el(document, 'button', { type: 'button', className: 'primary' }, 'Save connection');
  const testButton = el(document, 'button', { type: 'button', className: 'secondary' }, 'Test');
  const deleteButton = el(document, 'button', { type: 'button', className: 'secondary' }, 'Remove');
  const lockButton = el(document, 'button', { type: 'button', className: 'secondary' }, 'Lock vault');
  const actionRow = el(document, 'div', { className: 'tbs-row' });
  actionRow.append(saveButton, testButton, deleteButton, lockButton);
  const status = el(document, 'p', { className: 'tbs-status' });
  const transcript = el(document, 'pre', { className: 'tbs-log' });
  appView.append(kindWrap, label.wrap, url.wrap, model.wrap, token.wrap, actionRow, status, transcript);
  dialog.append(head, lockView, appView);

  let visible = false;
  let modalOpen = false;
  let disposed = false;
  let running = false;

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  }

  function appendLog(line) {
    transcript.textContent = transcript.textContent ? `${transcript.textContent}\n${line}` : line;
    transcript.scrollTop = transcript.scrollHeight;
  }

  function fillEditor(connection) {
    if (!connection) {
      label.input.value = '';
      url.input.value = '';
      model.input.value = '';
      token.input.value = '';
      token.input.placeholder = '';
      return;
    }
    kindSelect.value = connection.kind;
    label.input.value = connection.label;
    url.input.value = connection.config.baseUrl ?? '';
    model.input.value = connection.config.model ?? '';
    token.input.value = '';
    token.input.placeholder = connection.hasSecret ? 'Saved · enter a new token to replace' : '';
  }

  function refreshConnections() {
    const connections = session.isUnlocked() ? session.listConnections() : [];
    const activeId = session.isUnlocked() ? session.activeConnection()?.id ?? '' : '';
    connectionSelect.replaceChildren();
    if (connections.length === 0) {
      connectionSelect.appendChild(el(document, 'option', { value: '' }, 'No model yet'));
      fillEditor(null);
      return;
    }
    for (const connection of connections) {
      connectionSelect.appendChild(el(document, 'option', { value: connection.id }, connection.label));
    }
    connectionSelect.value = activeId;
    fillEditor(connections.find(item => item.id === activeId) ?? connections[0]);
  }

  function render() {
    const unlocked = session.isUnlocked();
    lockView.hidden = unlocked;
    appView.hidden = !unlocked;
    confirm.wrap.hidden = session.exists();
    lockHint.textContent = session.exists()
      ? 'Enter your PIN to use the tokens saved in this browser.'
      : 'Create a PIN. Bearer tokens are encrypted here and never written into the page.';
    unlockButton.hidden = !session.exists();
    createButton.hidden = session.exists();
    if (unlocked) {
      try {
        refreshConnections();
      } catch (error) {
        setStatus(error.message, true);
      }
    } else {
      connectionSelect.replaceChildren(el(document, 'option', { value: '' }, 'Unlock in Models'));
    }
  }

  function setVisible(next) {
    visible = Boolean(next) && !disposed;
    dock.classList.toggle('is-visible', visible);
    if (visible) render();
    if (!visible) setModalOpen(false);
  }

  function setModalOpen(next) {
    modalOpen = Boolean(next) && !disposed;
    modal.classList.toggle('is-open', modalOpen);
    modal.setAttribute('aria-hidden', modalOpen ? 'false' : 'true');
    if (modalOpen) render();
  }

  async function withBusy(work) {
    if (running) return;
    running = true;
    try {
      await work();
    } catch (error) {
      setStatus(error?.message ?? String(error), true);
      setModalOpen(true);
    } finally {
      running = false;
    }
  }

  async function runPrompt() {
    await withBusy(async () => {
      if (!session.isUnlocked()) {
        setModalOpen(true);
        throw new Error('Unlock or create a PIN in Models first.');
      }
      transcript.textContent = '';
      setStatus('Running…');
      const result = await session.runPrompt(promptInput.value, {
        onEvent(event) {
          if (event.type === 'text' && event.text) appendLog(event.text);
          if (event.type === 'tool-call') appendLog(`→ ${event.name}`);
          if (event.type === 'tool-result') appendLog(`← ${event.name}${event.ok ? '' : ` (${event.code})`}`);
        },
      });
      if (result.text) appendLog(result.text);
      setStatus(result.finishReason === 'stop' ? 'Done.' : result.finishReason);
      if (result.toolTrace?.some(item => item.code === 'kernel_unavailable')) setModalOpen(true);
    });
  }

  unlockButton.addEventListener('click', () => withBusy(async () => {
    await session.unlock(pin.input.value);
    pin.input.value = '';
    confirm.input.value = '';
    setStatus('Vault unlocked.');
    render();
  }));
  createButton.addEventListener('click', () => withBusy(async () => {
    if (pin.input.value !== confirm.input.value) throw new Error('PIN confirmation does not match.');
    await session.createVault(pin.input.value);
    pin.input.value = '';
    confirm.input.value = '';
    setStatus('Vault created. Tokens stay encrypted until you lock.');
    render();
  }));
  lockButton.addEventListener('click', () => {
    session.lock();
    token.input.value = '';
    transcript.textContent = '';
    setStatus('Vault locked.');
    render();
  });
  saveButton.addEventListener('click', () => withBusy(async () => {
    const saved = await session.saveConnection({
      id: connectionSelect.value || undefined,
      kind: kindSelect.value,
      label: label.input.value,
      config: { baseUrl: url.input.value, model: model.input.value },
      secret: token.input.value,
    });
    token.input.value = '';
    setStatus(`Saved ${saved.label}.`);
    render();
  }));
  testButton.addEventListener('click', () => withBusy(async () => {
    const result = await session.testActive();
    setStatus(`Reachable · ${result.model}`);
  }));
  deleteButton.addEventListener('click', () => withBusy(async () => {
    const id = connectionSelect.value;
    if (!id) return;
    await session.deleteConnection(id);
    setStatus('Removed connection.');
    render();
  }));
  connectionSelect.addEventListener('change', () => withBusy(async () => {
    if (!connectionSelect.value) return;
    await session.setActiveConnection(connectionSelect.value);
    fillEditor(session.activeConnection());
  }));
  runButton.addEventListener('click', () => { void runPrompt(); });
  modelsButton.addEventListener('click', () => setModalOpen(true));
  closeButton.addEventListener('click', () => setModalOpen(false));
  backdrop.addEventListener('click', () => setModalOpen(false));
  promptInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void runPrompt();
    }
  });
  const onDocumentKey = event => {
    if (event.key === 'Escape' && modalOpen) setModalOpen(false);
  };
  document.addEventListener('keydown', onDocumentKey);

  render();

  return Object.freeze({
    root: dock,
    modal,
    setVisible,
    setOpen: setVisible,
    setLauncherVisible: setVisible,
    layout() {},
    refresh: render,
    dispose() {
      if (disposed) return;
      disposed = true;
      visible = false;
      modalOpen = false;
      document.removeEventListener('keydown', onDocumentKey);
      session.lock();
      dock.remove();
      modal.remove();
    },
  });
}
