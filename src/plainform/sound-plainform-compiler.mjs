import { evaluateDesignExpression } from './design-expression.mjs';
import { interpretSoundFeel } from './sound-feel-vocabulary.mjs';
import { parsePlainformProgram } from './plainform-front-end.mjs';
import { validateGraph } from '../graphs/index.mjs';
import { GRAPH_CATALOGS } from '../graphs/catalogs.mjs';
import { AUDIO_LIMITS, evaluateAudioGraph, parseNotePattern } from '../audio/audio-graph-evaluator.mjs';
import { buildSoundVisualization } from '../audio/audio-visualization.mjs';

const MAX_STATEMENTS = 256;
const MAX_LOOP_ITERATIONS = 128;
const MAX_VOICES = 16;

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details ?? {};
  throw error;
}

function clean(value) {
  return String(value ?? '').trim().replace(/[.:;]+$/u, '').trim();
}

function key(value) {
  return clean(value).toLowerCase().replace(/^(?:the|a|an)\s+/u, '').replace(/\s+/gu, ' ');
}

function slug(value) {
  return key(value).replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'sound';
}

const VOWEL_FORMANTS = Object.freeze({
  ah: [730, 1090, 2440],
  eh: [530, 1840, 2480],
  ee: [270, 2290, 3010],
  oo: [300, 870, 2240],
  ih: [390, 1990, 2550],
  uh: [640, 1190, 2390],
  oh: [570, 840, 2410],
  ae: [660, 1720, 2410],
});

function quoteName(value) {
  return clean(value).replace(/^"|"$/gu, '');
}

function quantity(value, dimension = 'scalar') {
  return Object.freeze({ value, dimension });
}

function expectDimension(result, dimensions, phrase) {
  const allowed = Array.isArray(dimensions) ? dimensions : [dimensions];
  if (!allowed.includes(result.dimension) && !(result.dimension === 'scalar' && result.value === 0)) {
    fail('plainform_dimension_mismatch', `${phrase} must be ${allowed.join(' or ')}, received ${result.dimension}.`);
  }
  return result;
}

function toSeconds(result, tempo, phrase) {
  if (result.dimension === 'time') return result.value;
  if (result.dimension === 'beats') return result.value * 60 / Math.max(1, tempo);
  if (result.dimension === 'scalar') fail('plainform_dimension_mismatch', `${phrase} needs an explicit time unit such as seconds or milliseconds.`);
  fail('plainform_dimension_mismatch', `${phrase} must be time, received ${result.dimension}.`);
}

class AudioGraphBuilder {
  constructor(graphId, name) {
    this.catalog = GRAPH_CATALOGS.audio;
    this.graph = { formatVersion: 1, id: graphId, domain: 'audio', nodes: [], edges: [], outputs: {}, settings: { sampleRate: AUDIO_LIMITS.sampleRate, duration: 2, channels: 2 } };
    this.name = name;
    this.sequence = 0;
  }

  node(type, params = {}, hint = type) {
    if (!this.catalog.nodes[type]) fail('plainform_sound_node_unavailable', `The audio catalog does not provide ${type}.`);
    if (this.graph.nodes.length >= 128) fail('plainform_sound_node_limit', 'Sound Plainform is limited to 128 audio nodes.');
    const id = `${slug(hint).slice(0, 36)}-${String(++this.sequence).padStart(3, '0')}`;
    this.graph.nodes.push({ id, type, params });
    return id;
  }

  connect(fromId, fromPort, toId, toPort) {
    this.graph.edges.push({ from: { nodeId: fromId, port: fromPort }, to: { nodeId: toId, port: toPort } });
  }

  setDuration(duration) {
    this.graph.settings.duration = duration;
  }
}

function splitStatements(source) {
  return source.split(/\r?\n/u).map(clean).filter(Boolean);
}

function parseOffsetClause(source, variables) {
  const position = [0, 0, 0];
  const pattern = /(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?(?:\s+(?:millimetres?|centimetres?|metres?|meters?|milliseconds?|seconds?|hertz|beats?))?)\s+(right|left|up|down|forward|backward)(?: of the listener)?/giu;
  let matched = false;
  for (const match of source.matchAll(pattern)) {
    matched = true;
    const amount = evaluateDesignExpression(match[1], variables);
    const metres = amount.dimension === 'length' ? amount.value : amount.dimension === 'scalar' ? amount.value : fail('plainform_dimension_mismatch', 'Placement offsets must be lengths.');
    const axis = match[2].toLowerCase();
    if (axis === 'right') position[0] += metres;
    else if (axis === 'left') position[0] -= metres;
    else if (axis === 'up') position[1] += metres;
    else if (axis === 'down') position[1] -= metres;
    else if (axis === 'forward') position[2] += metres;
    else position[2] -= metres;
  }
  return { matched, position };
}

function chainSum(builder, nodeIds) {
  if (nodeIds.length === 0) fail('plainform_sound_source_required', 'A sound needs at least one oscillator, noise, or sequence.');
  if (nodeIds.length === 1) return nodeIds[0];
  let current = nodeIds[0];
  for (let index = 1; index < nodeIds.length; index += 1) {
    const mixId = builder.node('audio.sum', {}, `sum-${index}`);
    builder.connect(current, 'audio', mixId, 'a');
    builder.connect(nodeIds[index], 'audio', mixId, 'b');
    current = mixId;
  }
  return current;
}

function ownedSound(project, audioId) {
  const resource = project?.resources?.audio?.[audioId];
  if (resource && resource.metadata?.plainform?.kind !== 'sound') {
    fail('plainform_sound_ownership_conflict', `Audio ${audioId} exists and is not owned by Sound Plainform.`);
  }
  return resource ?? null;
}

export class SoundPlainformCompiler {
  compile(source, { project } = {}) {
    if (!project) fail('plainform_project_required', 'Sound Plainform requires the canonical project document.');
    const ast = parsePlainformProgram(source);
    const rawLines = splitStatements(source);
    if (rawLines.length < 1 || rawLines.length > MAX_STATEMENTS) fail('plainform_statement_limit', `Sound Plainform accepts 1 to ${MAX_STATEMENTS} statements.`);

    let requestedPreview = false;
    const interpretation = [];
    const feelPhrases = [];
    const variables = new Map();
    let tempo = 120;
    let duration = null;
    let loop = false;
    let peakLimitDb = null;
    let frameLens = 50;
    let frameAngle = 'slightly above';
    let playOnStart = true;
    const voices = [];
    const groups = [];
    const constraints = [];

    const headerLine = rawLines[0];
    const continueHeader = headerLine.match(/^continue the sound ([a-z0-9][a-z0-9._/-]*)$/iu);
    const sceneHeader = headerLine.match(/^create (?:a |an )?sound scene called (?:(?:"([^"]+)")|(.+?))(?: with id ([a-z0-9][a-z0-9._/-]*))?$/iu);
    const designHeader = headerLine.match(/^(?:begin\s+)?design a sound called (?:(?:"([^"]+)")|(.+?)) with id ([a-z0-9][a-z0-9._/-]*)(?: in scene ([a-z0-9][a-z0-9._/-]*))?(?: using the right-up-forward design frame)?$/iu);
    const graphHeader = headerLine.match(/^create (?:a |an )?sound graph called (?:(?:"([^"]+)")|(.+?))(?: with id ([a-z0-9][a-z0-9._/-]*))?$/iu);
    if (!continueHeader && !sceneHeader && !designHeader && !graphHeader) {
      fail('plainform_sound_header', 'Begin with “Design a sound called … with id audio/…”, “Create a sound scene called …”, “Create a sound graph called …”, or “Continue the sound audio/…”');
    }

    let name;
    let audioId;
    let sceneId;
    let continuing = false;
    if (continueHeader) {
      continuing = true;
      audioId = continueHeader[1];
      const existing = ownedSound(project, audioId);
      if (!existing) fail('plainform_continue_not_found', `Cannot continue missing sound ${audioId}.`);
      name = existing.name;
      sceneId = existing.metadata?.plainform?.sceneId ?? project.activeSceneId;
    } else if (sceneHeader) {
      name = quoteName(sceneHeader[1] ?? sceneHeader[2]);
      sceneId = sceneHeader[3] ?? `scene/${slug(name)}`;
      audioId = `audio/${slug(name)}`;
    } else if (designHeader) {
      name = quoteName(designHeader[1] ?? designHeader[2]);
      audioId = designHeader[3];
      sceneId = designHeader[4] ?? `scene/${slug(name)}`;
    } else {
      name = quoteName(graphHeader[1] ?? graphHeader[2]);
      audioId = `audio/${slug(name)}`;
      sceneId = graphHeader[3]?.startsWith('scene/') ? graphHeader[3] : `scene/${slug(name)}`;
    }
    const graphId = `graph/${slug(name)}`;
    const soundSlug = slug(name);
    if (designHeader || graphHeader || continueHeader) interpretation.push(continuing ? `Continue sound ${audioId}.` : `Create sound “${name}” as ${audioId}.`);
    if (sceneHeader) interpretation.push(`Create sound scene ${sceneId}.`);
    interpretation.push('Will use the semantic right/up/forward frame for spatial sources and the 3D sound visualization.');

    const bodyLines = rawLines.slice(1).filter(line => !/^(?:show me a preview|preview these changes|preview this sound)$/iu.test(line));
    if (rawLines.some(line => /^(?:show me a preview|preview these changes|preview this sound)$/iu.test(line))) {
      requestedPreview = true;
      interpretation.push('Requested a dry-run preview.');
    }

    const applyStatement = (statement, scope) => {
      const letMatch = statement.match(/^let (.+?) be (.+)$/iu);
      if (letMatch) {
        const result = evaluateDesignExpression(letMatch[2], scope);
        scope.set(key(letMatch[1]), result);
        if (key(letMatch[1]) === 'tempo' && result.dimension === 'tempo') tempo = result.value;
        if (key(letMatch[1]) === 'duration') duration = toSeconds(result, tempo, 'Duration');
        interpretation.push(`Define ${key(letMatch[1])} as ${result.value} ${result.dimension}.`);
        return;
      }
      const feel = statement.match(/^(?:make it feel|describe it as|the sound should feel) (.+)$/iu);
      if (feel) { feelPhrases.push(feel[1]); interpretation.push(`Interpret sound feel: ${feel[1]}.`); return; }
      const oscillator = statement.match(/^create an? (sine|triangle|sawtooth|square|pulse) oscillator called (.+?) at (.+?)(?:, volume ([^,]+))?(?:, starting at (.+))?$/iu);
      if (oscillator) {
        const frequency = expectDimension(evaluateDesignExpression(oscillator[3], scope), ['frequency', 'scalar'], 'Oscillator frequency');
        const hz = frequency.dimension === 'frequency' ? frequency.value : frequency.value;
        if (hz < 16 || hz > AUDIO_LIMITS.maxFrequency) fail('plainform_sound_frequency', 'Oscillator frequency must be from 16 to 8000 hertz.');
        const volume = oscillator[4] ? expectDimension(evaluateDesignExpression(oscillator[4], scope), 'scalar', 'Volume').value : 0.2;
        const startTime = oscillator[5] ? toSeconds(evaluateDesignExpression(oscillator[5], scope), tempo, 'Start time') : 0;
        voices.push({
          kind: 'oscillator',
          name: quoteName(oscillator[2]),
          slug: slug(oscillator[2]),
          waveform: oscillator[1].toLowerCase(),
          frequency: hz,
          volume: Math.min(1, Math.max(0, volume)),
          startTime,
          position: [0, 0, 0],
        });
        interpretation.push(`Create ${oscillator[1].toLowerCase()} oscillator ${quoteName(oscillator[2])} at ${hz} hertz.`);
        return;
      }
      const noise = statement.match(/^create (white|pink|brown) noise called (.+?)(?:, volume ([^,]+))?$/iu);
      if (noise) {
        const volume = noise[3] ? expectDimension(evaluateDesignExpression(noise[3], scope), 'scalar', 'Volume').value : 0.12;
        voices.push({
          kind: 'noise',
          name: quoteName(noise[2]),
          slug: slug(noise[2]),
          color: noise[1].toLowerCase(),
          volume: Math.min(1, Math.max(0, volume)),
          position: [0, 0, 0],
        });
        interpretation.push(`Create ${noise[1].toLowerCase()} noise ${quoteName(noise[2])}.`);
        return;
      }
      const sequence = statement.match(/^sequence (.+?) as (.+?), one note per (beat|second)s?$/iu);
      if (sequence) {
        const voice = voices.find(item => key(item.name) === key(sequence[1]) || item.slug === slug(sequence[1]));
        if (!voice || voice.kind !== 'oscillator') fail('plainform_sound_sequence_target', `Sequence target “${sequence[1]}” must be an oscillator created in this program.`);
        const notes = parseNotePattern(sequence[2]);
        const noteDuration = sequence[3].toLowerCase().startsWith('beat') ? 60 / tempo : 1;
        voice.sequence = { pattern: sequence[2], notes, noteDuration };
        duration = Math.max(duration ?? 0, notes.length * noteDuration + 0.2);
        interpretation.push(`Sequence ${voice.name} as ${notes.length} notes.`);
        return;
      }
      const shape = statement.match(/^shape (.+?) with attack ([^,]+), decay ([^,]+), sustain ([^,]+), release ([^,]+)(?:, hold (.+))?$/iu);
      if (shape) {
        const voice = voices.find(item => key(item.name) === key(shape[1]) || item.slug === slug(shape[1]));
        if (!voice) fail('plainform_sound_unknown_voice', `Unknown sound voice “${shape[1]}”.`);
        voice.envelope = {
          attack: toSeconds(evaluateDesignExpression(shape[2], scope), tempo, 'Attack'),
          decay: toSeconds(evaluateDesignExpression(shape[3], scope), tempo, 'Decay'),
          sustain: expectDimension(evaluateDesignExpression(shape[4], scope), 'scalar', 'Sustain').value,
          release: toSeconds(evaluateDesignExpression(shape[5], scope), tempo, 'Release'),
          ...(shape[6] ? { hold: toSeconds(evaluateDesignExpression(shape[6], scope), tempo, 'Hold') } : {}),
        };
        interpretation.push(`Shape ${voice.name} with ADSR.`);
        return;
      }
      const filter = statement.match(/^filter (.+?) with an? (low-pass|high-pass|band-pass|lowpass|highpass|bandpass) at (.+?)(?:, resonance (.+))?$/iu);
      if (filter) {
        const voice = voices.find(item => key(item.name) === key(filter[1]) || item.slug === slug(filter[1]));
        if (!voice) fail('plainform_sound_unknown_voice', `Unknown sound voice “${filter[1]}”.`);
        const frequency = expectDimension(evaluateDesignExpression(filter[3], scope), ['frequency', 'scalar'], 'Filter frequency');
        voice.filter = {
          type: filter[2].toLowerCase().replaceAll('-', ''),
          frequency: frequency.dimension === 'frequency' ? frequency.value : frequency.value,
          q: filter[4] ? expectDimension(evaluateDesignExpression(filter[4], scope), 'scalar', 'Resonance').value : 0.7,
        };
        interpretation.push(`Filter ${voice.name}.`);
        return;
      }
      const formantVowel = statement.match(/^(?:give|formant) (.+?) (?:a vocal tract as|formants as|as) (ah|eh|ee|oo|ih|uh|oh|ae)$/iu);
      if (formantVowel) {
        const voice = voices.find(item => key(item.name) === key(formantVowel[1]) || item.slug === slug(formantVowel[1]));
        if (!voice) fail('plainform_sound_unknown_voice', `Unknown sound voice “${formantVowel[1]}”.`);
        const [f1, f2, f3] = VOWEL_FORMANTS[formantVowel[2].toLowerCase()];
        voice.formant = { f1, f2, f3, q: 9.2, dry: 0.05 };
        interpretation.push(`Formant ${voice.name} as ${formantVowel[2].toLowerCase()}.`);
        return;
      }
      const formantHz = statement.match(/^give (.+?) a vocal tract with formants (.+?), (.+?) and (.+)$/iu);
      if (formantHz) {
        const voice = voices.find(item => key(item.name) === key(formantHz[1]) || item.slug === slug(formantHz[1]));
        if (!voice) fail('plainform_sound_unknown_voice', `Unknown sound voice “${formantHz[1]}”.`);
        const f1 = expectDimension(evaluateDesignExpression(formantHz[2], scope), ['frequency', 'scalar'], 'F1').value;
        const f2 = expectDimension(evaluateDesignExpression(formantHz[3], scope), ['frequency', 'scalar'], 'F2').value;
        const f3 = expectDimension(evaluateDesignExpression(formantHz[4], scope), ['frequency', 'scalar'], 'F3').value;
        voice.formant = { f1, f2, f3, q: 9.2, dry: 0.05 };
        interpretation.push(`Formant ${voice.name} with ${f1}, ${f2}, ${f3} hertz.`);
        return;
      }
      const harmonic = statement.match(/^add an? (?:quiet )?harmonic(?: to (.+?))? at (.+?) times (.+?) frequency(?:, volume (.+))?$/iu);
      if (harmonic) {
        const targetName = harmonic[1] ?? harmonic[3];
        const ratioSource = harmonic[2];
        const volumeSource = harmonic[4];
        const voice = voices.find(item => key(item.name) === key(targetName) || item.slug === slug(targetName));
        if (!voice || !voice.frequency) fail('plainform_sound_harmonic_target', 'Harmonics require an oscillator with a frequency.');
        const ratio = expectDimension(evaluateDesignExpression(ratioSource, scope), 'scalar', 'Harmonic ratio').value;
        voice.harmonics = voice.harmonics ?? [];
        voice.harmonics.push({
          ratio,
          volume: volumeSource ? expectDimension(evaluateDesignExpression(volumeSource, scope), 'scalar', 'Volume').value : 0.12,
        });
        interpretation.push(`Add harmonic ${ratio}× to ${voice.name}.`);
        return;
      }
      const place = statement.match(/^place (.+?) ((?:-?\d|\bat\b).+)$/iu);
      if (place) {
        const voice = voices.find(item => key(item.name) === key(place[1]) || item.slug === slug(place[1]));
        if (!voice) fail('plainform_sound_unknown_voice', `Unknown sound voice “${place[1]}”.`);
        const vector = place[2].trim().match(/^at (\[.+\])$/iu);
        if (vector) {
          const parts = vector[1].slice(1, -1).split(',').map(part => part.trim());
          if (parts.length !== 3) fail('plainform_vector_expected', 'Placement vectors must contain three values.');
          const parsed = parseOffsetClause(parts.map((part, index) => {
            if (/\b(?:right|left|up|down|forward|backward)\b/iu.test(part)) return part;
            return `${part} ${['right', 'up', 'forward'][index]}`;
          }).join(' '), scope);
          voice.position = parsed.position;
        } else {
          const parsed = parseOffsetClause(place[2], scope);
          if (!parsed.matched) fail('plainform_sound_unsupported_statement', `Sound Plainform does not understand “${statement}”.`);
          voice.position = parsed.position;
        }
        interpretation.push(`Place ${voice.name} at [${voice.position.map(value => value.toFixed(3)).join(', ')}] metres.`);
        return;
      }
      const mirror = statement.match(/^mirror (.+?) across the listener as (.+)$/iu);
      if (mirror) {
        const voice = voices.find(item => key(item.name) === key(mirror[1]) || item.slug === slug(mirror[1]));
        if (!voice) fail('plainform_sound_unknown_voice', `Unknown sound voice “${mirror[1]}”.`);
        const copy = {
          ...voice,
          name: quoteName(mirror[2]),
          slug: slug(mirror[2]),
          position: [-(voice.position?.[0] ?? 0), voice.position?.[1] ?? 0, voice.position?.[2] ?? 0],
          harmonics: [...(voice.harmonics ?? [])],
          envelope: voice.envelope ? { ...voice.envelope } : undefined,
          filter: voice.filter ? { ...voice.filter } : undefined,
          sequence: voice.sequence ? { ...voice.sequence } : undefined,
        };
        voices.push(copy);
        interpretation.push(`Mirror ${voice.name} across the listener as ${copy.name}.`);
        return;
      }
      const group = statement.match(/^put (.+?) into a group called (?:(?:"([^"]+)")|(.+?))(?: with id ([a-z0-9][a-z0-9._/-]*))?(?:, centred at (\[.+\]))?$/iu);
      if (group) {
        const members = group[1].split(/\s+and\s+/iu).map(item => item.replace(/,/g, '').trim()).filter(Boolean);
        groups.push({
          name: quoteName(group[2] ?? group[3]),
          id: group[4] ?? `entity/${soundSlug}/${slug(group[2] ?? group[3])}`,
          members: members.map(slug),
        });
        interpretation.push(`Group ${members.join(', ')}.`);
        return;
      }
      const keep = statement.match(/^keep peak level below (.+)$/iu);
      if (keep) {
        const level = expectDimension(evaluateDesignExpression(keep[1], scope), ['level', 'scalar'], 'Peak level');
        peakLimitDb = level.dimension === 'level' ? level.value : level.value;
        constraints.push({ type: 'peak', decibels: peakLimitDb });
        interpretation.push(`Keep peak below ${peakLimitDb} dB.`);
        return;
      }
      const frame = statement.match(/^frame the (?:sound |whole )?visualization from (slightly below|eye level|slightly above) at a (\d+(?:\.\d+)?) millimetre lens$/iu);
      if (frame) {
        frameAngle = frame[1].toLowerCase();
        frameLens = Number(frame[2]);
        interpretation.push(`Frame the sound visualization at ${frameLens} mm.`);
        return;
      }
      if (/^when play starts, play /iu.test(statement) || /^play (?:this sound|it) when play starts$/iu.test(statement)) {
        playOnStart = true;
        interpretation.push('Play the sound when Play starts.');
        return;
      }
      if (/^loop (?:this sound|it)$/iu.test(statement)) { loop = true; interpretation.push('Loop the sound.'); return; }
      if (/^end$/iu.test(statement)) return;
      fail('plainform_sound_unsupported_statement', `Sound Plainform does not understand “${statement}”.`);
    };

    const execute = (lines, start, end, scope) => {
      for (let index = start; index < end; index += 1) {
        const statement = lines[index];
        const loop = statement.match(/^for every (?:partial|note|voice|harmonic|item)?\s*([a-z][a-z0-9_]*) from (.+?) through (.+)$/iu);
        if (loop) {
          let depth = 1;
          let close = index + 1;
          for (; close < end; close += 1) {
            if (/^for every\b/iu.test(lines[close])) depth += 1;
            else if (/^end$/iu.test(lines[close])) depth -= 1;
            if (depth === 0) break;
          }
          if (depth !== 0) fail('plainform_missing_end', `Loop on statement ${index + 1} has no End.`);
          const first = Math.round(evaluateDesignExpression(loop[2], scope).value);
          const last = Math.round(evaluateDesignExpression(loop[3], scope).value);
          if (![first, last].every(Number.isSafeInteger) || last < first || last - first + 1 > MAX_LOOP_ITERATIONS) {
            fail('plainform_loop_bounds', `Sound loops require ascending integer bounds and at most ${MAX_LOOP_ITERATIONS} iterations.`);
          }
          for (let value = first; value <= last; value += 1) {
            const inner = new Map(scope);
            inner.set(key(loop[1]), quantity(value));
            inner.set('index', quantity(value));
            const replaced = lines.slice(index + 1, close).map(line => line.replace(new RegExp(`\\b${loop[1]}\\b`, 'gu'), String(value)));
            execute(replaced, 0, replaced.length, inner);
          }
          interpretation.push(`Evaluated ${last - first + 1} bounded iterations for ${loop[1]}.`);
          index = close;
          continue;
        }
        applyStatement(statement, scope);
      }
    };
    execute(bodyLines, 0, bodyLines.length, variables);

    if (sceneHeader && voices.length === 0 && !designHeader && !graphHeader && !continueHeader) {
      return this.#emptyScene({ project, source, name, sceneId, requestedPreview, interpretation, ast });
    }
    if (voices.length === 0) fail('plainform_sound_source_required', 'A sound needs at least one oscillator, noise, or sequence.');
    if (voices.length > MAX_VOICES) fail('plainform_sound_voice_limit', `Sound Plainform accepts at most ${MAX_VOICES} voices.`);

    const feel = interpretSoundFeel(feelPhrases.join(', '));
    if (feel.descriptors.length) interpretation.push(`Applied sound feel: ${feel.descriptors.join(', ')}.`);

    const builder = new AudioGraphBuilder(graphId, name);
    const voiceOutputs = [];
    for (const voice of voices) {
      let nodeId;
      if (voice.sequence) {
        nodeId = builder.node('audio.sequence', {
          pattern: voice.sequence.pattern,
          waveform: voice.waveform ?? 'sine',
          noteDuration: voice.sequence.noteDuration,
          gain: voice.volume,
          startTime: voice.startTime ?? 0,
        }, voice.slug);
      } else if (voice.kind === 'noise') {
        nodeId = builder.node('audio.noise', { color: voice.color, gain: voice.volume, seed: Math.abs(voice.slug.split('').reduce((sum, char) => sum + char.charCodeAt(0), 1)) || 1 }, voice.slug);
      } else {
        nodeId = builder.node('audio.oscillator', {
          waveform: voice.waveform, frequency: voice.frequency, gain: voice.volume, startTime: voice.startTime ?? 0,
        }, voice.slug);
      }
      const harmonicIds = [];
      for (const harmonic of voice.harmonics ?? []) {
        if (!voice.frequency) continue;
        const harmonicId = builder.node('audio.oscillator', {
          waveform: voice.waveform ?? 'sine',
          frequency: voice.frequency * harmonic.ratio,
          gain: harmonic.volume,
          startTime: voice.startTime ?? 0,
        }, `${voice.slug}-h${harmonic.ratio}`);
        harmonicIds.push(harmonicId);
      }
      if (harmonicIds.length) nodeId = chainSum(builder, [nodeId, ...harmonicIds]);
      if (voice.envelope || feel.envelope) {
        const envelope = { attack: 0.01, decay: 0.12, sustain: 0.7, release: 0.2, ...(feel.envelope ?? {}), ...(voice.envelope ?? {}) };
        const startTime = voice.startTime ?? 0;
        const hold = Number.isFinite(envelope.hold)
          ? Math.max(0, envelope.hold)
          : Math.max(0, (duration ?? 2) - startTime - envelope.attack - envelope.decay - envelope.release);
        const envId = builder.node('audio.adsr', { ...envelope, startTime, hold }, `${voice.slug}-env`);
        builder.connect(nodeId, 'audio', envId, 'audio');
        nodeId = envId;
      }
      if (voice.formant) {
        const formantId = builder.node('audio.formant', voice.formant, `${voice.slug}-formant`);
        builder.connect(nodeId, 'audio', formantId, 'audio');
        nodeId = formantId;
      }
      if (voice.filter) {
        const filterId = builder.node('audio.filter', { type: voice.filter.type, frequency: voice.filter.frequency, q: voice.filter.q }, `${voice.slug}-filter`);
        builder.connect(nodeId, 'audio', filterId, 'audio');
        nodeId = filterId;
      }
      const pannerId = builder.node('audio.panner', {
        x: voice.position?.[0] ?? 0, y: voice.position?.[1] ?? 0, z: voice.position?.[2] ?? 0,
      }, `${voice.slug}-pan`);
      builder.connect(nodeId, 'audio', pannerId, 'audio');
      voiceOutputs.push(pannerId);
      voice.nodeId = pannerId;
      voice.audioId = audioId;
    }
    if (feel.harmonics.length && voices[0]?.frequency) {
      for (const harmonic of feel.harmonics) {
        const id = builder.node('audio.oscillator', {
          waveform: 'sine', frequency: voices[0].frequency * harmonic.ratio, gain: harmonic.gain, startTime: 0,
        }, `feel-h${harmonic.ratio}`);
        voiceOutputs.push(id);
      }
    }
    if (feel.noise) {
      const id = builder.node('audio.noise', { color: feel.noise.color, gain: feel.noise.gain, seed: 7 }, 'feel-noise');
      voiceOutputs.push(id);
    }
    let mixId = chainSum(builder, voiceOutputs);
    if (feel.filter) {
      const filterId = builder.node('audio.filter', { type: feel.filter.type, frequency: feel.filter.frequency, q: feel.filter.q }, 'feel-filter');
      builder.connect(mixId, 'audio', filterId, 'audio');
      mixId = filterId;
    }
    if (feel.gain !== 1) {
      const gainId = builder.node('audio.gain', { gain: feel.gain }, 'feel-gain');
      builder.connect(mixId, 'audio', gainId, 'audio');
      mixId = gainId;
    }
    if (Number.isFinite(feel.saturate) && feel.saturate > 0) {
      const satId = builder.node('audio.saturate', { drive: Math.min(8, Math.max(0.1, feel.saturate)) }, 'feel-drive');
      builder.connect(mixId, 'audio', satId, 'audio');
      mixId = satId;
    }
    const computedDuration = duration ?? Math.max(2, ...voices.map(voice => {
      if (voice.sequence) return voice.sequence.notes.length * voice.sequence.noteDuration + 0.25;
      const envelope = voice.envelope ?? feel.envelope;
      return (voice.startTime ?? 0) + (envelope ? envelope.attack + envelope.decay + envelope.release + 0.4 : 2);
    }));
    builder.setDuration(Math.min(AUDIO_LIMITS.maxDuration, Math.max(AUDIO_LIMITS.minDuration, computedDuration)));
    builder.graph.outputs.mix = { nodeId: mixId, port: 'audio' };

    const validation = validateGraph(builder.graph);
    if (!validation.valid) fail('plainform_sound_graph_invalid', validation.errors[0]?.message ?? 'The generated audio graph did not pass validation.', { errors: validation.errors });
    const evaluation = evaluateAudioGraph(validation.graph);
    if (peakLimitDb !== null && evaluation.digest.peakDecibels > peakLimitDb) {
      fail('plainform_constraint_unsatisfied', `Peak level ${evaluation.digest.peakDecibels.toFixed(2)} dB exceeds ${peakLimitDb} dB.`);
    }

    const visualization = buildSoundVisualization({
      slug: soundSlug,
      name,
      evaluation,
      voices: voices.map(voice => ({ ...voice, audioId })),
      listenerPosition: [0, 0, 0],
    });
    for (const group of groups) {
      visualization.entities.splice(1, 0, {
        id: group.id,
        kind: 'group',
        name: group.name,
        parentId: visualization.rootId,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        tags: ['sound', 'group'],
      });
      for (const member of group.members) {
        const entity = visualization.entities.find(item => item.id === `entity/${soundSlug}/source/${member}`);
        if (entity) entity.parentId = group.id;
      }
    }

    const cameraId = `camera/${soundSlug}`;
    const playerId = `entity/${soundSlug}/player`;
    const eventGraphId = `blueprint/${soundSlug}-sound-play`;
    const fov = 2 * Math.atan(36 / (2 * frameLens)) * 180 / Math.PI;
    const eventGraph = {
      formatVersion: 1,
      id: eventGraphId,
      domain: 'blueprint',
      nodes: [
        { id: 'event/start', type: 'event.onStart', params: {} },
        { id: 'entity/self', type: 'entity.self', params: {} },
        { id: 'action/play', type: 'audio.play', params: { audioId, volume: 1 } },
      ],
      edges: [
        { from: { nodeId: 'event/start', port: 'out' }, to: { nodeId: 'action/play', port: 'in' } },
        { from: { nodeId: 'entity/self', port: 'entity' }, to: { nodeId: 'action/play', port: 'entity' } },
      ],
      outputs: {},
    };
    const eventValidation = validateGraph(eventGraph);
    if (!eventValidation.valid) fail('plainform_event_graph_invalid', eventValidation.errors[0]?.message ?? 'The sound event sheet is invalid.');

    visualization.entities.push({
      id: playerId,
      kind: 'empty',
      name: `${name} Player`,
      parentId: visualization.rootId,
      components: {
        audio: { enabled: true, volume: 1, loop, audioId },
        ...(playOnStart ? { logic: { enabled: true, graphIds: [eventGraphId] } } : {}),
      },
      tags: ['sound', 'player'],
    });
    visualization.entities.push({
      id: cameraId,
      kind: 'perspectiveCamera',
      name: `${name} Camera`,
      components: { camera: { fov, near: 0.05, far: 200 } },
      metadata: { soundAssetId: audioId },
    });

    const existingScene = project.scenes?.[sceneId];
    const existingAudio = ownedSound(project, audioId);
    const fps = existingScene?.settings?.timeline?.framesPerSecond ?? 24;
    const frameEnd = Math.max(2, Math.round(evaluation.duration * fps));
    const audioResource = {
      id: audioId,
      kind: 'audio',
      name,
      recipe: { kind: 'graph', graphId, sampleRate: evaluation.sampleRate, duration: evaluation.duration, channels: 2 },
      digest: evaluation.digest,
      metadata: {
        plainform: {
          kind: 'sound',
          source,
          ast,
          sceneId,
          graphId,
          visualizationRootId: visualization.rootId,
          voices: voices.map(voice => ({ name: voice.name, slug: voice.slug, kind: voice.kind, frequency: voice.frequency ?? null })),
          feel: feel.descriptors,
          constraints,
          duration: evaluation.duration,
        },
      },
    };
    const graphResource = {
      id: graphId,
      kind: 'graph',
      name: `${name} Sound`,
      metadata: { plainform: { kind: 'sound', source, subjectId: audioId } },
      graph: validation.graph,
    };
    const eventResource = {
      id: eventGraphId,
      kind: 'graph',
      name: `${name} Play Event`,
      metadata: { plainform: { kind: 'eventSheet', source: 'When Play starts, play the sound.', subjectId: playerId } },
      graph: eventValidation.graph,
    };

    const operations = [];
    if (!existingScene) {
      operations.push({
        op: 'scene.create',
        scene: {
          id: sceneId,
          name,
          settings: {
            purpose: 'sound',
            background: { mode: 'color', color: [0.034, 0.024, 0.03], colorSpace: 'linear-srgb' },
            activeCameraId: null,
            timeline: { frameStart: 1, frameEnd, currentFrame: 1, framesPerSecond: fps },
          },
          metadata: { plainformSound: { audioId, graphId } },
        },
      });
    }
    if (project.activeSceneId !== sceneId) operations.push({ op: 'scene.setActive', sceneId });

    const resourceItems = [];
    const patchResources = [];
    const addResource = (resourceType, resource) => {
      const table = project.resources?.[resourceType] ?? {};
      if (table[resource.id]) {
        const { id, ...patch } = resource;
        patchResources.push({ op: 'resource.patch', resourceType, resourceId: id, patch });
      } else resourceItems.push({ resourceType, resource });
    };
    addResource('graphs', graphResource);
    addResource('graphs', eventResource);
    addResource('audio', audioResource);
    for (const geometry of visualization.geometries) addResource('geometries', { id: geometry.id, recipe: geometry.recipe });
    for (const material of visualization.materials) addResource('materials', material);
    if (resourceItems.length) operations.push({ op: 'resource.createMany', items: resourceItems });
    operations.push(...patchResources);

    const sceneEntities = existingScene?.entities ?? {};
    const patchEntities = [];
    for (const entity of visualization.entities) {
      if (sceneEntities[entity.id]) {
        const { id, parentId, ...patch } = entity;
        patchEntities.push({ op: 'entity.patch', entityId: id, patch });
      } else operations.push({ op: 'entity.create', sceneId, entity });
    }
    operations.push(...patchEntities);

    const collectionId = `collection/${soundSlug}/sound`;
    if (!existingScene?.collections?.[collectionId]) {
      operations.push({
        op: 'collection.create',
        sceneId,
        collection: {
          id: collectionId,
          name: `${name} Sound`,
          entityIds: visualization.entities.map(entity => entity.id),
          metadata: { plainformSound: { audioId } },
        },
      });
    }

    const upsertLight = (entity) => {
      if (sceneEntities[entity.id]) {
        const { id, ...patch } = entity;
        operations.push({ op: 'entity.patch', entityId: id, patch });
      } else operations.push({ op: 'entity.create', sceneId, entity });
    };
    upsertLight({
      id: `entity/${soundSlug}/key-light`,
      kind: 'pointLight',
      name: `${name} Key Light`,
      transform: { position: [2.1, 2.6, 3.4], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: { light: { color: [1, 0.82, 0.62], intensity: 46, distance: 14, decay: 2, castShadow: false } },
      tags: ['lighting', 'sound'],
    });
    upsertLight({
      id: `entity/${soundSlug}/fill-light`,
      kind: 'ambientLight',
      name: `${name} Fill`,
      components: { light: { color: [0.32, 0.24, 0.2], intensity: 0.16, castShadow: false } },
      tags: ['lighting', 'sound'],
    });
    upsertLight({
      id: `entity/${soundSlug}/rim-light`,
      kind: 'pointLight',
      name: `${name} Rim Light`,
      transform: { position: [-2.2, 1.7, -1.1], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: { light: { color: [1, 0.68, 0.38], intensity: 28, distance: 12, decay: 2, castShadow: false } },
      tags: ['lighting', 'sound'],
    });
    upsertLight({
      id: `entity/${soundSlug}/sky-light`,
      kind: 'hemisphereLight',
      name: `${name} Sky`,
      transform: { position: [0, 8, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: { light: { color: [0.72, 0.52, 0.36], groundColor: [0.08, 0.05, 0.04], intensity: 0.38, castShadow: false } },
      tags: ['lighting', 'sound'],
    });
    operations.push({
      op: 'camera.frame',
      cameraId,
      target: { targetIds: [
        `entity/${soundSlug}/spectrogram`,
        `entity/${soundSlug}/envelope`,
        `entity/${soundSlug}/plinth`,
      ] },
      aspect: 16 / 9,
      padding: 1.04,
      view: {
        azimuth: -0.46,
        elevation: ({ 'slightly below': 0.08, 'eye level': 0.32, 'slightly above': 0.48 })[frameAngle],
        distanceScale: 0.62,
        targetOffset: [0, 0.06, 0.28],
        minHeight: 0.22,
      },
      lockPreviewAspect: true,
    });
    operations.push({ op: 'scene.setActiveCamera', sceneId, cameraId });
    operations.push({
      op: 'scene.settings.patch',
      sceneId,
      patch: {
        purpose: 'sound',
        background: { mode: 'color', color: [0.034, 0.024, 0.03], colorSpace: 'linear-srgb' },
        activeCameraId: cameraId,
        timeline: { frameStart: 1, frameEnd, currentFrame: 1, framesPerSecond: fps },
        audio: {
          graphId,
          audioId,
          duration: evaluation.duration,
          loop,
          visualizationRootId: visualization.rootId,
        },
        presentation: { exposure: 1.05 },
      },
    });

    return Object.freeze({
      language: 'plainform-v1',
      dialect: 'sound',
      source,
      operations: Object.freeze(operations),
      interpretation: Object.freeze(interpretation),
      aliases: Object.freeze({}),
      requestedPreview,
      sound: Object.freeze({
        audioId,
        graphId,
        sceneId,
        duration: evaluation.duration,
        voiceCount: voices.length,
        digest: evaluation.digest,
        visualizationRootId: visualization.rootId,
        metrics: validation.metrics,
        feel: feel.descriptors,
      }),
    });
  }

  #emptyScene({ project, source, name, sceneId, requestedPreview, interpretation, ast }) {
    const operations = [];
    if (!project.scenes?.[sceneId]) {
      operations.push({
        op: 'scene.create',
        scene: {
          id: sceneId,
          name,
          settings: {
            purpose: 'sound',
            background: { mode: 'color', color: [0.034, 0.024, 0.03], colorSpace: 'linear-srgb' },
            timeline: { frameStart: 1, frameEnd: 48, currentFrame: 1, framesPerSecond: 24 },
          },
          metadata: { plainformSound: { ast } },
        },
      });
    }
    if (project.activeSceneId !== sceneId) operations.push({ op: 'scene.setActive', sceneId });
    operations.push({
      op: 'scene.settings.patch',
      sceneId,
      patch: { purpose: 'sound', background: { mode: 'color', color: [0.034, 0.024, 0.03], colorSpace: 'linear-srgb' } },
    });
    return Object.freeze({
      language: 'plainform-v1',
      dialect: 'sound',
      source,
      operations: Object.freeze(operations),
      interpretation: Object.freeze(interpretation),
      aliases: Object.freeze({}),
      requestedPreview,
      sound: Object.freeze({ sceneId, audioId: null, graphId: null, duration: 0, voiceCount: 0 }),
    });
  }
}
