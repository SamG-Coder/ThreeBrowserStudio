const TRAILING_PUNCTUATION = /[.:;]+$/u;
const MAX_CATALOG_RESULTS = 256;

export const PLAINFORM_AST_VERSION = 1;

const UNIT_WORDS = new Set([
  'millimetre', 'millimetres', 'millimeter', 'millimeters',
  'centimetre', 'centimetres', 'centimeter', 'centimeters',
  'metre', 'metres', 'meter', 'meters', 'degree', 'degrees',
  'radian', 'radians', 'percent',
]);

const CLAUSE_WORDS = new Set([
  'and', 'as', 'at', 'by', 'called', 'for', 'from', 'in', 'into', 'of',
  'on', 'over', 'through', 'to', 'using', 'when', 'where', 'with',
]);

const TOKEN_PATTERN = /"(?:[^"\\]|\\.)*"|\$[a-z0-9][a-z0-9._/-]*|[a-z][a-z0-9._-]*\/[a-z0-9._/-]+|-?\d+(?:\.\d+)?|[a-z][a-z0-9_-]*|[\[\](),]|[^\s]/giu;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function cleanStatement(value) {
  return value.trim().replace(TRAILING_PUNCTUATION, '').trim();
}

function semanticPart(value) {
  return cleanStatement(String(value ?? ''))
    .toLowerCase()
    .replace(/^(?:the|a|an)\s+/u, '')
    .replace(/^"|"$/gu, '')
    .replace(/[^a-z0-9._/-]+/gu, '.')
    .replace(/^\.+|\.+$/gu, '') || 'unnamed';
}

function tokenKind(value) {
  if (value.startsWith('"')) return 'quotedName';
  if (value.startsWith('$')) return 'reference';
  if (/^[a-z][a-z0-9._-]*\/[a-z0-9._/-]+$/iu.test(value)) return 'id';
  if (/^-?\d+(?:\.\d+)?$/u.test(value)) return 'number';
  if (/^[\[\](),]$/u.test(value)) return 'punctuation';
  const lower = value.toLowerCase();
  if (UNIT_WORDS.has(lower)) return 'unit';
  if (CLAUSE_WORDS.has(lower)) return 'clause';
  if (/^[a-z][a-z0-9_-]*$/iu.test(value)) return 'word';
  return 'symbol';
}

function tokenizeStatement(text, sourceStart) {
  const tokens = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const start = sourceStart + match.index;
    tokens.push(deepFreeze({
      kind: tokenKind(match[0]),
      value: match[0],
      normalized: match[0].toLowerCase(),
      span: { start, end: start + match[0].length },
    }));
  }
  return Object.freeze(tokens);
}

function statementFromLine(raw, lineStart, lineNumber, statementIndex) {
  const trimmedStart = raw.search(/\S/u);
  if (trimmedStart < 0) return null;
  let rawEnd = raw.length;
  while (rawEnd > trimmedStart && /\s/u.test(raw[rawEnd - 1])) rawEnd -= 1;
  const trimmed = raw.slice(trimmedStart, rawEnd);
  const text = cleanStatement(trimmed);
  if (!text) return null;
  const textStart = lineStart + trimmedStart;
  const textEnd = textStart + text.length;
  return deepFreeze({
    index: statementIndex,
    line: lineNumber,
    raw: trimmed,
    text,
    span: { start: textStart, end: textEnd },
    rawSpan: { start: textStart, end: lineStart + rawEnd },
    column: { start: trimmedStart + 1, end: trimmedStart + text.length + 1 },
    terminator: trimmed.slice(text.length).trim(),
    tokens: tokenizeStatement(text, textStart),
  });
}

/** Splits line-oriented Plainform while retaining exact UTF-16 source offsets. */
export function tokenizePlainformSource(source) {
  if (typeof source !== 'string') throw new TypeError('Plainform source must be a string.');
  const statements = [];
  let cursor = 0;
  let lineNumber = 1;
  while (cursor <= source.length) {
    const newline = source.indexOf('\n', cursor);
    const physicalEnd = newline < 0 ? source.length : newline;
    const contentEnd = physicalEnd > cursor && source[physicalEnd - 1] === '\r' ? physicalEnd - 1 : physicalEnd;
    const statement = statementFromLine(
      source.slice(cursor, contentEnd), cursor, lineNumber, statements.length,
    );
    if (statement) statements.push(statement);
    if (newline < 0) break;
    cursor = newline + 1;
    lineNumber += 1;
  }
  return deepFreeze({
    kind: 'plainform.source',
    length: source.length,
    lineCount: lineNumber,
    statements,
  });
}

function definition(value) {
  return deepFreeze({ priority: 100, inputs: [], outputs: [], examples: [], ...value });
}

const DEFINITIONS = Object.freeze([
  definition({
    id: 'common.request.preview', dialect: 'common', domain: 'control', kind: 'request.preview',
    pattern: /^(?:show me a preview|preview these changes)$/iu,
    summary: 'Request dry-run preview of the compiled candidate.', outputs: ['requestedPreview'],
    examples: ['Preview these changes.'], semanticKey: () => 'request.preview',
  }),
  definition({
    id: 'object.growth.setAxis', dialect: 'object', domain: 'growth', kind: 'growth.setAxis',
    pattern: /^use (positive|negative) ([xyz]) as the growth axis for (?:the\s+)?(.+)$/iu,
    summary: 'Set the cardinal growth axis for an exact entity reference.',
    inputs: ['direction', 'axis', 'entityReference'], outputs: ['growthAxis'],
    examples: ['Use positive Y as the growth axis for the trunk.'],
    semanticKey: match => `growth.axis.${semanticPart(match[3])}`,
    fields: match => ({ direction: match[1].toLowerCase(), axis: match[2].toLowerCase(), target: match[3] }),
  }),
  definition({
    id: 'design.header', dialect: 'design', domain: 'design', kind: 'design.header', priority: 1000,
    pattern: /^(?:begin\s+)?design (?:a |an )?(.+?) called (?:(?:"([^"]+)")|(.+?)) with id ([a-z0-9][a-z0-9._/-]*)(?: using the (right-up-forward|legacy-xz-y) design frame)?$/iu,
    summary: 'Declare a Design Plainform root and coordinate frame.',
    inputs: ['designKind', 'name', 'rootId', 'designFrame'], outputs: ['designRoot'],
    examples: ['Design a tree called Mountain Pine with id entity/pine using the right-up-forward design frame.'],
    semanticKey: match => `design.${semanticPart(match[4])}`,
    fields: match => ({ kind: match[1], name: match[2] ?? match[3], rootId: match[4], designFrame: match[5] ?? 'legacy-xz-y' }),
  }),
  definition({
    id: 'design.profile.rectangular', dialect: 'design', domain: 'profile', kind: 'profile.createRectangular',
    pattern: /^create a rectangular profile called (.+?) with width (.+?) and (?:depth|height) (.+?)(?:,? rounded by (.+))?$/iu,
    summary: 'Create a named rectangular profile.',
    inputs: ['name', 'width', 'depth', 'cornerRadius'], outputs: ['profile'],
    examples: ['Create a rectangular profile called Trunk Base with width 1 metre and depth 80 centimetres.'],
    semanticKey: match => `profile.${semanticPart(match[1])}`,
    fields: match => ({ name: match[1], width: match[2], depth: match[3], ...(match[4] ? { cornerRadius: match[4] } : {}) }),
  }),
  definition({
    id: 'design.guide.create', dialect: 'design', domain: 'guide', kind: 'guide.create',
    pattern: /^create a (?:(smooth)\s+)?guide curve called (.+?) through (.+?)(?:,? following point (\d+) of (?:the )?profile (.+))?$/iu,
    summary: 'Create a named guide curve through bounded points.',
    inputs: ['name', 'points', 'smooth', 'profilePoint'], outputs: ['guide'],
    examples: ['Create a smooth guide curve called Trunk Path through [0, 0, 0], [0, 4, 0].'],
    semanticKey: match => `guide.${semanticPart(match[2])}`,
    fields: match => ({ smooth: Boolean(match[1]), name: match[2], points: match[3], ...(match[4] ? { profilePoint: Number(match[4]), profile: match[5] } : {}) }),
  }),
  definition({
    id: 'design.primitive.box', dialect: 'design', domain: 'primitive', kind: 'primitive.createBox',
    pattern: /^create a box called (.+?)(?: with id ([a-z0-9{}._/-]+))?,? with width (.+?)(?=,\s*height),\s*height (.+?)(?=,\s*(?:and )?depth),\s*(?:and )?depth (.+?)(?=,\s*cent(?:er|r)ed|,\s*rotated|,\s*using material|$)(?:,? cent(?:er|r)ed at (\[.+?\]))?(?:,? rotated by (\[.+?\]))?(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu,
    summary: 'Create a bounded box design primitive.',
    inputs: ['name', 'id', 'width', 'height', 'depth', 'position', 'rotation', 'materialId'], outputs: ['entity', 'geometry'],
    examples: ['Create a box called Body with id entity/body, with width 1 metre, height 2 metres, and depth 1 metre.'],
    semanticKey: match => `primitive.${semanticPart(match[2] ?? match[1])}`,
    fields: match => ({ name: match[1], id: match[2], width: match[3], height: match[4], depth: match[5], position: match[6], rotation: match[7], materialId: match[8] }),
  }),
  definition({
    id: 'design.eye.coordinatedPair', dialect: 'design', domain: 'assembly', kind: 'assembly.createEyePair',
    pattern: /^create a coordinated eye pair called (.+?) with id ([a-z0-9][a-z0-9._/-]*),? cent(?:er|r)ed at (\[.+?\]), separated by (.+?), with eye width (.+?), eye height (.+?), (?:and )?eye depth (.+?), looking at (\[.+?\])(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu,
    summary: 'Create a coordinated eye pair with one gaze target.',
    inputs: ['name', 'id', 'center', 'separation', 'eyeSize', 'gazeTarget', 'materialId'], outputs: ['eyeAssembly'],
    examples: ['Create a coordinated eye pair called Eyes with id entity/eyes, centered at [0, 1, 0], separated by 6 centimetres, with eye width 3 centimetres, eye height 2 centimetres, and eye depth 2 centimetres, looking at [0, 1, 4].'],
    semanticKey: match => `assembly.${semanticPart(match[2])}`,
    fields: match => ({ name: match[1], id: match[2], center: match[3], separation: match[4], width: match[5], height: match[6], depth: match[7], gazeTarget: match[8], materialId: match[9] }),
  }),
  definition({
    id: 'design.groom.hairCard', dialect: 'design', domain: 'groom', kind: 'groom.createHairCard',
    pattern: /^groom a hair card called (.+?) with id ([a-z0-9][a-z0-9._/-]*) along (?:guide )?(.+?), with width (.+?), tapering to (.+?)(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu,
    summary: 'Create one bounded hair card along a named guide.',
    inputs: ['name', 'id', 'guide', 'width', 'tipWidth', 'materialId'], outputs: ['groomCard'],
    examples: ['Groom a hair card called Fringe with id entity/fringe along guide Hair Path, with width 2 centimetres, tapering to 2 millimetres.'],
    semanticKey: match => `groom.${semanticPart(match[2])}`,
    fields: match => ({ name: match[1], id: match[2], guide: match[3], width: match[4], tipWidth: match[5], materialId: match[6] }),
  }),
  definition({
    id: 'design.loft.create', dialect: 'design', domain: 'loft', kind: 'loft.create',
    pattern: /^loft a (?:watertight )?(?:solid )?called (.+?) with id ([a-z0-9][a-z0-9._/-]*) through all sections of (.+?)(?:,? with (\d+) cap rings)?(?:,? following (.+?))?(?:,? with (positional|tangent|curvature) continuity)?(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu,
    summary: 'Loft a named solid through all sections of a profile.',
    inputs: ['name', 'id', 'profile', 'capRings', 'guides', 'continuity', 'materialId'], outputs: ['entity', 'geometry'],
    examples: ['Loft a watertight solid called Trunk with id entity/trunk through all sections of Trunk Profile, with 4 cap rings.'],
    semanticKey: match => `loft.${semanticPart(match[2])}`,
    fields: match => ({ name: match[1], id: match[2], profile: match[3], capRings: match[4] ? Number(match[4]) : undefined, guides: match[5], continuity: match[6], materialId: match[7] }),
  }),
  definition({
    id: 'design.surface.subdivideRegion', dialect: 'design', domain: 'surface', kind: 'surface.subdivideRegion',
    pattern: /^subdivide (?:the )?surface region (.+?) locally by (\d+) levels?(?:,? then relax it for (\d+) iterations? with strength (.+))?$/iu,
    summary: 'Locally subdivide and optionally relax a semantic surface region.',
    inputs: ['region', 'levels', 'relaxIterations', 'relaxStrength'], outputs: ['derivedSurface'],
    examples: ['Subdivide the surface region Cheek locally by 2 levels, then relax it for 8 iterations with strength 0.4.'],
    semanticKey: match => `surface.region.${semanticPart(match[1])}.refinement`,
    fields: match => ({ region: match[1], levels: Number(match[2]), ...(match[3] ? { relaxIterations: Number(match[3]), relaxStrength: match[4] } : {}) }),
  }),
  definition({
    id: 'shader.header', dialect: 'shader', domain: 'shader', kind: 'shader.header', priority: 1000,
    pattern: /^create (?:a |an )?(?:shader|material) graph called (?:(?:"([^"]+)")|(.+?))(?: with id ([a-z0-9][a-z0-9._/-]*))?$/iu,
    summary: 'Declare a typed shader graph.', inputs: ['name', 'graphId'], outputs: ['graph'],
    examples: ['Create a shader graph called Rugged Bark with id graph/rugged-bark.'],
    semanticKey: match => `shader.${semanticPart(match[3] ?? match[1] ?? match[2])}`,
    fields: match => ({ name: match[1] ?? match[2], graphId: match[3] }),
  }),
  definition({
    id: 'shader.property.set', dialect: 'shader', domain: 'shader', kind: 'shader.setProperty',
    pattern: /^(?:set|drive) (?:the )?(.+?) (?:to|with) (.+)$/iu,
    summary: 'Drive one supported shader property with a typed value or expression.',
    inputs: ['property', 'expression'], outputs: ['graphInput'],
    examples: ['Set roughness to 0.8.'],
    semanticKey: match => `shader.property.${semanticPart(match[1])}`,
    fields: match => ({ property: match[1], expression: match[2] }),
  }),
]);

function inferDialect(source) {
  if (/^\s*create (?:a |an )?(?:shader|material) graph\b/imu.test(source)) return 'shader';
  if (/^\s*(?:begin\s+)?design\b/iu.test(source)) return 'design';
  return 'object';
}

function astNode(statement, dialect, candidates) {
  const ordered = [...candidates].sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  const selected = ordered[0];
  if (!selected) {
    return deepFreeze({
      kind: 'legacy.statement',
      semanticKey: `legacy.${dialect}.${statement.index + 1}`,
      dialect, domain: 'legacy', statementIndex: statement.index,
      source: statement.text, span: statement.span, tokens: statement.tokens,
      legacy: true,
    });
  }
  const match = statement.text.match(selected.pattern);
  const ambiguous = ordered.filter(item => item.priority === selected.priority).length > 1;
  return deepFreeze({
    kind: selected.kind,
    semanticKey: selected.semanticKey(match, statement),
    dialect: selected.dialect === 'common' ? dialect : selected.dialect,
    domain: selected.domain,
    statementIndex: statement.index,
    source: statement.text,
    span: statement.span,
    tokens: statement.tokens,
    fields: selected.fields ? selected.fields(match, statement) : {},
    legacy: false,
    ...(ambiguous ? { ambiguous: true, candidateKinds: ordered.map(item => item.kind) } : {}),
  });
}

export class PlainformStatementRegistry {
  constructor(definitions = DEFINITIONS) {
    const ids = new Set();
    for (const item of definitions) {
      if (!item?.id || ids.has(item.id)) throw new TypeError(`Plainform statement ID must be unique: ${item?.id ?? '<missing>'}.`);
      if (!(item.pattern instanceof RegExp) || item.pattern.global) throw new TypeError(`Plainform statement ${item.id} requires a non-global RegExp.`);
      ids.add(item.id);
    }
    this.definitions = Object.freeze([...definitions]);
    Object.freeze(this);
  }

  parse(source, options = {}) {
    const tokenized = tokenizePlainformSource(source);
    const dialect = options.dialect ?? inferDialect(source);
    const statements = tokenized.statements.map(statement => {
      const candidates = this.definitions.filter(item => (
        (item.dialect === dialect || item.dialect === 'common') && item.pattern.test(statement.text)
      ));
      return astNode(statement, dialect, candidates);
    });
    return deepFreeze({
      kind: 'plainform.program',
      version: PLAINFORM_AST_VERSION,
      language: 'plainform-v1',
      dialect,
      sourceLength: source.length,
      span: { start: 0, end: source.length },
      statements,
      metrics: {
        statementCount: statements.length,
        typedStatementCount: statements.filter(item => !item.legacy).length,
        legacyStatementCount: statements.filter(item => item.legacy).length,
        ambiguousStatementCount: statements.filter(item => item.ambiguous).length,
      },
    });
  }

  catalog(options = {}) {
    const dialect = options.dialect;
    const domain = options.domain;
    const query = String(options.query ?? '').trim().toLowerCase();
    const limit = options.limit ?? MAX_CATALOG_RESULTS;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CATALOG_RESULTS) {
      throw new RangeError(`Plainform grammar catalog limit must be between 1 and ${MAX_CATALOG_RESULTS}.`);
    }
    const entries = this.definitions
      .filter(item => !dialect || item.dialect === dialect || item.dialect === 'common')
      .filter(item => !domain || item.domain === domain)
      .map(item => deepFreeze({
        id: item.id, dialect: item.dialect, domain: item.domain, kind: item.kind,
        priority: item.priority, summary: item.summary,
        grammar: { source: item.pattern.source, flags: item.pattern.flags },
        inputs: item.inputs, outputs: item.outputs, examples: item.examples,
      }))
      .filter(item => !query || JSON.stringify(item).toLowerCase().includes(query))
      .sort((left, right) => left.id.localeCompare(right.id));
    return deepFreeze({
      version: PLAINFORM_AST_VERSION,
      total: entries.length,
      limit,
      entries: entries.slice(0, limit),
    });
  }
}

export const PLAINFORM_STATEMENT_REGISTRY = new PlainformStatementRegistry();

export function parsePlainformProgram(source, options) {
  return PLAINFORM_STATEMENT_REGISTRY.parse(source, options);
}

export function getPlainformGrammarCatalog(options) {
  return PLAINFORM_STATEMENT_REGISTRY.catalog(options);
}
