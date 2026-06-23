import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing as watchdogTesting } from '../../dist/watchdog.js';

function checkpoint() {
  return {
    schemaVersion: 12,
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
  };
}

function binding(rows) {
  return {
    dreamingProjectTable: {
      list: async () => rows,
    },
  };
}

test('checkpointFloors uses min dreaming project sessionSnapshotVersion for session cleanup', async () => {
  const floors = await watchdogTesting.checkpointFloors(checkpoint(), binding([
    { project: '/repo/a', updatedAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: 15 },
    { project: '/repo/b', updatedAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: 12 },
  ]));
  assert.equal(floors.session, 12);
});

test('checkpointFloors keeps session baseline when dreaming project table is empty', async () => {
  const floors = await watchdogTesting.checkpointFloors(checkpoint(), binding([]));
  assert.equal(floors.session, 20);
});

test('checkpointFloors ignores invalid numeric floors', async () => {
  const floors = await watchdogTesting.checkpointFloors(checkpoint(), binding([
    { project: '/repo/a', updatedAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: Number.NaN },
    { project: '/repo/b', updatedAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: Number.POSITIVE_INFINITY },
    { project: '/repo/c', updatedAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: -1 },
    { project: '/repo/d', updatedAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: 1.5 },
    { project: '/repo/e', updatedAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: 18 },
  ]));
  assert.equal(floors.session, 18);
});
