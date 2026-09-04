import { evaluateAudioGraph } from './audio-graph-evaluator.mjs';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function copyChannel(source, destination) {
  const count = Math.min(source.length, destination.length);
  for (let index = 0; index < count; index += 1) destination[index] = source[index];
}

function floatToPcm16(sample) {
  const clipped = clamp(sample, -1, 1);
  return clipped < 0 ? Math.round(clipped * 0x8000) : Math.round(clipped * 0x7fff);
}

export function encodeWavPcm16({ left, right, sampleRate }) {
  const frames = Math.min(left?.length ?? 0, right?.length ?? 0);
  const rate = Math.max(1, Number(sampleRate) || 1);
  const dataBytes = frames * 4;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let index = 0; index < frames; index += 1) {
    view.setInt16(offset, floatToPcm16(left[index]), true);
    view.setInt16(offset + 2, floatToPcm16(right[index]), true);
    offset += 4;
  }
  return bytes;
}

function wavFileName(graphId) {
  const slug = String(graphId ?? 'sound').replace(/[^a-z0-9]+/giu, '-').replace(/^-|-$/gu, '') || 'sound';
  return `${slug}.wav`;
}

function joinPath(dir, name) {
  const left = String(dir ?? '');
  if (!left) return name;
  const slash = left.includes('\\') ? '\\' : '/';
  return `${left.replace(/[\\/]+$/u, '')}${slash}${name}`;
}

function fileUrlFromPath(filePath) {
  const raw = String(filePath ?? '');
  if (!raw || /^file:/iu.test(raw)) return raw;
  const normalized = raw.replaceAll('\\', '/');
  if (/^[a-zA-Z]:/u.test(normalized)) return `file:///${normalized}`;
  if (normalized.startsWith('/')) return `file://${normalized}`;
  return raw;
}

function htmlAudioConstructor() {
  return typeof globalThis.Audio === 'function' ? globalThis.Audio : null;
}

function usableAudioContextConstructor() {
  const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext ?? null;
  if (typeof Ctor !== 'function') return null;
  if (Ctor.name === 'SilentAudioContext') return null;
  return Ctor;
}

function expectedAudioBackend() {
  if (htmlAudioConstructor()) return 'html-audio';
  if (usableAudioContextConstructor()) return 'webaudio';
  return 'silent';
}

export function createAudioRuntime({
  project,
  scene,
  cacheDirectory,
  writeFile,
  audioFactory,
} = {}) {
  const settings = scene?.settings?.audio;
  if (scene?.settings?.purpose !== 'sound' || !settings?.graphId) return null;
  const graphResource = project?.resources?.graphs?.[settings.graphId];
  if (!graphResource?.graph) return null;

  let evaluation = null;
  let playing = false;
  let paused = false;
  let elapsed = 0;
  let loop = settings.loop === true;
  let volume = 1;
  let context = null;
  let sourceNode = null;
  let media = null;
  let wavPath = null;
  let backend = 'silent';
  let lastError = null;
  let playGeneration = 0;
  const persistWav = typeof writeFile === 'function' ? writeFile : null;
  const wavDirectory = cacheDirectory ?? '';

  const ensureEvaluation = () => {
    if (!evaluation) {
      evaluation = evaluateAudioGraph(graphResource.graph, {
        duration: settings.duration,
        sampleRate: graphResource.graph.settings?.sampleRate,
      });
    }
    return evaluation;
  };

  const releaseWebAudio = () => {
    try { sourceNode?.stop?.(); } catch { /* already stopped */ }
    try { sourceNode?.disconnect?.(); } catch { /* already disconnected */ }
    sourceNode = null;
  };

  const releaseMedia = () => {
    playGeneration += 1;
    if (!media) return;
    try { media.pause?.(); } catch { /* already paused */ }
    try { media.close?.(); } catch { /* host without close() */ }
    media = null;
  };

  const disconnect = () => {
    releaseWebAudio();
    releaseMedia();
  };

  const ensureWav = () => {
    if (wavPath) return wavPath;
    const evaled = ensureEvaluation();
    if (!persistWav) throw new Error('Sound Play needs a local WAV writer.');
    const bytes = encodeWavPcm16(evaled);
    const filePath = joinPath(wavDirectory, wavFileName(settings.graphId));
    persistWav(filePath, bytes);
    wavPath = filePath;
    return filePath;
  };

  const startHtmlAudio = (offset) => {
    const filePath = ensureWav();
    const startOffset = clamp(offset, 0, Math.max(0, ensureEvaluation().duration - 0.001));
    const factory = audioFactory ?? ((source) => {
      const Ctor = htmlAudioConstructor();
      return Ctor ? new Ctor(source) : null;
    });
    const source = fileUrlFromPath(filePath);
    const element = factory(source) ?? factory(filePath);
    if (!element) {
      backend = 'silent';
      lastError = 'HTMLAudioElement is not available.';
      return false;
    }
    media = element;
    media.loop = loop;
    if (typeof media.volume === 'number' || 'volume' in media) {
      media.volume = clamp(volume, 0, 1);
    }
    if ('currentTime' in media) media.currentTime = startOffset;
    const generation = playGeneration;
    const started = media.play?.();
    if (started && typeof started.then === 'function') {
      started.catch((error) => {
        if (generation !== playGeneration) return;
        lastError = error?.message ?? String(error);
        backend = 'silent';
        playing = false;
      });
    }
    backend = 'html-audio';
    lastError = null;
    return true;
  };

  const startWebAudio = (offset) => {
    const Ctor = usableAudioContextConstructor();
    if (!Ctor) return false;
    const evaled = ensureEvaluation();
    if (!context) context = new Ctor({ sampleRate: evaled.sampleRate });
    const buffer = context.createBuffer(2, evaled.left.length, evaled.sampleRate);
    copyChannel(evaled.left, buffer.getChannelData(0));
    copyChannel(evaled.right, buffer.getChannelData(1));
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.connect(context.destination);
    context.resume?.();
    const startOffset = clamp(offset, 0, Math.max(0, evaled.duration - 0.001));
    source.start(0, startOffset);
    sourceNode = source;
    backend = 'webaudio';
    lastError = null;
    return true;
  };

  const startFrom = (offset) => {
    disconnect();
    try {
      if ((htmlAudioConstructor() || audioFactory) && persistWav) {
        if (startHtmlAudio(offset)) return;
      }
      if (startWebAudio(offset)) return;
      backend = 'silent';
      lastError ??= 'No audible playback backend is available.';
    } catch (error) {
      backend = 'silent';
      lastError = error?.message ?? String(error);
    }
  };

  return {
    get enabled() { return true; },
    get playing() { return playing && !paused; },
    get paused() { return paused; },
    get elapsed() { return elapsed; },
    get duration() { return ensureEvaluation().duration; },
    get digest() { return ensureEvaluation().digest; },
    get backend() { return backend; },
    get audioId() { return settings.audioId ?? null; },
    get graphId() { return settings.graphId; },
    get outputPath() { return wavPath; },
    enter(options = {}) {
      loop = options.loop === true || settings.loop === true;
      volume = clamp(Number(options.volume ?? volume ?? 1) || 1, 0, 1);
      elapsed = 0;
      playing = true;
      paused = false;
      startFrom(0);
      return { backend, duration: this.duration, audioId: this.audioId, outputPath: wavPath, error: lastError };
    },
    play(audioId, options = {}) {
      if (audioId && settings.audioId && audioId !== settings.audioId) return { backend, ignored: true };
      return this.enter(options);
    },
    stop() {
      playing = false;
      paused = false;
      elapsed = 0;
      disconnect();
      return { backend };
    },
    pause() {
      paused = true;
      try { media?.pause?.(); } catch { /* already paused */ }
      releaseWebAudio();
      return { backend, elapsed };
    },
    resume() {
      if (!playing) return this.enter();
      paused = false;
      if (media) {
        if ('currentTime' in media) media.currentTime = elapsed;
        const generation = playGeneration;
        const started = media.play?.();
        if (started && typeof started.then === 'function') {
          started.catch((error) => {
            if (generation !== playGeneration) return;
            lastError = error?.message ?? String(error);
            backend = 'silent';
            playing = false;
          });
        }
        return { backend, elapsed };
      }
      startFrom(elapsed);
      return { backend, elapsed };
    },
    seek(timeSeconds) {
      elapsed = clamp(Number(timeSeconds) || 0, 0, this.duration);
      if (playing && !paused) {
        if (media && 'currentTime' in media) media.currentTime = elapsed;
        else startFrom(elapsed);
      }
      return { backend, elapsed };
    },
    advance(deltaSeconds) {
      if (!playing || paused) return { elapsed, playing: false };
      const duration = this.duration;
      const next = elapsed + deltaSeconds;
      if (loop && duration > 0) {
        elapsed = ((next % duration) + duration) % duration;
        return { elapsed, playing: true };
      }
      elapsed = clamp(next, 0, duration);
      if (elapsed >= duration) {
        playing = false;
        disconnect();
      }
      return { elapsed, playing };
    },
    status() {
      return {
        enabled: true,
        purpose: 'sound',
        backend,
        playing: playing && !paused,
        paused,
        elapsed,
        duration: this.duration,
        audioId: this.audioId,
        graphId: this.graphId,
        outputPath: wavPath,
        error: lastError,
        digest: this.digest,
      };
    },
  };
}

export { expectedAudioBackend };

