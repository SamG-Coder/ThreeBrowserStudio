import assert from 'node:assert/strict';
import test from 'node:test';

import { LOCAL_AI_SYSTEM_PROMPT, requiredLocalAiTools } from '../src/browser/local-ai-policy.mjs';

test('local AI policy requires the MCP operation matching explicit user intent', () => {
  assert.deepEqual(requiredLocalAiTools('Create a tree using Plainform.'), ['three_studio_apply']);
  assert.deepEqual(requiredLocalAiTools('Please validate the project.'), ['three_studio_validate']);
  assert.deepEqual(requiredLocalAiTools('Render a screenshot.'), ['three_studio_render']);
  assert.deepEqual(requiredLocalAiTools('Enter play mode.'), ['three_studio_play']);
  assert.deepEqual(requiredLocalAiTools('Save the project.'), ['three_studio_project']);
  assert.deepEqual(requiredLocalAiTools('What is selected?'), []);
  assert.match(LOCAL_AI_SYSTEM_PROMPT, /same agent rules/);
  assert.match(LOCAL_AI_SYSTEM_PROMPT, /must call three_studio_apply/);
  assert.match(LOCAL_AI_SYSTEM_PROMPT, /never merely explain/i);
});
