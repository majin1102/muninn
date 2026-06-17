import test from 'node:test';
import assert from 'node:assert/strict';

import { DreamingIndex } from '../../dist/dreaming/index.js';

function client({ rows = [], deltaRows = [], version = 10 } = {}) {
  const calls = { list: 0, delta: 0 };
  return {
    calls,
    tables: {
      dreamingTable: {
        list: async () => {
          calls.list += 1;
          return rows;
        },
        delta: async () => {
          calls.delta += 1;
          return { sourceVersion: version, rows: deltaRows };
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
      { dreamingId: 'dreaming:5', project: '/repo/a', parentId: 2, createdAt: '2026-06-18T01:00:00Z', sessionSnapshotVersion: 8, content: '# Project Dream' },
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
