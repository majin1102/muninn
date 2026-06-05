import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSessionObservationsForTests,
  buildSessionSegmentsForTests,
  buildSessionTurnPageForTests,
  resolveSessionTreeNextOffsetForTests,
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

test('uses extraction title heading for segment titles', () => {
  const snapshot = [
    '## Extractions',
    '<!-- refs: [turn:1] -->',
    '### Title',
    'Discussion segment navigation',
    '',
    '### Summary',
    'The tree should show discussion segments instead of every user prompt.',
    '',
    '### Content',
    '- Keep title and summary required.',
  ].join('\n');

  assert.deepEqual(buildSessionSegmentsForTests(snapshot, turns), [
    {
      memoryId: 'turn:1',
      title: 'Discussion segment navigation',
      createdAt: '2026-06-02T10:00:00.000Z',
    },
  ]);
});

test('builds snapshot observations with markdown and refs', () => {
  const snapshot = [
    '# Session title',
    '',
    '## Summary',
    'Session summary text',
    '',
    '## Extractions',
    '<!-- sequence: 1; refs: [turn:1, turn:2] -->',
    '### Title',
    'Prompt budget rules',
    '',
    '### Summary',
    'Summary content.',
    '',
    '### Content',
    '- Keep Markdown bullets.',
    '----',
    '<!-- refs: [turn:2] -->',
    '### Title',
    'Title language',
    '',
    '### Summary',
    'Write in the session language.',
  ].join('\n');

  assert.deepEqual(buildSessionObservationsForTests(snapshot, turns), [
    {
      memoryId: 'turn:1',
      title: 'Prompt budget rules',
      createdAt: '2026-06-02T10:00:00.000Z',
      markdown: ['### Summary', 'Summary content.', '', '### Content', '- Keep Markdown bullets.'].join('\n'),
      refs: ['turn:1', 'turn:2'],
    },
    {
      memoryId: 'turn:2',
      title: 'Title language',
      createdAt: '2026-06-02T10:10:00.000Z',
      markdown: ['### Summary', 'Write in the session language.'].join('\n'),
      refs: ['turn:2'],
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
  assert.deepEqual(page.observations.map((observation) => observation.title), [
    'snapshot segment a',
    'snapshot segment b',
  ]);
  assert.equal(page.turns.length, 1);
  assert.equal(page.nextOffset, null);
});

test('session tree pagination ignores turn nextOffset when snapshot segments exist', () => {
  assert.equal(resolveSessionTreeNextOffsetForTests({
    segmentCount: 1,
    offset: 0,
    limit: 20,
    turnCount: 80,
  }), null);
  assert.equal(resolveSessionTreeNextOffsetForTests({
    segmentCount: 0,
    offset: 0,
    limit: 20,
    turnCount: 80,
  }), 20);
});

test('session node display title prefers sessionIndex title', () => {
  assert.deepEqual(resolveSessionNodeFromIndexForTests({
    sessionId: 'raw-session-id',
    agent: 'codex',
    project: 'muninn',
    cwd: '/Users/Nathan/workspace/muninn',
    latestUpdatedAt: '2026-06-02T12:00:00.000Z',
    snapshotId: 'session:1',
    title: 'Snapshot title',
  }), {
    sessionKey: 'raw-session-id',
    displaySessionId: 'Snapshot title',
    projectKey: 'muninn',
    cwd: '/Users/Nathan/workspace/muninn',
    latestUpdatedAt: '2026-06-02T12:00:00.000Z',
  });
});

test('session node display title ignores generated default snapshot title', () => {
  assert.deepEqual(resolveSessionNodeFromIndexForTests({
    sessionId: '019e5e34-raw-session',
    agent: 'codex',
    project: 'lance',
    cwd: '/Users/Nathan/workspace/lance',
    latestUpdatedAt: '2026-06-02T12:00:00.000Z',
    snapshotId: 'session:1',
    title: 'Session 019e5e34-raw-session',
  }), {
    sessionKey: '019e5e34-raw-session',
    displaySessionId: '019e5e34-raw-session',
    projectKey: 'lance',
    cwd: '/Users/Nathan/workspace/lance',
    latestUpdatedAt: '2026-06-02T12:00:00.000Z',
  });
});
