import {
  ProjectIndex,
  StudioError,
  contentHash,
  createEntityDocument,
  createResourceDocument,
  mergePatch,
} from '../core/index.mjs';
import { PlainformCompiler } from './plainform-compiler.mjs';
import { PLAINFORM_AST_VERSION, parsePlainformProgram } from './plainform-front-end.mjs';

export const PLAINFORM_DESIGN_SCHEMA_VERSION = 1;
export const PLAINFORM_DESIGN_SOURCE_LIMIT = 32 * 1024;
export const PLAINFORM_DESIGN_OUTPUT_LIMIT = 4_096;

const OWNERSHIP_MODES = new Set(['owned', 'detached', 'referenced']);

function fail(code, message, details = {}) {
  throw new StudioError(code, message, details);
}

function plainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function compactAst(source) {
  const ast = parsePlainformProgram(source);
  return cleanJson({
    ...ast,
    statements: ast.statements.map(({ tokens, ...statement }) => statement),
  });
}

function addEntity(document, sceneId, input) {
  const scene = document.scenes?.[sceneId];
  if (!scene) fail('plainform_design_scene_missing', `Scene ${sceneId} does not exist while preparing the design.`);
  const entity = createEntityDocument(input);
  if (scene.entities[entity.id]) fail('plainform_design_output_conflict', `Design output ${entity.id} already exists.`);
  scene.entities[entity.id] = entity;
  if (entity.parentId) {
    const parent = scene.entities[entity.parentId];
    if (!parent) fail('plainform_design_parent_missing', `Design output ${entity.id} requires missing parent ${entity.parentId}.`);
    if (!parent.children.includes(entity.id)) parent.children = [...parent.children, entity.id];
  } else if (!scene.rootEntityIds.includes(entity.id)) {
    scene.rootEntityIds = [...scene.rootEntityIds, entity.id];
  }
}

function simulateDesignCompilation(document, compiled) {
  const candidate = structuredClone(document);
  const resourceOutputs = [];
  for (const operation of compiled.operations) {
    if (operation.op === 'resource.createMany') {
      for (const item of operation.items) {
        const resource = createResourceDocument(item.resourceType, item.resource);
        if (candidate.resources[item.resourceType]?.[resource.id]) {
          fail('plainform_design_output_conflict', `Design resource output ${resource.id} already exists.`);
        }
        candidate.resources[item.resourceType][resource.id] = resource;
        resourceOutputs.push({ resourceType: item.resourceType, id: resource.id });
      }
      continue;
    }
    if (operation.op === 'resource.create') {
      const resource = createResourceDocument(operation.resourceType, operation.resource);
      if (candidate.resources[operation.resourceType]?.[resource.id]) {
        fail('plainform_design_output_conflict', `Design resource output ${resource.id} already exists.`);
      }
      candidate.resources[operation.resourceType][resource.id] = resource;
      resourceOutputs.push({ resourceType: operation.resourceType, id: resource.id });
      continue;
    }
    if (operation.op === 'entity.create') {
      addEntity(candidate, operation.sceneId, operation.entity);
      continue;
    }
    if (operation.op === 'entity.createMany') {
      for (const item of operation.items) addEntity(candidate, operation.sceneId, item.entity);
      continue;
    }
    fail(
      'plainform_design_external_mutation',
      `Persistent Plainform designs cannot yet own the result of ${operation.op}; author a self-contained Design Plainform program.`,
      { operation: operation.op },
    );
  }
  const rootId = compiled.design?.rootId;
  if (!rootId) fail('plainform_design_dialect_required', 'Persistent designs currently require the Design Plainform dialect.');
  const index = new ProjectIndex(candidate);
  const { scene } = index.getEntity(rootId);
  const entityIds = index.collectSubtree(rootId).sort();
  const outputs = [
    ...entityIds.map(id => ({
      semanticId: `entity.${id}`,
      outputType: 'entity',
      projectId: id,
      hash: contentHash(scene.entities[id]),
      ownership: 'owned',
    })),
    ...resourceOutputs
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ resourceType, id }) => ({
        semanticId: `resource.${id}`,
        outputType: 'resource',
        resourceType,
        projectId: id,
        hash: contentHash(candidate.resources[resourceType][id]),
        ownership: 'owned',
      })),
  ];
  if (outputs.length > PLAINFORM_DESIGN_OUTPUT_LIMIT) {
    fail('plainform_design_output_limit', `Persistent designs support at most ${PLAINFORM_DESIGN_OUTPUT_LIMIT} tracked outputs.`);
  }
  return {
    candidate,
    rootId,
    rootSubtreeHash: index.subtreeHash(rootId),
    outputs,
    parameters: cleanJson(scene.entities[rootId].metadata?.plainformDesign?.variables ?? {}),
  };
}

function collectDependencies(document, simulated, outputs) {
  const outputIds = new Set(outputs.map(output => output.projectId));
  const known = new Set([
    ...new ProjectIndex(document).resources.keys(),
    ...new ProjectIndex(document).entities.keys(),
  ]);
  const dependencies = new Set();
  const visit = value => {
    if (typeof value === 'string') {
      if (known.has(value) && !outputIds.has(value)) dependencies.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (plainRecord(value)) for (const item of Object.values(value)) visit(item);
  };
  const index = new ProjectIndex(simulated.candidate);
  const { scene } = index.getEntity(simulated.rootId);
  for (const id of index.collectSubtree(simulated.rootId)) visit(scene.entities[id]);
  for (const output of outputs) {
    if (output.outputType === 'resource') visit(simulated.candidate.resources[output.resourceType][output.projectId]);
  }
  return [...dependencies].sort();
}

function designResource({ designId, name, source, compiled, document }) {
  const ast = compactAst(source);
  if (ast.dialect !== 'design') {
    fail('plainform_design_dialect_required', 'Persistent designs currently require a source beginning with a Design Plainform header.');
  }
  const simulated = simulateDesignCompilation(document, compiled);
  const dependencies = collectDependencies(document, simulated, simulated.outputs);
  const resource = createResourceDocument('assets', {
    id: designId,
    kind: 'plainformDesign',
    name: name ?? designId.split('/').at(-1),
    schemaVersion: PLAINFORM_DESIGN_SCHEMA_VERSION,
    source,
    ast,
    parameters: simulated.parameters,
    dependencies,
    outputs: simulated.outputs,
    rootId: simulated.rootId,
    rootSubtreeHash: simulated.rootSubtreeHash,
    compiler: {
      language: compiled.language,
      astVersion: PLAINFORM_AST_VERSION,
      dialect: compiled.dialect,
      loweringPlanHash: contentHash(compiled.operations),
    },
    ownership: {
      mode: 'guarded',
      lastAppliedRevision: document.revision + 1,
    },
    evidence: {},
    metadata: { plainformDesign: true },
  });
  resource.designHash = contentHash({
    source: resource.source,
    ast: resource.ast,
    parameters: resource.parameters,
    dependencies: resource.dependencies,
  });
  return { resource, compiled, simulated };
}

export function normalizePlainformDesignResource(resource) {
  if (!plainRecord(resource) || resource.kind !== 'plainformDesign') {
    fail('plainform_design_invalid', 'The requested asset is not a Plainform design resource.');
  }
  if (resource.schemaVersion !== PLAINFORM_DESIGN_SCHEMA_VERSION) {
    fail('plainform_design_schema_unsupported', `Plainform design schema ${String(resource.schemaVersion)} is not supported.`);
  }
  if (typeof resource.source !== 'string' || resource.source.length < 1 || resource.source.length > PLAINFORM_DESIGN_SOURCE_LIMIT) {
    fail('plainform_design_source_invalid', `Plainform design source must contain 1 to ${PLAINFORM_DESIGN_SOURCE_LIMIT} characters.`);
  }
  if (!Array.isArray(resource.outputs) || resource.outputs.length > PLAINFORM_DESIGN_OUTPUT_LIMIT) {
    fail('plainform_design_outputs_invalid', 'Plainform design outputs are missing or exceed the tracked-output limit.');
  }
  const semanticIds = new Set();
  for (const output of resource.outputs) {
    if (!plainRecord(output) || typeof output.semanticId !== 'string' || semanticIds.has(output.semanticId)) {
      fail('plainform_design_outputs_invalid', 'Plainform design outputs require unique semantic IDs.');
    }
    if (!['entity', 'resource'].includes(output.outputType) || typeof output.projectId !== 'string') {
      fail('plainform_design_outputs_invalid', `Plainform output ${output.semanticId} has an invalid target.`);
    }
    if (!OWNERSHIP_MODES.has(output.ownership) || !/^[a-f0-9]{64}$/u.test(output.hash)) {
      fail('plainform_design_outputs_invalid', `Plainform output ${output.semanticId} has invalid ownership or hash data.`);
    }
    semanticIds.add(output.semanticId);
  }
  return resource;
}

function designFromDocument(document, designId, expectedDesignHash) {
  const { resource } = new ProjectIndex(document).getResource(designId, 'assets');
  normalizePlainformDesignResource(resource);
  const actualDesignHash = contentHash(resource);
  if (expectedDesignHash !== actualDesignHash) {
    fail('plainform_design_guard_failed', `Plainform design ${designId} changed after inspection.`, {
      designId, expectedDesignHash, actualDesignHash,
    });
  }
  return resource;
}

function currentOutputHash(document, output) {
  if (output.outputType === 'entity') {
    try {
      return contentHash(new ProjectIndex(document).getEntity(output.projectId).entity);
    } catch (error) {
      if (error?.code === 'not_found') return null;
      throw error;
    }
  }
  const resource = document.resources?.[output.resourceType]?.[output.projectId];
  return resource ? contentHash(resource) : null;
}

function assertOutputsUnchanged(document, design, forcedSemanticIds = new Set()) {
  const conflicts = [];
  for (const output of design.outputs) {
    if (output.ownership !== 'owned') continue;
    const actualHash = currentOutputHash(document, output);
    if (actualHash !== output.hash && !forcedSemanticIds.has(output.semanticId)) {
      conflicts.push({
        semanticId: output.semanticId,
        projectId: output.projectId,
        expectedHash: output.hash,
        actualHash,
        reason: actualHash === null ? 'missing' : 'changed',
      });
    }
  }
  if (conflicts.length) {
    fail('plainform_design_conflict', `Plainform design ${design.id} has ${conflicts.length} output conflict${conflicts.length === 1 ? '' : 's'}.`, {
      designId: design.id,
      conflicts,
    });
  }
}

function preserveDetachedResourceOutputs(compiled, design) {
  const preserved = design.outputs.filter(output => output.ownership !== 'owned');
  const unsupported = preserved.filter(output => output.outputType === 'entity');
  if (unsupported.length) {
    fail(
      'plainform_design_detached_entity_regeneration_unsupported',
      'Regeneration cannot yet preserve detached entities inside the generated root hierarchy.',
      { designId: design.id, semanticIds: unsupported.map(output => output.semanticId) },
    );
  }
  const ids = new Set(preserved.map(output => output.projectId));
  if (!ids.size) return { compiled, preserved };
  const operations = compiled.operations.flatMap(operation => {
    if (operation.op === 'resource.createMany') {
      const items = operation.items.filter(item => !ids.has(item.resource.id));
      return items.length ? [{ ...operation, items }] : [];
    }
    if (operation.op === 'resource.create' && ids.has(operation.resource.id)) return [];
    return [operation];
  });
  return { compiled: { ...compiled, operations }, preserved };
}

function projectWithoutOwnedOutputs(document, design) {
  const shadow = structuredClone(document);
  const index = new ProjectIndex(shadow);
  const { scene, entity: root } = index.getEntity(design.rootId);
  const subtreeIds = index.collectSubtree(root.id);
  if (root.parentId && scene.entities[root.parentId]) {
    scene.entities[root.parentId].children = scene.entities[root.parentId].children.filter(id => id !== root.id);
  } else {
    scene.rootEntityIds = scene.rootEntityIds.filter(id => id !== root.id);
  }
  for (const id of subtreeIds) delete scene.entities[id];
  // Compilation must see the complete generated namespace as vacant. Detached
  // resources are restored after compilation and their create operations are
  // removed from the lowering plan before candidate simulation.
  for (const output of design.outputs) {
    if (output.outputType === 'resource') delete shadow.resources[output.resourceType][output.projectId];
  }
  return shadow;
}

function compileDesign(source, document) {
  if (typeof source !== 'string' || source.length < 1 || source.length > PLAINFORM_DESIGN_SOURCE_LIMIT) {
    fail('plainform_design_source_invalid', `Plainform design source must contain 1 to ${PLAINFORM_DESIGN_SOURCE_LIMIT} characters.`);
  }
  const compiled = new PlainformCompiler().compile(source, { project: document });
  if (compiled.dialect !== 'design') {
    fail('plainform_design_dialect_required', 'Persistent designs currently require Design Plainform source.');
  }
  return compiled;
}

function createExpansion(operation, document) {
  const compiled = compileDesign(operation.source, document);
  const created = designResource({
    designId: operation.designId,
    name: operation.name,
    source: operation.source,
    compiled,
    document,
  });
  return {
    operations: [
      ...compiled.operations,
      { op: 'resource.create', resourceType: 'assets', resource: created.resource },
    ],
    result: {
      action: 'create', designId: operation.designId, designHash: contentHash(created.resource),
      rootId: created.resource.rootId, outputCount: created.resource.outputs.length,
      requestedPreview: compiled.requestedPreview,
    },
  };
}

function regenerateExpansion(operation, document, forcedSemanticIds = new Set()) {
  const design = designFromDocument(document, operation.designId, operation.expectedDesignHash);
  assertOutputsUnchanged(document, design, forcedSemanticIds);
  const source = operation.source ?? design.source;
  const shadow = projectWithoutOwnedOutputs(document, design);
  const prepared = preserveDetachedResourceOutputs(compileDesign(source, shadow), design);
  const compiled = prepared.compiled;
  for (const output of prepared.preserved) {
    shadow.resources[output.resourceType][output.projectId] = structuredClone(
      document.resources[output.resourceType][output.projectId],
    );
  }
  const rebuilt = designResource({
    designId: design.id,
    name: operation.name ?? design.name,
    source,
    compiled,
    document: shadow,
  });
  rebuilt.resource.outputs = [...rebuilt.resource.outputs, ...prepared.preserved]
    .sort((left, right) => left.semanticId.localeCompare(right.semanticId));
  rebuilt.resource.dependencies = [...new Set([
    ...rebuilt.resource.dependencies,
    ...prepared.preserved.map(output => output.projectId),
  ])].sort();
  rebuilt.resource.designHash = contentHash({
    source: rebuilt.resource.source,
    ast: rebuilt.resource.ast,
    parameters: rebuilt.resource.parameters,
    dependencies: rebuilt.resource.dependencies,
  });
  const index = new ProjectIndex(document);
  const resourceDeletes = design.outputs
    .filter(output => output.outputType === 'resource' && output.ownership === 'owned')
    .map(output => ({ op: 'resource.delete', resourceType: output.resourceType, resourceId: output.projectId }));
  const patch = { ...rebuilt.resource };
  delete patch.id;
  return {
    operations: [
      {
        op: 'entity.delete', entityId: design.rootId, recursive: true,
        expectedSubtreeHash: index.subtreeHash(design.rootId),
      },
      ...resourceDeletes,
      ...compiled.operations,
      { op: 'resource.patch', resourceType: 'assets', resourceId: design.id, patch },
    ],
    result: {
      action: operation.op === 'plainform.design.patch' ? 'patch' : 'regenerate',
      designId: design.id,
      previousDesignHash: contentHash(design),
      nextDesignHash: contentHash(mergePatch(design, patch)),
      rootId: rebuilt.resource.rootId,
      outputCount: rebuilt.resource.outputs.length,
      requestedPreview: compiled.requestedPreview,
    },
  };
}

function detachExpansion(operation, document, ownership = 'detached') {
  const design = designFromDocument(document, operation.designId, operation.expectedDesignHash);
  const output = design.outputs.find(item => item.semanticId === operation.semanticId);
  if (!output) fail('plainform_design_output_not_found', `Plainform design ${design.id} has no output ${operation.semanticId}.`);
  const outputs = design.outputs.map(item => item.semanticId === operation.semanticId ? { ...item, ownership } : item);
  return {
    operations: [{
      op: 'resource.patch', resourceType: 'assets', resourceId: design.id,
      patch: { outputs, ownership: { ...design.ownership, mode: 'partially-detached' } },
    }],
    result: { action: ownership, designId: design.id, semanticId: operation.semanticId },
  };
}

function resolveExpansion(operation, document) {
  if (operation.resolution === 'overwrite') {
    return regenerateExpansion(operation, document, new Set([operation.semanticId]));
  }
  if (operation.resolution === 'detach') return detachExpansion(operation, document, 'detached');
  const design = designFromDocument(document, operation.designId, operation.expectedDesignHash);
  const output = design.outputs.find(item => item.semanticId === operation.semanticId);
  if (!output) fail('plainform_design_output_not_found', `Plainform design ${design.id} has no output ${operation.semanticId}.`);
  const hash = currentOutputHash(document, output);
  if (!hash) fail('plainform_design_output_missing', `Cannot keep missing Plainform output ${operation.semanticId}.`);
  const outputs = design.outputs.map(item => item.semanticId === operation.semanticId
    ? { ...item, ownership: 'referenced', hash }
    : item);
  return {
    operations: [{
      op: 'resource.patch', resourceType: 'assets', resourceId: design.id,
      patch: { outputs, ownership: { ...design.ownership, mode: 'partially-detached' } },
    }],
    result: { action: 'keep', designId: design.id, semanticId: operation.semanticId },
  };
}

export function expandPlainformDesignOperation(operation, document) {
  if (operation.op === 'plainform.design.create') return createExpansion(operation, document);
  if (operation.op === 'plainform.design.patch' || operation.op === 'plainform.design.regenerate') {
    return regenerateExpansion(operation, document);
  }
  if (operation.op === 'plainform.design.detachOutput') return detachExpansion(operation, document);
  if (operation.op === 'plainform.design.resolveConflict') return resolveExpansion(operation, document);
  fail('plainform_design_operation_unknown', `Unknown persistent Plainform operation ${operation.op}.`);
}
