import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MuninnBackend } from '../dist/backend.js';
import { readCheckpointFile, resolveCheckpointPath, serializeCheckpointFile } from '../dist/checkpoint.js';
import { SessionIndex } from '../dist/session-index.js';

function client({
  turns = [],
  snapshots = [],
  turnDelta = [],
  sessionDelta = [],
  turnVersion = 10,
  sessionVersion = 10,
} = {}) {
  const calls = {
    listTurns: 0,
    listSnapshots: 0,
    turnDelta: 0,
    sessionDelta: 0,
    listTurnQueries: [],
    listSnapshotQueries: [],
  };
  return {
    calls,
    tables: {
      turnTable: {
        listTurns: async (query = {}) => {
          calls.listTurns += 1;
          calls.listTurnQueries.push(query);
          return query.observer ? turns.filter((turn) => turn.observer === query.observer) : turns;
        },
        delta: async () => {
          calls.turnDelta += 1;
          return turnDelta;
        },
        stats: async () => ({ version: turnVersion, rowCount: turns.length, fragmentCount: 1 }),
      },
      sessionTable: {
        listSnapshots: async (query = {}) => {
          calls.listSnapshots += 1;
          calls.listSnapshotQueries.push(query);
          return query.observer
            ? snapshots.filter((snapshot) => (snapshot.extractor ?? snapshot.observer) === query.observer)
            : snapshots;
        },
        delta: async () => {
          calls.sessionDelta += 1;
          return sessionDelta;
        },
        stats: async () => ({ version: sessionVersion, rowCount: snapshots.length, fragmentCount: 1 }),
      },
    },
  };
}

async function withTempMuninnHome(t) {
  const previousHome = process.env.MUNINN_HOME;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-session-index-'));
  const homeDir = path.join(dir, 'muninn');
  process.env.MUNINN_HOME = homeDir;
  t.after(async () => {
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
    await rm(dir, { recursive: true, force: true });
  });
  return homeDir;
}

function checkpoint(overrides = {}) {
  return {
    schemaVersion: 7,
    writtenAt: '2026-06-02T00:00:00.000Z',
    writerPid: 123,
    extractor: {
      baseline: { turn: 10, session: 10, extraction: 2, global_observation: 3 },
      committedEpoch: 5,
      nextEpoch: 6,
      recentSessions: [],
      threads: [],
      runs: [],
      pendingExtractionChanges: [],
    },
    observer: {
      baseline: { globalObservationContext: 4, global_observation: 3 },
      observeQueue: { cwdBuckets: [] },
      runs: [],
    },
    sessionIndex: {
      baseline: { turn: 10, session: 10 },
      entries: [{
        sessionId: 'muninn/stale',
        agent: 'codex',
        project: 'muninn',
        cwd: '/Users/Nathan/workspace/muninn',
        latestUpdatedAt: '2026-06-02T10:00:00.000Z',
      }],
    },
    ...overrides,
  };
}

test('sessionIndex restores checkpoint and applies table deltas without full turn scan', async () => {
  const index = new SessionIndex({
    baseline: { turn: 4, session: 7 },
    entries: [{
      sessionId: 'muninn/session-a',
      agent: 'codex',
      project: 'muninn',
      cwd: '/Users/Nathan/workspace/muninn',
      latestUpdatedAt: '2026-06-02T10:00:00.000Z',
    }],
  }, 'default-observer');
  const fake = client({
    turnDelta: [{
      sessionId: 'muninn/session-a',
      agent: 'codex',
      project: 'muninn',
      cwd: '/Users/Nathan/workspace/muninn',
      observer: 'default-observer',
      summary: 'newer turn',
      updatedAt: '2026-06-02T11:00:00.000Z',
    }],
    sessionDelta: [{
      snapshotId: 'session:9',
      sessionId: 'muninn/session-a',
      project: 'muninn',
      cwd: '/Users/Nathan/workspace/muninn',
      agent: 'codex',
      snapshotSequence: 2,
      createdAt: '2026-06-02T11:00:00.000Z',
      updatedAt: '2026-06-02T11:00:00.000Z',
      observer: 'default-observer',
      title: 'Snapshot title',
      summary: '',
      content: '',
      references: [],
    }],
    turnVersion: 5,
    sessionVersion: 8,
  });

  assert.deepEqual(await index.list(fake.tables), [{
    sessionId: 'muninn/session-a',
    agent: 'codex',
    project: 'muninn',
    cwd: '/Users/Nathan/workspace/muninn',
    latestUpdatedAt: '2026-06-02T11:00:00.000Z',
    snapshotId: 'session:9',
    title: 'Snapshot title',
  }]);
  assert.equal(fake.calls.listTurns, 0);
  assert.equal(fake.calls.listSnapshots, 0);
  assert.equal(fake.calls.turnDelta, 1);
  assert.equal(fake.calls.sessionDelta, 1);
});

test('sessionIndex rebuilds after dirty mark and drops removed sessions', async () => {
  const index = new SessionIndex({
    baseline: { turn: 4, session: 7 },
    entries: [
      {
        sessionId: 'muninn/stale',
        agent: 'codex',
        project: 'muninn',
        cwd: '/Users/Nathan/workspace/muninn',
        latestUpdatedAt: '2026-06-02T10:00:00.000Z',
      },
    ],
  }, 'default-observer');
  index.markDirty();
  const fake = client({
    turns: [{
      session_id: 'muninn/live',
      agent: 'codex',
      project: 'muninn',
      cwd: '/Users/Nathan/workspace/muninn',
      observer: 'default-observer',
      summary: 'live turn',
      updatedAt: '2026-06-02T12:00:00.000Z',
    }],
    snapshots: [{
      snapshotId: 'session:10',
      sessionId: 'muninn/live',
      project: 'muninn',
      cwd: '/Users/Nathan/workspace/muninn',
      agent: 'codex',
      snapshotSequence: 1,
      createdAt: '2026-06-02T12:00:00.000Z',
      updatedAt: '2026-06-02T12:00:00.000Z',
      extractor: 'default-observer',
      title: 'Live snapshot title',
      summary: '',
      content: '',
      references: [],
    }],
    turnVersion: 9,
    sessionVersion: 9,
  });

  assert.deepEqual(await index.list(fake.tables), [{
    sessionId: 'muninn/live',
    agent: 'codex',
    project: 'muninn',
    cwd: '/Users/Nathan/workspace/muninn',
    latestUpdatedAt: '2026-06-02T12:00:00.000Z',
    snapshotId: 'session:10',
    title: 'Live snapshot title',
  }]);
  assert.equal(fake.calls.listTurns, 1);
  assert.equal(fake.calls.listSnapshots, 1);
});

test('sessionIndex rebuild filters turns and snapshots by observer', async () => {
  const index = new SessionIndex(null, 'default-observer');
  const fake = client({
    turns: [
      {
        session_id: 'muninn/live',
        agent: 'codex',
        project: 'muninn',
        cwd: '/Users/Nathan/workspace/muninn',
        observer: 'other-observer',
        summary: 'wrong observer turn',
        updatedAt: '2026-06-02T13:00:00.000Z',
      },
      {
        session_id: 'muninn/live',
        agent: 'codex',
        project: 'muninn',
        cwd: '/Users/Nathan/workspace/muninn',
        observer: 'default-observer',
        summary: 'right observer turn',
        updatedAt: '2026-06-02T12:00:00.000Z',
      },
    ],
    snapshots: [
      {
        snapshotId: 'session:wrong',
        sessionId: 'muninn/live',
        project: 'muninn',
        cwd: '/Users/Nathan/workspace/muninn',
        agent: 'codex',
        snapshotSequence: 2,
        createdAt: '2026-06-02T13:00:00.000Z',
        updatedAt: '2026-06-02T13:00:00.000Z',
        extractor: 'other-observer',
        title: 'Wrong observer title',
        summary: '',
        content: '',
        references: [],
      },
      {
        snapshotId: 'session:right',
        sessionId: 'muninn/live',
        project: 'muninn',
        cwd: '/Users/Nathan/workspace/muninn',
        agent: 'codex',
        snapshotSequence: 1,
        createdAt: '2026-06-02T12:00:00.000Z',
        updatedAt: '2026-06-02T12:00:00.000Z',
        extractor: 'default-observer',
        title: 'Right observer title',
        summary: '',
        content: '',
        references: [],
      },
    ],
    turnVersion: 9,
    sessionVersion: 9,
  });

  assert.deepEqual(await index.list(fake.tables), [{
    sessionId: 'muninn/live',
    agent: 'codex',
    project: 'muninn',
    cwd: '/Users/Nathan/workspace/muninn',
    latestUpdatedAt: '2026-06-02T12:00:00.000Z',
    snapshotId: 'session:right',
    title: 'Right observer title',
  }]);
  assert.deepEqual(fake.calls.listTurnQueries, [{
    mode: { type: 'page', offset: 0, limit: 1_000_000 },
    observer: 'default-observer',
  }]);
  assert.deepEqual(fake.calls.listSnapshotQueries, [{ observer: 'default-observer' }]);
});

test('sessionIndex groups entries by project agent and session id, not cwd', async () => {
  const index = new SessionIndex(null, 'default-observer');
  const fake = client({
    turns: [
      {
        session_id: 'same-session',
        agent: 'codex',
        project: '/workspace/muninn',
        cwd: '/Users/Nathan/.codex/worktrees/aaaa/muninn',
        observer: 'default-observer',
        summary: 'older worktree turn',
        updatedAt: '2026-06-02T10:00:00.000Z',
      },
      {
        session_id: 'same-session',
        agent: 'codex',
        project: '/workspace/muninn',
        cwd: '/Users/Nathan/.codex/worktrees/bbbb/muninn',
        observer: 'default-observer',
        summary: 'newer worktree turn',
        updatedAt: '2026-06-02T11:00:00.000Z',
      },
      {
        session_id: 'same-session',
        agent: 'codex',
        project: '/workspace/lance',
        cwd: '/Users/Nathan/workspace/lance',
        observer: 'default-observer',
        summary: 'different project turn',
        updatedAt: '2026-06-02T12:00:00.000Z',
      },
    ],
    snapshots: [{
      snapshotId: 'session:muninn',
      sessionId: 'same-session',
      project: '/workspace/muninn',
      cwd: '/Users/Nathan/.codex/worktrees/cccc/muninn',
      agent: 'codex',
      snapshotSequence: 1,
      createdAt: '2026-06-02T12:00:00.000Z',
      updatedAt: '2026-06-02T12:00:00.000Z',
      extractor: 'default-observer',
      title: 'Canonical project title',
      summary: '',
      content: '',
      references: [],
    }],
    turnVersion: 9,
    sessionVersion: 9,
  });

  assert.deepEqual(await index.list(fake.tables), [
    {
      sessionId: 'same-session',
      agent: 'codex',
      project: '/workspace/lance',
      cwd: '/Users/Nathan/workspace/lance',
      latestUpdatedAt: '2026-06-02T12:00:00.000Z',
    },
    {
      sessionId: 'same-session',
      agent: 'codex',
      project: '/workspace/muninn',
      cwd: '/Users/Nathan/.codex/worktrees/bbbb/muninn',
      latestUpdatedAt: '2026-06-02T11:00:00.000Z',
      snapshotId: 'session:muninn',
      title: 'Canonical project title',
    },
  ]);
});

test('sessionIndex records firstTurnSequence from turn metadata', async () => {
  const index = new SessionIndex(null, 'default-observer');
  const fake = client({
    turns: [{
      session_id: 'captured-late',
      agent: 'codex',
      project: 'github.com/example/repo',
      cwd: '/Users/Nathan/workspace/repo',
      observer: 'default-observer',
      summary: 'late summary',
      metadata: { sourceTurnSequence: 17 },
      updatedAt: '2026-06-02T10:00:00.000Z',
    }],
    turnVersion: 9,
    sessionVersion: 9,
  });

  assert.deepEqual(await index.list(fake.tables), [{
    sessionId: 'captured-late',
    agent: 'codex',
    project: 'github.com/example/repo',
    cwd: '/Users/Nathan/workspace/repo',
    latestUpdatedAt: '2026-06-02T10:00:00.000Z',
    firstTurnSequence: 17,
  }]);
});

test('sessionIndex lowers firstTurnSequence when import fills history from zero', async () => {
  const index = new SessionIndex({
    baseline: { turn: 4, session: 7 },
    entries: [{
      sessionId: 'fill-history',
      agent: 'codex',
      project: 'github.com/example/repo',
      cwd: '/Users/Nathan/workspace/repo',
      latestUpdatedAt: '2026-06-02T10:00:00.000Z',
      firstTurnSequence: 17,
    }],
  }, 'default-observer');
  const fake = client({
    turnDelta: [{
      session_id: 'fill-history',
      agent: 'codex',
      project: 'github.com/example/repo',
      cwd: '/Users/Nathan/workspace/repo',
      observer: 'default-observer',
      summary: 'first summary',
      metadata: { sourceTurnSequence: 0 },
      updatedAt: '2026-06-02T11:00:00.000Z',
    }],
    turnVersion: 5,
    sessionVersion: 8,
  });

  assert.deepEqual(await index.list(fake.tables), [{
    sessionId: 'fill-history',
    agent: 'codex',
    project: 'github.com/example/repo',
    cwd: '/Users/Nathan/workspace/repo',
    latestUpdatedAt: '2026-06-02T11:00:00.000Z',
    firstTurnSequence: 0,
  }]);
});

test('backend refreshSessionIndex rebuilds stale checkpoint entries from current tables', async (t) => {
  await withTempMuninnHome(t);
  const fake = client({
    turns: [],
    snapshots: [{
      snapshotId: 'session:stale',
      sessionId: 'muninn/stale',
      project: 'muninn',
      cwd: '/Users/Nathan/workspace/muninn',
      agent: 'codex',
      snapshotSequence: 1,
      createdAt: '2026-06-02T10:00:00.000Z',
      updatedAt: '2026-06-02T10:00:00.000Z',
      extractor: 'default-observer',
      title: 'Stale snapshot title',
      summary: '',
      content: '',
      references: [],
    }],
    turnVersion: 12,
    sessionVersion: 12,
  });
  const backend = MuninnBackend.createForTests(fake.tables, {
    schemaVersion: 7,
    writtenAt: '2026-06-02T00:00:00.000Z',
    writerPid: 123,
    extractor: {
      baseline: { turn: 10, session: 10, extraction: 0, global_observation: 0 },
      committedEpoch: 0,
      nextEpoch: 1,
      recentSessions: [],
      threads: [],
      runs: [],
      pendingExtractionChanges: [],
    },
    observer: {
      baseline: { globalObservationContext: 0, global_observation: 0 },
      observeQueue: { cwdBuckets: [] },
      runs: [],
    },
    sessionIndex: {
      baseline: { turn: 10, session: 10 },
      entries: [{
        sessionId: 'muninn/stale',
        agent: 'codex',
        project: 'muninn',
        cwd: '/Users/Nathan/workspace/muninn',
        latestUpdatedAt: '2026-06-02T10:00:00.000Z',
      }],
    },
  });

  assert.deepEqual(await backend.refreshSessionIndex(), []);
  assert.equal(fake.calls.listTurns, 1);
  assert.equal(fake.calls.listSnapshots, 1);
});

test('backend refreshSessionIndex writes rebuilt sessionIndex back to an existing checkpoint', async (t) => {
  await withTempMuninnHome(t);
  const staleCheckpoint = checkpoint();
  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), serializeCheckpointFile(staleCheckpoint), 'utf8');

  const fake = client({
    turns: [],
    snapshots: [{
      snapshotId: 'session:stale',
      sessionId: 'muninn/stale',
      project: 'muninn',
      cwd: '/Users/Nathan/workspace/muninn',
      agent: 'codex',
      snapshotSequence: 1,
      createdAt: '2026-06-02T10:00:00.000Z',
      updatedAt: '2026-06-02T10:00:00.000Z',
      extractor: 'default-observer',
      title: 'Stale snapshot title',
      summary: '',
      content: '',
      references: [],
    }],
    turnVersion: 12,
    sessionVersion: 12,
  });
  const backend = MuninnBackend.createForTests(fake.tables, staleCheckpoint);

  assert.deepEqual(await backend.refreshSessionIndex(), []);

  const refreshed = await readCheckpointFile();
  assert.deepEqual(refreshed.sessionIndex.entries, []);
  assert.deepEqual(refreshed.sessionIndex.baseline, { turn: 12, session: 12 });
  assert.deepEqual(refreshed.extractor, staleCheckpoint.extractor);
  assert.deepEqual(refreshed.observer, staleCheckpoint.observer);
  assert.equal(fake.calls.listTurns, 1);
  assert.equal(fake.calls.listSnapshots, 1);
});

test('backend refreshSessionIndex skips checkpoint write when no checkpoint file exists', async (t) => {
  await withTempMuninnHome(t);
  const fake = client({ turns: [], snapshots: [] });
  const backend = MuninnBackend.createForTests(fake.tables, checkpoint());

  assert.deepEqual(await backend.refreshSessionIndex(), []);
  assert.equal(await readCheckpointFile(), null);
});
