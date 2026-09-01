import { createFormDocument, createFormEventSheet } from '../forms/form-document.mjs';

const clean = value => value.trim().replace(/[.;]+$/u, '').trim();
const slug = value => clean(value).toLowerCase().replace(/^(?:the|a|an)\s+/u, '').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
const control = (formSlug, id, type, parentId, tabIndex, text, bounds, properties = {}) => ({ id: `control/${formSlug}/${id}`, type, parentId, tabIndex, text, layout: { bounds }, properties });

export class FormPlainformCompiler {
  compile(source, { project } = {}) {
    if (!project) fail('plainform_project_required', 'Form Plainform requires the canonical project document.');
    const lines = source.split(/\r?\n/u).map(clean).filter(Boolean); const header = lines[0];
    const inventory = header.match(/^create an? (.+?) window with a two-column layout, an item tree on the left, details on the right, and (.+?) and (.+?) buttons along the bottom$/iu);
    const modal = header.match(/^create a modal (.+?) dialog with a multiline (.+?) box(?:\. enter adds a line; control\+enter confirms only when a slot is selected)?$/iu);
    if (!inventory && !modal) fail('plainform_form_header', 'Begin with a supported window or modal dialog description.');
    const name = clean(inventory?.[1] ?? modal[1]); const formSlug = slug(name); const formId = `asset/forms/${formSlug}`; const eventSheetId = `blueprint/form-${formSlug}-events`;
    let controls; let eventBindings; let actions; let defaultButtonId; let cancelButtonId;
    if (inventory) {
      const root = `control/${formSlug}/layout`; const details = `control/${formSlug}/details`;
      controls = [
        control(formSlug, 'layout', 'grid', null, -1, '', [8, 8, 624, 404], { columns: ['40%', '60%'], rows: ['1fr', 'auto'] }),
        control(formSlug, 'items', 'tree', root, 0, 'Items', [0, 0, 240, 350], { items: [] }),
        control(formSlug, 'details', 'panel', root, -1, 'Details', [248, 0, 376, 350]),
        control(formSlug, 'item-name', 'label', details, -1, 'Name', [8, 8, 350, 28]),
        control(formSlug, 'description', 'multilineInput', details, 1, 'Description', [8, 44, 350, 150], { text: '', readOnly: true }),
        control(formSlug, 'weight', 'label', details, -1, 'Weight', [8, 202, 350, 28]),
        control(formSlug, 'icon', 'image', details, -1, 'Icon', [8, 238, 96, 96]),
        control(formSlug, slug(inventory[2]), 'button', root, 2, clean(inventory[2]), [416, 362, 96, 34]),
        control(formSlug, slug(inventory[3]), 'button', root, 3, clean(inventory[3]), [520, 362, 96, 34]),
      ];
      const useId = `control/${formSlug}/${slug(inventory[2])}`; const closeId = `control/${formSlug}/${slug(inventory[3])}`;
      eventBindings = [
        { controlId: useId, event: 'click', eventSheetId, eventId: `event/form-${formSlug}-use` },
        { controlId: closeId, event: 'click', eventSheetId, eventId: `event/form-${formSlug}-close` },
        { controlId: `control/${formSlug}/items`, event: 'selectionChanged', eventSheetId, eventId: `event/form-${formSlug}-selection` },
      ];
      actions = [
        { eventId: `event/form-${formSlug}-close`, type: 'closeForm', formId, result: 'cancel' },
        { eventId: `event/form-${formSlug}-selection`, type: 'showSelectionDetails', targets: ['item-name', 'description', 'weight', 'icon'] },
        { eventId: `event/form-${formSlug}-use`, type: 'emitSelection', event: 'event/item-use' },
      ];
      defaultButtonId = useId; cancelButtonId = closeId;
    } else {
      const root = `control/${formSlug}/layout`; const notesName = slug(modal[2]);
      controls = [
        control(formSlug, 'layout', 'stack', null, -1, '', [8, 8, 472, 304], { direction: 'vertical', gap: 8 }),
        control(formSlug, 'slots', 'list', root, 0, 'Save slots', [0, 0, 456, 96], { items: [] }),
        control(formSlug, notesName, 'multilineInput', root, 1, clean(modal[2]), [0, 104, 456, 132], { text: '', maximumLength: 4096, enter: 'newline', submitChord: 'Control+Enter' }),
        control(formSlug, 'confirm', 'button', root, 2, 'Confirm', [248, 244, 96, 34]),
        control(formSlug, 'cancel', 'button', root, 3, 'Cancel', [352, 244, 96, 34]),
      ];
      const notesId = `control/${formSlug}/${notesName}`; const confirmId = `control/${formSlug}/confirm`; const cancelId = `control/${formSlug}/cancel`;
      eventBindings = [
        { controlId: notesId, event: 'submit', eventSheetId, eventId: `event/form-${formSlug}-confirm` },
        { controlId: confirmId, event: 'click', eventSheetId, eventId: `event/form-${formSlug}-confirm` },
        { controlId: cancelId, event: 'click', eventSheetId, eventId: `event/form-${formSlug}-cancel` },
      ];
      actions = [
        { eventId: `event/form-${formSlug}-confirm`, type: 'closeForm', formId, result: 'ok', condition: { controlId: `control/${formSlug}/slots`, property: 'selectedIndex', operation: 'greaterEqual', value: 0 } },
        { eventId: `event/form-${formSlug}-cancel`, type: 'closeForm', formId, result: 'cancel' },
      ];
      defaultButtonId = confirmId; cancelButtonId = cancelId;
    }
    const form = createFormDocument({ id: formId, name, windowType: inventory ? 'window' : 'modalDialog', controls, eventBindings, defaultButtonId, cancelButtonId, metadata: { plainform: { source, kind: 'form', actions } } });
    const eventSheet = createFormEventSheet(form, actions); const existingForm = project.resources.assets?.[formId]; const existingGraph = project.resources.graphs?.[eventSheet.id];
    if (existingForm && existingForm.metadata?.plainform?.kind !== 'form') fail('plainform_form_ownership_conflict', `Asset ${formId} is not owned by Form Plainform.`);
    if (existingGraph && existingGraph.metadata?.plainform?.kind !== 'formEventSheet') fail('plainform_form_ownership_conflict', `Graph ${eventSheet.id} is not owned by Form Plainform.`);
    const items = [];
    if (!existingForm) items.push({ resourceType: 'assets', resource: { id: formId, kind: 'form', name, metadata: { plainform: { kind: 'form', source } }, form } });
    if (!existingGraph) items.push({ resourceType: 'graphs', resource: eventSheet });
    const operations = [...(items.length ? [{ op: 'resource.createMany', items }] : [])];
    if (existingForm) operations.push({ op: 'resource.patch', resourceType: 'assets', resourceId: formId, patch: { form, metadata: { plainform: { kind: 'form', source } } } });
    if (existingGraph) operations.push({ op: 'resource.patch', resourceType: 'graphs', resourceId: eventSheet.id, patch: { graph: eventSheet.graph, metadata: eventSheet.metadata } });
    return Object.freeze({ language: 'plainform-v1', dialect: 'form', source, operations: Object.freeze(operations), interpretation: Object.freeze([`Create shared retained ${form.windowType} ${name} with ${form.controls.length} canonical controls and Stage 9 bindings.`]), aliases: Object.freeze({}), requestedPreview: false, form: Object.freeze({ formId, eventSheetId: eventSheet.id, controlCount: form.controls.length, modal: form.modal }) });
  }
}
