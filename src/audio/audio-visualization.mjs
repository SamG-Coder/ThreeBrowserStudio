import { AUDIO_LIMITS } from './audio-graph-evaluator.mjs';

function identityTransform(position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) {
  return { position: [...position], rotation: [...rotation], scale: [...scale] };
}

function lerp3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function addQuad(positions, indices, colors, corners, color) {
  const base = positions.length / 3;
  for (const corner of corners) {
    positions.push(corner[0], corner[1], corner[2]);
    colors.push(color[0], color[1], color[2]);
  }
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function heatColor(amount) {
  const t = Math.min(1, Math.max(0, amount)) ** 0.58;
  const stops = [
    [0, [0.04, 0.025, 0.06]],
    [0.18, [0.22, 0.06, 0.16]],
    [0.38, [0.62, 0.16, 0.18]],
    [0.58, [0.92, 0.42, 0.14]],
    [0.8, [1, 0.78, 0.28]],
    [1, [1, 0.96, 0.82]],
  ];
  for (let index = 1; index < stops.length; index += 1) {
    if (t <= stops[index][0]) {
      const span = stops[index][0] - stops[index - 1][0];
      const local = span > 0 ? (t - stops[index - 1][0]) / span : 0;
      return lerp3(stops[index - 1][1], stops[index][1], local);
    }
  }
  return stops[stops.length - 1][1];
}

function bilinearSample(grid, u, v) {
  const zMax = Math.max(0, grid.length - 1);
  const xMax = Math.max(0, (grid[0]?.length ?? 1) - 1);
  const z = u * zMax;
  const x = v * xMax;
  const z0 = Math.floor(z);
  const x0 = Math.floor(x);
  const z1 = Math.min(zMax, z0 + 1);
  const x1 = Math.min(xMax, x0 + 1);
  const tz = z - z0;
  const tx = x - x0;
  const a = grid[z0]?.[x0] ?? 0;
  const b = grid[z0]?.[x1] ?? 0;
  const c = grid[z1]?.[x0] ?? 0;
  const d = grid[z1]?.[x1] ?? 0;
  return a * (1 - tx) * (1 - tz) + b * tx * (1 - tz) + c * (1 - tx) * tz + d * tx * tz;
}

function physical(recipe) {
  return { kind: 'physical', roughness: 0.32, metalness: 0.08, ...recipe };
}

function isBedVoice(voice) {
  if ((voice.kind ?? '') === 'noise') return true;
  return /^(chest|glow|breath|rain|pad|feel)/u.test(voice.slug ?? '');
}

function voicePose(voice, duration, { width = 3.8, depth = 2.55 } = {}) {
  const start = Number.isFinite(voice.startTime) ? voice.startTime : 0;
  const t = Math.min(1, Math.max(0, start / Math.max(0.05, duration)));
  const volume = Number.isFinite(voice.volume) ? voice.volume : 0.3;
  if (isBedVoice(voice)) {
    const side = /chest|pad/u.test(voice.slug ?? '') ? -1.95 : 1.92;
    return {
      position: [side, 0.18 + volume * 0.4, 0.18 + t * depth * 0.86],
      scale: [0.52, 0.52, 0.52],
    };
  }
  const freq = Number.isFinite(voice.frequency) ? voice.frequency : 160;
  const logx = (Math.log(Math.min(360, Math.max(80, freq))) - Math.log(80)) / (Math.log(320) - Math.log(80));
  const size = 0.72 + volume * 1.12;
  return {
    position: [
      (logx - 0.5) * width * 0.82,
      0.24 + volume * 0.82,
      0.12 + t * depth,
    ],
    scale: [size, size, size],
  };
}

function quantize(value) {
  return Math.round(value * 10000) / 10000;
}

export function buildSpectrogramMesh(spectrogram, { width = 3.8, height = 1.55, depth = 2.55 } = {}) {
  const timeBins = Math.max(2, spectrogram.length);
  const freqBins = Math.max(2, spectrogram[0]?.length ?? 0);
  const positions = [];
  const indices = [];
  const colors = [];
  let max = 0;
  for (const row of spectrogram) for (const value of row) max = Math.max(max, value);
  const scale = max > 0 ? 1 / max : 1;
  const sample = (z, x) => bilinearSample(spectrogram, z / Math.max(1, timeBins - 1), x / Math.max(1, freqBins - 1)) * scale;
  const point = (z, x) => {
    const magnitude = sample(z, x);
    return {
      position: [
        quantize((x / Math.max(1, freqBins - 1) - 0.5) * width),
        quantize(magnitude * height),
        quantize((z / Math.max(1, timeBins - 1)) * depth),
      ],
      magnitude,
    };
  };
  for (let z = 0; z < timeBins; z += 1) {
    for (let x = 0; x < freqBins; x += 1) {
      const vertex = point(z, x);
      positions.push(...vertex.position);
      const color = heatColor(vertex.magnitude).map(quantize);
      colors.push(color[0], color[1], color[2]);
    }
  }
  for (let z = 0; z < timeBins - 1; z += 1) {
    for (let x = 0; x < freqBins - 1; x += 1) {
      const a = z * freqBins + x;
      const b = a + 1;
      const c = a + freqBins;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const skirt = (from, to) => {
    const color = heatColor(Math.max(from.magnitude, to.magnitude) * 0.45).map(quantize);
    addQuad(positions, indices, colors, [
      [from.position[0], 0, from.position[2]],
      [to.position[0], 0, to.position[2]],
      [to.position[0], to.position[1], to.position[2]],
      [from.position[0], from.position[1], from.position[2]],
    ], color);
  };
  for (let x = 0; x < freqBins - 1; x += 1) {
    skirt(point(0, x), point(0, x + 1));
    skirt(point(timeBins - 1, x + 1), point(timeBins - 1, x));
  }
  for (let z = 0; z < timeBins - 1; z += 1) {
    skirt(point(z + 1, 0), point(z, 0));
    skirt(point(z, freqBins - 1), point(z + 1, freqBins - 1));
  }
  const uvs = [];
  const vertexCount = positions.length / 3;
  for (let index = 0; index < vertexCount; index += 1) {
    uvs.push(
      quantize((positions[index * 3] / width) + 0.5),
      quantize(positions[index * 3 + 2] / Math.max(1e-6, depth)),
    );
  }
  return {
    kind: 'indexedMesh',
    positions,
    indices,
    colors,
    uvs,
    computeNormals: true,
  };
}

export function buildEnvelopeRibbon(envelope, { length = 2.55, height = 1.2, thickness = 0.11 } = {}) {
  const positions = [];
  const indices = [];
  const colors = [];
  const samples = Math.max(2, envelope.length);
  const ranked = [...envelope].sort((a, b) => a - b);
  const floor = ranked[Math.floor((ranked.length - 1) * 0.12)] ?? 0;
  const peak = Math.max(1e-6, ranked[ranked.length - 1] ?? 0);
  const span = Math.max(1e-6, peak - floor);
  const valueAt = (index) => Math.max(0, ((envelope[index] ?? 0) - floor) / span);
  for (let index = 0; index < samples - 1; index += 1) {
    const t0 = index / Math.max(1, samples - 1);
    const t1 = (index + 1) / Math.max(1, samples - 1);
    const a = valueAt(index);
    const b = valueAt(index + 1);
    const y0 = Math.max(0.012, a * height);
    const y1 = Math.max(0.012, b * height);
    const z0 = t0 * length;
    const z1 = t1 * length;
    const color = heatColor(0.55 + a * 0.45).map(quantize);
    addQuad(positions, indices, colors, [
      [-thickness, 0, z0],
      [thickness, 0, z0],
      [thickness, y0, z0],
      [-thickness, y0, z0],
    ], color);
    addQuad(positions, indices, colors, [
      [-thickness, y0, z0],
      [thickness, y0, z0],
      [thickness, y1, z1],
      [-thickness, y1, z1],
    ], color);
    addQuad(positions, indices, colors, [
      [-thickness, 0, z0],
      [-thickness, 0, z1],
      [thickness, 0, z1],
      [thickness, 0, z0],
    ], [0.08, 0.05, 0.03]);
  }
  return {
    kind: 'indexedMesh',
    positions,
    indices,
    colors,
    computeNormals: true,
  };
}

export function buildSoundVisualization({
  slug,
  name,
  evaluation,
  voices = [],
  listenerPosition = [0, 0, 0],
} = {}) {
  const spectrogramRecipe = buildSpectrogramMesh(evaluation.spectrogram);
  const envelopeRecipe = buildEnvelopeRibbon(evaluation.envelope);
  const geometries = [
    { id: `geometry/${slug}/spectrogram`, recipe: spectrogramRecipe },
    { id: `geometry/${slug}/envelope`, recipe: envelopeRecipe },
    { id: `geometry/${slug}/source-marker`, recipe: { kind: 'sphere', radius: 0.11 } },
    { id: `geometry/${slug}/source-stem`, recipe: { kind: 'cylinder', radiusTop: 0.01, radiusBottom: 0.01, height: 0.2 } },
    { id: `geometry/${slug}/listener`, recipe: { kind: 'sphere', radius: 0.075 } },
    { id: `geometry/${slug}/harmonic`, recipe: { kind: 'cylinder', radiusTop: 0.042, radiusBottom: 0.042, height: 1 } },
    { id: `geometry/${slug}/harmonic-cap`, recipe: { kind: 'sphere', radius: 0.048 } },
    { id: `geometry/${slug}/plinth`, recipe: { kind: 'box', width: 4.9, height: 0.08, depth: 3.2 } },
    { id: `geometry/${slug}/floor`, recipe: { kind: 'plane', width: 9, height: 9 } },
    { id: `geometry/${slug}/rail`, recipe: { kind: 'box', width: 3.9, height: 0.018, depth: 0.018 } },
  ];
  const materials = [
    {
      id: `material/${slug}/spectrogram`,
      recipe: physical({
        color: '#ffffff',
        vertexColors: true,
        roughness: 0.22,
        metalness: 0.12,
        clearcoat: 0.45,
        clearcoatRoughness: 0.18,
        emissive: '#3a1408',
        emissiveIntensity: 0.42,
      }),
    },
    {
      id: `material/${slug}/envelope`,
      recipe: physical({
        color: '#ffffff',
        vertexColors: true,
        roughness: 0.2,
        metalness: 0.18,
        clearcoat: 0.55,
        clearcoatRoughness: 0.12,
        emissive: '#5a2208',
        emissiveIntensity: 0.62,
      }),
    },
    {
      id: `material/${slug}/harmonic`,
      recipe: physical({
        color: '#9fd7ff',
        roughness: 0.16,
        metalness: 0.28,
        clearcoat: 0.6,
        clearcoatRoughness: 0.1,
        emissive: '#4ea7ff',
        emissiveIntensity: 1.15,
      }),
    },
    {
      id: `material/${slug}/harmonic-warm`,
      recipe: physical({
        color: '#ffd08a',
        roughness: 0.18,
        metalness: 0.22,
        emissive: '#ff9a3a',
        emissiveIntensity: 1.05,
      }),
    },
    {
      id: `material/${slug}/source`,
      recipe: physical({
        color: '#ffe7b0',
        roughness: 0.18,
        metalness: 0.08,
        emissive: '#ffcf70',
        emissiveIntensity: 2.1,
      }),
    },
    {
      id: `material/${slug}/listener`,
      recipe: physical({
        color: '#d8dee8',
        roughness: 0.12,
        metalness: 0.86,
        clearcoat: 0.4,
        clearcoatRoughness: 0.08,
        emissive: '#8aa0c8',
        emissiveIntensity: 0.25,
      }),
    },
    {
      id: `material/${slug}/plinth`,
      recipe: physical({
        color: '#12151c',
        roughness: 0.28,
        metalness: 0.72,
        clearcoat: 0.35,
        clearcoatRoughness: 0.22,
      }),
    },
    {
      id: `material/${slug}/floor`,
      recipe: physical({
        color: '#0b0d12',
        roughness: 0.82,
        metalness: 0.18,
      }),
    },
    {
      id: `material/${slug}/rail`,
      recipe: physical({
        color: '#2a3344',
        roughness: 0.24,
        metalness: 0.65,
        emissive: '#1a2436',
        emissiveIntensity: 0.4,
      }),
    },
  ];
  const rootId = `entity/${slug}`;
  const vizId = `entity/${slug}/visualization`;
  const entities = [
    {
      id: rootId,
      kind: 'group',
      name,
      transform: identityTransform(),
      tags: ['sound', 'plainform-sound'],
      metadata: { plainformSound: { role: 'root' } },
    },
    {
      id: vizId,
      kind: 'group',
      name: `${name} Visualization`,
      parentId: rootId,
      transform: identityTransform([0, 0.02, 0.35]),
      tags: ['sound-visualization'],
    },
    {
      id: `entity/${slug}/floor`,
      kind: 'mesh',
      name: `${name} Gallery Floor`,
      parentId: rootId,
      transform: identityTransform([0, 0, 1.45], [-Math.PI / 2, 0, 0]),
      components: { mesh: { geometryId: `geometry/${slug}/floor`, materialId: `material/${slug}/floor` } },
      tags: ['sound-visualization', 'stage'],
    },
    {
      id: `entity/${slug}/plinth`,
      kind: 'mesh',
      name: `${name} Plinth`,
      parentId: vizId,
      transform: identityTransform([0, 0.04, 1.2]),
      components: { mesh: { geometryId: `geometry/${slug}/plinth`, materialId: `material/${slug}/plinth` } },
      tags: ['sound-visualization', 'stage'],
    },
    {
      id: `entity/${slug}/spectrogram`,
      kind: 'mesh',
      name: `${name} Spectrogram`,
      parentId: vizId,
      transform: identityTransform([0, 0.1, 0]),
      components: { mesh: { geometryId: `geometry/${slug}/spectrogram`, materialId: `material/${slug}/spectrogram` } },
      tags: ['sound-visualization', 'spectrogram'],
    },
    {
      id: `entity/${slug}/envelope`,
      kind: 'mesh',
      name: `${name} Envelope`,
      parentId: vizId,
      transform: identityTransform([2.12, 0.1, 0]),
      components: { mesh: { geometryId: `geometry/${slug}/envelope`, materialId: `material/${slug}/envelope` } },
      tags: ['sound-visualization', 'envelope'],
    },
    {
      id: `entity/${slug}/time-rail`,
      kind: 'mesh',
      name: `${name} Time Rail`,
      parentId: vizId,
      transform: identityTransform([0, 0.109, -0.03], [0, Math.PI / 2, 0]),
      components: { mesh: { geometryId: `geometry/${slug}/rail`, materialId: `material/${slug}/rail` } },
      tags: ['sound-visualization', 'stage'],
    },
  ];
  const maxHarmonic = Math.max(1e-6, ...evaluation.harmonics.map(item => item.magnitude));
  const notableHarmonics = evaluation.harmonics.filter(item => item.magnitude >= maxHarmonic * 0.12);
  const harmonicCount = notableHarmonics.length;
  notableHarmonics.forEach((harmonic, index) => {
    const height = 0.18 + (harmonic.magnitude / maxHarmonic) * 0.72;
    const z = 0.35 + (harmonicCount <= 1 ? 0 : (index / Math.max(1, harmonicCount - 1)) * 1.9);
    const warm = harmonic.frequency < 250;
    entities.push({
      id: `entity/${slug}/harmonic/${index + 1}`,
      kind: 'mesh',
      name: `${name} Harmonic ${harmonic.partial}`,
      parentId: vizId,
      transform: identityTransform([-2.12, 0.1 + height / 2, z], [0, 0, 0], [1, height, 1]),
      components: {
        mesh: {
          geometryId: `geometry/${slug}/harmonic`,
          materialId: warm ? `material/${slug}/harmonic-warm` : `material/${slug}/harmonic`,
        },
      },
      tags: ['sound-visualization', 'harmonic'],
      metadata: { harmonic },
    });
    entities.push({
      id: `entity/${slug}/harmonic/${index + 1}/cap`,
      kind: 'mesh',
      name: `${name} Harmonic ${harmonic.partial} Cap`,
      parentId: vizId,
      transform: identityTransform([-2.12, 0.1 + height, z]),
      components: {
        mesh: {
          geometryId: `geometry/${slug}/harmonic-cap`,
          materialId: warm ? `material/${slug}/harmonic-warm` : `material/${slug}/harmonic`,
        },
      },
      tags: ['sound-visualization', 'harmonic'],
    });
  });
  const listenerId = `entity/${slug}/listener`;
  entities.push({
    id: listenerId,
    kind: 'empty',
    name: `${name} Listener`,
    parentId: vizId,
    transform: identityTransform([listenerPosition[0] * 0.45, 0.34 + listenerPosition[1] * 0.35, -0.08 + listenerPosition[2] * 0.35]),
    tags: ['sound', 'listener'],
  });
  entities.push({
    id: `entity/${slug}/listener-marker`,
    kind: 'mesh',
    name: `${name} Listener Marker`,
    parentId: listenerId,
    transform: identityTransform(),
    components: { mesh: { geometryId: `geometry/${slug}/listener`, materialId: `material/${slug}/listener` } },
    tags: ['sound-visualization', 'listener'],
  });
  const duration = evaluation.digest?.duration ?? evaluation.duration ?? 2;
  for (const voice of voices) {
    const sourceId = `entity/${slug}/source/${voice.slug}`;
    const pose = voicePose(voice, duration);
    const stemHeight = Math.max(0.08, pose.position[1] - 0.08);
    entities.push({
      id: sourceId,
      kind: 'audioSource',
      name: voice.name,
      parentId: vizId,
      transform: identityTransform(pose.position, [0, 0, 0], pose.scale),
      components: {
        audio: { enabled: true, volume: voice.volume ?? 1, loop: false, audioId: voice.audioId },
      },
      tags: ['sound', 'audio-source'],
      metadata: {
        voice: {
          ...(voice.waveform ? { waveform: voice.waveform } : {}),
          ...(Number.isFinite(voice.frequency) ? { frequency: voice.frequency } : {}),
          ...(Number.isFinite(voice.startTime) ? { startTime: voice.startTime } : {}),
          kind: voice.kind ?? 'source',
        },
      },
    });
    entities.push({
      id: `${sourceId}/marker`,
      kind: 'mesh',
      name: `${voice.name} Marker`,
      parentId: sourceId,
      transform: identityTransform(),
      components: { mesh: { geometryId: `geometry/${slug}/source-marker`, materialId: `material/${slug}/source` } },
      tags: ['sound-visualization', 'audio-source'],
    });
    entities.push({
      id: `${sourceId}/stem`,
      kind: 'mesh',
      name: `${voice.name} Stem`,
      parentId: sourceId,
      transform: identityTransform([0, -stemHeight / (2 * pose.scale[1]), 0], [0, 0, 0], [1 / pose.scale[0], stemHeight / (0.2 * pose.scale[1]), 1 / pose.scale[2]]),
      components: { mesh: { geometryId: `geometry/${slug}/source-stem`, materialId: `material/${slug}/rail` } },
      tags: ['sound-visualization', 'audio-source'],
    });
  }
  return { geometries, materials, entities, rootId, vizId, listenerId };
}
