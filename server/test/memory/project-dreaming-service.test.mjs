import test from 'node:test';
import assert from 'node:assert/strict';

import { ProjectDreamingService } from '../../dist/dreaming/service.js';
import { ProjectDreamingScheduler } from '../../dist/dreaming/scheduler.js';

function snapshot(overrides) {
  const memorySignals = overrides.memorySignals ?? [];
  const skillSignals = overrides.skillSignals ?? [];
  const skillDetails = Object.hasOwn(overrides, 'skillDetails')
    ? overrides.skillDetails
    : {};
  return {
    snapshotId: overrides.snapshotId,
    sessionId: overrides.sessionId,
    project: overrides.project ?? '/repo/muninn',
    cwd: overrides.cwd ?? '/repo/muninn',
    agent: overrides.agent ?? 'codex',
    snapshotSequence: overrides.snapshotSequence ?? 0,
    createdAt: overrides.createdAt ?? '2026-06-18T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-06-18T00:00:00Z',
    extractor: 'default-extractor',
    title: 'Session',
    summary: 'Session summary',
    memorySignals,
    skillSignals,
    skillDetails: typeof skillDetails === 'string' ? skillDetails : JSON.stringify(skillDetails),
    content: '',
    references: [],
  };
}

function dreamingRow(overrides) {
  return {
    dreamingId: overrides.dreamingId,
    project: overrides.project ?? '/repo/muninn',
    createdAt: overrides.createdAt ?? '2026-06-18T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-06-18T00:00:00Z',
    content: overrides.content,
    supportTurns: overrides.supportTurns ?? [],
  };
}

function createClient({
  snapshots = [],
  snapshotsByVersion = {},
  deltaRows = [],
  sourceVersion = 12,
  deltaVersion = 13,
  dreamingRows = [],
  watermark = null,
  turns = {},
} = {}) {
  const deleted = [];
  const watermarks = [];
  let nextDreamingId = 100;
  const rows = [...dreamingRows];
  const client = {
    turnTable: {
      getTurn: async (turnId) => turns[turnId] ?? null,
    },
    sessionTable: {
      listSnapshotsWithVersion: async (params = {}) => (
        params.version == null
          ? { sourceVersion, rows: snapshots }
          : { sourceVersion: params.version, rows: snapshotsByVersion[params.version] ?? [] }
      ),
      delta: async ({ baselineVersion }) => {
        assert.equal(baselineVersion, watermark?.sessionSnapshotVersion);
        return { sourceVersion: deltaVersion, rows: deltaRows };
      },
    },
    dreamingTable: {
      list: async () => rows,
      append: async ({ row }) => {
        const inserted = { ...row, dreamingId: `dreaming:${nextDreamingId++}` };
        rows.push(inserted);
        return inserted;
      },
      update: async ({ row }) => {
        const index = rows.findIndex((current) => current.dreamingId === row.dreamingId);
        assert.notEqual(index, -1);
        rows[index] = row;
        return row;
      },
      delete: async ({ dreamingIds }) => {
        deleted.push(...dreamingIds);
        for (const id of dreamingIds) {
          const index = rows.findIndex((row) => row.dreamingId === id);
          if (index >= 0) {
            rows.splice(index, 1);
          }
        }
        return { deleted: dreamingIds.length };
      },
      get: async () => null,
      delta: async () => ({ sourceVersion: 0, rows: [] }),
      stats: async () => ({ version: 0, rowCount: rows.length, fragmentCount: 1 }),
      describe: async () => null,
    },
    dreamingProjectTable: {
      list: async () => watermark ? [watermark, ...watermarks] : watermarks,
      get: async ({ project }) => (watermark?.project === project ? watermark : null),
      upsert: async ({ row }) => {
        watermarks.push(row);
      },
    },
    extractionTable: {},
  };
  return { client, rows, deleted, watermarks };
}

test('first dream renders incremental evidence blocks and writes signal rows plus watermark', async () => {
  const { client, watermarks } = createClient({
    sourceVersion: 12,
    snapshots: [
      snapshot({
        snapshotId: 'session:1',
        sessionId: 's1',
        memorySignals: ['- [turn:10 +1] Prefer minimal prompt changes.'],
        skillSignals: ['- [turn:11 +10] 记忆清库验证: Validate memory prompt changes with a clean rerun.'],
        skillDetails: {
          记忆清库验证: '#### Procedure\n- Clear the active dataset.',
        },
      }),
    ],
    turns: {
      'turn:10': { turnId: 'turn:10', createdAt: '2026-06-17T00:00:00Z' },
      'turn:11': { turnId: 'turn:11', createdAt: '2026-06-18T00:00:00Z' },
    },
  });
  const service = new ProjectDreamingService(client, 'default-extractor', {
    now: () => new Date('2026-06-19T00:00:00Z'),
    merge: async ({ existingProjectSignals, incrementalSessionSignals, labels }) => {
      assert.equal(existingProjectSignals, '');
      assert.match(incrementalSessionSignals, /\[turn:10 \+1\]\n## Memory Signal\nPrefer minimal prompt changes\./);
      assert.match(incrementalSessionSignals, /\[turn:11 \+10\]\n## Skill Signal\n### 记忆清库验证/);
      assert.match(incrementalSessionSignals, /#### Procedure/);
      assert.deepEqual(labels, {
        signalLabels: [],
        turnLabels: ['turn:10 +1', 'turn:11 +10'],
      });
      return [
        '# Project Signals',
        '',
        '[turn:10 +1]',
        '## Memory Signal',
        'Prefer minimal prompt changes.',
        '',
        '[turn:11 +10]',
        '## Skill Signal',
        '### 记忆清库验证',
        '',
        'Validate memory prompt changes with a clean rerun.',
        '',
        '#### Procedure',
        '- Clear the active dataset.',
      ].join('\n');
    },
  });

  const result = await service.create('/repo/muninn');

  assert.equal(result.created, true);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map((row) => row.supportTurns.map((turn) => turn.turnId)), [
    ['turn:10'],
    ['turn:11'],
  ]);
  assert.deepEqual(watermarks, [{
    project: '/repo/muninn',
    sessionSnapshotVersion: 12,
    updatedAt: '2026-06-19T00:00:00.000Z',
  }]);
});

test('incremental dream merges existing signal support and deletes omitted rows', async () => {
  const existing = [
    dreamingRow({
      dreamingId: 'dreaming:10',
      content: '## Memory Signal\nPrefer minimal prompt changes.',
      supportTurns: [{ turnId: 'turn:1', createdAt: '2026-06-01T00:00:00Z', contribution: 1 }],
    }),
    dreamingRow({
      dreamingId: 'dreaming:11',
      content: '## Memory Signal\nTask-local stale signal.',
      supportTurns: [{ turnId: 'turn:2', createdAt: '2026-06-02T00:00:00Z', contribution: 1 }],
    }),
  ];
  const { client, deleted, watermarks } = createClient({
    watermark: {
      project: '/repo/muninn',
      sessionSnapshotVersion: 12,
      updatedAt: '2026-06-10T00:00:00Z',
    },
    deltaVersion: 15,
    dreamingRows: existing,
    deltaRows: [
      snapshot({
        snapshotId: 'session:3',
        sessionId: 's1',
        snapshotSequence: 2,
        memorySignals: ['- [turn:3 +1] Prefer subtractive prompt changes.'],
      }),
    ],
    turns: {
      'turn:3': { turnId: 'turn:3', createdAt: '2026-06-18T00:00:00Z' },
    },
  });
  const service = new ProjectDreamingService(client, 'default-extractor', {
    now: () => new Date('2026-06-19T00:00:00Z'),
    merge: async ({ existingProjectSignals, incrementalSessionSignals }) => {
      assert.match(existingProjectSignals, /\[signal:10\]/);
      assert.match(existingProjectSignals, /\[signal:11\]/);
      assert.match(incrementalSessionSignals, /\[turn:3 \+1\]/);
      return [
        '# Project Signals',
        '',
        '[signal:10, turn:3 +1]',
        '## Memory Signal',
        'Prefer subtractive prompt changes.',
      ].join('\n');
    },
  });

  const result = await service.create('/repo/muninn');

  assert.equal(result.created, true);
  assert.deepEqual(deleted, ['dreaming:11']);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].dreamingId, 'dreaming:10');
  assert.equal(result.rows[0].content, '## Memory Signal\nPrefer subtractive prompt changes.');
  assert.deepEqual(result.rows[0].supportTurns.map((turn) => turn.turnId), ['turn:1', 'turn:3']);
  assert.equal(watermarks.at(-1).sessionSnapshotVersion, 15);
});

test('incremental dream skips merge when snapshots have no new evidence labels', async () => {
  const existing = [dreamingRow({
    dreamingId: 'dreaming:10',
    content: '## Memory Signal\nPrefer minimal prompt changes.',
    supportTurns: [],
  })];
  const { client, watermarks } = createClient({
    watermark: {
      project: '/repo/muninn',
      sessionSnapshotVersion: 12,
      updatedAt: '2026-06-10T00:00:00Z',
    },
    dreamingRows: existing,
    snapshotsByVersion: {
      12: [
        snapshot({
          snapshotId: 'session:2',
          sessionId: 's1',
          memorySignals: ['- [turn:1 +1] Prefer minimal prompt changes.'],
        }),
      ],
    },
    deltaRows: [
      snapshot({
        snapshotId: 'session:3',
        sessionId: 's1',
        memorySignals: ['- [turn:1 +1] Prefer minimal prompt changes.'],
      }),
    ],
  });
  const service = new ProjectDreamingService(client, 'default-extractor', {
    now: () => new Date('2026-06-19T00:00:00Z'),
    merge: async () => assert.fail('merge should not run without new evidence'),
  });

  const result = await service.create('/repo/muninn');

  assert.equal(result.created, false);
  assert.deepEqual(result.rows, existing);
  assert.deepEqual(watermarks, [{
    project: '/repo/muninn',
    sessionSnapshotVersion: 13,
    updatedAt: '2026-06-19T00:00:00.000Z',
  }]);
});

test('incremental dream treats higher contribution from the same turn as new evidence', async () => {
  const { client } = createClient({
    watermark: {
      project: '/repo/muninn',
      sessionSnapshotVersion: 12,
      updatedAt: '2026-06-10T00:00:00Z',
    },
    snapshotsByVersion: {
      12: [
        snapshot({
          snapshotId: 'session:2',
          sessionId: 's1',
          memorySignals: ['- [turn:1 +1] Prefer minimal prompt changes.'],
        }),
      ],
    },
    deltaRows: [
      snapshot({
        snapshotId: 'session:3',
        sessionId: 's1',
        memorySignals: ['- [turn:1 +10] Prefer minimal prompt changes.'],
      }),
    ],
    turns: {
      'turn:1': { turnId: 'turn:1', createdAt: '2026-06-18T00:00:00Z' },
    },
  });
  const service = new ProjectDreamingService(client, 'default-extractor', {
    now: () => new Date('2026-06-19T00:00:00Z'),
    merge: async ({ incrementalSessionSignals, labels }) => {
      assert.match(incrementalSessionSignals, /\[turn:1 \+10\]/);
      assert.deepEqual(labels, {
        signalLabels: [],
        turnLabels: ['turn:1 +10'],
      });
      return [
        '# Project Signals',
        '',
        '[turn:1 +10]',
        '## Memory Signal',
        'Prefer minimal prompt changes.',
      ].join('\n');
    },
  });

  const result = await service.create('/repo/muninn');

  assert.equal(result.created, true);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0].supportTurns, [{
    turnId: 'turn:1',
    createdAt: '2026-06-18T00:00:00Z',
    contribution: 10,
  }]);
});

test('dreaming service lists projects with current snapshot signals only', async () => {
  const { client } = createClient({
    snapshots: [
      snapshot({ snapshotId: 'session:1', sessionId: 's1', project: '/repo/a', memorySignals: ['- [turn:1 +1] Keep A.'] }),
      snapshot({ snapshotId: 'session:2', sessionId: 's2', project: '/repo/b', skillDetails: { details: 'details only' } }),
      snapshot({ snapshotId: 'session:3', sessionId: 's3', project: '/repo/c' }),
    ],
  });
  const service = new ProjectDreamingService(client, 'default-extractor');

  assert.deepEqual(await service.projectsWithSignals(), ['/repo/a']);
});

test('dreaming service lists projects from current dreaming rows with watermark updatedAt', async () => {
  const { client } = createClient({
    watermark: {
      project: '/repo/a',
      sessionSnapshotVersion: 12,
      updatedAt: '2026-06-20T00:00:00Z',
    },
    dreamingRows: [
      dreamingRow({
        dreamingId: 'dreaming:1',
        project: '/repo/a',
        updatedAt: '2026-06-19T00:00:00Z',
        content: '## Memory Signal\nA.',
      }),
      dreamingRow({
        dreamingId: 'dreaming:2',
        project: '/repo/b',
        updatedAt: '2026-06-21T00:00:00Z',
        content: '## Memory Signal\nB.',
      }),
    ],
  });
  const service = new ProjectDreamingService(client, 'default-extractor');

  assert.deepEqual(await service.projects(), [
    { project: '/repo/a', latestUpdatedAt: '2026-06-20T00:00:00Z' },
    { project: '/repo/b', latestUpdatedAt: '2026-06-21T00:00:00Z' },
  ]);
});

test('global dreaming scheduler runs all signal projects and logs per-project failures', async () => {
  const created = [];
  const logs = [];
  const scheduler = new ProjectDreamingScheduler({
    intervalMs: 1_800_000,
    listProjects: async () => ['/repo/a', '/repo/b', '/repo/c'],
    createProject: async (project) => {
      created.push(project);
      if (project === '/repo/b') {
        throw new Error('boom');
      }
      return { created: project === '/repo/a', rows: project === '/repo/a' ? [{}] : [] };
    },
    log: async (level, event, details) => logs.push({ level, event, details }),
  });

  await scheduler.runOnce();

  assert.deepEqual(created, ['/repo/a', '/repo/b', '/repo/c']);
  assert.deepEqual(logs.map((entry) => [entry.level, entry.event, entry.details.project, entry.details.rowCount]), [
    ['info', 'project_dream_schedule_result', '/repo/a', 1],
    ['error', 'project_dream_schedule_failed', '/repo/b', undefined],
    ['info', 'project_dream_schedule_result', '/repo/c', 0],
  ]);
});

test('global dreaming scheduler logs and stops when project listing fails', async () => {
  const logs = [];
  const scheduler = new ProjectDreamingScheduler({
    intervalMs: 1_800_000,
    listProjects: async () => {
      throw new Error('list failed');
    },
    createProject: async () => {
      throw new Error('create should not run');
    },
    log: async (level, event, details) => logs.push({ level, event, details }),
  });

  await scheduler.runOnce();

  assert.deepEqual(logs, [{
    level: 'error',
    event: 'project_dream_schedule_list_failed',
    details: { message: 'list failed' },
  }]);
});

test('global dreaming scheduler serializes overlapping runs through one in-flight cycle', async () => {
  let listCalls = 0;
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const scheduler = new ProjectDreamingScheduler({
    intervalMs: 1_800_000,
    listProjects: async () => {
      listCalls += 1;
      return ['/repo/a'];
    },
    createProject: async () => {
      await blocker;
      return { created: true, rows: [] };
    },
    log: async () => {},
  });

  const first = scheduler.runOnce();
  const second = scheduler.runOnce();
  await Promise.resolve();
  release();
  await Promise.all([first, second]);

  assert.equal(listCalls, 1);
});
