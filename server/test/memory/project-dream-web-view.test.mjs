import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProjectDreamProjectsView, buildProjectDreamView } from '../../dist/web/dreaming.js';

test('buildProjectDreamView exposes project dream rows and skill details without metadata', () => {
  const view = buildProjectDreamView(
    'github.com/majin1102/muninn',
    {
      project: 'github.com/majin1102/muninn',
      memorySignals: [
        {
          score: 3,
          text: '修改 prompt 后先清理数据、重新导入、finalize、manual dreaming，再检查 full dream。',
          updatedAt: '2026-06-20T00:00:00.000Z',
          supportTurns: [{
            turnId: 'turn:10',
            createdAt: '2026-06-20T00:00:00.000Z',
            contribution: 3,
            score: 3,
          }],
        },
      ],
      skillSignals: [
        {
          score: 2,
          name: '记忆清库重跑验证',
          summary: '在修改 memory prompt 后做 clean rerun 验证。',
          detail: [
            '#### When to Use',
            '- 修改 memory prompt 后。',
            '',
            '#### Procedure',
            '- 清理数据。',
            '- 重新导入 sessions。',
            '- finalize 后手动触发 dreaming。',
          ].join('\n'),
        },
      ],
    },
    new Map([['turn:10', '用户要求修改 prompt 后清库、重导、finalize，再检查 full dream。']]),
  );

  assert.deepEqual(view.memorySignals, [
    {
      score: 3,
      text: '修改 prompt 后先清理数据、重新导入、finalize、manual dreaming，再检查 full dream。',
      updatedAt: '2026-06-20T00:00:00.000Z',
      supportTurns: [{
        turnId: 'turn:10',
        content: '用户要求修改 prompt 后清库、重导、finalize，再检查 full dream。',
        createdAt: '2026-06-20T00:00:00.000Z',
        contribution: 3,
        score: 3,
      }],
    },
  ]);
  assert.equal('openQuestions' in view, false);
  assert.deepEqual(view.skills, [
    {
      score: 2,
      name: '记忆清库重跑验证',
      summary: '在修改 memory prompt 后做 clean rerun 验证。',
      detail: [
        '#### When to Use',
        '- 修改 memory prompt 后。',
        '',
        '#### Procedure',
        '- 清理数据。',
        '- 重新导入 sessions。',
        '- finalize 后手动触发 dreaming。',
      ].join('\n'),
    },
  ]);
  assert.equal('memoryId' in view, false);
  assert.equal('sessionSnapshotVersion' in view, false);
  assert.equal('createdAt' in view, false);
});

test('buildProjectDreamProjectsView exposes dream project rows only', () => {
  assert.deepEqual(buildProjectDreamProjectsView([
    {
      project: 'github.com/majin1102/muninn',
      latestUpdatedAt: '2026-06-20T00:00:00.000Z',
    },
    {
      project: 'github.com/majin1102/lance',
      latestUpdatedAt: '2026-06-19T00:00:00.000Z',
    },
  ]), [
    {
      project: 'github.com/majin1102/lance',
      latestUpdatedAt: '2026-06-19T00:00:00.000Z',
    },
    {
      project: 'github.com/majin1102/muninn',
      latestUpdatedAt: '2026-06-20T00:00:00.000Z',
    },
  ]);
});
