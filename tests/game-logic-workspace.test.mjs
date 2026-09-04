import assert from 'node:assert/strict';
import test from 'node:test';

import { AuthoringKernel, createProjectDocument } from '../src/core/index.mjs';
import {
  GAME_LOGIC_NODE_CATALOG,
  addGameLogicNode,
  applyGameLogicGraph,
  createGameLogicGraph,
  patchGameLogicNode,
  readGameLogicWorkspace,
  removeGameLogicNode,
} from '../src/viewport/game-logic-workspace.mjs';

function project() {
  return createProjectDocument({
    projectId: 'project/game-logic-workspace',
    scenes: [{
      id: 'scene/main', rootEntityIds: ['entity/player'],
      entities: [{ id: 'entity/player', kind: 'gameObject', name: 'Player' }],
    }],
  });
}

function application() {
  const kernel = new AuthoringKernel(project());
  return {
    get document() { return kernel.document; },
    dispatch(name, params) {
      assert.equal(name, 'three_studio_apply');
      return kernel.apply(params);
    },
  };
}

test('GameMaker node catalog exposes every predefined event, condition, and action', () => {
  assert.equal(GAME_LOGIC_NODE_CATALOG.length, 68);
  assert.equal(GAME_LOGIC_NODE_CATALOG.find(node => node.type === 'event.onStart').event, true);
  assert.equal(GAME_LOGIC_NODE_CATALOG.find(node => node.type === 'flow.branch').category, 'flow');
  assert.equal(GAME_LOGIC_NODE_CATALOG.find(node => node.type === 'physics.addForce').category, 'physics');
});

test('event-sheet helpers add, configure, chain, and remove typed nodes', () => {
  const graph = {
    formatVersion: 1, id: 'blueprint/player', domain: 'blueprint',
    nodes: [{ id: 'event/start', type: 'event.onStart', params: {} }], edges: [], outputs: {},
  };
  const added = addGameLogicNode(graph, 'physics.addForce', { entityId: 'entity/player' });
  assert.equal(added.validation.valid, true, JSON.stringify(added.validation.errors));
  assert.deepEqual(added.graph.edges, [{
    from: { nodeId: 'event/start', port: 'out' },
    to: { nodeId: added.nodeId, port: 'in' },
  }]);
  const patched = patchGameLogicNode(added.graph, added.nodeId, {
    params: { space: 'local' }, inputs: { entity: 'entity/player', force: [0, 10, 0] },
  });
  assert.equal(patched.validation.valid, true);
  assert.deepEqual(patched.graph.nodes.find(node => node.id === added.nodeId).inputs.force, [0, 10, 0]);
  const removed = removeGameLogicNode(patched.graph, added.nodeId);
  assert.equal(removed.validation.valid, true);
  assert.equal(removed.graph.edges.length, 0);
});

test('new and edited event sheets use canonical graph and component operations', async () => {
  const app = application();
  let workspace = await createGameLogicGraph(app, 'entity/player');
  assert.equal(workspace.graphs.length, 1);
  assert.equal(workspace.graphs[0].graph.nodes[0].type, 'event.onStart');
  assert.deepEqual(app.document.scenes['scene/main'].entities['entity/player'].components.logic.graphIds, [workspace.graphs[0].id]);
  const added = addGameLogicNode(workspace.graphs[0].graph, 'visibility.set', { entityId: 'entity/player' });
  workspace = await applyGameLogicGraph(app, 'entity/player', workspace.graphs[0].id, added.graph);
  assert.equal(workspace.revision, 2);
  assert.equal(readGameLogicWorkspace(app.document, 'entity/player').graphs[0].graph.nodes.length, 2);
});
