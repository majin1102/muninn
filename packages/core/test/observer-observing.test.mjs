import assert from 'node:assert/strict';
import test from 'node:test';

import { __testing } from '../dist/llm/observing.js';

const { trimContent } = __testing;

test('trimContent leaves content within budget unchanged', () => {
  assert.equal(trimContent('short content', 100), 'short content');
});

test('trimContent keeps head and tail when content exceeds budget', () => {
  const content = `${'a'.repeat(100)}${'b'.repeat(100)}${'c'.repeat(100)}`;
  const trimmed = trimContent(content, 120);

  assert.match(trimmed, /^a+/);
  assert.match(trimmed, /c+$/);
  assert.match(trimmed, /Existing content omitted/);
  assert.ok(trimmed.length <= 140);
});
