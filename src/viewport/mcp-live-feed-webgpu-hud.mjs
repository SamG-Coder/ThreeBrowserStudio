import { sanitizeLiveFeedText } from '../runtime/mcp-live-feed-telemetry.mjs';
import { DEFAULT_RTX_SETTINGS, normalizeRtxSettings } from '../core/rtx-settings.mjs';
import { DEFAULT_DLSS5_SETTINGS } from './dlss5-neural-controller.mjs';
import { createFontRunCache } from './overlay-fonts.mjs';
import { pointInRect } from './overlay-geometry.mjs';
import {
  Button,
  Control,
  Label,
  OverlayHost,
  RangeOption,
  RadioOption,
  ScrollBar,
  ScrollPanel,
  TabStrip,
  ToggleOption,
  VirtualList,
  eventPoint,
  claimStudioViewportFocus,
  isStudioOverlayEvent,
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
const PANEL_BACKGROUND = 'rgba(8, 13, 22, 0.92)';
const PANEL_LAYER_TRANSPARENT = 'rgba(0, 0, 0, 0)';
const SETTINGS_CONTENT_HEIGHT = 1_570;
const DLSS5_STYLES = Object.freeze([0, 1, 2]);
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

function shortNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const absolute = Math.abs(number);
  if (absolute >= 100_000 || (absolute > 0 && absolute < 0.001)) return number.toExponential(2);
  if (absolute >= 100) return number.toFixed(0);
  if (absolute >= 10) return number.toFixed(1);
  if (absolute >= 1) return number.toFixed(2);
  return number.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function normalizeRtxUiState(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const nestedLighting = source.lighting && typeof source.lighting === 'object' ? source.lighting : null;
  const nestedShadows = source.shadows && typeof source.shadows === 'object' ? source.shadows : null;
  const nestedAo = source.ambientOcclusion && typeof source.ambientOcclusion === 'object'
    ? source.ambientOcclusion
    : null;
  const settings = {
    lighting: nestedLighting ? nestedLighting.enabled : source.lighting,
    shadows: nestedShadows ? nestedShadows.enabled : source.shadows,
    ambientOcclusion: nestedAo ? nestedAo.enabled : source.ambientOcclusion,
    directionalSampleCount: source.directionalSampleCount ?? nestedShadows?.sampleCount,
    aoSampleCount: source.aoSampleCount ?? nestedAo?.sampleCount,
    directionalAngularRadius: source.directionalAngularRadius ?? nestedShadows?.angularRadius,
    shadowStrength: source.shadowStrength ?? nestedShadows?.strength,
    aoStrength: source.aoStrength ?? nestedAo?.strength,
    aoRadius: source.aoRadius ?? nestedAo?.radius,
    maxDistance: source.maxDistance ?? nestedLighting?.maxDistance,
    rayBias: source.rayBias ?? nestedLighting?.rayBias,
  };
  for (const [key, setting] of Object.entries(settings)) {
    if (setting === undefined) delete settings[key];
  }
  try {
    return Object.freeze({ enabled: source.enabled === true, ...normalizeRtxSettings(settings) });
  } catch {
    return Object.freeze({ enabled: false, ...DEFAULT_RTX_SETTINGS });
  }
}

function normalizeDlss5UiState(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const style = Number(source.style ?? 0);
  const setting = (key, minimum, maximum) => {
    const candidate = Number(source[key]);
    const fallback = DEFAULT_DLSS5_SETTINGS[key];
    return clamp(Number.isFinite(candidate) ? candidate : fallback, minimum, maximum);
  };
  return Object.freeze({
    enabled: source.enabled === true,
    intensity: setting('intensity', 0, 1),
    localToneStrength: setting('localToneStrength', -1, 1),
    localStructureStrength: setting('localStructureStrength', -1, 1),
    globalToneStrength: setting('globalToneStrength', 0, 1),
    skinStructureStrength: setting('skinStructureStrength', -1, 1),
    style: DLSS5_STYLES.includes(style) ? style : 0,
    performanceMode: 'dlaa',
    useAutoMask: source.useAutoMask === undefined
      ? DEFAULT_DLSS5_SETTINGS.useAutoMask
      : source.useAutoMask === true,
  });
}

function normalizeFeatureStatus(value, fallbackReason) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const supported = source.supported === true;
  return Object.freeze({
    supported,
    available: source.available === undefined ? supported : source.available === true,
    requested: source.requested === true,
    configured: source.configured === true,
    active: source.active === true,
    building: source.building === true,
    failed: source.failed === true,
    reason: sanitizeLiveFeedText(source.reason, { maximum: 120, fallback: fallbackReason }),
  });
}

function featureStatusText(status, label) {
  if (!status.available) return `${label} unavailable · ${status.reason}`;
  if (status.failed) return `${label} failed · ${status.reason}`;
  if (status.building) return `${label} building…`;
  if (status.active) return `${label} active`;
  if (status.configured) return `${label} configured`;
  if (status.requested) return `${label} requested · ${status.reason}`;
  return `${label} available`;
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
  onExportProject,
  onImportProject,
  onRtxSettingsChange,
  onDlss5SettingsChange,
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
  let rtxAuthoritativeSettings = normalizeRtxUiState();
  let rtxUiSettings = rtxAuthoritativeSettings;
  const pendingRtxSettings = new Map();
  let rtxPatchSequence = 0;
  let rtxUiStatus = normalizeFeatureStatus(null, 'Waiting for native RTX capability status.');
  let dlss5UiSettings = normalizeDlss5UiState();
  let dlss5UiStatus = normalizeFeatureStatus(null, 'Waiting for native DLSS 5 capability status.');

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
    backColor: PANEL_BACKGROUND,
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

  const logPage = host.add(new Control({ name: 'log-page', backColor: PANEL_LAYER_TRANSPARENT }));
  const logToolbar = logPage.add(new Control({
    name: 'log-toolbar',
    backColor: PANEL_LAYER_TRANSPARENT,
  }));
  const logDetailToggle = logToolbar.add(new ToggleOption({
    name: 'log-expanded',
    text: 'Expanded details',
    selected: false,
    onChange(selected) { setLogExpanded(selected); },
  }));
  const list = logPage.add(new VirtualList({
    name: 'log-list',
    backColor: PANEL_LAYER_TRANSPARENT,
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
    backColor: PANEL_LAYER_TRANSPARENT,
  }));
  const explorerList = explorerPage.add(new VirtualList({
    name: 'explorer-list',
    backColor: PANEL_LAYER_TRANSPARENT,
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
    backColor: PANEL_LAYER_TRANSPARENT,
  }));
  const settingsViewport = settingsPage.add(new ScrollPanel({
    name: 'settings-scroll-panel',
    backColor: PANEL_LAYER_TRANSPARENT,
    contentHeight: SETTINGS_CONTENT_HEIGHT,
    onScroll(value) {
      settingsScroll.setScroll(value, { notify: false });
    },
  }));
  const settingsScroll = settingsPage.add(new ScrollBar({
    name: 'settings-scroll',
    onScroll(value) {
      settingsViewport.setScroll(value, { notify: false });
    },
  }));
  const settingsContent = settingsViewport.content;
  const cameraLabel = settingsContent.add(new Label({
    name: 'camera-label',
    text: 'Camera',
    font: UI_FONT_BOLD,
    color: '#9fc6f2',
  }));
  const followOption = settingsContent.add(new RadioOption({
    name: 'follow-shot',
    text: 'Follow shot',
    selected: viewMode === VIEW_MODE_FOLLOW_SHOT,
    onSelect() { setViewMode(VIEW_MODE_FOLLOW_SHOT, { fromUi: true }); },
  }));
  const reviewOption = settingsContent.add(new RadioOption({
    name: 'review',
    text: 'Review  ·  look / fly',
    selected: viewMode === VIEW_MODE_REVIEW,
    onSelect() { setViewMode(VIEW_MODE_REVIEW, { fromUi: true }); },
  }));
  const cameraHint = settingsContent.add(new Label({
    text: 'Review never writes the authored camera. Evidence stays on the shot.',
    color: '#7f94ad',
  }));
  const panelHint = settingsContent.add(new Label({
    text: 'Drag looks. WASD moves. Space up, Ctrl down. Ctrl+Shift+M hides this panel.',
    color: '#7f94ad',
  }));
  const rtxSettingsLabel = settingsContent.add(new Label({
    name: 'rtx-settings-label',
    text: 'RTX Lighting',
    font: UI_FONT_BOLD,
    color: '#9fc6f2',
  }));
  const rtxStatusLabel = settingsContent.add(new Label({
    name: 'rtx-status',
    text: '',
    color: '#7f94ad',
  }));
  const rtxEnabledToggle = settingsContent.add(new ToggleOption({
    name: 'rtx-enabled',
    text: 'Enable native RTX',
    onChange(selected) { requestRtxPatch({ enabled: selected }); },
  }));
  const rtxLightingToggle = settingsContent.add(new ToggleOption({
    name: 'rtx-lighting',
    text: 'Ray lighting',
    onChange(selected) { requestRtxPatch({ lighting: selected }); },
  }));
  const rtxShadowsToggle = settingsContent.add(new ToggleOption({
    name: 'rtx-shadows',
    text: 'Ray-traced shadows',
    onChange(selected) { requestRtxPatch({ shadows: selected }); },
  }));
  const rtxAoToggle = settingsContent.add(new ToggleOption({
    name: 'rtx-ambient-occlusion',
    text: 'Ray-traced ambient occlusion',
    onChange(selected) { requestRtxPatch({ ambientOcclusion: selected }); },
  }));
  const rtxDirectionalSamples = settingsContent.add(new RangeOption({
    name: 'rtx-directional-samples',
    text: 'Shadow samples',
    minimum: 1,
    maximum: 64,
    step: 1,
    formatValue: value => String(Math.round(value)),
    onChange(value) { requestRtxPatch({ directionalSampleCount: value }); },
  }));
  const rtxDirectionalRadius = settingsContent.add(new RangeOption({
    name: 'rtx-directional-radius',
    text: 'Sun angular radius',
    minimum: 0,
    maximum: Math.PI / 2 - 0.0001,
    step: 0.0001,
    curve: 3,
    formatValue: value => shortNumber(value),
    onChange(value) { requestRtxPatch({ directionalAngularRadius: value }); },
  }));
  const rtxShadowStrength = settingsContent.add(new RangeOption({
    name: 'rtx-shadow-strength',
    text: 'Shadow strength',
    minimum: 0,
    maximum: 1,
    step: 0.01,
    formatValue: value => value.toFixed(2),
    onChange(value) { requestRtxPatch({ shadowStrength: value }); },
  }));
  const rtxAoSamples = settingsContent.add(new RangeOption({
    name: 'rtx-ao-samples',
    text: 'AO samples',
    minimum: 1,
    maximum: 64,
    step: 1,
    formatValue: value => String(Math.round(value)),
    onChange(value) { requestRtxPatch({ aoSampleCount: value }); },
  }));
  const rtxAoStrength = settingsContent.add(new RangeOption({
    name: 'rtx-ao-strength',
    text: 'AO strength',
    minimum: 0,
    maximum: 1,
    step: 0.01,
    formatValue: value => value.toFixed(2),
    onChange(value) { requestRtxPatch({ aoStrength: value }); },
  }));
  const rtxAoRadius = settingsContent.add(new RangeOption({
    name: 'rtx-ao-radius',
    text: 'AO radius',
    minimum: 0.001,
    maximum: 10_000,
    step: 0,
    scale: 'log',
    formatValue: value => shortNumber(value),
    onChange(value) { requestRtxPatch({ aoRadius: value }); },
  }));
  const rtxMaxDistance = settingsContent.add(new RangeOption({
    name: 'rtx-max-distance',
    text: 'Maximum ray distance',
    minimum: 0.01,
    maximum: 1_000_000,
    step: 0,
    scale: 'log',
    formatValue: value => shortNumber(value),
    onChange(value) { requestRtxPatch({ maxDistance: value }); },
  }));
  const rtxRayBias = settingsContent.add(new RangeOption({
    name: 'rtx-ray-bias',
    text: 'Ray bias',
    minimum: 0.000001,
    maximum: 10_000,
    step: 0,
    scale: 'log',
    formatValue: value => shortNumber(value),
    onChange(value) { requestRtxPatch({ rayBias: value }); },
  }));

  const dlss5SettingsLabel = settingsContent.add(new Label({
    name: 'dlss5-settings-label',
    text: 'DLSS 5 · Neural Rendering',
    font: UI_FONT_BOLD,
    color: '#9fc6f2',
  }));
  const dlss5StatusLabel = settingsContent.add(new Label({
    name: 'dlss5-status',
    text: '',
    color: '#7f94ad',
  }));
  const dlss5EnabledToggle = settingsContent.add(new ToggleOption({
    name: 'dlss5-enabled',
    text: 'Enable DLSS 5',
    onChange(selected) { requestDlss5Patch({ enabled: selected }); },
  }));
  const dlss5AdvancedLabel = settingsContent.add(new Label({
    name: 'dlss5-advanced-label',
    text: 'Advanced · Style',
    font: UI_FONT_BOLD,
    color: '#9fc6f2',
  }));
  const dlss5StyleOptions = DLSS5_STYLES.map(style => settingsContent.add(new RadioOption({
    name: `dlss5-style-${style}`,
    text: `Style ${style}`,
    selected: style === 0,
    onSelect() { requestDlss5Patch({ style }); },
  })));
  const dlss5Hint = settingsContent.add(new Label({
    name: 'dlss5-hint',
    text: 'Only the three real plug-in styles are exposed: 0, 1, and 2.',
    color: '#7f94ad',
  }));
  const dlss5Intensity = settingsContent.add(new RangeOption({
    name: 'dlss5-intensity',
    text: 'Neural intensity',
    minimum: 0,
    maximum: 1,
    step: 0.01,
    formatValue: value => value.toFixed(2),
    onChange(value) { requestDlss5Patch({ intensity: value }); },
  }));
  const dlss5LocalTone = settingsContent.add(new RangeOption({
    name: 'dlss5-local-tone',
    text: 'Local tone',
    minimum: -1,
    maximum: 1,
    step: 0.01,
    formatValue: value => value.toFixed(2),
    onChange(value) { requestDlss5Patch({ localToneStrength: value }); },
  }));
  const dlss5LocalStructure = settingsContent.add(new RangeOption({
    name: 'dlss5-local-structure',
    text: 'Local structure',
    minimum: -1,
    maximum: 1,
    step: 0.01,
    formatValue: value => value.toFixed(2),
    onChange(value) { requestDlss5Patch({ localStructureStrength: value }); },
  }));
  const dlss5GlobalTone = settingsContent.add(new RangeOption({
    name: 'dlss5-global-tone',
    text: 'Global tone',
    minimum: 0,
    maximum: 1,
    step: 0.01,
    formatValue: value => value.toFixed(2),
    onChange(value) { requestDlss5Patch({ globalToneStrength: value }); },
  }));
  const dlss5SkinStructure = settingsContent.add(new RangeOption({
    name: 'dlss5-skin-structure',
    text: 'Skin structure',
    minimum: -1,
    maximum: 1,
    step: 0.01,
    formatValue: value => value.toFixed(2),
    onChange(value) { requestDlss5Patch({ skinStructureStrength: value }); },
  }));
  const dlss5AutoMask = settingsContent.add(new ToggleOption({
    name: 'dlss5-auto-mask',
    text: 'Automatic control mask',
    onChange(selected) { requestDlss5Patch({ useAutoMask: selected }); },
  }));

  const logSettingsLabel = settingsContent.add(new Label({
    text: 'Log',
    font: UI_FONT_BOLD,
    color: '#9fc6f2',
  }));
  const settingsDetailToggle = settingsContent.add(new ToggleOption({
    name: 'settings-log-expanded',
    text: 'Expanded details',
    selected: false,
    onChange(selected) { setLogExpanded(selected); },
  }));
  const logHint = settingsContent.add(new Label({
    text: 'Expanded details name whitelisted operation types. Never raw arguments or results.',
    color: '#7f94ad',
  }));
  const projectLabel = settingsContent.add(new Label({
    name: 'project-label',
    text: 'Project',
    font: UI_FONT_BOLD,
    color: '#9fc6f2',
  }));
  const exportProjectButton = settingsContent.add(new Button({
    name: 'export-project',
    text: 'Export JSON',
    onClick() { onExportProject?.(); },
  }));
  const importProjectButton = settingsContent.add(new Button({
    name: 'import-project',
    text: 'Import JSON',
    onClick() { onImportProject?.(); },
  }));
  const projectTransferStatus = settingsContent.add(new Label({
    name: 'project-transfer-status',
    text: '',
    color: '#9fc6f2',
  }));
  const projectHint = settingsContent.add(new Label({
    name: 'project-hint',
    text: 'JSON pack of the canonical project. History, recovery, and Prompt keys stay out.',
    color: '#7f94ad',
  }));
  const promptSettingsLabel = promptTab ? settingsContent.add(new Label({
    name: 'prompt-settings-label',
    text: 'Prompt',
    font: UI_FONT_BOLD,
    color: '#9fc6f2',
  })) : null;
  const promptSettingsButton = promptTab ? settingsContent.add(new Button({
    name: 'open-prompt',
    text: 'Open Prompt  ·  models',
    onClick() { tabs.setSelected('prompt'); },
  })) : null;
  const promptSettingsHint = promptTab ? settingsContent.add(new Label({
    name: 'prompt-settings-hint',
    text: 'Connect HTTP chat APIs here. Tokens stay PIN-encrypted in this browser.',
    color: '#7f94ad',
  })) : null;

  const promptPage = promptTab ? host.add(new Control({
    name: 'prompt-page',
    visible: false,
    backColor: PANEL_LAYER_TRANSPARENT,
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
    settingsViewport.setBounds(0, 0, Math.max(40, settingsPage.width - SCROLL_WIDTH), settingsPage.height);
    settingsViewport.setContentHeight(SETTINGS_CONTENT_HEIGHT);
    settingsScroll.setBounds(settingsPage.width - SCROLL_WIDTH, 0, SCROLL_WIDTH, settingsPage.height);
    settingsScroll.minimum = 0;
    settingsScroll.maximum = settingsViewport.maxScroll;
    settingsScroll.viewportSize = settingsViewport.height;
    settingsScroll.setScroll(settingsViewport.value, { notify: false });
    settingsScroll.setVisible(settingsViewport.maxScroll > 0);
    const settingsWidth = settingsContent.width;
    cameraLabel.setBounds(12, 10, settingsWidth - 24, 20);
    followOption.setBounds(8, 34, settingsWidth - 16, 28);
    reviewOption.setBounds(8, 64, settingsWidth - 16, 28);
    cameraHint.setBounds(12, 100, settingsWidth - 24, 36);
    panelHint.setBounds(12, 138, settingsWidth - 24, 36);
    rtxSettingsLabel.setBounds(12, 186, settingsWidth - 24, 20);
    rtxStatusLabel.setBounds(12, 210, settingsWidth - 24, 36);
    rtxEnabledToggle.setBounds(8, 250, settingsWidth - 16, 28);
    rtxLightingToggle.setBounds(8, 280, settingsWidth - 16, 28);
    rtxShadowsToggle.setBounds(8, 310, settingsWidth - 16, 28);
    rtxAoToggle.setBounds(8, 340, settingsWidth - 16, 28);
    rtxDirectionalSamples.setBounds(8, 374, settingsWidth - 16, 36);
    rtxDirectionalRadius.setBounds(8, 412, settingsWidth - 16, 36);
    rtxShadowStrength.setBounds(8, 450, settingsWidth - 16, 36);
    rtxAoSamples.setBounds(8, 488, settingsWidth - 16, 36);
    rtxAoStrength.setBounds(8, 526, settingsWidth - 16, 36);
    rtxAoRadius.setBounds(8, 564, settingsWidth - 16, 36);
    rtxMaxDistance.setBounds(8, 602, settingsWidth - 16, 36);
    rtxRayBias.setBounds(8, 640, settingsWidth - 16, 36);
    dlss5SettingsLabel.setBounds(12, 690, settingsWidth - 24, 20);
    dlss5StatusLabel.setBounds(12, 714, settingsWidth - 24, 36);
    dlss5EnabledToggle.setBounds(8, 754, settingsWidth - 16, 28);
    dlss5AdvancedLabel.setBounds(12, 792, settingsWidth - 24, 20);
    dlss5StyleOptions[0].setBounds(8, 816, settingsWidth - 16, 28);
    dlss5StyleOptions[1].setBounds(8, 846, settingsWidth - 16, 28);
    dlss5StyleOptions[2].setBounds(8, 876, settingsWidth - 16, 28);
    dlss5Hint.setBounds(12, 910, settingsWidth - 24, 36);
    dlss5Intensity.setBounds(8, 952, settingsWidth - 16, 36);
    dlss5LocalTone.setBounds(8, 990, settingsWidth - 16, 36);
    dlss5LocalStructure.setBounds(8, 1028, settingsWidth - 16, 36);
    dlss5GlobalTone.setBounds(8, 1066, settingsWidth - 16, 36);
    dlss5SkinStructure.setBounds(8, 1104, settingsWidth - 16, 36);
    dlss5AutoMask.setBounds(8, 1144, settingsWidth - 16, 28);
    logSettingsLabel.setBounds(12, 1214, settingsWidth - 24, 20);
    settingsDetailToggle.setBounds(8, 1238, settingsWidth - 16, 28);
    logHint.setBounds(12, 1270, settingsWidth - 24, 36);
    projectLabel.setBounds(12, 1314, settingsWidth - 24, 20);
    const buttonWidth = Math.max(80, Math.floor((settingsWidth - 24) / 2));
    exportProjectButton.setBounds(8, 1338, buttonWidth, 28);
    importProjectButton.setBounds(8 + buttonWidth + 8, 1338, Math.max(80, settingsWidth - 16 - buttonWidth - 8), 28);
    projectTransferStatus.setBounds(12, 1372, settingsWidth - 24, 32);
    projectHint.setBounds(12, 1406, settingsWidth - 24, 36);
    promptSettingsLabel?.setBounds(12, 1450, settingsWidth - 24, 20);
    promptSettingsButton?.setBounds(8, 1474, settingsWidth - 16, 28);
    promptSettingsHint?.setBounds(12, 1508, settingsWidth - 24, 36);
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

  function syncSettingsScroll() {
    settingsScroll.minimum = 0;
    settingsScroll.maximum = settingsViewport.maxScroll;
    settingsScroll.viewportSize = settingsViewport.height;
    settingsScroll.setScroll(settingsViewport.value, { notify: false });
    settingsScroll.setVisible(settingsViewport.maxScroll > 0);
  }

  function syncScroll() {
    syncLogScroll();
    syncExplorerScroll();
    syncSettingsScroll();
  }

  const rtxValueControls = [
    rtxDirectionalSamples,
    rtxDirectionalRadius,
    rtxShadowStrength,
    rtxAoSamples,
    rtxAoStrength,
    rtxAoRadius,
    rtxMaxDistance,
    rtxRayBias,
  ];
  const rtxDetailControls = [
    rtxLightingToggle,
    rtxShadowsToggle,
    rtxAoToggle,
    ...rtxValueControls,
  ];
  const dlss5AdvancedControls = [
    ...dlss5StyleOptions,
    dlss5Intensity,
    dlss5LocalTone,
    dlss5LocalStructure,
    dlss5GlobalTone,
    dlss5SkinStructure,
    dlss5AutoMask,
  ];

  function syncRangeValue(control, value) {
    if (!control.interacting) control.setValue(value);
  }

  function refreshOptimisticRtxSettings() {
    const pending = {};
    for (const [key, entry] of pendingRtxSettings) pending[key] = entry.value;
    rtxUiSettings = normalizeRtxUiState({ ...rtxAuthoritativeSettings, ...pending });
  }

  function syncGraphicsControls() {
    rtxEnabledToggle.setSelected(rtxUiSettings.enabled);
    rtxLightingToggle.setSelected(rtxUiSettings.lighting);
    rtxShadowsToggle.setSelected(rtxUiSettings.shadows);
    rtxAoToggle.setSelected(rtxUiSettings.ambientOcclusion);
    syncRangeValue(rtxDirectionalSamples, rtxUiSettings.directionalSampleCount);
    syncRangeValue(rtxDirectionalRadius, rtxUiSettings.directionalAngularRadius);
    syncRangeValue(rtxShadowStrength, rtxUiSettings.shadowStrength);
    syncRangeValue(rtxAoSamples, rtxUiSettings.aoSampleCount);
    syncRangeValue(rtxAoStrength, rtxUiSettings.aoStrength);
    syncRangeValue(rtxAoRadius, rtxUiSettings.aoRadius);
    syncRangeValue(rtxMaxDistance, rtxUiSettings.maxDistance);
    syncRangeValue(rtxRayBias, rtxUiSettings.rayBias);
    rtxEnabledToggle.setEnabled(rtxUiStatus.available);
    for (const control of rtxDetailControls) control.setEnabled(rtxUiStatus.available);
    rtxStatusLabel.setText(featureStatusText(rtxUiStatus, 'RTX'));

    dlss5EnabledToggle.setSelected(dlss5UiSettings.enabled);
    dlss5EnabledToggle.setEnabled(dlss5UiStatus.available);
    for (const [index, control] of dlss5StyleOptions.entries()) {
      control.setSelected(dlss5UiSettings.style === DLSS5_STYLES[index]);
    }
    syncRangeValue(dlss5Intensity, dlss5UiSettings.intensity);
    syncRangeValue(dlss5LocalTone, dlss5UiSettings.localToneStrength);
    syncRangeValue(dlss5LocalStructure, dlss5UiSettings.localStructureStrength);
    syncRangeValue(dlss5GlobalTone, dlss5UiSettings.globalToneStrength);
    syncRangeValue(dlss5SkinStructure, dlss5UiSettings.skinStructureStrength);
    dlss5AutoMask.setSelected(dlss5UiSettings.useAutoMask);
    for (const control of dlss5AdvancedControls) {
      control.setEnabled(dlss5UiStatus.available && dlss5UiSettings.enabled);
    }
    dlss5StatusLabel.setText(featureStatusText(dlss5UiStatus, 'DLSS 5'));
  }

  function requestRtxPatch(patch) {
    const merged = { ...rtxUiSettings, ...patch };
    const { enabled, ...settings } = merged;
    let normalized;
    try {
      normalized = Object.freeze({ enabled: enabled === true, ...normalizeRtxSettings(settings) });
    } catch (error) {
      rtxStatusLabel.setText(`RTX setting rejected · ${error?.message ?? String(error)}`);
      syncGraphicsControls();
      return false;
    }
    const token = ++rtxPatchSequence;
    const keys = Object.keys(patch);
    for (const key of keys) pendingRtxSettings.set(key, { token, value: normalized[key] });
    refreshOptimisticRtxSettings();
    syncGraphicsControls();
    try {
      const result = onRtxSettingsChange?.(Object.freeze({ ...patch }));
      Promise.resolve(result).then(() => {
        const committed = { ...rtxAuthoritativeSettings };
        for (const key of keys) {
          const entry = pendingRtxSettings.get(key);
          if (entry?.token !== token) continue;
          committed[key] = entry.value;
          pendingRtxSettings.delete(key);
        }
        rtxAuthoritativeSettings = normalizeRtxUiState(committed);
        refreshOptimisticRtxSettings();
        syncGraphicsControls();
      }).catch(error => {
        for (const key of keys) {
          if (pendingRtxSettings.get(key)?.token === token) pendingRtxSettings.delete(key);
        }
        refreshOptimisticRtxSettings();
        syncGraphicsControls();
        rtxStatusLabel.setText(`RTX update failed · ${error?.message ?? String(error)}`);
      });
    } catch (error) {
      for (const key of keys) {
        if (pendingRtxSettings.get(key)?.token === token) pendingRtxSettings.delete(key);
      }
      refreshOptimisticRtxSettings();
      syncGraphicsControls();
      rtxStatusLabel.setText(`RTX update failed · ${error?.message ?? String(error)}`);
    }
    return true;
  }

  function requestDlss5Patch(patch) {
    const merged = normalizeDlss5UiState({ ...dlss5UiSettings, ...patch });
    if (patch.style !== undefined && merged.style !== patch.style) {
      dlss5StatusLabel.setText('DLSS 5 style must be 0, 1, or 2.');
      return false;
    }
    dlss5UiSettings = merged;
    syncGraphicsControls();
    try {
      const result = onDlss5SettingsChange?.(Object.freeze({ ...patch }));
      Promise.resolve(result).catch(error => {
        dlss5StatusLabel.setText(`DLSS 5 update failed · ${error?.message ?? String(error)}`);
      });
    } catch (error) {
      dlss5StatusLabel.setText(`DLSS 5 update failed · ${error?.message ?? String(error)}`);
    }
    return true;
  }

  function setGraphicsSettingsState(value = {}) {
    const state = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    if (state.rtx && typeof state.rtx === 'object') {
      const authored = state.rtx.authored ?? state.rtx.settings;
      if (authored && typeof authored === 'object') {
        rtxAuthoritativeSettings = normalizeRtxUiState(authored);
        refreshOptimisticRtxSettings();
      }
      const status = state.rtx.status ?? (state.rtx.supported !== undefined ? state.rtx : undefined);
      if (status !== undefined) {
        rtxUiStatus = normalizeFeatureStatus(status, 'Native RTX is unavailable.');
      }
    }
    if (state.dlss5 && typeof state.dlss5 === 'object') {
      const settings = state.dlss5.settings;
      if (settings && typeof settings === 'object') dlss5UiSettings = normalizeDlss5UiState(settings);
      const status = state.dlss5.status ?? (state.dlss5.supported !== undefined ? state.dlss5 : undefined);
      if (status !== undefined) {
        dlss5UiStatus = normalizeFeatureStatus(status, 'DLSS 5 is unavailable.');
      }
    }
    syncGraphicsControls();
    return Object.freeze({
      rtx: Object.freeze({ authored: rtxUiSettings, status: rtxUiStatus }),
      dlss5: Object.freeze({ settings: dlss5UiSettings, status: dlss5UiStatus }),
    });
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
    if (isStudioOverlayEvent(event)) return false;
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
    claimStudioViewportFocus(event, event?.target);
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
    let handled = false;
    let control = hit;
    while (control && !handled) {
      handled = control.onWheel?.(event, { ...point, delta }) === true;
      control = control.parent;
    }
    handled = handled
      || (tab === 'log' && list.onWheel(event, { delta }))
      || (tab === 'explorer' && explorerList.onWheel(event, { delta }))
      || (tab === 'settings' && settingsViewport.onWheel(event, { delta }));
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

  syncGraphicsControls();
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
    setGraphicsSettingsState,
    setProjectTransferStatus(text) {
      projectTransferStatus.setText(text);
    },
    get projectTransferStatus() {
      return projectTransferStatus.text;
    },
    handlePointerDown: onPointerDown,
    get tab() { return tab; },
    get logExpanded() { return logExpanded; },
    get viewMode() { return viewMode; },
    get visible() { return visible; },
    get drawRevision() { return host.paintGeneration; },
    get scrollIndex() { return list.scrollIndex; },
    get settingsScrollOffset() { return settingsViewport.value; },
    get settingsMaxScroll() { return settingsViewport.maxScroll; },
    get graphicsSettingsState() {
      return Object.freeze({
        rtx: Object.freeze({ authored: rtxUiSettings, status: rtxUiStatus }),
        dlss5: Object.freeze({ settings: dlss5UiSettings, status: dlss5UiStatus }),
      });
    },
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
