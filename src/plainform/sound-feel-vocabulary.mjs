const FEELS = Object.freeze([
  { terms: ['muffled', 'dull', 'muted', 'dark'], filter: { type: 'lowpass', frequency: 900, q: 0.55 }, shader: ['dark', 'moody'] },
  { terms: ['warm'], filter: { type: 'lowpass', frequency: 2400, q: 0.6 }, harmonic: { ratio: 2, gain: 0.18 }, shader: ['warm'] },
  { terms: ['hollow'], harmonic: { ratio: 3, gain: 0.22 }, shader: ['cool'] },
  { terms: ['metallic', 'metal'], harmonic: { ratio: 5, gain: 0.12 }, extraHarmonic: { ratio: 7, gain: 0.08 }, shader: ['metallic'] },
  { terms: ['bright', 'brittle', 'crisp', 'thin'], filter: { type: 'highpass', frequency: 380, q: 0.5 }, harmonic: { ratio: 4, gain: 0.12 }, shader: ['bright'] },
  { terms: ['airy', 'air'], noise: { color: 'pink', gain: 0.05 }, shader: ['cool'] },
  { terms: ['noisy', 'hissy'], noise: { color: 'white', gain: 0.04 }, shader: ['bright'] },
  { terms: ['soft', 'gentle'], envelope: { attack: 0.08, release: 0.45 }, shader: ['soft'] },
  { terms: ['plucked', 'percussive'], envelope: { attack: 0.004, decay: 0.22, sustain: 0.05, release: 0.18 }, shader: ['bright'] },
  { terms: ['distant'], filter: { type: 'lowpass', frequency: 1100, q: 0.4 }, gain: 0.7, shader: ['dark'] },
  { terms: ['glowing', 'luminous'], shader: ['glowing', 'neon'] },
  { terms: ['aggressive', 'harsh', 'gritty', 'raspy'], saturate: 2.15, shader: ['bright'] },
]);

const INTENSIFIERS = Object.freeze({
  barely: 0.25, slightly: 0.4, subtly: 0.45, softly: 0.55, moderately: 0.75, very: 1, deeply: 1, strongly: 1, extremely: 1.2,
});

export function interpretSoundFeel(source) {
  let remaining = ` ${String(source ?? '').toLowerCase().replace(/[_/]+/gu, ' ').replace(/[^a-z0-9 -]+/gu, ' ')} `;
  const descriptors = [];
  const shaderTerms = [];
  const result = { filter: null, harmonics: [], noise: null, envelope: null, gain: 1, saturate: null, descriptors, shaderTerms };
  for (const entry of FEELS) {
    for (const term of [...entry.terms].sort((a, b) => b.length - a.length)) {
      const expression = new RegExp(`\\b(?:(barely|slightly|subtly|softly|moderately|very|deeply|strongly|extremely)\\s+)?${term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'iu');
      const match = remaining.match(expression);
      if (!match) continue;
      const amount = INTENSIFIERS[match[1]?.toLowerCase()] ?? 0.82;
      descriptors.push(term);
      if (entry.shader) shaderTerms.push(...entry.shader);
      if (entry.filter) {
        result.filter = {
          type: entry.filter.type,
          frequency: entry.filter.frequency,
          q: entry.filter.q,
          amount,
        };
      }
      if (entry.harmonic) result.harmonics.push({ ...entry.harmonic, gain: entry.harmonic.gain * amount });
      if (entry.extraHarmonic) result.harmonics.push({ ...entry.extraHarmonic, gain: entry.extraHarmonic.gain * amount });
      if (entry.noise) result.noise = { ...entry.noise, gain: entry.noise.gain * amount };
      if (entry.envelope) result.envelope = { ...entry.envelope };
      if (entry.gain) result.gain *= 1 - (1 - entry.gain) * amount;
      if (entry.saturate) result.saturate = entry.saturate * (0.65 + 0.35 * amount);
      remaining = remaining.replace(expression, ' ');
    }
  }
  return Object.freeze({
    ...result,
    descriptors: Object.freeze([...new Set(descriptors)]),
    shaderTerms: Object.freeze([...new Set(shaderTerms)]),
    harmonics: Object.freeze(result.harmonics),
  });
}
