import test from 'node:test';
import assert from 'node:assert/strict';

import * as projectDreamContent from '../../dist/dreaming/content.js';

const {
  calculateProjectSignalScore,
  parseProjectDreamOutput,
  parseProjectDreamSignals,
  parseProjectSignalContent,
  validateProjectDreamContent,
  validateProjectSignalContent,
} = projectDreamContent;

function row(overrides = {}) {
  return {
    dreamingId: overrides.dreamingId ?? 'dreaming:1',
    project: overrides.project ?? '/repo/muninn',
    createdAt: overrides.createdAt ?? '2026-06-18T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-06-18T00:00:00Z',
    content: overrides.content ?? [
      '## Memory Signal',
      'Prefer minimal prompt changes.',
    ].join('\n'),
    supportTurns: overrides.supportTurns ?? [{
      turnId: 'turn:10',
      createdAt: '2026-06-18T00:00:00Z',
      contribution: 1,
    }],
  };
}

test('project signal row content parses memory and skill rows', () => {
  assert.deepEqual(parseProjectSignalContent([
    '## Memory Signal',
    'Prefer minimal prompt changes.',
  ].join('\n')), {
    kind: 'memory',
    content: [
      '## Memory Signal',
      'Prefer minimal prompt changes.',
    ].join('\n'),
  });

  assert.deepEqual(parseProjectSignalContent([
    '## Skill Signal',
    '### 记忆清库验证',
    '',
    'Validate memory prompt changes with a clean rerun.',
    '',
    '#### Procedure',
    '- Clear the active dataset.',
    '- Reimport sessions.',
  ].join('\n')), {
    kind: 'skill',
    skillName: '记忆清库验证',
    content: [
      '## Skill Signal',
      '### 记忆清库验证',
      '',
      'Validate memory prompt changes with a clean rerun.',
      '',
      '#### Procedure',
      '- Clear the active dataset.',
      '- Reimport sessions.',
    ].join('\n'),
  });
});

test('project signal row content rejects old full dream documents and refs', () => {
  for (const content of [
    '# Project Dream: /repo/muninn\n\n## Memory Signals\n- [1] Old.',
    '# Project Signals\n\n[turn:1 +1]\n## Memory Signal\nOld.',
    '## Open Questions\n- unresolved',
    '## Memory Signal\nUse refs: turn:1.',
    '## Memory Signal\n- [1] Old weight.',
  ]) {
    assert.throws(
      () => validateProjectSignalContent(content),
      /project signal|Open Questions|refs|old \[N\]/i,
    );
  }
});

test('project dreamer output parses labeled current signal blocks', () => {
  const blocks = parseProjectDreamOutput([
    '# Project Signals',
    '',
    '[signal:101, turn:300 +1]',
    '## Memory Signal',
    'Prefer focused fixes.',
    '',
    '[signal:102, signal:119, turn:400 +10]',
    '## Skill Signal',
    '### memory-clean-rerun',
    '',
    'Validate memory prompt changes with a clean rerun.',
    '',
    '#### Procedure',
    '- Clear the active dataset.',
  ].join('\n'), {
    signalLabels: ['signal:101', 'signal:102', 'signal:119'],
    turnLabels: ['turn:300 +1', 'turn:400 +10'],
  });

  assert.deepEqual(blocks.map((block) => ({
    labels: block.labels,
    kind: block.kind,
    skillName: block.skillName,
  })), [
    {
      labels: [
        { type: 'signal', signalId: 'signal:101' },
        { type: 'turn', turnId: 'turn:300', contribution: 1 },
      ],
      kind: 'memory',
      skillName: undefined,
    },
    {
      labels: [
        { type: 'signal', signalId: 'signal:102' },
        { type: 'signal', signalId: 'signal:119' },
        { type: 'turn', turnId: 'turn:400', contribution: 10 },
      ],
      kind: 'skill',
      skillName: 'memory-clean-rerun',
    },
  ]);
});

test('project dreamer output ignores unknown labels even when allowed sets are empty', () => {
  const blocks = parseProjectDreamOutput([
    '# Project Signals',
    '',
    '[signal:999, turn:300 +1]',
    '## Memory Signal',
    'Prefer focused fixes.',
  ].join('\n'), {
    signalLabels: [],
    turnLabels: ['turn:300 +1'],
  });

  assert.deepEqual(blocks[0].labels, [
    { type: 'turn', turnId: 'turn:300', contribution: 1 },
  ]);
  assert.throws(
    () => parseProjectDreamOutput([
      '# Project Signals',
      '',
      '[signal:999]',
      '## Memory Signal',
      'Prefer focused fixes.',
    ].join('\n'), {
      signalLabels: [],
      turnLabels: ['turn:300 +1'],
    }),
    /at least one valid label/i,
  );
});

test('project dreamer output rejects invalid labels and old document shape', () => {
  assert.throws(
    () => validateProjectDreamContent('# Project Dream: /repo/muninn\n\n## Memory Signals\n- [1] Old.'),
    /must start with # Project Signals/i,
  );
  assert.throws(
    () => validateProjectDreamContent('# Project Signals: /repo/muninn\n\n[turn:1 +1]\n## Memory Signal\nA.'),
    /must start with # Project Signals/i,
  );
  assert.throws(
    () => validateProjectDreamContent('# Project Signals\n\n## Memory Signal\nMissing labels.'),
    /must start with one label list/i,
  );
  assert.throws(
    () => validateProjectDreamContent('# Project Signals\n\n[foo]\n## Memory Signal\nA.'),
    /invalid project signal label/i,
  );
  assert.throws(
    () => validateProjectDreamContent('# Project Signals\n\n[signal:1]\n## Memory Signal\nA.\n\n[signal:1]\n## Memory Signal\nB.'),
    /duplicate survivor/i,
  );
  assert.throws(
    () => validateProjectDreamContent('# Project Signals\n\n[turn:1 +1, turn:1 +10]\n## Memory Signal\nA.'),
    /duplicate turn evidence/i,
  );
  assert.throws(
    () => validateProjectDreamContent('# Project Signals\n\n[turn:1 +1]\n## Skill Signal\nMissing skill heading.'),
    /must include a ### <skill name>/i,
  );
  assert.throws(
    () => validateProjectSignalContent([
      '## Skill Signal',
      'Summary before the skill name.',
      '### memory-clean-rerun',
      '',
      'Validate memory prompt changes with a clean rerun.',
    ].join('\n')),
    /must include a ### <skill name>/i,
  );
  assert.throws(
    () => validateProjectDreamContent([
      '# Project Signals',
      '',
      '[turn:1 +1]',
      '## Memory Signal',
      'Prefer focused fixes.',
      '',
      '[turn:2 +1]',
      '## Memory Signal',
      'Prefer focused fixes.',
    ].join('\n')),
    /duplicate project signal content/i,
  );
  assert.throws(
    () => validateProjectDreamContent([
      '# Project Signals',
      '',
      '[turn:1 +1]',
      '## Skill Signal',
      '### memory-clean-rerun',
      '',
      'Validate memory prompt changes with a clean rerun.',
      '',
      '[turn:2 +1]',
      '## Skill Signal',
      '### memory-clean-rerun',
      '',
      'Validate memory prompt changes with a clean rerun after prompt changes.',
    ].join('\n')),
    /duplicate Skill Signal name/i,
  );
});

test('project dream signals compute score and sort by score then latest support', () => {
  const now = new Date('2026-06-18T00:00:00Z');
  const oldNormal = row({
    dreamingId: 'dreaming:1',
    content: '## Memory Signal\nOld normal support.',
    supportTurns: [{
      turnId: 'turn:1',
      createdAt: '2026-03-20T00:00:00Z',
      contribution: 1,
    }],
  });
  const pinned = row({
    dreamingId: 'dreaming:2',
    content: '## Memory Signal\nPinned support does not decay.',
    supportTurns: [{
      turnId: 'turn:2',
      createdAt: '2026-03-20T00:00:00Z',
      contribution: 10,
    }],
  });
  const recentSkill = row({
    dreamingId: 'dreaming:3',
    content: [
      '## Skill Signal',
      '### 记忆清库验证',
      '',
      'Validate memory prompt changes with a clean rerun.',
    ].join('\n'),
    supportTurns: [{
      turnId: 'turn:3',
      createdAt: '2026-06-18T00:00:00Z',
      contribution: 1,
    }],
  });

  assert.equal(calculateProjectSignalScore(pinned, now), 10);
  assert.equal(Number(calculateProjectSignalScore(oldNormal, now).toFixed(3)), 0.5);
  assert.deepEqual(parseProjectDreamSignals([oldNormal, pinned, recentSkill], 5, now), {
    project: '/repo/muninn',
    memorySignals: [
      {
        score: 10,
        text: 'Pinned support does not decay.',
        updatedAt: '2026-03-20T00:00:00Z',
        supportTurns: [{
          turnId: 'turn:2',
          createdAt: '2026-03-20T00:00:00Z',
          contribution: 10,
          score: 10,
        }],
      },
      {
        score: 0.5,
        text: 'Old normal support.',
        updatedAt: '2026-03-20T00:00:00Z',
        supportTurns: [{
          turnId: 'turn:1',
          createdAt: '2026-03-20T00:00:00Z',
          contribution: 1,
          score: 0.5,
        }],
      },
    ],
    skillSignals: [{
      score: 1,
      name: '记忆清库验证',
      summary: 'Validate memory prompt changes with a clean rerun.',
      detail: 'Validate memory prompt changes with a clean rerun.',
    }],
  });
});
