import { validateGraph } from '../graphs/index.mjs';

export const AUDIO_LIMITS = Object.freeze({
  sampleRate: 22050,
  minDuration: 0.05,
  maxDuration: 16,
  spectrogramTimeBins: 48,
  spectrogramFreqBins: 24,
  envelopeSamples: 64,
  maxHarmonics: 8,
  minFrequency: 40,
  maxFrequency: 8000,
});

const TWO_PI = Math.PI * 2;
const NOTE_OFFSETS = Object.freeze({
  c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11,
});

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

const GLOTTAL_TP = 0.30;
const GLOTTAL_TE = 0.45;
const GLOTTAL_TA = 0.022;
const PULSE_OVERSAMPLE = 4;

function glottalFlowDerivative(phase) {
  const t = phase - Math.floor(phase);
  if (t < GLOTTAL_TE) {
    const opening = Math.sin((Math.PI * t) / GLOTTAL_TP);
    if (t <= GLOTTAL_TP) return opening;
    const closing = (t - GLOTTAL_TP) / (GLOTTAL_TE - GLOTTAL_TP);
    return opening * (1 - closing) - 1.25 * closing * closing;
  }
  const returned = (t - GLOTTAL_TE) / GLOTTAL_TA;
  if (returned < 10) return -2.45 * Math.exp(-returned);
  return 0;
}

function waveform(type, phase) {
  const wrapped = phase - Math.floor(phase);
  if (type === 'square') return wrapped < 0.5 ? 1 : -1;
  if (type === 'sawtooth') return wrapped * 2 - 1;
  if (type === 'triangle') return 1 - 4 * Math.abs(wrapped - 0.5);
  if (type === 'pulse') return glottalFlowDerivative(wrapped);
  return Math.sin(wrapped * TWO_PI);
}

export function midiToFrequency(midi) {
  return 440 * (2 ** ((midi - 69) / 12));
}

export function parseNoteName(source) {
  const match = String(source).trim().match(/^([a-g])([#b]?)(-?\d)$/iu);
  if (!match) fail('plainform_sound_note', `“${source}” is not a note name such as C4 or F#3.`);
  const letter = match[1].toLowerCase();
  const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0;
  const octave = Number(match[3]);
  return midiToFrequency(12 * (octave + 1) + NOTE_OFFSETS[letter] + accidental);
}

export function parseNotePattern(pattern) {
  const notes = String(pattern ?? '').trim().split(/[\s,]+/u).filter(Boolean);
  if (notes.length < 1 || notes.length > 32) fail('plainform_sound_sequence_limit', 'A sequence may contain 1 to 32 notes.');
  return notes.map(parseNoteName);
}

function seededRandom(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function noiseSample(color, random, brown) {
  const white = random() * 2 - 1;
  if (color === 'brown') {
    brown.value = clamp(brown.value + white * 0.02, -1, 1);
    return brown.value;
  }
  if (color === 'pink') {
    brown.b0 = 0.99765 * brown.b0 + white * 0.099046;
    brown.b1 = 0.963 * brown.b1 + white * 0.2965164;
    brown.b2 = 0.5703 * brown.b2 + white * 1.052691;
    return clamp((brown.b0 + brown.b1 + brown.b2 + white * 0.1848) * 0.05, -1, 1);
  }
  return white;
}

function adsrGain(time, attack, decay, sustain, release, startTime, hold) {
  const local = time - startTime;
  if (local < 0) return 0;
  if (local < attack) return attack <= 0 ? 1 : local / attack;
  const afterAttack = local - attack;
  if (afterAttack < decay) {
    const amount = decay <= 0 ? 1 : afterAttack / decay;
    return 1 - (1 - sustain) * amount;
  }
  const sustainEnd = attack + decay + hold;
  if (local < sustainEnd) return sustain;
  const afterRelease = local - sustainEnd;
  if (afterRelease >= release) return 0;
  return sustain * (1 - afterRelease / Math.max(release, 1e-6));
}

function biquadCoefficients(type, frequency, q, sampleRate) {
  const omega = TWO_PI * clamp(frequency, 40, sampleRate / 2 - 20) / sampleRate;
  const sin = Math.sin(omega);
  const cos = Math.cos(omega);
  const alpha = sin / (2 * Math.max(0.1, q));
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;
  if (type === 'highpass') {
    b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
    a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  } else if (type === 'bandpass') {
    b0 = alpha; b1 = 0; b2 = -alpha;
    a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  } else {
    b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
    a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function applyBiquad(input, type, frequency, q, sampleRate) {
  const coeff = biquadCoefficients(type, frequency, q, sampleRate);
  const output = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let index = 0; index < input.length; index += 1) {
    const x0 = input[index];
    const y0 = coeff.b0 * x0 + coeff.b1 * x1 + coeff.b2 * x2 - coeff.a1 * y1 - coeff.a2 * y2;
    output[index] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return output;
}

function applyResonator(input, frequency, bandwidth, sampleRate) {
  const hz = clamp(frequency, 40, sampleRate / 2 - 40);
  const bw = clamp(bandwidth, 40, 800);
  const radius = Math.exp(-Math.PI * bw / sampleRate);
  const a1 = 2 * radius * Math.cos(TWO_PI * hz / sampleRate);
  const a2 = -radius * radius;
  const gain = 1 - radius;
  const output = new Float32Array(input.length);
  let y1 = 0;
  let y2 = 0;
  for (let index = 0; index < input.length; index += 1) {
    const y0 = gain * input[index] + a1 * y1 + a2 * y2;
    output[index] = y0;
    y2 = y1;
    y1 = y0;
  }
  return output;
}

function emptyStereo(length) {
  return { left: new Float32Array(length), right: new Float32Array(length) };
}

function toStereo(value, length) {
  if (value?.left && value?.right) return value;
  const mono = value instanceof Float32Array ? value : new Float32Array(length);
  return { left: mono, right: Float32Array.from(mono) };
}

function scaleBuffer(buffer, gain) {
  const left = new Float32Array(buffer.left.length);
  const right = new Float32Array(buffer.right.length);
  for (let index = 0; index < buffer.left.length; index += 1) {
    left[index] = buffer.left[index] * gain;
    right[index] = buffer.right[index] * gain;
  }
  return { left, right };
}

function mixBuffers(a, b, amount = 1) {
  const left = new Float32Array(a.left.length);
  const right = new Float32Array(a.right.length);
  for (let index = 0; index < a.left.length; index += 1) {
    left[index] = a.left[index] + b.left[index] * amount;
    right[index] = a.right[index] + b.right[index] * amount;
  }
  return { left, right };
}

function incoming(graph, nodeId, port, values, length, fallback) {
  const edge = graph.edges.find(item => item.to.nodeId === nodeId && item.to.port === port);
  if (!edge) return fallback;
  return values.get(`${edge.from.nodeId}:${edge.from.port}`) ?? fallback;
}

function controlAt(control, index, fallback) {
  if (control instanceof Float32Array) return control[index] ?? fallback;
  return fallback;
}

function renderPulseVoice({
  length,
  sampleRate,
  frequencyAt,
  amplitudeAt,
  startIndex,
  endIndex,
  seed,
  startPhase = 0,
  into,
}) {
  const left = into ?? new Float32Array(length);
  const random = seededRandom(seed);
  const begin = Math.max(0, startIndex);
  const finish = Math.min(length, endIndex);
  let phase = startPhase;
  let cycleFreq = frequencyAt(begin);
  let cycleGain = 1;
  let dcPrev = 0;
  let dcOut = 0;
  let aspLow = 0;
  for (let index = begin; index < finish; index += 1) {
    const time = index / sampleRate;
    const base = clamp(frequencyAt(index, time), 16, AUDIO_LIMITS.maxFrequency);
    const amp = clamp(amplitudeAt(index, time), 0, 4);
    const flutter = 1 + 0.011 * Math.sin(TWO_PI * 11.6 * time) + 0.006 * Math.sin(TWO_PI * 4.8 * time);
    let acc = 0;
    for (let step = 0; step < PULSE_OVERSAMPLE; step += 1) {
      if (phase >= 1) {
        phase -= Math.floor(phase);
        cycleFreq = clamp(base * flutter * (1 + (random() - 0.5) * 0.014), 16, AUDIO_LIMITS.maxFrequency);
        cycleGain = 1 + (random() - 0.5) * 0.06;
      }
      const wrapped = phase - Math.floor(phase);
      const glottal = glottalFlowDerivative(wrapped) * cycleGain;
      const white = random() * 2 - 1;
      aspLow = aspLow * 0.82 + white * 0.18;
      const open = wrapped < GLOTTAL_TE;
      acc += glottal + (open ? (white - aspLow) * 0.055 : 0);
      phase += cycleFreq / (sampleRate * PULSE_OVERSAMPLE);
    }
    const avg = acc / PULSE_OVERSAMPLE;
    dcOut = avg - dcPrev + 0.995 * dcOut;
    dcPrev = avg;
    left[index] += dcOut * amp;
  }
  return left;
}

function renderOscillator({ length, sampleRate, waveformType, frequency, gain, startTime, frequencyControl, gainControl }) {
  const left = new Float32Array(length);
  const start = Math.max(0, Math.floor(startTime * sampleRate));
  if (waveformType === 'pulse') {
    renderPulseVoice({
      length,
      sampleRate,
      frequencyAt: index => clamp(controlAt(frequencyControl, index, frequency), 16, AUDIO_LIMITS.maxFrequency),
      amplitudeAt: index => clamp(controlAt(gainControl, index, gain), 0, 4),
      startIndex: start,
      endIndex: length,
      seed: Math.max(1, Math.round(frequency * 17)),
      into: left,
    });
    return { left, right: Float32Array.from(left) };
  }
  let phase = 0;
  for (let index = start; index < length; index += 1) {
    const freq = clamp(controlAt(frequencyControl, index, frequency), 16, AUDIO_LIMITS.maxFrequency);
    const amp = clamp(controlAt(gainControl, index, gain), 0, 4);
    left[index] = waveform(waveformType, phase) * amp;
    phase += freq / sampleRate;
  }
  return { left, right: Float32Array.from(left) };
}

function renderSequence({ length, sampleRate, notes, waveformType, noteDuration, gain, startTime }) {
  const left = new Float32Array(length);
  const spoken = waveformType === 'pulse';
  const attack = spoken ? 0.002 : 0.008;
  const decay = spoken ? 0.014 : 0.04;
  const release = Math.min(spoken ? 0.028 : 0.08, noteDuration * 0.28);
  const random = seededRandom(17);
  const brown = { value: 0, b0: 0, b1: 0, b2: 0 };
  for (let noteIndex = 0; noteIndex < notes.length; noteIndex += 1) {
    const noteStart = startTime + noteIndex * noteDuration;
    const begin = Math.max(0, Math.floor(noteStart * sampleRate));
    const end = Math.min(length, Math.floor((noteStart + noteDuration) * sampleRate));
    const hold = Math.max(0, noteDuration - attack - decay - release);
    const stressed = noteIndex % 4 === 0;
    if (spoken) {
      renderPulseVoice({
        length,
        sampleRate,
        frequencyAt: (index, time) => {
          const frac = (index - begin) / Math.max(1, end - begin);
          const contour = (stressed ? 1.04 : 1) * (1 + 0.035 * Math.sin(Math.PI * Math.min(1, frac * 1.2)) - 0.05 * frac);
          return notes[noteIndex] * contour;
        },
        amplitudeAt: (index, time) => {
          const env = adsrGain(time, attack, decay, stressed ? 0.94 : 0.84, release, noteStart, hold);
          return gain * env;
        },
        startIndex: begin,
        endIndex: end,
        seed: 31 + noteIndex * 13,
        startPhase: stressed ? GLOTTAL_TE : 0,
        into: left,
      });
      const burstEnd = Math.min(end, begin + Math.floor((stressed ? 0.012 : 0.008) * sampleRate));
      let burstLow = 0;
      for (let index = begin; index < burstEnd; index += 1) {
        const remain = 1 - ((index - begin) / Math.max(1, burstEnd - begin));
        const white = noiseSample('white', random, brown);
        burstLow = burstLow * 0.7 + white * 0.3;
        const treble = white - burstLow;
        const mix = noteIndex % 2 === 0 ? treble * 0.72 + burstLow * 0.12 : burstLow * 0.55 + treble * 0.22;
        left[index] += mix * gain * remain * remain * (stressed ? 0.7 : 0.48);
      }
      continue;
    }
    let phase = 0;
    for (let index = begin; index < end; index += 1) {
      const time = index / sampleRate;
      const env = adsrGain(time, attack, decay, 0.75, release, noteStart, hold);
      left[index] += waveform(waveformType, phase) * gain * env;
      phase += notes[noteIndex] / sampleRate;
    }
  }
  return { left, right: Float32Array.from(left) };
}

function formantBandwidth(frequency, q, scale) {
  return clamp(frequency / Math.max(3, q * scale), 80, 420);
}

function preEmphasis(input, coeff = 0.88) {
  const output = new Float32Array(input.length);
  let previous = 0;
  for (let index = 0; index < input.length; index += 1) {
    output[index] = input[index] - coeff * previous;
    previous = input[index];
  }
  return output;
}

function applyFormantChannel(input, f1, f2, f3, q, dry, sampleRate) {
  const wet = 1 - clamp(dry, 0, 1);
  const highpassed = applyBiquad(input, 'highpass', 120, 0.7, sampleRate);
  const source = preEmphasis(highpassed, 0.88);
  const body = applyResonator(
    applyResonator(source, f1, formantBandwidth(f1, q, 0.72), sampleRate),
    f2,
    formantBandwidth(f2, q, 0.9),
    sampleRate,
  );
  const third = applyResonator(source, f3, formantBandwidth(f3, q, 0.7), sampleRate);
  const fourth = applyResonator(source, 3500, 260, sampleRate);
  const nasal = applyResonator(source, 270, 120, sampleRate);
  const brightness = applyBiquad(source, 'highpass', 2200, 0.5, sampleRate);
  const output = new Float32Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const tract = body[index] * 0.92 + third[index] * 0.55 + fourth[index] * 0.32 + nasal[index] * 0.08 + brightness[index] * 0.12;
    output[index] = input[index] * dry * 0.22 + tract * wet * 7.4;
  }
  return output;
}

function applyFormant(buffer, f1, f2, f3, q, dry, sampleRate) {
  return {
    left: applyFormantChannel(buffer.left, f1, f2, f3, q, dry, sampleRate),
    right: applyFormantChannel(buffer.right, f1, f2, f3, q, dry, sampleRate),
  };
}

function applyDelay(buffer, time, feedback, mix, sampleRate) {
  const delaySamples = Math.max(1, Math.min(sampleRate, Math.round(time * sampleRate)));
  const left = new Float32Array(buffer.left.length);
  const right = new Float32Array(buffer.right.length);
  for (let index = 0; index < buffer.left.length; index += 1) {
    const delayedLeft = index >= delaySamples ? left[index - delaySamples] : 0;
    const delayedRight = index >= delaySamples ? right[index - delaySamples] : 0;
    left[index] = buffer.left[index] + delayedLeft * feedback;
    right[index] = buffer.right[index] + delayedRight * feedback;
  }
  const wetLeft = new Float32Array(left.length);
  const wetRight = new Float32Array(right.length);
  for (let index = 0; index < left.length; index += 1) {
    wetLeft[index] = buffer.left[index] * (1 - mix) + left[index] * mix;
    wetRight[index] = buffer.right[index] * (1 - mix) + right[index] * mix;
  }
  return { left: wetLeft, right: wetRight };
}

function hann(index, size) {
  return 0.5 - 0.5 * Math.cos((TWO_PI * index) / Math.max(1, size - 1));
}

function dftMagnitude(samples, frequency, sampleRate) {
  let real = 0;
  let imag = 0;
  const omega = TWO_PI * frequency / sampleRate;
  for (let index = 0; index < samples.length; index += 1) {
    const windowed = samples[index] * hann(index, samples.length);
    real += windowed * Math.cos(omega * index);
    imag -= windowed * Math.sin(omega * index);
  }
  return Math.hypot(real, imag) / samples.length;
}

export function analyseAudioBuffers(left, right, sampleRate) {
  const length = left.length;
  const duration = length / sampleRate;
  let peak = 0;
  let sumSquares = 0;
  let leftPower = 0;
  let rightPower = 0;
  const envelope = [];
  const envelopeStep = Math.max(1, Math.floor(length / AUDIO_LIMITS.envelopeSamples));
  for (let index = 0; index < length; index += 1) {
    const sample = Math.max(Math.abs(left[index]), Math.abs(right[index]));
    peak = Math.max(peak, sample);
    sumSquares += left[index] * left[index] + right[index] * right[index];
    leftPower += left[index] * left[index];
    rightPower += right[index] * right[index];
  }
  for (let bin = 0; bin < AUDIO_LIMITS.envelopeSamples; bin += 1) {
    const start = bin * envelopeStep;
    const end = Math.min(length, start + envelopeStep);
    let energy = 0;
    for (let index = start; index < end; index += 1) energy += left[index] * left[index] + right[index] * right[index];
    envelope.push(Math.sqrt(energy / Math.max(1, (end - start) * 2)));
  }
  const timeBins = AUDIO_LIMITS.spectrogramTimeBins;
  const freqBins = AUDIO_LIMITS.spectrogramFreqBins;
  const hop = Math.max(1, Math.floor(length / timeBins));
  const windowSize = Math.min(512, Math.max(64, hop * 2));
  const spectrogram = [];
  const minLog = Math.log(AUDIO_LIMITS.minFrequency);
  const maxLog = Math.log(AUDIO_LIMITS.maxFrequency);
  for (let time = 0; time < timeBins; time += 1) {
    const start = Math.min(length - 1, time * hop);
    const slice = new Float32Array(windowSize);
    for (let index = 0; index < windowSize; index += 1) {
      const sampleIndex = Math.min(length - 1, start + index);
      slice[index] = (left[sampleIndex] + right[sampleIndex]) * 0.5;
    }
    const row = [];
    for (let freq = 0; freq < freqBins; freq += 1) {
      const ratio = freq / Math.max(1, freqBins - 1);
      const frequency = Math.exp(minLog + (maxLog - minLog) * ratio);
      row.push(dftMagnitude(slice, frequency, sampleRate));
    }
    spectrogram.push(row);
  }
  const mixWindow = new Float32Array(Math.min(length, sampleRate));
  for (let index = 0; index < mixWindow.length; index += 1) mixWindow[index] = (left[index] + right[index]) * 0.5;
  const harmonics = [];
  for (let partial = 1; partial <= AUDIO_LIMITS.maxHarmonics; partial += 1) {
    const frequency = 110 * partial;
    if (frequency > AUDIO_LIMITS.maxFrequency) break;
    harmonics.push({
      partial,
      frequency,
      magnitude: dftMagnitude(mixWindow, frequency, sampleRate),
    });
  }
  const spectralSum = spectrogram.reduce((sum, row) => sum + row.reduce((inner, value) => inner + value, 0), 0);
  let centroidAcc = 0;
  spectrogram.forEach((row) => {
    row.forEach((value, freqIndex) => {
      const ratio = freqIndex / Math.max(1, freqBins - 1);
      centroidAcc += value * Math.exp(minLog + (maxLog - minLog) * ratio);
    });
  });
  const rms = Math.sqrt(sumSquares / Math.max(1, length * 2));
  return {
    duration,
    sampleRate,
    peak,
    rms,
    peakDecibels: peak <= 1e-9 ? -120 : 20 * Math.log10(peak),
    rmsDecibels: rms <= 1e-9 ? -120 : 20 * Math.log10(rms),
    stereoBalance: (rightPower - leftPower) / Math.max(1e-9, leftPower + rightPower),
    centroidHz: spectralSum > 0 ? centroidAcc / spectralSum : 0,
    envelope,
    spectrogram,
    harmonics,
  };
}

export function evaluateAudioGraph(rawGraph, options = {}) {
  const validation = validateGraph(rawGraph);
  if (!validation.valid) fail('plainform_sound_graph_invalid', validation.errors[0]?.message ?? 'The audio graph is invalid.', { errors: validation.errors });
  const graph = validation.graph;
  const sampleRate = options.sampleRate ?? graph.settings?.sampleRate ?? AUDIO_LIMITS.sampleRate;
  const duration = clamp(options.duration ?? graph.settings?.duration ?? 2, AUDIO_LIMITS.minDuration, AUDIO_LIMITS.maxDuration);
  const length = Math.max(1, Math.round(duration * sampleRate));
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const incomingCount = new Map(graph.nodes.map(node => [node.id, 0]));
  for (const edge of graph.edges) incomingCount.set(edge.to.nodeId, (incomingCount.get(edge.to.nodeId) ?? 0) + 1);
  const queue = graph.nodes.filter(node => (incomingCount.get(node.id) ?? 0) === 0).map(node => node.id);
  const values = new Map();
  const visited = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodes.get(id);
    const params = node.params ?? {};
    let rendered;
    if (node.type === 'audio.oscillator') {
      rendered = renderOscillator({
        length, sampleRate,
        waveformType: params.waveform ?? 'sine',
        frequency: params.frequency ?? 440,
        gain: params.gain ?? 0.2,
        startTime: params.startTime ?? 0,
        frequencyControl: incoming(graph, id, 'frequency', values, length, null),
        gainControl: incoming(graph, id, 'gain', values, length, null),
      });
    } else if (node.type === 'audio.noise') {
      const random = seededRandom(params.seed ?? 1);
      const brown = { value: 0, b0: 0, b1: 0, b2: 0 };
      const left = new Float32Array(length);
      const gainControl = incoming(graph, id, 'gain', values, length, null);
      const gain = params.gain ?? 0.12;
      for (let index = 0; index < length; index += 1) {
        left[index] = noiseSample(params.color ?? 'white', random, brown) * controlAt(gainControl, index, gain);
      }
      rendered = { left, right: Float32Array.from(left) };
    } else if (node.type === 'audio.sequence') {
      rendered = renderSequence({
        length, sampleRate,
        notes: parseNotePattern(params.pattern ?? 'C4'),
        waveformType: params.waveform ?? 'sine',
        noteDuration: params.noteDuration ?? 0.5,
        gain: params.gain ?? 0.22,
        startTime: params.startTime ?? 0,
      });
    } else if (node.type === 'audio.lfo') {
      const control = new Float32Array(length);
      const frequency = params.frequency ?? 4;
      const depth = params.depth ?? 1;
      const offset = params.offset ?? 0;
      for (let index = 0; index < length; index += 1) {
        control[index] = offset + waveform(params.waveform ?? 'sine', (index * frequency) / sampleRate) * depth;
      }
      values.set(`${id}:value`, control);
      for (const edge of graph.edges) if (edge.from.nodeId === id) {
        incomingCount.set(edge.to.nodeId, incomingCount.get(edge.to.nodeId) - 1);
        if (incomingCount.get(edge.to.nodeId) === 0) queue.push(edge.to.nodeId);
      }
      continue;
    } else if (node.type === 'audio.adsr') {
      const source = toStereo(incoming(graph, id, 'audio', values, length, emptyStereo(length)), length);
      const left = new Float32Array(length);
      const right = new Float32Array(length);
      for (let index = 0; index < length; index += 1) {
        const env = adsrGain(
          index / sampleRate,
          params.attack ?? 0.01,
          params.decay ?? 0.12,
          params.sustain ?? 0.7,
          params.release ?? 0.2,
          params.startTime ?? 0,
          params.hold ?? 0,
        );
        left[index] = source.left[index] * env;
        right[index] = source.right[index] * env;
      }
      rendered = { left, right };
    } else if (node.type === 'audio.gain') {
      const source = toStereo(incoming(graph, id, 'audio', values, length, emptyStereo(length)), length);
      const gainControl = incoming(graph, id, 'gain', values, length, null);
      const gain = params.gain ?? 1;
      const left = new Float32Array(length);
      const right = new Float32Array(length);
      for (let index = 0; index < length; index += 1) {
        const amount = controlAt(gainControl, index, gain);
        left[index] = source.left[index] * amount;
        right[index] = source.right[index] * amount;
      }
      rendered = { left, right };
    } else if (node.type === 'audio.sum') {
      rendered = mixBuffers(
        toStereo(incoming(graph, id, 'a', values, length, emptyStereo(length)), length),
        toStereo(incoming(graph, id, 'b', values, length, emptyStereo(length)), length),
        1,
      );
    } else if (node.type === 'audio.mix') {
      const mix = params.mix ?? 0.5;
      const a = toStereo(incoming(graph, id, 'a', values, length, emptyStereo(length)), length);
      const b = toStereo(incoming(graph, id, 'b', values, length, emptyStereo(length)), length);
      const left = new Float32Array(length);
      const right = new Float32Array(length);
      for (let index = 0; index < length; index += 1) {
        left[index] = a.left[index] * (1 - mix) + b.left[index] * mix;
        right[index] = a.right[index] * (1 - mix) + b.right[index] * mix;
      }
      rendered = { left, right };
    } else if (node.type === 'audio.filter') {
      const source = toStereo(incoming(graph, id, 'audio', values, length, emptyStereo(length)), length);
      const frequency = params.frequency ?? 1200;
      rendered = {
        left: applyBiquad(source.left, params.type ?? 'lowpass', frequency, params.q ?? 0.7, sampleRate),
        right: applyBiquad(source.right, params.type ?? 'lowpass', frequency, params.q ?? 0.7, sampleRate),
      };
    } else if (node.type === 'audio.formant') {
      const source = toStereo(incoming(graph, id, 'audio', values, length, emptyStereo(length)), length);
      rendered = applyFormant(
        source,
        params.f1 ?? 700,
        params.f2 ?? 1200,
        params.f3 ?? 2500,
        params.q ?? 6,
        params.dry ?? 0.12,
        sampleRate,
      );
    } else if (node.type === 'audio.delay') {
      rendered = applyDelay(
        toStereo(incoming(graph, id, 'audio', values, length, emptyStereo(length)), length),
        params.time ?? 0.18,
        params.feedback ?? 0.25,
        params.mix ?? 0.2,
        sampleRate,
      );
    } else if (node.type === 'audio.saturate') {
      const source = toStereo(incoming(graph, id, 'audio', values, length, emptyStereo(length)), length);
      const drive = params.drive ?? 1.4;
      const left = new Float32Array(length);
      const right = new Float32Array(length);
      const norm = Math.tanh(drive) || 1;
      for (let index = 0; index < length; index += 1) {
        const drivenLeft = source.left[index] * drive;
        const drivenRight = source.right[index] * drive;
        left[index] = Math.tanh(drivenLeft + 0.1 * drivenLeft * drivenLeft) / norm;
        right[index] = Math.tanh(drivenRight + 0.1 * drivenRight * drivenRight) / norm;
      }
      rendered = { left, right };
    } else if (node.type === 'audio.pan') {
      const source = toStereo(incoming(graph, id, 'audio', values, length, emptyStereo(length)), length);
      const pan = clamp(params.pan ?? 0, -1, 1);
      const leftGain = Math.cos((pan + 1) * 0.25 * Math.PI);
      const rightGain = Math.sin((pan + 1) * 0.25 * Math.PI);
      rendered = scaleBuffer({
        left: Float32Array.from(source.left, sample => sample * leftGain),
        right: Float32Array.from(source.right, sample => sample * rightGain),
      }, 1);
    } else if (node.type === 'audio.panner') {
      const source = toStereo(incoming(graph, id, 'audio', values, length, emptyStereo(length)), length);
      const x = params.x ?? 0;
      const y = params.y ?? 0;
      const z = params.z ?? 0;
      const distance = Math.hypot(x, y, z);
      const gain = 1 / (1 + distance);
      const pan = clamp(x / 4, -1, 1);
      const leftGain = Math.cos((pan + 1) * 0.25 * Math.PI) * gain;
      const rightGain = Math.sin((pan + 1) * 0.25 * Math.PI) * gain;
      rendered = {
        left: Float32Array.from(source.left, sample => sample * leftGain),
        right: Float32Array.from(source.right, sample => sample * rightGain),
      };
    } else {
      fail('plainform_sound_node_unsupported', `Audio evaluator does not implement ${node.type}.`);
    }
    values.set(`${id}:audio`, rendered);
    for (const edge of graph.edges) if (edge.from.nodeId === id) {
      incomingCount.set(edge.to.nodeId, incomingCount.get(edge.to.nodeId) - 1);
      if (incomingCount.get(edge.to.nodeId) === 0) queue.push(edge.to.nodeId);
    }
  }
  const outputRef = graph.outputs?.mix;
  if (!outputRef) fail('plainform_sound_output_required', 'Audio graphs require a mix output.');
  const mix = toStereo(values.get(`${outputRef.nodeId}:${outputRef.port}`) ?? emptyStereo(length), length);
  const analysis = analyseAudioBuffers(mix.left, mix.right, sampleRate);
  return Object.freeze({
    sampleRate,
    duration,
    channels: 2,
    left: mix.left,
    right: mix.right,
    digest: Object.freeze({
      duration: analysis.duration,
      sampleRate,
      peak: analysis.peak,
      rms: analysis.rms,
      peakDecibels: analysis.peakDecibels,
      rmsDecibels: analysis.rmsDecibels,
      stereoBalance: analysis.stereoBalance,
      centroidHz: analysis.centroidHz,
    }),
    envelope: Object.freeze(analysis.envelope),
    spectrogram: analysis.spectrogram.map(row => Object.freeze([...row])),
    harmonics: Object.freeze(analysis.harmonics.map(item => Object.freeze({ ...item }))),
  });
}
