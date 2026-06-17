import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProjectDreamPrompt, mergeProjectDream } from '../../dist/dreaming/project-dreamer.js';

test('buildProjectDreamPrompt omits session ids and includes parent plus incremental signals', () => {
  const prompt = buildProjectDreamPrompt({
    project: '/repo/muninn',
    parentDream: '# Project Dream\n\n## Signals\n\n### Guidance\n- [2] Keep schemas minimal.\n\n### Skills\n\n### Open Questions',
    incrementalSignals: '- [1] Keep schemas small.',
  });
  assert.match(prompt, /## Parent Dream/);
  assert.match(prompt, /Keep schemas minimal/);
  assert.match(prompt, /## Incremental Signals/);
  assert.match(prompt, /Keep schemas small/);
  assert.doesNotMatch(prompt, /session:<rowid>/);
  assert.doesNotMatch(prompt, /### session:/);
});

test('mergeProjectDream validates LLM Markdown output', async () => {
  const result = await mergeProjectDream({
    project: '/repo/muninn',
    parentDream: '(none)',
    incrementalSignals: '- [1] Keep schemas minimal.',
    model: async () => '# Project Dream\n\n## Signals\n\n### Guidance\n- [1] Keep schemas minimal.\n\n### Skills\n\n### Open Questions',
  });
  assert.match(result, /# Project Dream/);
  assert.match(result, /Keep schemas minimal/);
});
