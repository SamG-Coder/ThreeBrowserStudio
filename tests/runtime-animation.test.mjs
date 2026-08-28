import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AnimationRuntime,
  AnimationValidationError,
  applyAnimationAction,
  compileAnimationAction,
  evaluateAnimationAction,
  resolveAnimationTime,
  validateAnimationResource,
} from '../src/runtime/animation-runtime.mjs';

function positionAction(overrides = {}) {
  return {
    id: 'animation/move-cube',
    kind: 'animation',
    name: 'Move Cube',
    enabled: true,
    autoplay: true,
    fps: 24,
    frameStart: 1,
    frameEnd: 25,
    loop: 'once',
    speed: 1,
    tracks: [{
      targetId: 'entity/cube',
      property: 'transform.position',
      interpolation: 'linear',
      keyframes: [
        { frame: 1, value: [0, 0, 0] },
        { frame: 25, value: [8, 4, -2] },
      ],
    }],
    ...overrides,
  };
}

function vector() {
  return {
    values: [0, 0, 0],
    fromArray(values) { this.values = [...values]; return this; },
  };
}

function animatedObject() {
  return {
    position: vector(),
    rotation: vector(),
    scale: vector(),
    visible: true,
    matrixUpdates: 0,
    updateMatrix() { this.matrixUpdates += 1; },
  };
}

test('compiles frame ranges to local seconds and linearly evaluates typed tracks', () => {
  const action = compileAnimationAction(positionAction(), {
    knownTargetIds: ['entity/cube'],
  });

  assert.equal(action.duration, 1);
  assert.deepEqual(action.tracks[0].times, [0, 1]);
  assert.equal(Object.isFrozen(action), true);
  assert.equal(Object.isFrozen(action.tracks[0].values[0]), true);

  const evaluation = evaluateAnimationAction(action, 0.25);
  assert.equal(evaluation.localTime, 0.25);
  assert.deepEqual(evaluation.samples[0], {
    targetId: 'entity/cube',
    property: 'transform.position',
    value: [2, 1, -0.5],
  });
});

test('supports flat times/values, constant visibility, smooth curves, and bezier tangents', () => {
  const visibility = compileAnimationAction({
    id: 'animation/reveal',
    duration: 2,
    tracks: [{
      targetId: 'entity/cube',
      property: 'visible',
      times: [0, 1, 2],
      values: [false, true, false],
    }],
  });
  assert.equal(evaluateAnimationAction(visibility, 0.999).samples[0].value, false);
  assert.equal(evaluateAnimationAction(visibility, 1).samples[0].value, true);

  const smooth = compileAnimationAction({
    id: 'animation/smooth',
    duration: 1,
    tracks: [{
      targetId: 'entity/cube',
      property: 'transform.scale',
      interpolation: 'smooth',
      times: [0, 1],
      values: [1, 1, 1, 3, 5, 7],
    }],
  });
  assert.deepEqual(evaluateAnimationAction(smooth, 0.25).samples[0].value, [1.3125, 1.625, 1.9375]);

  const bezier = compileAnimationAction({
    id: 'animation/bezier',
    duration: 1,
    tracks: [{
      targetId: 'entity/cube',
      property: 'transform.position',
      interpolation: 'bezier',
      keyframes: [
        { time: 0, value: [0, 0, 0], outTangent: [4, 0, 0] },
        { time: 1, value: [1, 0, 0], inTangent: [0, 0, 0] },
      ],
    }],
  });
  assert.deepEqual(evaluateAnimationAction(bezier, 0.5).samples[0].value, [1, 0, 0]);
});

test('resolves once, repeat, and pingpong timelines deterministically', () => {
  const once = compileAnimationAction(positionAction());
  assert.deepEqual(resolveAnimationTime(once, 2), {
    time: 1,
    cycle: 0,
    direction: 1,
    completed: true,
  });

  const repeat = compileAnimationAction(positionAction({ loop: 'repeat' }));
  assert.equal(resolveAnimationTime(repeat, 2.25).time, 0.25);
  assert.equal(resolveAnimationTime(repeat, -0.25).time, 0.75);

  const pingpong = compileAnimationAction(positionAction({ loop: 'pingpong' }));
  assert.deepEqual(resolveAnimationTime(pingpong, 1.25), {
    time: 0.75,
    cycle: 0,
    direction: -1,
    completed: false,
  });
  assert.equal(resolveAnimationTime(pingpong, 2.25).time, 0.25);
});

test('strict validation rejects expressions, malformed timelines, bad values, and missing targets', () => {
  const invalid = positionAction({
    expression: 'object.position.x = fetch(secret)',
    tracks: [
      {
        targetId: 'entity/missing',
        property: 'position.x',
        interpolation: 'javascript',
        times: [0, 1],
        values: [[0, 0, 0]],
      },
      {
        targetId: 'entity/missing',
        property: 'visible',
        interpolation: 'linear',
        keyframes: [
          { time: 1, value: true },
          { time: 0, value: false },
        ],
      },
    ],
  });
  const validation = validateAnimationResource(invalid, {
    knownTargetIds: ['entity/cube'],
  });
  const codes = new Set(validation.errors.map(entry => entry.code));
  assert.equal(validation.valid, false);
  assert.equal(codes.has('animation_unknown_property'), true);
  assert.equal(codes.has('animation_missing_target'), true);
  assert.equal(codes.has('animation_invalid_property_path'), true);
  assert.equal(codes.has('animation_invalid_interpolation'), true);
  assert.equal(codes.has('animation_keyframe_count_mismatch'), true);
  assert.equal(codes.has('animation_visibility_interpolation_forbidden'), true);
  assert.equal(codes.has('animation_keyframes_not_increasing'), true);
  assert.throws(
    () => compileAnimationAction(invalid),
    error => error instanceof AnimationValidationError
      && error.code === 'animation_invalid'
      && error.diagnostics.length > 0,
  );
});

test('applies canonical properties to Three-like objects and updates matrices once per sample', () => {
  const object = animatedObject();
  const objects = new Map([['entity/cube', object]]);
  const action = compileAnimationAction({
    id: 'animation/object-state',
    duration: 1,
    tracks: [
      {
        targetId: 'entity/cube',
        property: 'transform.position',
        times: [0, 1],
        values: [[0, 0, 0], [2, 4, 6]],
      },
      {
        targetId: 'entity/cube',
        property: 'transform.rotation',
        times: [0, 1],
        values: [[0, 0, 0], [1, 2, 3]],
      },
      {
        targetId: 'entity/cube',
        property: 'visible',
        times: [0, 0.5],
        values: [true, false],
      },
    ],
  });

  const result = applyAnimationAction(action, 0.5, objects);
  assert.equal(result.appliedTracks, 3);
  assert.deepEqual(object.position.values, [1, 2, 3]);
  assert.deepEqual(object.rotation.values, [0.5, 1, 1.5]);
  assert.equal(object.visible, false);
  assert.equal(object.matrixUpdates, 1);

  const staleObjects = new Map([['entity/cube', animatedObject()]]);
  const staleAction = compileAnimationAction({
    id: 'animation/stale-binding',
    duration: 1,
    tracks: [
      {
        targetId: 'entity/cube',
        property: 'transform.position',
        times: [0],
        values: [[9, 9, 9]],
      },
      {
        targetId: 'entity/gone',
        property: 'visible',
        times: [0],
        values: [false],
      },
    ],
  });
  assert.throws(
    () => applyAnimationAction(staleAction, 0, staleObjects),
    error => error.code === 'animation_target_missing',
  );
  assert.deepEqual(staleObjects.get('entity/cube').position.values, [0, 0, 0]);
});

test('runtime autoplay, seek, pause, resume, stop, and one-shot completion are stable', () => {
  const object = animatedObject();
  const runtime = new AnimationRuntime({
    objects: new Map([['entity/cube', object]]),
    actions: [positionAction()],
  });

  assert.equal(runtime.getState('animation/move-cube').playing, true);
  runtime.advance(0.25);
  assert.deepEqual(object.position.values, [2, 1, -0.5]);

  runtime.pause('animation/move-cube');
  runtime.advance(0.25);
  assert.deepEqual(object.position.values, [2, 1, -0.5]);

  runtime.setTime(0.5, { actionId: 'animation/move-cube' });
  assert.deepEqual(object.position.values, [4, 2, -1]);
  runtime.play('animation/move-cube');
  runtime.advance(0.5);
  assert.deepEqual(object.position.values, [8, 4, -2]);
  assert.deepEqual(runtime.getState('animation/move-cube'), {
    actionId: 'animation/move-cube',
    time: 1,
    playing: false,
    completed: true,
    enabled: true,
  });

  runtime.stop('animation/move-cube');
  assert.deepEqual(object.position.values, [0, 0, 0]);
  assert.throws(() => runtime.advance(-1), error => error.code === 'animation_invalid_delta');
});
