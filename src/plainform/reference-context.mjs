function clean(value) {
  return String(value ?? '').trim().replace(/[.:;]+$/u, '').trim();
}

function key(value) {
  return clean(value).toLowerCase().replace(/^(?:the|those|these)\s+/u, '').replace(/\s+/gu, ' ');
}

function inflections(value) {
  const parts = value.split(' ');
  const noun = parts.pop();
  const prefix = parts.length > 0 ? `${parts.join(' ')} ` : '';
  const forms = new Set([value]);
  if (/[^aeiou]y$/u.test(noun)) forms.add(`${prefix}${noun.slice(0, -1)}ies`);
  else if (noun.endsWith('fe')) forms.add(`${prefix}${noun.slice(0, -2)}ves`);
  else if (noun.endsWith('f')) forms.add(`${prefix}${noun.slice(0, -1)}ves`);
  else if (/(?:s|x|z|ch|sh)$/u.test(noun)) forms.add(`${prefix}${noun}es`);
  else forms.add(`${prefix}${noun}s`);
  if (noun.endsWith('ies')) forms.add(`${prefix}${noun.slice(0, -3)}y`);
  if (noun.endsWith('ves')) {
    forms.add(`${prefix}${noun.slice(0, -3)}f`);
    forms.add(`${prefix}${noun.slice(0, -3)}fe`);
  }
  if (noun.endsWith('es')) forms.add(`${prefix}${noun.slice(0, -2)}`);
  if (noun.endsWith('s') && !noun.endsWith('ss')) forms.add(`${prefix}${noun.slice(0, -1)}`);
  return forms;
}

function sameAlias(left, right) {
  const leftForms = inflections(key(left));
  return [...inflections(key(right))].some(form => leftForms.has(form));
}

/**
 * Explicit discourse state for Plainform. It resolves names and pronouns from
 * canonical records; no entity IDs or domain nouns are embedded in the language.
 */
export class PlainformReferenceContext {
  constructor({ index, resolveEntity, fail }) {
    this.index = index;
    this.resolveEntity = resolveEntity;
    this.fail = fail;
    this.aliases = new Map();
    this.references = new Map();
    this.previousSelection = null;
  }

  nameSelection(name, selection) {
    this.aliases.set(key(name), selection);
    this.previousSelection = selection;
  }

  replaceSelection(name, selection) {
    const matched = [...this.aliases.keys()].find(candidate => sameAlias(candidate, name));
    this.aliases.set(matched ?? key(name), selection);
    this.previousSelection = selection;
  }

  nameReference(name, record) {
    this.references.set(key(name), record);
  }

  selection(name) {
    const requested = key(name);
    if (requested === 'previous selection' || requested === 'last selection') {
      if (!this.previousSelection) this.fail('plainform_missing_selection', 'There is no previous selection in this program.');
      return this.previousSelection;
    }
    const match = [...this.aliases].find(([candidate]) => sameAlias(candidate, requested))?.[1];
    if (!match) this.fail('plainform_unknown_alias', `I do not know which objects “${name}” refers to.`);
    return match;
  }

  records(phrase, { current = null } = {}) {
    const requested = key(phrase);
    if (['it', 'itself', 'this object', 'current object'].includes(requested)) {
      if (!current) this.fail('plainform_missing_context', `“${phrase}” requires a current loop object.`);
      return [current];
    }
    if (requested === 'its parent' || requested === 'parent') {
      if (!current) this.fail('plainform_missing_context', `“${phrase}” requires a current loop object.`);
      const parent = current.entity.parentId ? this.index.entities.get(current.entity.parentId) : null;
      if (!parent) this.fail('plainform_reference_not_found', `${current.entity.id} has no parent.`);
      return [parent];
    }
    if (requested === 'its children' || requested === 'children') {
      if (!current) this.fail('plainform_missing_context', `“${phrase}” requires a current loop object.`);
      return (current.entity.children ?? []).map(id => this.index.entities.get(id)).filter(Boolean);
    }
    if (requested === 'previous selection' || requested === 'last selection') return this.selection(requested).records;
    const named = [...this.references].find(([candidate]) => sameAlias(candidate, requested))?.[1];
    if (named) return [named];
    const alias = [...this.aliases].find(([candidate]) => sameAlias(candidate, requested))?.[1];
    if (alias) return alias.records;
    return [this.resolveEntity(this.index, phrase)];
  }

  one(phrase, { current = null, positionOf = null } = {}) {
    const nearest = clean(phrase).match(/^(?:the\s+)?nearest (?:object|entity|item)?\s*(?:in|from)\s+(.+)$/iu);
    if (nearest) {
      if (!current || !positionOf) this.fail('plainform_missing_context', 'Nearest-object references require a current loop object.');
      const candidates = this.records(nearest[1], { current }).filter(record => record.entity.id !== current.entity.id);
      if (candidates.length === 0) this.fail('plainform_reference_not_found', `No candidate exists in “${nearest[1]}”.`);
      const origin = positionOf(current);
      return candidates.toSorted((left, right) => {
        const leftDistance = Math.hypot(...positionOf(left).map((value, axis) => value - origin[axis]));
        const rightDistance = Math.hypot(...positionOf(right).map((value, axis) => value - origin[axis]));
        return leftDistance - rightDistance || left.entity.id.localeCompare(right.entity.id);
      })[0];
    }
    const records = this.records(phrase, { current });
    if (records.length !== 1) {
      this.fail('plainform_reference_not_singular', `“${phrase}” refers to ${records.length} entities; name one entity or use “the nearest object in …”.`);
    }
    return records[0];
  }

  aliasEntries() {
    return this.aliases.entries();
  }
}
