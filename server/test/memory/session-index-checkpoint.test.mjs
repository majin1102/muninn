import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCheckpointFile, serializeCheckpointFile } from '../../dist/checkpoint.js';

function checkpoint(overrides = {}) {
  return {
    schemaVersion: 11,
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
    dreamingIndex: {
      baseline: { dreaming: 7 },
      entries: [
        {
          project: '/Users/Nathan/workspace/muninn',
          dreamingId: 'dreaming:12',
          parentId: 'dreaming:8',
          createdAt: '2026-06-02T13:00:00.000Z',
          sessionSnapshotVersion: 5,
        },
      ],
    },
    ...overrides,
  };
}

test('checkpoint parses and serializes sessionIndex entries', () => {
  const parsed = parseCheckpointFile(JSON.stringify(checkpoint()));

  assert.equal(parsed.schemaVersion, 11);
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
  assert.deepEqual(reparsed.dreamingIndex, parsed.dreamingIndex);
});

test('checkpoint rejects missing sessionIndex', () => {
  const content = checkpoint();
  delete content.sessionIndex;

  assert.throws(
    () => parseCheckpointFile(JSON.stringify(content)),
    /sessionIndex section is invalid/,
  );
});

test('checkpoint rejects missing dreamingIndex', () => {
  const content = checkpoint();
  delete content.dreamingIndex;

  assert.throws(
    () => parseCheckpointFile(JSON.stringify(content)),
    /dreamingIndex section is invalid/,
  );
});
