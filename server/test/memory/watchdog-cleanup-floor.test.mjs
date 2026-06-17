import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing as watchdogTesting } from '../../dist/watchdog.js';

test('checkpointFloors uses min dreaming sessionSnapshotVersion for session cleanup', () => {
  const floors = watchdogTesting.checkpointFloors({
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
      entries: [
        { project: '/repo/a', dreamingId: 'dreaming:1', createdAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: 15 },
        { project: '/repo/b', dreamingId: 'dreaming:2', createdAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: 12 },
      ],
    },
  });
  assert.equal(floors.session, 12);
});
