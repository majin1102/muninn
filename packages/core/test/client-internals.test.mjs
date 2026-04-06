import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';

import { __testing } from '../dist/client.js';
import { Observer } from '../dist/observer/observer.js';
import { restoreIndexBatches } from '../dist/observer/update.js';

test('resolveNativeBindingPath points at the packaged addon', async () => {
  const bindingPath = __testing.resolveNativeBindingPath();
  assert.match(bindingPath, /muninn_native\.node$/);
  await access(bindingPath);
});

test('restoreIndexBatches keeps threads with pending index even when no pending turns remain', () => {
  const batches = restoreIndexBatches([
    {
      observingId: 'observing-a',
      observingEpoch: 7,
      title: 'Title',
      summary: 'Summary',
      snapshots: [
        { memories: [], openQuestions: [], nextSteps: [], memoryDelta: { before: [], after: [] } },
        { memories: [], openQuestions: [], nextSteps: [], memoryDelta: { before: [], after: [] } },
      ],
      snapshotIds: ['snapshot-0', 'snapshot-1'],
      indexedSnapshotSequence: 0,
      references: [],
      observer: 'default-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
  ], []);

  assert.deepEqual(batches, [{
    turns: [],
    observingIds: ['observing-a'],
  }]);
});

test('observer.watermark stays unresolved when only semantic index retry is pending', async () => {
  const observer = new Observer({});
  observer.bootstrapped = true;
  observer.indexBatches = [{ turns: [], observingIds: ['observing-a'] }];

  const watermark = await observer.watermark();
  assert.deepEqual(watermark.pendingTurnIds, []);
  assert.equal(watermark.resolved, false);
});
