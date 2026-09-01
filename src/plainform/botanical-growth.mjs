const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '');

function seeded(seed) {
  let state = seed >>> 0;
  return () => { state += 0x6d2b79f5; let value = state; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4_294_967_296; };
}

function branchPath({ start, angle, length, rise, droop, bend }) {
  const direction = [Math.cos(angle), 0, Math.sin(angle)];
  return [0, 1, 2, 3].map(step => {
    const t = step / 3; const horizontal = length * t;
    return [
      start[0] + direction[0] * horizontal + -direction[2] * bend * Math.sin(Math.PI * t),
      start[1] + rise * t - droop * t * t,
      start[2] + direction[2] * horizontal + direction[0] * bend * Math.sin(Math.PI * t),
    ];
  });
}

export function generateMountainPineSkeleton({ name, height, age, seed, envelope = height * 0.52, sparseNorth = true }) {
  if (!(height >= 1 && height <= 100) || !Number.isSafeInteger(age) || age < 1 || age > 2_000 || !Number.isSafeInteger(seed)) {
    const error = new Error('Botanical pine height, age, and seed are outside bounded limits.'); error.code = 'plainform_botanical_parameters'; throw error;
  }
  const random = seeded(seed); const base = `entity/${slug(name)}`; const tiers = clamp(Math.round(height / 1.35), 4, 12); const paths = [];
  const trunkPoints = Array.from({ length: 9 }, (_, index) => {
    const t = index / 8; const sway = (random() - 0.5) * height * 0.015 * t;
    return [sway, height * t, (random() - 0.5) * height * 0.012 * t];
  });
  paths.push({ semanticId: 'trunk', entityId: `${base}/trunk`, order: 0, parentSemanticId: null, points: trunkPoints, radius: clamp(height * (0.012 + age / 30_000), 0.08, height * 0.04), health: 'live' });
  for (let tier = 0; tier < tiers; tier += 1) {
    const t = tiers === 1 ? 0.5 : tier / (tiers - 1); const y = height * (0.2 + t * 0.72); const count = 3 + ((tier + seed) % 3);
    for (let branch = 0; branch < count; branch += 1) {
      const angle = (tier * GOLDEN_ANGLE + branch * Math.PI * 2 / count + (random() - 0.5) * 0.28) % (Math.PI * 2);
      const northFactor = sparseNorth && Math.sin(angle) > 0.45 ? 0.64 : 1; const crownFactor = 1 - t * 0.48;
      const branchLength = Math.min(envelope * 0.5, height * 0.31 * crownFactor) * northFactor * (0.82 + random() * 0.3);
      const droop = t < 0.45 ? branchLength * (0.1 + (0.45 - t) * 0.28) : 0; const rise = branchLength * (0.08 + t * 0.52);
      const tierId = `tier.${String(tier + 1).padStart(2, '0')}`; const semanticId = `${tierId}.branch.${String(branch + 1).padStart(2, '0')}`;
      const points = branchPath({ start: [0, y, 0], angle, length: branchLength, rise, droop, bend: (random() - 0.5) * branchLength * 0.12 });
      const branchRadius = paths[0].radius * (0.34 - t * 0.15);
      paths.push({ semanticId, entityId: `${base}/${semanticId.replaceAll('.', '-')}`, order: 1, parentSemanticId: 'trunk', points, radius: branchRadius, health: random() < 0.04 ? 'deadwood' : 'live', collar: { continuity: 'boundedG1', rings: 3 } });
      const childCount = 1;
      for (let child = 0; child < childCount; child += 1) {
        const childSemanticId = `${semanticId}.child.${String(child + 1).padStart(2, '0')}`; const startIndex = 1 + child; const start = points[startIndex];
        const childPoints = branchPath({ start, angle: angle + (child ? 0.72 : -0.72), length: branchLength * (0.32 + random() * 0.12), rise: branchLength * 0.16, droop: branchLength * 0.04, bend: 0 });
        paths.push({ semanticId: childSemanticId, entityId: `${base}/${childSemanticId.replaceAll('.', '-')}`, order: 2, parentSemanticId: semanticId, points: childPoints, radius: branchRadius * 0.48, health: 'live', collar: { continuity: 'boundedG1', rings: 3 } });
      }
    }
  }
  if (paths.length > 4_096) { const error = new Error('Botanical growth exceeds the 4,096-node budget.'); error.code = 'plainform_botanical_growth_limit'; throw error; }
  return {
    parameters: { species: 'mountainPine', name, height, age, seed, envelope, sparseNorth, whorlSpacing: height * 0.72 / Math.max(1, tiers - 1), apicalDominance: 0.78, gravityResponse: 0.35, lightResponse: 0.42 },
    paths,
    report: { seed, tiers, pathCount: paths.length, structuralPathCount: paths.length, foliageClusterCount: 0, maximumOrder: 2, estimatedTriangles: paths.reduce((sum, path) => sum + Math.max(16, path.points.length * 8) * 8 * 2, 0), envelope, deterministic: true },
  };
}
