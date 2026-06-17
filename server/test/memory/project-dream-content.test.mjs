import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseProjectDreamSignals,
  validateProjectDreamContent,
} from '../../dist/dreaming/content.js';

test('project dream content parser returns top weighted signals per category', () => {
  const content = [
    '# Project Dream',
    '',
    '## Signals',
    '',
    '### Guidance',
    '- [2] Use minimal schemas.',
    '- [9] Preserve project identifiers exactly.',
    '',
    '### Skills',
    '- [4] Prompt review:',
    '  - Check exact prompt diffs.',
    '',
    '### Open Questions',
    '- [1] Decide whether dreams participate in recall.',
  ].join('\n');

  validateProjectDreamContent(content);
  assert.deepEqual(parseProjectDreamSignals(content, 1), {
    guidance: ['- [9] Preserve project identifiers exactly.'],
    skills: ['- [4] Prompt review:\n  - Check exact prompt diffs.'],
    openQuestions: ['- [1] Decide whether dreams participate in recall.'],
  });
});

test('project dream content rejects refs and session ids', () => {
  assert.throws(
    () => validateProjectDreamContent('# Project Dream\n\n## Signals\n\n### Guidance\n- [1] Keep refs. (refs: session:1)\n\n### Skills\n\n### Open Questions'),
    /must not include session refs/i,
  );
});
