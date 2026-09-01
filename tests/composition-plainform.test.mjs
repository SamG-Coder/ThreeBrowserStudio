import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectDocument } from '../src/core/index.mjs';
import { operationSchema } from '../src/mcp/tool-schemas.mjs';
import { PlainformCompiler } from '../src/plainform/index.mjs';

function project() {
  return createProjectDocument({
    projectId: 'project/composition',
    scenes: [{ id: 'scene/main', entities: [
      { id: 'entity/pine', kind: 'group', name: 'Pine', children: ['entity/pine/trunk', 'entity/pine/crown'] },
      { id: 'entity/pine/trunk', kind: 'mesh', name: 'Trunk', parentId: 'entity/pine', components: { mesh: { geometryId: 'geometry/trunk' } } },
      { id: 'entity/pine/crown', kind: 'mesh', name: 'Crown', parentId: 'entity/pine', transform: { position: [0, 7, 0] }, components: { mesh: { geometryId: 'geometry/crown' } } },
    ] }],
    resources: { geometries: [
      { id: 'geometry/trunk', recipe: { kind: 'cylinder', radius: 0.5, height: 8 } },
      { id: 'geometry/crown', recipe: { kind: 'sphere', radius: 3 } },
    ] },
  });
}

const source = 'Frame the whole pine from slightly below at a 50 millimetre lens. Use late afternoon sun from camera left, soft blue sky fill, a dry grass ground, and enough depth of field to keep the trunk and crown sharp.';

test('Composition Plainform lowers one semantic hero sentence to typed camera, lighting, ground, and appearance operations', () => {
  const compiled = new PlainformCompiler().compile(source, { project: project() });
  assert.equal(compiled.dialect, 'composition');
  assert.equal(compiled.requestedPreview, true);
  assert.ok(compiled.operations.every(operation => operationSchema.safeParse(operation).success));
  const frame = compiled.operations.find(operation => operation.op === 'camera.frame');
  assert.deepEqual(frame.target, { targetIds: ['entity/pine'] });
  assert.equal(frame.view.elevation, -0.12);
  const rig = compiled.operations.find(operation => operation.op === 'lighting.rig.create');
  assert.equal(rig.preset, 'outdoor');
  const settings = compiled.operations.find(operation => operation.op === 'scene.settings.patch').patch;
  assert.equal(settings.fog.mode, 'linear');
  assert.equal(settings.presentation.depthOfField.mode, 'semanticRange');
  const resources = compiled.operations[0].items.map(item => item.resource);
  const presentation = resources.find(resource => resource.kind === 'presentation').presentation;
  assert.deepEqual(presentation.subject.semanticBounds, ['whole', 'trunk', 'crown']);
  assert.ok(Math.abs(presentation.camera.fieldOfViewDegrees - 39.5978) < 0.001);
});

test('Composition Plainform is deterministic across hosts and documents explicit renderer differences', () => {
  const first = new PlainformCompiler().compile(source, { project: project() });
  const second = new PlainformCompiler().compile(source, { project: project() });
  assert.deepEqual(first.operations, second.operations);
  assert.deepEqual(first.composition.diagnostics.map(item => item.code), [
    'PLAINFORM_COMPOSITION_DOF_FALLBACK',
    'PLAINFORM_COMPOSITION_ENVIRONMENT_FALLBACK',
  ]);
  assert.deepEqual(first.composition.diagnostics[1].hosts, ['browser']);
});

test('Composition Plainform rejects ambiguous subjects and unsafe lenses before mutation', () => {
  const duplicate = project(); duplicate.scenes['scene/main'].entities['entity/other-pine'] = { ...duplicate.scenes['scene/main'].entities['entity/pine'], id: 'entity/other-pine', children: [], name: 'Pine' };
  assert.throws(() => new PlainformCompiler().compile(source, { project: duplicate }), error => error.code === 'plainform_composition_subject_ambiguous');
  assert.throws(() => new PlainformCompiler().compile(source.replace('50 millimetre', '5 millimetre'), { project: project() }), error => error.code === 'plainform_composition_lens');
});
