import assert from 'node:assert/strict';
import test from 'node:test';

import { createSceneControllerInput } from '../src/viewport/scene-controller-input.mjs';

function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, listener) { const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type, event = {}) { for (const listener of listeners.get(type) ?? []) listener(event); },
  };
}

test('controller input captures activation and globally reserves Escape while restoring presentation', () => {
  const keyboard = eventTarget();
  const hud = { visible: true, hide() { this.visible = false; }, show() { this.visible = true; } };
  const controls = { enabled: true };
  const viewportLayers = { state: { gridVisible: true }, getState() { return this.state; }, setGridVisible(value) { this.state.gridVisible = value; } };
  const domElement = { style: { cursor: 'crosshair' }, requestPointerLock() {} };
  let active = false;
  const application = {
    controllerKeyDown(code) {
      if (code === 'Enter') active = true;
      if (code === 'Escape') active = false;
      return { handled: ['Enter', 'Escape'].includes(code) || active, active, capture: { keyboard: true, hideHud: true, hideCursor: true } };
    },
    controllerKeyUp() { return { handled: active, active, capture: { keyboard: true, hideHud: true, hideCursor: true } }; },
    releaseControllerKeys() {},
  };
  const input = createSceneControllerInput({ keyboard, document: {}, domElement, getApplication: () => application, hud, controls, viewportLayers });
  const enter = { code: 'Enter', preventDefault() { this.prevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} };
  keyboard.dispatch('keydown', enter);
  assert.equal(input.active, true);
  assert.equal(enter.prevented, true);
  assert.equal(hud.visible, false);
  assert.equal(domElement.style.cursor, 'none');
  assert.equal(controls.enabled, false);
  assert.equal(viewportLayers.state.gridVisible, false);
  const escape = { code: 'Escape', preventDefault() { this.prevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} };
  keyboard.dispatch('keydown', escape);
  assert.equal(input.active, false);
  assert.equal(escape.prevented, true);
  assert.equal(hud.visible, true);
  assert.equal(domElement.style.cursor, 'crosshair');
  assert.equal(controls.enabled, true);
  assert.equal(viewportLayers.state.gridVisible, true);
  input.dispose();
  assert.equal(keyboard.listeners.get('keydown').size, 0);
});

test('hidden editor grid remains hidden after HUD-free controller capture', () => {
  const viewportLayers = { state: { gridVisible: false }, getState() { return this.state; }, setGridVisible(value) { this.state.gridVisible = value; } };
  const input = createSceneControllerInput({ keyboard: eventTarget(), viewportLayers });
  input.sync({ active: true, capture: { hideHud: true } });
  input.sync({ active: false });
  assert.equal(viewportLayers.state.gridVisible, false);
  input.dispose();
});

test('controller input exits on Escape key-up when a native host reserves key-down', () => {
  const keyboard = eventTarget();
  const calls = [];
  const application = {
    controllerKeyDown(code) {
      calls.push(['down', code]);
      return { handled: true, active: code !== 'Escape', capture: { keyboard: true } };
    },
    controllerKeyUp(code) {
      calls.push(['up', code]);
      return { handled: true, active: true, capture: { keyboard: true } };
    },
  };
  const input = createSceneControllerInput({ keyboard, getApplication: () => application });
  input.sync({ active: true, capture: { keyboard: true } });

  keyboard.dispatch('keyup', { code: 'Escape' });

  assert.deepEqual(calls, [['down', 'Escape']]);
  assert.equal(input.active, false);
});
