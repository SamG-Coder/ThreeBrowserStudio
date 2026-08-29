import { isEditableStudioEvent, isStudioOverlayEvent } from './overlay-controls.mjs';

export function reviewShouldIgnoreKey(event) {
  return isEditableStudioEvent(event);
}

export function reviewShouldStartLook(event) {
  if (isStudioOverlayEvent(event)) return false;
  return event?.button == null || event.button === 0;
}

export function reviewShouldReleaseKeys(event) {
  if (!event) return false;
  if (event.type === 'contextmenu' || event.type === 'blur') return true;
  return event.type === 'pointerdown' && event.button != null && event.button !== 0;
}
