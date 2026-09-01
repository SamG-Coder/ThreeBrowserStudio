import { Button, Control, Label, RadioOption, TabStrip, TextInput, ToggleOption, ToolWindow, VirtualList } from '../viewport/overlay-controls.mjs';

function createControl(source, emit) {
  const common = { name: source.id, ...(source.layout?.bounds ? { x: source.layout.bounds[0], y: source.layout.bounds[1], width: source.layout.bounds[2], height: source.layout.bounds[3] } : {}) };
  const event = name => emit?.(source.id, name, { value: controlValue(source, instance) });
  let instance;
  if (source.type === 'label') instance = new Label({ ...common, text: source.text ?? '' });
  else if (source.type === 'button') instance = new Button({ ...common, text: source.text ?? source.name, onClick: () => event('click') });
  else if (source.type === 'checkbox') instance = new ToggleOption({ ...common, text: source.text ?? source.name, selected: source.properties.value === true, onChange: () => event('change') });
  else if (source.type === 'radioGroup') instance = new RadioOption({ ...common, text: source.text ?? source.name, selected: source.properties.value === true, onSelect: () => event('change') });
  else if (source.type === 'singleLineInput' || source.type === 'multilineInput' || source.type === 'numberInput') instance = new TextInput({ ...common, text: source.properties.text ?? '', multiline: source.type === 'multilineInput', maximumLength: source.properties.maximumLength ?? 4096, onChange: () => event('change'), onSubmit: () => event('submit') });
  else if (source.type === 'tabs') instance = new TabStrip({ ...common, tabs: source.properties.items ?? [] });
  else if (source.type === 'list' || source.type === 'tree') instance = new VirtualList({ ...common, itemCount: source.properties.items?.length ?? 0, onActivate: index => emit?.(source.id, 'selectionChanged', { index, item: source.properties.items?.[index] }) });
  else instance = new Control(common);
  return instance;
}

function controlValue(source, instance) {
  if (instance instanceof TextInput) return instance.text;
  if (instance instanceof ToggleOption || instance instanceof RadioOption) return instance.selected;
  return source.properties?.value;
}

export function createRetainedForm(form, { emitEvent } = {}) {
  const bindings = new Map(form.eventBindings.map(binding => [`${binding.controlId}:${binding.event}`, binding]));
  const emit = (controlId, event, payload) => { const binding = bindings.get(`${controlId}:${event}`); if (binding) emitEvent?.(binding.eventSheetId, binding.eventId, payload); };
  const window = new ToolWindow({ name: form.id, title: form.name, modal: form.modal, closable: true });
  const controls = new Map();
  for (const source of form.controls) controls.set(source.id, createControl(source, emit));
  for (const source of form.controls) (source.parentId === null ? window.content : controls.get(source.parentId))?.add(controls.get(source.id));
  return Object.freeze({
    form, window, controls,
    open() { return form.modal ? window.showDialog() : window.open(); },
    close(result) { return window.close(result); },
    focusedTextInput() { return [...controls.values()].find(control => control instanceof TextInput && control.focused) ?? null; },
    handleKey(event) {
      const focused = this.focusedTextInput(); if (focused) return focused.handleKey(event);
      if (event?.key === 'Escape' && form.cancelButtonId) { controls.get(form.cancelButtonId)?.onPointerDown?.(); controls.get(form.cancelButtonId)?.onPointerUp?.(event, { inside: true }); return true; }
      if (event?.key === 'Enter' && form.defaultButtonId) { controls.get(form.defaultButtonId)?.onPointerDown?.(); controls.get(form.defaultButtonId)?.onPointerUp?.(event, { inside: true }); return true; }
      return false;
    },
    inputContract: Object.freeze({ ...form.inputPolicy, sharedRetainedModel: true, browserAdapterOnly: Object.freeze(['ime', 'clipboard', 'accessibility', 'filePicker']) }),
  });
}
