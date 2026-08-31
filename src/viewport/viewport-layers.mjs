export const VIEWPORT_LAYER_SCENE = 'scene';
export const VIEWPORT_LAYER_PREVIEW = 'preview';
export const VIEWPORT_LAYER_ALL = 'all';

const VALID_MODES = new Set([
  VIEWPORT_LAYER_SCENE,
  VIEWPORT_LAYER_PREVIEW,
  VIEWPORT_LAYER_ALL,
]);

function disposeObject(root) {
  root?.traverse?.(object => {
    object.geometry?.dispose?.();
    if (Array.isArray(object.material)) object.material.forEach(material => material?.dispose?.());
    else object.material?.dispose?.();
  });
  root?.removeFromParent?.();
}

function createGridFloor(THREE) {
  if (typeof THREE?.GridHelper !== 'function') {
    throw new TypeError('THREE.GridHelper is required for the Studio viewport grid');
  }
  const grid = new THREE.GridHelper(200, 200, 0x526b87, 0x293747);
  grid.name = 'Studio grid floor';
  grid.position.y = 0.002;
  grid.renderOrder = -1000;
  grid.frustumCulled = false;
  grid.userData.studioHelper = true;
  grid.userData.studioLayer = 'grid';
  const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
  for (const material of materials) {
    if (!material) continue;
    material.transparent = true;
    material.opacity = 0.62;
    material.depthWrite = false;
    material.toneMapped = false;
  }
  return grid;
}

function createStudioLighting(THREE) {
  if (!THREE?.Group || !THREE?.HemisphereLight || !THREE?.DirectionalLight) {
    throw new TypeError('THREE Group, HemisphereLight, and DirectionalLight are required for Studio lighting');
  }
  const root = new THREE.Group();
  root.name = 'Studio workbench lighting';
  root.userData.studioHelper = true;
  root.userData.studioLayer = 'lighting';
  const fill = new THREE.HemisphereLight(0xdbe9ff, 0x26303b, 1.65);
  fill.name = 'Studio workbench fill';
  fill.userData.studioHelper = true;
  const key = new THREE.DirectionalLight(0xffffff, 2.8);
  key.name = 'Studio workbench key';
  key.position.set(6, 10, 8);
  key.userData.studioHelper = true;
  root.add(fill, key);
  return root;
}

function containsAuthoredLight(compiled) {
  let found = false;
  compiled?.root?.traverse?.(object => {
    if (object?.isLight && object?.userData?.studioHelper !== true) found = true;
  });
  return found;
}

/**
 * Owns transient viewport-only layers. None of this state enters the canonical
 * project document, resource tables, exports, history, or inverse operations.
 */
export function createViewportLayers({
  THREE,
  scene,
  onPresentationChange,
  onStateChange,
  gridVisible = true,
  studioLightVisible = true,
} = {}) {
  if (!scene?.add) throw new TypeError('A Three.js scene is required for viewport layers');
  const grid = createGridFloor(THREE);
  const studioLighting = createStudioLighting(THREE);
  scene.add(grid);
  scene.add(studioLighting);

  let committed = null;
  let preview = null;
  let previewLabel = '';
  let previewRevision = null;
  let mode = VIEWPORT_LAYER_SCENE;
  let disposed = false;
  let showGrid = gridVisible !== false;
  let showStudioLight = studioLightVisible !== false;

  function state() {
    return Object.freeze({
      mode,
      gridVisible: showGrid,
      studioLightVisible: showStudioLight,
      previewActive: Boolean(preview),
      previewLabel,
      previewRevision,
      layers: Object.freeze({
        scene: Boolean(committed) && (mode === VIEWPORT_LAYER_SCENE || mode === VIEWPORT_LAYER_ALL),
        preview: Boolean(preview) && (mode === VIEWPORT_LAYER_PREVIEW || mode === VIEWPORT_LAYER_ALL),
        grid: showGrid,
        lighting: studioLighting.visible,
      }),
    });
  }

  function sync() {
    if (disposed) return state();
    if (!preview && mode !== VIEWPORT_LAYER_SCENE) mode = VIEWPORT_LAYER_SCENE;
    if (committed?.root) {
      committed.root.visible = mode === VIEWPORT_LAYER_SCENE || mode === VIEWPORT_LAYER_ALL;
    }
    if (preview?.root) {
      preview.root.visible = mode === VIEWPORT_LAYER_PREVIEW || mode === VIEWPORT_LAYER_ALL;
    }
    grid.visible = showGrid;
    const presentation = preview && mode !== VIEWPORT_LAYER_SCENE ? preview : committed;
    const visiblePresentations = mode === VIEWPORT_LAYER_ALL
      ? [committed, preview]
      : [presentation];
    studioLighting.visible = showStudioLight
      && !visiblePresentations.some(containsAuthoredLight);
    onPresentationChange?.(presentation, state());
    const snapshot = state();
    onStateChange?.(snapshot);
    return snapshot;
  }

  function setCommitted(next) {
    if (disposed) return state();
    const previous = committed;
    committed = next ?? null;
    if (committed?.root && committed.root.parent !== scene) scene.add(committed.root);
    if (previous?.root && previous.root !== committed?.root) previous.root.removeFromParent?.();
    return sync();
  }

  function setPreview(next, { label = '', revision = null } = {}) {
    if (disposed) return state();
    const previous = preview;
    preview = next ?? null;
    previewLabel = preview ? String(label ?? '') : '';
    previewRevision = preview && Number.isInteger(revision) ? revision : null;
    if (preview?.root && preview.root.parent !== scene) scene.add(preview.root);
    if (previous?.root && previous.root !== preview?.root) previous.root.removeFromParent?.();
    mode = preview ? VIEWPORT_LAYER_PREVIEW : VIEWPORT_LAYER_SCENE;
    return sync();
  }

  function clearPreview({ preserveRoot = false } = {}) {
    if (disposed) return state();
    const previous = preview;
    preview = null;
    previewLabel = '';
    previewRevision = null;
    mode = VIEWPORT_LAYER_SCENE;
    if (!preserveRoot) previous?.root?.removeFromParent?.();
    return sync();
  }

  function setMode(nextMode) {
    if (!VALID_MODES.has(nextMode)) throw new TypeError(`Unknown viewport layer mode ${nextMode}`);
    mode = preview ? nextMode : VIEWPORT_LAYER_SCENE;
    return sync();
  }

  function setGridVisible(visible) {
    showGrid = visible === true;
    return sync();
  }

  function setStudioLightVisible(visible) {
    showStudioLight = visible === true;
    return sync();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    committed?.root?.removeFromParent?.();
    preview?.root?.removeFromParent?.();
    committed = null;
    preview = null;
    disposeObject(grid);
    disposeObject(studioLighting);
  }

  sync();
  return Object.freeze({
    grid,
    studioLighting,
    setCommitted,
    setPreview,
    clearPreview,
    setMode,
    setGridVisible,
    setStudioLightVisible,
    getState: state,
    dispose,
  });
}
