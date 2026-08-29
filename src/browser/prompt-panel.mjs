const SHEET_ID = 'tbs-prompt-sheet';
const STYLE_ID = 'tbs-prompt-sheet-style';
const HEADER_AND_TABS = 78;

const STYLE_TEXT = `
#${SHEET_ID} {
  position: fixed;
  z-index: 20;
  display: none;
  flex-direction: column;
  box-sizing: border-box;
  padding: 10px 12px 12px;
  overflow: auto;
  color: #dce8f7;
  background: rgba(8, 13, 22, 0.96);
  border: 1px solid rgba(135, 176, 224, 0.18);
  font: 13px/1.4 "Segoe UI", sans-serif;
}
#${SHEET_ID}.is-open { display: flex; }
#${SHEET_ID} h2, #${SHEET_ID} h3 {
  margin: 0 0 8px;
  font: 600 13px/1.3 "Segoe UI", sans-serif;
  color: #9fc6f2;
}
#${SHEET_ID} p, #${SHEET_ID} label { margin: 0 0 6px; color: #7f94ad; }
#${SHEET_ID} input, #${SHEET_ID} select, #${SHEET_ID} textarea {
  width: 100%;
  box-sizing: border-box;
  margin: 0 0 8px;
  padding: 6px 8px;
  color: #dce8f7;
  background: rgba(12, 20, 32, 0.96);
  border: 1px solid rgba(135, 176, 224, 0.28);
  font: inherit;
}
#${SHEET_ID} textarea { min-height: 72px; resize: vertical; }
#${SHEET_ID} button {
  margin: 0 8px 8px 0;
  padding: 6px 10px;
  color: #dce8f7;
  background: rgba(36, 58, 88, 0.98);
  border: 1px solid rgba(126, 176, 232, 0.35);
  font: 600 12px/1.2 "Segoe UI", sans-serif;
  cursor: pointer;
}
#${SHEET_ID} button.secondary { background: rgba(22, 34, 52, 0.96); }
#${SHEET_ID} .tbs-row { display: flex; flex-wrap: wrap; align-items: center; }
#${SHEET_ID} .tbs-status { min-height: 2.4em; color: #8eb4dc; }
#${SHEET_ID} .tbs-status.is-error { color: #ffadba; }
#${SHEET_ID} .tbs-log {
  flex: 1;
  min-height: 72px;
  margin: 0;
  padding: 8px;
  overflow: auto;
  color: #9fb1c6;
  background: rgba(10, 16, 26, 0.96);
  white-space: pre-wrap;
  word-break: break-word;
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
  const caption = el(document, 'label', { for: name }, label);
  const input = el(document, 'input', {
    id: name,
    name,
    type,
    autocomplete: 'off',
    placeholder,
  });
  wrap.append(caption, input);
  return { wrap, input, caption };
}

/**
 * DOM sheet for the browser Prompt tab. Native ThreeRuntime never mounts this.
 */
export function createBrowserPromptPanel({
  document: suppliedDocument,
  session,
  getBounds,
} = {}) {
  const document = suppliedDocument ?? globalThis.document;
  if (!document?.body?.appendChild || !document.createElement) {
    throw new TypeError('A DOM document is required for the Prompt sheet.');
  }
  if (!session) throw new TypeError('A browser prompt session is required.');

  if (!document.getElementById?.(STYLE_ID)) {
    const style = el(document, 'style', { id: STYLE_ID });
    style.textContent = STYLE_TEXT;
    (document.head ?? document.body).appendChild(style);
  }

  const root = el(document, 'aside', { id: SHEET_ID, 'aria-label': 'Studio prompt' });
  const lockView = el(document, 'div');
  const appView = el(document, 'div');
  root.append(lockView, appView);
  document.body.appendChild(root);

  const pin = labeledInput(document, { label: 'PIN', name: 'tbs-pin', type: 'password' });
  const confirm = labeledInput(document, { label: 'Confirm PIN', name: 'tbs-pin-confirm', type: 'password' });
  const lockHint = el(document, 'p');
  const unlockButton = el(document, 'button', { type: 'button' }, 'Unlock');
  const createButton = el(document, 'button', { type: 'button', className: 'secondary' }, 'Create PIN');
  lockView.append(el(document, 'h2', {}, 'Prompt'), pin.wrap, confirm.wrap, lockHint, unlockButton, createButton);

  const connectionSelect = el(document, 'select', { 'aria-label': 'Saved model' });
  const kindSelect = el(document, 'select', { 'aria-label': 'Provider kind' });
  for (const kind of session.listProviderKinds()) {
    kindSelect.appendChild(el(document, 'option', { value: kind.id }, kind.label));
  }
  const label = labeledInput(document, { label: 'Label', name: 'tbs-label', placeholder: 'OpenRouter' });
  const url = labeledInput(document, { label: 'Base URL', name: 'tbs-url', placeholder: 'https://openrouter.ai/api/v1' });
  const model = labeledInput(document, { label: 'Model', name: 'tbs-model', placeholder: 'openai/gpt-4.1-mini' });
  const token = labeledInput(document, { label: 'Token', name: 'tbs-token', type: 'password' });
  const promptInput = el(document, 'textarea', {
    'aria-label': 'Prompt',
    placeholder: 'Ask the connected model. It can call the nine Studio tools through the browser harness.',
  });
  const status = el(document, 'p', { className: 'tbs-status' });
  const transcript = el(document, 'pre', { className: 'tbs-log' });
  const saveButton = el(document, 'button', { type: 'button' }, 'Save connection');
  const testButton = el(document, 'button', { type: 'button', className: 'secondary' }, 'Test');
  const deleteButton = el(document, 'button', { type: 'button', className: 'secondary' }, 'Remove');
  const lockButton = el(document, 'button', { type: 'button', className: 'secondary' }, 'Lock');
  const runButton = el(document, 'button', { type: 'button' }, 'Run');
  const actionRow = el(document, 'div', { className: 'tbs-row' });
  actionRow.append(saveButton, testButton, deleteButton, lockButton);
  const runRow = el(document, 'div', { className: 'tbs-row' });
  runRow.append(runButton);
  appView.append(
    el(document, 'h2', {}, 'Prompt'),
    el(document, 'h3', {}, 'Models'),
    connectionSelect,
    el(document, 'label', {}, 'Provider'),
    kindSelect,
    label.wrap,
    url.wrap,
    model.wrap,
    token.wrap,
    actionRow,
    el(document, 'h3', {}, 'Harness'),
    promptInput,
    runRow,
    status,
    transcript,
  );

  let open = false;
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
    const connections = session.listConnections();
    const activeId = session.activeConnection()?.id ?? '';
    connectionSelect.replaceChildren();
    if (connections.length === 0) {
      connectionSelect.appendChild(el(document, 'option', { value: '' }, 'No saved models'));
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
      ? 'Unlock this browser vault to use saved model tokens. The PIN never leaves the page.'
      : 'Create a PIN to encrypt bearer tokens in localStorage. Desktop ThreeRuntime does not use this vault.';
    unlockButton.hidden = !session.exists();
    createButton.hidden = session.exists();
    if (unlocked) {
      try {
        refreshConnections();
      } catch (error) {
        setStatus(error.message, true);
      }
    }
  }

  function layout() {
    const bounds = typeof getBounds === 'function' ? getBounds() : null;
    if (!bounds) return;
    root.style.left = `${bounds.left}px`;
    root.style.top = `${bounds.top + HEADER_AND_TABS}px`;
    root.style.width = `${bounds.width}px`;
    root.style.height = `${Math.max(160, bounds.height - HEADER_AND_TABS)}px`;
  }

  function setOpen(next) {
    open = Boolean(next) && !disposed;
    root.classList.toggle('is-open', open);
    if (open) {
      layout();
      render();
    }
  }

  async function withBusy(work) {
    if (running) return;
    running = true;
    try {
      await work();
    } catch (error) {
      setStatus(error?.message ?? String(error), true);
    } finally {
      running = false;
    }
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
  runButton.addEventListener('click', () => withBusy(async () => {
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
  }));

  render();
  layout();

  return Object.freeze({
    root,
    setOpen,
    layout,
    refresh: render,
    dispose() {
      if (disposed) return;
      disposed = true;
      open = false;
      session.lock();
      root.remove();
    },
  });
}
