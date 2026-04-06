import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { __testing } from '../dist/client.js';
import { Observer } from '../dist/observer/observer.js';
import updateModule from '../dist/observer/update.js';

const { restoreIndexBatches, __testing: updateTesting } = updateModule;

async function makeConfigHome() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-observer-internals-'));
  return {
    dir,
    homeDir: path.join(dir, 'muninn'),
    configPath: path.join(dir, 'muninn', 'muninn.json'),
  };
}

async function writeObserverConfig(configPath) {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    observer: {
      name: 'default-observer',
      llm: 'observer_llm',
      maxAttempts: 3,
    },
    llm: {
      observer_llm: {
        provider: 'mock',
      },
    },
    semanticIndex: {
      embedding: {
        provider: 'mock',
        dimensions: 8,
      },
      defaultImportance: 0.7,
    },
  }, null, 2)}\n`, 'utf8');
}

test.afterEach(async () => {
  await __testing.shutdownCoreForTests();
  delete process.env.MUNINN_HOME;
});

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

test('observer.flushWindow keeps thread state unchanged when pre-commit work fails', async () => {
  const observer = new Observer({});
  const turn = {
    turnId: 'turn-1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    agent: 'agent-a',
    observer: 'default-observer',
    summary: 'pending summary',
    response: 'pending response',
    observingEpoch: 1,
  };
  const originalThreads = [{
    observingId: 'observing-a',
    snapshotId: 'snapshot-0',
    snapshotIds: ['snapshot-0'],
    observingEpoch: 0,
    title: 'Existing title',
    summary: 'Existing summary',
    snapshots: [
      { memories: [], openQuestions: [], nextSteps: [], memoryDelta: { before: [], after: [] } },
    ],
    references: ['session:existing'],
    indexedSnapshotSequence: 0,
    observer: 'default-observer',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  }];

  observer.bootstrapped = true;
  observer.nextEpoch = 1;
  observer.buffer = [turn];
  observer.threads = structuredClone(originalThreads);

  await assert.rejects(() => observer.flushWindow(), /observer gateway is not configured/);
  assert.deepEqual(observer.threads, originalThreads);
  assert.equal(observer.buffer.length, 1);
  assert.equal(observer.buffer[0].turnId, turn.turnId);
  assert.equal(observer.buffer[0].summary, turn.summary);
  assert.equal(observer.buffer[0].response, turn.response);
  assert.deepEqual(observer.observingBuffer, []);
  assert.equal(observer.observingEpoch, undefined);
});

test('flushThreads keeps committed observing state when parent ref repair fails', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const threads = [
    {
      observingId: 'observing-parent',
      snapshotId: 'snapshot-parent',
      snapshotIds: ['snapshot-parent'],
      observingEpoch: 0,
      title: 'Parent',
      summary: 'Parent summary',
      snapshots: [
        { memories: [], openQuestions: [], nextSteps: [], memoryDelta: { before: [], after: [] } },
      ],
      references: [],
      indexedSnapshotSequence: 0,
      observer: 'default-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
    {
      observingId: 'observing-child',
      snapshotId: undefined,
      snapshotIds: [],
      pendingParentId: 'observing-parent',
      observingEpoch: 1,
      title: 'Child',
      summary: 'Child summary',
      snapshots: [
        {
          memories: [],
          openQuestions: [],
          nextSteps: [],
          memoryDelta: {
            before: [],
            after: [{ id: null, text: 'remember this', category: 'Fact', updatedMemory: null }],
          },
        },
      ],
      references: [],
      indexedSnapshotSequence: null,
      observer: 'default-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
  ];
  let observingUpserts = 0;

  const failedIndexIds = await updateTesting.flushThreads({
    observingTable: {
      upsert: async ({ snapshots }) => {
        observingUpserts += 1;
        if (observingUpserts === 1) {
          return snapshots.map((snapshot) => ({
            ...snapshot,
            snapshotId: snapshot.observingId === 'observing-child' ? 'snapshot-child' : snapshot.snapshotId,
          }));
        }
        if (observingUpserts === 2) {
          throw new Error('parent ref write failed');
        }
        return snapshots;
      },
    },
    semanticIndexTable: {
      delete: async () => ({ deleted: 0 }),
      loadByIds: async () => [],
      upsert: async () => undefined,
    },
  }, threads, new Set(['observing-child']));

  assert.deepEqual(failedIndexIds, []);
  assert.equal(observingUpserts, 3);
  assert.equal(threads[1].snapshotId, 'snapshot-child');
  assert.equal(threads[1].pendingParentId, 'observing-parent');
  assert.equal(threads[1].indexedSnapshotSequence, 0);
});
