import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GRAPH_CATALOGS,
  GRAPH_OUTPUTS,
  canonicalGraphString,
  queryGraphCatalog,
  validateGraph,
} from '../src/graphs/index.mjs';

test('v1 catalogs expose the curated shader, texture, and blueprint domains', () => {
  assert.deepEqual(Object.keys(GRAPH_CATALOGS).sort(), ['blueprint', 'shader', 'texture']);
  assert.deepEqual(Object.keys(GRAPH_OUTPUTS.shader), [
    'surface', 'baseColor', 'roughness', 'metalness', 'normal', 'emissive', 'opacity', 'alphaTest', 'positionOffset',
  ]);

  for (const type of [
    'constant', 'image', 'uv', 'worldPosition', 'gradient', 'checker', 'valueNoise', 'fbm',
    'voronoi', 'colorRamp', 'arithmetic', 'mix', 'remap', 'warp', 'blur',
    'normalFromHeight', 'channelPack',
  ]) assert.ok(GRAPH_CATALOGS.texture.nodes[type], `missing texture node ${type}`);

  for (const type of [
    'event.onStart', 'event.onInput', 'time.timer', 'flow.branch', 'flow.boundedLoop',
    'state.get', 'state.set', 'event.emit', 'entity.getProperty', 'entity.setProperty',
    'transform.translate', 'visibility.set', 'entity.spawn', 'entity.destroy', 'entity.reparent',
    'animation.play', 'audio.play', 'camera.setActive', 'material.setParameter',
    'layout.array', 'layout.grid', 'layout.scatter', 'layout.alongCurve',
    'prefab.instantiate', 'script.callExposed',
  ]) assert.ok(GRAPH_CATALOGS.blueprint.nodes[type], `missing blueprint node ${type}`);
});

test('catalog queries are compact, searchable, sorted, and bounded', () => {
  const result = queryGraphCatalog('texture', { search: 'noise', limit: 2 });
  assert.equal(result.domain, 'texture');
  assert.equal(result.returned, 2);
  assert.deepEqual(result.nodes.map((entry) => entry.type), ['fbm', 'valueNoise']);
  assert.deepEqual(result.nodes[0].inputs, { coordinate: 'numeric!' });
  assert.equal('tags' in result.nodes[0], false);

  const selected = queryGraphCatalog('blueprint', { types: ['entity.spawn', 'event.onStart'] });
  assert.deepEqual(selected.nodes.map((entry) => entry.type), ['entity.spawn', 'event.onStart']);
  assert.throws(() => queryGraphCatalog('rawShader'), /Unknown graph domain/);
});

test('canonicalization fills defaults and ignores input ordering', () => {
  const first = {
    formatVersion: 1,
    id: 'shader/wet-stone',
    domain: 'shader',
    nodes: [
      { id: 'rough', type: 'constant.float', params: { value: -0 } },
      { id: 'stone', type: 'constant.color', params: { value: [0.2, 0.3, 0.4] } },
    ],
    edges: [],
    outputs: {
      roughness: { nodeId: 'rough', port: 'value' },
      baseColor: { nodeId: 'stone', port: 'value' },
    },
  };
  const second = {
    outputs: {
      baseColor: { port: 'value', nodeId: 'stone' },
      roughness: { port: 'value', nodeId: 'rough' },
    },
    edges: [],
    nodes: [
      { params: { value: [0.2, 0.3, 0.4] }, type: 'constant.color', id: 'stone' },
      { params: { value: 0 }, type: 'constant.float', id: 'rough' },
    ],
    domain: 'shader',
    id: 'shader/wet-stone',
    formatVersion: 1,
  };
  assert.equal(canonicalGraphString(first), canonicalGraphString(second));
});

test('graph envelopes reject unknown fields and unregistered raw code nodes', () => {
  const raw = {
    formatVersion: 1,
    id: 'shader/raw',
    domain: 'shader',
    nodes: [{ id: 'raw', type: 'raw.wgsl', params: { source: 'eval(1)' } }],
    edges: [],
    outputs: { baseColor: { nodeId: 'raw', port: 'value' } },
    executable: true,
  };
  const validation = validateGraph(raw);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((entry) => entry.code === 'unknown_property'));
  assert.ok(validation.errors.some((entry) => entry.code === 'unknown_node_type'));
});
