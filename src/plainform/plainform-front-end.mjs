const TRAILING_PUNCTUATION = /[.:;]+$/u;
const MAX_CATALOG_RESULTS = 256;

export const PLAINFORM_AST_VERSION = 1;

const UNIT_WORDS = new Set([
  'millimetre', 'millimetres', 'millimeter', 'millimeters',
  'centimetre', 'centimetres', 'centimeter', 'centimeters',
  'metre', 'metres', 'meter', 'meters', 'degree', 'degrees',
  'radian', 'radians', 'percent',
  'second', 'seconds', 'millisecond', 'milliseconds',
  'hertz', 'kilohertz', 'decibel', 'decibels', 'beat', 'beats', 'bpm',
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
    pattern: /^(?:show me a preview|preview these changes|preview this sound)$/iu,
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
    id: 'design.header.continue', dialect: 'design', domain: 'design', kind: 'design.continue', priority: 1000,
    pattern: /^continue the design ([a-z0-9][a-z0-9._/-]*)(?: using the (right-up-forward|legacy-xz-y) design frame)?$/iu,
    summary: 'Append generated children to an existing Design Plainform root without creating a sibling root.',
    inputs: ['rootId', 'designFrame'], outputs: ['designRoot'],
    examples: ['Continue the design entity/jeep using the right-up-forward design frame.'],
    semanticKey: match => `design.continue.${semanticPart(match[1])}`,
    fields: match => ({ rootId: match[1], designFrame: match[2] ?? 'stored' }),
  }),
  definition({
    id: 'design.assembly.createGroup', dialect: 'design', domain: 'assembly', kind: 'assembly.createGroup',
    pattern: /^create a group called (.+?) with id ([a-z0-9{}._/-]*)(?:,? cent(?:er|r)ed at (\[.+?\]))?(?:,? rotated by (\[.+?\]))?(?:,? aligned along (?:the )?(right|left|up|down|forward|backward)(?: axis| direction)?)?$/iu,
    summary: 'Create an empty world-centred pivot group under the design root.',
    inputs: ['name', 'id', 'position', 'rotation', 'axis'], outputs: ['group'],
    examples: ['Create a group called Front Hub with id entity/hub-fl, centred at [82 centimetres left, 42 centimetres up, 1.23 metres forward].'],
    semanticKey: match => `assembly.${semanticPart(match[2])}`,
    fields: match => ({ name: match[1], id: match[2], position: match[3], rotation: match[4], axis: match[5] }),
  }),
  definition({
    id: 'design.assembly.parentWorldPose', dialect: 'design', domain: 'assembly', kind: 'assembly.parentWorldPose',
    pattern: /^put (.+?) under (.+?), keeping world pose$/iu,
    summary: 'Parent generated solids or groups under an existing pivot while preserving world pose.',
    inputs: ['children', 'parent'], outputs: ['hierarchy'],
    examples: ['Put Front Left Tire, Front Left Rim, and Front Left Hub under Front Hub, keeping world pose.'],
    semanticKey: match => `assembly.parent.${semanticPart(match[2])}`,
    fields: match => ({ children: match[1], parent: match[2] }),
  }),
  definition({
    id: 'design.primitive.torus', dialect: 'design', domain: 'primitive', kind: 'primitive.createTorus',
    pattern: /^create a torus called (.+?)(?: with id ([a-z0-9{}._/-]+))?,? with ring radius (.+?) and tube radius (.+?)(?:,? cent(?:er|r)ed at (\[.+?\]))?(?:,? rotated by (\[.+?\]))?(?:,? aligned along (?:the )?(right|left|up|down|forward|backward)(?: axis| direction)?)?(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu,
    summary: 'Create a torus with the hole aligned along a semantic axis.',
    inputs: ['name', 'id', 'radius', 'tube', 'position', 'rotation', 'axis', 'materialId'], outputs: ['entity', 'geometry'],
    examples: ['Create a torus called Wheel Rim with id entity/rim, with ring radius 18 centimetres and tube radius 16 millimetres, centred at [0 metres right, 42 centimetres up, 1.23 metres forward], aligned along the right axis.'],
    semanticKey: match => `primitive.${semanticPart(match[2] ?? match[1])}`,
    fields: match => ({ name: match[1], id: match[2], radius: match[3], tube: match[4], position: match[5], rotation: match[6], axis: match[7], materialId: match[8] }),
  }),
  definition({
    id: 'design.primitive.lathe', dialect: 'design', domain: 'primitive', kind: 'primitive.latheProfile',
    pattern: /^lathe (?:the )?profile (.+?) around (?:the )?(right|left|up|down|forward|backward)(?: axis| direction)? as a (?:watertight )?(?:solid )?called (.+?) with id ([a-z0-9][a-z0-9._/-]*)(?:,? cent(?:er|r)ed at (\[.+?\]))?(?:,? rotated by (\[.+?\]))?(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu,
    summary: 'Revolve a named profile around a semantic axis as a lathe solid.',
    inputs: ['profile', 'axis', 'name', 'id', 'position', 'rotation', 'materialId'], outputs: ['entity', 'geometry'],
    examples: ['Lathe profile tire section around the right axis as a solid called Tire with id entity/tire.'],
    semanticKey: match => `primitive.${semanticPart(match[4])}`,
    fields: match => ({ profile: match[1], axis: match[2], name: match[3], id: match[4], position: match[5], rotation: match[6], materialId: match[7] }),
  }),
  definition({
    id: 'object.group.create', dialect: 'object', domain: 'hierarchy', kind: 'object.createGroup',
    pattern: /^put (?:the\s+)?(.+?) (?:into|inside) a group called (?:(?:"([^"]+)")|(.+?)) with id ([a-z0-9][a-z0-9._/-]*)(?:,? cent(?:er|r)ed at (\[.+\]))?$/iu,
    summary: 'Create a world-preserving transform group, optionally at an authored world centre.',
    inputs: ['selection', 'name', 'id', 'position'], outputs: ['group'],
    examples: ['Put the canopy leaves into a group called "Canopy" with id entity/tree/canopy, centred at [0 metres, 2 metres, 0 metres].'],
    semanticKey: match => `group.${semanticPart(match[4])}`,
    fields: match => ({ selection: match[1], name: match[2] ?? match[3], id: match[4], position: match[5] }),
  }),
  definition({
    id: 'object.parent.worldPose', dialect: 'object', domain: 'hierarchy', kind: 'object.parentWorldPose',
    pattern: /^put (.+?) under (.+?), keeping world pose$/iu,
    summary: 'Reparent existing entities under a group while preserving world pose.',
    inputs: ['children', 'parent'], outputs: ['hierarchy'],
    examples: ['Put entity/wheel-fl under entity/hub-fl, keeping world pose.'],
    semanticKey: match => `parent.${semanticPart(match[2])}`,
    fields: match => ({ children: match[1], parent: match[2] }),
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
    id: 'design.groom.pineNeedleField', dialect: 'design', domain: 'groom', kind: 'groom.createNeedleField',
    pattern: /^place clusters of (.+?) pine needles along (?:the )?(?:first-|second-|third-|and|order|branches|\s)+,? denser near healthy tips and absent from deadwood$/iu,
    summary: 'Create one bounded deterministic pine-needle instance field attached to live semantic branch paths.',
    inputs: ['needleLength', 'semanticBranches', 'densityBias', 'exclusions'], outputs: ['groomField', 'instancedMesh'],
    examples: ['Place clusters of 9 centimetre pine needles along second- and third-order branches, denser near healthy tips and absent from deadwood.'],
    semanticKey: () => 'groom.pine-needle-field',
    fields: match => ({ needleLength: match[1], branches: 'second-and-third-order', densityBias: 'healthyTips', excludes: 'deadwood' }),
  }),
  definition({
    id: 'design.groom.regionField', dialect: 'design', domain: 'groom', kind: 'groom.createRegionField',
    pattern: /^groom (.+?) hair over (.+?) using (\d+) guides, (low|medium|high) clumping, and seed (\d+)(?:;?\s*exclude (.+))?$/iu,
    summary: 'Generate bounded guide-only grooming over a named semantic surface region.',
    inputs: ['description', 'region', 'guideCount', 'clumping', 'seed', 'exclusions'], outputs: ['groomField'],
    examples: ['Groom short swept-back hair over Scalp using 24 guides, medium clumping, and seed 91; exclude the forehead and ears.'],
    semanticKey: match => `groom.region.${semanticPart(match[2])}`,
    fields: match => ({ description: match[1], region: match[2], guideCount: Number(match[3]), clumping: match[4], seed: Number(match[5]), exclusions: match[6] }),
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
    id: 'design.surface.subdivideConforming', dialect: 'design', domain: 'surface', kind: 'surface.subdivideConforming', priority: 621,
    pattern: /^subdivide (?:the )?(?:surface )?region (.+?) (once|twice|\d+ times?) with a conforming transition$/iu,
    summary: 'Subdivide a semantic region with deterministic stitched transition triangles.',
    inputs: ['region', 'levels', 'transition'], outputs: ['derivedSurface'],
    examples: ['Subdivide the surface region Cheek twice with a conforming transition.'],
    semanticKey: match => `surface.region.${semanticPart(match[1])}.conforming-refinement`,
    fields: match => ({ region: match[1], levels: match[2], transition: 'conforming' }),
  }),
  definition({
    id: 'design.surface.relaxRegion', dialect: 'design', domain: 'surface', kind: 'surface.relaxRegion', priority: 622,
    pattern: /^relax (?:the )?(?:surface )?region (.+?) for (\d+) (?:passes|iterations)(?: with strength (.+?))?(?: while preserving (?:its )?boundary and volume)?$/iu,
    summary: 'Tangentially relax and reproject a semantic region while preserving its boundary.',
    inputs: ['region', 'passes', 'strength'], outputs: ['derivedSurface'],
    examples: ['Relax the surface region Cheek for 8 passes while preserving its boundary and volume.'],
    semanticKey: match => `surface.region.${semanticPart(match[1])}.relaxation`,
    fields: match => ({ region: match[1], passes: Number(match[2]), strength: match[3] ?? '0.5' }),
  }),
  definition({
    id: 'design.botanical.mountainPine', dialect: 'design', domain: 'growth', kind: 'botanical.mountainPine', priority: 700,
    pattern: /^create a mature (?:mountain )?pine(?: tree)? named (.+?), (.+?) tall and about (\d+) years old$/iu,
    summary: 'Generate a bounded seeded mountain-pine skeleton with stable semantic paths.',
    inputs: ['name', 'height', 'age', 'seed from following botanical description'], outputs: ['structural paths', 'growth report'],
    examples: ['Create a mature mountain pine named Mountain Pine, 18 metres tall and about 70 years old.'],
    semanticKey: match => `botanical.${semanticPart(match[1])}.skeleton`,
    fields: match => ({ name: match[1], height: match[2], age: Number(match[3]), species: 'mountainPine' }),
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
    id: 'shader.edit.header', dialect: 'shader', domain: 'shader', kind: 'shader.editHeader', priority: 1000,
    pattern: /^edit (?:the )?(?:shader|material) graph (.+)$/iu,
    summary: 'Edit one existing canonical graph through a validated candidate.', inputs: ['graph'], outputs: ['graphPatch'],
    examples: ['Edit shader graph Rugged Bark.'],
    semanticKey: match => `shader.edit.${semanticPart(match[1])}`,
    fields: match => ({ graph: match[1] }),
  }),
  definition({
    id: 'shader.edit.insert', dialect: 'shader', domain: 'shader', kind: 'shader.insertNode',
    pattern: /^insert (?:a |an )?(.+?) node with id ([a-z0-9][a-z0-9._/-]*) as (.+)$/iu,
    summary: 'Insert an owned typed shader node with stable ID and semantic role.', inputs: ['type', 'id', 'role'], outputs: ['node'],
    examples: ['Insert a Noise Texture node with id bark-ridges as Ridges.'],
    semanticKey: match => `shader.node.${semanticPart(match[2])}.insert`,
    fields: match => ({ type: match[1], id: match[2], role: match[3] }),
  }),
  definition({
    id: 'shader.edit.connect', dialect: 'shader', domain: 'shader', kind: 'shader.connect',
    pattern: /^connect (.+?) (\S+) to (.+?) (\S+?)(?: only,? not (\S+))?$/iu,
    summary: 'Connect typed sockets by stable node role.', inputs: ['fromRole', 'fromPort', 'toRole', 'toPort', 'excludedPort'], outputs: ['edge'],
    examples: ['Connect Ridges factor to Principled Surface roughness.'],
    semanticKey: match => `shader.edge.${semanticPart(match[1])}.${semanticPart(match[3])}.${semanticPart(match[4])}`,
    fields: match => ({ from: match[1], output: match[2], to: match[3], input: match[4], excludedInput: match[5] }),
  }),
  definition({
    id: 'shader.edit.set', dialect: 'shader', domain: 'shader', kind: 'shader.setNodeInput',
    pattern: /^set (.+?) (\S+) to (.+)$/iu,
    summary: 'Set a typed node input literal and disconnect its prior driver.', inputs: ['role', 'input', 'value'], outputs: ['nodeInput'],
    examples: ['Set Ridges scale to 8.'],
    semanticKey: match => `shader.node.${semanticPart(match[1])}.${semanticPart(match[2])}`,
    fields: match => ({ role: match[1], input: match[2], value: match[3] }),
  }),
  definition({
    id: 'shader.edit.preset', dialect: 'shader', domain: 'shader', kind: 'shader.applyPreset',
    pattern: /^apply preset (.+)$/iu,
    summary: 'Apply a bounded catalogued material preset as owned typed nodes and edges.', inputs: ['preset'], outputs: ['nodes', 'edges', 'exposedParameters'],
    examples: ['Apply preset Rugged Bark.'],
    semanticKey: match => `shader.preset.${semanticPart(match[1])}`,
    fields: match => ({ preset: match[1] }),
  }),
  definition({
    id: 'shader.edit.disconnect', dialect: 'shader', domain: 'shader', kind: 'shader.disconnect',
    pattern: /^disconnect (.+?) from (.+?) (\S+)$/iu,
    summary: 'Disconnect one exact role-to-socket edge.', inputs: ['fromRole', 'toRole', 'toPort'], outputs: ['edgeRemoval'],
    examples: ['Disconnect Ridges from Principled Surface roughness.'],
    semanticKey: match => `shader.edge.${semanticPart(match[1])}.${semanticPart(match[2])}.${semanticPart(match[3])}.disconnect`,
    fields: match => ({ from: match[1], to: match[2], input: match[3] }),
  }),
  definition({
    id: 'shader.edit.expose', dialect: 'shader', domain: 'shader', kind: 'shader.exposeParameter',
    pattern: /^expose (.+?) (\S+) as (.+)$/iu,
    summary: 'Expose a typed node input under a stable semantic parameter name.', inputs: ['role', 'input', 'name'], outputs: ['exposedParameter'],
    examples: ['Expose Ridges scale as Bark Age.'],
    semanticKey: match => `shader.parameter.${semanticPart(match[3])}`, fields: match => ({ role: match[1], input: match[2], name: match[3] }),
  }),
  definition({
    id: 'shader.edit.replace', dialect: 'shader', domain: 'shader', kind: 'shader.replaceNode',
    pattern: /^replace (.+?) with (?:a |an )?(.+?) node with id ([a-z0-9][a-z0-9._/-]*)$/iu,
    summary: 'Replace one Plainform-owned node while preserving its semantic role.', inputs: ['role', 'type', 'id'], outputs: ['node'],
    examples: ['Replace Ridges with a Noise Texture node with id finer-ridges.'],
    semanticKey: match => `shader.node.${semanticPart(match[1])}.replace`, fields: match => ({ role: match[1], type: match[2], id: match[3] }),
  }),
  definition({
    id: 'shader.edit.removeUnused', dialect: 'shader', domain: 'shader', kind: 'shader.removeIfUnused',
    pattern: /^remove (.+?) if unused$/iu,
    summary: 'Remove an unconnected Plainform-owned node and fail if it is used.', inputs: ['role'], outputs: ['nodeRemoval'],
    examples: ['Remove Temporary Detail if unused.'],
    semanticKey: match => `shader.node.${semanticPart(match[1])}.remove`, fields: match => ({ role: match[1] }),
  }),
  definition({
    id: 'event.keyHeld.move', dialect: 'event', domain: 'event', kind: 'event.keyHeldMove', priority: 900,
    pattern: /^for (.+?),\s*when (.+?) is held, move (left|right|up|down) at (\d+(?:\.\d+)?) metres? per second$/iu,
    summary: 'Move an object at an exact velocity while a shared keyboard key is held.', inputs: ['subject', 'key', 'direction', 'speed'], outputs: ['eventRow'],
    examples: ['For Player, when Left is held, move left at 5 metres per second.'],
    semanticKey: match => `event.${semanticPart(match[1])}.key.${semanticPart(match[2])}`, fields: match => ({ subject: match[1], key: match[2], direction: match[3], speedMetresPerSecond: Number(match[4]) }),
  }),
  definition({
    id: 'event.collision.stop', dialect: 'event', domain: 'event', kind: 'event.collisionStop', priority: 900,
    pattern: /^when (.+?) collides with (.+?), stop horizontal movement$/iu,
    summary: 'Condition a collision event on one exact other entity and stop movement.', inputs: ['subject', 'other'], outputs: ['eventRow'],
    examples: ['When Player collides with Pine Trunk, stop horizontal movement.'],
    semanticKey: match => `event.${semanticPart(match[1])}.collision.${semanticPart(match[2])}`, fields: match => ({ subject: match[1], other: match[2] }),
  }),
  definition({
    id: 'event.message.stateAnimation', dialect: 'event', domain: 'event', kind: 'event.messageStateAnimation', priority: 900,
    pattern: /^when (?:the )?(.+?) receives (.+?) with strength at least (\d+(?:\.\d+)?), add (\d+(?:\.\d+)?) to (.+?) and play the (.+?) animation(?:\. if (.+?) reaches (\d+(?:\.\d+)?), send (.+?) once)?$/iu,
    summary: 'Gate a message payload, change numeric state, play animation, and optionally emit a one-shot event.', inputs: ['subject', 'message', 'minimumStrength', 'increment', 'state', 'animation', 'threshold', 'event'], outputs: ['eventRow'],
    examples: ['When the tree receives Chop with strength at least 3, add 1 to Damage and play the bark-hit animation. If Damage reaches 10, send Tree Fell once.'],
    semanticKey: match => `event.${semanticPart(match[1])}.message.${semanticPart(match[2])}`, fields: match => ({ subject: match[1], message: match[2], minimumStrength: Number(match[3]), increment: Number(match[4]), state: match[5], animation: match[6], thresholdState: match[7], threshold: match[8] ? Number(match[8]) : undefined, emitOnce: match[9] }),
  }),
  definition({
    id: 'form.window.inventory', dialect: 'form', domain: 'form', kind: 'form.inventoryWindow', priority: 900,
    pattern: /^create an? (.+?) window with a two-column layout, an item tree on the left, details on the right, and (.+?) and (.+?) buttons along the bottom$/iu,
    summary: 'Create a canonical two-column retained inventory window.', inputs: ['name', 'primaryButton', 'closeButton'], outputs: ['form', 'eventSheet'],
    examples: ['Create an Inventory window with a two-column layout, an item tree on the left, details on the right, and Use and Close buttons along the bottom.'],
    semanticKey: match => `form.${semanticPart(match[1])}`, fields: match => ({ name: match[1], primaryButton: match[2], closeButton: match[3] }),
  }),
  definition({
    id: 'form.dialog.save', dialect: 'form', domain: 'form', kind: 'form.saveDialog', priority: 900,
    pattern: /^create a modal (.+?) dialog with a multiline (.+?) box(?:\. enter adds a line; control\+enter confirms only when a slot is selected)?$/iu,
    summary: 'Create a modal retained save dialog with focus-safe multiline input.', inputs: ['name', 'notesField'], outputs: ['form', 'eventSheet'],
    examples: ['Create a modal Save Game dialog with a multiline notes box. Enter adds a line; Control+Enter confirms only when a slot is selected.'],
    semanticKey: match => `form.${semanticPart(match[1])}`, fields: match => ({ name: match[1], notesField: match[2] }),
  }),
  definition({
    id: 'composition.hero', dialect: 'composition', domain: 'composition', kind: 'composition.heroFrame', priority: 900,
    pattern: /^frame the whole (.+?) from (slightly below|eye level|slightly above) at a (\d+(?:\.\d+)?) millimetre lens\. use late afternoon sun from camera left, soft blue sky fill, a (.+?) ground, and enough depth of field to keep the (.+?) and (.+?) sharp$/iu,
    summary: 'Create a bounded semantic hero composition with camera, outdoor rig, ground, atmosphere, and explicit fallbacks.', inputs: ['subject', 'angle', 'lens', 'ground', 'nearSemantic', 'farSemantic'], outputs: ['presentation', 'camera', 'lightRig'],
    examples: ['Frame the whole pine from slightly below at a 50 millimetre lens. Use late afternoon sun from camera left, soft blue sky fill, a dry grass ground, and enough depth of field to keep the trunk and crown sharp.'],
    semanticKey: match => `composition.${semanticPart(match[1])}.hero`, fields: match => ({ subject: match[1], angle: match[2], lensMillimetres: Number(match[3]), ground: match[4], nearSemantic: match[5], farSemantic: match[6] }),
  }),
  definition({
    id: 'sound.header.design', dialect: 'sound', domain: 'sound', kind: 'sound.header', priority: 1100,
    pattern: /^(?:begin\s+)?design a sound called (?:(?:"([^"]+)")|(.+?)) with id ([a-z0-9][a-z0-9._/-]*)(?: in scene ([a-z0-9][a-z0-9._/-]*))?(?: using the right-up-forward design frame)?$/iu,
    summary: 'Create a sound scene, audio graph, spatial sources, and 3D visualization.',
    inputs: ['name', 'audioId', 'sceneId'], outputs: ['audio', 'graph', 'scene'],
    examples: ['Design a sound called Distant Bell with id audio/distant-bell using the right-up-forward design frame.'],
    semanticKey: match => `sound.${semanticPart(match[3])}`,
    fields: match => ({ name: match[1] ?? match[2], audioId: match[3], sceneId: match[4] ?? null, frame: 'right-up-forward' }),
  }),
  definition({
    id: 'sound.header.continue', dialect: 'sound', domain: 'sound', kind: 'sound.continue', priority: 1100,
    pattern: /^continue the sound ([a-z0-9][a-z0-9._/-]*)$/iu,
    summary: 'Rebuild an existing Sound Plainform resource.',
    inputs: ['audioId'], outputs: ['audio'],
    examples: ['Continue the sound audio/distant-bell.'],
    semanticKey: match => `sound.continue.${semanticPart(match[1])}`,
    fields: match => ({ audioId: match[1] }),
  }),
  definition({
    id: 'sound.header.scene', dialect: 'sound', domain: 'sound', kind: 'sound.createScene', priority: 1100,
    pattern: /^create (?:a |an )?sound scene called (?:(?:"([^"]+)")|(.+?))(?: with id ([a-z0-9][a-z0-9._/-]*))?$/iu,
    summary: 'Create a scene whose purpose is audio play/preview rather than a visual world.',
    inputs: ['name', 'sceneId'], outputs: ['scene'],
    examples: ['Create a sound scene called Distant Bell with id scene/distant-bell.'],
    semanticKey: match => `sound.scene.${semanticPart(match[3] ?? match[1] ?? match[2])}`,
    fields: match => ({ name: match[1] ?? match[2], sceneId: match[3] ?? null }),
  }),
  definition({
    id: 'sound.header.graph', dialect: 'sound', domain: 'sound', kind: 'sound.createGraph', priority: 1100,
    pattern: /^create (?:a |an )?sound graph called (?:(?:"([^"]+)")|(.+?))(?: with id ([a-z0-9][a-z0-9._/-]*))?$/iu,
    summary: 'Create a catalogued audio graph from Sound Plainform.',
    inputs: ['name', 'graphId'], outputs: ['graph'],
    examples: ['Create a sound graph called Distant Bell with id graph/distant-bell.'],
    semanticKey: match => `sound.graph.${semanticPart(match[3] ?? match[1] ?? match[2])}`,
    fields: match => ({ name: match[1] ?? match[2], graphId: match[3] ?? null }),
  }),
  definition({
    id: 'sound.let', dialect: 'sound', domain: 'parameter', kind: 'sound.let',
    pattern: /^let (.+?) be (.+)$/iu,
    summary: 'Define a unit-checked sound parameter (time, frequency, tempo, level, or scalar).',
    inputs: ['name', 'expression'], outputs: ['parameter'],
    examples: ['Let tempo be 72 beats per minute.'],
    semanticKey: match => `sound.let.${semanticPart(match[1])}`,
    fields: match => ({ name: match[1], expression: match[2] }),
  }),
  definition({
    id: 'sound.oscillator', dialect: 'sound', domain: 'source', kind: 'sound.createOscillator',
    pattern: /^create an? (sine|triangle|sawtooth|square|pulse) oscillator called (.+?) at (.+?)(?:, volume ([^,]+))?(?:, starting at (.+))?$/iu,
    summary: 'Create a periodic oscillator voice.',
    inputs: ['waveform', 'name', 'frequency', 'volume'], outputs: ['voice'],
    examples: ['Create a sine oscillator called Bell at 440 hertz, volume 0.22.'],
    semanticKey: match => `sound.oscillator.${semanticPart(match[2])}`,
    fields: match => ({ waveform: match[1], name: match[2], frequency: match[3], volume: match[4] ?? null, startTime: match[5] ?? null }),
  }),
  definition({
    id: 'sound.noise', dialect: 'sound', domain: 'source', kind: 'sound.createNoise',
    pattern: /^create (white|pink|brown) noise called (.+?)(?:, volume ([^,]+))?$/iu,
    summary: 'Create a seeded noise bed.',
    inputs: ['color', 'name', 'volume'], outputs: ['voice'],
    examples: ['Create pink noise called Rain, volume 0.2.'],
    semanticKey: match => `sound.noise.${semanticPart(match[2])}`,
    fields: match => ({ color: match[1], name: match[2], volume: match[3] ?? null }),
  }),
  definition({
    id: 'sound.envelope', dialect: 'sound', domain: 'time', kind: 'sound.shapeEnvelope',
    pattern: /^shape (.+?) with attack ([^,]+), decay ([^,]+), sustain ([^,]+), release ([^,]+)(?:, hold (.+))?$/iu,
    summary: 'Apply an ADSR envelope to a named voice.',
    inputs: ['voice', 'attack', 'decay', 'sustain', 'release'], outputs: ['envelope'],
    examples: ['Shape Bell with attack 8 milliseconds, decay 1.2 seconds, sustain 0, release 0.4 seconds.'],
    semanticKey: match => `sound.envelope.${semanticPart(match[1])}`,
    fields: match => ({ voice: match[1], attack: match[2], decay: match[3], sustain: match[4], release: match[5] }),
  }),
  definition({
    id: 'sound.filter', dialect: 'sound', domain: 'process', kind: 'sound.filter',
    pattern: /^filter (.+?) with an? (low-pass|high-pass|band-pass|lowpass|highpass|bandpass) at (.+?)(?:, resonance (.+))?$/iu,
    summary: 'Filter a named voice.',
    inputs: ['voice', 'type', 'frequency', 'resonance'], outputs: ['filter'],
    examples: ['Filter Rain with a low-pass at 800 hertz, resonance 0.4.'],
    semanticKey: match => `sound.filter.${semanticPart(match[1])}`,
    fields: match => ({ voice: match[1], type: match[2], frequency: match[3], resonance: match[4] ?? null }),
  }),
  definition({
    id: 'sound.formant', dialect: 'sound', domain: 'process', kind: 'sound.formant',
    pattern: /^(?:give|formant) (.+?) (?:a vocal tract as|formants as|as) (ah|eh|ee|oo|ih|uh|oh|ae)$/iu,
    summary: 'Apply a three-formant vocal tract to a named voice.',
    inputs: ['voice', 'vowel'], outputs: ['formant'],
    examples: ['Give Voice a vocal tract as ah.'],
    semanticKey: match => `sound.formant.${semanticPart(match[1])}`,
    fields: match => ({ voice: match[1], vowel: match[2] }),
  }),
  definition({
    id: 'sound.sequence', dialect: 'sound', domain: 'music', kind: 'sound.sequence',
    pattern: /^sequence (.+?) as (.+?), one note per (beat|second)s?$/iu,
    summary: 'Play a bounded note sequence on an oscillator.',
    inputs: ['voice', 'pattern', 'unit'], outputs: ['sequence'],
    examples: ['Sequence Bell as C4, E4, G4, C5, one note per beat.'],
    semanticKey: match => `sound.sequence.${semanticPart(match[1])}`,
    fields: match => ({ voice: match[1], pattern: match[2], unit: match[3] }),
  }),
  definition({
    id: 'sound.place', dialect: 'sound', domain: 'space', kind: 'sound.place',
    pattern: /^place (.+?) ((?:-?\d|\bat\b).+)$/iu,
    summary: 'Place a voice relative to the listener in the right-up-forward frame.',
    inputs: ['voice', 'offset'], outputs: ['position'],
    examples: ['Place Bell 1.5 metres right of the listener and 80 centimetres up.'],
    semanticKey: match => `sound.place.${semanticPart(match[1])}`,
    fields: match => ({ voice: match[1], offset: match[2] }),
  }),
  definition({
    id: 'sound.mirror', dialect: 'sound', domain: 'space', kind: 'sound.mirror',
    pattern: /^mirror (.+?) across the listener as (.+)$/iu,
    summary: 'Mirror a voice across the listener for stereo placement.',
    inputs: ['source', 'name'], outputs: ['voice'],
    examples: ['Mirror Rain across the listener as Left Rain.'],
    semanticKey: match => `sound.mirror.${semanticPart(match[2])}`,
    fields: match => ({ source: match[1], name: match[2] }),
  }),
  definition({
    id: 'sound.feel', dialect: 'sound', domain: 'feel', kind: 'sound.feel',
    pattern: /^(?:make it feel|describe it as|the sound should feel) (.+)$/iu,
    summary: 'Apply bounded sound-feel vocabulary to filters, harmonics, and visualization shaders.',
    inputs: ['descriptors'], outputs: ['feel'],
    examples: ['Make it feel warm and muffled.'],
    semanticKey: () => 'sound.feel',
    fields: match => ({ descriptors: match[1] }),
  }),
  definition({
    id: 'sound.constraint.peak', dialect: 'sound', domain: 'constraint', kind: 'sound.keepPeak',
    pattern: /^keep peak level below (.+)$/iu,
    summary: 'Fail the compile if the evaluated peak exceeds a decibel limit.',
    inputs: ['level'], outputs: ['constraint'],
    examples: ['Keep peak level below 0 decibels.'],
    semanticKey: () => 'sound.constraint.peak',
    fields: match => ({ level: match[1] }),
  }),
  definition({
    id: 'sound.composition.frame', dialect: 'sound', domain: 'composition', kind: 'sound.frame',
    pattern: /^frame the (?:sound |whole )?visualization from (slightly below|eye level|slightly above) at a (\d+(?:\.\d+)?) millimetre lens$/iu,
    summary: 'Frame the 3D sound visualization with a composition-style camera.',
    inputs: ['angle', 'lens'], outputs: ['camera'],
    examples: ['Frame the sound visualization from slightly above at a 50 millimetre lens.'],
    semanticKey: () => 'sound.frame',
    fields: match => ({ angle: match[1], lensMillimetres: Number(match[2]) }),
  }),
  definition({
    id: 'sound.event.play', dialect: 'sound', domain: 'event', kind: 'sound.playOnStart',
    pattern: /^(?:when play starts, play .+|play (?:this sound|it) when play starts)$/iu,
    summary: 'Author an event sheet that plays the sound when Play starts.',
    outputs: ['eventSheet'],
    examples: ['When Play starts, play Distant Bell.'],
    semanticKey: () => 'sound.playOnStart',
  }),
  definition({
    id: 'sound.loop', dialect: 'sound', domain: 'time', kind: 'sound.loop',
    pattern: /^loop (?:this sound|it)$/iu,
    summary: 'Loop the compiled sound during Play.',
    outputs: ['loop'],
    examples: ['Loop this sound.'],
    semanticKey: () => 'sound.loop',
  }),
  definition({
    id: 'sound.harmonic', dialect: 'sound', domain: 'source', kind: 'sound.addHarmonic',
    pattern: /^add an? (?:quiet )?harmonic(?: to (.+?))? at (.+?) times (.+?) frequency(?:, volume (.+))?$/iu,
    summary: 'Add a harmonic partial to an oscillator.',
    inputs: ['voice', 'ratio', 'volume'], outputs: ['voice'],
    examples: ['Add a quiet harmonic at 3 times Bell frequency, volume 0.18.'],
    semanticKey: match => `sound.harmonic.${semanticPart(match[1] ?? match[3])}`,
    fields: match => ({ voice: match[1] ?? match[3], ratio: match[2], volume: match[4] ?? null }),
  }),
  definition({
    id: 'sound.loop.for', dialect: 'sound', domain: 'control', kind: 'sound.forEvery',
    pattern: /^for every (?:partial|note|voice|harmonic|item)?\s*([a-z][a-z0-9_]*) from (.+?) through (.+)$/iu,
    summary: 'Bounded integer loop that expands later sound statements.',
    inputs: ['name', 'start', 'end'], outputs: ['iteration'],
    examples: ['For every i from 1 through 4:'],
    semanticKey: match => `sound.loop.${semanticPart(match[1])}`,
    fields: match => ({ name: match[1], start: match[2], end: match[3] }),
  }),
  definition({
    id: 'sound.group', dialect: 'sound', domain: 'assembly', kind: 'sound.group',
    pattern: /^put (.+?) into a group called (?:(?:"([^"]+)")|(.+?))(?: with id ([a-z0-9][a-z0-9._/-]*))?(?:, centred at (\[.+\]))?$/iu,
    summary: 'Group named voices under a transform pivot.',
    inputs: ['members', 'name', 'id'], outputs: ['group'],
    examples: ['Put Bell and Rain into a group called Voices with id entity/distant-bell/voices.'],
    semanticKey: match => `sound.group.${semanticPart(match[4] ?? match[2] ?? match[3])}`,
    fields: match => ({ members: match[1], name: match[2] ?? match[3], id: match[4] ?? null }),
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
  if (/^\s*(?:(?:begin\s+)?design a sound\b|create (?:a |an )?sound (?:scene|graph)\b|continue the sound\b)/iu.test(source)) return 'sound';
  if (/^\s*(?:create (?:a |an )?(?:shader|material) graph|edit (?:the )?(?:shader|material) graph|in .+?,)/imu.test(source)) return 'shader';
  if (/^\s*(?:(?:begin\s+)?design\b|continue the design\b)/iu.test(source)) return 'design';
  if (/^\s*(?:for .+?,\s*when |when (?:the )?.+? (?:collides|receives|is destroyed))/imu.test(source)) return 'event';
  if (/^\s*create (?:an? .+? window|a modal .+? dialog)\b/imu.test(source)) return 'form';
  if (/^\s*frame the whole .+? from /imu.test(source)) return 'composition';
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
