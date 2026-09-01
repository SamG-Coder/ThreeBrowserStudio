const STYLE_ID = 'tbs-browser-play-style';

function ensureStyle(document) {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .tbs-browser-play {
      position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
      z-index: 30; display: flex; align-items: center; gap: 6px;
      padding: 5px; border: 1px solid rgba(137,177,218,.35); border-radius: 10px;
      background: rgba(10,17,27,.88); box-shadow: 0 8px 24px rgba(0,0,0,.28);
      backdrop-filter: blur(10px); font: 12px/1.2 "Segoe UI", sans-serif;
    }
    .tbs-browser-play button {
      min-width: 84px; height: 30px; border: 0; border-radius: 7px; cursor: pointer;
      color: #e9f3ff; background: #17324c; font: inherit; font-weight: 650;
    }
    .tbs-browser-play button:hover { background: #21476c; }
    .tbs-browser-play[data-mode="play"] button { background: #6b2631; }
    .tbs-browser-play[data-mode="play"] button:hover { background: #86313f; }
    .tbs-browser-play span { color: #91a8c1; padding-right: 5px; white-space: nowrap; }
  `;
  document.head.appendChild(style);
}

export function createBrowserPlayControls({ document = globalThis.document, application } = {}) {
  if (!document?.body || !application?.togglePlay) throw new TypeError('document and a browser Studio application are required.');
  ensureStyle(document);
  const host = document.createElement('div');
  host.className = 'tbs-browser-play';
  host.dataset.mode = 'author';
  host.setAttribute('aria-label', 'Play controls');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '▶ Play';
  button.title = 'Enter Play (Enter)';
  const hint = document.createElement('span');
  hint.textContent = 'Enter';
  host.append(button, hint);
  document.body.appendChild(host);

  function sync() {
    const playing = application.mode === 'play';
    if (host.dataset.mode === (playing ? 'play' : 'author')) return;
    host.dataset.mode = playing ? 'play' : 'author';
    button.textContent = playing ? '■ Stop' : '▶ Play';
    button.title = playing ? 'Stop and restore Author state (Escape)' : 'Enter Play (Enter)';
    hint.textContent = playing ? 'Escape' : 'Enter';
  }

  button.addEventListener('click', () => {
    application.togglePlay();
    sync();
  });
  sync();
  return Object.freeze({
    sync,
    dispose() { host.remove(); },
  });
}
