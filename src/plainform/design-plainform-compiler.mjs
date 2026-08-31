import { evaluateDesignExpression, evaluateDesignVector } from './design-expression.mjs';
import { ProjectIndex } from '../core/indexes.mjs';
import { PlainformSpatialResolver } from './spatial-relations.mjs';

const MAX_DESIGN_ENTITIES = 128;
const MAX_LOOP_ITERATIONS = 128;

function clean(value) {
  return value.trim().replace(/[.:;]+$/u, '').trim();
}

function key(value) {
  return clean(value).toLowerCase().replace(/^(?:the|a|an)\s+/u, '').replace(/\s+/gu, ' ');
}

function slug(value) {
  return key(value).replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'design';
}

function quoteName(value) {
  return value.trim().replace(/^"|"$/gu, '');
}

function expectDimension(result, dimension, phrase) {
  if (result.dimension !== dimension && !(result.dimension === 'scalar' && result.value === 0)) {
    const error = new Error(`${phrase} must be ${dimension}, received ${result.dimension}.`);
    error.code = 'plainform_dimension_mismatch';
    throw error;
  }
  return result.value;
}

function finitePositive(value, phrase) {
  if (!Number.isFinite(value) || value <= 0) {
    const error = new Error(`${phrase} must be greater than zero.`);
    error.code = 'plainform_design_dimension';
    throw error;
  }
  return value;
}

function interpolate(value, variables) {
  return value.replace(/\{([^}]+)\}/gu, (_match, expression) => {
    const result = evaluateDesignExpression(expression, variables);
    if (result.dimension !== 'scalar') {
      const error = new Error(`ID interpolation “${expression}” must be scalar.`);
      error.code = 'plainform_dimension_mismatch';
      throw error;
    }
    return Number.isInteger(result.value) ? String(result.value) : String(result.value).replace('.', '-');
  });
}

function rectangularPoints(width, depth, radius = 0) {
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const boundedRadius = Math.max(0, Math.min(radius, halfWidth, halfDepth));
  if (boundedRadius === 0) return [
    [-halfWidth, 0, -halfDepth], [halfWidth, 0, -halfDepth],
    [halfWidth, 0, halfDepth], [-halfWidth, 0, halfDepth],
  ];
  const points = [];
  for (const [cx, cz, start] of [
    [halfWidth - boundedRadius, halfDepth - boundedRadius, 0],
    [-halfWidth + boundedRadius, halfDepth - boundedRadius, Math.PI / 2],
    [-halfWidth + boundedRadius, -halfDepth + boundedRadius, Math.PI],
    [halfWidth - boundedRadius, -halfDepth + boundedRadius, Math.PI * 1.5],
  ]) {
    for (let step = 0; step <= 3; step += 1) {
      const angle = start + step * Math.PI / 6;
      points.push([cx + Math.cos(angle) * boundedRadius, 0, cz + Math.sin(angle) * boundedRadius]);
    }
  }
  return points;
}

function activeScene(project) {
  const sceneId = project.activeSceneId ?? project.sceneOrder?.[0] ?? Object.keys(project.scenes ?? {})[0];
  if (!sceneId || !project.scenes?.[sceneId]) {
    const error = new Error('Design Plainform requires an active scene.');
    error.code = 'plainform_scene_required';
    throw error;
  }
  return project.scenes[sceneId];
}

function occupiedIds(project) {
  const ids = new Set();
  Object.keys(project.scenes ?? {}).forEach(id => ids.add(id));
  for (const scene of Object.values(project.scenes ?? {})) Object.keys(scene.entities ?? {}).forEach(id => ids.add(id));
  for (const resources of Object.values(project.resources ?? {})) Object.keys(resources ?? {}).forEach(id => ids.add(id));
  return ids;
}

/** A bounded parametric solid-design dialect that lowers to canonical resources and batched entities. */
export class DesignPlainformCompiler {
  static canCompile(source) {
    return /^\s*(?:begin\s+)?design\b/iu.test(source);
  }

  compile(source, { project }) {
    const lines = source.split(/\r?\n/u).map(value => value.trim()).filter(Boolean);
    const header = clean(lines[0]).match(/^(?:begin\s+)?design (?:a |an )?(.+?) called (?:(?:"([^"]+)")|(.+?)) with id ([a-z0-9][a-z0-9._/-]*)$/iu);
    if (!header) {
      const error = new Error('A design must begin with “Design a <kind> called <name> with id entity/<id>.”');
      error.code = 'plainform_design_header';
      throw error;
    }
    const scene = activeScene(project);
    const projectIndex = new ProjectIndex(project);
    const spatial = new PlainformSpatialResolver({
      fail(code, message, details) {
        const error = new Error(message); error.code = code; error.details = details; throw error;
      },
    });
    const designKind = header[1].trim();
    const designName = header[2] ?? header[3];
    const rootId = header[4];
    const designSlug = slug(designName);
    const occupied = occupiedIds(project);
    if (occupied.has(rootId)) {
      const error = new Error(`The design root ID ${rootId} already exists.`);
      error.code = 'plainform_id_conflict';
      throw error;
    }

    const variables = new Map();
    const profiles = new Map();
    const entities = [];
    const aliases = { [key(designName)]: [rootId] };
    const interpretations = [`Will create the ${designKind} design “${designName}” as ${rootId}.`];
    const geometryKinds = new Set();
    const lofts = [];
    const ids = new Set([rootId]);
    let requestedPreview = false;
    let autoNumber = 0;

    const evaluate = (expression, scope) => evaluateDesignExpression(clean(expression), scope);
    const length = (expression, scope, phrase) => expectDimension(evaluate(expression, scope), 'length', phrase);
    const scalar = (expression, scope, phrase) => expectDimension(evaluate(expression, scope), 'scalar', phrase);
    const angle = (expression, scope, phrase) => {
      const result = evaluate(expression, scope);
      if (!['angle', 'scalar'].includes(result.dimension)) {
        const error = new Error(`${phrase} must be an angle.`); error.code = 'plainform_dimension_mismatch'; throw error;
      }
      return result.value;
    };
    const referencePoint = phrase => {
      const name = key(phrase);
      const exact = projectIndex.entities.get(clean(phrase)) ?? projectIndex.entities.get(name);
      if (exact) return spatial.position(exact);
      const generatedId = aliases[name]?.[0] ?? clean(phrase);
      const generated = entities.find(entity => entity.id === generatedId);
      if (generated) return [...generated.transform.position];
      const error = new Error(`No exact design reference matches “${phrase}”.`);
      error.code = 'plainform_reference_not_found';
      throw error;
    };
    const addEntity = ({ id, name, kind: primitiveKind, dimensions, position, rotation = [0, 0, 0], materialId }) => {
      if (entities.length >= MAX_DESIGN_ENTITIES) {
        const error = new Error(`Design Plainform creates at most ${MAX_DESIGN_ENTITIES} entities per program.`);
        error.code = 'plainform_design_entity_limit';
        throw error;
      }
      if (!/^[a-z0-9][a-z0-9._/-]*$/u.test(id)) {
        const error = new Error(`Generated entity ID “${id}” is not a stable ID.`); error.code = 'plainform_invalid_id'; throw error;
      }
      if (occupied.has(id) || ids.has(id)) {
        const error = new Error(`Generated entity ID ${id} already exists.`); error.code = 'plainform_id_conflict'; throw error;
      }
      Object.entries(dimensions).forEach(([dimension, value]) => finitePositive(value, `${name} ${dimension}`));
      ids.add(id);
      geometryKinds.add(primitiveKind);
      const geometryId = `geometry/plainform-design/${designSlug}/${primitiveKind}-unit`;
      const scale = primitiveKind === 'box'
        ? [dimensions.width, dimensions.height, dimensions.depth]
        : primitiveKind === 'cylinder'
          ? [dimensions.radius, dimensions.height, dimensions.radius]
          : [dimensions.width, dimensions.height, 1];
      entities.push({
        id, kind: 'mesh', name, parentId: rootId,
        transform: { position, rotation, scale },
        components: { mesh: { geometryId, ...(materialId ? { materialId } : {}) } },
        metadata: { plainformDesign: { primitive: primitiveKind, dimensions } },
      });
      aliases[key(name)] = [id];
    };

    const execute = (start, end, scope) => {
      for (let lineIndex = start; lineIndex < end; lineIndex += 1) {
        const statement = clean(lines[lineIndex]);
        if (/^(?:preview these changes|show me a preview)$/iu.test(statement)) {
          requestedPreview = true;
          interpretations.push('Will request a guarded dry-run preview.');
          continue;
        }
        const distanceStatement = statement.match(/^let (.+?) be (?:the )?distance between (.+?) and (.+)$/iu);
        if (distanceStatement) {
          const from = referencePoint(distanceStatement[2]);
          const to = referencePoint(distanceStatement[3]);
          const distance = Math.hypot(...from.map((value, axis) => value - to[axis]));
          const name = key(distanceStatement[1]);
          scope.set(name, Object.freeze({ value: distance, dimension: 'length' }));
          if (scope === variables) interpretations.push(`Measured ${name} as ${distance} metres between exact references.`);
          continue;
        }
        const letStatement = statement.match(/^let (.+?) be (.+)$/iu);
        if (letStatement) {
          const name = key(letStatement[1]);
          const result = evaluate(letStatement[2], scope);
          scope.set(name, result);
          if (scope === variables) interpretations.push(`Defined ${name} as ${result.value} ${result.dimension}.`);
          continue;
        }
        const profileStatement = statement.match(/^create a rectangular profile called (.+?) with width (.+?) and depth (.+?)(?:,? rounded by (.+))?$/iu);
        if (profileStatement) {
          const name = key(profileStatement[1]);
          const width = finitePositive(length(profileStatement[2], scope, 'Profile width'), 'Profile width');
          const depth = finitePositive(length(profileStatement[3], scope, 'Profile depth'), 'Profile depth');
          const radius = profileStatement[4] ? length(profileStatement[4], scope, 'Profile corner radius') : 0;
          profiles.set(name, { name, width, depth, radius, points: rectangularPoints(width, depth, radius), sections: [] });
          interpretations.push(`Defined rectangular profile “${name}” at ${width} by ${depth} metres.`);
          continue;
        }
        const loop = statement.match(/^for every (?:floor|level|item)?\s*([a-z][a-z0-9_]*) from (.+?) through (.+)$/iu);
        if (loop) {
          let depth = 1;
          let close = lineIndex + 1;
          for (; close < end; close += 1) {
            const nested = clean(lines[close]);
            if (/^for every\b/iu.test(nested)) depth += 1;
            else if (/^end$/iu.test(nested)) depth -= 1;
            if (depth === 0) break;
          }
          if (depth !== 0) { const error = new Error(`Loop on statement ${lineIndex + 1} has no End.`); error.code = 'plainform_missing_end'; throw error; }
          const first = scalar(loop[2], scope, 'Loop start');
          const last = scalar(loop[3], scope, 'Loop end');
          if (![first, last].every(Number.isSafeInteger) || last < first || last - first + 1 > MAX_LOOP_ITERATIONS) {
            const error = new Error(`Design loops require ascending integer bounds and at most ${MAX_LOOP_ITERATIONS} iterations.`);
            error.code = 'plainform_loop_bounds'; throw error;
          }
          for (let index = first; index <= last; index += 1) {
            const inner = new Map(scope);
            inner.set(key(loop[1]), Object.freeze({ value: index, dimension: 'scalar' }));
            inner.set('index', Object.freeze({ value: index, dimension: 'scalar' }));
            inner.set('number', Object.freeze({ value: index - first + 1, dimension: 'scalar' }));
            execute(lineIndex + 1, close, inner);
          }
          interpretations.push(`Evaluated ${last - first + 1} bounded iterations for ${loop[1]}.`);
          lineIndex = close;
          continue;
        }
        if (/^end$/iu.test(statement)) continue;

        const section = statement.match(/^add a section of (.+?) at height (.+?)(?:,? rotated around y by (.+?))?(?:,? and scaled horizontally by (.+))?$/iu);
        if (section) {
          const profile = profiles.get(key(section[1]));
          if (!profile) { const error = new Error(`Unknown profile “${section[1]}”.`); error.code = 'plainform_unknown_profile'; throw error; }
          const height = length(section[2], scope, 'Section height');
          const rotation = section[3] ? angle(section[3], scope, 'Section rotation') : 0;
          const scale = section[4] ? finitePositive(scalar(section[4], scope, 'Section scale'), 'Section scale') : 1;
          profile.sections.push({
            id: `section/${slug(profile.name)}-${String(profile.sections.length + 1).padStart(3, '0')}`,
            points: profile.points,
            transform: { translation: [0, height, 0], rotation: [0, rotation, 0], scale: [scale, 1, scale] },
          });
          continue;
        }

        const plate = statement.match(/^create a floor plate from (.+?) at height (.+?)(?:,? with thickness (.+?))?(?:,? rotated around y by (.+?))?(?:,? and scaled horizontally by (.+))?$/iu);
        if (plate) {
          const profile = profiles.get(key(plate[1]));
          if (!profile) { const error = new Error(`Unknown profile “${plate[1]}”.`); error.code = 'plainform_unknown_profile'; throw error; }
          const height = length(plate[2], scope, 'Floor height');
          const thickness = plate[3] ? finitePositive(length(plate[3], scope, 'Floor thickness'), 'Floor thickness') : 0.2;
          const rotation = plate[4] ? angle(plate[4], scope, 'Floor rotation') : 0;
          const scale = plate[5] ? finitePositive(scalar(plate[5], scope, 'Floor scale'), 'Floor scale') : 1;
          autoNumber += 1;
          addEntity({
            id: `entity/${designSlug}/floor-${String(autoNumber).padStart(3, '0')}`,
            name: `${designName} floor ${autoNumber}`, kind: 'box',
            dimensions: { width: profile.width * scale, height: thickness, depth: profile.depth * scale },
            position: [0, height, 0], rotation: [0, rotation, 0],
          });
          continue;
        }

        const box = statement.match(/^create a box called (.+?)(?: with id ([a-z0-9{}._/-]+))?,? with width (.+?)(?=,\s*height),\s*height (.+?)(?=,\s*(?:and )?depth),\s*(?:and )?depth (.+?)(?=,\s*cent(?:er|r)ed|,\s*rotated|,\s*using material|$)(?:,? cent(?:er|r)ed at (\[.+?\]))?(?:,? rotated by (\[.+?\]))?(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu);
        if (box) {
          autoNumber += 1;
          const name = interpolate(quoteName(box[1]), scope);
          addEntity({
            id: box[2] ? interpolate(box[2], scope) : `entity/${designSlug}/${slug(name)}-${String(autoNumber).padStart(3, '0')}`,
            name, kind: 'box',
            dimensions: {
              width: length(box[3], scope, 'Box width'), height: length(box[4], scope, 'Box height'), depth: length(box[5], scope, 'Box depth'),
            },
            position: box[6] ? evaluateDesignVector(box[6], scope, 'length') : [0, 0, 0],
            rotation: box[7] ? evaluateDesignVector(box[7], scope, 'angle') : [0, 0, 0],
            materialId: box[8],
          });
          continue;
        }

        const cylinder = statement.match(/^create a cylinder called (.+?)(?: with id ([a-z0-9{}._/-]+))?,? with radius (.+?)(?=\s+and height)\s+and height (.+?)(?=,\s*cent(?:er|r)ed|,\s*using material|$)(?:,? cent(?:er|r)ed at (\[.+?\]))?(?:,? using material ([a-z0-9][a-z0-9._/-]*))?$/iu);
        if (cylinder) {
          autoNumber += 1;
          const name = interpolate(quoteName(cylinder[1]), scope);
          addEntity({
            id: cylinder[2] ? interpolate(cylinder[2], scope) : `entity/${designSlug}/${slug(name)}-${String(autoNumber).padStart(3, '0')}`,
            name, kind: 'cylinder',
            dimensions: { radius: length(cylinder[3], scope, 'Cylinder radius'), height: length(cylinder[4], scope, 'Cylinder height') },
            position: cylinder[5] ? evaluateDesignVector(cylinder[5], scope, 'length') : [0, 0, 0],
            materialId: cylinder[6],
          });
          continue;
        }

        const loft = statement.match(/^loft a (?:watertight )?(?:solid )?called (.+?) with id ([a-z0-9][a-z0-9._/-]*) through all sections of (.+)$/iu);
        if (loft) {
          const profile = profiles.get(key(loft[3]));
          if (!profile || profile.sections.length < 2) {
            const error = new Error(`Loft profile “${loft[3]}” requires at least two sections.`); error.code = 'plainform_loft_sections'; throw error;
          }
          const entityId = loft[2];
          const geometryId = `geometry/plainform-design/${designSlug}/${slug(loft[1])}`;
          if (occupied.has(entityId) || ids.has(entityId) || occupied.has(geometryId) || ids.has(geometryId)) {
            const error = new Error(`Loft ID ${entityId} or ${geometryId} already exists.`); error.code = 'plainform_id_conflict'; throw error;
          }
          ids.add(entityId); ids.add(geometryId);
          lofts.push({ entityId, geometryId, name: quoteName(loft[1]), profile });
          aliases[key(loft[1])] = [entityId];
          continue;
        }

        const ensureHeight = statement.match(/^ensure the design is exactly (.+?) high$/iu);
        if (ensureHeight) {
          const expected = length(ensureHeight[1], scope, 'Design height');
          const spans = [
            ...entities.map(entity => [entity.transform.position[1] - entity.transform.scale[1] / 2, entity.transform.position[1] + entity.transform.scale[1] / 2]),
            ...[...profiles.values()].flatMap(profile => profile.sections.map(item => [item.transform.translation[1], item.transform.translation[1]])),
          ];
          if (spans.length === 0) { const error = new Error('Design height cannot be checked before geometry is defined.'); error.code = 'plainform_assertion_empty'; throw error; }
          const actual = Math.max(...spans.map(value => value[1])) - Math.min(...spans.map(value => value[0]));
          if (Math.abs(actual - expected) > 1e-6) {
            const error = new Error(`Design height assertion failed: expected ${expected} metres, calculated ${actual} metres.`);
            error.code = 'plainform_assertion_failed'; error.details = { expected, actual, dimension: 'length' }; throw error;
          }
          interpretations.push(`Verified the design height is ${expected} metres.`);
          continue;
        }
        if (/^ensure every generated object has positive dimensions$/iu.test(statement)) {
          interpretations.push(`Verified positive dimensions for ${entities.length} generated objects.`);
          continue;
        }
        const error = new Error(`I could not understand Design Plainform statement ${lineIndex + 1}: “${statement}”.`);
        error.code = 'plainform_unknown_design_statement'; error.details = { statement: lineIndex + 1, source: statement }; throw error;
      }
    };

    execute(1, lines.length, variables);
    if (entities.length + lofts.length === 0) {
      const error = new Error('A design must create at least one solid or primitive.'); error.code = 'plainform_empty_design'; throw error;
    }

    const resources = [...geometryKinds].map(kind => ({
      resourceType: 'geometries',
      resource: { id: `geometry/plainform-design/${designSlug}/${kind}-unit`, recipe: kind === 'box'
        ? { kind: 'box', width: 1, height: 1, depth: 1 }
        : kind === 'cylinder'
          ? { kind: 'cylinder', radiusTop: 1, radiusBottom: 1, height: 1, radialSegments: 32 }
          : { kind: 'plane', width: 1, height: 1 } },
    }));
    for (const loft of lofts) resources.push({
      resourceType: 'geometries',
      resource: { id: loft.geometryId, recipe: {
        kind: 'loft', sections: loft.profile.sections, closedProfile: true, capStart: true, capEnd: true,
        profileResolution: loft.profile.points.length, subdivisions: 0, alignProfile: 'closest',
      } },
    });
    for (const resource of resources) {
      if (occupied.has(resource.resource.id)) {
        const error = new Error(`Generated geometry ID ${resource.resource.id} already exists.`); error.code = 'plainform_id_conflict'; throw error;
      }
    }
    const variableMetadata = Object.fromEntries([...variables].map(([name, value]) => [name, value]));
    const allEntities = [...entities, ...lofts.map(loft => ({
      id: loft.entityId, kind: 'mesh', name: loft.name, parentId: rootId,
      components: { mesh: { geometryId: loft.geometryId } },
      metadata: { plainformDesign: { primitive: 'loft', profile: loft.profile.name } },
    }))];
    if (allEntities.length > MAX_DESIGN_ENTITIES) {
      const error = new Error(`Design Plainform creates at most ${MAX_DESIGN_ENTITIES} entities per program.`);
      error.code = 'plainform_design_entity_limit';
      throw error;
    }
    const operations = [
      ...(resources.length > 0 ? [{ op: 'resource.createMany', items: resources }] : []),
      { op: 'entity.create', sceneId: scene.id, entity: {
        id: rootId, kind: 'group', name: designName,
        metadata: { plainformDesign: { version: 1, kind: designKind, source, variables: variableMetadata } },
      } },
      { op: 'entity.createMany', sceneId: scene.id, items: allEntities.map(entity => ({ entity })) },
    ];
    interpretations.push(`Will create ${allEntities.length} meshes using ${resources.length} shared or procedural geometries.`);
    return Object.freeze({
      language: 'plainform-v1', dialect: 'design', source,
      operations: Object.freeze(operations), interpretation: Object.freeze(interpretations),
      aliases: Object.freeze(aliases), requestedPreview,
      design: Object.freeze({ rootId, entityCount: allEntities.length, resourceCount: resources.length, variableCount: variables.size }),
    });
  }
}
