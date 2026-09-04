function eventCode(event) {
  return String(event?.code || event?.key || '');
}

function steal(event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  event?.stopImmediatePropagation?.();
}

export function createSceneControllerInput({
  keyboard = globalThis,
  document = globalThis.document,
  domElement,
  getApplication,
  hud,
  controls,
  viewportLayers,
} = {}) {
  let active = false;
  let capture = null;
  let restoreHud = true;
  let restoreCursor = '';
  let restoreControls = false;
  let restoreGrid = true;
  let disposed = false;

  function applyPresentation(status) {
    const nextActive = status?.active === true;
    if (nextActive && !active) {
      capture = status.capture ?? {};
      restoreHud = hud?.visible !== false;
      restoreCursor = domElement?.style?.cursor ?? '';
      restoreControls = controls?.enabled === true;
      restoreGrid = viewportLayers?.getState?.().gridVisible !== false;
      if (capture.hideHud) {
        hud?.hide?.();
        viewportLayers?.setGridVisible?.(false);
      }
      if (capture.hideCursor && domElement?.style) domElement.style.cursor = 'none';
      if (capture.pointer) void domElement?.requestPointerLock?.();
      if (controls) controls.enabled = false;
    } else if (!nextActive && active) {
      if (capture?.hideHud && restoreHud) hud?.show?.();
      if (capture?.hideHud) viewportLayers?.setGridVisible?.(restoreGrid);
      if (capture?.hideCursor && domElement?.style) domElement.style.cursor = restoreCursor;
      if (document?.pointerLockElement === domElement) document?.exitPointerLock?.();
      if (controls) controls.enabled = restoreControls;
      capture = null;
    }
    active = nextActive;
  }

  function onKeyDown(event) {
    if (disposed) return;
    const application = getApplication?.();
    if (!application) return;
    const code = eventCode(event);
    if (active && code === 'Escape') {
      const result = application.controllerKeyDown?.('Escape', { repeat: event.repeat === true });
      applyPresentation(result);
      steal(event);
      return;
    }
    const result = application.controllerKeyDown?.(code, { repeat: event.repeat === true });
    applyPresentation(result);
    if (result?.handled && result?.capture?.keyboard !== false) steal(event);
  }

  function onKeyUp(event) {
    if (disposed || !active) return;
    const code = eventCode(event);
    // Native Chromium hosts can reserve Escape key-down while dismissing
    // transient chrome or pointer lock. Its key-up remains a global exit path
    // so a controller cannot trap the scene in play mode.
    const result = code === 'Escape'
      ? getApplication?.()?.controllerKeyDown?.('Escape')
      : getApplication?.()?.controllerKeyUp?.(code);
    applyPresentation(result);
    if (result?.handled && result?.capture?.keyboard !== false) steal(event);
  }

  function onBlur() {
    getApplication?.()?.releaseControllerKeys?.();
  }

  keyboard?.addEventListener?.('keydown', onKeyDown, { capture: true });
  keyboard?.addEventListener?.('keyup', onKeyUp, { capture: true });
  keyboard?.addEventListener?.('blur', onBlur);

  return Object.freeze({
    get active() { return active; },
    sync: applyPresentation,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (active) getApplication?.()?.controllerKeyDown?.('Escape');
      applyPresentation({ active: false });
      keyboard?.removeEventListener?.('keydown', onKeyDown, { capture: true });
      keyboard?.removeEventListener?.('keyup', onKeyUp, { capture: true });
      keyboard?.removeEventListener?.('blur', onBlur);
    },
  });
}
