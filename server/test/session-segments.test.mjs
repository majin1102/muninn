import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSessionSegmentsForTests,
  buildSessionTimelineForTests,
  buildSessionTimelinePageForTests,
  buildSessionTurnPageForTests,
  buildTurnDetailForTests,
  buildTurnPreviewForTests,
  resolveSessionTreeNextOffsetForTests,
  resolveSessionNodeFromIndexForTests,
} from '../dist/web/routes.js';

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

function snapshotDoc(content) {
  return {
    snapshotId: 'session:snapshot',
    content,
    createdAt: '2026-06-02T09:00:00.000Z',
    updatedAt: '2026-06-02T11:00:00.000Z',
  };
}

function extractionTimeline(content) {
  return buildSessionTimelineForTests(snapshotDoc(content), turns)
    .filter((item) => item.kind === 'extraction');
}

test('builds snapshot extraction segments in snapshot order', () => {
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

  assert.deepEqual(buildSessionSegmentsForTests(snapshotDoc(snapshot), turns), [
    {
      memoryId: 'turn:2~timeline:0',
      title: '晚一点的问题段落',
      createdAt: '2026-06-02T10:10:00.000Z',
      updatedAt: '2026-06-02T10:10:00.000Z',
    },
    {
      memoryId: 'turn:1~timeline:1',
      title: '更早的问题段落',
      createdAt: '2026-06-02T10:00:00.000Z',
      updatedAt: '2026-06-02T10:00:00.000Z',
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

  assert.deepEqual(buildSessionSegmentsForTests(snapshotDoc(snapshot), turns), [
    {
      memoryId: 'turn:1~timeline:0',
      title: 'Discussion segment navigation',
      createdAt: '2026-06-02T10:00:00.000Z',
      updatedAt: '2026-06-02T10:00:00.000Z',
    },
  ]);
});

test('parses extraction headings when Markdown leaves blank lines after headings', () => {
  const snapshot = [
    '## Extractions',
    '<!-- refs: [turn:1] -->',
    '### Title',
    '',
    'Markdown heading spacing',
    '',
    '### Summary',
    '',
    'The parser should read the summary instead of treating the blank line as the end of the section.',
  ].join('\n');

  assert.deepEqual(extractionTimeline(snapshot), [
    {
      memoryId: 'turn:1~timeline:0',
      kind: 'extraction',
      title: 'Markdown heading spacing',
      createdAt: '2026-06-02T10:00:00.000Z',
      updatedAt: '2026-06-02T10:00:00.000Z',
      markdown: [
        '### Summary',
        '',
        'The parser should read the summary instead of treating the blank line as the end of the section.',
      ].join('\n'),
      refs: ['turn:1'],
    },
  ]);
});

test('builds snapshot timeline with summary, split signals, markdown, and refs', () => {
  const snapshot = [
    '# Session title',
    '',
    '## Summary',
    'Session summary text',
    '',
    '## Instruction Signals',
    '- [2] Write in the session language.',
    '',
    '## Skill Signals',
    '- [1] `prompt-review`: Review prompt wording before applying prompt changes.',
    '',
    '## Skill Details',
    '### `prompt-review`',
    'This hidden detail should not appear in the timeline signals item.',
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

  assert.deepEqual(buildSessionTimelineForTests(snapshotDoc(snapshot), turns), [
    {
      memoryId: 'session:snapshot~timeline:summary',
      kind: 'summary',
      title: 'Summary',
      createdAt: '2026-06-02T09:00:00.000Z',
      updatedAt: '2026-06-02T11:00:00.000Z',
      markdown: 'Session summary text',
      refs: [],
    },
    {
      memoryId: 'session:snapshot~timeline:instructions',
      kind: 'signals',
      title: 'Instructions',
      createdAt: '2026-06-02T09:00:00.000Z',
      updatedAt: '2026-06-02T11:00:00.000Z',
      markdown: '- [2] Write in the session language.',
      refs: [],
    },
    {
      memoryId: 'session:snapshot~timeline:skills',
      kind: 'signals',
      title: 'Skills',
      createdAt: '2026-06-02T09:00:00.000Z',
      updatedAt: '2026-06-02T11:00:00.000Z',
      markdown: '- [1] `prompt-review`: Review prompt wording before applying prompt changes.',
      refs: [],
    },
    {
      memoryId: 'turn:1~timeline:0',
      kind: 'extraction',
      title: 'Prompt budget rules',
      createdAt: '2026-06-02T10:00:00.000Z',
      updatedAt: '2026-06-02T10:00:00.000Z',
      markdown: ['### Summary', 'Summary content.', '', '### Content', '- Keep Markdown bullets.'].join('\n'),
      refs: ['turn:1', 'turn:2'],
    },
    {
      memoryId: 'turn:2~timeline:1',
      kind: 'extraction',
      title: 'Title language',
      createdAt: '2026-06-02T10:10:00.000Z',
      updatedAt: '2026-06-02T10:10:00.000Z',
      markdown: ['### Summary', 'Write in the session language.'].join('\n'),
      refs: ['turn:2'],
    },
  ]);
});

test('does not synthesize turn segments when snapshot has no usable extraction refs', () => {
  assert.deepEqual(buildSessionSegmentsForTests(snapshotDoc('## Extractions\n没有 refs'), turns), []);
});

test('session timeline page segments use snapshot content when available', async () => {
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
  const page = buildSessionTimelinePageForTests({
    snapshot: snapshotDoc(snapshot),
    turnPreviews: turns,
  });

  assert.deepEqual(page.segments, [
    {
      memoryId: 'turn:2~timeline:0',
      title: 'snapshot segment b',
      createdAt: '2026-06-02T10:10:00.000Z',
      updatedAt: '2026-06-02T10:10:00.000Z',
    },
    {
      memoryId: 'turn:1~timeline:1',
      title: 'snapshot segment a',
      createdAt: '2026-06-02T10:00:00.000Z',
      updatedAt: '2026-06-02T10:00:00.000Z',
    },
  ]);
  assert.deepEqual(page.timeline.map((item) => item.title), [
    'snapshot segment b',
    'snapshot segment a',
  ]);
});

test('session turn page only carries paged turns and next offset', () => {
  const page = buildSessionTurnPageForTests({
    turns,
    offset: 0,
    limit: 1,
  });

  assert.equal(page.turns.length, 1);
  assert.equal(page.nextOffset, 1);
  assert.equal('segments' in page, false);
  assert.equal('timeline' in page, false);
});

test('session turn previews keep tool IO as bounded previews only', () => {
  const input = 'x'.repeat(1_000);
  const output = 'y'.repeat(1_200);
  const preview = buildTurnPreviewForTests({
    turnId: 'turn:tool-heavy',
    createdAt: '2026-06-02T10:00:00.000Z',
    updatedAt: '2026-06-02T10:01:00.000Z',
    prompt: 'run command',
    response: 'done',
    events: [
      { type: 'toolCall', id: 'call-1', name: 'exec_command', input },
      { type: 'toolOutput', id: 'call-1', output },
    ],
    artifacts: [],
  });

  assert.equal(preview.toolCalls, undefined);
  assert.equal(preview.events[0].input, undefined);
  assert.equal(preview.events[0].inputPreview.length < input.length, true);
  assert.equal(preview.events[0].inputBytes, Buffer.byteLength(input));
  assert.equal(preview.events[1].output, undefined);
  assert.equal(preview.events[1].outputPreview.length < output.length, true);
  assert.equal(preview.events[1].outputBytes, Buffer.byteLength(output));
});

test('session turn detail preserves full tool IO', () => {
  const input = 'x'.repeat(1_000);
  const output = 'y'.repeat(1_200);
  const detail = buildTurnDetailForTests({
    turnId: 'turn:tool-heavy',
    createdAt: '2026-06-02T10:00:00.000Z',
    updatedAt: '2026-06-02T10:01:00.000Z',
    prompt: 'run command',
    response: 'done',
    events: [
      { type: 'toolCall', id: 'call-1', name: 'exec_command', input },
      { type: 'toolOutput', id: 'call-1', output },
    ],
    artifacts: [],
  });

  assert.equal(detail.events[0].input, input);
  assert.equal(detail.events[1].output, output);
  assert.equal(detail.toolCalls[0].input, input);
  assert.equal(detail.toolCalls[0].output, output);
});

test('session tree pagination follows turn pages even when snapshot segments exist', () => {
  assert.equal(resolveSessionTreeNextOffsetForTests({
    offset: 0,
    limit: 20,
    turnCount: 80,
  }), 20);
  assert.equal(resolveSessionTreeNextOffsetForTests({
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
