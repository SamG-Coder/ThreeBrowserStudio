import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthoringKernel, StudioError, createProjectDocument } from '../src/core/index.mjs';
import { applySchema } from '../src/mcp/tool-schemas.mjs';
import {
  authoredEntityBounds,
  materializeCameraFrameOperation,
  translateToolOperation,
} from '../src/runtime/studio-application.mjs';
import { cameraEulerForDirection, solveCameraFrame } from '../src/core/camera-framing.mjs';

function kernel() {
  let sequence = 0;
  return new AuthoringKernel(createProjectDocument({
    projectId: 'project/camera-frame-operation',
    timestamp: '2026-08-29T00:00:00.000Z',
  }), {
    transactionIdFactory: prefix => `${prefix}/camera-frame-${++sequence}`,
  });
}

function request(baseRevision, idempotencyKey, operations, dryRun = false) {
  return {
    protocolVersion: 'three-studio/1',
    projectId: 'project/camera-frame-operation',
    baseRevision,
    idempotencyKey,
    label: 'Frame persistent camera shot',
    dryRun,
    operations,
  };
}

function forwardFromEulerXyz([x, y]) {
  return [
    -Math.sin(y),
    Math.sin(x) * Math.cos(y),
    -Math.cos(x) * Math.cos(y),
  ];
}

test('camera direction lowering remains exact across both Z hemispheres', () => {
  for (const direction of [
    [0, -0.2, -1],
    [0.62, -0.22, 1],
    [-0.7, 0.3, 0.5],
    [1, 0, 0],
  ]) {
    const length = Math.hypot(...direction);
    const expected = direction.map(component => component / length);
    const actual = forwardFromEulerXyz(cameraEulerForDirection(direction));
    actual.forEach((component, index) => assert.ok(
      Math.abs(component - expected[index]) < 1e-10,
      `direction ${direction.join(',')} axis ${index} expected ${expected[index]} but received ${component}`,
    ));
  }
});

test('camera.frame authors a persistent exact-aspect shot and undo restores camera fields', async () => {
  const subject = kernel();
  await subject.apply(request(0, 'camera-frame-create-0001', [{
    type: 'entity.create',
    sceneId: 'scene/main',
    entity: {
      id: 'camera/tutorial',
      kind: 'perspectiveCamera',
      transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: { camera: { fov: 50, near: 0.1, far: 100 } },
    },
  }]));

  const bounds = { min: [-4, 0, -2], max: [4, 6, 2] };
  const framed = await subject.apply(request(1, 'camera-frame-apply-0002', [{
    type: 'camera.frame',
    cameraId: 'camera/tutorial',
    bounds,
    targetIds: ['camera/tutorial'],
    aspect: 4 / 3,
    padding: 1.2,
    direction: [0.4, -0.2, -1],
    lockPreviewAspect: true,
  }]));
  assert.equal(framed.revision, 2);
  assert.deepEqual(framed.invalidations, ['persistence', 'renderer', 'sceneGraph', 'transforms']);
  const entity = subject.document.scenes['scene/main'].entities['camera/tutorial'];
  assert.notDeepEqual(entity.transform.position, [1, 2, 3]);
  assert.equal(entity.components.camera.presentationAspect, 4 / 3);
  assert.equal(entity.components.camera.framing.fit, 'contain');
  assert.deepEqual(entity.components.camera.framing.bounds, bounds);
  assert.deepEqual(entity.components.camera.framing.targetIds, ['camera/tutorial']);

  await subject.undo({
    protocolVersion: 'three-studio/1', projectId: subject.projectId,
    baseRevision: 2, idempotencyKey: 'camera-frame-undo-0003', label: 'Undo camera shot',
  });
  const restored = subject.document.scenes['scene/main'].entities['camera/tutorial'];
  assert.deepEqual(restored.transform.position, [1, 2, 3]);
  assert.deepEqual(restored.components.camera, { fov: 50, near: 0.1, far: 100 });
});

test('MCP camera.frame is strict and compiled target bounds materialize before the kernel', () => {
  const parsed = applySchema.parse({
    protocolVersion: 'three-studio/1', sessionId: 'session/test',
    projectId: 'project/camera-frame-operation', baseRevision: 0,
    idempotencyKey: 'camera-frame-schema-0001', label: 'Frame target',
    operations: [{
      op: 'camera.frame', cameraId: 'camera/tutorial',
      target: { targetIds: ['subject/a', 'subject/b'] }, aspect: 16 / 9,
    }],
  });
  assert.deepEqual(parsed.operations[0].direction, [0, -0.2, -1]);
  assert.equal(parsed.operations[0].padding, 1.15);
  const translated = translateToolOperation(parsed.operations[0], createProjectDocument({
    projectId: 'project/camera-frame-operation',
  }));

  class Vector {
    constructor(values) { this.values = values; }
    toArray() { return [...this.values]; }
  }
  class Box3 {
    constructor() {
      this.minimum = [Infinity, Infinity, Infinity];
      this.maximum = [-Infinity, -Infinity, -Infinity];
      this.min = new Vector(this.minimum);
      this.max = new Vector(this.maximum);
    }
    expandByObject(object) {
      for (let axis = 0; axis < 3; axis += 1) {
        this.minimum[axis] = Math.min(this.minimum[axis], object.bounds.min[axis]);
        this.maximum[axis] = Math.max(this.maximum[axis], object.bounds.max[axis]);
      }
    }
    isEmpty() { return !Number.isFinite(this.minimum[0]); }
  }
  const compiled = {
    root: { updateWorldMatrix() {} },
    objects: new Map([
      ['subject/a', { bounds: { min: [-2, 0, -1], max: [0, 2, 1] } }],
      ['subject/b', { bounds: { min: [1, -1, -3], max: [4, 5, 2] } }],
    ]),
  };
  const materialized = materializeCameraFrameOperation(translated, { compiled, THREE: { Box3 } });
  assert.deepEqual(materialized.bounds, { min: [-2, -1, -3], max: [4, 5, 2] });
  assert.deepEqual(materialized.targetIds, ['subject/a', 'subject/b']);
  assert.equal(Object.hasOwn(materialized, 'target'), false);

  assert.throws(
    () => applySchema.parse({
      protocolVersion: 'three-studio/1', sessionId: 'session/test',
      projectId: 'project/camera-frame-operation', baseRevision: 0,
      idempotencyKey: 'camera-frame-schema-0002', label: 'Bad camera frame',
      operations: [{
        op: 'camera.frame', cameraId: 'camera/tutorial',
        target: { bounds: { min: [0, 0, 0], max: [1, 1, 1] }, extra: true },
        aspect: 16 / 9,
      }],
    }),
  );
  assert.throws(
    () => materializeCameraFrameOperation({ ...translated, targetIds: ['missing'] }, { compiled, THREE: { Box3 } }),
    error => error instanceof StudioError && error.code === 'camera_frame_target_not_compiled',
  );
});

test('camera composition lowers orbit controls, target offset, distance, and floor safety deterministically', () => {
  const parsed = applySchema.parse({
    protocolVersion: 'three-studio/1', sessionId: 'session/test',
    projectId: 'project/camera-frame-operation', baseRevision: 0,
    idempotencyKey: 'camera-composition-0001', label: 'Compose safe hero shot',
    operations: [{
      op: 'camera.frame', cameraId: 'camera/tutorial', target: { bounds: { min: [-1, 0, -1], max: [1, 2, 1] } },
      aspect: 16 / 9, padding: 1.2,
      view: { azimuth: Math.PI / 4, elevation: 0.3, distanceScale: 1.5, targetOffset: [0, 0.5, 0], minHeight: 0.25 },
    }],
  });
  const translated = translateToolOperation(parsed.operations[0], createProjectDocument({ projectId: 'project/camera-frame-operation' }));
  assert.equal(translated.padding, 1.2);
  assert.equal(translated.distanceScale, 1.5);
  assert.equal(translated.minHeight, 0.25);
  assert.equal(Object.hasOwn(translated, 'view'), false);
  const materialized = materializeCameraFrameOperation(translated);
  assert.deepEqual(materialized.bounds, { min: [-1, 0.5, -1], max: [1, 2.5, 1] });
  assert.equal(Object.hasOwn(materialized, 'targetOffset'), false);
  const framed = solveCameraFrame({ kind: 'perspectiveCamera', camera: { fov: 46 }, ...materialized });
  assert.ok(framed.transform.position[1] >= 0.25);
  const close = applySchema.parse({
    protocolVersion: 'three-studio/1', sessionId: 'session/test',
    projectId: 'project/camera-frame-operation', baseRevision: 0,
    idempotencyKey: 'camera-composition-0002', label: 'Closer shot',
    operations: [{
      op: 'camera.frame', cameraId: 'camera/tutorial', target: { bounds: { min: [-1, 0, -1], max: [1, 2, 1] } },
      aspect: 16 / 9, padding: 1.08,
      view: { azimuth: 0, elevation: 0.2, distanceScale: 0.88 },
    }],
  });
  const closeTranslated = translateToolOperation(close.operations[0], createProjectDocument({ projectId: 'project/camera-frame-operation' }));
  assert.equal(closeTranslated.padding, 1.08);
  assert.equal(closeTranslated.distanceScale, 0.88);
  assert.doesNotThrow(() => solveCameraFrame({
    kind: 'perspectiveCamera', camera: { fov: 46 }, ...materializeCameraFrameOperation(closeTranslated),
  }));
});

test('camera.frame materializes authored recipe bounds for uncompiled targets', () => {
  const document = createProjectDocument({
    projectId: 'project/camera-frame-operation',
    resources: {
      geometries: [{ id: 'geometry/box', recipe: { kind: 'box', width: 2, height: 1, depth: 4 } }],
    },
    scenes: [{
      id: 'scene/main',
      entities: [{
        id: 'entity/new-box',
        kind: 'mesh',
        transform: { position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        components: { mesh: { geometryId: 'geometry/box' } },
      }],
    }],
  });
  const bounds = authoredEntityBounds(document, 'entity/new-box');
  assert.deepEqual(bounds, { min: [-1, 0, -2], max: [1, 1, 2] });
  const materialized = materializeCameraFrameOperation({
    op: 'camera.frame',
    cameraId: 'camera/tutorial',
    targetIds: ['entity/new-box'],
    aspect: 16 / 9,
    padding: 1.15,
  }, { document });
  assert.deepEqual(materialized.bounds, bounds);
});
