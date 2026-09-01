import assert from 'node:assert/strict';
import test from 'node:test';

import { LOCAL_AI_SYSTEM_PROMPT, localAiToolNames, requiredLocalAiTools } from '../src/browser/local-ai-policy.mjs';

test('local AI policy requires the MCP operation matching explicit user intent', () => {
  assert.deepEqual(requiredLocalAiTools('Create a tree using Plainform.'), ['three_studio_apply']);
  assert.deepEqual(requiredLocalAiTools('Please validate the project.'), ['three_studio_validate']);
  assert.deepEqual(requiredLocalAiTools('Render a screenshot.'), ['three_studio_render']);
  assert.deepEqual(requiredLocalAiTools('Enter play mode.'), ['three_studio_play']);
  assert.deepEqual(requiredLocalAiTools('Save the project.'), ['three_studio_project']);
  assert.deepEqual(requiredLocalAiTools('What is selected?'), []);
  assert.deepEqual(localAiToolNames('Create a tree.'), [
    'three_studio_status',
    'three_studio_inspect',
    'three_studio_apply',
    'three_studio_validate',
    'three_studio_render',
  ]);
  assert.deepEqual(localAiToolNames('What is selected?'), ['three_studio_status', 'three_studio_inspect']);
  assert.match(LOCAL_AI_SYSTEM_PROMPT, /kernel enforces the full Studio rules/);
  assert.match(LOCAL_AI_SYSTEM_PROMPT, /Call three_studio_apply/);
  assert.ok(LOCAL_AI_SYSTEM_PROMPT.length < 1_000, 'the 4K policy stays compact');
});
