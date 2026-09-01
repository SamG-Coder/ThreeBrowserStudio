import { validateGraph } from '../graphs/index.mjs';

const CONTROL_TYPES = Object.freeze({
  panel: ['layout'], stack: ['layout'], grid: ['layout'], label: ['text'], button: ['text', 'command'], checkbox: ['text', 'value'],
  radioGroup: ['items', 'value'], singleLineInput: ['text', 'selection', 'clipboard', 'undo', 'ime'], multilineInput: ['text', 'selection', 'clipboard', 'undo', 'ime', 'scroll'],
  numberInput: ['value', 'validation'], list: ['items', 'selection', 'scroll'], tree: ['items', 'selection', 'expand'], tabs: ['items', 'selection'],
  progress: ['value'], image: ['source'], viewportHost: ['viewport'],
});
const WINDOW_TYPES = new Set(['window', 'modalDialog', 'toolPanel', 'overlay', 'menu', 'systemPickerRequest']);
const stable = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._/-]*$/u.test(value);
const clone = value => structuredClone(value);
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }

export const FORM_CONTROL_CATALOG = Object.freeze(Object.entries(CONTROL_TYPES).map(([type, components]) => Object.freeze({
  type, components: Object.freeze([...components]), sharedHosts: Object.freeze(['native', 'browser']),
  browserAdapterOnly: Object.freeze(['singleLineInput', 'multilineInput'].includes(type) ? ['ime', 'accessibility', 'clipboard'] : []),
})));

export function createFormDocument(input) {
  if (!stable(input?.id) || !WINDOW_TYPES.has(input.windowType)) fail('plainform_form_invalid', 'A form requires a stable ID and supported window type.');
  const controls = clone(input.controls ?? []); if (!Array.isArray(controls) || controls.length < 1 || controls.length > 256) fail('plainform_form_control_limit', 'A form requires 1 to 256 controls.');
  const ids = new Set(); const tabOrders = new Set();
  for (const control of controls) {
    if (!stable(control.id) || ids.has(control.id) || !CONTROL_TYPES[control.type]) fail('plainform_form_control_invalid', `Control ${control?.id ?? '<missing>'} has an invalid ID or type.`);
    ids.add(control.id);
    if (control.parentId !== null && !stable(control.parentId)) fail('plainform_form_parent_invalid', `Control ${control.id} has an invalid parent.`);
    if (!Number.isSafeInteger(control.tabIndex) || control.tabIndex < -1 || control.tabIndex > 255 || (control.tabIndex >= 0 && tabOrders.has(control.tabIndex))) fail('plainform_form_tab_order', 'Focusable control tab indexes must be unique integers from 0 to 255.');
    if (control.tabIndex >= 0) tabOrders.add(control.tabIndex);
    control.name ??= control.id.split('/').at(-1); control.accessibilityLabel ??= control.text ?? control.name;
    control.properties = { ...(control.properties ?? {}) }; control.layout = { ...(control.layout ?? {}) };
    control.components = [...CONTROL_TYPES[control.type]];
  }
  for (const control of controls) if (control.parentId !== null && !ids.has(control.parentId)) fail('plainform_form_parent_missing', `Control ${control.id} references missing parent ${control.parentId}.`);
  const bindings = clone(input.eventBindings ?? []);
  for (const binding of bindings) if (!ids.has(binding.controlId) || !stable(binding.eventSheetId) || !stable(binding.eventId)) fail('plainform_form_binding_invalid', 'Form events must bind an existing control to stable event sheet and event IDs.');
  return Object.freeze({
    formatVersion: 1, id: input.id, kind: 'form', name: input.name ?? input.id.split('/').at(-1), windowType: input.windowType,
    modal: input.windowType === 'modalDialog', ownerFormId: input.ownerFormId ?? null,
    controls: Object.freeze(controls.map(Object.freeze)), eventBindings: Object.freeze(bindings.map(Object.freeze)),
    inputPolicy: Object.freeze({ stopCanvasKeyboard: true, stopCanvasPointer: true, multilineEnter: 'newline', submitChord: 'Control+Enter', supportsIme: true, ...(input.inputPolicy ?? {}) }),
    defaultButtonId: input.defaultButtonId ?? null, cancelButtonId: input.cancelButtonId ?? null,
    metadata: clone(input.metadata ?? {}),
  });
}

export function createFormEventSheet(form, actions = []) {
  const graphId = `blueprint/form-${form.id.split('/').at(-1)}-events`;
  const eventIds = [...new Set(form.eventBindings.map(binding => binding.eventId))];
  const graph = { formatVersion: 1, id: graphId, domain: 'blueprint', nodes: eventIds.map((eventId, index) => ({ id: `event/control-${String(index + 1).padStart(3, '0')}`, type: 'event.onEvent', params: { eventId } })), edges: [], outputs: {} };
  const validation = validateGraph(graph); if (!validation.valid) fail('plainform_form_event_graph_invalid', validation.errors[0]?.message ?? 'Form event sheet is invalid.');
  return { id: graphId, kind: 'graph', name: `${form.name} Events`, metadata: { plainform: { kind: 'formEventSheet', formId: form.id, actions: clone(actions) } }, graph: validation.graph };
}

export function inspectFormComponents(form) {
  return Object.freeze(form.controls.map(control => Object.freeze({ id: control.id, type: control.type, components: Object.freeze([...control.components]), compatible: true })));
}
