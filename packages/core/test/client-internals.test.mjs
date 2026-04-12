import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import core from '../dist/index.js';
import { __testing } from '../dist/client.js';
import { Muninn } from '../dist/muninn.js';
import { Observer } from '../dist/observer/observer.js';
import { EpochQueue, OpenEpoch } from '../dist/observer/epoch.js';
import { SessionRegistry } from '../dist/session/registry.js';
import { normalizeSessionId, sessionKey } from '../dist/session/key.js';
import { Session } from '../dist/session/session.js';
import { Watchdog } from '../dist/watchdog.js';
import updateModule from '../dist/observer/update.js';
import threadModule from '../dist/observer/thread.js';

const { __testing: updateTesting } = updateModule;
const { getPendingIndex, getPendingIndexUpTo } = threadModule;
const { addMessage, observer: observerApi, shutdownCoreForTests } = core;

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

async function writeOpenAiObserverConfig(configPath) {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    turn: {
      llm: 'turn_llm',
    },
    observer: {
      name: 'default-observer',
      llm: 'observer_llm',
      maxAttempts: 3,
    },
    llm: {
      turn_llm: {
        provider: 'mock',
      },
      observer_llm: {
        provider: 'openai',
        apiKey: 'test-key',
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeObservableTurn(turnId, observingEpoch, text) {
  return {
    turnId,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    sessionId: 'group-a',
    agent: 'agent-a',
    observer: 'default-observer',
    summary: `${text} summary`,
    prompt: `${text} prompt`,
    response: `${text} response`,
    observingEpoch,
  };
}

function makeObserverClient() {
  let snapshotSequence = 0;
  return {
    observingTable: {
      insert: async ({ snapshots }) => snapshots.map((snapshot) => ({
        ...snapshot,
        snapshotId: `snapshot-${snapshotSequence += 1}`,
      })),
      update: async ({ snapshots }) => snapshots,
    },
    semanticIndexTable: {
      delete: async () => ({ deleted: 0 }),
      loadByIds: async () => [],
      upsert: async () => undefined,
    },
  };
}

async function waitFor(predicate, { timeoutMs = 1_000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('timed out waiting for condition');
}

async function readWatchdogLog(homeDir) {
  try {
    const content = await readFile(path.join(homeDir, 'watchdog.jsonl'), 'utf8');
    const trimmed = content.trim();
    return trimmed
      ? trimmed.split('\n').map((line) => JSON.parse(line))
      : [];
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function createWatchdogConfig(overrides = {}) {
  return {
    enabled: true,
    intervalMs: 30,
    compactMinFragments: 2,
    semanticIndex: {
      targetPartitionSize: 16,
      optimizeMergeCount: 4,
    },
    ...overrides,
  };
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

test('watchdog.start waits for the first interval before maintenance', async (t) => {
  const { dir, homeDir } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  let sessionStatsCalls = 0;
  const runtime = new Watchdog({
    sessionTable: {
      stats: async () => {
        sessionStatsCalls += 1;
        return null;
      },
      compact: async () => ({ changed: false }),
    },
    observingTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    semanticIndexTable: {
      ensureVectorIndex: async () => ({ created: false }),
      stats: async () => null,
      compact: async () => ({ changed: false }),
      optimize: async () => ({ changed: false }),
    },
  }, createWatchdogConfig({ intervalMs: 60 }));
  t.after(async () => runtime.stop());

  runtime.start();

  assert.equal(sessionStatsCalls, 0);
  assert.deepEqual(await readWatchdogLog(homeDir), []);

  await waitFor(() => sessionStatsCalls > 0, { timeoutMs: 500 });
  assert.ok(sessionStatsCalls > 0);
  assert.deepEqual(await readWatchdogLog(homeDir), []);
});

test('watchdog compacts turn data once per observed version without logging skips', async (t) => {
  const { dir, homeDir } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  let compactCalls = 0;
  let statsCalls = 0;
  const runtime = new Watchdog({
    sessionTable: {
      stats: async () => {
        statsCalls += 1;
        return {
          version: 7,
          fragmentCount: 4,
          rowCount: 10,
        };
      },
      compact: async () => {
        compactCalls += 1;
        return { changed: true };
      },
    },
    observingTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    semanticIndexTable: {
      ensureVectorIndex: async () => ({ created: false }),
      stats: async () => null,
      compact: async () => ({ changed: false }),
      optimize: async () => ({ changed: false }),
    },
  }, createWatchdogConfig());
  t.after(async () => runtime.stop());

  runtime.start();
  await waitFor(() => compactCalls === 1);
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(compactCalls, 1);
  assert.ok(statsCalls > 1);
  const records = await readWatchdogLog(homeDir);
  assert.deepEqual(records, [{
    ts: records[0]?.ts,
    level: 'info',
    dataset: 'turn',
    event: 'compacted',
    version: 7,
    details: {
      changed: true,
      fragmentCount: 4,
      rowCount: 10,
    },
  }]);
});

test('watchdog creates and optimizes semantic index only once for an unchanged version', async (t) => {
  const { dir, homeDir } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  let ensureCalls = 0;
  let optimizeCalls = 0;
  const runtime = new Watchdog({
    sessionTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    observingTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    semanticIndexTable: {
      ensureVectorIndex: async () => {
        ensureCalls += 1;
        return { created: ensureCalls === 1 };
      },
      stats: async () => ({
        version: 11,
        fragmentCount: 1,
        rowCount: 3,
      }),
      compact: async () => ({ changed: false }),
      optimize: async () => {
        optimizeCalls += 1;
        return { changed: true };
      },
    },
  }, createWatchdogConfig({ compactMinFragments: 3 }));
  t.after(async () => runtime.stop());

  runtime.start();
  await waitFor(() => optimizeCalls === 1);
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(optimizeCalls, 1);
  const records = await readWatchdogLog(homeDir);
  assert.ok(records.some((record) => (
    record.dataset === 'semanticIndex'
    && record.event === 'index_created'
    && record.version === 11
  )));
  assert.ok(records.some((record) => (
    record.dataset === 'semanticIndex'
    && record.event === 'optimized'
    && record.details?.indexCreated === true
  )));
  assert.equal(records.length, 2);
});

test('watchdog below-threshold cycles do not compact or write logs', async (t) => {
  const { dir, homeDir } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  let compactCalls = 0;
  let statsCalls = 0;
  const runtime = new Watchdog({
    sessionTable: {
      stats: async () => {
        statsCalls += 1;
        return {
          version: 3,
          fragmentCount: 1,
          rowCount: 4,
        };
      },
      compact: async () => {
        compactCalls += 1;
        return { changed: false };
      },
    },
    observingTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    semanticIndexTable: {
      ensureVectorIndex: async () => ({ created: false }),
      stats: async () => null,
      compact: async () => ({ changed: false }),
      optimize: async () => ({ changed: false }),
    },
  }, createWatchdogConfig({ compactMinFragments: 2 }));
  t.after(async () => runtime.stop());

  runtime.start();
  await waitFor(() => statsCalls > 0);
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(compactCalls, 0);
  assert.ok(statsCalls > 1);
  assert.deepEqual(await readWatchdogLog(homeDir), []);
});

test('watchdog logs dataset failures to file and stderr', async (t) => {
  const { dir, homeDir } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  const errors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => {
    errors.push(args.join(' '));
  };
  t.after(() => {
    console.error = originalConsoleError;
  });

  const runtime = new Watchdog({
    sessionTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    observingTable: {
      stats: async () => ({
        version: 5,
        fragmentCount: 6,
        rowCount: 9,
      }),
      compact: async () => {
        throw new Error('observing compact failed');
      },
    },
    semanticIndexTable: {
      ensureVectorIndex: async () => ({ created: false }),
      stats: async () => null,
      compact: async () => ({ changed: false }),
      optimize: async () => ({ changed: false }),
    },
  }, createWatchdogConfig());
  t.after(async () => runtime.stop());

  runtime.start();
  await waitFor(async () => (await readWatchdogLog(homeDir)).some((record) => record.event === 'failed'));

  const records = await readWatchdogLog(homeDir);
  assert.ok(records.some((record) => (
    record.level === 'error'
    && record.dataset === 'observing'
    && record.event === 'failed'
    && record.version === 5
    && /observing compact failed/i.test(String(record.details?.errorMessage))
  )));
  assert.ok(errors.some((entry) => /observing maintenance failed: observing compact failed/i.test(entry)));
});

test('watchdog logs semantic optimize failures with the current stats version', async (t) => {
  const { dir, homeDir } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  const runtime = new Watchdog({
    sessionTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    observingTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    semanticIndexTable: {
      ensureVectorIndex: async () => ({ created: false }),
      stats: async () => ({
        version: 13,
        fragmentCount: 1,
        rowCount: 2,
      }),
      compact: async () => ({ changed: false }),
      optimize: async () => {
        throw new Error('semantic optimize failed');
      },
    },
  }, createWatchdogConfig({ compactMinFragments: 3 }));
  t.after(async () => runtime.stop());

  runtime.start();
  await waitFor(async () => (await readWatchdogLog(homeDir)).some((record) => record.event === 'failed'));

  const records = await readWatchdogLog(homeDir);
  assert.ok(records.some((record) => (
    record.level === 'error'
    && record.dataset === 'semanticIndex'
    && record.event === 'failed'
    && record.version === 13
    && /semantic optimize failed/i.test(String(record.details?.errorMessage))
  )));
});

test('watchdog logs null version when stats fails before reading the current dataset version', async (t) => {
  const { dir, homeDir } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  let statsCalls = 0;
  const runtime = new Watchdog({
    sessionTable: {
      stats: async () => {
        statsCalls += 1;
        if (statsCalls === 1) {
          return {
            version: 7,
            fragmentCount: 1,
            rowCount: 2,
          };
        }
        throw new Error('session stats failed');
      },
      compact: async () => ({ changed: false }),
    },
    observingTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    semanticIndexTable: {
      ensureVectorIndex: async () => ({ created: false }),
      stats: async () => null,
      compact: async () => ({ changed: false }),
      optimize: async () => ({ changed: false }),
    },
  }, createWatchdogConfig({ compactMinFragments: 2 }));
  t.after(async () => runtime.stop());

  runtime.start();
  await waitFor(async () => (await readWatchdogLog(homeDir)).some((record) => (
    record.dataset === 'turn' && record.event === 'failed'
  )));

  const records = await readWatchdogLog(homeDir);
  assert.ok(records.some((record) => (
    record.level === 'error'
    && record.dataset === 'turn'
    && record.event === 'failed'
    && record.version === null
    && /session stats failed/i.test(String(record.details?.errorMessage))
  )));
});

test('getPendingIndex returns the unindexed snapshot range', () => {
  const pending = getPendingIndex({
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
  });
  assert.deepEqual(pending, {
    start: 1,
    end: 1,
  });
});

test('getPendingIndexUpTo only reports snapshots at or before the barrier epoch', () => {
  const pending = getPendingIndexUpTo({
    observingId: 'observing-a',
    observingEpoch: 8,
    title: 'Title',
    summary: 'Summary',
    snapshots: [
      { memories: [], openQuestions: [], nextSteps: [], memoryDelta: { before: [], after: [] } },
      { memories: [], openQuestions: [], nextSteps: [], memoryDelta: { before: [], after: [] } },
      { memories: [], openQuestions: [], nextSteps: [], memoryDelta: { before: [], after: [] } },
    ],
    snapshotIds: ['snapshot-0', 'snapshot-1', 'snapshot-2'],
    snapshotEpochs: [6, 7, 8],
    indexedSnapshotSequence: 0,
    references: [],
    observer: 'default-observer',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  }, 7);
  assert.deepEqual(pending, {
    start: 1,
    end: 1,
  });
});

test('epochQueue.shift returns a published epoch without waiting', () => {
  const queue = new EpochQueue();
  const turn = {
    turnId: 'turn-1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    agent: 'agent-a',
    observer: 'default-observer',
    summary: 'queued summary',
    response: 'queued response',
    observingEpoch: 1,
  };

  queue.publishEpoch({ epoch: 1, turns: [turn] });

  assert.deepEqual(queue.shift(), {
    epoch: 1,
    turns: [{
      ...turn,
      toolCalling: undefined,
      artifacts: undefined,
    }],
  });
  assert.equal(queue.shift(), null);
});

test('observer.watermark stays unresolved when only semantic index work is pending', async () => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  try {
    const observer = new Observer({});
    observer.bootstrapped = true;
    observer.openEpoch = new OpenEpoch(8);
    observer.threads = [{
      observingId: 'observing-a',
      snapshotId: 'snapshot-1',
      snapshotIds: ['snapshot-0', 'snapshot-1'],
      observingEpoch: 7,
      title: 'Title',
      summary: 'Summary',
      snapshots: [
        { memories: [], openQuestions: [], nextSteps: [], memoryDelta: { before: [], after: [] } },
        { memories: [], openQuestions: [], nextSteps: [], memoryDelta: { before: [], after: [] } },
      ],
      references: [],
      indexedSnapshotSequence: 0,
      observer: 'default-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }];

    const watermark = await observer.watermark();
    assert.deepEqual(watermark.pendingTurnIds, []);
    assert.equal(watermark.resolved, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('muninn.recallMemories does not wait for observer flushes', async () => {
  const muninn = new Muninn({});
  let flushPendingCalls = 0;
  let recallCalls = 0;

  muninn.ensureObserver = async () => ({
    flushPending: async () => {
      flushPendingCalls += 1;
    },
    shutdown: async () => {},
    watermark: async () => ({
      resolved: true,
      pendingTurnIds: [],
      observingEpoch: undefined,
      committedEpoch: undefined,
    }),
  });
  muninn.memories.recall = async () => {
    recallCalls += 1;
    return [];
  };

  await muninn.recallMemories('remember this');
  assert.equal(flushPendingCalls, 0);
  assert.equal(recallCalls, 1);
});

test('session registry reuses one in-flight session load per key', async () => {
  let loadOpenTurnCalls = 0;
  let releaseLoad;
  const loadStarted = new Promise((resolve) => {
    releaseLoad = resolve;
  });

  const registry = new SessionRegistry({
    sessionTable: {
      loadOpenTurn: async () => {
        loadOpenTurnCalls += 1;
        await loadStarted;
        return null;
      },
    },
  }, 'default-observer');

  const first = registry.load('group-a', 'agent-a');
  const second = registry.load('group-a', 'agent-a');
  await Promise.resolve();

  assert.equal(loadOpenTurnCalls, 1);
  releaseLoad();

  const [firstSession, secondSession] = await Promise.all([first, second]);
  assert.strictEqual(firstSession, secondSession);
});

test('session key normalizes sessionId whitespace', async () => {
  assert.equal(
    sessionKey('group-a', 'agent-a', 'default-observer'),
    sessionKey(' group-a ', 'agent-a', 'default-observer'),
  );
  assert.equal(normalizeSessionId(' group-a '), 'group-a');
  assert.equal(normalizeSessionId('   '), undefined);
});

test('session registry reuses the same load for trimmed session ids', async () => {
  let loadOpenTurnCalls = 0;
  const registry = new SessionRegistry({
    sessionTable: {
      loadOpenTurn: async ({ sessionId }) => {
        loadOpenTurnCalls += 1;
        assert.equal(sessionId, 'group-a');
        return null;
      },
    },
  }, 'default-observer');

  const first = registry.load('group-a', 'agent-a');
  const second = registry.load(' group-a ', 'agent-a');
  const [firstSession, secondSession] = await Promise.all([first, second]);

  assert.equal(loadOpenTurnCalls, 1);
  assert.strictEqual(firstSession, secondSession);
});

test('repairOpenTurns groups duplicates with TS session semantics', async () => {
  const updated = [];
  const deleted = [];

  const repaired = await __testing.repairOpenTurns({
    sessionTable: {
      listTurns: async () => [
        {
          turnId: 'session:1',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          session_id: ' group-a ',
          agent: 'agent-a',
          observer: 'default-observer',
          prompt: 'first prompt',
        },
        {
          turnId: 'session:2',
          createdAt: '2024-01-01T00:00:01Z',
          updatedAt: '2024-01-01T00:00:01Z',
          sessionId: 'group-a',
          agent: 'agent-a',
          observer: 'default-observer',
          toolCalling: ['tool-a'],
        },
        {
          turnId: 'session:3',
          createdAt: '2024-01-01T00:00:02Z',
          updatedAt: '2024-01-01T00:00:02Z',
          session_id: '   ',
          agent: 'agent-a',
          observer: 'default-observer',
          prompt: 'default prompt',
        },
        {
          turnId: 'session:4',
          createdAt: '2024-01-01T00:00:03Z',
          updatedAt: '2024-01-01T00:00:03Z',
          sessionId: null,
          agent: 'agent-a',
          observer: 'default-observer',
          artifacts: { key: 'value' },
        },
        {
          turnId: 'session:5',
          createdAt: '2024-01-01T00:00:04Z',
          updatedAt: '2024-01-01T00:00:04Z',
          sessionId: null,
          agent: 'agent-b',
          observer: 'default-observer',
          prompt: 'other agent',
        },
      ],
      update: async ({ turns }) => {
        updated.push(turns[0]);
        return turns;
      },
      deleteTurns: async ({ turnIds }) => {
        deleted.push(turnIds);
        return { deleted: turnIds.length };
      },
    },
  });

  assert.equal(repaired, 2);
  assert.equal(updated.length, 2);
  assert.equal(updated[0].session_id, 'group-a');
  assert.equal(updated[0].prompt, 'first prompt');
  assert.deepEqual(updated[0].toolCalling, ['tool-a']);
  assert.equal(updated[1].session_id, null);
  assert.equal(updated[1].prompt, 'default prompt');
  assert.deepEqual(updated[1].artifacts, { key: 'value' });
  assert.deepEqual(deleted, [['session:1'], ['session:3']]);
});

test('session.accept serializes concurrent updates on the same open turn', async () => {
  let concurrentUpdates = 0;
  let maxConcurrentUpdates = 0;

  const session = new Session({
    sessionTable: {
      update: async ({ turns }) => {
        concurrentUpdates += 1;
        maxConcurrentUpdates = Math.max(maxConcurrentUpdates, concurrentUpdates);
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrentUpdates -= 1;
        return turns;
      },
    },
  }, {
    sessionId: 'group-a',
    agent: 'agent-a',
    observer: 'default-observer',
    openTurn: {
      turnId: 'session:1',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      sessionId: 'group-a',
      agent: 'agent-a',
      observer: 'default-observer',
      prompt: 'base prompt',
    },
  });

  const first = session.accept({
    sessionId: 'group-a',
    agent: 'agent-a',
    toolCalling: ['tool-a'],
  }, 1);
  const second = session.accept({
    sessionId: 'group-a',
    agent: 'agent-a',
    artifacts: { key: 'value' },
  }, 1);

  const [, merged] = await Promise.all([first, second]);
  assert.equal(maxConcurrentUpdates, 1);
  assert.deepEqual(merged.toolCalling, ['tool-a']);
  assert.deepEqual(merged.artifacts, { key: 'value' });
});

test('observer.observeCurrentEpoch keeps thread state unchanged when pre-commit work fails', async () => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  try {
    const observer = new Observer({
      observingTable: {
        insert: async () => {
          throw new Error('persist failed');
        },
      },
    });
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
    observer.openEpoch = new OpenEpoch(2);
    observer.currentEpoch = { epoch: 1, turns: [turn] };
    observer.threads = structuredClone(originalThreads);

    await assert.rejects(() => observer.observeCurrentEpoch(), /persist failed/);
    assert.deepEqual(observer.threads, originalThreads);
    assert.deepEqual(observer.currentEpoch, { epoch: 1, turns: [turn] });
    assert.equal(observer.committedEpoch, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildSemanticIndex surfaces semantic write failures and leaves work pending', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const threads = [
    {
      observingId: 'observing-a',
      snapshotId: 'snapshot-1',
      snapshotIds: ['snapshot-0', 'snapshot-1'],
      observingEpoch: 7,
      title: 'Title',
      summary: 'Summary',
      snapshots: [
        {
          memories: [],
          openQuestions: [],
          nextSteps: [],
          memoryDelta: { before: [], after: [] },
        },
        {
          memories: [],
          openQuestions: [],
          nextSteps: [],
          memoryDelta: {
            before: [],
            after: [{ id: 'memory-1', text: 'remember this', category: 'Fact', updatedMemory: null }],
          },
        },
      ],
      references: [],
      indexedSnapshotSequence: 0,
      observer: 'default-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
  ];
  let semanticUpserts = 0;

  await assert.rejects(
    () => updateTesting.buildSemanticIndex({
      observingTable: {
        update: async ({ snapshots }) => snapshots,
      },
      semanticIndexTable: {
        delete: async () => ({ deleted: 0 }),
        loadByIds: async () => [],
        upsert: async () => {
          semanticUpserts += 1;
          throw new Error('semantic write failed');
        },
      },
    }, threads),
    /semantic write failed/,
  );

  assert.equal(semanticUpserts, 1);
  assert.deepEqual(getPendingIndex(threads[0]), { start: 1, end: 1 });
});

test('buildTouchedIndex immediately advances semantic index for touched threads', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  let semanticUpserts = 0;
  const threads = [{
    observingId: 'observing-a',
    snapshotId: 'snapshot-1',
    snapshotIds: ['snapshot-0', 'snapshot-1'],
    observingEpoch: 1,
    title: 'Existing title',
    summary: 'Existing summary',
    snapshots: [
      { memories: [], openQuestions: [], nextSteps: [], memoryDelta: { before: [], after: [] } },
      {
        memories: [],
        openQuestions: [],
        nextSteps: [],
        memoryDelta: {
          before: [],
          after: [{ id: 'memory-1', text: 'remember this', category: 'Fact', updatedMemory: null }],
        },
      },
    ],
    references: ['session:existing'],
    indexedSnapshotSequence: 0,
    observer: 'default-observer',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  }];

  await updateTesting.buildTouchedIndex({
    observingTable: {
      update: async ({ snapshots }) => snapshots,
    },
    semanticIndexTable: {
      delete: async () => ({ deleted: 0 }),
      loadByIds: async () => [],
      upsert: async () => {
        semanticUpserts += 1;
      },
    },
  }, threads, new Set(['observing-a']));

  assert.equal(semanticUpserts, 1);
  assert.equal(threads[0].indexedSnapshotSequence, 1);
  assert.equal(getPendingIndex(threads[0]), null);
});

test('observer.observeCurrentEpoch commits observing rows and schedules semantic index retry', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  let semanticUpserts = 0;
  const observer = new Observer({
    observingTable: {
      insert: async ({ snapshots }) => snapshots.map((snapshot) => ({
        ...snapshot,
        snapshotId: 'snapshot-1',
      })),
      update: async ({ snapshots }) => snapshots,
    },
    semanticIndexTable: {
      delete: async () => ({ deleted: 0 }),
      loadByIds: async () => [],
      upsert: async () => {
        semanticUpserts += 1;
        throw new Error('semantic write failed');
      },
    },
  });

  observer.bootstrapped = true;
  observer.openEpoch = new OpenEpoch(2);
  observer.currentEpoch = {
    epoch: 1,
    turns: [makeObservableTurn('turn-1', 1, 'first')],
  };
  observer.threads = [{
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
  observer.buildCurrentEpochIndex = async () => {
    semanticUpserts += 1;
    throw new Error('semantic write failed');
  };

  await observer.observeCurrentEpoch();

  assert.equal(semanticUpserts, 1);
  assert.equal(observer.committedEpoch, 1);
  assert.equal(observer.currentEpoch, null);
  assert.equal(observer.threads[0].snapshotId, 'snapshot-1');
  assert.ok(getPendingIndex(observer.threads[0]) !== null);
  assert.ok(observer.nextIndexRetryAt > Date.now());
});

test('observer.run retries pending semantic index before queued epochs when due', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const calls = [];
  const observer = new Observer({
    observingTable: {
      update: async ({ snapshots }) => snapshots,
    },
    semanticIndexTable: {
      delete: async () => ({ deleted: 0 }),
      loadByIds: async () => [],
      upsert: async () => {
        calls.push('index');
      },
    },
  });

  observer.bootstrapped = true;
  observer.openEpoch = new OpenEpoch(9);
  observer.threads = [
    {
      observingId: 'observing-a',
      snapshotId: 'snapshot-1',
      snapshotIds: ['snapshot-0', 'snapshot-1'],
      observingEpoch: 7,
      title: 'Title',
      summary: 'Summary',
      snapshots: [
        {
          memories: [],
          openQuestions: [],
          nextSteps: [],
          memoryDelta: { before: [], after: [] },
        },
        {
          memories: [],
          openQuestions: [],
          nextSteps: [],
          memoryDelta: {
            before: [],
            after: [{ id: 'memory-1', text: 'remember this', category: 'Fact', updatedMemory: null }],
          },
        },
      ],
      references: [],
      indexedSnapshotSequence: 0,
      observer: 'default-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
  ];
  observer.nextIndexRetryAt = Date.now() - 1;
  observer.epochQueue.publishEpoch({
    epoch: 8,
    turns: [
      {
        turnId: 'turn-queued',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        agent: 'agent-a',
        observer: 'default-observer',
        summary: 'queued summary',
        response: 'queued response',
        observingEpoch: 8,
      },
    ],
  });

  observer.retrySemanticIndex = async () => {
    calls.push('index');
    observer.nextIndexRetryAt = undefined;
    observer.threads = [];
  };
  observer.observeCurrentEpoch = async () => {
    calls.push('observe');
    observer.currentEpoch = null;
    observer.threads = [];
    observer.shuttingDown = true;
    observer.epochQueue.close();
  };

  await observer.run();

  assert.deepEqual(calls, ['index', 'observe']);
});

test('flushPending waits for an in-flight accept that started before the barrier', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const observer = new Observer(makeObserverClient());
  observer.bootstrapped = true;
  observer.openEpoch = new OpenEpoch(1);
  observer.start();
  t.after(async () => observer.shutdown());

  const firstEntered = deferred();
  const releaseFirst = deferred();
  const registry = {
    load: async () => ({
      accept: async (_content, epoch) => {
        firstEntered.resolve();
        await releaseFirst.promise;
        return makeObservableTurn('turn-1', epoch, 'first');
      },
    }),
  };

  const acceptPromise = observer.accept({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'first prompt',
    response: 'first response',
  }, registry);
  await firstEntered.promise;

  const flushPromise = observer.flushPending();
  const pendingState = await Promise.race([
    flushPromise.then(() => 'flushed'),
    new Promise((resolve) => setTimeout(() => resolve('waiting'), 25)),
  ]);
  assert.equal(pendingState, 'waiting');

  releaseFirst.resolve();
  await acceptPromise;
  await flushPromise;

  assert.equal(observer.committedEpoch, 1);
});

test('flushPending does not wait for accepts that start after the barrier', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const observer = new Observer(makeObserverClient());
  observer.bootstrapped = true;
  observer.openEpoch = new OpenEpoch(1);
  observer.start();
  t.after(async () => observer.shutdown());

  const secondEntered = deferred();
  const releaseSecond = deferred();
  let acceptCount = 0;
  let secondEpoch;
  const registry = {
    load: async () => ({
      accept: async (_content, epoch) => {
        acceptCount += 1;
        if (acceptCount === 1) {
          return makeObservableTurn('turn-1', epoch, 'first');
        }
        secondEpoch = epoch;
        secondEntered.resolve();
        await releaseSecond.promise;
        return makeObservableTurn('turn-2', epoch, 'second');
      },
    }),
  };

  await observer.accept({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'first prompt',
    response: 'first response',
  }, registry);

  const flushPromise = observer.flushPending();
  while (observer.openEpoch.epoch !== 3) {
    await Promise.resolve();
  }

  const secondAccept = observer.accept({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'second prompt',
    response: 'second response',
  }, registry);
  await secondEntered.promise;

  await Promise.race([
    flushPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('flushPending waited on post-barrier accept')), 100)),
  ]);

  assert.equal(secondEpoch, 3);

  releaseSecond.resolve();
  await secondAccept;
});

test('flushPending rejects when sealing the barrier epoch fails', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const observer = new Observer(makeObserverClient());
  observer.bootstrapped = true;
  observer.openEpoch = {
    epoch: 1,
    hasStagedTurns: () => true,
    stagedTurns: () => [],
    seal: async () => {
      throw new Error('seal failed');
    },
  };

  await assert.rejects(
    () => observer.flushPending(),
    /seal failed/,
  );
});

test('observer.accept rejects new writes after shutdown starts', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const observer = new Observer(makeObserverClient());
  observer.bootstrapped = true;
  observer.openEpoch = new OpenEpoch(1);

  await observer.shutdown();

  await assert.rejects(
    () => observer.accept({
      sessionId: 'group-a',
      agent: 'agent-a',
      prompt: 'late prompt',
      response: 'late response',
    }, {
      load: async () => ({
        accept: async () => makeObservableTurn('turn-late', 1, 'late'),
      }),
    }),
    /observer is shutting down/,
  );
});

test('observer.shutdown does not wait for pending publish chain', async () => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  try {
    const observer = new Observer({});
    observer.bootstrapped = true;
    observer.openEpoch = new OpenEpoch(1);

    let releasePublish;
    observer.publishChain = new Promise((resolve) => {
      releasePublish = resolve;
    });

    const shutdownPromise = observer.shutdown();
    await Promise.race([
      shutdownPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown blocked on publish chain')), 50)),
    ]);

    releasePublish();
    await observer.publishChain;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('observer.watermark keeps sealed turns visible while publish is in flight', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const observer = new Observer({});
  observer.bootstrapped = true;
  const turn = makeObservableTurn('session:42', 7, 'publishing');
  const openEpoch = new OpenEpoch(7, [turn]);
  observer.openEpoch = openEpoch;

  let releasePublish;
  observer.publishChain = new Promise((resolve) => {
    releasePublish = resolve;
  });

  const barrier = observer.sealOpenEpoch(openEpoch);
  assert.ok(barrier);

  const watermark = await observer.watermark();
  assert.deepEqual(watermark.pendingTurnIds, [turn.turnId]);
  assert.equal(watermark.resolved, false);

  releasePublish();
  await observer.publishChain;
});

test('observer shutdown relies on restart replay for unpublished observer work', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeOpenAiObserverConfig(configPath);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => (
    new Promise((_, reject) => {
      const signal = init?.signal;
      const onAbort = () => reject(signal?.reason ?? Object.assign(new Error('operation aborted'), { name: 'AbortError' }));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    })
  );
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const turn = await addMessage({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'replay prompt',
    response: 'replay response',
  });

  await shutdownCoreForTests();

  const watermark = await observerApi.watermark();
  assert.ok(watermark.pendingTurnIds.includes(turn.turnId));

  await shutdownCoreForTests();
});

test('flushThreads persists observing state without inline ref or index builders', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const threads = [
    {
      observingId: 'observing-child',
      snapshotId: undefined,
      snapshotIds: [],
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

  await updateTesting.flushThreads({
    observingTable: {
      insert: async ({ snapshots }) => {
        return snapshots.map((snapshot) => ({
          ...snapshot,
          snapshotId: snapshot.observingId === 'observing-child' ? 'snapshot-child' : snapshot.snapshotId,
        }));
      },
    },
  }, threads, new Set(['observing-child']));

  assert.equal(threads[0].snapshotId, 'snapshot-child');
  assert.equal(threads[0].indexedSnapshotSequence, null);
});
