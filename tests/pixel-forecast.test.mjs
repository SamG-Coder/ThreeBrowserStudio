import assert from 'node:assert/strict';
import test from 'node:test';

import { forecastPixelImpact } from '../src/core/index.mjs';

function documentWithGraph(id, graph) {
  return {
    resources: {
      graphs: {
        [id]: { id, kind: 'graph', graph },
      },
    },
  };
}

const velvetGraph = {
  formatVersion: 1,
  id: 'graph/velvet',
  domain: 'shader',
  nodes: [{
    id: 'bsdf',
    type: 'blender.principledBSDF',
    params: {},
    inputs: { roughness: 0.5, sheenWeight: 0, metallic: 0 },
  }],
  edges: [],
  outputs: { surface: { nodeId: 'bsdf', port: 'surface' } },
};

test('catalog-only and below-8-bit socket patches forecast will-not-move', () => {
  const before = documentWithGraph('graph/velvet', velvetGraph);
  const catalogOnly = forecastPixelImpact({
    before,
    operations: [{
      type: 'resource.patch',
      resourceType: 'graphs',
      resourceId: 'graph/velvet',
      patch: { nodeInputs: { bsdf: { weight: 0.2 } } },
    }],
  });
  assert.equal(catalogOnly.verdict, 'will-not-move');
  assert.equal(catalogOnly.sockets[0].live, false);

  const bumpGraph = {
    formatVersion: 1,
    id: 'graph/bump',
    domain: 'shader',
    nodes: [{
      id: 'bump',
      type: 'blender.bump',
      params: {},
      inputs: { strength: 0.08, distance: 0.0008, height: 0.5 },
    }],
    edges: [],
    outputs: { normal: { nodeId: 'bump', port: 'normal' } },
  };
  const bump = forecastPixelImpact({
    before: documentWithGraph('graph/bump', bumpGraph),
    operations: [{
      type: 'resource.patch',
      resourceType: 'graphs',
      resourceId: 'graph/bump',
      patch: { nodeInputs: { bump: { strength: 0.22 } } },
    }],
  });
  assert.equal(bump.verdict, 'will-not-move');
  assert.equal(bump.sockets[0].reason, 'below-8bit');
});

test('live sheen and entity transforms forecast will-move', () => {
  const before = documentWithGraph('graph/velvet', velvetGraph);
  const sheen = forecastPixelImpact({
    before,
    operations: [{
      type: 'resource.patch',
      resourceType: 'graphs',
      resourceId: 'graph/velvet',
      patch: { nodeInputs: { bsdf: { sheenWeight: 0.38 } } },
    }],
  });
  assert.equal(sheen.verdict, 'will-move');
  assert.equal(sheen.sockets[0].live, true);

  const move = forecastPixelImpact({
    before,
    operations: [{ type: 'entity.patch', entityId: 'entity/a', patch: { transform: { position: [1, 0, 0] } } }],
  });
  assert.equal(move.verdict, 'will-move');
});

test('editable-mesh recalculateNormals-only edits forecast will-not-move', () => {
  const forecast = forecastPixelImpact({
    before: { resources: { geometries: {} } },
    operations: [{
      type: 'geometry.edit',
      resourceId: 'geometry/velvet',
      edits: [{ type: 'recalculateNormals' }],
    }],
  });
  assert.equal(forecast.verdict, 'will-not-move');
  assert.equal(forecast.reasons[0].code, 'derived-normals-noop');
});
