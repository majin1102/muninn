import test from 'node:test';
import assert from 'node:assert/strict';

import { DreamingIndex } from '../../dist/dreaming/index.js';

function client({ rows = [], deltaRows = [], version = 10 } = {}) {
  const calls = { list: 0, delta: 0, baselineVersions: [] };
  return {
    calls,
    tables: {
      dreamingTable: {
        list: async () => {
          calls.list += 1;
          return rows;
        },
        delta: async ({ baselineVersion } = {}) => {
          calls.delta += 1;
          calls.baselineVersions.push(baselineVersion);
          return {
            sourceVersion: version,
            rows: typeof deltaRows === 'function' ? deltaRows(baselineVersion) : deltaRows,
          };
        },
        stats: async () => ({ version, rowCount: rows.length, fragmentCount: 1 }),
      },
    },
  };
}

test('DreamingIndex rebuild selects latest dream per project by row id', async () => {
  const fake = client({
    rows: [
      { dreamingId: 'dreaming:2', project: '/repo/a', parentId: null, createdAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: 4, content: '# Project Dream' },
      { dreamingId: 'dreaming:5', project: '/repo/a', parentId: '2', createdAt: '2026-06-18T01:00:00Z', sessionSnapshotVersion: 8, content: '# Project Dream' },
      { dreamingId: 'dreaming:3', project: '/repo/b', parentId: null, createdAt: '2026-06-18T00:30:00Z', sessionSnapshotVersion: 7, content: '# Project Dream' },
    ],
    version: 9,
  });
  const index = new DreamingIndex(null);
  assert.deepEqual(await index.list(fake.tables), [
    { project: '/repo/a', dreamingId: 'dreaming:5', parentId: 'dreaming:2', createdAt: '2026-06-18T01:00:00Z', sessionSnapshotVersion: 8 },
    { project: '/repo/b', dreamingId: 'dreaming:3', createdAt: '2026-06-18T00:30:00Z', sessionSnapshotVersion: 7 },
  ]);
  assert.equal(fake.calls.list, 1);
});

test('DreamingIndex cleanup floor is min latest-project session snapshot version', async () => {
  const index = new DreamingIndex({
    baseline: { dreaming: 4 },
    entries: [
      { project: '/repo/a', dreamingId: 'dreaming:5', createdAt: '2026-06-18T01:00:00Z', sessionSnapshotVersion: 8 },
      { project: '/repo/b', dreamingId: 'dreaming:6', createdAt: '2026-06-18T02:00:00Z', sessionSnapshotVersion: 3 },
    ],
  });
  assert.equal(index.sessionSnapshotFloor(), 3);
});

test('DreamingIndex compares row ids without Number precision loss', async () => {
  const fake = client({
    rows: [
      { dreamingId: 'dreaming:9007199254740992', project: '/repo/a', parentId: null, createdAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: 7, content: '# Project Dream' },
      { dreamingId: 'dreaming:9007199254740993', project: '/repo/a', parentId: null, createdAt: '2026-06-18T01:00:00Z', sessionSnapshotVersion: 8, content: '# Project Dream' },
    ],
    version: 11,
  });
  const index = new DreamingIndex(null);

  assert.deepEqual(await index.list(fake.tables), [
    { project: '/repo/a', dreamingId: 'dreaming:9007199254740993', createdAt: '2026-06-18T01:00:00Z', sessionSnapshotVersion: 8 },
  ]);
});

test('DreamingIndex delta refresh uses source version and protects latest entry copies', async () => {
  const index = new DreamingIndex({
    baseline: { dreaming: 4 },
    entries: [
      {
        project: '/repo/a',
        dreamingId: 'dreaming:5',
        createdAt: '2026-06-18T01:00:00Z',
        sessionSnapshotVersion: 8,
      },
    ],
  });
  const fake = client({
    deltaRows: (baselineVersion) => (baselineVersion === 4
      ? [
          { dreamingId: 'dreaming:4', project: '/repo/a', parentId: null, createdAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: 7, content: '# Project Dream' },
          { dreamingId: 'dreaming:9', project: '/repo/b', parentId: null, createdAt: '2026-06-18T03:00:00Z', sessionSnapshotVersion: 12, content: '# Project Dream' },
        ]
      : []),
    version: 13,
  });

  const latest = await index.latest(fake.tables, '/repo/a');
  latest.sessionSnapshotVersion = 99;

  assert.deepEqual(await index.list(fake.tables), [
    { project: '/repo/a', dreamingId: 'dreaming:5', createdAt: '2026-06-18T01:00:00Z', sessionSnapshotVersion: 8 },
    { project: '/repo/b', dreamingId: 'dreaming:9', createdAt: '2026-06-18T03:00:00Z', sessionSnapshotVersion: 12 },
  ]);
  assert.equal(fake.calls.list, 0);
  assert.equal(fake.calls.delta, 2);
  assert.deepEqual(fake.calls.baselineVersions, [4, 13]);
  assert.deepEqual(await index.exportCheckpoint(fake.tables), {
    baseline: { dreaming: 13 },
    entries: [
      { project: '/repo/a', dreamingId: 'dreaming:5', createdAt: '2026-06-18T01:00:00Z', sessionSnapshotVersion: 8 },
      { project: '/repo/b', dreamingId: 'dreaming:9', createdAt: '2026-06-18T03:00:00Z', sessionSnapshotVersion: 12 },
    ],
  });
});
