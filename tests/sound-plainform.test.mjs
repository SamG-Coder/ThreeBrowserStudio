import assert from 'node:assert/strict';
import test from 'node:test';

import { AuthoringKernel, createProjectDocument } from '../src/core/index.mjs';
import { operationSchema } from '../src/mcp/tool-schemas.mjs';
import { PlainformCompiler, parsePlainformProgram, getPlainformGrammarCatalog } from '../src/plainform/index.mjs';
import { evaluateAudioGraph } from '../src/audio/index.mjs';

function project() {
  return createProjectDocument({
    projectId: 'project/sound-plainform',
    scenes: [{ id: 'scene/main', rootEntityIds: [], entities: [] }],
  });
}

const SOUND_SOURCE = [
  'Design a sound called Distant Bell with id audio/distant-bell using the right-up-forward design frame.',
  'Let tempo be 72 beats per minute.',
  'Let duration be 1.2 seconds.',
  'Let bell frequency be 440 hertz.',
  'Create a sine oscillator called Bell at bell frequency, volume 0.28.',
  'Shape Bell with attack 8 milliseconds, decay 0.25 seconds, sustain 0.1, release 0.2 seconds.',
  'Add a quiet harmonic at 3 times Bell frequency, volume 0.12.',
  'Create pink noise called Rain, volume 0.08.',
  'Filter Rain with a low-pass at 900 hertz, resonance 0.4.',
  'Place Bell 1.5 metres right of the listener and 80 centimetres up.',
  'Mirror Rain across the listener as Left Rain.',
  'Put Bell and Rain into a group called Voices with id entity/distant-bell/voices.',
  'Make it feel warm and muffled.',
  'Keep peak level below 6 decibels.',
  'Frame the sound visualization from slightly above at a 50 millimetre lens.',
  'When Play starts, play Distant Bell.',
  'Preview this sound.',
].join('\n');

function kernelOperations(operations) {
  return operations.filter(operation => operation.op !== 'camera.frame');
}

test('Sound dialect is inferred and catalogued separately from Design', () => {
  const ast = parsePlainformProgram(SOUND_SOURCE);
  assert.equal(ast.dialect, 'sound');
  assert.equal(ast.statements[0].kind, 'sound.header');
  assert.equal(ast.statements.some(item => item.kind === 'sound.createOscillator'), true);
  assert.equal(ast.statements.some(item => item.kind === 'request.preview'), true);
  const catalog = getPlainformGrammarCatalog({ dialect: 'sound', domain: 'source', limit: 16 });
  assert.ok(catalog.entries.some(entry => entry.id === 'sound.oscillator'));
});

test('Sound Plainform compiles graph, audio resource, visualization, event sheet, and preview', () => {
  const compiled = new PlainformCompiler().compile(SOUND_SOURCE, { project: project() });
  assert.equal(compiled.dialect, 'sound');
  assert.equal(compiled.requestedPreview, true);
  assert.equal(compiled.sound.audioId, 'audio/distant-bell');
  assert.equal(compiled.sound.graphId, 'graph/distant-bell');
  assert.ok(compiled.sound.digest.peak > 0);
  assert.ok(compiled.operations.every(operation => operationSchema.safeParse(operation).success), JSON.stringify(compiled.operations.map(op => ({ op: op.op, issues: operationSchema.safeParse(op).error?.issues })), null, 2));
  const graphOp = compiled.operations.find(operation => operation.op === 'resource.createMany')
    .items.find(item => item.resourceType === 'graphs' && item.resource.graph?.domain === 'audio');
  assert.equal(graphOp.resource.graph.domain, 'audio');
  assert.ok(graphOp.resource.graph.nodes.some(node => node.type === 'audio.oscillator'));
  assert.ok(graphOp.resource.graph.nodes.some(node => node.type === 'audio.panner'));
  assert.ok(compiled.operations.some(operation => operation.op === 'scene.create' && operation.scene.settings.purpose === 'sound'));
  assert.ok(compiled.operations.some(operation => operation.op === 'entity.create' && operation.entity.kind === 'audioSource'));
  assert.ok(compiled.operations.some(operation => operation.op === 'entity.create' && operation.entity.id === 'entity/distant-bell/spectrogram'));
  assert.ok(compiled.operations.some(operation => operation.op === 'entity.create' && operation.entity.id === 'entity/distant-bell/plinth'));
  const spectrogramMaterial = compiled.operations
    .filter(operation => operation.op === 'resource.createMany')
    .flatMap(operation => operation.items)
    .find(item => item.resource?.id === 'material/distant-bell/spectrogram');
  assert.equal(spectrogramMaterial?.resource?.recipe?.vertexColors, true);
  assert.ok(compiled.operations.some(operation => operation.op === 'camera.frame'));
  const evaluated = evaluateAudioGraph(graphOp.resource.graph);
  assert.equal(evaluated.digest.duration, compiled.sound.duration);
});

test('Sound Plainform applies through the kernel and rebuilds by patch', async () => {
  const initial = project();
  const compiled = new PlainformCompiler().compile(SOUND_SOURCE.replace('\nPreview this sound.', ''), { project: initial });
  const kernel = new AuthoringKernel(initial);
  await kernel.apply({
    baseRevision: kernel.document.revision,
    idempotencyKey: 'sound-plainform-create',
    label: 'Create distant bell sound',
    operations: kernelOperations(compiled.operations),
  });
  const scene = kernel.document.scenes['scene/distant-bell'];
  assert.equal(scene.settings.purpose, 'sound');
  assert.equal(scene.settings.audio.audioId, 'audio/distant-bell');
  assert.ok(kernel.document.resources.audio['audio/distant-bell']);
  assert.ok(kernel.document.resources.graphs['graph/distant-bell']);
  assert.ok(scene.entities['entity/distant-bell/spectrogram']);
  const rebuilt = new PlainformCompiler().compile(SOUND_SOURCE.replace('\nPreview this sound.', ''), { project: kernel.document });
  assert.ok(rebuilt.operations.some(operation => operation.op === 'resource.patch'));
});

test('bounded loops, sequences, and constraints fail closed', () => {
  const compiler = new PlainformCompiler();
  const initial = project();
  const looped = compiler.compile([
    'Design a sound called Partials with id audio/partials.',
    'Let bell frequency be 220 hertz.',
    'Let count be 3.',
    'For every i from 1 through count:',
    '  Create a sine oscillator called Partial i at bell frequency * i, volume 0.12.',
    'End.',
  ].join('\n'), { project: initial });
  assert.equal(looped.sound.voiceCount, 3);

  const sequenced = compiler.compile([
    'Design a sound called Phrase with id audio/phrase.',
    'Let tempo be 120 beats per minute.',
    'Create a sine oscillator called Lead at 261.63 hertz, volume 0.24.',
    'Sequence Lead as C4, E4, G4, C5, one note per beat.',
  ].join('\n'), { project: initial });
  assert.ok(sequenced.sound.duration >= 1.9);

  assert.throws(
    () => compiler.compile('Design a sound called Empty with id audio/empty.', { project: initial }),
    error => error.code === 'plainform_sound_source_required',
  );
  assert.throws(
    () => compiler.compile([
      'Design a sound called Hot with id audio/hot.',
      'Create a sine oscillator called Tone at 440 hertz, volume 1.',
      'Keep peak level below -80 decibels.',
    ].join('\n'), { project: initial }),
    error => error.code === 'plainform_constraint_unsatisfied',
  );
  const spaced = compiler.compile([
    'Design a sound called Named Pad with id audio/named-pad.',
    'Create a sine oscillator called Low Pad at 220 hertz, volume 0.2.',
    'Place Low Pad 90 centimetres left of the listener and 40 centimetres up.',
  ].join('\n'), { project: initial });
  assert.ok(spaced.interpretation.some(line => line.includes('Place Low Pad')));

  const syllable = compiler.compile([
    'Design a sound called Syllable with id audio/syllable.',
    'Let duration be 4 seconds.',
    'Create a sawtooth oscillator called Twin at 261.63 hertz, volume 0.3, starting at 0 seconds.',
    'Shape Twin with attack 40 milliseconds, decay 0.1 seconds, sustain 0.7, release 0.2 seconds, hold 0.6 seconds.',
  ].join('\n'), { project: initial });
  const adsr = syllable.operations
    .find(operation => operation.op === 'resource.createMany')
    .items.find(item => item.resourceType === 'graphs' && item.resource.graph?.domain === 'audio')
    .resource.graph.nodes.find(node => node.type === 'audio.adsr');
  assert.equal(adsr.params.hold, 0.6);
  assert.equal(adsr.params.startTime, 0);

  const voiced = compiler.compile([
    'Design a sound called Rap with id audio/rap.',
    'Create a pulse oscillator called Spit at 140 hertz, volume 0.4.',
    'Give Spit a vocal tract as ah.',
    'Sequence Spit as C3, C3, D3, C3, one note per beat.',
  ].join('\n'), { project: initial });
  const rapGraph = voiced.operations
    .find(operation => operation.op === 'resource.createMany')
    .items.find(item => item.resourceType === 'graphs' && item.resource.graph?.domain === 'audio')
    .resource.graph;
  assert.ok(rapGraph.nodes.some(node => node.type === 'audio.formant' && node.params.f1 === 730));
  assert.ok(rapGraph.nodes.some(node => node.type === 'audio.sequence' && node.params.waveform === 'pulse'));

  const timed = compiler.compile([
    'Design a sound called Timed with id audio/timed.',
    'Let duration be 4 seconds.',
    'Create a pulse oscillator called First at 140 hertz, volume 0.3, starting at 0 seconds.',
    'Create a pulse oscillator called Later at 220 hertz, volume 0.5, starting at 3 seconds.',
  ].join('\n'), { project: initial });
  const first = timed.operations.find(operation => operation.op === 'entity.create' && operation.entity.id === 'entity/timed/source/first');
  const later = timed.operations.find(operation => operation.op === 'entity.create' && operation.entity.id === 'entity/timed/source/later');
  assert.ok(later.entity.transform.position[2] > first.entity.transform.position[2] + 1);
  assert.ok(later.entity.transform.scale[0] > first.entity.transform.scale[0]);

  assert.throws(
    () => compiler.compile('Create a sine oscillator called Bell at 440 hertz.', { project: initial }),
  );
});
