import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';

import core from '../dist/index.js';
import { __testing } from '../dist/client.js';
import { getObserverLlmConfig, validateMuninnConfigInput } from '../dist/config.js';
import { MuninnBackend } from '../dist/backend.js';
import { Observer } from '../dist/observer/observer.js';
import { EpochQueue, OpenEpoch } from '../dist/observer/epoch.js';
import { readCheckpointFile, resolveCheckpointPath } from '../dist/checkpoint.js';
import { SessionRegistry } from '../dist/session/registry.js';
import { normalizeSessionId, sessionKey } from '../dist/session/key.js';
import { Session } from '../dist/session/session.js';
import { Watchdog } from '../dist/watchdog.js';
import updateModule from '../dist/observer/update.js';
import threadModule from '../dist/observer/thread.js';
import observingGatewayModule from '../dist/llm/observing-gateway.js';

const { __testing: updateTesting } = updateModule;
const { __testing: threadTesting } = threadModule;
const { __testing: observingGatewayTesting } = observingGatewayModule;
const { createObservingThread, getPendingIndex, getPendingIndexUpTo, loadThreads, toObservingSnapshot } = threadModule;
const { addMessage, observer: observerApi, shutdownCoreForTests } = core;
const CHECKPOINT_SCHEMA_VERSION = 3;

function createCheckpointBackend(exported = null) {
  return {
    exportCheckpoint: async () => exported,
  };
}

async function makeConfigHome() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-observer-internals-'));
  return {
    dir,
    homeDir: path.join(dir, 'muninn'),
    configPath: path.join(dir, 'muninn', 'muninn.json'),
  };
}

async function writeObserverConfig(configPath, { activeWindowDays = 3650, name = 'default-observer' } = {}) {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    observer: {
      name,
      llm: 'observer_llm',
      maxAttempts: 3,
      activeWindowDays,
    },
    llm: {
      observer_llm: {
        provider: 'mock',
      },
    },
    observation: {
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
      activeWindowDays: 3650,
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
    observation: {
      embedding: {
        provider: 'mock',
        dimensions: 8,
      },
      defaultImportance: 0.7,
    },
  }, null, 2)}\n`, 'utf8');
}

test('config reads observation embedding config and rejects semanticIndex', async () => {
  assert.doesNotThrow(() => validateMuninnConfigInput(JSON.stringify({
    storage: { uri: 'file:///tmp/muninn-test' },
    observer: { name: 'default-observer', llm: 'observer_llm' },
    llm: { observer_llm: { provider: 'mock' } },
    observation: { embedding: { provider: 'mock' } },
  })));
  assert.throws(() => validateMuninnConfigInput(JSON.stringify({
    storage: { uri: 'file:///tmp/muninn-test' },
    observer: { name: 'default-observer', llm: 'observer_llm' },
    llm: { observer_llm: { provider: 'mock' } },
    semanticIndex: { embedding: { provider: 'mock' } },
  })), /semanticIndex/);
});

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

function makeRecentTurn(turnId, text = turnId) {
  return {
    turnId,
    updatedAt: '2024-01-01T00:00:00Z',
    prompt: `${text} prompt`,
    response: `${text} response`,
  };
}

function storedObservation(id) {
  return {
    id,
    text: `${id} text`,
    vector: [1, 0, 0, 0],
    importance: 1,
    category: 'fact',
    references: ['session:1'],
    createdAt: '2024-01-01T00:00:00Z',
  };
}

function makePersistedTurn(turnId, text = turnId) {
  return {
    turnId,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    sessionId: 'group-a',
    agent: 'agent-a',
    observer: 'default-observer',
    prompt: `${text} prompt`,
    response: `${text} response`,
  };
}

test('createObservingThread preserves complete readable title and summary text', () => {
  const title = 'Caroline LGBTQ support group impact and counseling career direction';
  const summary = [
    'Caroline attended an LGBTQ support group on 7 May 2023.',
    'The group made Caroline feel accepted and gave her courage to embrace herself.',
    'Caroline plans to continue education and explore counseling or mental health work.',
    'Melanie believes Caroline would be a strong counselor because of Caroline\'s empathy and understanding.',
  ].join(' ');

  const thread = createObservingThread(
    'default-observer',
    title,
    summary,
    [],
    1,
    '2024-01-01T00:00:00Z',
  );

  assert.equal(thread.title, title);
  assert.equal(thread.summary, summary);
  assert.doesNotMatch(thread.title, /\.\.\.$/);
  assert.doesNotMatch(thread.summary, /\.\.\.$/);
});

function makeRecentSessionCheckpoint(turns, sessionId = 'group-a', agent = 'agent-a') {
  return {
    sessionId,
    agent,
    turns,
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
    observationTable: {
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

async function readCheckpoint() {
  return JSON.parse(await readFile(resolveCheckpointPath(), 'utf8'));
}

function createWatchdogConfig(overrides = {}) {
  return {
    enabled: true,
    intervalMs: 30,
    compactMinFragments: 2,
    observation: {
      targetPartitionSize: 16,
      optimizeMergeCount: 4,
    },
    ...overrides,
  };
}

test.beforeEach(async () => {
  await __testing.shutdownCoreForTests();
  delete process.env.MUNINN_HOME;
});

test.after(async () => {
  await __testing.shutdownCoreForTests();
  delete process.env.MUNINN_HOME;
});

test('getObserverLlmConfig defaults activeWindowDays to 7 and continuityHints to 1', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

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
    observation: {
      embedding: {
        provider: 'mock',
        dimensions: 8,
      },
      defaultImportance: 0.7,
    },
  }, null, 2)}\n`, 'utf8');

  const config = getObserverLlmConfig();
  assert.ok(config);
  assert.equal(config.activeWindowDays, 7);
  assert.equal(config.continuityHints, 1);
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
    observationTable: {
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
    observationTable: {
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

test('watchdog creates and optimizes observation index only once for an unchanged version', async (t) => {
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
    observationTable: {
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
    record.dataset === 'observation'
    && record.event === 'index_created'
    && record.version === 11
  )));
  assert.ok(records.some((record) => (
    record.dataset === 'observation'
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
    observationTable: {
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
    observationTable: {
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

test('watchdog logs observation optimize failures with the current stats version', async (t) => {
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
    observationTable: {
      ensureVectorIndex: async () => ({ created: false }),
      stats: async () => ({
        version: 13,
        fragmentCount: 1,
        rowCount: 2,
      }),
      compact: async () => ({ changed: false }),
      optimize: async () => {
        throw new Error('observation optimize failed');
      },
    },
  }, createWatchdogConfig({ compactMinFragments: 3 }));
  t.after(async () => runtime.stop());

  runtime.start();
  await waitFor(async () => (await readWatchdogLog(homeDir)).some((record) => record.event === 'failed'));

  const records = await readWatchdogLog(homeDir);
  assert.ok(records.some((record) => (
    record.level === 'error'
    && record.dataset === 'observation'
    && record.event === 'failed'
    && record.version === 13
    && /observation optimize failed/i.test(String(record.details?.errorMessage))
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
    observationTable: {
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

test('watchdog writes observer checkpoint files', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const runtime = new Watchdog({
    sessionTable: {
      stats: async () => ({
        version: 10,
        fragmentCount: 1,
        rowCount: 1,
      }),
      compact: async () => ({ changed: false }),
    },
    observingTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    observationTable: {
      ensureVectorIndex: async () => ({ created: false }),
      stats: async () => null,
      compact: async () => ({ changed: false }),
      optimize: async () => ({ changed: false }),
    },
  }, createWatchdogConfig({ intervalMs: 25, compactMinFragments: 3 }), createCheckpointBackend({
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    observer: {
        baseline: {
          turn: 10,
          observing: 21,
          observation: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [makeRecentSessionCheckpoint([makeRecentTurn('session:101', 'checkpoint-1')])],
        threads: [{
          observingId: 'obs-1',
          latestSnapshotId: 'observing:42',
          latestSnapshotSequence: 2,
          indexedSnapshotSequence: 1,
          updatedAt: '2024-01-01T00:00:00Z',
        }],
      },
  }));
  t.after(async () => runtime.stop());

  runtime.start();
  await waitFor(async () => {
    try {
      const checkpoint = await readCheckpoint();
      return checkpoint.observer?.threads?.length === 1;
    } catch {
      return false;
    }
  });

  const checkpoint = await readCheckpoint();
  assert.equal(checkpoint.schemaVersion, CHECKPOINT_SCHEMA_VERSION);
  assert.deepEqual(checkpoint.observer, {
    baseline: {
      turn: 10,
      observing: 21,
      observation: 8,
    },
    committedEpoch: 12,
    nextEpoch: 13,
    recentSessions: [makeRecentSessionCheckpoint([makeRecentTurn('session:101', 'checkpoint-1')])],
    threads: [{
      observingId: 'obs-1',
      latestSnapshotId: 'observing:42',
      latestSnapshotSequence: 2,
      indexedSnapshotSequence: 1,
      updatedAt: '2024-01-01T00:00:00Z',
    }],
  });
});

test('watchdog skips checkpoint writes when contributors return no observer state', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  const existing = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    observer: {
        baseline: {
          turn: 10,
          observing: 21,
          observation: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [],
        threads: [],
      },
  };
  await writeFile(resolveCheckpointPath(), `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  const before = await readFile(resolveCheckpointPath(), 'utf8');
  const beforeStat = await stat(resolveCheckpointPath());

  const runtime = new Watchdog({
    sessionTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    observingTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    observationTable: {
      ensureVectorIndex: async () => ({ created: false }),
      stats: async () => null,
      compact: async () => ({ changed: false }),
      optimize: async () => ({ changed: false }),
    },
  }, createWatchdogConfig({ intervalMs: 25 }), createCheckpointBackend(null));
  t.after(async () => runtime.stop());

  runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 80));

  const after = await readFile(resolveCheckpointPath(), 'utf8');
  const afterStat = await stat(resolveCheckpointPath());
  assert.equal(after, before);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
});

test('watchdog skips checkpoint writes when observer content is unchanged', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const checkpointContent = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    observer: {
        baseline: {
          turn: 10,
          observing: 21,
          observation: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [makeRecentSessionCheckpoint([makeRecentTurn('session:101', 'checkpoint-2')])],
        threads: [{
          observingId: 'obs-1',
          latestSnapshotId: 'observing:42',
          latestSnapshotSequence: 2,
          indexedSnapshotSequence: 1,
          updatedAt: '2024-01-01T00:00:00Z',
        }],
      },
  };
  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify({
    ...checkpointContent,
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
  }, null, 2)}\n`, 'utf8');
  const before = await readFile(resolveCheckpointPath(), 'utf8');
  const beforeStat = await stat(resolveCheckpointPath());
  const lastCheckpointJson = JSON.stringify(checkpointContent);

  const runtime = new Watchdog({
    sessionTable: {
      stats: async () => ({
        version: 10,
        fragmentCount: 1,
        rowCount: 1,
      }),
      compact: async () => ({ changed: false }),
    },
    observingTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    observationTable: {
      ensureVectorIndex: async () => ({ created: false }),
      stats: async () => null,
      compact: async () => ({ changed: false }),
      optimize: async () => ({ changed: false }),
    },
  }, createWatchdogConfig({ intervalMs: 25 }), createCheckpointBackend(checkpointContent), lastCheckpointJson);
  t.after(async () => runtime.stop());

  runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 80));

  const after = await readFile(resolveCheckpointPath(), 'utf8');
  const afterStat = await stat(resolveCheckpointPath());
  assert.equal(after, before);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
});

test('watchdog rewrites checkpoint when the file is deleted after startup', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const checkpointContent = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    observer: {
        baseline: {
          turn: 10,
          observing: 21,
          observation: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [makeRecentSessionCheckpoint([makeRecentTurn('session:101', 'checkpoint-3')])],
        threads: [{
          observingId: 'obs-1',
          latestSnapshotId: 'observing:42',
          latestSnapshotSequence: 2,
          indexedSnapshotSequence: 1,
          updatedAt: '2024-01-01T00:00:00Z',
        }],
      },
  };
  const lastCheckpointJson = JSON.stringify(checkpointContent);
  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify({
    ...checkpointContent,
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
  }, null, 2)}\n`, 'utf8');
  await rm(resolveCheckpointPath());

  const runtime = new Watchdog({
    sessionTable: {
      stats: async () => ({
        version: 10,
        fragmentCount: 1,
        rowCount: 1,
      }),
      compact: async () => ({ changed: false }),
    },
    observingTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    observationTable: {
      ensureVectorIndex: async () => ({ created: false }),
      stats: async () => null,
      compact: async () => ({ changed: false }),
      optimize: async () => ({ changed: false }),
    },
  }, createWatchdogConfig({ intervalMs: 25 }), createCheckpointBackend(checkpointContent), lastCheckpointJson);
  t.after(async () => runtime.stop());

  runtime.start();
  await waitFor(async () => {
    try {
      await access(resolveCheckpointPath());
      return true;
    } catch {
      return false;
    }
  });

  const checkpoint = await readCheckpoint();
  assert.equal(checkpoint.observer.committedEpoch, 12);
});

test('readCheckpointFile throws when the checkpoint file is invalid JSON', async (t) => {
  const { dir, homeDir } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), '{invalid-json', 'utf8');

  await assert.rejects(() => readCheckpointFile(), /Unexpected token|JSON/i);
});

test('readCheckpointFile rejects the legacy observers checkpoint schema', async (t) => {
  const { dir, homeDir } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify({
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    observers: {
      'default-observer': {
        baseline: {
          turn: 10,
          observing: 21,
          observation: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [],
        threads: [],
      },
    },
  }, null, 2)}\n`, 'utf8');

  await assert.rejects(
    () => readCheckpointFile(),
    /checkpoint observer section is invalid/i,
  );
});

test('resolveCheckpointPath is scoped by observer name', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await writeObserverConfig(configPath, { name: 'observer-a' });
  const firstPath = resolveCheckpointPath();

  await writeObserverConfig(configPath, { name: 'observer-b' });
  const secondPath = resolveCheckpointPath();

  assert.notEqual(firstPath, secondPath);
});

test('watchdog rewrites checkpoint when observer content changes', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify({
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    observer: {
        baseline: {
          turn: 10,
          observing: 21,
          observation: 8,
        },
        committedEpoch: 11,
        nextEpoch: 12,
        recentSessions: [],
        threads: [],
      },
  }, null, 2)}\n`, 'utf8');
  const beforeStat = await stat(resolveCheckpointPath());

  const runtime = new Watchdog({
    sessionTable: {
      stats: async () => ({
        version: 10,
        fragmentCount: 1,
        rowCount: 0,
      }),
      compact: async () => ({ changed: false }),
    },
    observingTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    observationTable: {
      ensureVectorIndex: async () => ({ created: false }),
      stats: async () => null,
      compact: async () => ({ changed: false }),
      optimize: async () => ({ changed: false }),
    },
  }, createWatchdogConfig({ intervalMs: 25 }), createCheckpointBackend({
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    observer: {
        baseline: {
          turn: 10,
          observing: 21,
          observation: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [],
        threads: [],
      },
  }));
  t.after(async () => runtime.stop());

  runtime.start();
  await waitFor(async () => {
    const checkpoint = await readCheckpoint();
    return checkpoint.observer?.committedEpoch === 12;
  });

  const after = await readCheckpoint();
  const afterStat = await stat(resolveCheckpointPath());
  assert.equal(after.observer.committedEpoch, 12);
  assert.equal(after.observer.nextEpoch, 13);
  assert.ok(after.writtenAt !== '2024-01-01T00:00:00Z');
  assert.ok(afterStat.mtimeMs >= beforeStat.mtimeMs);
});

test('getPendingIndex returns the unindexed snapshot range', () => {
  const pending = getPendingIndex({
    observingId: 'observing-a',
    observingEpoch: 7,
    title: 'Title',
    summary: 'Summary',
    snapshots: [
      { observations: [], contextRefs: [], openQuestions: [], nextSteps: [], observationDelta: { before: [], after: [] } },
      { observations: [], contextRefs: [], openQuestions: [], nextSteps: [], observationDelta: { before: [], after: [] } },
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
      { observations: [], contextRefs: [], openQuestions: [], nextSteps: [], observationDelta: { before: [], after: [] } },
      { observations: [], contextRefs: [], openQuestions: [], nextSteps: [], observationDelta: { before: [], after: [] } },
      { observations: [], contextRefs: [], openQuestions: [], nextSteps: [], observationDelta: { before: [], after: [] } },
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

test('loadThreads filters snapshots by the configured active window', () => {
  const freshUpdatedAt = new Date().toISOString();
  const staleUpdatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const snapshots = [
    {
      snapshotId: 'fresh-snapshot',
      observingId: 'fresh-thread',
      snapshotSequence: 0,
      createdAt: freshUpdatedAt,
      updatedAt: freshUpdatedAt,
      observer: 'default-observer',
      title: 'Fresh thread',
      summary: 'Fresh summary',
      content: JSON.stringify({
        observations: [],
        contextRefs: [],
        openQuestions: [],
        nextSteps: [],
        observationDelta: { before: [], after: [] },
      }),
      references: [],
    },
    {
      snapshotId: 'stale-snapshot',
      observingId: 'stale-thread',
      snapshotSequence: 0,
      createdAt: staleUpdatedAt,
      updatedAt: staleUpdatedAt,
      observer: 'default-observer',
      title: 'Stale thread',
      summary: 'Stale summary',
      content: JSON.stringify({
        observations: [],
        contextRefs: [],
        openQuestions: [],
        nextSteps: [],
        observationDelta: { before: [], after: [] },
      }),
      references: [],
    },
  ];

  const threads = loadThreads(snapshots, 'default-observer', 7);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].observingId, 'fresh-thread');
});

test('loadThreads keeps full history for active threads', () => {
  const freshUpdatedAt = new Date().toISOString();
  const staleUpdatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const snapshots = [
    {
      snapshotId: 'snapshot-0',
      observingId: 'mixed-thread',
      snapshotSequence: 0,
      createdAt: staleUpdatedAt,
      updatedAt: staleUpdatedAt,
      observer: 'default-observer',
      title: 'Thread',
      summary: 'Summary',
      content: JSON.stringify({
        observations: [],
        contextRefs: [],
        openQuestions: [],
        nextSteps: [],
        observationDelta: { before: [], after: [] },
      }),
      references: [],
    },
    {
      snapshotId: 'snapshot-1',
      observingId: 'mixed-thread',
      snapshotSequence: 1,
      createdAt: freshUpdatedAt,
      updatedAt: freshUpdatedAt,
      observer: 'default-observer',
      title: 'Thread',
      summary: 'Summary',
      content: JSON.stringify({
        observations: [],
        contextRefs: [],
        openQuestions: [],
        nextSteps: [],
        observationDelta: { before: [], after: [] },
      }),
      references: [],
    },
  ];

  const threads = loadThreads(snapshots, 'default-observer', 7);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].observingId, 'mixed-thread');
  assert.deepEqual(threads[0].snapshotIds, ['snapshot-0', 'snapshot-1']);
  assert.equal(threads[0].snapshots.length, 2);
  assert.equal(threads[0].indexedSnapshotSequence, null);
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
    turns: [turn],
  });
  assert.equal(queue.shift(), null);
});

test('observer.watermark stays unresolved when only observation index work is pending', async () => {
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
        { observations: [], contextRefs: [], openQuestions: [], nextSteps: [], observationDelta: { before: [], after: [] } },
        { observations: [], contextRefs: [], openQuestions: [], nextSteps: [], observationDelta: { before: [], after: [] } },
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

test('observer checkpoint export omits threads outside the active window', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath, { activeWindowDays: 7 });

  const freshUpdatedAt = new Date().toISOString();
  const staleUpdatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const observer = new Observer({});
  t.after(async () => observer.shutdown());

  observer.bootstrapped = true;
  observer.committedEpoch = 1;
  observer.openEpoch = new OpenEpoch(2);
  observer.threads = [
    {
      observingId: 'fresh-thread',
      snapshotId: 'fresh-snapshot',
      snapshotIds: ['fresh-snapshot'],
      observingEpoch: 1,
      title: 'Fresh',
      summary: 'Fresh',
      snapshots: [{ observations: [], contextRefs: [], openQuestions: [], nextSteps: [], observationDelta: { before: [], after: [] } }],
      references: [],
      indexedSnapshotSequence: 0,
      observer: 'default-observer',
      createdAt: freshUpdatedAt,
      updatedAt: freshUpdatedAt,
    },
    {
      observingId: 'stale-thread',
      snapshotId: 'stale-snapshot',
      snapshotIds: ['stale-snapshot'],
      observingEpoch: 1,
      title: 'Stale',
      summary: 'Stale',
      snapshots: [{ observations: [], contextRefs: [], openQuestions: [], nextSteps: [], observationDelta: { before: [], after: [] } }],
      references: [],
      indexedSnapshotSequence: 0,
      observer: 'default-observer',
      createdAt: staleUpdatedAt,
      updatedAt: staleUpdatedAt,
    },
  ];
  observer.refreshCheckpointSnapshot();

  assert.deepEqual(observer.exportCheckpoint().threads, [{
    observingId: 'fresh-thread',
    latestSnapshotId: 'fresh-snapshot',
    latestSnapshotSequence: 0,
    indexedSnapshotSequence: 0,
    updatedAt: freshUpdatedAt,
  }]);
});

test('observer checkpoint export returns null before bootstrap completes', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const observer = new Observer({});
  t.after(async () => observer.shutdown());

  assert.equal(observer.exportCheckpoint(), null);
});

test('observer bootstrap without checkpoint derives committedEpoch from observing snapshots', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const snapshot1At = new Date(Date.now() - 1_000).toISOString();
  const snapshot2At = new Date().toISOString();
  const rows = [
    {
      snapshotId: 'snapshot-1',
      observingId: 'obs-1',
      snapshotSequence: 0,
      createdAt: snapshot1At,
      updatedAt: snapshot1At,
      observer: 'default-observer',
      title: 'Thread',
      summary: 'Summary',
      content: JSON.stringify({
        observations: [],
        contextRefs: [],
        openQuestions: [],
        nextSteps: [],
        observationDelta: { before: [], after: [] },
      }),
      references: ['turn-13'],
    },
    {
      snapshotId: 'snapshot-2',
      observingId: 'obs-1',
      snapshotSequence: 1,
      createdAt: snapshot2At,
      updatedAt: snapshot2At,
      observer: 'default-observer',
      title: 'Thread',
      summary: 'Summary',
      content: JSON.stringify({
        observations: [],
        contextRefs: [],
        openQuestions: [],
        nextSteps: [],
        observationDelta: { before: [], after: [] },
      }),
      references: ['turn-13', 'turn-14'],
    },
  ];
  const observer = new Observer({
    sessionTable: {
      loadTurnsAfterEpoch: async () => [
        makeObservableTurn('turn-13', 13, 'epoch13'),
        makeObservableTurn('turn-14', 14, 'epoch14'),
      ],
    },
    observingTable: {
      listSnapshots: async () => rows,
      threadSnapshots: async () => rows,
    },
    observationTable: {},
  });
  t.after(async () => observer.shutdown());

  await observer.ensureBootstrapped();

  assert.equal(observer.committedEpoch, 14);
  assert.deepEqual((await observer.watermark()).pendingTurnIds, []);
  assert.deepEqual(observer.threads[0].snapshotIds, ['snapshot-1', 'snapshot-2']);
});

test('observer bootstrap publishes pending turns by their observingEpoch', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const published = [];
  const observer = new Observer({
    sessionTable: {
      loadTurnsAfterEpoch: async () => [
        makeObservableTurn('turn-13', 13, 'epoch13'),
        makeObservableTurn('turn-14', 14, 'epoch14'),
      ],
    },
    observingTable: {
      listSnapshots: async () => [],
    },
    observationTable: {},
  });
  t.after(async () => observer.shutdown());

  observer.epochQueue.publishEpoch = (sealedEpoch) => {
    published.push({
      epoch: sealedEpoch.epoch,
      turnIds: sealedEpoch.turns.map((turn) => turn.turnId),
    });
  };

  await observer.ensureBootstrapped();

  assert.deepEqual(published, [
    { epoch: 13, turnIds: ['turn-13'] },
    { epoch: 14, turnIds: ['turn-14'] },
  ]);
  assert.equal(observer.openEpoch.epoch, 15);
});

test('observer bootstrap restores committed state from checkpoint when baselines match', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify({
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    observer: {
        baseline: {
          turn: 10,
          observing: 21,
          observation: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [makeRecentSessionCheckpoint([makeRecentTurn('session:101', 'checkpoint-4')])],
        threads: [{
          observingId: 'obs-1',
          latestSnapshotId: 'observing:42',
          latestSnapshotSequence: 1,
          indexedSnapshotSequence: 1,
          updatedAt: '2024-01-01T00:00:01Z',
        }],
      },
  }, null, 2)}\n`, 'utf8');

  let listSnapshotsCalls = 0;
  let loadTurnsAfterEpochCalls = 0;
  const checkpoint = (await readCheckpointFile())?.observer ?? null;
  const observer = new Observer({
    sessionTable: {
      stats: async () => ({
        version: 10,
        fragmentCount: 1,
        rowCount: 1,
      }),
      loadTurnsAfterEpoch: async () => {
        loadTurnsAfterEpochCalls += 1;
        return [];
      },
    },
    observingTable: {
      delta: async () => [],
      stats: async () => ({
        version: 21,
        fragmentCount: 1,
        rowCount: 2,
      }),
      listSnapshots: async () => {
        listSnapshotsCalls += 1;
        return [];
      },
      threadSnapshots: async (observingId) => {
        assert.equal(observingId, 'obs-1');
        return [
          {
            snapshotId: 'observing:41',
            observingId: 'obs-1',
            snapshotSequence: 0,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
            observer: 'default-observer',
            title: 'Thread',
            summary: 'Summary',
            content: JSON.stringify({
              observations: [],
              contextRefs: [],
              openQuestions: [],
              nextSteps: [],
              observationDelta: { before: [], after: [] },
            }),
            references: [],
          },
          {
            snapshotId: 'observing:42',
            observingId: 'obs-1',
            snapshotSequence: 1,
            createdAt: '2024-01-01T00:00:01Z',
            updatedAt: '2024-01-01T00:00:01Z',
            observer: 'default-observer',
            title: 'Thread',
            summary: 'Summary',
            content: JSON.stringify({
              observations: [],
              contextRefs: [],
              openQuestions: [],
              nextSteps: [],
              observationDelta: { before: [], after: [] },
            }),
            references: [],
          },
        ];
      },
    },
    observationTable: {
      stats: async () => ({
        version: 8,
        fragmentCount: 1,
        rowCount: 0,
      }),
    },
  }, checkpoint);
  t.after(async () => observer.shutdown());

  await observer.ensureBootstrapped();

  assert.equal(listSnapshotsCalls, 0);
  assert.equal(loadTurnsAfterEpochCalls, 1);
  assert.deepEqual(observer.exportCheckpoint(), {
    committedEpoch: 12,
    nextEpoch: 13,
    threads: [{
      observingId: 'obs-1',
      latestSnapshotId: 'observing:42',
      latestSnapshotSequence: 1,
      indexedSnapshotSequence: 1,
      updatedAt: '2024-01-01T00:00:01Z',
    }],
  });
});

test('observer checkpoint restore keeps full history for active threads', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath, { activeWindowDays: 7 });

  const staleUpdatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const freshUpdatedAt = new Date().toISOString();
  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify({
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    writtenAt: new Date().toISOString(),
    writerPid: 123,
    observer: {
        baseline: {
          turn: 10,
          observing: 21,
          observation: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [],
        threads: [{
          observingId: 'mixed-thread',
          latestSnapshotId: 'snapshot-1',
          latestSnapshotSequence: 1,
          indexedSnapshotSequence: 1,
          updatedAt: freshUpdatedAt,
        }],
      },
  }, null, 2)}\n`, 'utf8');

  const checkpoint = (await readCheckpointFile())?.observer ?? null;
  const observer = new Observer({
    sessionTable: {
      stats: async () => ({
        version: 10,
        fragmentCount: 1,
        rowCount: 0,
      }),
      loadTurnsAfterEpoch: async () => [],
    },
    observingTable: {
      delta: async () => [],
      stats: async () => ({
        version: 21,
        fragmentCount: 1,
        rowCount: 2,
      }),
      listSnapshots: async () => [],
      threadSnapshots: async (observingId) => {
        assert.equal(observingId, 'mixed-thread');
        return [
          {
            snapshotId: 'snapshot-0',
            observingId: 'mixed-thread',
            snapshotSequence: 0,
            createdAt: staleUpdatedAt,
            updatedAt: staleUpdatedAt,
            observer: 'default-observer',
            title: 'Thread',
            summary: 'Summary',
            content: JSON.stringify({
              observations: [],
              contextRefs: [],
              openQuestions: [],
              nextSteps: [],
              observationDelta: { before: [], after: [] },
            }),
            references: [],
          },
          {
            snapshotId: 'snapshot-1',
            observingId: 'mixed-thread',
            snapshotSequence: 1,
            createdAt: freshUpdatedAt,
            updatedAt: freshUpdatedAt,
            observer: 'default-observer',
            title: 'Thread',
            summary: 'Summary',
            content: JSON.stringify({
              observations: [],
              contextRefs: [],
              openQuestions: [],
              nextSteps: [],
              observationDelta: { before: [], after: [] },
            }),
            references: [],
          },
        ];
      },
    },
    observationTable: {
      stats: async () => ({
        version: 8,
        fragmentCount: 1,
        rowCount: 0,
      }),
    },
  }, checkpoint);
  t.after(async () => observer.shutdown());

  await observer.ensureBootstrapped();

  assert.equal(observer.threads.length, 1);
  assert.deepEqual(observer.threads[0].snapshotIds, ['snapshot-0', 'snapshot-1']);
  assert.equal(observer.threads[0].snapshots.length, 2);
  assert.equal(observer.threads[0].indexedSnapshotSequence, 1);
});

test('observer restoreCheckpointState advances committedEpoch and excludes observed turns from pending', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath, { activeWindowDays: 7 });
  const snapshot0At = new Date(Date.now() - 2_000).toISOString();
  const snapshot1At = new Date(Date.now() - 1_000).toISOString();
  const snapshot2At = new Date().toISOString();

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify({
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    observer: {
        baseline: {
          turn: 10,
          observing: 21,
          observation: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [],
        threads: [{
          observingId: 'obs-1',
          latestSnapshotId: 'snapshot-0',
          latestSnapshotSequence: 0,
          indexedSnapshotSequence: 0,
          updatedAt: snapshot0At,
        }],
      },
  }, null, 2)}\n`, 'utf8');

  const checkpoint = (await readCheckpointFile())?.observer ?? null;
  const observer = new Observer({
    sessionTable: {
      loadTurnsAfterEpoch: async () => [
        makeObservableTurn('turn-13', 13, 'epoch13'),
        makeObservableTurn('turn-14', 14, 'epoch14'),
      ],
    },
    observingTable: {
      delta: async () => [
        {
          snapshotId: 'snapshot-1',
          observingId: 'obs-1',
          snapshotSequence: 1,
          createdAt: snapshot1At,
          updatedAt: snapshot1At,
          observer: 'default-observer',
          title: 'Thread',
          summary: 'Summary',
          content: JSON.stringify({
            observations: [],
            contextRefs: [],
            openQuestions: [],
            nextSteps: [],
            observationDelta: { before: [], after: [] },
          }),
          references: ['turn-13'],
        },
        {
          snapshotId: 'snapshot-2',
          observingId: 'obs-1',
          snapshotSequence: 2,
          createdAt: snapshot2At,
          updatedAt: snapshot2At,
          observer: 'default-observer',
          title: 'Thread',
          summary: 'Summary',
          content: JSON.stringify({
            observations: [],
            contextRefs: [],
            openQuestions: [],
            nextSteps: [],
            observationDelta: { before: [], after: [] },
          }),
          references: ['turn-13', 'turn-14'],
        },
      ],
      threadSnapshots: async () => [
        {
          snapshotId: 'snapshot-0',
          observingId: 'obs-1',
          snapshotSequence: 0,
          createdAt: snapshot0At,
          updatedAt: snapshot0At,
          observer: 'default-observer',
          title: 'Thread',
          summary: 'Summary',
          content: JSON.stringify({
            observations: [],
            contextRefs: [],
            openQuestions: [],
            nextSteps: [],
            observationDelta: { before: [], after: [] },
          }),
          references: [],
        },
        {
          snapshotId: 'snapshot-1',
          observingId: 'obs-1',
          snapshotSequence: 1,
          createdAt: snapshot1At,
          updatedAt: snapshot1At,
          observer: 'default-observer',
          title: 'Thread',
          summary: 'Summary',
          content: JSON.stringify({
            observations: [],
            contextRefs: [],
            openQuestions: [],
            nextSteps: [],
            observationDelta: { before: [], after: [] },
          }),
          references: ['turn-13'],
        },
        {
          snapshotId: 'snapshot-2',
          observingId: 'obs-1',
          snapshotSequence: 2,
          createdAt: snapshot2At,
          updatedAt: snapshot2At,
          observer: 'default-observer',
          title: 'Thread',
          summary: 'Summary',
          content: JSON.stringify({
            observations: [],
            contextRefs: [],
            openQuestions: [],
            nextSteps: [],
            observationDelta: { before: [], after: [] },
          }),
          references: ['turn-13', 'turn-14'],
        },
      ],
    },
    observationTable: {},
  }, checkpoint);
  t.after(async () => observer.shutdown());

  const restored = await observer.restoreCheckpointState();

  assert.equal(restored.committedEpoch, 14);
  assert.deepEqual(restored.pendingTurns, []);
  assert.deepEqual(restored.threads[0].snapshotIds, ['snapshot-0', 'snapshot-1', 'snapshot-2']);
  assert.deepEqual(restored.threads[0].snapshotEpochs, [12, 13, 14]);
});

test('observer restoreCheckpointState falls back when observing delta refs are missing turn epochs', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath, { activeWindowDays: 7 });

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify({
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    observer: {
        baseline: {
          turn: 10,
          observing: 21,
          observation: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [],
        threads: [{
          observingId: 'obs-1',
          latestSnapshotId: 'snapshot-0',
          latestSnapshotSequence: 0,
          indexedSnapshotSequence: 0,
          updatedAt: '2024-01-01T00:00:00Z',
        }],
      },
  }, null, 2)}\n`, 'utf8');

  const checkpoint = (await readCheckpointFile())?.observer ?? null;
  const observer = new Observer({
    sessionTable: {
      loadTurnsAfterEpoch: async () => [makeObservableTurn('turn-13', 13, 'epoch13')],
    },
    observingTable: {
      delta: async () => [
        {
          snapshotId: 'snapshot-1',
          observingId: 'obs-1',
          snapshotSequence: 1,
          createdAt: '2024-01-01T00:00:01Z',
          updatedAt: '2024-01-01T00:00:01Z',
          observer: 'default-observer',
          title: 'Thread',
          summary: 'Summary',
          content: JSON.stringify({
            observations: [],
            contextRefs: [],
            openQuestions: [],
            nextSteps: [],
            observationDelta: { before: [], after: [] },
          }),
          references: ['missing-turn'],
        },
      ],
      threadSnapshots: async () => [
        {
          snapshotId: 'snapshot-0',
          observingId: 'obs-1',
          snapshotSequence: 0,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          observer: 'default-observer',
          title: 'Thread',
          summary: 'Summary',
          content: JSON.stringify({
            observations: [],
            contextRefs: [],
            openQuestions: [],
            nextSteps: [],
            observationDelta: { before: [], after: [] },
          }),
          references: [],
        },
      ],
    },
    observationTable: {},
  }, checkpoint);
  t.after(async () => observer.shutdown());

  const restored = await observer.restoreCheckpointState();

  assert.equal(restored, null);
});

test('observer restoreCheckpointState skips stale threads recovered only from observing delta', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath, { activeWindowDays: 7 });
  const staleUpdatedAt = new Date(Date.now() - 4000 * 24 * 60 * 60 * 1000).toISOString();

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify({
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    observer: {
        baseline: {
          turn: 10,
          observing: 21,
          observation: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [],
        threads: [],
      },
  }, null, 2)}\n`, 'utf8');

  const checkpoint = (await readCheckpointFile())?.observer ?? null;
  const staleRow = {
    snapshotId: 'snapshot-1',
    observingId: 'obs-stale',
    snapshotSequence: 0,
    createdAt: staleUpdatedAt,
    updatedAt: staleUpdatedAt,
    observer: 'default-observer',
    title: 'Stale Thread',
    summary: 'Summary',
    content: JSON.stringify({
      observations: [],
      contextRefs: [],
      openQuestions: [],
      nextSteps: [],
      observationDelta: { before: [], after: [] },
    }),
    references: ['turn-13'],
  };
  const observer = new Observer({
    sessionTable: {
      loadTurnsAfterEpoch: async () => [makeObservableTurn('turn-13', 13, 'epoch13')],
    },
    observingTable: {
      delta: async () => [staleRow],
      threadSnapshots: async () => [staleRow],
    },
    observationTable: {},
  }, checkpoint);
  t.after(async () => observer.shutdown());

  const restored = await observer.restoreCheckpointState();

  assert.equal(restored.committedEpoch, 13);
  assert.equal(restored.threads.length, 0);
  assert.deepEqual(restored.pendingTurns, []);
});

test('observer restoreCheckpointState rebuilds delta-only threads from full history', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath, { activeWindowDays: 7 });
  const rowTimes = Array.from({ length: 8 }, (_, index) => new Date(Date.now() - (8 - index) * 1000).toISOString());

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify({
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    observer: {
        baseline: {
          turn: 10,
          observing: 21,
          observation: 8,
        },
        committedEpoch: 5,
        nextEpoch: 6,
        recentSessions: [],
        threads: [],
      },
  }, null, 2)}\n`, 'utf8');

  const checkpoint = (await readCheckpointFile())?.observer ?? null;
  const fullRows = Array.from({ length: 8 }, (_, index) => ({
    snapshotId: `snapshot-${index}`,
    observingId: 'obs-legacy',
    snapshotSequence: index,
    createdAt: rowTimes[index],
    updatedAt: rowTimes[index],
    observer: 'default-observer',
    title: 'Legacy Thread',
    summary: `Summary ${index}`,
    content: JSON.stringify({
      observations: [],
      contextRefs: [],
      openQuestions: [],
      nextSteps: [],
      observationDelta: { before: [], after: [] },
    }),
    references: Array.from({ length: index + 1 }, (_, turnIndex) => `turn-${turnIndex + 1}`),
  }));
  const turnById = new Map(fullRows.map((row, index) => [
    `turn-${index + 1}`,
    makeObservableTurn(`turn-${index + 1}`, index + 1, `epoch${index + 1}`),
  ]));
  const observer = new Observer({
    sessionTable: {
      loadTurnsAfterEpoch: async () => [
        turnById.get('turn-6'),
        turnById.get('turn-7'),
        turnById.get('turn-8'),
      ],
      getTurn: async (turnId) => turnById.get(turnId) ?? null,
    },
    observingTable: {
      delta: async () => [fullRows[6], fullRows[7]],
      threadSnapshots: async () => fullRows,
    },
    observationTable: {},
  }, checkpoint);
  t.after(async () => observer.shutdown());

  const restored = await observer.restoreCheckpointState();

  assert.equal(restored.committedEpoch, 8);
  assert.deepEqual(restored.pendingTurns, []);
  assert.deepEqual(
    restored.threads[0].snapshotIds,
    fullRows.map((row) => row.snapshotId),
  );
});

test('observer bootstrap skips stale checkpoint threads', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath, { activeWindowDays: 7 });

  const staleUpdatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify({
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    writtenAt: new Date().toISOString(),
    writerPid: 123,
    observer: {
        baseline: {
          turn: 10,
          observing: 21,
          observation: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [],
        threads: [{
          observingId: 'stale-thread',
          latestSnapshotId: 'observing:42',
          latestSnapshotSequence: 0,
          indexedSnapshotSequence: 0,
          updatedAt: staleUpdatedAt,
        }],
      },
  }, null, 2)}\n`, 'utf8');

  const checkpoint = (await readCheckpointFile())?.observer ?? null;
  const observer = new Observer({
    sessionTable: {
      stats: async () => ({
        version: 10,
        fragmentCount: 1,
        rowCount: 0,
      }),
      loadTurnsAfterEpoch: async () => [],
    },
    observingTable: {
      delta: async () => [],
      stats: async () => ({
        version: 21,
        fragmentCount: 1,
        rowCount: 1,
      }),
      listSnapshots: async () => [],
      threadSnapshots: async () => {
        throw new Error('stale checkpoint thread should not be loaded');
      },
    },
    observationTable: {
      stats: async () => ({
        version: 8,
        fragmentCount: 1,
        rowCount: 0,
      }),
    },
  }, checkpoint);
  t.after(async () => observer.shutdown());

  await observer.ensureBootstrapped();

  assert.equal(observer.threads.length, 0);
  assert.equal(observer.committedEpoch, 12);
  assert.equal(observer.openEpoch.epoch, 13);
});

test('observer exportCheckpoint keeps the last committed snapshot while observeCurrentEpoch is mid-flight', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const entered = deferred();
  const release = deferred();
  const checkpoint = (await readCheckpointFile())?.observer ?? null;
  const observer = new Observer({
    observingTable: {
      insert: async ({ snapshots }) => snapshots.map((snapshot) => ({
        ...snapshot,
        snapshotId: 'snapshot-1',
      })),
      stats: async () => ({
        version: 5,
        fragmentCount: 1,
        rowCount: 2,
      }),
    },
    observationTable: {
      stats: async () => ({
        version: 7,
        fragmentCount: 1,
        rowCount: 1,
      }),
    },
  }, checkpoint);
  t.after(async () => observer.shutdown());

  observer.bootstrapped = true;
  observer.committedEpoch = 0;
  observer.openEpoch = new OpenEpoch(2);
  observer.threads = [{
    observingId: 'observing-a',
    snapshotId: 'snapshot-0',
    snapshotIds: ['snapshot-0'],
    observingEpoch: 0,
    title: 'Existing title',
    summary: 'Existing summary',
    snapshots: [
      { observations: [], contextRefs: [], openQuestions: [], nextSteps: [], observationDelta: { before: [], after: [] } },
    ],
    references: ['session:existing'],
    indexedSnapshotSequence: 0,
    observer: 'default-observer',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  }];
  observer.refreshCheckpointSnapshot();
  observer.currentEpoch = {
    epoch: 1,
    turns: [makeObservableTurn('turn-1', 1, 'first')],
  };

  let midFlight;
  observer.buildCurrentEpochIndex = async () => {
    midFlight = observer.exportCheckpoint();
    entered.resolve();
    await release.promise;
  };

  const observePromise = observer.observeCurrentEpoch();
  await entered.promise;

  assert.deepEqual(midFlight, {
    committedEpoch: 0,
    nextEpoch: 2,
    threads: [{
      observingId: 'observing-a',
      latestSnapshotId: 'snapshot-0',
      latestSnapshotSequence: 0,
      indexedSnapshotSequence: 0,
      updatedAt: '2024-01-01T00:00:00Z',
    }],
  });

  release.resolve();
  await observePromise;

  const committed = observer.exportCheckpoint();
  assert.equal(committed.committedEpoch, 1);
  assert.equal(committed.nextEpoch, 2);
  assert.deepEqual(committed.threads, observer.threads.map((thread) => ({
    observingId: thread.observingId,
    latestSnapshotId: thread.snapshotId,
    latestSnapshotSequence: thread.snapshots.length - 1,
    indexedSnapshotSequence: thread.indexedSnapshotSequence ?? null,
    updatedAt: thread.updatedAt,
  })));
});

test('observer bootstrap ignores observation version mismatches when observing baseline matches', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify({
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    observer: {
        baseline: {
          turn: 10,
          observing: 21,
          observation: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [],
        threads: [{
          observingId: 'obs-1',
          latestSnapshotId: 'observing:42',
          latestSnapshotSequence: 1,
          indexedSnapshotSequence: 1,
          updatedAt: '2024-01-01T00:00:01Z',
        }],
      },
  }, null, 2)}\n`, 'utf8');

  let listSnapshotsCalls = 0;
  const checkpoint = (await readCheckpointFile())?.observer ?? null;
  const observer = new Observer({
    sessionTable: {
      stats: async () => ({
        version: 10,
        fragmentCount: 1,
        rowCount: 1,
      }),
      loadTurnsAfterEpoch: async () => [],
    },
    observingTable: {
      delta: async () => [],
      stats: async () => ({
        version: 21,
        fragmentCount: 1,
        rowCount: 2,
      }),
      listSnapshots: async () => {
        listSnapshotsCalls += 1;
        return [];
      },
      threadSnapshots: async () => [
        {
          snapshotId: 'observing:41',
          observingId: 'obs-1',
          snapshotSequence: 0,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          observer: 'default-observer',
          title: 'Thread',
          summary: 'Summary',
          content: JSON.stringify({
            observations: [],
            contextRefs: [],
            openQuestions: [],
            nextSteps: [],
            observationDelta: { before: [], after: [] },
          }),
          references: [],
        },
        {
          snapshotId: 'observing:42',
          observingId: 'obs-1',
          snapshotSequence: 1,
          createdAt: '2024-01-01T00:00:01Z',
          updatedAt: '2024-01-01T00:00:01Z',
          observer: 'default-observer',
          title: 'Thread',
          summary: 'Summary',
          content: JSON.stringify({
            observations: [],
            contextRefs: [],
            openQuestions: [],
            nextSteps: [],
            observationDelta: { before: [], after: [] },
          }),
          references: [],
        },
      ],
    },
    observationTable: {
      stats: async () => ({
        version: 99,
        fragmentCount: 1,
        rowCount: 0,
      }),
    },
  }, checkpoint);
  t.after(async () => observer.shutdown());

  await observer.ensureBootstrapped();

  assert.equal(listSnapshotsCalls, 0);
  assert.equal(observer.exportCheckpoint().committedEpoch, 12);
});

test('readCheckpointFile throws when the checkpoint section is structurally invalid', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify({
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    observer: {
        baseline: {
          turn: 10,
          observing: 21,
          observation: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [],
        threads: [{
          observingId: 'obs-1',
          latestSnapshotId: 'observing:42',
          latestSnapshotSequence: 'bad-sequence',
          indexedSnapshotSequence: 1,
          updatedAt: '2024-01-01T00:00:01Z',
        }],
      },
  }, null, 2)}\n`, 'utf8');

  await assert.rejects(
    () => readCheckpointFile(),
    /checkpoint observer section is invalid/i,
  );
});

test('muninn.recallMemories does not wait for observer flushes', async () => {
  const muninn = new MuninnBackend({});
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

test('backend exportCheckpoint returns null before observer creation', async () => {
  const checkpoint = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    observer: {
        baseline: {
          turn: 10,
          observing: 21,
          observation: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [],
        threads: [],
      },
  };
  const backend = new MuninnBackend({}, checkpoint);

  const exported = await backend.exportCheckpoint();

  assert.equal(exported, null);
});

test('session registry reuses one in-flight session load per key', async () => {
  const registry = new SessionRegistry({
    sessionTable: {},
  }, 'default-observer');

  const first = registry.load('group-a', 'agent-a');
  const second = registry.load('group-a', 'agent-a');
  await Promise.resolve();

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
  const registry = new SessionRegistry({
    sessionTable: {},
  }, 'default-observer');

  const first = registry.load('group-a', 'agent-a');
  const second = registry.load(' group-a ', 'agent-a');
  const [firstSession, secondSession] = await Promise.all([first, second]);

  assert.strictEqual(firstSession, secondSession);
});

test('session registry restores live sessions for checkpoint recent turns', async () => {
  const registry = new SessionRegistry({
    sessionTable: {},
  }, 'default-observer');

  registry.restoreSession('group-a', 'agent-a', [{
    turnId: 'session:101',
    updatedAt: '2024-01-01T00:00:00Z',
    prompt: 'pending prompt',
    response: '',
  }]);

  const session = await registry.load('group-a', 'agent-a');
  const exported = session.exportRecentSession();
  assert.deepEqual(exported?.turns.map((turn) => turn.turnId), ['session:101']);
});

test('session registry replays persisted turns into recent windows', async () => {
  const registry = new SessionRegistry({
    sessionTable: {},
  }, 'default-observer');

  registry.restoreSession('group-a', 'agent-a', [makeRecentTurn('session:101', 'checkpoint')]);
  registry.rememberTurn(makePersistedTurn('session:102', 'delta'));

  const exported = (await registry.load('group-a', 'agent-a')).exportRecentSession();
  assert.deepEqual(
    exported?.turns.map((turn) => turn.turnId),
    ['session:101', 'session:102'],
  );
});

test('session.accept serializes concurrent inserts for the same session', async () => {
  let concurrentInserts = 0;
  let maxConcurrentInserts = 0;
  let nextTurnId = 1;

  const session = new Session({
    sessionTable: {
      insert: async ({ turns }) => {
        concurrentInserts += 1;
        maxConcurrentInserts = Math.max(maxConcurrentInserts, concurrentInserts);
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrentInserts -= 1;
        return turns.map((turn) => ({
          ...turn,
          turnId: `session:${nextTurnId++}`,
        }));
      },
    },
  }, {
    sessionId: 'group-a',
    agent: 'agent-a',
    observer: 'default-observer',
  });

  const first = session.accept({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'first prompt',
    response: 'first response',
  }, 1);
  const second = session.accept({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'second prompt',
    response: 'second response',
  }, 1);

  const [firstTurn, secondTurn] = await Promise.all([first, second]);
  assert.equal(maxConcurrentInserts, 1);
  assert.notEqual(firstTurn.turn.turnId, secondTurn.turn.turnId);
  assert.equal(firstTurn.turn.prompt, 'first prompt');
  assert.equal(secondTurn.turn.prompt, 'second prompt');
  assert.equal(firstTurn.deduped, false);
  assert.equal(secondTurn.deduped, false);
});

test('session.accept dedupes against the recent three turns', async () => {
  let nextTurnId = 1;
  const insertedTurns = new Map();

  const session = new Session({
    sessionTable: {
      insert: async ({ turns }) => turns.map((turn) => {
        const persisted = {
          ...turn,
          turnId: `session:${nextTurnId++}`,
        };
        insertedTurns.set(persisted.turnId, persisted);
        return persisted;
      }),
      getTurn: async (turnId) => insertedTurns.get(turnId) ?? null,
    },
  }, {
    sessionId: 'group-a',
    agent: 'agent-a',
    observer: 'default-observer',
  });

  const accepted = [];
  for (const prompt of ['A', 'B', 'C']) {
    accepted.push(await session.accept({
      sessionId: 'group-a',
      agent: 'agent-a',
      prompt,
      response: `${prompt}-response`,
    }, 1));
  }

  const duplicate = await session.accept({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'A',
    response: 'A-response',
  }, 1);
  assert.equal(duplicate.deduped, true);
  assert.equal(duplicate.turn, null);

  const fourth = await session.accept({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'D',
    response: 'D-response',
  }, 1);
  assert.equal(fourth.deduped, false);

  const expiredDuplicate = await session.accept({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'A',
    response: 'A-response',
  }, 1);
  assert.equal(expiredDuplicate.deduped, false);
  assert.notEqual(expiredDuplicate.turn.turnId, accepted[0].turn.turnId);
});

test('session.accept drops stale recent turns before inserting a new turn', async () => {
  let nextTurnId = 1;
  const insertedTurns = new Map();

  const session = new Session({
    sessionTable: {
      insert: async ({ turns }) => turns.map((turn) => {
        const persisted = {
          ...turn,
          turnId: `session:${nextTurnId++}`,
        };
        insertedTurns.set(persisted.turnId, persisted);
        return persisted;
      }),
      getTurn: async (turnId) => insertedTurns.get(turnId) ?? null,
    },
  }, {
    sessionId: 'group-a',
    agent: 'agent-a',
    observer: 'default-observer',
    recentTurns: [
      makeRecentTurn('session:stale-1', 'stale'),
      makeRecentTurn('session:stale-2', 'stale'),
    ],
  });

  const accepted = await session.accept({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'stale prompt',
    response: 'stale response',
  }, 1);

  assert.equal(accepted.deduped, false);
  assert.equal(accepted.turn.turnId, 'session:1');
  assert.deepEqual(
    session.exportRecentSession()?.turns.map((turn) => turn.turnId),
    ['session:1'],
  );
});

test('open epoch skips deduped turns when staging observable turns', async () => {
  const epoch = new OpenEpoch(7);
  const dedupedTurn = {
    turnId: 'session:1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    sessionId: 'group-a',
    agent: 'agent-a',
    observer: 'default-observer',
    title: 'title',
    summary: 'summary',
    toolCalls: null,
    artifacts: null,
    prompt: 'prompt',
    response: 'response',
    observingEpoch: 7,
  };
  const sessionRegistry = {
    load: async () => ({
      accept: async () => ({
        turn: dedupedTurn,
        deduped: true,
      }),
    }),
  };

  const accepted = await epoch.accept({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'prompt',
    response: 'response',
  }, sessionRegistry);

  assert.equal(accepted, undefined);
  assert.equal(epoch.hasStagedTurns(), false);
  assert.deepEqual(epoch.stagedTurns(), []);
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
        { observations: [], contextRefs: [], openQuestions: [], nextSteps: [], observationDelta: { before: [], after: [] } },
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

test('snapshot observation delta writes observation rows with snapshot references', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const { applyObservationTableDelta } = await import('../dist/observer/memory-delta.js');
  const rows = [];
  const client = {
    observationTable: {
      loadByIds: async () => [],
      delete: async () => ({ deleted: 0 }),
      upsert: async ({ rows: next }) => rows.push(...next),
    },
  };
  await applyObservationTableDelta(client, {
    observations: [],
    contextRefs: [],
    observationDelta: {
      before: [],
      after: [{ id: 'thread-obs-1', text: 'Caroline has an ongoing support group thread.', category: 'Fact' }],
    },
  }, 'observing:12');
  assert.equal(rows[0].id, 'thread-obs-1');
  assert.deepEqual(rows[0].references, ['observing:12']);
});

test('observation extraction validation rejects invalid category', async () => {
  const { __testing: extractionTesting } = await import('../dist/observer/observation-extraction.js');
  assert.throws(
    () => extractionTesting.validateExtraction({
      observations: [{ text: 'Caroline joined a support group.', category: 'Goal', references: ['session:1'] }],
    }),
    /invalid observation category/i,
  );
});

test('observation extraction validation rejects empty text', async () => {
  const { __testing: extractionTesting } = await import('../dist/observer/observation-extraction.js');
  assert.throws(
    () => extractionTesting.validateExtraction({
      observations: [{ text: ' ', category: 'Fact', references: ['session:1'] }],
    }),
    /text must be a non-empty string/i,
  );
});

test('observation extraction validation rejects missing references', async () => {
  const { __testing: extractionTesting } = await import('../dist/observer/observation-extraction.js');
  assert.throws(
    () => extractionTesting.validateExtraction({
      observations: [{ text: 'Caroline joined a support group.', category: 'Fact', references: [] }],
    }),
    /references must include at least one reference/i,
  );
});

test('observation review validation requires every new observation to be reviewed', async () => {
  const { __testing: reviewTesting } = await import('../dist/observer/observation-review.js');
  assert.throws(
    () => reviewTesting.validateReview({
      newObservations: [storedObservation('obs-1')],
      candidateObservations: [],
    }, {
      removeObservationIds: [],
      reviewedObservationIds: [],
    }),
    /not reviewed/i,
  );
});

test('observation review validation rejects unknown removals', async () => {
  const { __testing: reviewTesting } = await import('../dist/observer/observation-review.js');
  assert.throws(
    () => reviewTesting.validateReview({
      newObservations: [storedObservation('obs-1')],
      candidateObservations: [],
    }, {
      removeObservationIds: ['obs-missing'],
      reviewedObservationIds: ['obs-1'],
    }),
    /unknown observation id/i,
  );
});

test('thread preparation validation rejects duplicate observation coverage', async () => {
  const { __testing: preparationTesting } = await import('../dist/observer/thread-preparation.js');
  const input = {
    reviewedObservations: [storedObservation('obs-1'), storedObservation('obs-2')],
    activeThreads: [{ threadId: 'thread-1', title: 'Thread one' }],
  };
  assert.throws(
    () => preparationTesting.validateThreadPreparation(input, {
      workItems: [{
        observationIds: ['obs-1'],
        targetThreadId: 'thread-1',
        rationale: 'same topic',
      }],
      unthreadedObservationIds: ['obs-1', 'obs-2'],
    }),
    /exactly once/i,
  );
});

test('thread preparation validation rejects single-observation new threads', async () => {
  const { __testing: preparationTesting } = await import('../dist/observer/thread-preparation.js');
  const input = {
    reviewedObservations: [storedObservation('obs-1')],
    activeThreads: [],
  };
  assert.throws(
    () => preparationTesting.validateThreadPreparation(input, {
      workItems: [{
        observationIds: ['obs-1'],
        newThreadTitle: 'Caroline support group',
        rationale: 'new durable subject',
      }],
      unthreadedObservationIds: [],
    }),
    /at least two/i,
  );
});

test('thread preparation validation rejects unknown target threads', async () => {
  const { __testing: preparationTesting } = await import('../dist/observer/thread-preparation.js');
  const input = {
    reviewedObservations: [storedObservation('obs-1')],
    activeThreads: [{ threadId: 'thread-1', title: 'Thread one' }],
  };
  assert.throws(
    () => preparationTesting.validateThreadPreparation(input, {
      workItems: [{
        observationIds: ['obs-1'],
        targetThreadId: 'thread-missing',
        rationale: 'same topic',
      }],
      unthreadedObservationIds: [],
    }),
    /unknown targetThreadId/i,
  );
});

test('buildObservation surfaces observation write failures and leaves work pending', async (t) => {
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
          observations: [],
          contextRefs: [],
          openQuestions: [],
          nextSteps: [],
          observationDelta: { before: [], after: [] },
        },
        {
          observations: [],
          contextRefs: [],
          openQuestions: [],
          nextSteps: [],
          observationDelta: {
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
    () => updateTesting.buildObservation({
      observingTable: {
        update: async ({ snapshots }) => snapshots,
      },
      observationTable: {
        delete: async () => ({ deleted: 0 }),
        loadByIds: async () => [],
        upsert: async () => {
          semanticUpserts += 1;
          throw new Error('observation write failed');
        },
      },
    }, threads),
    /observation write failed/,
  );

  assert.equal(semanticUpserts, 1);
  assert.deepEqual(getPendingIndex(threads[0]), { start: 1, end: 1 });
});

test('gateway validation accepts source slice routes', () => {
  const result = observingGatewayTesting.validateGatewayResultForTests(
    [{ threadId: 'thread-1', title: 'Caroline counseling and mental-health career plans' }],
    [{ turnId: 'session:1', text: 'Caroline mentions career plans.' }],
    {
      routes: [{
        turnId: 'session:1',
        targetThreadId: 'thread-1',
        sourceSlice: 'Caroline mentions career plans.',
        rationale: 'The slice continues the existing career planning thread.',
      }],
    },
  );

  assert.deepEqual(result.routes, [{
    turnId: 'session:1',
    targetThreadId: 'thread-1',
    sourceSlice: 'Caroline mentions career plans.',
    rationale: 'The slice continues the existing career planning thread.',
  }]);
});

test('gateway validation accepts new source slice routes with concrete titles', () => {
  const result = observingGatewayTesting.validateGatewayResultForTests(
    [],
    [{ turnId: 'session:12', text: 'Melanie shares a lake painting.' }],
    {
      routes: [{
        turnId: 'session:12',
        targetThreadId: null,
        newThreadTitle: 'Melanie lake sunrise painting and creative outlet',
        sourceSlice: 'Melanie shares a lake painting.',
        rationale: 'The slice introduces a separate painting topic.',
      }],
    },
  );

  assert.deepEqual(result.routes, [{
    turnId: 'session:12',
    targetThreadId: null,
    newThreadTitle: 'Melanie lake sunrise painting and creative outlet',
    sourceSlice: 'Melanie shares a lake painting.',
    rationale: 'The slice introduces a separate painting topic.',
  }]);
});

test('gateway validation rejects routes without rationale', () => {
  assert.throws(
    () => observingGatewayTesting.validateGatewayResultForTests(
      [{ threadId: 'thread-1', title: 'Caroline counseling and mental-health career plans' }],
      [{ turnId: 'session:1', text: 'Caroline mentions career plans.' }],
      {
        routes: [{
          turnId: 'session:1',
          targetThreadId: 'thread-1',
          sourceSlice: 'Caroline mentions career plans.',
        }],
      },
    ),
    /empty rationale/i,
  );
});

test('gateway validation rejects existing-thread routes that also set newThreadTitle', () => {
  assert.throws(
    () => observingGatewayTesting.validateGatewayResultForTests(
      [{ threadId: 'thread-1', title: 'Caroline counseling and mental-health career plans' }],
      [{ turnId: 'session:1', text: 'Caroline mentions career plans.' }],
      {
        routes: [{
          turnId: 'session:1',
          targetThreadId: 'thread-1',
          newThreadTitle: 'Unexpected replacement title',
          sourceSlice: 'Caroline mentions career plans.',
          rationale: 'The slice continues the existing career planning thread.',
        }],
      },
    ),
    /invalid targetThreadId/i,
  );
});

test('observer validation keeps valid context refs', () => {
  const result = observingGatewayTesting.validateObserveResultForTests({
    observingContentUpdate: {
      title: 'Painting',
      summary: 'Melanie painted a lake sunrise.',
      openQuestions: [],
      nextSteps: [],
    },
    contextRefs: [{
      turnId: 'session:13',
      summary: 'Melanie says she painted the lake sunrise in 2022, described as last year relative to 8 May 2023.',
    }],
    observationDelta: {
      before: [],
      after: [{
        text: 'Melanie painted the lake sunrise painting in 2022.',
        category: 'Fact',
        updatedMemory: null,
      }],
    },
  });

  assert.deepEqual(result.contextRefs, [{
    turnId: 'session:13',
    summary: 'Melanie says she painted the lake sunrise in 2022, described as last year relative to 8 May 2023.',
  }]);
});

test('thread observing consumes prepared observation work items', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const result = await observingGatewayModule.observePreparedThread({
    observingContent: {
      title: 'Caroline support group',
      summary: 'Caroline support group',
      observations: [],
      openQuestions: [],
      nextSteps: [],
    },
    observations: [{
      id: 'obs-1',
      text: 'Caroline joined an LGBTQ support group in May 2023.',
      category: 'fact',
      references: ['session:1'],
    }],
  });

  assert.deepEqual(result.contextRefs, [{
    turnId: 'session:1',
    summary: 'Caroline joined an LGBTQ support group in May 2023.',
  }]);
});

test('observing snapshots keep complete cumulative context refs', () => {
  const thread = createObservingThread(
    'default-observer',
    'Career',
    'Career thread',
    [],
    1,
    '2026-01-01T00:00:00.000Z',
  );
  const result = (summary, turnId) => ({
    observingContentUpdate: {
      title: 'Career',
      summary,
      openQuestions: [],
      nextSteps: [],
    },
    contextRefs: [{ turnId, summary }],
    observationDelta: {
      before: [],
      after: [{ text: summary, category: 'Fact', updatedMemory: null }],
    },
  });

  for (let index = 1; index <= 10; index += 1) {
    threadTesting.applyObserveResultForTests(
      thread,
      result(`slice ${index}`, `session:${index}`),
      index,
      (current, observeResult) => ({
        observations: [
          ...current,
          ...observeResult.observationDelta.after.map((observation) => ({
            ...observation,
            id: observation.id ?? `observation-${index}`,
          })),
        ],
        observationDelta: observeResult.observationDelta,
      }),
      '2026-01-01T00:00:00.000Z',
    );
  }

  const latest = thread.snapshots[thread.snapshots.length - 1];
  assert.deepEqual(latest.contextRefs.map((reference) => reference.turnId), [
    'session:1',
    'session:2',
    'session:3',
    'session:4',
    'session:5',
    'session:6',
    'session:7',
    'session:8',
    'session:9',
    'session:10',
  ]);
  assert.deepEqual(thread.references, [
    'session:1',
    'session:2',
    'session:3',
    'session:4',
    'session:5',
    'session:6',
    'session:7',
    'session:8',
    'session:9',
    'session:10',
  ]);
  assert.deepEqual(toObservingSnapshot(thread).references, thread.references);
});

test('observing context refs update duplicate turn summaries without duplicates', () => {
  const thread = createObservingThread(
    'default-observer',
    'Career',
    'Career thread',
    [],
    1,
    '2026-01-01T00:00:00.000Z',
  );
  const observeResult = (summary) => ({
    observingContentUpdate: {
      title: 'Career',
      summary,
      openQuestions: [],
      nextSteps: [],
    },
    contextRefs: [{ turnId: 'session:1', summary }],
    observationDelta: { before: [], after: [] },
  });

  threadTesting.applyObserveResultForTests(
    thread,
    observeResult('initial summary'),
    1,
    (observations, result) => ({
      observations,
      observationDelta: result.observationDelta,
    }),
    '2026-01-01T00:00:00.000Z',
  );
  threadTesting.applyObserveResultForTests(
    thread,
    observeResult('updated summary'),
    2,
    (observations, result) => ({
      observations,
      observationDelta: result.observationDelta,
    }),
    '2026-01-01T00:00:01.000Z',
  );

  assert.deepEqual(thread.snapshots.at(-1).contextRefs, [{
    turnId: 'session:1',
    summary: 'updated summary',
  }]);
  assert.deepEqual(thread.references, ['session:1']);
});

test('applyGatewayUpdates passes raw prompt response and source slice to observer', async () => {
  const now = '2026-01-01T00:00:00.000Z';
  const thread = createObservingThread('default-observer', 'Painting', 'Painting thread', [], 1, now);
  const observedInputs = [];
  const observeThreadImpl = async (input) => {
    observedInputs.push(input);
    return {
      observingContentUpdate: {
        title: 'Painting',
        summary: 'Melanie painted a lake sunrise in 2022.',
        openQuestions: [],
        nextSteps: [],
      },
      contextRefs: [{
        turnId: 'session:13',
        summary: 'Melanie says she painted the lake sunrise in 2022, described as last year relative to 8 May 2023.',
      }],
      observationDelta: {
        before: [],
        after: [{
          text: 'Melanie painted the lake sunrise painting in 2022.',
          category: 'Fact',
          updatedMemory: null,
        }],
      },
    };
  };

  await updateTesting.applyGatewayUpdatesForTests({
    threads: [thread],
    observerName: 'default-observer',
    pendingTurns: [{
      turnId: 'session:13',
      createdAt: now,
      updatedAt: now,
      sessionId: 'locomo',
      agent: 'Melanie',
      observer: 'default-observer',
      title: null,
      summary: 'DATE: 1:56 pm on 8 May, 2023\nDIALOGUE:\nMelanie said: "Yeah, I painted that lake sunrise last year!"',
      prompt: 'DATE: 1:56 pm on 8 May, 2023\nDIALOGUE:\nMelanie said: "Yeah, I painted that lake sunrise last year!"',
      response: '[imported dialogue event; no assistant response]',
      observingEpoch: 2,
    }],
    observingEpoch: 2,
    updates: [{
      turnId: 'session:13',
      targetThreadId: thread.observingId,
      sourceSlice: 'Melanie said: "Yeah, I painted that lake sunrise last year!"',
      rationale: 'The slice continues the painting thread.',
    }],
    observeThreadImpl,
  });

  assert.deepEqual(observedInputs[0].pendingTurns, [{
    turnId: 'session:13',
    sourceSlice: 'Melanie said: "Yeah, I painted that lake sunrise last year!"',
    prompt: 'DATE: 1:56 pm on 8 May, 2023\nDIALOGUE:\nMelanie said: "Yeah, I painted that lake sunrise last year!"',
    response: '[imported dialogue event; no assistant response]',
  }]);
  assert.equal('rationale' in observedInputs[0].pendingTurns[0], false);
  assert.deepEqual(thread.snapshots.at(-1).contextRefs, [{
    turnId: 'session:13',
    summary: 'Melanie says she painted the lake sunrise in 2022, described as last year relative to 8 May 2023.',
  }]);
});

test('gateway input includes latest continuity hints and transient previous turn context', () => {
  const thread = createObservingThread(
    'default-observer',
    'Career',
    'Career thread',
    [],
    1,
    '2026-01-01T00:00:00.000Z',
  );
  thread.snapshots.push({
    observations: [],
    contextRefs: [
      { turnId: 'session:10', summary: 'Caroline attended a LGBTQ support group.' },
      { turnId: 'session:11', summary: 'Caroline is considering counseling work.' },
      { turnId: 'session:12', summary: 'Melanie encouraged Caroline to pursue counseling.' },
    ],
    openQuestions: [],
    nextSteps: [],
    observationDelta: { before: [], after: [] },
  });

  const input = updateTesting.activeGatewayInputsForTests([thread], 'default-observer', 365, 2);
  assert.deepEqual(input[0].continuityHints, [
    'Caroline is considering counseling work.',
    'Melanie encouraged Caroline to pursue counseling.',
  ]);

  const turns = observingGatewayTesting.gatewayTurnsForTests([{
    turnId: 'session:12',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessionId: 'locomo',
    agent: 'Melanie',
    observer: 'default-observer',
    summary: 'Melanie encouraged Caroline.',
    prompt: 'Melanie encouraged Caroline.',
    response: 'placeholder',
    observingEpoch: 2,
    previousTurnSummary: 'Caroline said she is keen on counseling or mental health.',
  }]);
  assert.deepEqual(turns[0], {
    turnId: 'session:12',
    text: 'Melanie encouraged Caroline.',
    previousTurn: 'Caroline said she is keen on counseling or mental health.',
  });
});

test('gateway input omits empty continuity hints', () => {
  const thread = createObservingThread(
    'default-observer',
    'Career',
    'Career thread',
    [],
    1,
    '2026-01-01T00:00:00.000Z',
  );
  thread.snapshots.push({
    observations: [],
    contextRefs: [],
    openQuestions: [],
    nextSteps: [],
    observationDelta: { before: [], after: [] },
  });

  const input = updateTesting.activeGatewayInputsForTests([thread], 'default-observer', 365, 3);
  assert.equal('continuityHints' in input[0], false);
});

test('routed turns without observer context refs are not persisted as references', async () => {
  const now = '2026-01-01T00:00:00.000Z';
  const thread = createObservingThread('default-observer', 'Career', 'Career thread', [], 1, now);
  const observeThreadImpl = async () => ({
    observingContentUpdate: {
      title: 'Career',
      summary: 'Career thread',
      openQuestions: [],
      nextSteps: [],
    },
    contextRefs: [],
    observationDelta: { before: [], after: [] },
  });

  await updateTesting.applyGatewayUpdatesForTests({
    threads: [thread],
    observerName: 'default-observer',
    pendingTurns: [{
      turnId: 'session:99',
      createdAt: now,
      updatedAt: now,
      sessionId: 'locomo',
      agent: 'Melanie',
      observer: 'default-observer',
      title: null,
      summary: 'A routed but ultimately irrelevant turn.',
      prompt: 'A routed but ultimately irrelevant turn.',
      response: null,
      observingEpoch: 2,
    }],
    observingEpoch: 2,
    updates: [{
      turnId: 'session:99',
      targetThreadId: thread.observingId,
      sourceSlice: 'A routed but ultimately irrelevant turn.',
      rationale: 'The route lets the observer inspect the existing career thread.',
    }],
    observeThreadImpl,
  });

  assert.deepEqual(thread.snapshots.at(-1).contextRefs, []);
  assert.deepEqual(thread.references, []);
});

test('new source slice route creates an independent observing thread', async () => {
  const now = '2026-01-01T00:00:00.000Z';
  const threads = [];
  const observedInputs = [];
  const observeThreadImpl = async (input) => {
    observedInputs.push(input);
    return {
      observingContentUpdate: {
        title: 'Melanie lake sunrise painting and creative outlet',
        summary: 'Melanie discusses her lake sunrise painting and painting as a creative outlet.',
        openQuestions: [],
        nextSteps: [],
      },
      contextRefs: [{
        turnId: 'session:12',
        summary: 'Melanie shared a photo of a lake painting.',
      }],
      observationDelta: {
        before: [],
        after: [{
          text: 'Melanie shared a lake painting during the check-in.',
          category: 'Fact',
          updatedMemory: null,
        }],
      },
    };
  };

  await updateTesting.applyGatewayUpdatesForTests({
    threads,
    observerName: 'default-observer',
    pendingTurns: [{
      turnId: 'session:12',
      createdAt: now,
      updatedAt: now,
      sessionId: 'locomo',
      agent: 'Melanie',
      observer: 'default-observer',
      title: null,
      summary: 'Melanie encouraged Caroline and shared a lake painting.',
      prompt: 'Melanie said: "You would be a great counselor. By the way, take a look at this painting."',
      response: null,
      observingEpoch: 2,
    }],
    observingEpoch: 2,
    updates: [{
      turnId: 'session:12',
      targetThreadId: null,
      newThreadTitle: 'Melanie lake sunrise painting and creative outlet',
      sourceSlice: 'By the way, take a look at this painting.',
      rationale: 'The slice introduces a separate painting topic.',
    }],
    observeThreadImpl,
  });

  assert.equal(threads.length, 1);
  assert.equal(threads[0].title, 'Melanie lake sunrise painting and creative outlet');
  assert.equal(observedInputs[0].pendingTurns[0].sourceSlice, 'By the way, take a look at this painting.');
});

test('buildTouchedIndex immediately advances observation index for touched threads', async (t) => {
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
      { observations: [], contextRefs: [], openQuestions: [], nextSteps: [], observationDelta: { before: [], after: [] } },
      {
        observations: [],
        contextRefs: [],
        openQuestions: [],
        nextSteps: [],
        observationDelta: {
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
    observationTable: {
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

test('observer.retryObservation refreshes the committed checkpoint snapshot after observing rows are updated', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const observer = new Observer({
    observingTable: {
      update: async ({ snapshots }) => snapshots,
      stats: async () => ({
        version: 22,
        fragmentCount: 1,
        rowCount: 1,
      }),
    },
    observationTable: {
      delete: async () => ({ deleted: 0 }),
      loadByIds: async () => [],
      upsert: async () => undefined,
      stats: async () => ({
        version: 9,
        fragmentCount: 1,
        rowCount: 1,
      }),
    },
  });
  t.after(async () => observer.shutdown());

  observer.bootstrapped = true;
  observer.committedEpoch = 1;
  observer.openEpoch = new OpenEpoch(2);
  observer.threads = [{
    observingId: 'observing-a',
    snapshotId: 'snapshot-1',
    snapshotIds: ['snapshot-0', 'snapshot-1'],
    observingEpoch: 1,
    title: 'Existing title',
    summary: 'Existing summary',
    snapshots: [
      { observations: [], contextRefs: [], openQuestions: [], nextSteps: [], observationDelta: { before: [], after: [] } },
      {
        observations: [],
        contextRefs: [],
        openQuestions: [],
        nextSteps: [],
        observationDelta: {
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
  observer.refreshCheckpointSnapshot();

  await observer.retryObservation();

  assert.deepEqual(observer.exportCheckpoint(), {
    committedEpoch: 1,
    nextEpoch: 2,
    threads: [{
      observingId: 'observing-a',
      latestSnapshotId: 'snapshot-1',
      latestSnapshotSequence: 1,
      indexedSnapshotSequence: 1,
      updatedAt: '2024-01-01T00:00:00Z',
    }],
  });
});

test('observer.observeCurrentEpoch commits observing rows and schedules observation index retry', async (t) => {
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
    observationTable: {
      delete: async () => ({ deleted: 0 }),
      loadByIds: async () => [],
      upsert: async () => {
        semanticUpserts += 1;
        throw new Error('observation write failed');
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
      { observations: [], contextRefs: [], openQuestions: [], nextSteps: [], observationDelta: { before: [], after: [] } },
    ],
    references: ['session:existing'],
    indexedSnapshotSequence: 0,
    observer: 'default-observer',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  }];
  observer.buildCurrentEpochIndex = async () => {
    semanticUpserts += 1;
    throw new Error('observation write failed');
  };

  await observer.observeCurrentEpoch();

  assert.equal(semanticUpserts, 1);
  assert.equal(observer.committedEpoch, 1);
  assert.equal(observer.currentEpoch, null);
  assert.equal(observer.threads[0].snapshotId, 'snapshot-1');
  assert.ok(getPendingIndex(observer.threads[0]) !== null);
  assert.ok(observer.nextIndexRetryAt > Date.now());
});

test('observer.run retries pending observation index before queued epochs when due', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const calls = [];
  const observer = new Observer({
    observingTable: {
      update: async ({ snapshots }) => snapshots,
    },
    observationTable: {
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
          observations: [],
          contextRefs: [],
          openQuestions: [],
          nextSteps: [],
          observationDelta: { before: [], after: [] },
        },
        {
          observations: [],
          contextRefs: [],
          openQuestions: [],
          nextSteps: [],
          observationDelta: {
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

  observer.retryObservation = async () => {
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
        return {
          turn: makeObservableTurn('turn-1', epoch, 'first'),
          deduped: false,
        };
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
          return {
            turn: makeObservableTurn('turn-1', epoch, 'first'),
            deduped: false,
          };
        }
        secondEpoch = epoch;
        secondEntered.resolve();
        await releaseSecond.promise;
        return {
          turn: makeObservableTurn('turn-2', epoch, 'second'),
          deduped: true,
        };
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

  await addMessage({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'replay prompt',
    response: 'replay response',
  });

  await shutdownCoreForTests();

  const watermark = await observerApi.watermark();
  assert.ok(watermark.pendingTurnIds.length > 0);

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
          observations: [],
          contextRefs: [],
          openQuestions: [],
          nextSteps: [],
          observationDelta: {
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
