import { GRAPH_CATALOGS } from '../graphs/catalogs.mjs';
import { validateGraph } from '../graphs/index.mjs';
import { interpretShaderFeel } from './shader-feel-vocabulary.mjs';

const MAX_NODES = 128;

export class ShaderPlainformError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ShaderPlainformError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new ShaderPlainformError(code, message, details);
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'shader';
}

function clean(value) {
  return value.trim().replace(/[.;]+$/u, '').trim();
}

function splitStatements(source) {
  return source.split(/\r?\n/u).map(clean).filter(Boolean);
}

function parseColor(value) {
  const match = value.match(/^#([0-9a-f]{6})$/iu);
  if (!match) return null;
  const number = Number.parseInt(match[1], 16);
  return [((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255, 1];
}

class GraphBuilder {
  constructor(catalog, graphId, name) {
    this.catalog = catalog;
    this.graph = { formatVersion: 1, id: graphId, domain: 'shader', nodes: [], edges: [], outputs: {} };
    this.name = name;
    this.sequence = 0;
    this.bindings = new Map();
  }

  definition(type) {
    const definition = this.catalog.nodes[type];
    if (!definition) fail('plainform_shader_node_unavailable', `The active shader catalog does not provide ${type}.`, { type });
    return definition;
  }

  node(type, params = {}, inputs = {}, hint = type) {
    this.definition(type);
    if (this.graph.nodes.length >= MAX_NODES) fail('plainform_shader_node_limit', `Shader Plainform is limited to ${MAX_NODES} nodes.`);
    const id = `${slug(hint).slice(0, 40)}-${String(++this.sequence).padStart(3, '0')}`;
    const node = { id, type, params, ...(Object.keys(inputs).length ? { inputs } : {}) };
    this.graph.nodes.push(node);
    return { nodeId: id, port: Object.keys(this.definition(type).outputs)[0], type: Object.values(this.definition(type).outputs)[0].type };
  }

  connect(from, nodeId, port) {
    const node = this.graph.nodes.find(candidate => candidate.id === nodeId);
    const definition = this.definition(node.type);
    if (!definition.inputs[port]) fail('plainform_shader_socket_unavailable', `${node.type} has no catalogued ${port} input.`);
    this.graph.edges.push({ from: { nodeId: from.nodeId, port: from.port }, to: { nodeId, port } });
  }

  constant(value, hint = 'constant') {
    return this.node('constant.float', { value }, {}, hint);
  }

  math(operation, values, hint = operation.toLowerCase()) {
    const result = this.node('blender.math', { operation, clamp: false }, {}, hint);
    const ports = ['value', 'valueB', 'valueC'];
    values.forEach((value, index) => this.connect(value, result.nodeId, ports[index]));
    return result;
  }

  output(socket, value) {
    const surface = this.graph.nodes.find(node => node.id === 'principled-surface');
    if (!surface) fail('plainform_shader_internal', 'The Principled surface node is missing.');
    this.connect(value, surface.id, socket);
  }
}

function tokenize(source, bindingNames) {
  let normalized = source;
  const replacements = new Map();
  [...bindingNames].sort((a, b) => b.length - a.length).forEach((name, index) => {
    const token = `__binding_${index}`;
    normalized = normalized.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'giu'), token);
    replacements.set(token, name);
  });
  const tokens = [];
  const expression = /\s*(?:(\d+(?:\.\d+)?(?:e[+-]?\d+)?)|([a-z_][a-z0-9_]*)|([()+\-*/^,]))/giy;
  let offset = 0;
  while (offset < normalized.length) {
    expression.lastIndex = offset;
    const match = expression.exec(normalized);
    if (!match || match.index !== offset) fail('plainform_shader_math_syntax', `Cannot read the expression near “${normalized.slice(offset)}”.`);
    tokens.push(match[1] ? { kind: 'number', value: Number(match[1]) } : match[2] ? { kind: 'name', value: replacements.get(match[2]) ?? match[2].toLowerCase() } : { kind: match[3], value: match[3] });
    offset = expression.lastIndex;
  }
  return tokens;
}

function parseSymbolicExpression(source, builder) {
  const tokens = tokenize(source, builder.bindings.keys());
  let cursor = 0;
  const peek = kind => tokens[cursor]?.kind === kind;
  const take = kind => {
    if (!peek(kind)) fail('plainform_shader_math_syntax', `Expected ${kind} in “${source}”.`);
    return tokens[cursor++];
  };
  const primary = () => {
    if (peek('number')) return { kind: 'number', value: take('number').value };
    if (peek('-')) { take('-'); return { kind: 'call', name: 'negate', args: [primary()] }; }
    if (peek('(')) { take('('); const value = binary(0); take(')'); return value; }
    if (peek('name')) {
      const name = take('name').value;
      if (!peek('(')) return { kind: 'reference', name };
      take('(');
      const args = [];
      if (!peek(')')) {
        do { args.push(binary(0)); if (!peek(',')) break; take(','); } while (true);
      }
      take(')');
      return { kind: 'call', name, args };
    }
    fail('plainform_shader_math_syntax', `Expected a number, name, or function in “${source}”.`);
  };
  const precedence = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 };
  const binary = minimum => {
    let left = primary();
    while (precedence[tokens[cursor]?.kind] >= minimum) {
      const operator = tokens[cursor++].kind;
      const right = binary(precedence[operator] + (operator === '^' ? 0 : 1));
      left = { kind: 'binary', operator, left, right };
    }
    return left;
  };
  const ast = binary(0);
  if (cursor !== tokens.length) fail('plainform_shader_math_syntax', `Unexpected ${tokens[cursor].value} in “${source}”.`);
  return ast;
}

function stripOuterParentheses(source) {
  let value = source.trim();
  while (value.startsWith('(') && value.endsWith(')')) {
    let depth = 0;
    let wraps = true;
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === '(') depth += 1;
      else if (value[index] === ')') depth -= 1;
      if (depth === 0 && index < value.length - 1) { wraps = false; break; }
    }
    if (!wraps) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function splitEnglishOutside(source, phrases) {
  let depth = 0;
  const lower = source.toLowerCase();
  for (let index = source.length - 1; index >= 0; index -= 1) {
    if (source[index] === ')') depth += 1;
    else if (source[index] === '(') depth -= 1;
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

function parseEnglishExpression(source) {
  const expression = stripOuterParentheses(clean(source));
  const sum = splitEnglishOutside(expression, [' plus ', ' minus ']);
  if (sum) return { kind: 'binary', operator: sum[1] === 'plus' ? '+' : '-', left: parseEnglishExpression(sum[0]), right: parseEnglishExpression(sum[2]) };
  const product = splitEnglishOutside(expression, [' multiplied by ', ' times ', ' divided by ', ' raised to ']);
  if (product) return {
    kind: 'binary',
    operator: { 'multiplied by': '*', times: '*', 'divided by': '/', 'raised to': '^' }[product[1]],
    left: parseEnglishExpression(product[0]),
    right: parseEnglishExpression(product[2]),
  };
  if (/^twice\s+/iu.test(expression)) return { kind: 'binary', operator: '*', left: { kind: 'number', value: 2 }, right: parseEnglishExpression(expression.replace(/^twice\s+/iu, '')) };
  if (/^half of\s+/iu.test(expression)) return { kind: 'binary', operator: '*', left: { kind: 'number', value: 0.5 }, right: parseEnglishExpression(expression.replace(/^half of\s+/iu, '')) };
  for (const [prefix, name] of [
    ['the sine of ', 'sin'], ['sine of ', 'sin'], ['the cosine of ', 'cos'], ['cosine of ', 'cos'],
    ['the tangent of ', 'tan'], ['tangent of ', 'tan'], ['the absolute value of ', 'abs'], ['absolute value of ', 'abs'],
    ['the square root of ', 'sqrt'], ['square root of ', 'sqrt'], ['the fractional part of ', 'fract'], ['fractional part of ', 'fract'],
  ]) {
    if (expression.toLowerCase().startsWith(prefix)) return { kind: 'call', name, args: [parseEnglishExpression(expression.slice(prefix.length))] };
  }
  const number = Number(expression);
  if (expression !== '' && Number.isFinite(number)) return { kind: 'number', value: number };
  return { kind: 'reference', name: expression.toLowerCase().replace(/^the\s+/u, '') };
}

function parseExpression(source, builder) {
  return /\b(?:plus|minus|times|multiplied by|divided by|raised to|sine of|cosine of|tangent of|square root of|absolute value of|fractional part of|twice|half of)\b/iu.test(source)
    ? parseEnglishExpression(source)
    : parseSymbolicExpression(source, builder);
}

const UNARY_MATH = Object.freeze({
  sin: 'SINE', sine: 'SINE', cos: 'COSINE', cosine: 'COSINE', tan: 'TANGENT', tangent: 'TANGENT',
  asin: 'ARCSINE', acos: 'ARCCOSINE', atan: 'ARCTANGENT', sqrt: 'SQRT', abs: 'ABSOLUTE',
  floor: 'FLOOR', ceil: 'CEIL', fract: 'FRACT', round: 'ROUND', radians: 'RADIANS', degrees: 'DEGREES',
});
const BINARY_MATH = Object.freeze({ '+': 'ADD', '-': 'SUBTRACT', '*': 'MULTIPLY', '/': 'DIVIDE', '^': 'POWER' });

function lowerExpression(ast, builder) {
  if (ast.kind === 'number') return builder.constant(ast.value);
  if (ast.kind === 'reference') {
    if (builder.bindings.has(ast.name)) return builder.bindings.get(ast.name);
    if (ast.name === 'time' || ast.name === 'seconds') return builder.node('input.time', {}, {}, 'time');
    if (ast.name === 'pi') return builder.constant(Math.PI, 'pi');
    if (ast.name === 'tau') return builder.constant(Math.PI * 2, 'tau');
    fail('plainform_shader_unknown_value', `“${ast.name}” is not a named shader value.`);
  }
  if (ast.kind === 'binary') return builder.math(BINARY_MATH[ast.operator], [lowerExpression(ast.left, builder), lowerExpression(ast.right, builder)]);
  const args = ast.args.map(value => lowerExpression(value, builder));
  if (ast.name === 'negate') return builder.math('MULTIPLY', [args[0], builder.constant(-1)]);
  if (UNARY_MATH[ast.name]) {
    if (args.length !== 1) fail('plainform_shader_math_arity', `${ast.name} expects one value.`);
    return builder.math(UNARY_MATH[ast.name], args, ast.name);
  }
  if (['min', 'minimum', 'max', 'maximum', 'pow', 'power', 'mod', 'modulo', 'wrap', 'pingpong'].includes(ast.name)) {
    if (args.length !== 2) fail('plainform_shader_math_arity', `${ast.name} expects two values.`);
    const operation = { min: 'MINIMUM', minimum: 'MINIMUM', max: 'MAXIMUM', maximum: 'MAXIMUM', pow: 'POWER', power: 'POWER', mod: 'MODULO', modulo: 'MODULO', wrap: 'WRAP', pingpong: 'PINGPONG' }[ast.name];
    return builder.math(operation, args, ast.name);
  }
  if (ast.name === 'clamp') {
    if (args.length !== 3) fail('plainform_shader_math_arity', 'clamp expects value, minimum, and maximum.');
    return builder.math('MINIMUM', [builder.math('MAXIMUM', [args[0], args[1]], 'clamp-min'), args[2]], 'clamp-max');
  }
  if (ast.name === 'saturate') {
    if (args.length !== 1) fail('plainform_shader_math_arity', 'saturate expects one value.');
    return builder.math('MINIMUM', [builder.math('MAXIMUM', [args[0], builder.constant(0)], 'saturate-min'), builder.constant(1)], 'saturate-max');
  }
  if (ast.name === 'mix' || ast.name === 'lerp') {
    if (args.length !== 3) fail('plainform_shader_math_arity', `${ast.name} expects two values and a factor.`);
    return builder.math('MULTIPLY_ADD', [builder.math('SUBTRACT', [args[1], args[0]]), args[2], args[0]], ast.name);
  }
  if (ast.name === 'remap') {
    if (args.length !== 5) fail('plainform_shader_math_arity', 'remap expects value, input minimum, input maximum, output minimum, and output maximum.');
    const unit = builder.math('DIVIDE', [builder.math('SUBTRACT', [args[0], args[1]]), builder.math('SUBTRACT', [args[2], args[1]])]);
    return builder.math('ADD', [args[3], builder.math('MULTIPLY', [unit, builder.math('SUBTRACT', [args[4], args[3]])])], 'remap');
  }
  if (ast.name === 'noise' || ast.name === 'value_noise' || ast.name === 'fbm') {
    if (args.length !== 1) fail('plainform_shader_math_arity', `${ast.name} expects one coordinate.`);
    const result = builder.node(ast.name === 'fbm' ? 'noise.fbm' : 'noise.value', {}, {}, ast.name);
    builder.connect(args[0], result.nodeId, 'coordinate');
    return result;
  }
  if (ast.name === 'smoothstep') {
    if (args.length !== 3) fail('plainform_shader_math_arity', 'smoothstep expects lower edge, upper edge, and value.');
    const scaled = builder.math('DIVIDE', [builder.math('SUBTRACT', [args[2], args[0]]), builder.math('SUBTRACT', [args[1], args[0]])]);
    const bounded = builder.math('MINIMUM', [builder.math('MAXIMUM', [scaled, builder.constant(0)]), builder.constant(1)]);
    return builder.math('MULTIPLY', [builder.math('MULTIPLY', [bounded, bounded]), builder.math('SUBTRACT', [builder.constant(3), builder.math('MULTIPLY', [builder.constant(2), bounded])])], 'smoothstep');
  }
  fail('plainform_shader_unknown_function', `Shader math function “${ast.name}” is not supported.`);
}

const SOCKETS = Object.freeze({
  'base color': 'baseColor', color: 'baseColor', colour: 'baseColor', roughness: 'roughness', metallic: 'metallic', metalness: 'metallic',
  opacity: 'alpha', alpha: 'alpha', 'index of refraction': 'ior', ior: 'ior', transmission: 'transmissionWeight', coat: 'coatWeight',
  'coat roughness': 'coatRoughness', sheen: 'sheenWeight', 'sheen roughness': 'sheenRoughness', anisotropy: 'anisotropic',
  'emission strength': 'emissionStrength', emission: 'emissionColor', 'emission color': 'emissionColor', 'emissive color': 'emissionColor',
  iridescence: 'thinFilmThickness', 'thin film thickness': 'thinFilmThickness',
});

export class ShaderPlainformCompiler {
  static canCompile(source) {
    return /^create (?:a |an )?(?:shader|material) graph\b/imu.test(source);
  }

  constructor(options = {}) {
    this.catalog = options.catalog ?? GRAPH_CATALOGS.shader;
  }

  compile(source) {
    const statements = splitStatements(source);
    const header = statements.shift()?.match(/^create (?:a |an )?(?:shader|material) graph called (?:(?:"([^"]+)")|(.+?))(?: with id ([a-z0-9][a-z0-9._/-]*))?$/iu);
    if (!header) fail('plainform_shader_header', 'Begin with “Create a shader graph called …” and an optional stable ID.');
    const name = header[1] ?? header[2];
    const graphId = header[3] ?? `graph/${slug(name)}`;
    const builder = new GraphBuilder(this.catalog, graphId, name);
    const feelPhrases = [];
    const assignments = [];
    const materialIds = [];
    const interpretation = [`Create shader graph ${graphId}.`];
    let requestedPreview = false;

    for (const statement of statements) {
      const feel = statement.match(/^(?:make it feel|describe it as|make the surface|the surface should feel) (.+)$/iu);
      if (feel) { feelPhrases.push(feel[1]); interpretation.push(`Interpret shader feel: ${feel[1]}.`); continue; }
      const binding = statement.match(/^let (.+?) be (.+)$/iu);
      if (binding) {
        const key = clean(binding[1]).toLowerCase();
        const value = lowerExpression(parseExpression(binding[2], builder), builder);
        builder.bindings.set(key, value);
        interpretation.push(`Define ${key} as a typed math chain.`);
        continue;
      }
      const set = statement.match(/^(?:set|drive) (?:the )?(.+?) (?:to|with) (.+)$/iu);
      if (set) { assignments.push({ name: clean(set[1]).toLowerCase(), value: set[2] }); continue; }
      const use = statement.match(/^use (.+?) for (?:the )?(.+)$/iu);
      if (use) { assignments.push({ name: clean(use[2]).toLowerCase(), value: use[1] }); continue; }
      const apply = statement.match(/^apply (?:it|the shader) to (?:material )?([a-z0-9][a-z0-9._/-]*)$/iu);
      if (apply) { materialIds.push(apply[1]); continue; }
      if (/^(?:show me a preview|preview these changes)$/iu.test(statement)) {
        requestedPreview = true;
        continue;
      }
      fail('plainform_shader_unsupported_statement', `Shader Plainform does not understand “${statement}”.`);
    }

    const feel = interpretShaderFeel(feelPhrases.join(', '));
    const principledDefinition = builder.definition('blender.principledBSDF');
    const principledInputs = {};
    for (const [key, value] of Object.entries(feel.inputs)) if (principledDefinition.inputs[key]) principledInputs[key] = value;
    builder.graph.nodes.push({ id: 'principled-surface', type: 'blender.principledBSDF', params: {}, inputs: principledInputs });
    builder.graph.outputs.surface = { nodeId: 'principled-surface', port: 'surface' };

    for (const assignment of assignments) {
      const socket = SOCKETS[assignment.name];
      if (!socket || !principledDefinition.inputs[socket]) fail('plainform_shader_unknown_property', `“${assignment.name}” is not a supported Principled shader property.`);
      const color = parseColor(assignment.value);
      if (color) {
        if (principledDefinition.inputs[socket].type !== 'color') fail('plainform_shader_type_mismatch', `${assignment.name} expects a number, not a colour.`);
        principledInputs[socket] = color;
        continue;
      }
      const value = lowerExpression(parseExpression(assignment.value, builder), builder);
      builder.output(socket, value);
      delete principledInputs[socket];
      interpretation.push(`Drive ${socket} with ${assignment.value}.`);
    }
    if (requestedPreview) interpretation.push('Requested a dry-run preview.');

    const validation = validateGraph(builder.graph);
    if (!validation.valid) fail('plainform_shader_graph_invalid', 'The generated shader graph did not pass typed graph validation.', { errors: validation.errors });
    const resource = {
      id: graphId,
      kind: 'graph',
      name,
      metadata: {
        plainform: {
          descriptors: feel.descriptors,
          openDescriptors: feel.openDescriptors,
          source,
        },
      },
      graph: validation.graph,
    };
    const operations = [{ op: 'resource.create', resourceType: 'graphs', resource }];
    for (const materialId of materialIds) operations.push({ op: 'resource.patch', resourceType: 'materials', resourceId: materialId, patch: { graphId } });
    return Object.freeze({
      language: 'plainform-v1',
      dialect: 'shader',
      operations: Object.freeze(operations),
      interpretation: Object.freeze(interpretation),
      aliases: Object.freeze({}),
      requestedPreview,
      shader: Object.freeze({ graphId, descriptors: feel.descriptors, openDescriptors: feel.openDescriptors, metrics: validation.metrics }),
    });
  }
}
