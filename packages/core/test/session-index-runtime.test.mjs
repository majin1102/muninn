import assert from 'node:assert/strict';
import test from 'node:test';

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
  };
  return {
    calls,
    tables: {
      turnTable: {
        listTurns: async () => {
          calls.listTurns += 1;
          return turns;
        },
        delta: async () => {
          calls.turnDelta += 1;
          return turnDelta;
        },
        stats: async () => ({ version: turnVersion, rowCount: turns.length, fragmentCount: 1 }),
      },
      sessionTable: {
        listSnapshots: async () => {
          calls.listSnapshots += 1;
          return snapshots;
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
      observer: 'default-observer',
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
