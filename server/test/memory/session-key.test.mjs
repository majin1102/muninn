import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionKey } from '../../dist/pipeline/ingest.js';

test('session identity ignores project label when cwd and raw session id match', () => {
  assert.equal(
    sessionKey('raw-session', 'codex', 'default-extractor', {
      project: 'muninn',
      cwd: '/Users/Nathan/workspace/muninn',
    }),
    sessionKey('raw-session', 'codex', 'default-extractor', {
      project: 'renamed-project-label',
      cwd: '/Users/Nathan/workspace/muninn',
    }),
  );
});

test('session identity remains isolated by cwd', () => {
  assert.notEqual(
    sessionKey('raw-session', 'codex', 'default-extractor', {
      project: 'muninn',
      cwd: '/Users/Nathan/workspace/muninn',
    }),
    sessionKey('raw-session', 'codex', 'default-extractor', {
      project: 'muninn',
      cwd: '/Users/Nathan/workspace/other-muninn',
    }),
  );
});
