import assert from 'node:assert/strict';
import test from 'node:test';

import { GRAPH_CATALOGS, validateGraph } from '../src/graphs/index.mjs';
import {
  AUDIO_LIMITS,
  createAudioRuntime,
  encodeWavPcm16,
  evaluateAudioGraph,
  expectedAudioBackend,
  parseNoteName,
  parseNotePattern,
} from '../src/audio/index.mjs';
import { evaluateDesignExpression } from '../src/plainform/design-expression.mjs';

test('glottal pulse through a three-formant tract stays finite and voiced', () => {
  const graph = {
    formatVersion: 1,
    id: 'graph/voice',
    domain: 'audio',
    settings: { sampleRate: 22050, duration: 0.3, channels: 2 },
    nodes: [
      { id: 'glot', type: 'audio.oscillator', params: { waveform: 'pulse', frequency: 140, gain: 0.4 } },
      { id: 'tract', type: 'audio.formant', params: { f1: 500, f2: 1500, f3: 2500, q: 6, dry: 0.1 } },
    ],
    edges: [{ from: { nodeId: 'glot', port: 'audio' }, to: { nodeId: 'tract', port: 'audio' } }],
    outputs: { mix: { nodeId: 'tract', port: 'audio' } },
  };
  const validation = validateGraph(graph);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const evaluated = evaluateAudioGraph(validation.graph);
  assert.ok(evaluated.digest.peak > 0);
  assert.ok(evaluated.digest.peak <= 4);
  assert.ok(evaluated.digest.centroidHz > 200);
  assert.ok(evaluated.digest.centroidHz < 2800);
});

test('pressed LF pulse has a negative glottal-closure spike', () => {
  const graph = {
    formatVersion: 1,
    id: 'graph/glot',
    domain: 'audio',
    settings: { sampleRate: 22050, duration: 0.08, channels: 2 },
    nodes: [
      { id: 'glot', type: 'audio.oscillator', params: { waveform: 'pulse', frequency: 140, gain: 0.5 } },
    ],
    edges: [],
    outputs: { mix: { nodeId: 'glot', port: 'audio' } },
  };
  const evaluated = evaluateAudioGraph(validateGraph(graph).graph);
  let min = 0;
  let max = 0;
  for (const sample of evaluated.left) {
    min = Math.min(min, sample);
    max = Math.max(max, sample);
  }
  assert.ok(min < -0.12, `closure min ${min}`);
  assert.ok(max > 0.04, `open max ${max}`);
  assert.ok(evaluated.digest.peak > 0);
});

test('audio catalog validates a mix of oscillator, envelope, and panner', () => {
  const graph = {
    formatVersion: 1,
    id: 'graph/bell',
    domain: 'audio',
    settings: { sampleRate: 22050, duration: 0.4, channels: 2 },
    nodes: [
      { id: 'osc', type: 'audio.oscillator', params: { waveform: 'sine', frequency: 440, gain: 0.3 } },
      { id: 'env', type: 'audio.adsr', params: { attack: 0.01, decay: 0.08, sustain: 0.2, release: 0.1, hold: 0.1 } },
      { id: 'pan', type: 'audio.panner', params: { x: 1.2, y: 0, z: 0.4 } },
    ],
    edges: [
      { from: { nodeId: 'osc', port: 'audio' }, to: { nodeId: 'env', port: 'audio' } },
      { from: { nodeId: 'env', port: 'audio' }, to: { nodeId: 'pan', port: 'audio' } },
    ],
    outputs: { mix: { nodeId: 'pan', port: 'audio' } },
  };
  const validation = validateGraph(graph);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(validation.graph.domain, 'audio');
  const evaluated = evaluateAudioGraph(validation.graph);
  assert.equal(evaluated.sampleRate, 22050);
  assert.ok(evaluated.digest.peak > 0);
  assert.equal(evaluated.spectrogram.length, AUDIO_LIMITS.spectrogramTimeBins);
  assert.equal(evaluated.envelope.length, AUDIO_LIMITS.envelopeSamples);
  assert.ok(evaluated.harmonics.length >= 1);
});

test('note names and Design time/frequency units are typed', () => {
  assert.ok(Math.abs(parseNoteName('A4') - 440) < 0.001);
  assert.deepEqual(parseNotePattern('C4 E4 G4').length, 3);
  const tempo = evaluateDesignExpression('72 beats per minute');
  assert.equal(tempo.dimension, 'tempo');
  assert.equal(tempo.value, 72);
  const time = evaluateDesignExpression('8 beats', new Map([['tempo', tempo]]));
  assert.equal(time.dimension, 'beats');
  const hz = evaluateDesignExpression('440 hertz');
  assert.equal(hz.dimension, 'frequency');
  const cycles = evaluateDesignExpression('440 hertz * 2 seconds');
  assert.equal(cycles.dimension, 'scalar');
  assert.equal(cycles.value, 880);
});

test('audio runtime reports silent playback when AudioContext is absent', () => {
  const graph = validateGraph({
    formatVersion: 1,
    id: 'graph/tone',
    domain: 'audio',
    settings: { sampleRate: 22050, duration: 0.2, channels: 2 },
    nodes: [{ id: 'osc', type: 'audio.oscillator', params: { waveform: 'sine', frequency: 220, gain: 0.2 } }],
    edges: [],
    outputs: { mix: { nodeId: 'osc', port: 'audio' } },
  }).graph;
  const runtime = createAudioRuntime({
    project: { resources: { graphs: { 'graph/tone': { graph } } } },
    scene: { settings: { purpose: 'sound', audio: { graphId: 'graph/tone', audioId: 'audio/tone', duration: 0.2 } } },
  });
  const started = runtime.enter();
  assert.equal(started.backend, expectedAudioBackend());
  assert.equal(runtime.playing, true);
  runtime.advance(0.05);
  assert.ok(runtime.elapsed > 0);
  runtime.stop();
  assert.equal(runtime.playing, false);
  assert.ok(GRAPH_CATALOGS.audio.nodes['audio.filter']);
});

test('PCM mix encodes as a stereo 16-bit WAV', () => {
  const left = new Float32Array([0, 0.5, -1]);
  const right = new Float32Array([0, -0.5, 1]);
  const bytes = encodeWavPcm16({ left, right, sampleRate: 22050 });
  const ascii = (offset, count) => String.fromCharCode(...bytes.subarray(offset, offset + count));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(ascii(8, 4), 'WAVE');
  assert.equal(ascii(12, 4), 'fmt ');
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 22050);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(ascii(36, 4), 'data');
  assert.equal(view.getUint32(40, true), 12);
  assert.equal(bytes.length, 56);
});

test('audio runtime prefers HTMLAudioElement and a baked WAV over Web Audio', () => {
  const graph = validateGraph({
    formatVersion: 1,
    id: 'graph/cove',
    domain: 'audio',
    settings: { sampleRate: 22050, duration: 0.4, channels: 2 },
    nodes: [{ id: 'osc', type: 'audio.oscillator', params: { waveform: 'sine', frequency: 220, gain: 0.3 } }],
    edges: [],
    outputs: { mix: { nodeId: 'osc', port: 'audio' } },
  }).graph;
  const files = new Map();
  const plays = [];
  const audioFactory = (source) => {
    const element = {
      source,
      loop: false,
      volume: 1,
      currentTime: 0,
      paused: true,
      play() {
        this.paused = false;
        plays.push({ source: this.source, loop: this.loop, volume: this.volume, currentTime: this.currentTime });
        return Promise.resolve();
      },
      pause() { this.paused = true; },
      close() { this.closed = true; },
    };
    return element;
  };
  const runtime = createAudioRuntime({
    project: { resources: { graphs: { 'graph/cove': { graph } } } },
    scene: {
      settings: {
        purpose: 'sound',
        audio: { graphId: 'graph/cove', audioId: 'audio/cove', duration: 0.4, loop: true },
      },
    },
    cacheDirectory: 'C:\\studio-cache\\sound-preview',
    writeFile: (filePath, bytes) => { files.set(filePath, bytes); },
    audioFactory,
  });
  const started = runtime.enter({ loop: true });
  assert.equal(started.backend, 'html-audio');
  assert.equal(files.size, 1);
  const [filePath, bytes] = [...files.entries()][0];
  assert.match(filePath.replaceAll('\\', '/'), /graph-cove\.wav$/u);
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'RIFF');
  assert.equal(plays.length, 1);
  assert.equal(plays[0].loop, true);
  assert.ok(plays[0].source.includes('graph-cove.wav'));
  runtime.advance(0.5);
  assert.ok(runtime.elapsed < 0.4);
  runtime.pause();
  assert.equal(runtime.paused, true);
  runtime.resume();
  assert.equal(runtime.playing, true);
  runtime.stop();
  assert.equal(runtime.playing, false);
});
