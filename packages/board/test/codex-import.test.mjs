import assert from 'node:assert/strict';
import test from 'node:test';
import sessionLabels from '../dist-server/session_labels.js';

const { __testing } = sessionLabels;

test('uses a short display title instead of the internal project-prefixed session id', () => {
  assert.equal(__testing.sessionDisplayTitle('lance/https-github-com-lance-format-lance--019e5e34'), 'https-github-com-lance-format-lance');
  assert.equal(__testing.sessionDisplayTitle('muninn/你当前在啥分支上-019e6e1c'), '你当前在啥分支上');
});

test('keeps large imported sessions collapsed by default', () => {
  assert.equal(__testing.shouldAutoExpandSession(12), true);
  assert.equal(__testing.shouldAutoExpandSession(80), false);
});
