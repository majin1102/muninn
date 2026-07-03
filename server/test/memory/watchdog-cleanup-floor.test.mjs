import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing as watchdogTesting } from '../../dist/watchdog.js';

function checkpoint(overrides = {}) {
  return {
    schemaVersion: 14,
    extractor: {
      baseline: { turn: 30, session: 20, extraction: 10 },
      committedEpoch: 1,
      nextEpoch: 2,
      recentSessions: [],
      threads: [],
      runs: [],
      pendingExtractionChanges: [],
    },
    sessionIndex: { baseline: { turn: 30, session: 20 }, entries: [] },
    dreaming: {
      projects: {},
    },
    session: {
      schemaVersion: 1,
      embeddingDimensions: 8,
      sourceSessionVersion: 20,
      tableVersion: 7,
    },
    ...overrides,
  };
}

test('checkpointFloors uses min dreaming project sessionSnapshotVersion for session cleanup', async () => {
  const floors = await watchdogTesting.checkpointFloors(checkpoint({
    dreaming: {
      projects: {
        '/repo/a': { sessionSnapshotVersion: 15 },
        '/repo/b': { sessionSnapshotVersion: 12 },
      },
    },
  }));
  assert.equal(floors.sessionSnapshot, 12);
  assert.equal(floors.session, 7);
});

test('checkpointFloors keeps session baseline when dreaming project table is empty', async () => {
  const floors = await watchdogTesting.checkpointFloors(checkpoint());
  assert.equal(floors.sessionSnapshot, 20);
  assert.equal(floors.session, 7);
});

test('checkpointFloors ignores invalid numeric floors', async () => {
  const floors = await watchdogTesting.checkpointFloors(checkpoint({
    dreaming: {
      projects: {
        '/repo/a': { sessionSnapshotVersion: Number.NaN },
        '/repo/b': { sessionSnapshotVersion: Number.POSITIVE_INFINITY },
        '/repo/c': { sessionSnapshotVersion: -1 },
        '/repo/d': { sessionSnapshotVersion: 1.5 },
        '/repo/e': { sessionSnapshotVersion: 18 },
      },
    },
  }));
  assert.equal(floors.sessionSnapshot, 18);
  assert.equal(floors.session, 7);
});
