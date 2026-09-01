import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectDocument } from '../src/core/documents.mjs';
import {
  DesignPlainformCompiler,
  PlainformCompiler,
  PlainformStatementRegistry,
  ShaderPlainformCompiler,
  getPlainformGrammarCatalog,
  parsePlainformProgram,
  tokenizePlainformSource,
} from '../src/plainform/index.mjs';

function emptyProject() {
  return createProjectDocument({
    projectId: 'project/plainform-front-end',
    scenes: [{ id: 'scene/main', rootEntityIds: [], entities: [] }],
  });
}

test('Plainform tokenizer retains exact line, statement, token, and terminator spans', () => {
  const source = [
    '  Create a box called Body with id entity/body, with width 1 metre, height 2 metres, and depth 3 metres.;  ',
    '',
    'Preview these changes.',
  ].join('\r\n');
  const tokenized = tokenizePlainformSource(source);

  assert.equal(tokenized.lineCount, 3);
  assert.equal(tokenized.statements.length, 2);
  const [box, preview] = tokenized.statements;
  assert.equal(box.line, 1);
  assert.equal(box.column.start, 3);
  assert.equal(box.terminator, '.;');
  assert.equal(source.slice(box.span.start, box.span.end), box.text);
  assert.equal(source.slice(box.rawSpan.start, box.rawSpan.end), box.raw);
  assert.deepEqual(
    box.tokens.filter(token => token.kind === 'unit').map(token => token.normalized),
    ['metre', 'metres', 'metres'],
  );
  assert.deepEqual(
    box.tokens.filter(token => token.kind === 'id').map(token => token.value),
    ['entity/body'],
  );
  assert.equal(preview.line, 3);
  assert.equal(source.slice(preview.span.start, preview.span.end), 'Preview these changes');
  assert.ok(Object.isFrozen(tokenized));
  assert.ok(Object.isFrozen(box.tokens));
});

test('typed Design AST covers one representative statement from every initial migration domain', () => {
  const source = [
    'Design a character called "Demo" with id entity/demo using the right-up-forward design frame.',
    'Create a rectangular profile called Body Profile with width 1 metre and depth 80 centimetres.',
    'Create a smooth guide curve called Hair Path through [0 metres, 0 metres, 0 metres], [0 metres, 1 metre, 0 metres].',
    'Create a box called Body with id entity/body, with width 1 metre, height 2 metres, and depth 1 metre.',
    'Create a coordinated eye pair called Eyes with id entity/eyes, centered at [0 metres, 1 metre, 0 metres], separated by 6 centimetres, with eye width 3 centimetres, eye height 2 centimetres, and eye depth 2 centimetres, looking at [0 metres, 1 metre, 4 metres].',
    'Groom a hair card called Fringe with id entity/fringe along guide Hair Path, with width 2 centimetres, tapering to 2 millimetres.',
    'Loft a watertight solid called Body Loft with id entity/body-loft through all sections of Body Profile, with 4 cap rings.',
    'Subdivide the surface region Cheek locally by 2 levels, then relax it for 8 iterations with strength 0.4.',
    'Preview these changes.',
  ].join('\n');
  const ast = parsePlainformProgram(source);

  assert.equal(ast.dialect, 'design');
  assert.deepEqual(ast.statements.map(statement => statement.kind), [
    'design.header',
    'profile.createRectangular',
    'guide.create',
    'primitive.createBox',
    'assembly.createEyePair',
    'groom.createHairCard',
    'loft.create',
    'surface.subdivideRegion',
    'request.preview',
  ]);
  assert.deepEqual(ast.metrics, {
    statementCount: 9,
    typedStatementCount: 9,
    legacyStatementCount: 0,
    ambiguousStatementCount: 0,
  });
  assert.equal(ast.statements[3].semanticKey, 'primitive.entity/body');
  assert.equal(ast.statements[7].fields.levels, 2);
  assert.equal(ast.statements[7].fields.relaxIterations, 8);
  assert.ok(ast.statements.every(statement => Object.isFrozen(statement)));
});

test('object growth and Shader statements use typed nodes while unmigrated grammar stays explicit', () => {
  const objectAst = parsePlainformProgram([
    'Use positive Y as the growth axis for the trunk.',
    'Find every visible mesh tagged "leaf".',
  ].join('\n'));
  assert.equal(objectAst.dialect, 'object');
  assert.equal(objectAst.statements[0].kind, 'growth.setAxis');
  assert.deepEqual(objectAst.statements[0].fields, {
    direction: 'positive', axis: 'y', target: 'trunk',
  });
  assert.equal(objectAst.statements[1].kind, 'legacy.statement');
  assert.equal(objectAst.statements[1].legacy, true);

  const shaderAst = parsePlainformProgram([
    'Create a shader graph called Rugged Bark with id graph/rugged-bark.',
    'Make it feel weathered and rough.',
    'Set roughness to 0.82.',
  ].join('\n'));
  assert.equal(shaderAst.dialect, 'shader');
  assert.deepEqual(shaderAst.statements.map(statement => statement.kind), [
    'shader.header', 'legacy.statement', 'shader.setProperty',
  ]);
  assert.equal(shaderAst.statements[2].semanticKey, 'shader.property.roughness');
});

test('recognized semantic keys do not depend on blank lines or trailing punctuation', () => {
  const first = parsePlainformProgram('Use positive Y as the growth axis for the trunk.');
  const second = parsePlainformProgram('\n\nUse positive Y as the growth axis for the trunk;;;\n');
  assert.equal(first.statements[0].semanticKey, second.statements[0].semanticKey);
  assert.equal(first.statements[0].kind, second.statements[0].kind);
});

test('generated Plainform grammar catalog is bounded, searchable, and JSON-safe', () => {
  const catalog = getPlainformGrammarCatalog({ dialect: 'design', query: 'groom', limit: 8 });
  assert.equal(catalog.total, 3);
  assert.equal(catalog.entries[0].id, 'design.groom.hairCard');
  assert.equal(catalog.entries[1].id, 'design.groom.pineNeedleField');
  assert.equal(catalog.entries[2].id, 'design.groom.regionField');
  assert.equal(typeof catalog.entries[0].grammar.source, 'string');
  assert.doesNotThrow(() => JSON.stringify(catalog));
  assert.ok(Object.isFrozen(catalog));
  assert.throws(
    () => getPlainformGrammarCatalog({ limit: 257 }),
    error => error instanceof RangeError,
  );
});

test('statement registry rejects duplicate IDs and global matching expressions', () => {
  const item = {
    id: 'test.statement', dialect: 'object', domain: 'test', kind: 'test.statement',
    pattern: /^test$/u, priority: 1, inputs: [], outputs: [], examples: [],
    semanticKey: () => 'test',
  };
  assert.throws(() => new PlainformStatementRegistry([item, item]), TypeError);
  assert.throws(() => new PlainformStatementRegistry([{ ...item, pattern: /^test$/gu }]), TypeError);
});

test('front-end dialect routing preserves existing Design and Shader lowering exactly', () => {
  const project = emptyProject();
  const designSource = [
    'Design a prop called Test Prop with id entity/test-prop.',
    'Create a box called Body with id entity/test-body, with width 1 metre, height 2 metres, and depth 1 metre.',
  ].join('\n');
  const shaderSource = [
    'Create a shader graph called Test Surface with id graph/test-surface.',
    'Set roughness to 0.72.',
  ].join('\n');

  assert.deepEqual(
    new PlainformCompiler().compile(designSource, { project }),
    new DesignPlainformCompiler().compile(designSource, { project }),
  );
  assert.deepEqual(
    new PlainformCompiler().compile(shaderSource, { project }),
    new ShaderPlainformCompiler().compile(shaderSource),
  );
});

test('ordinary compilation traverses the new AST seam without adding AST data to mutations', () => {
  let parseCount = 0;
  class TrackingCompiler extends PlainformCompiler {
    parse(source) {
      parseCount += 1;
      return super.parse(source);
    }
  }
  const compiled = new TrackingCompiler().compile([
    'Create a shader graph called Tracked.',
    'Set roughness to 0.5.',
  ].join('\n'), { project: emptyProject() });
  assert.equal(parseCount, 1);
  assert.equal('ast' in compiled, false);
  assert.equal(compiled.dialect, 'shader');
});
