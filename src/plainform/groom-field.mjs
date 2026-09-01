const TAU = Math.PI * 2;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function unit(seed, index, channel) {
  let value = (seed >>> 0) ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(channel + 1, 0x85ebca77);
  value ^= value >>> 16; value = Math.imul(value, 0x7feb352d); value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b); value ^= value >>> 16;
  return (value >>> 0) / 0x1_0000_0000;
}

const add = (a, b) => a.map((value, axis) => value + b[axis]);
const subtract = (a, b) => a.map((value, axis) => value - b[axis]);
const scale = (value, factor) => value.map(component => component * factor);
const length = value => Math.hypot(...value);
const normalize = value => { const magnitude = length(value); return magnitude > 1e-9 ? scale(value, 1 / magnitude) : [0, 1, 0]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp = (a, b, t) => a.map((value, axis) => value + (b[axis] - value) * t);

function samplePolyline(points, t) {
  const lengths = points.slice(1).map((point, index) => length(subtract(point, points[index])));
  const total = lengths.reduce((sum, value) => sum + value, 0);
  let distance = clamp(t, 0, 1) * total;
  for (let index = 0; index < lengths.length; index += 1) {
    if (distance <= lengths[index] || index === lengths.length - 1) {
      const local = lengths[index] > 1e-9 ? distance / lengths[index] : 0;
      return { position: lerp(points[index], points[index + 1], local), tangent: normalize(subtract(points[index + 1], points[index])) };
    }
    distance -= lengths[index];
  }
  return { position: [...points.at(-1)], tangent: normalize(subtract(points.at(-1), points.at(-2))) };
}

function orientation(direction) {
  const horizontal = Math.hypot(direction[0], direction[2]);
  return [Math.atan2(horizontal, direction[1]), Math.atan2(direction[0], direction[2]), 0];
}

export function generatePineNeedleGroom({ paths, seed, needleLength = 0.09, clusterSize = 7, clustersPerPath = 5, maximumInstances = 8_192 }) {
  if (!Array.isArray(paths) || !Number.isSafeInteger(seed) || !(needleLength > 0) || !Number.isSafeInteger(clusterSize) || clusterSize < 1 || clusterSize > 24) {
    const error = new Error('Pine needle grooming requires paths, an integer seed, positive length, and 1 to 24 needles per cluster.');
    error.code = 'plainform_groom_parameters'; throw error;
  }
  const eligible = paths.filter(path => path.health !== 'deadwood' && path.order >= 1 && path.order <= 3);
  const elements = [];
  for (const path of eligible) {
    for (let cluster = 0; cluster < clustersPerPath; cluster += 1) {
      const fieldIndex = elements.length + cluster;
      const pathT = 0.42 + 0.57 * Math.sqrt((cluster + 0.35 + unit(seed, fieldIndex, 0) * 0.3) / clustersPerPath);
      const sample = samplePolyline(path.points, pathT);
      const helper = Math.abs(sample.tangent[1]) < 0.92 ? [0, 1, 0] : [1, 0, 0];
      const normal = normalize(cross(sample.tangent, helper)); const binormal = normalize(cross(sample.tangent, normal));
      for (let needle = 0; needle < clusterSize && elements.length < maximumInstances; needle += 1) {
        const index = elements.length; const angle = TAU * (needle / clusterSize + unit(seed, index, 1) * 0.11);
        const radial = normalize(add(scale(normal, Math.cos(angle)), scale(binormal, Math.sin(angle))));
        const direction = normalize(add(scale(radial, 0.88), scale(sample.tangent, 0.46 + unit(seed, index, 2) * 0.18)));
        const authoredLength = needleLength * (0.82 + unit(seed, index, 3) * 0.34);
        const position = add(add(sample.position, scale(radial, path.radius * 0.9)), scale(direction, authoredLength * 0.5));
        const semanticId = `${path.semanticId}.foliage.${String(cluster + 1).padStart(2, '0')}.${String(needle + 1).padStart(2, '0')}`;
        elements.push({
          semanticId, parentSemanticId: path.semanticId,
          attachment: { kind: 'path', pathT, radialAngle: angle, health: path.health },
          detailCoordinates: { u: (angle % TAU) / TAU, v: pathT, layer: path.order },
          transform: { position, rotation: orientation(direction), scale: [authoredLength * 0.035, authoredLength, authoredLength * 0.035] },
        });
      }
    }
  }
  return {
    kind: 'groomField', formatVersion: 1, seed, mode: 'instancedNeedles',
    exclusions: [{ property: 'health', equals: 'deadwood' }],
    density: { bias: 'healthyTips', clustersPerPath, clusterSize }, elements,
    report: { instanceCount: elements.length, eligiblePathCount: eligible.length, excludedDeadwoodCount: paths.filter(path => path.health === 'deadwood').length, deterministic: true, boundedBy: maximumInstances },
  };
}

export function cylindricalBotanicalCoordinates(paths) {
  return paths.map(path => ({
    semanticId: path.semanticId, parentSemanticId: path.parentSemanticId,
    coordinateSystem: 'cylindricalPath', seamDirection: '+right',
    stations: path.points.map((point, index) => ({ u: 0, v: path.points.length === 1 ? 0 : index / (path.points.length - 1), position: [...point] })),
  }));
}

export function generateRegionGroomField({ region, description, guideCount, clumping, seed, exclusions = [], sourceGuides = [] }) {
  if (!region?.name || !region.ownerEntityId || !Number.isSafeInteger(guideCount) || guideCount < 2 || guideCount > 256 || !Number.isSafeInteger(seed)) {
    const error = new Error('Region grooming requires a semantic region, 2 to 256 guides, and an integer seed.');
    error.code = 'plainform_groom_parameters'; throw error;
  }
  const clumpStrength = ({ low: 0.2, medium: 0.5, high: 0.8 })[clumping];
  if (clumpStrength === undefined) { const error = new Error('Groom clumping must be low, medium, or high.'); error.code = 'plainform_groom_parameters'; throw error; }
  const sweptBack = /swept-back|swept back/iu.test(description); const short = /\bshort\b/iu.test(description);
  const guides = Array.from({ length: guideCount }, (_, index) => {
    const u = (index + 0.5) / guideCount; const v = unit(seed, index, 7);
    const clump = Math.floor(index * Math.max(2, guideCount / 6) / guideCount);
    const direction = normalize([sweptBack ? (unit(seed, index, 8) - 0.5) * 0.35 : unit(seed, index, 8) - 0.5, 0.82, sweptBack ? -0.75 : unit(seed, index, 9) - 0.5]);
    const authoredLength = (short ? 0.12 : 0.28) * (0.82 + unit(seed, index, 10) * 0.3);
    return {
      semanticId: `${region.name}.groom.guide.${String(index + 1).padStart(3, '0')}`,
      parentSemanticId: region.name,
      attachment: { kind: 'semanticRegion', ownerEntityId: region.ownerEntityId, regionCoordinates: { u, v } },
      detailCoordinates: { u, v, strand: index }, direction, length: authoredLength,
      width: authoredLength * 0.08, bend: sweptBack ? 0.32 : 0.16, clump, clumpStrength,
      interpolation: sourceGuides.length > 1 ? { sourceGuideIds: [...sourceGuides], factor: u } : { mode: 'generatedField' },
    };
  });
  return {
    kind: 'groomField', formatVersion: 1, seed, mode: 'guideOnly', description,
    parent: { region: region.name, ownerEntityId: region.ownerEntityId, definition: structuredClone(region.definition) },
    parameters: { direction: sweptBack ? 'sweptBack' : 'surfaceFlow', density: guideCount, length: short ? 'short' : 'medium', width: 'proportional', bend: sweptBack ? 0.32 : 0.16, clumping, clumpStrength, noise: 0.15 },
    exclusions: exclusions.map(name => ({ semanticRegion: name })), guides,
    report: { guideCount, output: 'guideOnly', deterministic: true, boundedBy: 256 },
  };
}
