import assert from 'node:assert/strict';
import test from 'node:test';

import {
  migrateCheckpointContent,
  parseArgs,
} from '../../../scripts/migrate-dreaming-project-to-checkpoint.mjs';

function checkpoint(overrides = {}) {
  return {
    schemaVersion: 12,
    writtenAt: '2026-06-01T00:00:00.000Z',
    writerPid: 1,
    extractor: {
      baseline: { turn: 1, session: 2, extraction: 3 },
      committedEpoch: 1,
      nextEpoch: 2,
      recentSessions: [],
      threads: [],
      runs: [],
    },
    sessionIndex: {
      baseline: { turn: 1, session: 2 },
      entries: [],
    },
    ...overrides,
  };
}

test('migrateCheckpointContent copies dreaming_project watermarks into checkpoint dreaming section', () => {
  const migrated = migrateCheckpointContent(
    checkpoint(),
    [
      { project: 'majin1102/muninn', sessionSnapshotVersion: 42, updatedAt: 'ignored' },
      { project: 'majin1102/lance', sessionSnapshotVersion: 7, updatedAt: 'ignored' },
    ],
    new Date('2026-07-01T00:00:00.000Z'),
    123,
  );

  assert.equal(migrated.schemaVersion, 13);
  assert.equal(migrated.writtenAt, '2026-07-01T00:00:00.000Z');
  assert.equal(migrated.writerPid, 123);
  assert.deepEqual(migrated.dreaming, {
    projects: {
      'majin1102/muninn': { sessionSnapshotVersion: 42 },
      'majin1102/lance': { sessionSnapshotVersion: 7 },
    },
  });
});

test('migrateCheckpointContent preserves existing checkpoint dreaming projects unless table rows replace them', () => {
  const migrated = migrateCheckpointContent(
    checkpoint({
      schemaVersion: 13,
      dreaming: {
        projects: {
          'majin1102/muninn': { sessionSnapshotVersion: 1 },
          'majin1102/amoro': { sessionSnapshotVersion: 9 },
        },
      },
    }),
    [
      { project: 'majin1102/muninn', sessionSnapshotVersion: 42 },
    ],
    new Date('2026-07-01T00:00:00.000Z'),
    123,
  );

  assert.deepEqual(migrated.dreaming.projects, {
    'majin1102/muninn': { sessionSnapshotVersion: 42 },
    'majin1102/amoro': { sessionSnapshotVersion: 9 },
  });
});

test('migrateCheckpointContent rejects invalid dreaming_project rows', () => {
  assert.throws(
    () => migrateCheckpointContent(checkpoint(), [
      { project: 'majin1102/muninn', sessionSnapshotVersion: -1 },
    ]),
    /invalid sessionSnapshotVersion/,
  );
});

test('parseArgs supports database and dry-run options', () => {
  assert.deepEqual(parseArgs(['--database', 'main', '--dry-run']), {
    database: 'main',
    dryRun: true,
    help: false,
  });
});
