const DIMENSION_POWERS = Object.freeze({ scalar: 0, length: 1, area: 2, volume: 3 });

function dimensionPower(dimension) {
  return Object.hasOwn(DIMENSION_POWERS, dimension) ? DIMENSION_POWERS[dimension] : null;
}

function dimensionFromPower(power) {
  return Object.entries(DIMENSION_POWERS).find(([, value]) => value === power)?.[0] ?? null;
}

function quantity(value, dimension = 'scalar') {
  if (!Number.isFinite(value)) throw new DesignExpressionError('plainform_math_error', 'The expression produced a non-finite value.');
  return Object.freeze({ value, dimension });
}

export class DesignExpressionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DesignExpressionError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new DesignExpressionError(code, message, details);
}

function compatible(left, right) {
  if (left.dimension === right.dimension) return left.dimension;
  if (left.dimension === 'scalar' && left.value === 0) return right.dimension;
  if (right.dimension === 'scalar' && right.value === 0) return left.dimension;
  return null;
}

function add(left, right, sign = 1) {
  const dimension = compatible(left, right);
  if (!dimension) fail('plainform_dimension_mismatch', `Cannot combine ${left.dimension} with ${right.dimension}.`);
  return quantity(left.value + sign * right.value, dimension);
}

function multiply(left, right) {
  if (left.dimension === 'angle' || right.dimension === 'angle') {
    if (left.dimension === 'scalar') return quantity(left.value * right.value, right.dimension);
    if (right.dimension === 'scalar') return quantity(left.value * right.value, left.dimension);
    fail('plainform_dimension_mismatch', `Cannot multiply ${left.dimension} by ${right.dimension}.`);
  }
  const power = dimensionPower(left.dimension) + dimensionPower(right.dimension);
  const dimension = dimensionFromPower(power);
  if (!dimension) fail('plainform_dimension_mismatch', `Cannot represent ${left.dimension} multiplied by ${right.dimension}.`);
  return quantity(left.value * right.value, dimension);
}

function divide(left, right) {
  if (right.value === 0) fail('plainform_math_error', 'Cannot divide by zero.');
  if (right.dimension === 'angle') fail('plainform_dimension_mismatch', `Cannot divide ${left.dimension} by an angle.`);
  if (left.dimension === 'angle') {
    if (right.dimension !== 'scalar') fail('plainform_dimension_mismatch', `Cannot divide an angle by ${right.dimension}.`);
    return quantity(left.value / right.value, 'angle');
  }
  const power = dimensionPower(left.dimension) - dimensionPower(right.dimension);
  const dimension = dimensionFromPower(power);
  if (!dimension) fail('plainform_dimension_mismatch', `Cannot represent ${left.dimension} divided by ${right.dimension}.`);
  return quantity(left.value / right.value, dimension);
}

function normalizeName(value) {
  return value.trim().toLowerCase().replace(/^the\s+/u, '').replace(/\s+/gu, ' ');
}

function normalizeExpression(source, variables) {
  let value = source.trim().replace(/[.;:]$/u, '').toLowerCase();
  const aliases = [...variables.keys()].sort((left, right) => right.length - left.length);
  const replacements = new Map();
  aliases.forEach((name, index) => {
    const token = `variable_${index}`;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\s+/gu, '\\s+');
    value = value.replace(new RegExp(`\\b${escaped}\\b`, 'giu'), token);
    replacements.set(token, variables.get(name));
  });
  value = value
    .replace(/\bsquare metres?\b|\bsquare meters?\b/gu, 'square_metres')
    .replace(/\bsquare centimetres?\b|\bsquare centimeters?\b/gu, 'square_centimetres')
    .replace(/\bcubic metres?\b|\bcubic meters?\b/gu, 'cubic_metres')
    .replace(/\bcubic centimetres?\b|\bcubic centimeters?\b/gu, 'cubic_centimetres')
    .replace(/\bone full turn\b|\ba full turn\b/gu, 'tau radians')
    .replace(/\bhalf (?:of )?(?:one |a )?full turn\b/gu, 'pi radians')
    .replace(/\bto the power of\b/gu, '^')
    .replace(/\bmultiplied by\b|\btimes\b/gu, '*')
    .replace(/\bdivided by\b/gu, '/')
    .replace(/\bplus\b/gu, '+')
    .replace(/\bminus\b/gu, '-')
    .replace(/\bmodulo\b|\bmod\b/gu, '%')
    .replace(/\bthe sine of\b|\bsine of\b/gu, 'sin ')
    .replace(/\bthe cosine of\b|\bcosine of\b/gu, 'cos ')
    .replace(/\bthe tangent of\b|\btangent of\b/gu, 'tan ')
    .replace(/\bthe square root of\b|\bsquare root of\b/gu, 'sqrt ')
    .replace(/\bthe absolute value of\b|\babsolute value of\b/gu, 'abs ')
    .replace(/\binverse lerp\b/gu, 'inverselerp');
  return { value, replacements };
}

function tokenize(source) {
  const tokens = [];
  const pattern = /\s*(?:(\d+(?:\.\d+)?(?:e[+-]?\d+)?)|([a-z_][a-z0-9_]*)|([()+\-*/%^,]))/gyu;
  let index = 0;
  while (index < source.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match) fail('plainform_unknown_expression', `I could not understand the expression near “${source.slice(index)}”.`);
    tokens.push(match[1] !== undefined
      ? { type: 'number', value: Number(match[1]) }
      : match[2] !== undefined ? { type: 'word', value: match[2] } : { type: match[3], value: match[3] });
    index = pattern.lastIndex;
  }
  tokens.push({ type: 'end', value: '' });
  return tokens;
}

const UNIT = Object.freeze({
  metre: [1, 'length'], metres: [1, 'length'], meter: [1, 'length'], meters: [1, 'length'],
  centimetre: [0.01, 'length'], centimetres: [0.01, 'length'], centimeter: [0.01, 'length'], centimeters: [0.01, 'length'],
  millimetre: [0.001, 'length'], millimetres: [0.001, 'length'], millimeter: [0.001, 'length'], millimeters: [0.001, 'length'],
  degree: [Math.PI / 180, 'angle'], degrees: [Math.PI / 180, 'angle'],
  radian: [1, 'angle'], radians: [1, 'angle'], percent: [0.01, 'scalar'],
  square_metres: [1, 'area'], square_centimetres: [0.0001, 'area'],
  cubic_metres: [1, 'volume'], cubic_centimetres: [0.000001, 'volume'],
});

class Parser {
  constructor(tokens, replacements) {
    this.tokens = tokens;
    this.replacements = replacements;
    this.index = 0;
  }

  peek(type) { return this.tokens[this.index].type === type; }
  take(type) {
    if (!this.peek(type)) fail('plainform_unknown_expression', `Expected “${type}” in mathematical expression.`);
    return this.tokens[this.index++];
  }

  parse() {
    const value = this.additive();
    if (!this.peek('end')) fail('plainform_unknown_expression', `Unexpected “${this.tokens[this.index].value}” in mathematical expression.`);
    return value;
  }

  additive() {
    let left = this.multiplicative();
    while (this.peek('+') || this.peek('-')) {
      const operator = this.tokens[this.index++].type;
      left = add(left, this.multiplicative(), operator === '-' ? -1 : 1);
    }
    return left;
  }

  multiplicative() {
    let left = this.power();
    while (this.peek('*') || this.peek('/') || this.peek('%')) {
      const operator = this.tokens[this.index++].type;
      const right = this.power();
      if (operator === '*') left = multiply(left, right);
      else if (operator === '/') left = divide(left, right);
      else {
        if (left.dimension !== right.dimension && right.dimension !== 'scalar') fail('plainform_dimension_mismatch', 'Modulo operands must use compatible dimensions.');
        if (right.value === 0) fail('plainform_math_error', 'Cannot take modulo zero.');
        left = quantity(left.value % right.value, left.dimension);
      }
    }
    return left;
  }

  power() {
    let left = this.unary();
    if (this.peek('^')) {
      this.index += 1;
      const exponent = this.power();
      if (exponent.dimension !== 'scalar') fail('plainform_dimension_mismatch', 'An exponent must be dimensionless.');
      const basePower = dimensionPower(left.dimension);
      if (left.dimension === 'angle' || basePower === null) fail('plainform_dimension_mismatch', `Cannot exponentiate ${left.dimension}.`);
      const dimension = dimensionFromPower(basePower * exponent.value);
      if (!dimension) fail('plainform_dimension_mismatch', 'The resulting dimensional power is unsupported.');
      left = quantity(left.value ** exponent.value, dimension);
    }
    return left;
  }

  unary() {
    if (this.peek('+')) { this.index += 1; return this.unary(); }
    if (this.peek('-')) { this.index += 1; const value = this.unary(); return quantity(-value.value, value.dimension); }
    return this.primary();
  }

  primary() {
    if (this.peek('(')) {
      this.index += 1;
      const value = this.additive();
      this.take(')');
      return value;
    }
    if (this.peek('number')) {
      const number = this.tokens[this.index++].value;
      if (this.peek('word') && UNIT[this.tokens[this.index].value]) {
        const [factor, dimension] = UNIT[this.tokens[this.index++].value];
        return quantity(number * factor, dimension);
      }
      return quantity(number);
    }
    const word = this.take('word').value;
    if (this.replacements.has(word)) return this.replacements.get(word);
    if (word === 'pi') return quantity(Math.PI);
    if (word === 'tau') return quantity(Math.PI * 2);
    if (word === 'e') return quantity(Math.E);
    if (this.peek('(')) return this.call(word);
    if (['sin', 'cos', 'tan', 'sqrt', 'abs', 'floor', 'ceil', 'round'].includes(word)) {
      return this.applyFunction(word, [this.unary()]);
    }
    fail('plainform_unknown_variable', `Unknown mathematical name “${word}”.`);
  }

  call(name) {
    this.take('(');
    const args = [];
    if (!this.peek(')')) {
      do {
        args.push(this.additive());
        if (!this.peek(',')) break;
        this.index += 1;
      } while (!this.peek(')'));
    }
    this.take(')');
    return this.applyFunction(name, args);
  }

  applyFunction(name, args) {
    const arity = count => { if (args.length !== count) fail('plainform_math_arity', `${name} requires ${count} arguments.`); };
    if (['sin', 'cos', 'tan'].includes(name)) {
      arity(1);
      if (!['scalar', 'angle'].includes(args[0].dimension)) fail('plainform_dimension_mismatch', `${name} requires an angle or scalar.`);
      return quantity(Math[name](args[0].value));
    }
    if (['asin', 'acos', 'atan'].includes(name)) { arity(1); if (args[0].dimension !== 'scalar') fail('plainform_dimension_mismatch', `${name} requires a scalar.`); return quantity(Math[name](args[0].value), 'angle'); }
    if (name === 'atan2') { arity(2); if (!compatible(args[0], args[1])) fail('plainform_dimension_mismatch', 'atan2 inputs must have matching dimensions.'); return quantity(Math.atan2(args[0].value, args[1].value), 'angle'); }
    if (name === 'abs') { arity(1); return quantity(Math.abs(args[0].value), args[0].dimension); }
    if (['floor', 'ceil', 'round'].includes(name)) { arity(1); return quantity(Math[name](args[0].value), args[0].dimension); }
    if (name === 'sqrt') {
      arity(1);
      if (args[0].value < 0) fail('plainform_math_error', 'Cannot take the square root of a negative value.');
      const power = dimensionPower(args[0].dimension);
      const dimension = dimensionFromPower(power / 2);
      if (!dimension) fail('plainform_dimension_mismatch', `Cannot take a supported square root of ${args[0].dimension}.`);
      return quantity(Math.sqrt(args[0].value), dimension);
    }
    if (name === 'pow') { arity(2); return multiplyPower(args[0], args[1]); }
    if (name === 'min' || name === 'max') {
      if (args.length < 2) fail('plainform_math_arity', `${name} requires at least 2 arguments.`);
      const dimension = args.slice(1).reduce((current, value) => compatible({ value: 1, dimension: current }, value), args[0].dimension);
      if (!dimension) fail('plainform_dimension_mismatch', `${name} arguments must have compatible dimensions.`);
      return quantity(Math[name](...args.map(value => value.value)), dimension);
    }
    if (name === 'clamp') { arity(3); return clampQuantity(args[0], args[1], args[2]); }
    if (name === 'saturate') { arity(1); if (args[0].dimension !== 'scalar') fail('plainform_dimension_mismatch', 'saturate requires a scalar.'); return quantity(Math.min(1, Math.max(0, args[0].value))); }
    if (name === 'lerp') { arity(3); return lerpQuantity(args[0], args[1], args[2]); }
    if (name === 'inverselerp') { arity(3); const span = add(args[1], args[0], -1); return divide(add(args[2], args[0], -1), span); }
    if (name === 'remap') { arity(5); return lerpQuantity(args[3], args[4], divide(add(args[2], args[0], -1), add(args[1], args[0], -1))); }
    if (name === 'smoothstep') {
      arity(3);
      const t = clampQuantity(divide(add(args[2], args[0], -1), add(args[1], args[0], -1)), quantity(0), quantity(1));
      return quantity(t.value * t.value * (3 - 2 * t.value));
    }
    fail('plainform_unknown_function', `Unknown mathematical function “${name}”.`);
  }
}

function multiplyPower(base, exponent) {
  if (exponent.dimension !== 'scalar') fail('plainform_dimension_mismatch', 'pow exponent must be scalar.');
  const basePower = dimensionPower(base.dimension);
  const dimension = dimensionFromPower(basePower * exponent.value);
  if (!dimension) fail('plainform_dimension_mismatch', 'pow produced an unsupported dimensional power.');
  return quantity(base.value ** exponent.value, dimension);
}

function clampQuantity(value, minimum, maximum) {
  const dimension = compatible(value, minimum) && compatible(value, maximum);
  if (!dimension) fail('plainform_dimension_mismatch', 'clamp arguments must have compatible dimensions.');
  return quantity(Math.min(maximum.value, Math.max(minimum.value, value.value)), value.dimension);
}

function lerpQuantity(start, end, amount) {
  const dimension = compatible(start, end);
  if (!dimension || amount.dimension !== 'scalar') fail('plainform_dimension_mismatch', 'lerp requires compatible endpoints and a scalar amount.');
  return quantity(start.value + (end.value - start.value) * amount.value, dimension);
}

/** Parse and evaluate bounded, unit-aware Design Plainform mathematics. */
export function evaluateDesignExpression(source, variables = new Map()) {
  const normalizedVariables = new Map([...variables].map(([name, value]) => [normalizeName(name), value]));
  const normalized = normalizeExpression(source, normalizedVariables);
  return new Parser(tokenize(normalized.value), normalized.replacements).parse();
}

export function evaluateDesignVector(source, variables, expectedDimension) {
  const match = source.trim().match(/^\[(.*)\]$/u);
  if (!match) fail('plainform_vector_expected', `Expected a three-part vector, received “${source}”.`);
  const parts = match[1].split(',').map(value => value.trim());
  if (parts.length !== 3) fail('plainform_vector_expected', 'Vectors must contain exactly three values.');
  return parts.map(part => {
    const value = evaluateDesignExpression(part, variables);
    if (value.dimension !== expectedDimension && !(value.dimension === 'scalar' && value.value === 0)) {
      fail('plainform_dimension_mismatch', `Vector component “${part}” must be ${expectedDimension}.`);
    }
    return value.value;
  });
}
