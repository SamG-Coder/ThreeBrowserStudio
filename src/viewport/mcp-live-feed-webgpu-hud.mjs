import { sanitizeLiveFeedText } from '../runtime/mcp-live-feed-telemetry.mjs';

const ACTIVE_REFRESH_MS = 250;
const DEFAULT_MAX_VISIBLE_ROWS = 10;
const PANEL_MARGIN = 18;
const HEADER_HEIGHT = 58;
const ROW_HEIGHT = 44;
const MAX_RETAINED_SOURCE_ENTRIES = 256;
const STAGE_COLORS = Object.freeze({
  started: '#f2b45c',
  completed: '#58dc90',
  failed: '#ff657d',
});

function finite(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function exactToggle(event) {
  let key = '';
  try {
    key = String(event?.key ?? '').toLowerCase();
  } catch {
    return false;
  }
  return key === 'm'
    && event?.ctrlKey === true
    && event?.shiftKey === true
    && event?.altKey !== true
    && event?.metaKey !== true
    && event?.repeat !== true;
}

function formatElapsed(milliseconds) {
  const value = Math.max(0, finite(milliseconds, 0));
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 10_000) return `${(value / 1_000).toFixed(2)}s`;
  return `${(value / 1_000).toFixed(1)}s`;
}

function safeStage(value) {
  return ['started', 'completed', 'failed'].includes(value) ? value : 'failed';
}

function boundedEntries(entries) {
  if (!Array.isArray(entries)) return Object.freeze([]);
  const source = entries.filter(entry => entry && typeof entry === 'object');
  if (source.length <= MAX_RETAINED_SOURCE_ENTRIES) return Object.freeze(source);
  const active = source.filter(entry => entry.stage === 'started');
  const completedCapacity = Math.max(0, MAX_RETAINED_SOURCE_ENTRIES - active.length);
  const completed = completedCapacity === 0
    ? []
    : source.filter(entry => entry.stage !== 'started').slice(-completedCapacity);
  const retained = new Set([...active, ...completed]);
  return Object.freeze(source.filter(entry => retained.has(entry)));
}

function safeSnapshot(source) {
  try {
    return source.snapshot();
  } catch {
    return [];
  }
}

function setVector(vector, x, y, z) {
  if (typeof vector?.set === 'function') vector.set(x, y, z);
  else if (vector) {
    vector.x = x;
    vector.y = y;
    vector.z = z;
  }
}

/**
 * A WebGPU-composited activity HUD. Telemetry is rasterized into a private
 * canvas and uploaded through CanvasTexture; no DOM overlay is required for
 * capture. Call render(renderer) after the main scene render.
 */
export function createMcpLiveFeedWebGpuHud({
  THREE,
  document: suppliedDocument,
  eventTarget,
  source,
  scene: targetScene,
  width = globalThis.innerWidth ?? 1280,
  height = globalThis.innerHeight ?? 720,
  pixelRatio = globalThis.devicePixelRatio ?? 1,
  maxVisibleRows = DEFAULT_MAX_VISIBLE_ROWS,
  now = () => Date.now(),
  setIntervalFn = globalThis.setInterval?.bind(globalThis),
  clearIntervalFn = globalThis.clearInterval?.bind(globalThis),
} = {}) {
  const document = suppliedDocument ?? globalThis.document;
  const keyboard = eventTarget ?? globalThis;
  if (!THREE?.CanvasTexture || !THREE?.Sprite || !THREE?.Vector3) {
    throw new TypeError('THREE must provide CanvasTexture, Sprite, and Vector3');
  }
  const SpriteMaterial = THREE.SpriteNodeMaterial ?? THREE.SpriteMaterial;
  if (!SpriteMaterial) throw new TypeError('THREE must provide SpriteNodeMaterial or SpriteMaterial');
  if (!document?.createElement) throw new TypeError('A DOM document is required to create the HUD canvas');
  if (!source?.snapshot || !source?.subscribe) throw new TypeError('source must expose snapshot() and subscribe()');
  if (!targetScene?.add || !targetScene?.remove) throw new TypeError('A target Three.js scene is required');
  if (typeof setIntervalFn !== 'function' || typeof clearIntervalFn !== 'function') {
    throw new TypeError('Timer functions are required');
  }

  const rowLimit = Number.isInteger(maxVisibleRows) && maxVisibleRows >= 1 && maxVisibleRows <= 64
    ? maxVisibleRows
    : DEFAULT_MAX_VISIBLE_ROWS;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext?.('2d', { alpha: true });
  if (!context) throw new Error('A 2D canvas context is required for the MCP HUD');

  const texture = new THREE.CanvasTexture(canvas);
  if (THREE.SRGBColorSpace !== undefined) texture.colorSpace = THREE.SRGBColorSpace;
  if (THREE.LinearFilter !== undefined) {
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
  }
  texture.generateMipmaps = false;
  const material = new SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.toneMapped = false;

  const sprite = new THREE.Sprite(material);
  sprite.name = 'Three Studio MCP Live Feed HUD';
  sprite.frustumCulled = false;
  sprite.renderOrder = 2_147_483_000;
  sprite.center?.set?.(0.5, 0.5);
  targetScene.add(sprite);
  const localPosition = new THREE.Vector3();

  let viewportWidth = 1;
  let viewportHeight = 1;
  let backingRatio = 1;
  let panelWidth = 1;
  let panelHeight = 1;
  let capacity = 1;
  let latest = Object.freeze([]);
  let visible = true;
  let disposed = false;
  let timer = null;
  let drawRevision = 0;
  let scrollIndex = 0;

  const timeNow = () => {
    try {
      const value = Number(now());
      return Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  };

  const draw = () => {
    if (disposed) return;
    const maximumScroll = Math.max(0, latest.length - capacity);
    scrollIndex = clamp(scrollIndex, 0, maximumScroll);
    const entries = latest.slice(scrollIndex, scrollIndex + capacity);
    const activeCount = latest.filter(entry => entry.stage === 'started').length;
    const firstVisible = entries.length > 0 ? scrollIndex + 1 : 0;
    const lastVisible = entries.length > 0 ? scrollIndex + entries.length : 0;
    context.setTransform?.(backingRatio, 0, 0, backingRatio, 0, 0);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.clearRect(0, 0, panelWidth, panelHeight);
    context.fillStyle = 'rgba(8, 13, 22, 0.90)';
    context.fillRect(0, 0, panelWidth, panelHeight);
    context.fillStyle = 'rgba(135, 176, 224, 0.34)';
    context.fillRect(0, 0, panelWidth, 1);
    context.fillRect(0, HEADER_HEIGHT - 1, panelWidth, 1);
    context.textBaseline = 'middle';
    context.font = '600 15px "Segoe UI", Arial, sans-serif';
    context.fillStyle = '#9fc6f2';
    context.fillText('MCP LIVE FEED', 12, 15, panelWidth - 24);
    context.font = '12px "Segoe UI", Arial, sans-serif';
    context.fillStyle = activeCount > 0 ? '#f2b45c' : '#7f94ad';
    const activity = activeCount > 0 ? `${activeCount} ACTIVE` : 'IDLE';
    context.fillText(
      `${activity}  \u00b7  ${latest.length} EVENTS  \u00b7  ${firstVisible}\u2013${lastVisible} / ${latest.length}`,
      12,
      34,
      panelWidth - 160,
    );
    context.fillStyle = '#70859e';
    context.textAlign = 'right';
    context.fillText('WHEEL  \u00b7  Ctrl+Shift+M', panelWidth - 12, 34, 150);
    context.textAlign = 'left';

    if (entries.length === 0) {
      context.font = '13px "Segoe UI", Arial, sans-serif';
      context.fillStyle = '#7f94ad';
      context.fillText('Waiting for Three Studio MCP activity\u2026', 12, HEADER_HEIGHT + 21, panelWidth - 24);
    }

    entries.forEach((entry, index) => {
      const stage = safeStage(entry.stage);
      const y = HEADER_HEIGHT + (index * ROW_HEIGHT);
      const elapsed = stage === 'started'
        ? Math.max(0, timeNow() - finite(entry.startedAtMs, timeNow()))
        : finite(entry.elapsedMs, 0);
      const timestamp = sanitizeLiveFeedText(entry.timestamp, { maximum: 16, fallback: '--:--:--.---' });
      const tool = sanitizeLiveFeedText(entry.tool, { maximum: 48, fallback: 'three_studio_unknown' });
      const revision = Number.isSafeInteger(entry.revision) && entry.revision >= 0 ? `r${entry.revision}` : 'r\u2014';
      const summary = sanitizeLiveFeedText(entry.summary, { maximum: 160, fallback: 'Studio command' });
      context.fillStyle = STAGE_COLORS[stage];
      context.fillRect(0, y + 3, 3, ROW_HEIGHT - 6);
      context.font = '12px "Cascadia Mono", Consolas, monospace';
      context.fillStyle = '#dce8f7';
      context.fillText(
        `${timestamp}  ${tool}  ${stage.toUpperCase()}  ${formatElapsed(elapsed)}  ${revision}`,
        10,
        y + 12,
        panelWidth - 20,
      );
      context.fillStyle = stage === 'failed' ? '#ffadba' : '#9fb1c6';
      context.font = '12px "Segoe UI", Arial, sans-serif';
      context.fillText(summary, 10, y + 28, panelWidth - 20);
      context.fillStyle = 'rgba(135, 176, 224, 0.10)';
      context.fillRect(8, y + ROW_HEIGHT - 1, panelWidth - 16, 1);
    });

    texture.needsUpdate = true;
    drawRevision += 1;
  };

  const stopTimer = () => {
    if (timer === null) return;
    try {
      clearIntervalFn(timer);
    } catch {
      // HUD cleanup must never affect viewport disposal.
    }
    timer = null;
  };

  const syncTimer = () => {
    const needsTimer = visible && !disposed && latest.some(entry => entry?.stage === 'started');
    if (!needsTimer) {
      stopTimer();
      return;
    }
    if (timer !== null) return;
    timer = setIntervalFn(() => {
      try {
        draw();
      } catch {
        // The presentation sink is isolated from command execution.
      }
    }, ACTIVE_REFRESH_MS);
  };

  const resize = (nextWidth, nextHeight, nextPixelRatio = backingRatio) => {
    if (disposed) return;
    const followedTail = scrollIndex >= Math.max(0, latest.length - capacity);
    const safeWidth = Math.max(1, Math.round(finite(nextWidth, viewportWidth)));
    const safeHeight = Math.max(1, Math.round(finite(nextHeight, viewportHeight)));
    const safeRatio = clamp(Math.max(3, finite(nextPixelRatio, backingRatio)), 3, 3);
    viewportWidth = safeWidth;
    viewportHeight = safeHeight;
    backingRatio = safeRatio;
    const availableWidth = Math.max(120, viewportWidth - (PANEL_MARGIN * 2));
    const availableHeight = Math.max(90, viewportHeight - (PANEL_MARGIN * 2));
    panelWidth = Math.round(Math.min(700, availableWidth, Math.max(520, viewportWidth * 0.44)));
    const desiredHeight = HEADER_HEIGHT + (ROW_HEIGHT * rowLimit);
    panelHeight = Math.round(Math.min(availableHeight, desiredHeight));
    capacity = Math.max(1, Math.min(rowLimit, Math.floor((panelHeight - HEADER_HEIGHT) / ROW_HEIGHT)));
    scrollIndex = followedTail
      ? Math.max(0, latest.length - capacity)
      : clamp(scrollIndex, 0, Math.max(0, latest.length - capacity));
    canvas.width = Math.max(1, Math.round(panelWidth * backingRatio));
    canvas.height = Math.max(1, Math.round(panelHeight * backingRatio));
    draw();
  };

  // Keep the cached sprite in the primary scene so the native host receives
  // exactly one render submission/swap per animation frame.
  const updateCamera = renderCamera => {
    if (disposed || !renderCamera) return false;
    const aspect = viewportWidth / Math.max(1, viewportHeight);
    const zoom = Math.max(0.0001, finite(renderCamera.zoom, 1));
    let viewWidth;
    let viewHeight;
    let distance;
    let centreX = 0;
    let centreY = 0;
    if (renderCamera.isOrthographicCamera) {
      viewWidth = Math.abs(finite(renderCamera.right, 1) - finite(renderCamera.left, -1)) / zoom;
      viewHeight = Math.abs(finite(renderCamera.top, 1) - finite(renderCamera.bottom, -1)) / zoom;
      centreX = (finite(renderCamera.left, -1) + finite(renderCamera.right, 1)) / (2 * zoom);
      centreY = (finite(renderCamera.bottom, -1) + finite(renderCamera.top, 1)) / (2 * zoom);
      distance = Math.max(0.01, finite(renderCamera.near, 0.1) * 1.5);
    } else {
      distance = Math.max(1, finite(renderCamera.near, 0.1) * 2);
      const radians = clamp(finite(renderCamera.fov, 50), 1, 179) * Math.PI / 180;
      viewHeight = 2 * Math.tan(radians * 0.5) * distance / zoom;
      viewWidth = viewHeight * aspect;
    }
    const centrePixelsX = PANEL_MARGIN + (panelWidth * 0.5);
    const centrePixelsY = PANEL_MARGIN + (panelHeight * 0.5);
    const ndcX = (centrePixelsX / viewportWidth) * 2 - 1;
    const ndcY = 1 - (centrePixelsY / viewportHeight) * 2;
    localPosition.set(
      centreX + (ndcX * viewWidth * 0.5),
      centreY + (ndcY * viewHeight * 0.5),
      -distance,
    );
    renderCamera.updateMatrixWorld?.(true);
    if (typeof renderCamera.localToWorld === 'function') renderCamera.localToWorld(localPosition);
    else localPosition.applyMatrix4?.(renderCamera.matrixWorld);
    setVector(sprite.position, localPosition.x, localPosition.y, localPosition.z);
    setVector(
      sprite.scale,
      (panelWidth / viewportWidth) * viewWidth,
      (panelHeight / viewportHeight) * viewHeight,
      1,
    );
    return true;
  };

  const show = () => {
    if (disposed || visible) return;
    visible = true;
    sprite.visible = true;
    draw();
    syncTimer();
  };

  const hide = () => {
    if (disposed || !visible) return;
    visible = false;
    sprite.visible = false;
    stopTimer();
  };

  const toggle = () => {
    if (visible) hide();
    else show();
  };

  const onKeyDown = event => {
    if (disposed || !exactToggle(event)) return;
    try {
      event.preventDefault?.();
    } catch {
      // A synthetic keyboard event may not be cancellable.
    }
    toggle();
  };

  const onWheel = event => {
    if (disposed || !visible || latest.length <= capacity) return;
    const x = finite(event?.clientX, -1);
    const y = finite(event?.clientY, -1);
    const left = PANEL_MARGIN;
    const top = PANEL_MARGIN;
    if (x < left || x > left + panelWidth || y < top || y > top + panelHeight) return;
    const modeScale = event?.deltaMode === 1 ? 16 : event?.deltaMode === 2 ? panelHeight : 1;
    const delta = finite(event?.deltaY, 0) * modeScale;
    if (delta === 0) return;
    const steps = Math.max(1, Math.ceil(Math.abs(delta) / ROW_HEIGHT));
    const maximumScroll = Math.max(0, latest.length - capacity);
    const next = clamp(scrollIndex + (delta > 0 ? steps : -steps), 0, maximumScroll);
    try {
      event.preventDefault?.();
      event.stopPropagation?.();
    } catch {
      // Synthetic wheel events may not support cancellation.
    }
    if (next === scrollIndex) return;
    scrollIndex = next;
    draw();
  };

  const acceptSnapshot = entries => {
    const followedTail = scrollIndex >= Math.max(0, latest.length - capacity);
    latest = boundedEntries(entries);
    scrollIndex = followedTail
      ? Math.max(0, latest.length - capacity)
      : clamp(scrollIndex, 0, Math.max(0, latest.length - capacity));
    try {
      if (visible) draw();
      syncTimer();
    } catch {
      stopTimer();
    }
  };

  latest = boundedEntries(safeSnapshot(source));
  scrollIndex = Math.max(0, latest.length - capacity);
  resize(width, height, pixelRatio);
  sprite.visible = true;
  let unsubscribe = () => {};
  try {
    unsubscribe = source.subscribe(acceptSnapshot) ?? unsubscribe;
  } catch {
    // The HUD remains as an inert, visible status panel.
  }
  keyboard?.addEventListener?.('keydown', onKeyDown);
  keyboard?.addEventListener?.('wheel', onWheel, { passive: false, capture: true });
  syncTimer();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    visible = false;
    sprite.visible = false;
    stopTimer();
    try {
      unsubscribe();
    } catch {
      // Subscription disposal is presentation-only.
    }
    keyboard?.removeEventListener?.('keydown', onKeyDown);
    keyboard?.removeEventListener?.('wheel', onWheel, { capture: true });
    targetScene.remove(sprite);
    material.dispose?.();
    texture.dispose?.();
    canvas.width = 1;
    canvas.height = 1;
    latest = Object.freeze([]);
  };

  return Object.freeze({
    scene: targetScene,
    sprite,
    material,
    texture,
    canvas,
    show,
    hide,
    toggle,
    resize,
    updateCamera,
    get visible() { return visible; },
    get drawRevision() { return drawRevision; },
    get scrollIndex() { return scrollIndex; },
    get visibleRowCount() { return Math.min(capacity, latest.length); },
    get panelBounds() {
      return Object.freeze({
        left: PANEL_MARGIN,
        top: PANEL_MARGIN,
        width: panelWidth,
        height: panelHeight,
        pixelRatio: backingRatio,
      });
    },
    dispose,
  });
}
