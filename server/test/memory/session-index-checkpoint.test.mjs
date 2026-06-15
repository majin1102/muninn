import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCheckpointFile, serializeCheckpointFile } from '../../dist/memory/checkpoint.js';

function checkpoint(overrides = {}) {
  return {
    schemaVersion: 9,
    writtenAt: '2026-06-02T00:00:00.000Z',
    writerPid: 123,
    extractor: {
      baseline: { turn: 10, session: 5, extraction: 3, observation: 2 },
      committedEpoch: 1,
      nextEpoch: 2,
      recentSessions: [],
      threads: [],
      runs: [],
      pendingExtractionChanges: [],
    },
    observer: {
      baseline: { observationContext: 4, observation: 2 },
      observeQueue: { cwdBuckets: [] },
      runs: [],
    },
    sessionIndex: {
      baseline: { turn: 10, session: 5 },
      entries: [
        {
          sessionId: 'raw-session-a',
          agent: 'codex',
          project: 'muninn',
          cwd: '/Users/Nathan/workspace/muninn',
          latestUpdatedAt: '2026-06-02T12:00:00.000Z',
          snapshotId: 'session:42',
          title: 'Snapshot title',
        },
      ],
    },
    ...overrides,
  };
}

test('checkpoint parses and serializes sessionIndex entries', () => {
  const parsed = parseCheckpointFile(JSON.stringify(checkpoint()));

  assert.equal(parsed.schemaVersion, 9);
  assert.deepEqual(parsed.sessionIndex, {
    baseline: { turn: 10, session: 5 },
    entries: [
      {
        sessionId: 'raw-session-a',
        agent: 'codex',
        project: 'muninn',
        cwd: '/Users/Nathan/workspace/muninn',
        latestUpdatedAt: '2026-06-02T12:00:00.000Z',
        snapshotId: 'session:42',
        title: 'Snapshot title',
      },
    ],
  });

  const reparsed = parseCheckpointFile(serializeCheckpointFile(parsed));
  assert.deepEqual(reparsed.sessionIndex, parsed.sessionIndex);
});

test('checkpoint rejects missing sessionIndex', () => {
  const content = checkpoint();
  delete content.sessionIndex;

  assert.throws(
    () => parseCheckpointFile(JSON.stringify(content)),
    /sessionIndex section is invalid/,
  );
});
