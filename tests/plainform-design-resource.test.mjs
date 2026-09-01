import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectDocument } from '../src/core/documents.mjs';
import { contentHash } from '../src/core/index.mjs';
import {
  PLAINFORM_DESIGN_SCHEMA_VERSION,
  expandPlainformDesignOperation,
  normalizePlainformDesignResource,
} from '../src/plainform/index.mjs';

function projectFixture() {
  return createProjectDocument({
    projectId: 'project/persistent-plainform',
    scenes: [{ id: 'scene/main', rootEntityIds: [], entities: [] }],
  });
}

const SOURCE = [
  'Design a prop called Persistent Box with id entity/persistent-box.',
  'Create a box called Body with id entity/persistent-body, with width 1 metre, height 2 metres, and depth 1 metre.',
].join('\n');

test('persistent Plainform creation expands to ordinary outputs and one canonical design asset', () => {
  const project = projectFixture();
  const expanded = expandPlainformDesignOperation({
    op: 'plainform.design.create',
    designId: 'design/persistent-box',
    name: 'Persistent Box Design',
    source: SOURCE,
  }, project);

  assert.equal(expanded.result.action, 'create');
  assert.equal(expanded.result.rootId, 'entity/persistent-box');
  const create = expanded.operations.at(-1);
  assert.equal(create.op, 'resource.create');
  assert.equal(create.resourceType, 'assets');
  const design = normalizePlainformDesignResource(create.resource);
  assert.equal(design.schemaVersion, PLAINFORM_DESIGN_SCHEMA_VERSION);
  assert.equal(design.ast.dialect, 'design');
  assert.ok(design.ast.statements.every(statement => !Object.hasOwn(statement, 'tokens')));
  assert.ok(design.outputs.some(output => output.projectId === 'entity/persistent-box'));
  assert.ok(design.outputs.some(output => output.projectId === 'entity/persistent-body'));
  assert.ok(design.outputs.some(output => output.outputType === 'resource'));
  assert.match(design.designHash, /^[a-f0-9]{64}$/u);
  assert.match(contentHash(design), /^[a-f0-9]{64}$/u);
});

test('persistent Plainform design resources reject malformed schema and ownership data', () => {
  assert.throws(
    () => normalizePlainformDesignResource({ kind: 'asset' }),
    error => error.code === 'plainform_design_invalid',
  );
  const project = projectFixture();
  const resource = expandPlainformDesignOperation({
    op: 'plainform.design.create', designId: 'design/persistent-box', source: SOURCE,
  }, project).operations.at(-1).resource;
  assert.throws(
    () => normalizePlainformDesignResource({
      ...resource,
      outputs: [{ ...resource.outputs[0], ownership: 'mystery' }],
    }),
    error => error.code === 'plainform_design_outputs_invalid',
  );
});
