const DOCK_ID = 'tbs-prompt-dock';
const STYLE_ID = 'tbs-prompt-dock-style';

const STYLE_TEXT = `
#${DOCK_ID} {
  position: fixed;
  left: 16px;
  right: 16px;
  bottom: 16px;
  z-index: 30;
  display: none;
  flex-direction: column;
  max-height: min(46vh, 420px);
  color: #dce8f7;
  background: rgba(8, 13, 22, 0.94);
  border: 1px solid rgba(135, 176, 224, 0.24);
  border-radius: 14px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.42);
  font: 13px/1.4 "Segoe UI", sans-serif;
  backdrop-filter: blur(16px);
}
#${DOCK_ID}.is-visible { display: flex; }
#${DOCK_ID} .tbs-dock-bar {
  display: grid;
  grid-template-columns: auto minmax(120px, 180px) 1fr auto auto;
  gap: 8px;
  align-items: center;
  padding: 10px 12px;
}
#${DOCK_ID} .tbs-dock-brand {
  padding: 0 4px;
  font: 600 12px/1 "Segoe UI", sans-serif;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #9fc6f2;
}
#${DOCK_ID} .tbs-dock-models {
  display: none;
  gap: 10px;
  padding: 0 12px 12px;
  border-top: 1px solid rgba(135, 176, 224, 0.14);
  overflow: auto;
}
#${DOCK_ID}.is-models .tbs-dock-models { display: grid; }
#${DOCK_ID} .tbs-dock-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 8px;
  padding-top: 10px;
}
#${DOCK_ID} label {
  display: block;
  margin: 0 0 4px;
  color: #7f94ad;
  font-size: 11px;
}
#${DOCK_ID} input, #${DOCK_ID} select, #${DOCK_ID} textarea {
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: 8px 10px;
  color: #dce8f7;
  background: rgba(12, 20, 32, 0.96);
  border: 1px solid rgba(135, 176, 224, 0.28);
  border-radius: 8px;
  font: inherit;
}
#${DOCK_ID} textarea {
  min-height: 38px;
  max-height: 96px;
  resize: none;
}
#${DOCK_ID} button {
  margin: 0;
  padding: 8px 12px;
  color: #dce8f7;
  background: rgba(36, 58, 88, 0.98);
  border: 1px solid rgba(126, 176, 232, 0.35);
  border-radius: 8px;
  font: 600 12px/1.2 "Segoe UI", sans-serif;
  cursor: pointer;
}
#${DOCK_ID} button.secondary { background: rgba(22, 34, 52, 0.96); }
#${DOCK_ID} button.primary { background: #2d5f93; border-color: #7eb0e8; }
#${DOCK_ID} .tbs-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
#${DOCK_ID} .tbs-status { margin: 0; color: #8eb4dc; }
#${DOCK_ID} .tbs-status.is-error { color: #ffadba; }
#${DOCK_ID} .tbs-hint { margin: 10px 0 0; color: #7f94ad; }
#${DOCK_ID} .tbs-log {
  min-height: 56px;
  max-height: 120px;
  margin: 0;
  padding: 8px 10px;
  overflow: auto;
  color: #9fb1c6;
  background: rgba(10, 16, 26, 0.96);
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
}
@media (max-width: 820px) {
  #${DOCK_ID} .tbs-dock-bar {
    grid-template-columns: 1fr auto auto;
  }
  #${DOCK_ID} .tbs-dock-brand { grid-column: 1 / -1; }
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

function labeledInput(document, { label, name, type = 'text', placeholder = '' }) {
  const wrap = el(document, 'div');
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
 * Bottom Prompt dock for the browser preview. Native ThreeRuntime never mounts this.
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

  const root = el(document, 'footer', { id: DOCK_ID, 'aria-label': 'Studio prompt' });
  const bar = el(document, 'div', { className: 'tbs-dock-bar' });
  const modelsPane = el(document, 'div', { className: 'tbs-dock-models' });
  const lockView = el(document, 'div');
  const appView = el(document, 'div');
  root.append(bar, modelsPane);
  modelsPane.append(lockView, appView);
  document.body.appendChild(root);

  const connectionSelect = el(document, 'select', { 'aria-label': 'Saved model' });
  const promptInput = el(document, 'textarea', {
    rows: '1',
    'aria-label': 'Prompt',
    placeholder: 'Ask the connected model…',
  });
  const runButton = el(document, 'button', { type: 'button', className: 'primary' }, 'Run');
  const modelsButton = el(document, 'button', { type: 'button', className: 'secondary' }, 'Models');
  bar.append(
    el(document, 'span', { className: 'tbs-dock-brand' }, 'Prompt'),
    connectionSelect,
    promptInput,
    runButton,
    modelsButton,
  );

  const pin = labeledInput(document, { label: 'PIN', name: 'tbs-pin', type: 'password' });
  const confirm = labeledInput(document, { label: 'Confirm PIN', name: 'tbs-pin-confirm', type: 'password' });
  const lockHint = el(document, 'p', { className: 'tbs-hint' });
  const unlockButton = el(document, 'button', { type: 'button' }, 'Unlock');
  const createButton = el(document, 'button', { type: 'button', className: 'secondary' }, 'Create PIN');
  const lockRow = el(document, 'div', { className: 'tbs-row' });
  lockRow.append(unlockButton, createButton);
  lockView.append(lockHint, pin.wrap, confirm.wrap, lockRow);

  const kindSelect = el(document, 'select', { id: 'tbs-kind', 'aria-label': 'Provider kind' });
  for (const kind of session.listProviderKinds()) {
    kindSelect.appendChild(el(document, 'option', { value: kind.id }, kind.label));
  }
  const label = labeledInput(document, { label: 'Label', name: 'tbs-label', placeholder: 'OpenRouter' });
  const url = labeledInput(document, { label: 'Base URL', name: 'tbs-url', placeholder: 'https://openrouter.ai/api/v1' });
  const model = labeledInput(document, { label: 'Model', name: 'tbs-model', placeholder: 'openai/gpt-4.1-mini' });
  const token = labeledInput(document, { label: 'Token', name: 'tbs-token', type: 'password' });
  const kindWrap = el(document, 'div');
  kindWrap.append(el(document, 'label', { for: 'tbs-kind' }, 'Provider'), kindSelect);
  const fields = el(document, 'div', { className: 'tbs-dock-grid' });
  fields.append(kindWrap, label.wrap, url.wrap, model.wrap, token.wrap);
  const saveButton = el(document, 'button', { type: 'button' }, 'Save');
  const testButton = el(document, 'button', { type: 'button', className: 'secondary' }, 'Test');
  const deleteButton = el(document, 'button', { type: 'button', className: 'secondary' }, 'Remove');
  const lockButton = el(document, 'button', { type: 'button', className: 'secondary' }, 'Lock');
  const actionRow = el(document, 'div', { className: 'tbs-row' });
  actionRow.append(saveButton, testButton, deleteButton, lockButton);
  const status = el(document, 'p', { className: 'tbs-status' });
  const transcript = el(document, 'pre', { className: 'tbs-log' });
  appView.append(fields, actionRow, status, transcript);

  let visible = false;
  let modelsOpen = false;
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
      ? 'Unlock this browser to use saved model tokens. The PIN never leaves the page.'
      : 'Create a PIN to encrypt tokens in this browser. Desktop Studio does not use this vault.';
    unlockButton.hidden = !session.exists();
    createButton.hidden = session.exists();
    if (unlocked) {
      try {
        refreshConnections();
      } catch (error) {
        setStatus(error.message, true);
      }
    } else {
      connectionSelect.replaceChildren(el(document, 'option', { value: '' }, 'Unlock to connect'));
    }
  }

  function setVisible(next) {
    visible = Boolean(next) && !disposed;
    root.classList.toggle('is-visible', visible);
    if (visible) render();
  }

  function setModelsOpen(next) {
    modelsOpen = Boolean(next);
    root.classList.toggle('is-models', modelsOpen);
    modelsButton.textContent = modelsOpen ? 'Close' : 'Models';
  }

  async function withBusy(work) {
    if (running) return;
    running = true;
    try {
      await work();
    } catch (error) {
      setStatus(error?.message ?? String(error), true);
      setModelsOpen(true);
    } finally {
      running = false;
    }
  }

  async function runPrompt() {
    await withBusy(async () => {
      if (!session.isUnlocked()) {
        setModelsOpen(true);
        throw new Error('Unlock or create a PIN first.');
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
  modelsButton.addEventListener('click', () => setModelsOpen(!modelsOpen));
  promptInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void runPrompt();
    }
  });

  render();

  return Object.freeze({
    root,
    setVisible,
    setOpen: setVisible,
    setLauncherVisible: setVisible,
    layout() {},
    refresh: render,
    dispose() {
      if (disposed) return;
      disposed = true;
      visible = false;
      session.lock();
      root.remove();
    },
  });
}
