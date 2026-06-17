import test from 'node:test';
import assert from 'node:assert/strict';

import { ProjectDreamingService } from '../../dist/dreaming/service.js';
import { DreamingIndex } from '../../dist/dreaming/index.js';

function snapshot(overrides) {
  return {
    snapshotId: overrides.snapshotId,
    sessionId: overrides.sessionId,
    project: overrides.project ?? '/repo/muninn',
    cwd: overrides.cwd ?? '/repo/muninn',
    agent: 'codex',
    snapshotSequence: overrides.snapshotSequence ?? 0,
    createdAt: overrides.createdAt ?? '2026-06-18T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-06-18T00:00:00Z',
    extractor: 'default-observer',
    title: 'Session',
    summary: 'Session summary',
    signals: overrides.signals,
    content: '# Session\n\n## Summary\nSession summary\n\n## Signals\n' + overrides.signals,
    references: [],
  };
}

test('first dream scans current session snapshots and stores scan sourceVersion', async () => {
  const appended = [];
  const client = {
    sessionTable: {
      listSnapshotsWithVersion: async () => ({
        sourceVersion: 12,
        rows: [
          snapshot({ snapshotId: 'session:1', sessionId: 's1', signals: '- [1] Keep schemas minimal.' }),
          snapshot({ snapshotId: 'session:2', sessionId: 's2', signals: '' }),
        ],
      }),
    },
    dreamingTable: {
      append: async ({ row }) => {
        appended.push(row);
        return { ...row, dreamingId: 'dreaming:1' };
      },
      get: async () => null,
      list: async () => [],
      delta: async () => ({ sourceVersion: 0, rows: [] }),
      stats: async () => ({ version: 0, rowCount: 0, fragmentCount: 0 }),
    },
  };
  const service = new ProjectDreamingService(client, new DreamingIndex(null), 'default-observer', {
    merge: async () => '# Project Dream\n\n## Signals\n\n### Guidance\n- [1] Keep schemas minimal.\n\n### Skills\n\n### Open Questions',
  });
  const result = await service.create('/repo/muninn');
  assert.equal(result.created, true);
  assert.equal(appended[0].sessionSnapshotVersion, 12);
});

test('incremental dream reads delta from parent sessionSnapshotVersion and stores delta sourceVersion', async () => {
  const appended = [];
  const parent = {
    dreamingId: 'dreaming:1',
    project: '/repo/muninn',
    parentId: null,
    createdAt: '2026-06-18T00:00:00Z',
    sessionSnapshotVersion: 12,
    content: '# Project Dream\n\n## Signals\n\n### Guidance\n- [1] Keep schemas minimal.\n\n### Skills\n\n### Open Questions',
  };
  const client = {
    sessionTable: {
      delta: async ({ baselineVersion }) => {
        assert.equal(baselineVersion, 12);
        return {
          sourceVersion: 15,
          rows: [
            snapshot({ snapshotId: 'session:3', sessionId: 's1', snapshotSequence: 2, signals: '- [2] Prefer Lance version checkpoints.' }),
          ],
        };
      },
    },
    dreamingTable: {
      append: async ({ row }) => {
        appended.push(row);
        return { ...row, dreamingId: 'dreaming:2' };
      },
      get: async (dreamingId) => dreamingId === 'dreaming:1' ? parent : null,
      list: async () => [parent],
      delta: async () => ({ sourceVersion: 1, rows: [] }),
      stats: async () => ({ version: 1, rowCount: 1, fragmentCount: 1 }),
    },
  };
  const service = new ProjectDreamingService(client, new DreamingIndex({
    baseline: { dreaming: 1 },
    entries: [{ project: '/repo/muninn', dreamingId: 'dreaming:1', createdAt: parent.createdAt, sessionSnapshotVersion: 12 }],
  }), 'default-observer', {
    merge: async ({ parentDream, incrementalSignals }) => {
      assert.match(parentDream, /Keep schemas minimal/);
      assert.match(incrementalSignals, /Prefer Lance version checkpoints/);
      return '# Project Dream\n\n## Signals\n\n### Guidance\n- [2] Prefer Lance version checkpoints.\n- [1] Keep schemas minimal.\n\n### Skills\n\n### Open Questions';
    },
  });
  const result = await service.create('/repo/muninn');
  assert.equal(result.created, true);
  assert.equal(appended[0].parentId, 1);
  assert.equal(appended[0].sessionSnapshotVersion, 15);
});

test('dream source selection keeps same session id in different cwd buckets', async () => {
  const client = {
    sessionTable: {
      listSnapshotsWithVersion: async () => ({
        sourceVersion: 22,
        rows: [
          snapshot({ snapshotId: 'session:5', sessionId: 's1', cwd: '/repo/muninn/a', snapshotSequence: 2, signals: '- [1] Keep cwd A.' }),
          snapshot({ snapshotId: 'session:6', sessionId: 's1', cwd: '/repo/muninn/b', snapshotSequence: 3, signals: '- [1] Keep cwd B.' }),
        ],
      }),
    },
    dreamingTable: {
      append: async ({ row }) => ({ ...row, dreamingId: 'dreaming:7' }),
      get: async () => null,
      list: async () => [],
      delta: async () => ({ sourceVersion: 0, rows: [] }),
      stats: async () => ({ version: 0, rowCount: 0, fragmentCount: 0 }),
    },
  };
  const service = new ProjectDreamingService(client, new DreamingIndex(null), 'default-observer', {
    merge: async ({ incrementalSignals }) => {
      assert.match(incrementalSignals, /Keep cwd A/);
      assert.match(incrementalSignals, /Keep cwd B/);
      return '# Project Dream\n\n## Signals\n\n### Guidance\n- [1] Keep cwd A.\n- [1] Keep cwd B.\n\n### Skills\n\n### Open Questions';
    },
  });

  const result = await service.create('/repo/muninn');

  assert.equal(result.created, true);
});
