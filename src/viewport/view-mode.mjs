export const VIEW_MODE_FOLLOW_SHOT = 'follow-shot';
export const VIEW_MODE_REVIEW = 'review';

const SNAP_FOLLOW_OPERATIONS = new Set(['camera.frame', 'scene.setActiveCamera']);

export function operationsSnapFollowShot(operations) {
  return (operations ?? []).some(operation => SNAP_FOLLOW_OPERATIONS.has(operation?.type ?? operation?.op));
}

export function resolveVisibleCamera({ viewMode, authoredCamera, reviewCamera } = {}) {
  if (viewMode === VIEW_MODE_FOLLOW_SHOT && authoredCamera) return authoredCamera;
  return reviewCamera ?? authoredCamera ?? null;
}

export function seedReviewFromAuthored(THREE, reviewCamera, controls, authoredCamera) {
  if (!THREE || !reviewCamera || !authoredCamera) return false;
  authoredCamera.updateWorldMatrix?.(true, false);
  if (typeof authoredCamera.getWorldPosition === 'function') {
    authoredCamera.getWorldPosition(reviewCamera.position);
    authoredCamera.getWorldQuaternion?.(reviewCamera.quaternion);
  } else {
    reviewCamera.position?.copy?.(authoredCamera.position);
    reviewCamera.quaternion?.copy?.(authoredCamera.quaternion);
  }
  const direction = new THREE.Vector3(0, 0, -1);
  if (typeof authoredCamera.getWorldDirection === 'function') authoredCamera.getWorldDirection(direction);
  const current = typeof controls?.target?.distanceTo === 'function'
    ? controls.target.distanceTo(reviewCamera.position)
    : 4;
  const distance = Math.max(1.2, Number.isFinite(current) ? current : 4);
  controls?.target?.copy?.(reviewCamera.position)?.addScaledVector?.(direction, distance);
  reviewCamera.updateProjectionMatrix?.();
  controls?.syncFromCamera?.();
  return true;
}

export function createReviewSession({
  THREE,
  reviewCamera,
  controls,
  onChange,
} = {}) {
  if (!reviewCamera) throw new TypeError('createReviewSession requires a review camera');
  let viewMode = VIEW_MODE_FOLLOW_SHOT;
  let authoredCamera = null;

  const emit = () => {
    onChange?.({
      viewMode,
      authoredCamera,
      renderCamera: resolveVisibleCamera({ viewMode, authoredCamera, reviewCamera }),
    });
  };

  const applyVisible = () => emit();

  return {
    get viewMode() { return viewMode; },
    get authoredCamera() { return authoredCamera; },
    get reviewCamera() { return reviewCamera; },
    get renderCamera() {
      return resolveVisibleCamera({ viewMode, authoredCamera, reviewCamera });
    },
    setAuthoredCamera(next) {
      authoredCamera = next ?? null;
      applyVisible();
      return authoredCamera;
    },
    followShot() {
      if (viewMode === VIEW_MODE_FOLLOW_SHOT) return viewMode;
      viewMode = VIEW_MODE_FOLLOW_SHOT;
      applyVisible();
      return viewMode;
    },
    enterReview({ seedFromAuthored = true } = {}) {
      if (viewMode === VIEW_MODE_REVIEW) return viewMode;
      if (seedFromAuthored) seedReviewFromAuthored(THREE, reviewCamera, controls, authoredCamera);
      viewMode = VIEW_MODE_REVIEW;
      applyVisible();
      return viewMode;
    },
    setViewMode(mode) {
      if (mode === VIEW_MODE_REVIEW) return this.enterReview({ seedFromAuthored: true });
      return this.followShot();
    },
  };
}
