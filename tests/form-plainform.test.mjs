import assert from 'node:assert/strict';
import test from 'node:test';

import { AuthoringKernel, createProjectDocument } from '../src/core/index.mjs';
import { FORM_CONTROL_CATALOG, createFormDocument, inspectFormComponents } from '../src/forms/form-document.mjs';
import { createRetainedForm } from '../src/forms/retained-form-runtime.mjs';
import { operationSchema } from '../src/mcp/tool-schemas.mjs';
import { PlainformCompiler } from '../src/plainform/index.mjs';

const project = () => createProjectDocument({ projectId: 'project/forms', scenes: [{ id: 'scene/main' }] });

test('Form control catalog covers the bounded shared native/browser control model', () => {
  assert.deepEqual(FORM_CONTROL_CATALOG.map(item => item.type), [
    'panel', 'stack', 'grid', 'label', 'button', 'checkbox', 'radioGroup', 'singleLineInput', 'multilineInput', 'numberInput', 'list', 'tree', 'tabs', 'progress', 'image', 'viewportHost',
  ]);
  assert.ok(FORM_CONTROL_CATALOG.every(item => item.sharedHosts.join(',') === 'native,browser'));
  assert.deepEqual(FORM_CONTROL_CATALOG.find(item => item.type === 'multilineInput').browserAdapterOnly, ['ime', 'accessibility', 'clipboard']);
});

test('Form Plainform creates and regenerates one canonical Inventory form with Stage 9 event bindings', async () => {
  const source = [
    'Create an Inventory window with a two-column layout, an item tree on the left, details on the right, and Use and Close buttons along the bottom.',
    'When Close is clicked, close Inventory. When an item is selected, show its name, description, weight, and icon in the details panel.',
  ].join('\n');
  const initial = project(); const compiled = new PlainformCompiler().compile(source, { project: initial });
  assert.equal(compiled.dialect, 'form');
  assert.equal(compiled.form.controlCount, 9);
  assert.ok(compiled.operations.every(operation => operationSchema.safeParse(operation).success));
  const asset = compiled.operations[0].items.find(item => item.resourceType === 'assets').resource;
  const graph = compiled.operations[0].items.find(item => item.resourceType === 'graphs').resource;
  assert.equal(asset.form.controls.find(control => control.type === 'tree').components.includes('expand'), true);
  assert.ok(asset.form.eventBindings.every(binding => binding.eventSheetId === graph.id));
  assert.ok(graph.metadata.plainform.actions.some(action => action.type === 'closeForm'));

  const kernel = new AuthoringKernel(initial);
  await kernel.apply({ baseRevision: 0, idempotencyKey: 'create-inventory-form', label: 'Create Inventory', operations: compiled.operations });
  const regenerated = new PlainformCompiler().compile(source, { project: kernel.document });
  assert.deepEqual(regenerated.operations.map(operation => operation.op), ['resource.patch', 'resource.patch']);
});

test('modal multiline retained form consumes editing keys and emits only the canonical Control+Enter binding', () => {
  const compiled = new PlainformCompiler().compile('Create a modal Save Game dialog with a multiline notes box. Enter adds a line; Control+Enter confirms only when a slot is selected.', { project: project() });
  const form = compiled.operations[0].items.find(item => item.resourceType === 'assets').resource.form;
  const emitted = []; const runtime = createRetainedForm(form, { emitEvent: (...args) => emitted.push(args) });
  assert.equal(runtime.inputContract.sharedRetainedModel, true);
  assert.equal(runtime.inputContract.stopCanvasKeyboard, true);
  runtime.open();
  const notes = runtime.controls.get('control/save-game/notes'); notes.setFocused(true);
  assert.equal(runtime.handleKey({ key: 'H' }), true);
  assert.equal(runtime.handleKey({ key: 'Enter' }), true);
  assert.equal(notes.text, 'H\n');
  assert.equal(emitted.length, 0);
  assert.equal(runtime.handleKey({ key: 'Enter', ctrlKey: true }), true);
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0].slice(0, 2), ['blueprint/form-save-game-events', 'event/form-save-game-confirm']);
});

test('canonical form validation exposes component presence and rejects duplicate tab order or missing parents', () => {
  const form = createFormDocument({
    id: 'asset/forms/simple', name: 'Simple', windowType: 'window', controls: [
      { id: 'control/simple/root', type: 'panel', parentId: null, tabIndex: -1 },
      { id: 'control/simple/input', type: 'singleLineInput', parentId: 'control/simple/root', tabIndex: 0 },
    ],
  });
  assert.deepEqual(inspectFormComponents(form)[1].components, ['text', 'selection', 'clipboard', 'undo', 'ime']);
  assert.throws(() => createFormDocument({ id: 'asset/forms/bad', windowType: 'window', controls: [
    { id: 'control/bad/a', type: 'button', parentId: null, tabIndex: 0 },
    { id: 'control/bad/b', type: 'button', parentId: 'control/bad/missing', tabIndex: 0 },
  ] }), error => ['plainform_form_tab_order', 'plainform_form_parent_missing'].includes(error.code));
});
