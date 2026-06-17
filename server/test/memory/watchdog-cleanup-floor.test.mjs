import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing as watchdogTesting } from '../../dist/watchdog.js';

function checkpoint(dreamingEntries) {
  return {
    schemaVersion: 11,
    extractor: {
      baseline: { turn: 30, session: 20, extraction: 10, observation: 9 },
      committedEpoch: 1,
      nextEpoch: 2,
      recentSessions: [],
      threads: [],
      runs: [],
      pendingExtractionChanges: [],
    },
    observer: { baseline: { observationContext: 8, observation: 9 }, observeQueue: { cwdBuckets: [] } },
    sessionIndex: { baseline: { turn: 30, session: 20 }, entries: [] },
    dreamingIndex: {
      baseline: { dreaming: 7 },
      entries: dreamingEntries,
    },
  };
}

test('checkpointFloors uses min dreaming sessionSnapshotVersion for session cleanup', () => {
  const floors = watchdogTesting.checkpointFloors(checkpoint([
    { project: '/repo/a', dreamingId: 'dreaming:1', createdAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: 15 },
    { project: '/repo/b', dreamingId: 'dreaming:2', createdAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: 12 },
  ]));
  assert.equal(floors.session, 12);
});

test('checkpointFloors keeps session baseline when dreaming index is empty', () => {
  const floors = watchdogTesting.checkpointFloors(checkpoint([]));
  assert.equal(floors.session, 20);
});

test('checkpointFloors ignores invalid numeric floors', () => {
  const floors = watchdogTesting.checkpointFloors(checkpoint([
    { project: '/repo/a', dreamingId: 'dreaming:1', createdAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: Number.NaN },
    { project: '/repo/b', dreamingId: 'dreaming:2', createdAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: Number.POSITIVE_INFINITY },
    { project: '/repo/c', dreamingId: 'dreaming:3', createdAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: -1 },
    { project: '/repo/d', dreamingId: 'dreaming:4', createdAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: 1.5 },
    { project: '/repo/e', dreamingId: 'dreaming:5', createdAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: 18 },
  ]));
  assert.equal(floors.session, 18);
});
