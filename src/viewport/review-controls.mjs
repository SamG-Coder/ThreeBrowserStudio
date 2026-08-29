import * as THREE from "three/webgpu";
import { isStudioOverlayEvent } from "./overlay-controls.mjs";
import { reviewShouldIgnoreKey, reviewShouldReleaseKeys, reviewShouldStartLook } from "./review-input.mjs";
import { applyLookDelta, clampPitch, flyStep } from "./review-fly.mjs";

function keyName(event) {
  return String(event?.code || event?.key || '');
}

/** First-person look / fly. Drag looks, WASD moves, Space/Ctrl fly up/down. */
export function createReviewControls(camera, domElement, {
  target = new THREE.Vector3(),
  keyboard = globalThis,
  onBeginInteract = null,
} = {}) {
  const look = new THREE.Euler(0, 0, 0, 'YXZ');
  const forward = new THREE.Vector3();
  const desiredTarget = target.clone();
  const keys = new Set();
  let yaw = 0;
  let pitch = 0;
  let dragging = false;
  let pointerId = 0;
  let previousX = 0;
  let previousY = 0;
  let disposed = false;
  let enabled = true;

  function applyLook() {
    look.set(pitch, yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(look);
    forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    desiredTarget.copy(camera.position).addScaledVector(forward, 4);
  }

  function syncFromCamera() {
    look.setFromQuaternion(camera.quaternion, 'YXZ');
    yaw = look.y;
    pitch = clampPitch(look.x);
    applyLook();
  }

  function releaseKeys() {
    keys.clear();
  }

  function cancelPointer() {
    if (!dragging) return;
    dragging = false;
    try {
      domElement.releasePointerCapture?.(pointerId);
    } catch {
      // Capture may already be gone after a context menu or blur.
    }
  }

  function onPointerDown(event) {
    if (disposed || dragging) return;
    if (reviewShouldReleaseKeys(event)) {
      releaseKeys();
      return;
    }
    if (!reviewShouldStartLook(event)) return;
    onBeginInteract?.(event);
    if (!enabled) return;
    dragging = true;
    pointerId = Number(event.pointerId ?? 1);
    previousX = Number(event.clientX || 0);
    previousY = Number(event.clientY || 0);
    domElement.setPointerCapture?.(pointerId);
    event.preventDefault?.();
  }

  function onPointerMove(event) {
    if (disposed || !dragging || Number(event.pointerId ?? 1) !== pointerId) return;
    const x = Number(event.clientX || 0);
    const y = Number(event.clientY || 0);
    const dx = x - previousX;
    const dy = y - previousY;
    previousX = x;
    previousY = y;
    const next = applyLookDelta(yaw, pitch, dx, dy);
    yaw = next.yaw;
    pitch = next.pitch;
    applyLook();
    event.preventDefault?.();
  }

  function finishPointer(event) {
    if (!dragging || Number(event.pointerId ?? 1) !== pointerId) return;
    cancelPointer();
  }

  function onContextMenu(event) {
    releaseKeys();
    cancelPointer();
    if (isStudioOverlayEvent(event)) return;
    if (event.target === domElement || domElement.contains?.(event.target)) {
      event.preventDefault?.();
    }
  }

  function onBlur() {
    releaseKeys();
    cancelPointer();
  }

  function onVisibilityChange() {
    if (globalThis.document?.hidden) {
      releaseKeys();
      cancelPointer();
    }
  }

  function onWheel(event) {
    if (disposed || !enabled) return;
    forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    camera.position.addScaledVector(forward, -Number(event.deltaY || 0) * 0.004);
    applyLook();
    event.preventDefault?.();
  }

  function onKeyDown(event) {
    if (disposed || !enabled) return;
    if (reviewShouldIgnoreKey(event)) {
      releaseKeys();
      return;
    }
    const code = keyName(event);
    if (code === 'Space' || code === ' ') {
      keys.add('Space');
      event.preventDefault?.();
      return;
    }
    if (code === 'ControlLeft' || code === 'ControlRight' || code === 'KeyC') {
      keys.add('Down');
      event.preventDefault?.();
      return;
    }
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight'].includes(code)) {
      keys.add(code);
      event.preventDefault?.();
    }
  }

  function onKeyUp(event) {
    const code = keyName(event);
    if (code === 'Space' || code === ' ') keys.delete('Space');
    if (code === 'ControlLeft' || code === 'ControlRight' || code === 'KeyC') keys.delete('Down');
    keys.delete(code);
  }

  domElement.addEventListener("pointerdown", onPointerDown);
  domElement.addEventListener("pointermove", onPointerMove);
  domElement.addEventListener("pointerup", finishPointer);
  domElement.addEventListener("pointercancel", finishPointer);
  domElement.addEventListener("lostpointercapture", finishPointer);
  domElement.addEventListener("contextmenu", onContextMenu);
  domElement.addEventListener("wheel", onWheel, { passive: false });
  keyboard.addEventListener?.("keydown", onKeyDown);
  keyboard.addEventListener?.("keyup", onKeyUp);
  keyboard.addEventListener?.("contextmenu", onContextMenu);
  keyboard.addEventListener?.("blur", onBlur);
  globalThis.document?.addEventListener?.("visibilitychange", onVisibilityChange);
  syncFromCamera();

  return {
    target: desiredTarget,
    get enabled() { return enabled; },
    set enabled(value) { enabled = value === true; },
    set onBeginInteract(value) { onBeginInteract = typeof value === 'function' ? value : null; },
    syncFromCamera,
    update(delta = 1 / 60) {
      if (disposed || !enabled) return;
      if (keys.size === 0) return;
      const move = flyStep(keys, delta, {
        yaw,
        pitch,
        fast: keys.has('ShiftLeft') || keys.has('ShiftRight'),
      });
      camera.position.x += move.x;
      camera.position.y += move.y;
      camera.position.z += move.z;
      applyLook();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      keys.clear();
      dragging = false;
      domElement.removeEventListener("pointerdown", onPointerDown);
      domElement.removeEventListener("pointermove", onPointerMove);
      domElement.removeEventListener("pointerup", finishPointer);
      domElement.removeEventListener("pointercancel", finishPointer);
      domElement.removeEventListener("lostpointercapture", finishPointer);
      domElement.removeEventListener("contextmenu", onContextMenu);
      domElement.removeEventListener("wheel", onWheel);
      keyboard.removeEventListener?.("keydown", onKeyDown);
      keyboard.removeEventListener?.("keyup", onKeyUp);
      keyboard.removeEventListener?.("contextmenu", onContextMenu);
      keyboard.removeEventListener?.("blur", onBlur);
      globalThis.document?.removeEventListener?.("visibilitychange", onVisibilityChange);
    },
  };
}
