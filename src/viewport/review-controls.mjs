import * as THREE from "three/webgpu";

const UP = new THREE.Vector3(0, 1, 0);

/** One-instance orbit/pan/dolly controls for the persistent review camera. */
export function createReviewControls(camera, domElement, {
  target = new THREE.Vector3(),
  minDistance = 1.2,
  maxDistance = 800,
  damping = 0.16,
} = {}) {
  const current = new THREE.Spherical();
  const desired = new THREE.Spherical();
  const offset = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const pan = new THREE.Vector3();
  const desiredTarget = target.clone();
  const currentTarget = target.clone();
  let dragging = false;
  let pointerId = 0;
  let mode = "orbit";
  let previousX = 0;
  let previousY = 0;
  let disposed = false;

  function syncFromCamera() {
    offset.copy(camera.position).sub(desiredTarget);
    desired.setFromVector3(offset);
    desired.radius = THREE.MathUtils.clamp(desired.radius, minDistance, maxDistance);
    desired.phi = THREE.MathUtils.clamp(desired.phi, 0.04, Math.PI - 0.04);
    current.copy(desired);
    currentTarget.copy(desiredTarget);
  }

  function onPointerDown(event) {
    if (disposed || dragging) return;
    dragging = true;
    pointerId = Number(event.pointerId ?? 1);
    mode = event.button === 1 || event.button === 2 || event.shiftKey ? "pan" : "orbit";
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
    if (mode === "orbit") {
      desired.theta -= dx * 0.006;
      desired.phi = THREE.MathUtils.clamp(desired.phi - dy * 0.006, 0.04, Math.PI - 0.04);
    } else {
      camera.getWorldDirection(offset);
      right.crossVectors(offset, UP).normalize();
      up.crossVectors(right, offset).normalize();
      const worldPerPixel = Math.max(0.0005, desired.radius * 0.00155);
      pan.copy(right).multiplyScalar(-dx * worldPerPixel)
        .addScaledVector(up, dy * worldPerPixel);
      desiredTarget.add(pan);
    }
    event.preventDefault?.();
  }

  function finishPointer(event) {
    if (!dragging || Number(event.pointerId ?? 1) !== pointerId) return;
    dragging = false;
    domElement.releasePointerCapture?.(pointerId);
  }

  function onWheel(event) {
    if (disposed) return;
    desired.radius = THREE.MathUtils.clamp(
      desired.radius * Math.exp(Number(event.deltaY || 0) * 0.0012),
      minDistance,
      maxDistance,
    );
    event.preventDefault?.();
  }

  domElement.addEventListener("pointerdown", onPointerDown);
  domElement.addEventListener("pointermove", onPointerMove);
  domElement.addEventListener("pointerup", finishPointer);
  domElement.addEventListener("pointercancel", finishPointer);
  domElement.addEventListener("lostpointercapture", finishPointer);
  domElement.addEventListener("wheel", onWheel, { passive: false });
  syncFromCamera();

  return {
    target: desiredTarget,
    syncFromCamera,
    update(delta = 1 / 60) {
      if (disposed) return;
      const blend = 1 - Math.exp(-Math.max(0, delta) * (damping > 0 ? 1 / damping : 1000));
      current.radius = THREE.MathUtils.lerp(current.radius, desired.radius, blend);
      current.phi = THREE.MathUtils.lerp(current.phi, desired.phi, blend);
      current.theta = THREE.MathUtils.lerp(current.theta, desired.theta, blend);
      currentTarget.lerp(desiredTarget, blend);
      offset.setFromSpherical(current);
      camera.position.copy(currentTarget).add(offset);
      camera.lookAt(currentTarget);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      domElement.removeEventListener("pointerdown", onPointerDown);
      domElement.removeEventListener("pointermove", onPointerMove);
      domElement.removeEventListener("pointerup", finishPointer);
      domElement.removeEventListener("pointercancel", finishPointer);
      domElement.removeEventListener("lostpointercapture", finishPointer);
      domElement.removeEventListener("wheel", onWheel);
    },
  };
}
