import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectDocument } from '../src/core/index.mjs';
import {
  buildExplorerOutline,
  defaultExpandedIds,
  flattenExplorerRows,
} from '../src/viewport/scene-explorer.mjs';

function sampleDocument() {
  return createProjectDocument({
    projectId: 'project/explorer',
    name: 'Explorer',
    scenes: [{
      id: 'scene/stage',
      name: 'Stage',
      rootEntityIds: ['entity/room'],
      entities: [
        {
          id: 'entity/room',
          kind: 'group',
          name: 'Room',
          children: ['entity/table', 'entity/lamp', 'entity/hidden'],
        },
        {
          id: 'entity/table',
          kind: 'mesh',
          name: 'Table',
          parentId: 'entity/room',
        },
        {
          id: 'entity/lamp',
          kind: 'pointLight',
          name: 'Lamp',
          parentId: 'entity/room',
        },
        {
          id: 'entity/hidden',
          kind: 'empty',
          name: 'Hidden',
          parentId: 'entity/room',
          visible: false,
        },
      ],
      rootCollectionIds: ['collection/props'],
      collections: [{
        id: 'collection/props',
        name: 'Props',
        entityIds: ['entity/table', 'entity/lamp'],
      }],
    }],
    activeSceneId: 'scene/stage',
  });
}

test('explorer outline is a compact scene tree, not a second document', () => {
  const outline = buildExplorerOutline(sampleDocument());
  assert.equal(outline.sceneId, 'scene/stage');
  assert.equal(outline.sceneName, 'Stage');
  assert.deepEqual(outline.rootEntityIds, ['entity/room']);
  assert.equal(outline.entities['entity/room'].kind, 'group');
  assert.equal(outline.entities['entity/hidden'].visible, false);
  assert.equal(outline.collections['collection/props'].memberCount, 2);
  assert.equal(outline.entities['entity/table'].children.length, 0);
});

test('flatten walks transform children and keeps collections as their own section', () => {
  const outline = buildExplorerOutline(sampleDocument());
  const rows = flattenExplorerRows(outline);
  assert.deepEqual(rows.map(row => row.id), [
    'scene/stage',
    'entity/room',
    'entity/table',
    'entity/lamp',
    'entity/hidden',
    'section/collections',
    'collection/props',
  ]);
  assert.equal(rows[2].depth, 2);
  assert.equal(rows[2].kindLabel, 'Mesh');
  assert.equal(rows[3].kindLabel, 'Light');
  assert.equal(rows[4].visible, false);
  assert.equal(rows[6].memberCount, 2);
});

test('collapsed groups hide descendants without dropping the collections section', () => {
  const outline = buildExplorerOutline(sampleDocument());
  const expanded = defaultExpandedIds(outline);
  expanded.delete('entity/room');
  const rows = flattenExplorerRows(outline, expanded);
  assert.deepEqual(rows.map(row => row.id), [
    'scene/stage',
    'entity/room',
    'section/collections',
    'collection/props',
  ]);
  assert.equal(rows[1].expandable, true);
  assert.equal(rows[1].expanded, false);
});
