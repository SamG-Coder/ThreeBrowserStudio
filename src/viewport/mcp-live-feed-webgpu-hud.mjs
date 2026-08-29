import { sanitizeLiveFeedText } from '../runtime/mcp-live-feed-telemetry.mjs';
import { createFontRunCache } from './overlay-fonts.mjs';
import { pointInRect } from './overlay-geometry.mjs';
import {
  Button,
  Control,
  Label,
  OverlayHost,
  RadioOption,
  ScrollBar,
  TabStrip,
  ToggleOption,
  VirtualList,
  eventPoint,
} from './overlay-controls.mjs';
import { defaultExpandedIds, flattenExplorerRows } from './scene-explorer.mjs';
import { VIEW_MODE_FOLLOW_SHOT, VIEW_MODE_REVIEW } from './view-mode.mjs';

const ACTIVE_REFRESH_MS = 250;
const DEFAULT_MAX_VISIBLE_ROWS = 16;
const PANEL_MARGIN = 12;
const PANEL_WIDTH = 380;
const ROW_HEIGHT = 40;
const EXPANDED_ROW_HEIGHT = 64;
const LOG_TOOLBAR_HEIGHT = 28;
const EXPLORER_ROW_HEIGHT = 22;
const HEADER_HEIGHT = 48;
const TAB_HEIGHT = 30;
const SCROLL_WIDTH = 10;
const MAX_RETAINED_SOURCE_ENTRIES = 256;
const STAGE_COLORS = Object.freeze({
  started: '#f2b45c',
  completed: '#58dc90',
  failed: '#ff657d',
});
const UI_FONT = '13px "Segoe UI", Arial, sans-serif';
const UI_FONT_BOLD = '600 13px "Segoe UI", Arial, sans-serif';
const MONO_FONT = '12px "Cascadia Mono", Consolas, monospace';

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

function logLine(entry, now, { expanded = false } = {}) {
  const stage = safeStage(entry.stage);
  const elapsed = stage === 'started'
    ? Math.max(0, now - finite(entry.startedAtMs, now))
    : finite(entry.elapsedMs, 0);
  const timestamp = sanitizeLiveFeedText(entry.timestamp, { maximum: 16, fallback: '--:--:--.---' });
  const tool = sanitizeLiveFeedText(entry.tool, { maximum: 48, fallback: 'three_studio_unknown' });
  const revision = Number.isSafeInteger(entry.revision) && entry.revision >= 0 ? `r${entry.revision}` : 'r\u2014';
  const summary = sanitizeLiveFeedText(entry.summary, { maximum: 160, fallback: 'Studio command' });
  const detail = sanitizeLiveFeedText(entry.detail, { maximum: 240, fallback: '' });
  const outcome = sanitizeLiveFeedText(entry.outcome, { maximum: 48, fallback: '' });
  const extra = [detail && detail !== summary ? detail : '', outcome].filter(Boolean).join('  ·  ');
  return {
    stage,
    headline: `${timestamp}  ${tool}  ${stage.toUpperCase()}  ${formatElapsed(elapsed)}  ${revision}`,
    summary,
    extra: expanded ? extra : '',
  };
}

/**
 * Side panel composited through CanvasTexture. Controls are retained and
 * only the invalidated update region is painted.
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
  schedulePaint,
  onViewModeChange,
  typeface = null,
  viewMode: initialViewMode = VIEW_MODE_FOLLOW_SHOT,
  promptTab = false,
  onTabChange,
  onVisibilityChange,
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
  if (!context) throw new Error('A 2D canvas context is required for the Studio side panel');

  const fonts = createFontRunCache({
    createCanvas: () => document.createElement('canvas'),
    typeface,
  });
  const texture = new THREE.CanvasTexture(canvas);
  if (THREE.SRGBColorSpace !== undefined) texture.colorSpace = THREE.SRGBColorSpace;
  const applyTextureFilter = ratio => {
    const nearest = Number.isInteger(ratio) && THREE.NearestFilter !== undefined;
    const filter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
    if (filter !== undefined) {
      texture.minFilter = filter;
      texture.magFilter = filter;
    }
  };
  applyTextureFilter(1);
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
  sprite.name = 'Three Studio side panel';
  sprite.frustumCulled = false;
  sprite.renderOrder = 2_147_483_000;
  sprite.center?.set?.(0.5, 0.5);
  targetScene.add(sprite);
  const localPosition = new THREE.Vector3();

  let viewportWidth = 1;
  let viewportHeight = 1;
  let originLeft = PANEL_MARGIN;
  let originTop = PANEL_MARGIN;
  let latest = Object.freeze([]);
  let visible = true;
  let disposed = false;
  let timer = null;
  let viewMode = initialViewMode === VIEW_MODE_REVIEW ? VIEW_MODE_REVIEW : VIEW_MODE_FOLLOW_SHOT;
  let captured = null;
  let tab = 'log';
  let logExpanded = false;
  let explorerOutline = Object.freeze({
    revision: 0,
    sceneId: null,
    sceneName: 'No scene',
    rootEntityIds: Object.freeze([]),
    entities: Object.freeze({}),
    rootCollectionIds: Object.freeze([]),
    collections: Object.freeze({}),
  });
  let explorerExpanded = new Set();
  let explorerKnownIds = new Set();
  let explorerRows = Object.freeze([]);

  const timeNow = () => {
    try {
      const value = Number(now());
      return Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  };

  const host = new OverlayHost({
    canvas,
    context,
    fonts,
    ...(schedulePaint ? { schedulePaint } : {}),
    backColor: 'rgba(8, 13, 22, 0.92)',
    onPainted() {
      texture.needsUpdate = true;
    },
  });

  const title = host.add(new Label({
    name: 'title',
    text: 'STUDIO',
    font: UI_FONT_BOLD,
    color: '#9fc6f2',
  }));
  const status = host.add(new Label({
    name: 'status',
    text: 'IDLE',
    font: '12px "Segoe UI", Arial, sans-serif',
    color: '#7f94ad',
  }));
  const modeButton = host.add(new Button({
    name: 'view-mode',
    text: 'Follow shot',
    onClick() {
      const next = viewMode === VIEW_MODE_FOLLOW_SHOT ? VIEW_MODE_REVIEW : VIEW_MODE_FOLLOW_SHOT;
      setViewMode(next, { fromUi: true });
    },
  }));
  const tabItems = [
    { id: 'log', label: 'Log' },
    { id: 'explorer', label: 'Explorer' },
    { id: 'settings', label: 'Settings' },
  ];
  if (promptTab) tabItems.push({ id: 'prompt', label: 'Prompt' });
  const tabs = host.add(new TabStrip({
    name: 'tabs',
    tabs: tabItems,
    selected: 'log',
    onChange(id) {
      tab = id;
      logPage.setVisible(id === 'log');
      explorerPage.setVisible(id === 'explorer');
      settingsPage.setVisible(id === 'settings');
      promptPage?.setVisible(id === 'prompt');
      syncStatus();
      onTabChange?.(id);
    },
  }));

  const logPage = host.add(new Control({ name: 'log-page', backColor: 'rgba(8, 13, 22, 0.92)' }));
  const logToolbar = logPage.add(new Control({
    name: 'log-toolbar',
    backColor: 'rgba(10, 16, 26, 0.96)',
  }));
  const logDetailToggle = logToolbar.add(new ToggleOption({
    name: 'log-expanded',
    text: 'Expanded details',
    selected: false,
    onChange(selected) { setLogExpanded(selected); },
  }));
  const list = logPage.add(new VirtualList({
    name: 'log-list',
    itemHeight: ROW_HEIGHT,
    paintItem(drawContext, drawFonts, { index, bounds }) {
      const entry = latest[index];
      if (!entry) return;
      const line = logLine(entry, timeNow(), { expanded: logExpanded });
      drawContext.fillStyle = STAGE_COLORS[line.stage];
      drawContext.fillRect(bounds.x, bounds.y + 4, 3, bounds.height - 8);
      drawFonts.blit(drawContext, line.headline, bounds.x + 10, bounds.y + 14, {
        font: MONO_FONT,
        fillStyle: '#dce8f7',
        maxWidth: bounds.width - 16,
      });
      drawFonts.blit(drawContext, line.summary, bounds.x + 10, bounds.y + 30, {
        font: UI_FONT,
        fillStyle: line.stage === 'failed' ? '#ffadba' : '#9fb1c6',
        maxWidth: bounds.width - 16,
      });
      if (line.extra) {
        drawFonts.blit(drawContext, line.extra, bounds.x + 10, bounds.y + 48, {
          font: '12px "Segoe UI", Arial, sans-serif',
          fillStyle: '#8eb4dc',
          maxWidth: bounds.width - 16,
        });
      }
      drawContext.fillStyle = 'rgba(135, 176, 224, 0.10)';
      drawContext.fillRect(bounds.x + 8, bounds.y + bounds.height - 1, bounds.width - 16, 1);
    },
  }));
  const scrollBar = logPage.add(new ScrollBar({
    name: 'log-scroll',
    onScroll(value) {
      list.setScrollIndex(value, { notify: false });
    },
  }));
  list.onScroll = value => {
    scrollBar.setScroll(value, { notify: false });
  };

  const explorerPage = host.add(new Control({
    name: 'explorer-page',
    visible: false,
    backColor: 'rgba(8, 13, 22, 0.92)',
  }));
  const explorerList = explorerPage.add(new VirtualList({
    name: 'explorer-list',
    itemHeight: EXPLORER_ROW_HEIGHT,
    paintItem(drawContext, drawFonts, { index, bounds }) {
      const row = explorerRows[index];
      if (!row) return;
      const indent = bounds.x + 8 + (row.depth * 14);
      const muted = row.visible === false || row.kind === 'section';
      if (row.expandable) {
        const cx = indent + 4;
        const cy = bounds.y + (bounds.height * 0.5);
        drawContext.beginPath();
        if (row.expanded) {
          drawContext.moveTo(cx - 3, cy - 2);
          drawContext.lineTo(cx + 3, cy - 2);
          drawContext.lineTo(cx, cy + 3);
        } else {
          drawContext.moveTo(cx - 2, cy - 3);
          drawContext.lineTo(cx + 3, cy);
          drawContext.lineTo(cx - 2, cy + 3);
        }
        drawContext.closePath();
        drawContext.fillStyle = '#8eb4dc';
        drawContext.fill();
      }
      const nameX = indent + (row.expandable ? 14 : 4);
      const meta = row.kind === 'collection' && Number.isInteger(row.memberCount)
        ? String(row.memberCount)
        : row.kindLabel;
      drawFonts.blit(drawContext, row.name, nameX, bounds.y + 15, {
        font: row.kind === 'scene' || row.kind === 'group' ? UI_FONT_BOLD : UI_FONT,
        fillStyle: muted ? '#6d8299' : '#dce8f7',
        maxWidth: Math.max(40, bounds.width - (nameX - bounds.x) - 58),
      });
      drawFonts.blit(drawContext, meta, bounds.x + bounds.width - 54, bounds.y + 15, {
        font: '11px "Segoe UI", Arial, sans-serif',
        fillStyle: '#6d8299',
        maxWidth: 48,
      });
      drawContext.fillStyle = 'rgba(135, 176, 224, 0.08)';
      drawContext.fillRect(bounds.x + 8, bounds.y + bounds.height - 1, bounds.width - 16, 1);
    },
    onActivate(index) {
      const row = explorerRows[index];
      if (!row?.expandable) return;
      if (explorerExpanded.has(row.id)) explorerExpanded.delete(row.id);
      else explorerExpanded.add(row.id);
      refreshExplorer({ fromIndex: index });
    },
  }));
  const explorerScroll = explorerPage.add(new ScrollBar({
    name: 'explorer-scroll',
    onScroll(value) {
      explorerList.setScrollIndex(value, { notify: false });
    },
  }));
  explorerList.onScroll = value => {
    explorerScroll.setScroll(value, { notify: false });
  };

  const settingsPage = host.add(new Control({
    name: 'settings-page',
    visible: false,
    backColor: 'rgba(8, 13, 22, 0.92)',
  }));
  const cameraLabel = settingsPage.add(new Label({
    text: 'Camera',
    font: UI_FONT_BOLD,
    color: '#9fc6f2',
  }));
  const followOption = settingsPage.add(new RadioOption({
    name: 'follow-shot',
    text: 'Follow shot',
    selected: viewMode === VIEW_MODE_FOLLOW_SHOT,
    onSelect() { setViewMode(VIEW_MODE_FOLLOW_SHOT, { fromUi: true }); },
  }));
  const reviewOption = settingsPage.add(new RadioOption({
    name: 'review',
    text: 'Review  ·  look / fly',
    selected: viewMode === VIEW_MODE_REVIEW,
    onSelect() { setViewMode(VIEW_MODE_REVIEW, { fromUi: true }); },
  }));
  const cameraHint = settingsPage.add(new Label({
    text: 'Review never writes the authored camera. Evidence stays on the shot.',
    color: '#7f94ad',
  }));
  const panelHint = settingsPage.add(new Label({
    text: 'Drag looks. WASD moves. Space up, Ctrl down. Ctrl+Shift+M hides this panel.',
    color: '#7f94ad',
  }));
  const logSettingsLabel = settingsPage.add(new Label({
    text: 'Log',
    font: UI_FONT_BOLD,
    color: '#9fc6f2',
  }));
  const settingsDetailToggle = settingsPage.add(new ToggleOption({
    name: 'settings-log-expanded',
    text: 'Expanded details',
    selected: false,
    onChange(selected) { setLogExpanded(selected); },
  }));
  const logHint = settingsPage.add(new Label({
    text: 'Expanded details name whitelisted operation types. Never raw arguments or results.',
    color: '#7f94ad',
  }));
  const promptSettingsHint = promptTab ? settingsPage.add(new Label({
    name: 'prompt-settings-hint',
    text: 'Model connections are on the Prompt tab. Tokens stay PIN-encrypted in this browser.',
    color: '#7f94ad',
  })) : null;

  const promptPage = promptTab ? host.add(new Control({
    name: 'prompt-page',
    visible: false,
    backColor: 'rgba(8, 13, 22, 0.92)',
  })) : null;
  if (promptPage) {
    promptPage.add(new Label({
      name: 'prompt-title',
      text: 'Prompt',
      font: UI_FONT_BOLD,
      color: '#9fc6f2',
    }));
    promptPage.add(new Label({
      name: 'prompt-hint',
      text: 'Connect an HTTP chat API. Bearer tokens stay in this browser, encrypted with your PIN.',
      color: '#7f94ad',
    }));
    promptPage.add(new Label({
      name: 'prompt-kernel-hint',
      text: 'The nine MCP tools go through the browser harness. The authoring kernel is not in the page yet.',
      color: '#7f94ad',
    }));
  }

  function layoutPages() {
    const contentY = HEADER_HEIGHT + TAB_HEIGHT;
    const contentHeight = Math.max(40, host.height - contentY);
    title.setBounds(10, 8, host.width - 132, 18);
    status.setBounds(10, 26, host.width - 132, 16);
    modeButton.setBounds(host.width - 118, 10, 108, 28);
    tabs.setBounds(0, HEADER_HEIGHT, host.width, TAB_HEIGHT);
    logPage.setBounds(0, contentY, host.width, contentHeight);
    explorerPage.setBounds(0, contentY, host.width, contentHeight);
    settingsPage.setBounds(0, contentY, host.width, contentHeight);
    promptPage?.setBounds(0, contentY, host.width, contentHeight);
    logToolbar.setBounds(0, 0, logPage.width, LOG_TOOLBAR_HEIGHT);
    logDetailToggle.setBounds(4, 0, Math.max(80, logPage.width - 8), LOG_TOOLBAR_HEIGHT);
    list.setBounds(0, LOG_TOOLBAR_HEIGHT, Math.max(40, logPage.width - SCROLL_WIDTH), Math.max(20, logPage.height - LOG_TOOLBAR_HEIGHT));
    scrollBar.setBounds(
      logPage.width - SCROLL_WIDTH,
      LOG_TOOLBAR_HEIGHT,
      SCROLL_WIDTH,
      Math.max(20, logPage.height - LOG_TOOLBAR_HEIGHT),
    );
    explorerList.setBounds(0, 0, Math.max(40, explorerPage.width - SCROLL_WIDTH), explorerPage.height);
    explorerScroll.setBounds(explorerPage.width - SCROLL_WIDTH, 0, SCROLL_WIDTH, explorerPage.height);
    cameraLabel.setBounds(12, 10, settingsPage.width - 24, 20);
    followOption.setBounds(8, 34, settingsPage.width - 16, 28);
    reviewOption.setBounds(8, 64, settingsPage.width - 16, 28);
    cameraHint.setBounds(12, 100, settingsPage.width - 24, 36);
    panelHint.setBounds(12, 138, settingsPage.width - 24, 36);
    logSettingsLabel.setBounds(12, 186, settingsPage.width - 24, 20);
    settingsDetailToggle.setBounds(8, 210, settingsPage.width - 16, 28);
    logHint.setBounds(12, 242, settingsPage.width - 24, 36);
    promptSettingsHint?.setBounds(12, 286, settingsPage.width - 24, 48);
    if (promptPage) {
      const [promptTitle, promptHint, promptKernelHint] = promptPage.children;
      promptTitle.setBounds(12, 10, promptPage.width - 24, 20);
      promptHint.setBounds(12, 36, promptPage.width - 24, 48);
      promptKernelHint.setBounds(12, 88, promptPage.width - 24, 48);
    }
    syncScroll();
  }

  function syncLogScroll() {
    list.setItems(latest.length, { followTail: list.scrollIndex >= list.maxScroll });
    scrollBar.minimum = 0;
    scrollBar.maximum = list.maxScroll;
    scrollBar.viewportSize = list.capacity;
    scrollBar.setScroll(list.scrollIndex, { notify: false });
    scrollBar.setVisible(list.maxScroll > 0);
  }

  function syncExplorerScroll() {
    explorerList.setItems(explorerRows.length);
    explorerScroll.minimum = 0;
    explorerScroll.maximum = explorerList.maxScroll;
    explorerScroll.viewportSize = explorerList.capacity;
    explorerScroll.setScroll(explorerList.scrollIndex, { notify: false });
    explorerScroll.setVisible(explorerList.maxScroll > 0);
  }

  function syncScroll() {
    syncLogScroll();
    syncExplorerScroll();
  }

  function refreshExplorer({ fromIndex = 0 } = {}) {
    explorerRows = flattenExplorerRows(explorerOutline, explorerExpanded);
    explorerList.setItems(explorerRows.length, { invalidate: false });
    if (tab === 'explorer') explorerList.invalidateFromIndex(fromIndex);
    syncExplorerScroll();
    if (tab === 'explorer') syncStatus();
  }

  function setExplorerOutline(outline) {
    explorerOutline = outline && typeof outline === 'object' ? outline : explorerOutline;
    const expandable = defaultExpandedIds(explorerOutline);
    const next = new Set();
    for (const id of expandable) {
      if (!explorerKnownIds.has(id) || explorerExpanded.has(id)) next.add(id);
    }
    explorerKnownIds = new Set([
      explorerOutline.sceneId,
      'section/collections',
      ...Object.keys(explorerOutline.entities ?? {}),
      ...Object.keys(explorerOutline.collections ?? {}),
    ].filter(Boolean));
    explorerExpanded = next;
    refreshExplorer();
  }

  function syncStatus() {
    const activeCount = latest.filter(entry => entry.stage === 'started').length;
    const first = latest.length > 0 ? list.scrollIndex + 1 : 0;
    const last = latest.length > 0 ? Math.min(latest.length, list.scrollIndex + list.capacity) : 0;
    const explorerFirst = explorerRows.length > 0 ? explorerList.scrollIndex + 1 : 0;
    const explorerLast = explorerRows.length > 0
      ? Math.min(explorerRows.length, explorerList.scrollIndex + explorerList.capacity)
      : 0;
    const objectCount = Object.keys(explorerOutline.entities ?? {}).length;
    const nextText = tab === 'log'
      ? `${activeCount > 0 ? `${activeCount} ACTIVE` : 'IDLE'}  ·  ${latest.length} events  ·  ${first}–${last}`
      : tab === 'explorer'
        ? `Explorer  ·  ${objectCount} objects  ·  ${explorerFirst}–${explorerLast}`
        : tab === 'prompt'
          ? 'Prompt  ·  PIN-encrypted models'
          : 'Settings';
    const nextColor = activeCount > 0 && tab === 'log' ? '#f2b45c' : '#7f94ad';
    status.setText(nextText);
    if (status.color !== nextColor) {
      status.color = nextColor;
      status.invalidate();
    }
  }

  function setLogExpanded(expanded) {
    const next = expanded === true;
    if (next === logExpanded) {
      logDetailToggle.setSelected(next);
      settingsDetailToggle.setSelected(next);
      return;
    }
    logExpanded = next;
    list.itemHeight = next ? EXPANDED_ROW_HEIGHT : ROW_HEIGHT;
    logDetailToggle.setSelected(next);
    settingsDetailToggle.setSelected(next);
    list.invalidate();
    syncLogScroll();
    syncStatus();
  }

  function setViewMode(mode, { fromUi = false } = {}) {
    const next = mode === VIEW_MODE_REVIEW ? VIEW_MODE_REVIEW : VIEW_MODE_FOLLOW_SHOT;
    if (next === viewMode) return;
    viewMode = next;
    modeButton.text = next === VIEW_MODE_FOLLOW_SHOT ? 'Follow shot' : 'Review';
    modeButton.invalidate();
    followOption.setSelected(next === VIEW_MODE_FOLLOW_SHOT);
    reviewOption.setSelected(next === VIEW_MODE_REVIEW);
    if (fromUi) onViewModeChange?.(next);
  }

  function paintLogItem(index) {
    list.invalidateItem(index);
  }

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
        latest.forEach((entry, index) => {
          if (entry?.stage === 'started') paintLogItem(index);
        });
        syncStatus();
      } catch {
        // The presentation sink is isolated from command execution.
      }
    }, ACTIVE_REFRESH_MS);
  };

  host.performLayout = () => {
    Control.prototype.performLayout.call(host);
    layoutPages();
  };

  const panelWidth = PANEL_WIDTH;
  const panelHeight = HEADER_HEIGHT + TAB_HEIGHT + (ROW_HEIGHT * rowLimit);
  const backingRatio = clamp(finite(pixelRatio, 1), 1, 2);

  const resize = (nextWidth, nextHeight) => {
    if (disposed) return;
    viewportWidth = Math.max(1, Math.round(finite(nextWidth, viewportWidth)));
    viewportHeight = Math.max(1, Math.round(finite(nextHeight, viewportHeight)));
    originLeft = PANEL_MARGIN;
    originTop = PANEL_MARGIN;
    if (host.width === panelWidth && host.height === panelHeight && host.backingRatio === backingRatio) {
      return;
    }
    applyTextureFilter(backingRatio);
    host.setBacking(panelWidth, panelHeight, backingRatio);
    syncStatus();
  };

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
    const centrePixelsX = originLeft + (host.width * 0.5);
    const centrePixelsY = originTop + (host.height * 0.5);
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
      (host.width / viewportWidth) * viewWidth,
      (host.height / viewportHeight) * viewHeight,
      1,
    );
    return true;
  };

  const show = () => {
    if (disposed || visible) return;
    visible = true;
    sprite.visible = true;
    host.visible = true;
    host.invalidate();
    syncTimer();
    onVisibilityChange?.(true);
  };

  const hide = () => {
    if (disposed || !visible) return;
    visible = false;
    sprite.visible = false;
    host.visible = false;
    stopTimer();
    onVisibilityChange?.(false);
  };

  const toggle = () => {
    if (visible) hide();
    else show();
  };

  const contentPoint = event => {
    const point = eventPoint(event);
    return { x: point.x - originLeft, y: point.y - originTop };
  };

  const containsEvent = event => {
    const point = eventPoint(event);
    return pointInRect(point.x, point.y, {
      x: originLeft,
      y: originTop,
      width: host.width,
      height: host.height,
    });
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

  const stealEvent = event => {
    try {
      event.preventDefault?.();
      event.stopPropagation?.();
      event.stopImmediatePropagation?.();
    } catch {
      // Synthetic events may not support cancellation.
    }
  };

  const onPointerDown = event => {
    if (disposed || !visible || !containsEvent(event)) return false;
    const point = contentPoint(event);
    const hit = host.hitTest(point.x, point.y);
    captured = hit;
    hit?.onPointerDown?.(event, point);
    stealEvent(event);
    return true;
  };

  const onPointerMove = event => {
    if (disposed || !captured) return false;
    const point = contentPoint(event);
    return captured.onPointerMove?.(event, point) === true;
  };

  const onPointerUp = event => {
    if (disposed || !captured) return false;
    const point = contentPoint(event);
    const inside = containsEvent(event);
    const handled = captured.onPointerUp?.(event, { ...point, inside }) === true;
    captured = null;
    return handled;
  };

  const onWheel = event => {
    if (disposed || !visible || !containsEvent(event)) return false;
    const point = contentPoint(event);
    const modeScale = event?.deltaMode === 1 ? 16 : event?.deltaMode === 2 ? host.height : 1;
    const delta = finite(event?.deltaY, 0) * modeScale;
    const hit = host.hitTest(point.x, point.y);
    const handled = hit?.onWheel?.(event, { ...point, delta }) === true
      || (tab === 'log' && list.onWheel(event, { delta }))
      || (tab === 'explorer' && explorerList.onWheel(event, { delta }));
    if (handled) {
      syncScroll();
      syncStatus();
    }
    stealEvent(event);
    return true;
  };

  const acceptSnapshot = entries => {
    latest = boundedEntries(entries);
    syncScroll();
    syncStatus();
    syncTimer();
  };

  latest = boundedEntries(safeSnapshot(source));
  resize(width, height, pixelRatio);
  sprite.visible = true;
  let unsubscribe = () => {};
  try {
    unsubscribe = source.subscribe(acceptSnapshot) ?? unsubscribe;
  } catch {
    // The HUD remains as an inert, visible status panel.
  }
  keyboard?.addEventListener?.('keydown', onKeyDown);
  keyboard?.addEventListener?.('pointerdown', onPointerDown, { capture: true });
  keyboard?.addEventListener?.('pointermove', onPointerMove, { capture: true });
  keyboard?.addEventListener?.('pointerup', onPointerUp, { capture: true });
  keyboard?.addEventListener?.('pointercancel', onPointerUp, { capture: true });
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
    keyboard?.removeEventListener?.('pointerdown', onPointerDown, { capture: true });
    keyboard?.removeEventListener?.('pointermove', onPointerMove, { capture: true });
    keyboard?.removeEventListener?.('pointerup', onPointerUp, { capture: true });
    keyboard?.removeEventListener?.('pointercancel', onPointerUp, { capture: true });
    keyboard?.removeEventListener?.('wheel', onWheel, { capture: true });
    onVisibilityChange?.(false);
    targetScene.remove(sprite);
    material.dispose?.();
    texture.dispose?.();
    fonts.clear();
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
    host,
    show,
    hide,
    toggle,
    resize,
    updateCamera,
    setViewMode,
    setExplorerOutline,
    handlePointerDown: onPointerDown,
    get tab() { return tab; },
    get logExpanded() { return logExpanded; },
    get viewMode() { return viewMode; },
    get visible() { return visible; },
    get drawRevision() { return host.paintGeneration; },
    get scrollIndex() { return list.scrollIndex; },
    get visibleRowCount() { return Math.min(list.capacity, latest.length); },
    get visibleLogText() {
      return latest.slice(list.scrollIndex, list.scrollIndex + list.capacity).map(entry => {
        const line = logLine(entry, timeNow(), { expanded: logExpanded });
        return line.extra ? `${line.headline}\n${line.summary}\n${line.extra}` : `${line.headline}\n${line.summary}`;
      }).join('\n');
    },
    get explorerRowCount() {
      return explorerRows.length;
    },
    get visibleExplorerText() {
      return explorerRows
        .slice(explorerList.scrollIndex, explorerList.scrollIndex + explorerList.capacity)
        .map(row => `${'  '.repeat(row.depth)}${row.name}  ${row.kindLabel}`)
        .join('\n');
    },
    get panelBounds() {
      return Object.freeze({
        left: originLeft,
        top: originTop,
        width: host.width,
        height: host.height,
        pixelRatio: host.backingRatio,
      });
    },
    dispose,
  });
}
