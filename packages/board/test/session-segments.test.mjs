import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSessionSegmentsForTests,
  buildSessionTurnPageForTests,
  resolveSessionNodeFromIndexForTests,
} from '../dist-server/app.js';

const turns = [
  {
    memoryId: 'turn:2',
    createdAt: '2026-06-02T10:10:00.000Z',
    updatedAt: '2026-06-02T10:10:00.000Z',
    summary: 'fallback b',
    prompt: 'fallback prompt b',
  },
  {
    memoryId: 'turn:1',
    createdAt: '2026-06-02T10:00:00.000Z',
    updatedAt: '2026-06-02T10:00:00.000Z',
    summary: 'fallback a',
    prompt: 'fallback prompt a',
  },
];

test('builds snapshot extraction segments ordered by first turn createdAt', () => {
  const snapshot = [
    '# muninn',
    '',
    '## Summary',
    'ignored',
    '',
    '## Extractions',
    '<!-- refs: [turn:2] -->',
    '晚一点的问题段落',
    '',
    '<!-- refs: [turn:1, turn:2] -->',
    '更早的问题段落',
  ].join('\n');

  assert.deepEqual(buildSessionSegmentsForTests(snapshot, turns), [
    {
      memoryId: 'turn:1',
      title: '更早的问题段落',
      createdAt: '2026-06-02T10:00:00.000Z',
    },
    {
      memoryId: 'turn:2',
      title: '晚一点的问题段落',
      createdAt: '2026-06-02T10:10:00.000Z',
    },
  ]);
});

test('cleans thread memory extraction markup for segment titles', () => {
  const snapshot = [
    '# lance',
    '',
    '## Summary',
    'ignored',
    '',
    '## Extractions',
    '<!-- refs: [turn:1] -->',
    '[Entity] mock entity',
    '[Fact] observed turn',
    '[Extraction] Prompt: 有说明白用的是 _row_id 而不是 _rowid 来保持兼容性吗， Response: 是的。',
  ].join('\n');

  assert.deepEqual(buildSessionSegmentsForTests(snapshot, turns), [
    {
      memoryId: 'turn:1',
      title: '有说明白用的是 _row_id 而不是 _rowid 来保持兼容性吗，',
      createdAt: '2026-06-02T10:00:00.000Z',
    },
  ]);
});

test('falls back to user prompt list when snapshot has no usable extraction refs', () => {
  assert.deepEqual(buildSessionSegmentsForTests('## Extractions\n没有 refs', turns), [
    {
      memoryId: 'turn:2',
      title: 'fallback prompt b',
      createdAt: '2026-06-02T10:10:00.000Z',
    },
    {
      memoryId: 'turn:1',
      title: 'fallback prompt a',
      createdAt: '2026-06-02T10:00:00.000Z',
    },
  ]);
});

test('session turn page segments use snapshot content when available', async () => {
  const snapshot = [
    '# muninn',
    '',
    '## Extractions',
    '<!-- refs: [turn:2] -->',
    'snapshot segment b',
    '',
    '<!-- refs: [turn:1] -->',
    'snapshot segment a',
  ].join('\n');
  const page = await buildSessionTurnPageForTests({
    turns,
    snapshotContent: snapshot,
    offset: 0,
    limit: 1,
  });

  assert.deepEqual(page.segments, [
    {
      memoryId: 'turn:1',
      title: 'snapshot segment a',
      createdAt: '2026-06-02T10:00:00.000Z',
    },
    {
      memoryId: 'turn:2',
      title: 'snapshot segment b',
      createdAt: '2026-06-02T10:10:00.000Z',
    },
  ]);
  assert.equal(page.turns.length, 1);
  assert.equal(page.nextOffset, 1);
});

test('session node display title prefers sessionIndex title', () => {
  assert.deepEqual(resolveSessionNodeFromIndexForTests({
    sessionId: 'muninn/internal-id',
    agent: 'codex',
    latestUpdatedAt: '2026-06-02T12:00:00.000Z',
    snapshotId: 'session:1',
    title: 'Snapshot title',
  }), {
    sessionKey: 'muninn/internal-id',
    displaySessionId: 'Snapshot title',
    projectKey: 'muninn',
    latestUpdatedAt: '2026-06-02T12:00:00.000Z',
  });
});

test('session node display title ignores generated default snapshot title', () => {
  assert.deepEqual(resolveSessionNodeFromIndexForTests({
    sessionId: 'lance/https-github-com-lance-format-lance--019e5e34',
    agent: 'codex',
    latestUpdatedAt: '2026-06-02T12:00:00.000Z',
    snapshotId: 'session:1',
    title: 'Session lance/https-github-com-lance-format-lance--019e5e34',
  }), {
    sessionKey: 'lance/https-github-com-lance-format-lance--019e5e34',
    displaySessionId: 'https-github-com-lance-format-lance',
    projectKey: 'lance',
    latestUpdatedAt: '2026-06-02T12:00:00.000Z',
  });
});
