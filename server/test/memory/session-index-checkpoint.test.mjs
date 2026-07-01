import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCheckpointFile, serializeCheckpointFile } from '../../dist/checkpoint.js';

function checkpoint(overrides = {}) {
  return {
    schemaVersion: 13,
    writtenAt: '2026-06-02T00:00:00.000Z',
    writerPid: 123,
    extractor: {
      baseline: { turn: 10, session: 5, extraction: 3 },
      committedEpoch: 1,
      nextEpoch: 2,
      recentSessions: [],
      threads: [],
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
    dreaming: {
      projects: {},
    },
    ...overrides,
  };
}

test('checkpoint parses and serializes sessionIndex entries', () => {
  const parsed = parseCheckpointFile(JSON.stringify(checkpoint()));

  assert.equal(parsed.schemaVersion, 13);
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

test('checkpoint parses and serializes dreaming project watermarks', () => {
  const parsed = parseCheckpointFile(JSON.stringify(checkpoint({
    dreaming: {
      projects: {
        'majin1102/muninn': { sessionSnapshotVersion: 42 },
        'majin1102/lance': { sessionSnapshotVersion: 7 },
      },
    },
  })));

  assert.deepEqual(parsed.dreaming, {
    projects: {
      'majin1102/muninn': { sessionSnapshotVersion: 42 },
      'majin1102/lance': { sessionSnapshotVersion: 7 },
    },
  });

  const reparsed = parseCheckpointFile(serializeCheckpointFile(parsed));
  assert.deepEqual(reparsed.dreaming, parsed.dreaming);
});

test('checkpoint rejects invalid dreaming project watermarks', () => {
  assert.throws(
    () => parseCheckpointFile(JSON.stringify(checkpoint({
      dreaming: {
        projects: {
          'majin1102/muninn': { sessionSnapshotVersion: -1 },
        },
      },
    }))),
    /dreaming section is invalid/,
  );
});

test('checkpoint ignores obsolete dreamingIndex when present', () => {
  const parsed = parseCheckpointFile(JSON.stringify(checkpoint({
    dreamingIndex: {
      baseline: { dreaming: 7 },
      entries: [],
    },
  })));

  assert.equal('dreamingIndex' in parsed, false);
});
