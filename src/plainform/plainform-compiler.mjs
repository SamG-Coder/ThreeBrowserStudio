import { ProjectIndex } from '../core/indexes.mjs';
import { hashExactEntitySet } from '../core/entity-selection.mjs';
import { composeTransformMatrix, relativeEntityTransform } from '../core/transform-math.mjs';
import { PlainformReferenceContext } from './reference-context.mjs';
import { PlainformSpatialResolver } from './spatial-relations.mjs';
import { PlainformAnchorResolver } from './anchor-resolver.mjs';
import { PlainformGrowthPlanner } from './growth-planner.mjs';
import { PlainformPrefabContext } from './prefab-context.mjs';
import { ShaderPlainformCompiler } from './shader-plainform-compiler.mjs';
import { DesignPlainformCompiler } from './design-plainform-compiler.mjs';
import { EventPlainformCompiler } from './event-plainform-compiler.mjs';
import { parsePlainformProgram } from './plainform-front-end.mjs';

const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const MAX_STATEMENTS = 256;
const MAX_GENERATED_OPERATIONS = 128;

export class PlainformError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PlainformError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new PlainformError(code, message, details);
}

function cleanStatement(value) {
  return value.trim().replace(/[.:;]+$/u, '').trim();
}

function aliasKey(value) {
  return cleanStatement(value).toLowerCase().replace(/^(?:the|those|these)\s+/u, '').replace(/\s+/gu, ' ');
}

function slug(value) {
  return aliasKey(value).replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'group';
}

function wordsNumber(source) {
  const units = new Map([
    ['zero', 0], ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
    ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
    ['eleven', 11], ['twelve', 12], ['thirteen', 13], ['fourteen', 14], ['fifteen', 15],
    ['sixteen', 16], ['seventeen', 17], ['eighteen', 18], ['nineteen', 19],
    ['twenty', 20], ['thirty', 30], ['forty', 40], ['fifty', 50],
    ['sixty', 60], ['seventy', 70], ['eighty', 80], ['ninety', 90],
  ]);
  const parts = source.toLowerCase().replaceAll('-', ' ').split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return null;
  let total = 0;
  let current = 0;
  for (const part of parts) {
    if (units.has(part)) current += units.get(part);
    else if (part === 'hundred') current = Math.max(1, current) * 100;
    else if (part === 'thousand') { total += Math.max(1, current) * 1_000; current = 0; }
    else if (part === 'and') continue;
    else return null;
  }
  return total + current;
}

function quantity(value, dimension = 'scalar') {
  return Object.freeze({ value, dimension });
}

function compatible(left, right) {
  if (left.dimension === right.dimension) return left.dimension;
  if (left.value === 0 && left.dimension === 'scalar') return right.dimension;
  if (right.value === 0 && right.dimension === 'scalar') return left.dimension;
  return null;
}

function add(left, right, sign = 1) {
  const dimension = compatible(left, right);
  if (!dimension) fail('plainform_dimension_mismatch', `Cannot combine ${left.dimension} with ${right.dimension}.`);
  return quantity(left.value + right.value * sign, dimension);
}

function multiply(left, right) {
  if (left.dimension === 'scalar') return quantity(left.value * right.value, right.dimension);
  if (right.dimension === 'scalar') return quantity(left.value * right.value, left.dimension);
  fail('plainform_dimension_mismatch', `Cannot multiply ${left.dimension} by ${right.dimension}.`);
}

function divide(left, right) {
  if (right.value === 0) fail('plainform_math_error', 'Cannot divide by zero.');
  if (right.dimension === 'scalar') return quantity(left.value / right.value, left.dimension);
  if (left.dimension === right.dimension) return quantity(left.value / right.value, 'scalar');
  fail('plainform_dimension_mismatch', `Cannot divide ${left.dimension} by ${right.dimension}.`);
}

function stripOuterParentheses(source) {
  let value = source.trim();
  for (;;) {
    if (!value.startsWith('(') || !value.endsWith(')')) return value;
    let depth = 0;
    let wraps = true;
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === '(') depth += 1;
      else if (value[index] === ')') depth -= 1;
      if (depth === 0 && index < value.length - 1) { wraps = false; break; }
    }
    if (!wraps) return value;
    value = value.slice(1, -1).trim();
  }
}

function splitOutside(source, phrases) {
  let depth = 0;
  const lower = source.toLowerCase();
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const char = source[index];
    if (char === ')') depth += 1;
    else if (char === '(') depth -= 1;
    if (depth !== 0) continue;
    for (const phrase of phrases) {
      const start = index - phrase.length + 1;
      if (start >= 0 && lower.slice(start, index + 1) === phrase) {
        return [source.slice(0, start).trim(), phrase.trim(), source.slice(index + 1).trim()];
      }
    }
  }
  return null;
}

function deterministicNoise(value, seed) {
  let state = (Math.imul(Math.floor(value * 1_000_003), 0x9e3779b1) ^ Math.imul(seed | 0, 0x85ebca6b)) >>> 0;
  state ^= state >>> 16; state = Math.imul(state, 0x7feb352d); state ^= state >>> 15;
  return ((state >>> 0) / 0xffffffff) * 2 - 1;
}

function atom(source, variables) {
  let value = source.trim().toLowerCase().replace(/^the\s+/u, '');
  value = value.replace(/^its number$/u, 'number').replace(/^its index$/u, 'index');
  value = value.replace(/^its sibling number$/u, 'sibling number').replace(/^its sibling index$/u, 'sibling index');
  value = value.replace(/^(?:the )?total number of siblings$/u, 'sibling count');
  value = value.replace(/^(?:the )?total number of .+$/u, 'count');
  value = value.replace(/^its ([xyz]) position$/u, '$1');
  if (variables.has(value)) return variables.get(value);
  if (value === 'pi') return quantity(Math.PI);
  if (value === 'tau' || value === 'one full turn' || value === 'a full turn') return quantity(TAU, 'angle');
  if (value === 'half a turn' || value === 'half of one full turn') return quantity(Math.PI, 'angle');
  if (value === 'the golden angle' || value === 'golden angle') return quantity(GOLDEN_ANGLE, 'angle');
  const unitMatch = value.match(/^(.+?)\s*(millimetres?|millimeters?|centimetres?|centimeters?|metres?|meters?|degrees?|radians?|percent)$/u);
  const numericSource = unitMatch ? unitMatch[1].trim() : value;
  const numeric = /^-?\d+(?:\.\d+)?$/u.test(numericSource) ? Number(numericSource) : wordsNumber(numericSource);
  if (numeric !== null && Number.isFinite(numeric)) {
    const unit = unitMatch?.[2];
    if (!unit) return quantity(numeric);
    if (/^m(?:etre|eter)/u.test(unit)) return quantity(numeric, 'length');
    if (/^cent/u.test(unit)) return quantity(numeric / 100, 'length');
    if (/^milli/u.test(unit)) return quantity(numeric / 1_000, 'length');
    if (/^degree/u.test(unit)) return quantity(numeric * Math.PI / 180, 'angle');
    if (/^radian/u.test(unit)) return quantity(numeric, 'angle');
    if (unit === 'percent') return quantity(numeric / 100);
  }
  fail('plainform_unknown_expression', `I could not understand the mathematical phrase “${source}”.`);
}

/** Evaluates bounded controlled-English mathematics without eval or JavaScript execution. */
export function evaluatePlainformMath(source, variables = new Map()) {
  let expression = stripOuterParentheses(cleanStatement(source));
  const sum = splitOutside(expression, [' plus ', ' minus ']);
  if (sum) return add(evaluatePlainformMath(sum[0], variables), evaluatePlainformMath(sum[2], variables), sum[1] === 'minus' ? -1 : 1);
  const product = splitOutside(expression, [' multiplied by ', ' times ', ' divided by ']);
  if (product) {
    const left = evaluatePlainformMath(product[0], variables);
    const right = evaluatePlainformMath(product[2], variables);
    return product[1] === 'divided by' ? divide(left, right) : multiply(left, right);
  }
  if (/^twice\s+/iu.test(expression)) return multiply(quantity(2), evaluatePlainformMath(expression.replace(/^twice\s+/iu, ''), variables));
  if (/^half of\s+/iu.test(expression)) return multiply(quantity(0.5), evaluatePlainformMath(expression.replace(/^half of\s+/iu, ''), variables));
  const seededNoise = expression.match(/^seeded noise of (.+) using seed (-?\d+)$/iu);
  if (seededNoise) {
    const input = evaluatePlainformMath(seededNoise[1], variables);
    if (input.dimension !== 'scalar') fail('plainform_dimension_mismatch', 'Seeded noise input must be scalar.');
    return quantity(deterministicNoise(input.value, Number(seededNoise[2])));
  }
  for (const [prefix, fn] of [
    ['the sine of ', Math.sin], ['sine of ', Math.sin],
    ['the cosine of ', Math.cos], ['cosine of ', Math.cos],
    ['the absolute value of ', Math.abs], ['absolute value of ', Math.abs],
    ['the square root of ', Math.sqrt], ['square root of ', Math.sqrt],
  ]) {
    if (expression.toLowerCase().startsWith(prefix)) {
      const input = evaluatePlainformMath(expression.slice(prefix.length), variables);
      if ((fn === Math.sin || fn === Math.cos) && !['angle', 'scalar'].includes(input.dimension)) {
        fail('plainform_dimension_mismatch', `${prefix.trim()} requires an angle.`);
      }
      if (fn === Math.sqrt && input.value < 0) fail('plainform_math_error', 'Cannot take the square root of a negative value.');
      return quantity(fn(input.value), fn === Math.abs ? input.dimension : 'scalar');
    }
  }
  return atom(expression, variables);
}

function vectorExpression(source, variables, expectedDimension) {
  const match = source.trim().match(/^\[(.*)\]$/u);
  if (!match) fail('plainform_vector_expected', `Expected a three-part vector, received “${source}”.`);
  const parts = match[1].split(',').map(part => part.trim());
  if (parts.length !== 3) fail('plainform_vector_expected', 'Vectors must contain exactly three values.');
  return parts.map(part => {
    const result = evaluatePlainformMath(part, variables);
    if (result.dimension !== expectedDimension && !(result.dimension === 'scalar' && result.value === 0)) {
      fail('plainform_dimension_mismatch', `Vector component “${part}” must be ${expectedDimension}.`);
    }
    return result.value;
  });
}

function entityKindFromPhrase(phrase) {
  if (/\bmesh(?:es)?\b/iu.test(phrase)) return new Set(['mesh', 'instancedMesh']);
  if (/\bgroups?\b/iu.test(phrase)) return new Set(['group']);
  if (/\bcameras?\b/iu.test(phrase)) return new Set(['perspectiveCamera', 'orthographicCamera']);
  if (/\blights?\b/iu.test(phrase)) return new Set(['ambientLight', 'hemisphereLight', 'directionalLight', 'pointLight', 'spotLight', 'areaLight']);
  if (/\b(?:objects?|entities)\b/iu.test(phrase)) return null;
  fail('plainform_unknown_noun', `I could not determine an entity kind in “${phrase}”.`);
}

function resolveEntityReference(index, phrase) {
  const value = cleanStatement(phrase).replace(/^(?:the|an?)\s+/iu, '').replace(/^"|"$/gu, '');
  if (index.entities.has(value)) return index.entities.get(value);
  const matches = [...index.entities.values()].filter(({ entity }) => entity.name?.toLowerCase() === value.toLowerCase());
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) fail('plainform_reference_not_found', `No entity matches “${phrase}”.`);
  fail('plainform_ambiguous_reference', `“${phrase}” matches ${matches.length} entities; use an exact ID.`);
}

function isDescendant(scene, entity, ancestorId) {
  let current = entity;
  while (current?.parentId) {
    if (current.parentId === ancestorId) return true;
    current = scene.entities[current.parentId];
  }
  return false;
}

function selectionFromFind(index, statement, context, spatial) {
  const phrase = statement.replace(/^find every\s+/iu, '');
  const kinds = entityKindFromPhrase(phrase);
  const tag = phrase.match(/(?:tagged|with the tag)\s+"([^"]+)"/iu)?.[1];
  const nameNeedle = phrase.match(/whose name contains\s+"([^"]+)"/iu)?.[1]?.toLowerCase();
  const ancestorPhrase = phrase.match(/(?:beneath|under)\s+(.+?)(?=\s+(?:that is tagged|tagged|with the tag|whose name|within)\b|$)/iu)?.[1];
  const ancestors = ancestorPhrase ? context.records(ancestorPhrase) : [];
  const proximity = phrase.match(/\bwithin\s+(.+?)\s+of\s+(.+?)(?=\s+(?:that is tagged|tagged|with the tag|whose name)\b|$)/iu);
  const proximityDistance = proximity ? evaluatePlainformMath(proximity[1]) : null;
  if (proximityDistance && proximityDistance.dimension !== 'length') {
    fail('plainform_dimension_mismatch', 'A spatial selection distance must be a length.');
  }
  const proximityReferences = proximity ? context.records(proximity[2]) : [];
  const visible = /\bvisible\b/iu.test(phrase);
  const results = [...index.entities.values()].filter(({ scene, entity }) => (
    (!kinds || kinds.has(entity.kind))
    && (!tag || entity.tags?.includes(tag))
    && (!nameNeedle || entity.name?.toLowerCase().includes(nameNeedle))
    && (!visible || entity.visible !== false)
    && (ancestors.length === 0 || ancestors.some(ancestor => (
      scene.id === ancestor.scene.id && isDescendant(scene, entity, ancestor.entity.id)
    )))
    && (proximityReferences.length === 0 || proximityReferences.some(reference => (
      scene.id === reference.scene.id && spatial.distance({ scene, entity }, reference) <= proximityDistance.value
    )))
  ));
  return results.sort((left, right) => left.entity.id.localeCompare(right.entity.id));
}

function selectionRecord(project, records) {
  const ids = records.map(({ entity }) => entity.id);
  return { records, ids, hash: hashExactEntitySet(project, ids, { allowEmpty: true }) };
}

function countAndAlias(source) {
  const words = source.trim().split(/\s+/u);
  for (let length = words.length - 1; length >= 1; length -= 1) {
    const countSource = words.slice(0, length).join(' ');
    const count = /^\d+$/u.test(countSource) ? Number(countSource) : wordsNumber(countSource);
    if (Number.isSafeInteger(count) && count >= 0 && count <= 256) {
      return { count, alias: words.slice(length).join(' ') };
    }
  }
  fail('plainform_count_expected', `I could not find a bounded count and selection name in “${source}”.`);
}

function distance(left, right) {
  return Math.hypot(
    left.transform.position[0] - right.transform.position[0],
    left.transform.position[1] - right.transform.position[1],
    left.transform.position[2] - right.transform.position[2],
  );
}

function cloneTransform(entity) {
  return {
    position: [...entity.transform.position], rotation: [...entity.transform.rotation], scale: [...entity.transform.scale],
    ...(entity.transform.quaternion ? { quaternion: [...entity.transform.quaternion] } : {}),
  };
}

function cardinalAxis(sign, name) {
  const axis = [0, 0, 0];
  axis['xyz'.indexOf(name.toLowerCase())] = sign.toLowerCase() === 'negative' ? -1 : 1;
  return axis;
}

function transformSelection(context, project, phrase) {
  try {
    return context.selection(phrase);
  } catch (error) {
    if (!(error instanceof PlainformError) || error.code !== 'plainform_unknown_alias') throw error;
    return selectionRecord(project, context.records(phrase));
  }
}

function faceGridOrientation(statement) {
  const rules = [
    {
      pattern: /,?\s+(?:and\s+)?(?:keep|keeping) each copy upright$/iu,
      orientation: { mode: 'upright' },
    },
    {
      pattern: /,?\s+(?:and\s+)?(?:preserve|preserving) the prefab orientation$/iu,
      orientation: { mode: 'preserve' },
    },
    {
      pattern: /,?\s+(?:and\s+)?(?:align|aligning) (?:each copy's|its) local ([xyz]) axis with (?:the )?face normal$/iu,
      orientation: match => ({ mode: 'face', axis: match[1].toLowerCase() }),
    },
  ];
  for (const rule of rules) {
    const match = statement.match(rule.pattern);
    if (!match) continue;
    return {
      statement: statement.slice(0, match.index).trim(),
      orientation: typeof rule.orientation === 'function' ? rule.orientation(match) : rule.orientation,
    };
  }
  return { statement, orientation: { mode: 'face', axis: 'z' } };
}

function relativePatternRotation(faceTransform, desiredRotation) {
  const parent = composeTransformMatrix({ position: [0, 0, 0], rotation: faceTransform.rotation, scale: [1, 1, 1] });
  const desired = composeTransformMatrix({ position: [0, 0, 0], rotation: desiredRotation, scale: [1, 1, 1] });
  return relativeEntityTransform(parent, desired).rotation;
}

function faceAxisRotation(axis) {
  if (axis === 'x') return [0, -Math.PI / 2, 0];
  if (axis === 'y') return [Math.PI / 2, 0, 0];
  return [0, 0, 0];
}

/** Compiles controlled natural English into guarded, canonical Studio operations. */
export class PlainformCompiler {
  parse(source) {
    return parsePlainformProgram(source);
  }

  compile(source, { project }) {
    if (typeof source !== 'string' || source.trim().length === 0) fail('plainform_empty', 'Plainform source is empty.');
    const program = this.parse(source);
    if (program.dialect === 'shader') return new ShaderPlainformCompiler().compile(source, { project });
    if (program.dialect === 'design') return new DesignPlainformCompiler().compile(source, { project });
    if (program.dialect === 'event') return new EventPlainformCompiler().compile(source, { project });
    if (!project) fail('plainform_project_required', 'Plainform compilation requires the canonical project document.');
    const statements = source.split(/\r?\n/u).map(cleanStatement).filter(Boolean);
    if (statements.length > MAX_STATEMENTS) fail('plainform_statement_limit', `Plainform accepts at most ${MAX_STATEMENTS} statements.`);
    const index = new ProjectIndex(project);
    const spatial = new PlainformSpatialResolver({ fail });
    const context = new PlainformReferenceContext({ index, resolveEntity: resolveEntityReference, fail });
    const anchors = new PlainformAnchorResolver({ project, spatial, fail });
    const growth = new PlainformGrowthPlanner({ anchors, fail });
    const prefabs = new PlainformPrefabContext({ project, index, references: context, fail });
    const operations = [];
    const interpretation = [];
    let requestedPreview = false;
    let pendingSelection = null;

    const push = operation => {
      operations.push(operation);
      if (operations.length > MAX_GENERATED_OPERATIONS) {
        fail('plainform_operation_limit', `Plainform generated more than ${MAX_GENERATED_OPERATIONS} operations.`);
      }
    };

    for (let statementIndex = 0; statementIndex < statements.length; statementIndex += 1) {
      const statement = statements[statementIndex];
      try {
        const growthAxis = statement.match(/^use (positive|negative) ([xyz]) as the growth axis for (?:the\s+)?(.+)$/iu);
        if (growthAxis) {
          const records = context.records(growthAxis[3]);
          const axis = cardinalAxis(growthAxis[1], growthAxis[2]);
          growth.setAxis(records, axis);
          interpretation.push(`Will use [${axis.join(', ')}] as the growth axis for ${records.length} entities.`);
          continue;
        }
        const useReference = statement.match(/^use (.+?) as (?:the\s+)?(.+)$/iu);
        if (useReference) {
          const record = context.one(useReference[1], { positionOf: item => spatial.position(item) });
          const name = aliasKey(useReference[2]);
          context.nameReference(name, record);
          interpretation.push(`Will use ${record.entity.id} as “${name}”.`);
          continue;
        }
        if (/^find every\s+/iu.test(statement)) {
          const records = selectionFromFind(index, statement, context, spatial);
          pendingSelection = selectionRecord(project, records);
          interpretation.push(`Selected ${records.length} exact entities.`);
          continue;
        }
        const call = statement.match(/^call them\s+(.+)$/iu);
        if (call) {
          if (!pendingSelection) fail('plainform_missing_selection', '“Call them” must follow a selection.');
          const key = aliasKey(call[1]);
          context.nameSelection(key, pendingSelection);
          interpretation.push(`Named that selection “${key}”.`);
          pendingSelection = null;
          continue;
        }
        const prefab = statement.match(/^(?:convert (.+?) into|name (.+?) as) a?\s*prefab called (\$?[a-z][a-z0-9_-]*)$/iu);
        if (prefab) {
          const record = context.one(prefab[1] ?? prefab[2], { positionOf: item => spatial.position(item) });
          const defined = prefabs.define(record, prefab[3]);
          for (const operation of defined.operations) push(operation);
          interpretation.push(`Converted ${record.entity.id} into ${defined.prefabId} and named it ${defined.name}.`);
          continue;
        }
        const orientedGrid = faceGridOrientation(statement);
        const grid = orientedGrid.statement.match(/^lay out (?:a )?(.+?) by (.+?) grid of (?:copies of )?(.+?) over the (front|back|rear|left|right|top|bottom) face of (.+?),? spaced (.+?) horizontally and (.+?) vertically(?:,? (?:offset|set) (.+?) outward)?$/iu);
        if (grid) {
          const columns = /^\d+$/u.test(grid[1]) ? Number(grid[1]) : wordsNumber(grid[1]);
          const rows = /^\d+$/u.test(grid[2]) ? Number(grid[2]) : wordsNumber(grid[2]);
          if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) || columns < 1 || rows < 1 || columns * rows > 8192) {
            fail('plainform_grid_count', 'A face grid requires positive integer dimensions and at most 8192 cells.');
          }
          const template = grid[3].trim().startsWith('$')
            ? prefabs.resolve(grid[3])
            : context.one(grid[3], { positionOf: item => spatial.position(item) });
          const reference = context.one(grid[5], { positionOf: item => spatial.position(item) });
          const horizontal = evaluatePlainformMath(grid[6]);
          const vertical = evaluatePlainformMath(grid[7]);
          if (horizontal.dimension !== 'length' || vertical.dimension !== 'length' || horizontal.value <= 0 || vertical.value <= 0) {
            fail('plainform_grid_spacing', 'Grid spacing requires two positive lengths.');
          }
          if (reference.entity.transform.quaternion) fail('plainform_grid_rotation', 'Face grids currently require an Euler-authored reference transform.');
          const face = grid[4].toLowerCase() === 'rear' ? 'back' : grid[4].toLowerCase();
          const outward = grid[8] === undefined ? { value: 0, dimension: 'length' } : evaluatePlainformMath(grid[8]);
          if (outward.dimension !== 'length' || outward.value < 0) {
            fail('plainform_grid_offset', 'A face-grid outward offset must be a non-negative length.');
          }
          const transform = cloneTransform(template.entity);
          const originalRotation = [...transform.rotation];
          const faceRotation = {
            front: [0, 0, 0], back: [0, Math.PI, 0], left: [0, -Math.PI / 2, 0], right: [0, Math.PI / 2, 0],
            top: [-Math.PI / 2, 0, 0], bottom: [Math.PI / 2, 0, 0],
          }[face];
          transform.rotation = reference.entity.transform.rotation.map((value, axis) => value + faceRotation[axis]);
          delete transform.quaternion;
          const origin = anchors.gridOriginOnFace(
            reference,
            face,
            columns,
            rows,
            horizontal.value,
            vertical.value,
            outward.value,
            { patternRecord: template, patternTransform: transform },
          );
          transform.position = anchors.placeNamedAnchorAtWorld(template, 'center', origin, transform);
          // Pattern translations are local to the rotated source object. Keep
          // the grid in local XY for every face; the face rotation maps local
          // horizontal/vertical axes into the requested world-space plane.
          const counts = [columns, rows, 1];
          const spacing = [horizontal.value, vertical.value, 0];
          let instanceRotation;
          if (orientedGrid.orientation.mode === 'preserve') {
            instanceRotation = relativePatternRotation(transform, originalRotation);
          } else if (orientedGrid.orientation.mode === 'upright') {
            instanceRotation = relativePatternRotation(transform, [0, 0, 0]);
          } else {
            instanceRotation = faceAxisRotation(orientedGrid.orientation.axis);
          }
          const pattern = {
            id: `modifier/plainform-grid-${slug(template.entity.id)}-${face}`,
            mode: 'grid', counts, spacing,
          };
          if (instanceRotation.some(value => Math.abs(value) > 1e-12)) pattern.instanceRotation = instanceRotation;
          push({ op: 'entity.patch', entityId: template.entity.id, patch: { transform } });
          push({
            op: 'layout.pattern', entityId: template.entity.id,
            pattern,
          });
          const orientationText = orientedGrid.orientation.mode === 'upright'
            ? ', keeping copies upright'
            : orientedGrid.orientation.mode === 'preserve'
              ? ', preserving the prefab orientation'
              : orientedGrid.orientation.axis !== 'z'
                ? `, aligning local ${orientedGrid.orientation.axis} with the face normal`
                : '';
          interpretation.push(`Laid out a centered ${columns} by ${rows} grid of ${template.entity.id} over the ${face} face of ${reference.entity.id}${outward.value > 0 ? `, offset ${outward.value} metres outward` : ''}${orientationText}.`);
          continue;
        }
        const group = statement.match(/^put (?:the\s+)?(.+?) (?:into|inside) a group called (?:(?:"([^"]+)")|(.+?)) with id ([a-z0-9][a-z0-9._/-]*)$/iu);
        if (group) {
          const selection = context.selection(group[1]);
          if (selection.ids.length === 0) fail('plainform_empty_selection', 'Cannot create a group from an empty selection.');
          const sceneIds = new Set(selection.records.map(record => record.scene.id));
          if (sceneIds.size !== 1) fail('plainform_cross_scene_selection', 'A group cannot contain entities from different scenes.');
          const name = group[2] ?? group[3];
          push({
            op: 'entity.group', sceneId: [...sceneIds][0], entityIds: selection.ids,
            expectedEntitySetHash: selection.hash,
            group: { id: group[4], kind: 'group', name },
          });
          interpretation.push(`Will put ${selection.ids.length} entities into group ${group[4]}.`);
          continue;
        }
        const extendWith = statement.match(/^extend (?:the\s+)?(.+?) with (?:the\s+)?(children|descendants) of (.+)$/iu);
        const addTo = statement.match(/^add (?:the\s+)?(children|descendants) of (.+?) to (?:the\s+)?(.+)$/iu);
        if (extendWith || addTo) {
          const targetName = extendWith?.[1] ?? addTo[3];
          const relation = extendWith?.[2] ?? addTo[1];
          const referencePhrase = extendWith?.[3] ?? addTo[2];
          const target = context.selection(targetName);
          const references = context.records(referencePhrase);
          const additions = [...index.entities.values()].filter(record => references.some(reference => (
            record.scene.id === reference.scene.id
            && (relation.toLowerCase() === 'children'
              ? record.entity.parentId === reference.entity.id
              : isDescendant(record.scene, record.entity, reference.entity.id))
          )));
          const records = [...new Map([...target.records, ...additions].map(record => [record.entity.id, record])).values()]
            .sort((left, right) => left.entity.id.localeCompare(right.entity.id));
          context.replaceSelection(targetName, selectionRecord(project, records));
          interpretation.push(`Extended “${aliasKey(targetName)}” with ${records.length - target.records.length} ${relation.toLowerCase()}.`);
          continue;
        }
        const exclude = statement.match(/^exclude (?:the\s+)?(.+?) from (?:the\s+)?(.+)$/iu);
        if (exclude) {
          const removed = context.selection(exclude[1]);
          const target = context.selection(exclude[2]);
          const removedIds = new Set(removed.ids);
          const records = target.records.filter(record => !removedIds.has(record.entity.id));
          context.replaceSelection(exclude[2], selectionRecord(project, records));
          interpretation.push(`Excluded ${target.records.length - records.length} entities from “${aliasKey(exclude[2])}”.`);
          continue;
        }
        const moveEach = statement.match(/^move (?:each|the) (.+?) by (\[.+\])$/iu);
        if (moveEach) {
          const selection = transformSelection(context, project, moveEach[1]);
          const offset = vectorExpression(moveEach[2], new Map(), 'length');
          push({ op: 'entity.transformMany', entityIds: selection.ids, expectedEntitySetHash: selection.hash, mode: 'delta', transform: { position: offset } });
          interpretation.push(`Will move ${selection.ids.length} entities by [${offset.join(', ')}] metres.`);
          continue;
        }
        const rotateEach = statement.match(/^rotate (?:each|the) (.+?) around ([xyz]) by (.+)$/iu);
        if (rotateEach) {
          const selection = transformSelection(context, project, rotateEach[1]);
          const angle = evaluatePlainformMath(rotateEach[3]);
          if (!['angle', 'scalar'].includes(angle.dimension)) fail('plainform_dimension_mismatch', 'Rotation requires an angle.');
          const rotation = [0, 0, 0]; rotation['xyz'.indexOf(rotateEach[2].toLowerCase())] = angle.value;
          push({ op: 'entity.transformMany', entityIds: selection.ids, expectedEntitySetHash: selection.hash, mode: 'delta', transform: { rotation } });
          interpretation.push(`Will rotate ${selection.ids.length} entities by ${angle.value} radians.`);
          continue;
        }
        const scaleEachByAxis = statement.match(/^set the scale of (?:each|the) (.+?) to (\[.+\])$/iu);
        if (scaleEachByAxis) {
          const selection = transformSelection(context, project, scaleEachByAxis[1]);
          const scale = vectorExpression(scaleEachByAxis[2], new Map(), 'scalar');
          if (scale.some(value => value <= 0)) fail('plainform_invalid_scale', 'Every scale axis must be greater than zero.');
          push({ op: 'entity.transformMany', entityIds: selection.ids, expectedEntitySetHash: selection.hash, mode: 'set', transform: { scale } });
          interpretation.push(`Will set ${selection.ids.length} entity scales independently to [${scale.join(', ')}].`);
          continue;
        }
        const scaleEach = statement.match(/^set the scale of (?:each|the) (.+?) to (.+)$/iu);
        if (scaleEach) {
          const selection = transformSelection(context, project, scaleEach[1]);
          const scale = evaluatePlainformMath(scaleEach[2]);
          if (scale.dimension !== 'scalar') fail('plainform_dimension_mismatch', 'Scale must be dimensionless.');
          if (scale.value <= 0) fail('plainform_invalid_scale', 'Scale must be greater than zero.');
          push({ op: 'entity.transformMany', entityIds: selection.ids, expectedEntitySetHash: selection.hash, mode: 'set', transform: { scale: [scale.value, scale.value, scale.value] } });
          interpretation.push(`Will set ${selection.ids.length} entity scales to ${scale.value}.`);
          continue;
        }
        const growChildren = statement.match(/^grow (?:exactly\s+)?(.+?) children from each (.+?) using (.+?) as the template and call them (.+)$/iu);
        if (growChildren) {
          const count = /^\d+$/u.test(growChildren[1]) ? Number(growChildren[1]) : wordsNumber(growChildren[1]);
          if (!Number.isSafeInteger(count) || count < 1 || count > 16) {
            fail('plainform_count_expected', 'Growth requires between 1 and 16 children per parent.');
          }
          const parents = context.selection(growChildren[2]);
          const template = context.one(growChildren[3], { positionOf: item => spatial.position(item) });
          if (!['mesh', 'instancedMesh'].includes(template.entity.kind) || (template.entity.children?.length ?? 0) > 0) {
            fail('plainform_invalid_template', 'Growth currently requires a childless mesh template.');
          }
          const occupied = new Set(index.entities.keys());
          const childAlias = aliasKey(growChildren[4]);
          const idPrefix = `entity/plainform/${slug(childAlias)}`;
          const records = [];
          const items = [];
          for (let parentIndex = 0; parentIndex < parents.records.length; parentIndex += 1) {
            const parent = parents.records[parentIndex];
            for (let childIndex = 0; childIndex < count; childIndex += 1) {
              let suffix = `${String(parentIndex + 1).padStart(3, '0')}-${String(childIndex + 1).padStart(2, '0')}`;
              let id = `${idPrefix}-${suffix}`;
              for (let collision = 1; occupied.has(id); collision += 1) {
                suffix = `${String(parentIndex + 1).padStart(3, '0')}-${String(childIndex + 1).padStart(2, '0')}-${collision}`;
                id = `${idPrefix}-${suffix}`;
              }
              occupied.add(id);
              const name = `${template.entity.name ?? 'Growth'} ${parentIndex + 1}.${childIndex + 1}`;
              items.push({ newId: id, name, parentId: parent.entity.id });
              records.push({
                scene: parent.scene,
                entity: {
                  ...structuredClone(template.entity), id, name, parentId: parent.entity.id, children: [],
                  transform: cloneTransform(template.entity),
                },
              });
            }
          }
          push({ op: 'entity.duplicateMany', entityId: template.entity.id, deep: false, items });
          context.nameSelection(childAlias, { records, ids: records.map(record => record.entity.id), hash: null });
          interpretation.push(`Will grow ${count} children from each of ${parents.ids.length} parents and name ${records.length} entities “${childAlias}”.`);
          continue;
        }
        const reconcile = statement.match(/^make sure there are exactly (.+), using (.+?) as the template and keeping the lowest ids$/iu);
        if (reconcile) {
          const desired = countAndAlias(reconcile[1]);
          const selection = context.selection(desired.alias);
          const template = resolveEntityReference(index, reconcile[2]);
          if (!['mesh', 'instancedMesh'].includes(template.entity.kind) || (template.entity.children?.length ?? 0) > 0) {
            fail('plainform_invalid_template', 'Plainform reconciliation currently requires a childless mesh template.');
          }
          const kept = selection.records.slice(0, desired.count);
          const removed = selection.records.slice(desired.count);
          for (const record of removed) {
            if ((record.entity.children?.length ?? 0) > 0) fail('plainform_duplicate_has_children', `Extra ${record.entity.id} has children and cannot be removed implicitly.`);
            push({ op: 'entity.delete', entityId: record.entity.id, recursive: false, expectedSubtreeHash: index.subtreeHash(record.entity.id) });
          }
          const created = [];
          const occupied = new Set(index.entities.keys());
          const needed = Math.max(0, desired.count - kept.length);
          const idPrefix = `entity/plainform/${slug(desired.alias)}`;
          for (let number = 1; created.length < needed; number += 1) {
            const newId = `${idPrefix}-${String(number).padStart(3, '0')}`;
            if (occupied.has(newId)) continue;
            occupied.add(newId);
            const name = `${template.entity.name ?? 'Copy'} ${String(number).padStart(3, '0')}`;
            created.push({
              scene: template.scene,
              entity: {
                ...structuredClone(template.entity), id: newId, name,
                parentId: template.entity.parentId ?? null, children: [],
              },
            });
          }
          if (created.length > 0) push({
            op: 'entity.duplicateMany', entityId: template.entity.id, deep: false,
            items: created.map(record => ({
              newId: record.entity.id, name: record.entity.name, parentId: record.entity.parentId,
            })),
          });
          const reconciled = [...kept, ...created];
          context.replaceSelection(desired.alias, {
            records: reconciled, ids: reconciled.map(record => record.entity.id),
            hash: created.length === 0 ? hashExactEntitySet(project, reconciled.map(record => record.entity.id), { allowEmpty: true }) : null,
          });
          interpretation.push(`Will reconcile “${aliasKey(desired.alias)}” to exactly ${desired.count}: create ${created.length}, remove ${removed.length}.`);
          continue;
        }
        const dedupe = statement.match(/^remove duplicates from (?:the\s+)?(.+?) when they use the same geometry and material and are within (.+?) of each other,? keeping the (?:object with the )?lowest id$/iu);
        if (dedupe) {
          const selection = context.selection(dedupe[1]);
          const tolerance = evaluatePlainformMath(dedupe[2]);
          if (tolerance.dimension !== 'length') fail('plainform_dimension_mismatch', 'Duplicate distance must be a length.');
          const kept = [];
          const duplicates = [];
          for (const record of selection.records) {
            const mesh = record.entity.components?.mesh;
            const match = kept.find(candidate => {
              const other = candidate.entity.components?.mesh;
              return mesh?.geometryId && mesh.geometryId === other?.geometryId
                && mesh.materialId === other?.materialId
                && distance(record.entity, candidate.entity) <= tolerance.value;
            });
            if (match) duplicates.push(record);
            else kept.push(record);
          }
          for (const record of duplicates) {
            if ((record.entity.children?.length ?? 0) > 0) fail('plainform_duplicate_has_children', `Duplicate ${record.entity.id} has children and cannot be removed implicitly.`);
            push({ op: 'entity.delete', entityId: record.entity.id, recursive: false, expectedSubtreeHash: index.subtreeHash(record.entity.id) });
          }
          context.replaceSelection(dedupe[1], selectionRecord(project, kept));
          interpretation.push(`Will remove ${duplicates.length} duplicates and keep ${kept.length} lowest-ID entities.`);
          continue;
        }
        const loop = statement.match(/^for each (.+?) in (?:the\s+)?(.+)$/iu);
        if (loop) {
          const selection = context.selection(loop[2]);
          const body = [];
          let endIndex = statementIndex + 1;
          while (endIndex < statements.length && !/^end$/iu.test(statements[endIndex])) body.push(statements[endIndex++]);
          if (endIndex >= statements.length) fail('plainform_unclosed_loop', '“For each” requires a matching “End.”');
          statementIndex = endIndex;
          for (let itemIndex = 0; itemIndex < selection.records.length; itemIndex += 1) {
            const record = selection.records[itemIndex];
            const siblings = selection.records.filter(candidate => candidate.entity.parentId === record.entity.parentId);
            const siblingIndex = siblings.findIndex(candidate => candidate.entity.id === record.entity.id);
            const transform = cloneTransform(record.entity);
            const variables = new Map([
              ['index', quantity(itemIndex)], ['number', quantity(itemIndex + 1)], ['count', quantity(selection.records.length)],
              ['sibling index', quantity(siblingIndex)], ['sibling number', quantity(siblingIndex + 1)], ['sibling count', quantity(siblings.length)],
              ['x', quantity(transform.position[0], 'length')], ['y', quantity(transform.position[1], 'length')], ['z', quantity(transform.position[2], 'length')],
            ]);
            const exposeReferenceMath = (name, reference) => {
              const referencePosition = spatial.position(reference);
              const separation = spatial.distance(record, reference);
              for (const label of [name, `the ${name}`]) {
                variables.set(`distance from ${label}`, quantity(separation, 'length'));
                variables.set(`its distance from ${label}`, quantity(separation, 'length'));
                variables.set(`${label} x position`, quantity(referencePosition[0], 'length'));
                variables.set(`${label} y position`, quantity(referencePosition[1], 'length'));
                variables.set(`${label} z position`, quantity(referencePosition[2], 'length'));
              }
            };
            for (const [name, reference] of context.references) exposeReferenceMath(name, reference);
            if (record.entity.parentId) {
              const parent = index.entities.get(record.entity.parentId);
              exposeReferenceMath('parent', parent);
              exposeReferenceMath('its parent', parent);
            }
            let changed = false;
            for (const line of body) {
              const letMatch = line.match(/^let (.+?) be (.+)$/iu);
              if (letMatch) { variables.set(aliasKey(letMatch[1]), evaluatePlainformMath(letMatch[2], variables)); continue; }
              const moveIt = line.match(/^move it by (\[.+\])$/iu);
              if (moveIt) {
                const offset = vectorExpression(moveIt[1], variables, 'length');
                transform.position = transform.position.map((component, axis) => component + offset[axis]);
                variables.set('x', quantity(transform.position[0], 'length'));
                variables.set('y', quantity(transform.position[1], 'length'));
                variables.set('z', quantity(transform.position[2], 'length'));
                changed = true; continue;
              }
              const centerOn = line.match(/^(?:center|centre|align) it (?:on|with) (.+)$/iu);
              if (centerOn) {
                const reference = context.one(centerOn[1], { current: record, positionOf: item => spatial.position(item) });
                transform.position = anchors.alignNamedAnchors(record, 'center', reference, 'center', transform);
                variables.set('x', quantity(transform.position[0], 'length'));
                variables.set('y', quantity(transform.position[1], 'length'));
                variables.set('z', quantity(transform.position[2], 'length'));
                changed = true; continue;
              }
              const centerOnFace = line.match(/^place it cent(?:er|re)ed on the (front|back|rear|left|right|top|bottom) face of (.+)$/iu);
              if (centerOnFace) {
                const face = centerOnFace[1].toLowerCase() === 'rear' ? 'back' : centerOnFace[1].toLowerCase();
                const reference = context.one(centerOnFace[2], { current: record, positionOf: item => spatial.position(item) });
                transform.position = anchors.alignNamedAnchors(record, 'center', reference, face, transform);
                variables.set('x', quantity(transform.position[0], 'length'));
                variables.set('y', quantity(transform.position[1], 'length'));
                variables.set('z', quantity(transform.position[2], 'length'));
                changed = true; continue;
              }
              const centeredOnTop = line.match(/^place it cent(?:er|re)ed on top of (.+)$/iu);
              if (centeredOnTop) {
                const reference = context.one(centeredOnTop[1], { current: record, positionOf: item => spatial.position(item) });
                transform.position = anchors.alignNamedAnchors(record, 'bottom', reference, 'top', transform);
                variables.set('x', quantity(transform.position[0], 'length'));
                variables.set('y', quantity(transform.position[1], 'length'));
                variables.set('z', quantity(transform.position[2], 'length'));
                changed = true; continue;
              }
              const alignAnchors = line.match(/^align its (center|centre|left|right|top|bottom|base|front|back|rear) with the (center|centre|left|right|top|bottom|base|front|back|rear) of (.+)$/iu);
              if (alignAnchors) {
                const reference = context.one(alignAnchors[3], { current: record, positionOf: item => spatial.position(item) });
                transform.position = anchors.alignNamedAnchors(record, alignAnchors[1], reference, alignAnchors[2], transform);
                variables.set('x', quantity(transform.position[0], 'length'));
                variables.set('y', quantity(transform.position[1], 'length'));
                variables.set('z', quantity(transform.position[2], 'length'));
                changed = true; continue;
              }
              const pointGrowth = line.match(/^point its growth axis (toward|towards|away from|away of) (.+)$/iu);
              if (pointGrowth) {
                const relation = /^away/iu.test(pointGrowth[1]) ? 'away' : 'toward';
                const reference = context.one(pointGrowth[2], { current: record, positionOf: item => spatial.position(item) });
                const direction = spatial.relationDirection(record, reference, relation, transform);
                transform.rotation = spatial.rotationAligningAxis(growth.axis(record), direction);
                delete transform.quaternion;
                changed = true; continue;
              }
              const attachSurface = line.match(/^attach its base to the surface of (.+?)(?: with an inset of (.+))?$/iu);
              if (attachSurface) {
                const reference = context.one(attachSurface[1], { current: record, positionOf: item => spatial.position(item) });
                const inset = attachSurface[2] ? evaluatePlainformMath(attachSurface[2], variables) : quantity(0, 'length');
                if (inset.dimension !== 'length' && inset.value !== 0) fail('plainform_dimension_mismatch', 'A surface inset must be a length.');
                transform.position = anchors.attachToSurface(record, growth.axis(record), reference, transform, inset.value);
                variables.set('x', quantity(transform.position[0], 'length'));
                variables.set('y', quantity(transform.position[1], 'length'));
                variables.set('z', quantity(transform.position[2], 'length'));
                changed = true; continue;
              }
              const attachAlong = line.match(/^attach its base to its parent at (.+?) from base to tip$/iu);
              if (attachAlong) {
                if (!record.entity.parentId) fail('plainform_reference_not_found', `${record.entity.id} has no parent.`);
                const parent = index.entities.get(record.entity.parentId);
                if (!parent) fail('plainform_reference_not_found', `Parent ${record.entity.parentId} is not canonical in this growth pass.`);
                const fraction = evaluatePlainformMath(attachAlong[1], variables);
                if (fraction.dimension !== 'scalar' || fraction.value < 0 || fraction.value > 1) {
                  fail('plainform_dimension_mismatch', 'Parent placement must be between 0 and 100 percent.');
                }
                transform.position = anchors.attachAlongParent(record, growth.axis(record), parent, growth.axis(parent), fraction.value, transform);
                variables.set('x', quantity(transform.position[0], 'length'));
                variables.set('y', quantity(transform.position[1], 'length'));
                variables.set('z', quantity(transform.position[2], 'length'));
                changed = true; continue;
              }
              const faceIt = line.match(/^(?:face|point) it (toward|towards|away from|away of) (.+)$/iu);
              if (faceIt) {
                const relation = /^away/iu.test(faceIt[1]) ? 'away' : 'toward';
                const reference = context.one(faceIt[2], { current: record, positionOf: item => spatial.position(item) });
                transform.rotation = spatial.facingRotation(record, reference, relation, transform);
                delete transform.quaternion;
                changed = true; continue;
              }
              const moveRelative = line.match(/^move it (toward|towards|away from|away of) (.+?) by (.+)$/iu);
              if (moveRelative) {
                const relation = /^away/iu.test(moveRelative[1]) ? 'away' : 'toward';
                const reference = context.one(moveRelative[2], { current: record, positionOf: item => spatial.position(item) });
                const amount = evaluatePlainformMath(moveRelative[3], variables);
                if (amount.dimension !== 'length') fail('plainform_dimension_mismatch', 'Relative movement requires a length.');
                const direction = spatial.relationDirection(record, reference, relation, transform);
                transform.position = transform.position.map((component, axis) => component + direction[axis] * amount.value);
                variables.set('x', quantity(transform.position[0], 'length'));
                variables.set('y', quantity(transform.position[1], 'length'));
                variables.set('z', quantity(transform.position[2], 'length'));
                changed = true; continue;
              }
              const moveLocal = line.match(/^move it (forward|backward|left|right|up|down) by (.+?)(?: in its local frame)?$/iu);
              if (moveLocal) {
                const amount = evaluatePlainformMath(moveLocal[2], variables);
                if (amount.dimension !== 'length') fail('plainform_dimension_mismatch', 'Local movement requires a length.');
                const offset = spatial.localOffset(transform, moveLocal[1].toLowerCase(), amount.value);
                transform.position = transform.position.map((component, axis) => component + offset[axis]);
                variables.set('x', quantity(transform.position[0], 'length'));
                variables.set('y', quantity(transform.position[1], 'length'));
                variables.set('z', quantity(transform.position[2], 'length'));
                changed = true; continue;
              }
              const positionIt = line.match(/^set its position to (\[.+\])$/iu);
              if (positionIt) {
                transform.position = vectorExpression(positionIt[1], variables, 'length');
                variables.set('x', quantity(transform.position[0], 'length'));
                variables.set('y', quantity(transform.position[1], 'length'));
                variables.set('z', quantity(transform.position[2], 'length'));
                changed = true; continue;
              }
              const rotateIt = line.match(/^rotate it around ([xyz]) by (.+)$/iu);
              if (rotateIt) {
                const angle = evaluatePlainformMath(rotateIt[2], variables);
                if (!['angle', 'scalar'].includes(angle.dimension)) fail('plainform_dimension_mismatch', 'Rotation requires an angle.');
                transform.rotation['xyz'.indexOf(rotateIt[1].toLowerCase())] += angle.value;
                delete transform.quaternion;
                changed = true; continue;
              }
              const scaleItByAxis = line.match(/^set its scale to (\[.+\])$/iu);
              if (scaleItByAxis) {
                const scale = vectorExpression(scaleItByAxis[1], variables, 'scalar');
                if (scale.some(value => value <= 0)) fail('plainform_invalid_scale', 'Every scale axis must be greater than zero.');
                transform.scale = scale; changed = true; continue;
              }
              const scaleIt = line.match(/^set its scale uniformly to (.+)$/iu);
              if (scaleIt) {
                const scale = evaluatePlainformMath(scaleIt[1], variables);
                if (scale.dimension !== 'scalar') fail('plainform_dimension_mismatch', 'Scale must be dimensionless.');
                if (scale.value <= 0) fail('plainform_invalid_scale', 'Scale must be greater than zero.');
                transform.scale = [scale.value, scale.value, scale.value]; changed = true; continue;
              }
              const inheritShape = line.match(/^make it (.+?) as long and (.+?) as thick as its parent$/iu);
              if (inheritShape) {
                if (!record.entity.parentId) fail('plainform_reference_not_found', `${record.entity.id} has no parent.`);
                const parent = index.entities.get(record.entity.parentId);
                if (!parent) fail('plainform_reference_not_found', `Parent ${record.entity.parentId} is not canonical in this growth pass.`);
                const lengthFactor = evaluatePlainformMath(inheritShape[1], variables);
                const thicknessFactor = evaluatePlainformMath(inheritShape[2], variables);
                if (lengthFactor.dimension !== 'scalar' || thicknessFactor.dimension !== 'scalar'
                  || lengthFactor.value <= 0 || thicknessFactor.value <= 0) {
                  fail('plainform_dimension_mismatch', 'Inherited length and thickness require positive percentages or scalars.');
                }
                transform.scale = growth.inheritedScale(record, parent, lengthFactor.value, thicknessFactor.value);
                changed = true; continue;
              }
              const compareScale = line.match(/^make it (.+?) (smaller|larger) than (.+)$/iu);
              if (compareScale) {
                const amount = evaluatePlainformMath(compareScale[1], variables);
                if (amount.dimension !== 'scalar' || amount.value < 0) fail('plainform_dimension_mismatch', 'Comparative scale requires a non-negative percentage or scalar.');
                const reference = context.one(compareScale[3], { current: record, positionOf: item => spatial.position(item) });
                const factor = compareScale[2].toLowerCase() === 'smaller' ? 1 - amount.value : 1 + amount.value;
                if (factor <= 0) fail('plainform_invalid_scale', 'Comparative scale must remain greater than zero.');
                transform.scale = reference.entity.transform.scale.map(component => component * factor);
                changed = true; continue;
              }
              fail('plainform_unknown_loop_statement', `I could not understand “${line}” inside the loop.`);
            }
            if (changed) push({ op: 'entity.patch', entityId: record.entity.id, patch: { transform } });
          }
          interpretation.push(`Will run ${body.length} instructions for each of ${selection.ids.length} entities.`);
          continue;
        }
        if (/^(?:show me a preview|preview these changes)$/iu.test(statement)) {
          interpretation.push('Requested a dry-run preview.');
          requestedPreview = true;
          continue;
        }
        fail('plainform_unknown_statement', `I could not understand “${statement}”.`);
      } catch (error) {
        if (error instanceof PlainformError) {
          error.details = { ...error.details, statement: statementIndex + 1, source: statement };
        }
        throw error;
      }
    }
    if (pendingSelection) fail('plainform_unnamed_selection', 'The final selection needs a “Call them …” sentence.');
    if (operations.length === 0) fail('plainform_no_operations', 'Plainform understood the text but generated no mutations.');
    return {
      language: 'plainform-v1', operations, interpretation, requestedPreview,
      aliases: Object.fromEntries([...context.aliasEntries()].map(([name, selection]) => [name, selection.ids])),
    };
  }
}
