import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';

import core from '../dist/index.js';
import { __testing } from '../dist/client.js';
import {
  getCurationConfigFromConfigForTests,
  getObserverLlmConfig,
  validateMuninnConfigInput,
} from '../dist/config.js';
import { MuninnBackend } from '../dist/backend.js';
import { Observer } from '../dist/observer/observer.js';
import { EpochQueue, OpenEpoch } from '../dist/observer/epoch.js';
import { parseCheckpointFile, readCheckpointFile, resolveCheckpointPath } from '../dist/checkpoint.js';
import { SessionRegistry } from '../dist/turn/registry.js';
import { normalizeSessionId, sessionKey } from '../dist/turn/key.js';
import { Session } from '../dist/turn/session.js';
import { Watchdog } from '../dist/watchdog.js';
import updateModule from '../dist/observer/update.js';
import threadModule from '../dist/observer/thread.js';
import observingGatewayModule from '../dist/llm/observing-gateway.js';
import { applyExtractionChanges, applyExtractionTableChanges } from '../dist/observer/memory-delta.js';
import { recallMemories } from '../dist/memories/recall.js';
import { validateMemoryRecallResult } from '../dist/memories/memory-recaller.js';
import { getNativeTables } from '../dist/native.js';

const { __testing: updateTesting } = updateModule;
const { __testing: threadTesting } = threadModule;
const { __testing: observingGatewayTesting } = observingGatewayModule;
const { createObservingThread, getPendingIndex, getPendingIndexUpTo, loadThreads, toSessionSnapshot } = threadModule;
const { addMessage, observer: observerApi, shutdownCoreForTests } = core;
const CHECKPOINT_SCHEMA_VERSION = 4;

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

async function writeObserverConfig(configPath, {
  activeWindowDays = 3650,
  epochTurns,
  epochWindowMs,
  name = 'default-observer',
} = {}) {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    observer: {
      name,
      llm: 'observer_llm',
      maxAttempts: 3,
      activeWindowDays,
      ...(epochTurns === undefined ? {} : { epochTurns }),
      ...(epochWindowMs === undefined ? {} : { epochWindowMs }),
    },
    llm: {
      observer_llm: {
        provider: 'mock',
      },
    },
    extraction: {
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
    extraction: {
      embedding: {
        provider: 'mock',
        dimensions: 8,
      },
      defaultImportance: 0.7,
    },
  }, null, 2)}\n`, 'utf8');
}

test('config reads extraction embedding config and rejects semanticIndex', async () => {
  assert.doesNotThrow(() => validateMuninnConfigInput(JSON.stringify({
    storage: { uri: 'file:///tmp/muninn-test' },
    observer: { name: 'default-observer', llm: 'observer_llm' },
    llm: { observer_llm: { provider: 'mock' } },
    extraction: { embedding: { provider: 'mock' } },
  })));
  assert.throws(() => validateMuninnConfigInput(JSON.stringify({
    storage: { uri: 'file:///tmp/muninn-test' },
    observer: { name: 'default-observer', llm: 'observer_llm' },
    llm: { observer_llm: { provider: 'mock' } },
    semanticIndex: { embedding: { provider: 'mock' } },
  })), /semanticIndex/);
});

test('curation anchor threshold defaults to five and validates positive integer', () => {
  const config = {
    storage: { uri: 'file:///tmp/muninn-test' },
    observer: { name: 'default-observer', llm: 'observer_llm' },
    llm: { observer_llm: { provider: 'mock' } },
    extraction: { embedding: { provider: 'mock' } },
  };
  assert.equal(getCurationConfigFromConfigForTests(config).anchorThreshold, 5);
  assert.throws(() => validateMuninnConfigInput(JSON.stringify({
    ...config,
    curation: { anchorThreshold: 0 },
  })), /curation\.anchorThreshold must be a positive integer/);
});

test('checkpoint preserves curation runs', () => {
  const checkpoint = parseCheckpointFile(JSON.stringify({
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    writtenAt: new Date(0).toISOString(),
    writerPid: 1,
    observer: {
      baseline: { turn: 0, session: 0, extraction: 0, curation: 0, observation: 0 },
      nextEpoch: 1,
      recentSessions: [],
      threads: [],
      runs: [],
      curationRuns: [{
        runId: 'run-1',
        curationId: 'entity:caroline',
        anchor: 'Caroline',
        stage: 'generatingCuration',
        pendingExtractionIds: ['abc'],
        errors: [],
      }],
    },
  }));
  assert.equal(checkpoint.observer.curationRuns[0].curationId, 'entity:caroline');
});

test('native bindings expose curation and observation tables', async () => {
  const tables = await getNativeTables();
  assert.equal(typeof tables.extractionTable.list, 'function');
  assert.equal(typeof tables.curationTable.insert, 'function');
  assert.equal(typeof tables.curationTable.latest, 'function');
  assert.equal(typeof tables.curationTable.stats, 'function');
  assert.equal(typeof tables.observationTable.replaceForCuration, 'function');
  assert.equal(typeof tables.observationTable.search, 'function');
  assert.equal(typeof tables.observationTable.stats, 'function');
});

test('curation markdown parser derives parent and child observations', async () => {
  const { parseCurationDocument } = await import('../dist/curation/markdown.js');
  const parsed = parseCurationDocument([
    '# Entity Memory: Alex',
    '',
    '## Who is Alex?',
    '<refs: [extraction:a, extraction:b]>',
    '',
    'Alex is a product lead focused on onboarding.',
    '',
    '### What changed recently?',
    '<refs: [extraction:c]>',
    '',
    'Alex moved the onboarding review to Thursday.',
  ].join('\n'), new Set(['extraction:a', 'extraction:b', 'extraction:c']));

  assert.equal(parsed.title, 'Entity Memory: Alex');
  assert.equal(parsed.summary, 'Alex is a product lead focused on onboarding.');
  assert.equal(parsed.observations.length, 2);
  assert.deepEqual(parsed.observations[0], {
    heading: 'Who is Alex?',
    text: 'Who is Alex?\n\nAlex is a product lead focused on onboarding.',
    references: ['extraction:a', 'extraction:b'],
  });
  assert.deepEqual(parsed.observations[1], {
    heading: 'Who is Alex? / What changed recently?',
    text: 'Who is Alex?\nWhat changed recently?\n\nAlex moved the onboarding review to Thursday.',
    references: ['extraction:a', 'extraction:b', 'extraction:c'],
  });
});

test('curation markdown parser rejects invalid refs and missing refs', async () => {
  const { parseCurationDocument } = await import('../dist/curation/markdown.js');
  assert.throws(() => parseCurationDocument([
    '# Entity Memory: Alex',
    '',
    '## Who is Alex?',
    '<refs: [session:a]>',
    '',
    'Alex is a product lead.',
  ].join('\n'), new Set(['extraction:a'])), /extraction memory id/);

  assert.throws(() => parseCurationDocument([
    '# Entity Memory: Alex',
    '',
    '## Who is Alex?',
    '',
    'Alex is a product lead.',
  ].join('\n'), new Set(['extraction:a'])), /must be followed by <refs/);

  assert.throws(() => parseCurationDocument([
    '# Entity Memory: Alex',
    '',
    '## Who is Alex?',
    '<refs: [extraction:missing]>',
    '',
    'Alex is a product lead.',
  ].join('\n'), new Set(['extraction:a'])), /unknown extraction ref/);
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

function storedExtraction(id) {
  return {
    id,
    text: `${id} text`,
    anchors: [],
    vector: [1, 0, 0, 0],
    importance: 1,
    category: 'fact',
    references: ['turn:1'],
    createdAt: '2024-01-01T00:00:00Z',
  };
}

function threadMemoryDocument(units, {
  title = 'Painting Memory',
  summary = 'This thread tracks durable painting memory.',
} = {}) {
  return [
    `# ${title}`,
    '',
    '## Summary',
    summary,
    '',
    '## Extractions',
    typeof units === 'string' ? units : units.join('\n'),
  ].join('\n');
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
    sessionTable: {
      insert: async ({ snapshots }) => snapshots.map((snapshot) => ({
        ...snapshot,
        snapshotId: `snapshot-${snapshotSequence += 1}`,
      })),
      update: async ({ snapshots }) => snapshots,
    },
    extractionTable: {
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
    extraction: {
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
    extraction: {
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
    turnTable: {
      stats: async () => {
        sessionStatsCalls += 1;
        return null;
      },
      compact: async () => ({ changed: false }),
    },
    sessionTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    extractionTable: {
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
    turnTable: {
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
    sessionTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    extractionTable: {
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

test('watchdog creates and optimizes extraction index only once for an unchanged version', async (t) => {
  const { dir, homeDir } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  let ensureCalls = 0;
  let optimizeCalls = 0;
  const runtime = new Watchdog({
    turnTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    sessionTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    extractionTable: {
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
    record.dataset === 'extraction'
    && record.event === 'index_created'
    && record.version === 11
  )));
  assert.ok(records.some((record) => (
    record.dataset === 'extraction'
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
    turnTable: {
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
    sessionTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    extractionTable: {
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
    turnTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    sessionTable: {
      stats: async () => ({
        version: 5,
        fragmentCount: 6,
        rowCount: 9,
      }),
      compact: async () => {
        throw new Error('session compact failed');
      },
    },
    extractionTable: {
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
    && record.dataset === 'session'
    && record.event === 'failed'
    && record.version === 5
    && /session compact failed/i.test(String(record.details?.errorMessage))
  )));
  assert.ok(errors.some((entry) => /session maintenance failed: session compact failed/i.test(entry)));
});

test('watchdog logs extraction optimize failures with the current stats version', async (t) => {
  const { dir, homeDir } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  const runtime = new Watchdog({
    turnTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    sessionTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    extractionTable: {
      ensureVectorIndex: async () => ({ created: false }),
      stats: async () => ({
        version: 13,
        fragmentCount: 1,
        rowCount: 2,
      }),
      compact: async () => ({ changed: false }),
      optimize: async () => {
        throw new Error('extraction optimize failed');
      },
    },
  }, createWatchdogConfig({ compactMinFragments: 3 }));
  t.after(async () => runtime.stop());

  runtime.start();
  await waitFor(async () => (await readWatchdogLog(homeDir)).some((record) => record.event === 'failed'));

  const records = await readWatchdogLog(homeDir);
  assert.ok(records.some((record) => (
    record.level === 'error'
    && record.dataset === 'extraction'
    && record.event === 'failed'
    && record.version === 13
    && /extraction optimize failed/i.test(String(record.details?.errorMessage))
  )));
});

test('watchdog logs null version when stats fails before reading the current dataset version', async (t) => {
  const { dir, homeDir } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  let statsCalls = 0;
  const runtime = new Watchdog({
    turnTable: {
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
    sessionTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    extractionTable: {
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
    turnTable: {
      stats: async () => ({
        version: 10,
        fragmentCount: 1,
        rowCount: 1,
      }),
      compact: async () => ({ changed: false }),
    },
    sessionTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    extractionTable: {
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
          session: 21,
          extraction: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [makeRecentSessionCheckpoint([makeRecentTurn('turn:101', 'checkpoint-1')])],
        threads: [{
          sessionId: 'obs-1',
          latestSnapshotId: 'turn:42',
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
      session: 21,
      extraction: 8,
    },
    committedEpoch: 12,
    nextEpoch: 13,
    recentSessions: [makeRecentSessionCheckpoint([makeRecentTurn('turn:101', 'checkpoint-1')])],
    threads: [{
      sessionId: 'obs-1',
      latestSnapshotId: 'turn:42',
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
          session: 21,
          extraction: 8,
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
    turnTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    sessionTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    extractionTable: {
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
          session: 21,
          extraction: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [makeRecentSessionCheckpoint([makeRecentTurn('turn:101', 'checkpoint-2')])],
        threads: [{
          sessionId: 'obs-1',
          latestSnapshotId: 'turn:42',
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
    turnTable: {
      stats: async () => ({
        version: 10,
        fragmentCount: 1,
        rowCount: 1,
      }),
      compact: async () => ({ changed: false }),
    },
    sessionTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    extractionTable: {
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
          session: 21,
          extraction: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [makeRecentSessionCheckpoint([makeRecentTurn('turn:101', 'checkpoint-3')])],
        threads: [{
          sessionId: 'obs-1',
          latestSnapshotId: 'turn:42',
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
    turnTable: {
      stats: async () => ({
        version: 10,
        fragmentCount: 1,
        rowCount: 1,
      }),
      compact: async () => ({ changed: false }),
    },
    sessionTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    extractionTable: {
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
          session: 21,
          extraction: 8,
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

test('checkpoint preserves session runs', async () => {
  const { parseCheckpointFile, serializeCheckpointFile } = await import('../dist/checkpoint.js');
  const file = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    writtenAt: new Date().toISOString(),
    writerPid: 1,
    observer: {
      baseline: { turn: 1, session: 1, extraction: 1 },
      nextEpoch: 2,
      recentSessions: [],
      threads: [],
      runs: [{
        observer: 'default',
        epoch: 1,
        status: 'running',
        stage: 'fittingThreads',
        inputTurnIds: ['turn:1'],
        pending: {
          sessionFragments: [{
            threadId: 'thread-1',
            turnIds: ['turn:1'],
            content: 'source content',
            reason: 'The source continues the thread.',
          }],
        },
        committed: { extractionIds: ['obs-1'], snapshotIds: [] },
        traceRefs: [],
        errors: [],
      }],
    },
  };

  const parsed = parseCheckpointFile(serializeCheckpointFile(file));
  assert.equal(parsed.observer.runs[0].stage, 'fittingThreads');
  assert.equal(parsed.observer.runs[0].pending.sessionFragments[0].content, 'source content');
  assert.deepEqual(parsed.observer.runs[0].committed.extractionIds, ['obs-1']);
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
          session: 21,
          extraction: 8,
        },
        committedEpoch: 11,
        nextEpoch: 12,
        recentSessions: [],
        threads: [],
      },
  }, null, 2)}\n`, 'utf8');
  const beforeStat = await stat(resolveCheckpointPath());

  const runtime = new Watchdog({
    turnTable: {
      stats: async () => ({
        version: 10,
        fragmentCount: 1,
        rowCount: 0,
      }),
      compact: async () => ({ changed: false }),
    },
    sessionTable: {
      stats: async () => null,
      compact: async () => ({ changed: false }),
    },
    extractionTable: {
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
          session: 21,
          extraction: 8,
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
    sessionId: 'session-a',
    observingEpoch: 7,
    title: 'Title',
    summary: 'Summary',
    snapshots: [
      { extractions: [], contextRefs: [], openQuestions: [], nextSteps: [], extractionDelta: { before: [], after: [] } },
      { extractions: [], contextRefs: [], openQuestions: [], nextSteps: [], extractionDelta: { before: [], after: [] } },
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
    sessionId: 'session-a',
    observingEpoch: 8,
    title: 'Title',
    summary: 'Summary',
    snapshots: [
      { extractions: [], contextRefs: [], openQuestions: [], nextSteps: [], extractionDelta: { before: [], after: [] } },
      { extractions: [], contextRefs: [], openQuestions: [], nextSteps: [], extractionDelta: { before: [], after: [] } },
      { extractions: [], contextRefs: [], openQuestions: [], nextSteps: [], extractionDelta: { before: [], after: [] } },
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
      sessionId: 'fresh-thread',
      snapshotSequence: 0,
      createdAt: freshUpdatedAt,
      updatedAt: freshUpdatedAt,
      observer: 'default-observer',
      title: 'Fresh thread',
      summary: 'Fresh summary',
      content: threadMemoryDocument('', { title: 'Fresh thread', summary: 'Fresh summary' }),
      references: [],
    },
    {
      snapshotId: 'stale-snapshot',
      sessionId: 'stale-thread',
      snapshotSequence: 0,
      createdAt: staleUpdatedAt,
      updatedAt: staleUpdatedAt,
      observer: 'default-observer',
      title: 'Stale thread',
      summary: 'Stale summary',
      content: threadMemoryDocument('', { title: 'Stale thread', summary: 'Stale summary' }),
      references: [],
    },
  ];

  const threads = loadThreads(snapshots, 'default-observer', 7);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].sessionId, 'fresh-thread');
});

test('loadThreads keeps full history for active threads', () => {
  const freshUpdatedAt = new Date().toISOString();
  const staleUpdatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const snapshots = [
    {
      snapshotId: 'snapshot-0',
      sessionId: 'mixed-thread',
      snapshotSequence: 0,
      createdAt: staleUpdatedAt,
      updatedAt: staleUpdatedAt,
      observer: 'default-observer',
      title: 'Thread',
      summary: 'Summary',
      content: threadMemoryDocument('', { title: 'Thread', summary: 'Summary' }),
      references: [],
    },
    {
      snapshotId: 'snapshot-1',
      sessionId: 'mixed-thread',
      snapshotSequence: 1,
      createdAt: freshUpdatedAt,
      updatedAt: freshUpdatedAt,
      observer: 'default-observer',
      title: 'Thread',
      summary: 'Summary',
      content: threadMemoryDocument('', { title: 'Thread', summary: 'Summary' }),
      references: [],
    },
  ];

  const threads = loadThreads(snapshots, 'default-observer', 7);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].sessionId, 'mixed-thread');
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

test('observer.watermark stays unresolved when only extraction index work is pending', async () => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  try {
    const observer = new Observer({});
    observer.bootstrapped = true;
    observer.openEpoch = new OpenEpoch(8);
    observer.threads = [{
      sessionId: 'session-a',
      snapshotId: 'snapshot-1',
      snapshotIds: ['snapshot-0', 'snapshot-1'],
      observingEpoch: 7,
      title: 'Title',
      summary: 'Summary',
      snapshots: [
        { extractions: [], contextRefs: [], openQuestions: [], nextSteps: [], extractionDelta: { before: [], after: [] } },
        { extractions: [], contextRefs: [], openQuestions: [], nextSteps: [], extractionDelta: { before: [], after: [] } },
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
      sessionId: 'fresh-thread',
      snapshotId: 'fresh-snapshot',
      snapshotIds: ['fresh-snapshot'],
      observingEpoch: 1,
      title: 'Fresh',
      summary: 'Fresh',
      snapshots: [{ extractions: [], contextRefs: [], openQuestions: [], nextSteps: [], extractionDelta: { before: [], after: [] } }],
      references: [],
      indexedSnapshotSequence: 0,
      observer: 'default-observer',
      createdAt: freshUpdatedAt,
      updatedAt: freshUpdatedAt,
    },
    {
      sessionId: 'stale-thread',
      snapshotId: 'stale-snapshot',
      snapshotIds: ['stale-snapshot'],
      observingEpoch: 1,
      title: 'Stale',
      summary: 'Stale',
      snapshots: [{ extractions: [], contextRefs: [], openQuestions: [], nextSteps: [], extractionDelta: { before: [], after: [] } }],
      references: [],
      indexedSnapshotSequence: 0,
      observer: 'default-observer',
      createdAt: staleUpdatedAt,
      updatedAt: staleUpdatedAt,
    },
  ];
  observer.refreshCheckpointSnapshot();

  assert.deepEqual(observer.exportCheckpoint().threads, [{
    sessionId: 'fresh-thread',
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

test('observer bootstrap without checkpoint derives committedEpoch from session snapshots', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const snapshot1At = new Date(Date.now() - 1_000).toISOString();
  const snapshot2At = new Date().toISOString();
  const rows = [
    {
      snapshotId: 'snapshot-1',
      sessionId: 'obs-1',
      snapshotSequence: 0,
      createdAt: snapshot1At,
      updatedAt: snapshot1At,
      observer: 'default-observer',
      title: 'Thread',
      summary: 'Summary',
      content: threadMemoryDocument('', { title: 'Thread', summary: 'Summary' }),
      references: ['turn-13'],
    },
    {
      snapshotId: 'snapshot-2',
      sessionId: 'obs-1',
      snapshotSequence: 1,
      createdAt: snapshot2At,
      updatedAt: snapshot2At,
      observer: 'default-observer',
      title: 'Thread',
      summary: 'Summary',
      content: threadMemoryDocument('', { title: 'Thread', summary: 'Summary' }),
      references: ['turn-13', 'turn-14'],
    },
  ];
  const observer = new Observer({
    turnTable: {
      loadTurnsAfterEpoch: async () => [
        makeObservableTurn('turn-13', 13, 'epoch13'),
        makeObservableTurn('turn-14', 14, 'epoch14'),
      ],
    },
    sessionTable: {
      listSnapshots: async () => rows,
      threadSnapshots: async () => rows,
    },
    extractionTable: {},
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
    turnTable: {
      loadTurnsAfterEpoch: async () => [
        makeObservableTurn('turn-13', 13, 'epoch13'),
        makeObservableTurn('turn-14', 14, 'epoch14'),
      ],
    },
    sessionTable: {
      listSnapshots: async () => [],
    },
    extractionTable: {},
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
          session: 21,
          extraction: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [makeRecentSessionCheckpoint([makeRecentTurn('turn:101', 'checkpoint-4')])],
        threads: [{
          sessionId: 'obs-1',
          latestSnapshotId: 'turn:42',
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
    turnTable: {
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
    sessionTable: {
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
      threadSnapshots: async (sessionId) => {
        assert.equal(sessionId, 'obs-1');
        return [
          {
            snapshotId: 'turn:41',
            sessionId: 'obs-1',
            snapshotSequence: 0,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
            observer: 'default-observer',
            title: 'Thread',
            summary: 'Summary',
            content: threadMemoryDocument('', { title: 'Thread', summary: 'Summary' }),
            references: [],
          },
          {
            snapshotId: 'turn:42',
            sessionId: 'obs-1',
            snapshotSequence: 1,
            createdAt: '2024-01-01T00:00:01Z',
            updatedAt: '2024-01-01T00:00:01Z',
            observer: 'default-observer',
            title: 'Thread',
            summary: 'Summary',
            content: threadMemoryDocument('', { title: 'Thread', summary: 'Summary' }),
            references: [],
          },
        ];
      },
    },
    extractionTable: {
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
    runs: [],
    curationRuns: [],
    threads: [{
      sessionId: 'obs-1',
      latestSnapshotId: 'turn:42',
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
          session: 21,
          extraction: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [],
        threads: [{
          sessionId: 'mixed-thread',
          latestSnapshotId: 'snapshot-1',
          latestSnapshotSequence: 1,
          indexedSnapshotSequence: 1,
          updatedAt: freshUpdatedAt,
        }],
      },
  }, null, 2)}\n`, 'utf8');

  const checkpoint = (await readCheckpointFile())?.observer ?? null;
  const observer = new Observer({
    turnTable: {
      stats: async () => ({
        version: 10,
        fragmentCount: 1,
        rowCount: 0,
      }),
      loadTurnsAfterEpoch: async () => [],
    },
    sessionTable: {
      delta: async () => [],
      stats: async () => ({
        version: 21,
        fragmentCount: 1,
        rowCount: 2,
      }),
      listSnapshots: async () => [],
      threadSnapshots: async (sessionId) => {
        assert.equal(sessionId, 'mixed-thread');
        return [
          {
            snapshotId: 'snapshot-0',
            sessionId: 'mixed-thread',
            snapshotSequence: 0,
            createdAt: staleUpdatedAt,
            updatedAt: staleUpdatedAt,
            observer: 'default-observer',
            title: 'Thread',
            summary: 'Summary',
            content: threadMemoryDocument('', { title: 'Thread', summary: 'Summary' }),
            references: [],
          },
          {
            snapshotId: 'snapshot-1',
            sessionId: 'mixed-thread',
            snapshotSequence: 1,
            createdAt: freshUpdatedAt,
            updatedAt: freshUpdatedAt,
            observer: 'default-observer',
            title: 'Thread',
            summary: 'Summary',
            content: threadMemoryDocument('', { title: 'Thread', summary: 'Summary' }),
            references: [],
          },
        ];
      },
    },
    extractionTable: {
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
          session: 21,
          extraction: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [],
        threads: [{
          sessionId: 'obs-1',
          latestSnapshotId: 'snapshot-0',
          latestSnapshotSequence: 0,
          indexedSnapshotSequence: 0,
          updatedAt: snapshot0At,
        }],
      },
  }, null, 2)}\n`, 'utf8');

  const checkpoint = (await readCheckpointFile())?.observer ?? null;
  const observer = new Observer({
    turnTable: {
      loadTurnsAfterEpoch: async () => [
        makeObservableTurn('turn-13', 13, 'epoch13'),
        makeObservableTurn('turn-14', 14, 'epoch14'),
      ],
    },
    sessionTable: {
      delta: async () => [
        {
          snapshotId: 'snapshot-1',
          sessionId: 'obs-1',
          snapshotSequence: 1,
          createdAt: snapshot1At,
          updatedAt: snapshot1At,
          observer: 'default-observer',
          title: 'Thread',
          summary: 'Summary',
          content: threadMemoryDocument('', { title: 'Thread', summary: 'Summary' }),
          references: ['turn-13'],
        },
        {
          snapshotId: 'snapshot-2',
          sessionId: 'obs-1',
          snapshotSequence: 2,
          createdAt: snapshot2At,
          updatedAt: snapshot2At,
          observer: 'default-observer',
          title: 'Thread',
          summary: 'Summary',
          content: threadMemoryDocument('', { title: 'Thread', summary: 'Summary' }),
          references: ['turn-13', 'turn-14'],
        },
      ],
      threadSnapshots: async () => [
        {
          snapshotId: 'snapshot-0',
          sessionId: 'obs-1',
          snapshotSequence: 0,
          createdAt: snapshot0At,
          updatedAt: snapshot0At,
          observer: 'default-observer',
          title: 'Thread',
          summary: 'Summary',
          content: threadMemoryDocument('', { title: 'Thread', summary: 'Summary' }),
          references: [],
        },
        {
          snapshotId: 'snapshot-1',
          sessionId: 'obs-1',
          snapshotSequence: 1,
          createdAt: snapshot1At,
          updatedAt: snapshot1At,
          observer: 'default-observer',
          title: 'Thread',
          summary: 'Summary',
          content: threadMemoryDocument('', { title: 'Thread', summary: 'Summary' }),
          references: ['turn-13'],
        },
        {
          snapshotId: 'snapshot-2',
          sessionId: 'obs-1',
          snapshotSequence: 2,
          createdAt: snapshot2At,
          updatedAt: snapshot2At,
          observer: 'default-observer',
          title: 'Thread',
          summary: 'Summary',
          content: threadMemoryDocument('', { title: 'Thread', summary: 'Summary' }),
          references: ['turn-13', 'turn-14'],
        },
      ],
    },
    extractionTable: {},
  }, checkpoint);
  t.after(async () => observer.shutdown());

  const restored = await observer.restoreCheckpointState();

  assert.equal(restored.committedEpoch, 14);
  assert.deepEqual(restored.pendingTurns, []);
  assert.deepEqual(restored.threads[0].snapshotIds, ['snapshot-0', 'snapshot-1', 'snapshot-2']);
  assert.deepEqual(restored.threads[0].snapshotEpochs, [12, 13, 14]);
});

test('observer restoreCheckpointState falls back when session delta refs are missing turn epochs', async (t) => {
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
          session: 21,
          extraction: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [],
        threads: [{
          sessionId: 'obs-1',
          latestSnapshotId: 'snapshot-0',
          latestSnapshotSequence: 0,
          indexedSnapshotSequence: 0,
          updatedAt: '2024-01-01T00:00:00Z',
        }],
      },
  }, null, 2)}\n`, 'utf8');

  const checkpoint = (await readCheckpointFile())?.observer ?? null;
  const observer = new Observer({
    turnTable: {
      loadTurnsAfterEpoch: async () => [makeObservableTurn('turn-13', 13, 'epoch13')],
    },
    sessionTable: {
      delta: async () => [
        {
          snapshotId: 'snapshot-1',
          sessionId: 'obs-1',
          snapshotSequence: 1,
          createdAt: '2024-01-01T00:00:01Z',
          updatedAt: '2024-01-01T00:00:01Z',
          observer: 'default-observer',
          title: 'Thread',
          summary: 'Summary',
          content: threadMemoryDocument('', { title: 'Thread', summary: 'Summary' }),
          references: ['missing-turn'],
        },
      ],
      threadSnapshots: async () => [
        {
          snapshotId: 'snapshot-0',
          sessionId: 'obs-1',
          snapshotSequence: 0,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          observer: 'default-observer',
          title: 'Thread',
          summary: 'Summary',
          content: threadMemoryDocument('', { title: 'Thread', summary: 'Summary' }),
          references: [],
        },
      ],
    },
    extractionTable: {},
  }, checkpoint);
  t.after(async () => observer.shutdown());

  const restored = await observer.restoreCheckpointState();

  assert.equal(restored, null);
});

test('observer restoreCheckpointState skips stale threads recovered only from session delta', async (t) => {
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
          session: 21,
          extraction: 8,
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
    sessionId: 'obs-stale',
    snapshotSequence: 0,
    createdAt: staleUpdatedAt,
    updatedAt: staleUpdatedAt,
    observer: 'default-observer',
    title: 'Stale Thread',
    summary: 'Summary',
    content: threadMemoryDocument('', { title: 'Thread', summary: 'Summary' }),
    references: ['turn-13'],
  };
  const observer = new Observer({
    turnTable: {
      loadTurnsAfterEpoch: async () => [makeObservableTurn('turn-13', 13, 'epoch13')],
    },
    sessionTable: {
      delta: async () => [staleRow],
      threadSnapshots: async () => [staleRow],
    },
    extractionTable: {},
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
          session: 21,
          extraction: 8,
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
    sessionId: 'obs-legacy',
    snapshotSequence: index,
    createdAt: rowTimes[index],
    updatedAt: rowTimes[index],
    observer: 'default-observer',
    title: 'Legacy Thread',
    summary: `Summary ${index}`,
    content: threadMemoryDocument('', { title: 'Thread', summary: 'Summary' }),
    references: Array.from({ length: index + 1 }, (_, turnIndex) => `turn-${turnIndex + 1}`),
  }));
  const turnById = new Map(fullRows.map((row, index) => [
    `turn-${index + 1}`,
    makeObservableTurn(`turn-${index + 1}`, index + 1, `epoch${index + 1}`),
  ]));
  const observer = new Observer({
    turnTable: {
      loadTurnsAfterEpoch: async () => [
        turnById.get('turn-6'),
        turnById.get('turn-7'),
        turnById.get('turn-8'),
      ],
      getTurn: async (turnId) => turnById.get(turnId) ?? null,
    },
    sessionTable: {
      delta: async () => [fullRows[6], fullRows[7]],
      threadSnapshots: async () => fullRows,
    },
    extractionTable: {},
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
          session: 21,
          extraction: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [],
        threads: [{
          sessionId: 'stale-thread',
          latestSnapshotId: 'turn:42',
          latestSnapshotSequence: 0,
          indexedSnapshotSequence: 0,
          updatedAt: staleUpdatedAt,
        }],
      },
  }, null, 2)}\n`, 'utf8');

  const checkpoint = (await readCheckpointFile())?.observer ?? null;
  const observer = new Observer({
    turnTable: {
      stats: async () => ({
        version: 10,
        fragmentCount: 1,
        rowCount: 0,
      }),
      loadTurnsAfterEpoch: async () => [],
    },
    sessionTable: {
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
    extractionTable: {
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
    sessionTable: {
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
    extractionTable: {
      delete: async () => ({ deleted: 0 }),
      loadByIds: async () => [],
      upsert: async () => undefined,
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
    sessionId: 'session-a',
    snapshotId: 'snapshot-0',
    snapshotIds: ['snapshot-0'],
    observingEpoch: 0,
    title: 'Existing title',
    summary: 'Existing summary',
    snapshots: [
      { extractions: [], contextRefs: [], openQuestions: [], nextSteps: [], extractionDelta: { before: [], after: [] } },
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
    runs: [],
    curationRuns: [],
    threads: [{
      sessionId: 'session-a',
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
    sessionId: thread.sessionId,
    latestSnapshotId: thread.snapshotId,
    latestSnapshotSequence: thread.snapshots.length - 1,
    indexedSnapshotSequence: thread.indexedSnapshotSequence ?? null,
    updatedAt: thread.updatedAt,
  })));
});

test('observer bootstrap ignores extraction version mismatches when session baseline matches', async (t) => {
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
          session: 21,
          extraction: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [],
        threads: [{
          sessionId: 'obs-1',
          latestSnapshotId: 'turn:42',
          latestSnapshotSequence: 1,
          indexedSnapshotSequence: 1,
          updatedAt: '2024-01-01T00:00:01Z',
        }],
      },
  }, null, 2)}\n`, 'utf8');

  let listSnapshotsCalls = 0;
  const checkpoint = (await readCheckpointFile())?.observer ?? null;
  const observer = new Observer({
    turnTable: {
      stats: async () => ({
        version: 10,
        fragmentCount: 1,
        rowCount: 1,
      }),
      loadTurnsAfterEpoch: async () => [],
    },
    sessionTable: {
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
          snapshotId: 'turn:41',
          sessionId: 'obs-1',
          snapshotSequence: 0,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          observer: 'default-observer',
          title: 'Thread',
          summary: 'Summary',
          content: threadMemoryDocument('', { title: 'Thread', summary: 'Summary' }),
          references: [],
        },
        {
          snapshotId: 'turn:42',
          sessionId: 'obs-1',
          snapshotSequence: 1,
          createdAt: '2024-01-01T00:00:01Z',
          updatedAt: '2024-01-01T00:00:01Z',
          observer: 'default-observer',
          title: 'Thread',
          summary: 'Summary',
          content: threadMemoryDocument('', { title: 'Thread', summary: 'Summary' }),
          references: [],
        },
      ],
    },
    extractionTable: {
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
          session: 21,
          extraction: 8,
        },
        committedEpoch: 12,
        nextEpoch: 13,
        recentSessions: [],
        threads: [{
          sessionId: 'obs-1',
          latestSnapshotId: 'turn:42',
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

test('recallMemories defaults to hybrid mode and passes query text to extraction search', async () => {
  const calls = [];
  const client = {
    extractionTable: {
      search: async (params) => {
        calls.push(params);
        return [{
          id: 'obs-1',
          text: 'Caroline researched adoption agencies.',
          vector: [],
          importance: 1,
          category: 'fact',
          references: ['turn:1'],
          createdAt: '2024-01-01T00:00:00Z',
        }];
      },
    },
  };

  const hits = await recallMemories(client, 'What did Caroline research?', 3, { embed: async () => [1, 0] });

  assert.deepEqual(hits, [{
    memoryId: 'extraction:obs-1',
    text: 'Caroline researched adoption agencies.',
    references: ['turn:1'],
  }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    query: 'What did Caroline research?',
    vector: [1, 0],
    limit: 3,
    mode: 'hybrid',
  });
});

test('recallMemories supports fts mode without embedding the query', async () => {
  let embedCalls = 0;
  const calls = [];
  const client = {
    extractionTable: {
      search: async (params) => {
        calls.push(params);
        return [];
      },
    },
  };

  await recallMemories(client, 'adoption agencies', 2, {
    mode: 'fts',
    embed: async () => {
      embedCalls += 1;
      return [1, 0];
    },
  });

  assert.equal(embedCalls, 0);
  assert.deepEqual(calls[0], {
    query: 'adoption agencies',
    vector: [],
    limit: 2,
    mode: 'fts',
  });
});

test('recallMemories returns recalled memory when budget is positive', async () => {
  const calls = [];
  const client = {
    extractionTable: {
      search: async (params) => {
        calls.push(params);
        return [
          {
            id: 'obs-1',
            text: 'Caroline and Melanie planned a summer outing.',
            context: 'They discussed summer plans together.',
            vector: [],
            importance: 1,
            category: 'Fact',
            references: ['D12:17'],
            createdAt: '2024-01-01T00:00:00Z',
          },
          {
            id: 'obs-2',
            text: 'Caroline researched adoption agencies.',
            context: 'Melanie asked Caroline about her summer plans.',
            vector: [],
            importance: 1,
            category: 'Fact',
            references: ['D2:8'],
            createdAt: '2024-01-01T00:00:00Z',
          },
        ];
      },
    },
  };

  const hits = await recallMemories(client, "What are Caroline's plans for the summer?", 0, {
    budget: 80,
    queryLimit: 20,
    embed: async () => [1, 0],
    recallMemory: async (input) => ({
      content: 'Caroline researched adoption agencies.',
      refs: ['D2:8'],
      raw: '{"content":"Caroline researched adoption agencies.","refs":["D2:8"]}',
      candidates: input.candidates,
    }),
  });

  assert.deepEqual(hits, [{
    memoryId: 'recalled:memory',
    text: 'Caroline researched adoption agencies.',
    references: ['D12:17', 'D2:8'],
  }]);
  assert.equal(calls[0].limit, 20);
});

test('recallMemories uses candidate refs for recalled memory', async () => {
  const client = {
    extractionTable: {
      search: async () => [
        {
          id: 'obs-1',
          text: 'Caroline researched adoption agencies.',
          context: null,
          vector: [],
          importance: 1,
          category: 'Fact',
          references: ['D2:8'],
          createdAt: '2024-01-01T00:00:00Z',
        },
      ],
    },
  };

  const hits = await recallMemories(client, 'What did Caroline research?', 1, {
    budget: 80,
    queryLimit: 20,
    embed: async () => [1, 0],
    recallMemory: async () => ({
      content: 'Caroline researched adoption agencies.',
      refs: ['D99:1'],
      raw: '',
      candidates: [],
    }),
  });

  assert.deepEqual(hits, [{
    memoryId: 'recalled:memory',
    text: 'Caroline researched adoption agencies.',
    references: ['D2:8'],
  }]);
});

test('memory recaller validation treats budget as a soft target', () => {
  const input = {
    query: 'q',
    budget: 10,
    candidates: [],
  };

  assert.deepEqual(
    validateMemoryRecallResult({ content: '123456789012345', refs: ['turn:1'] }, input),
    { content: '123456789012345', refs: ['turn:1'] },
  );
  assert.throws(
    () => validateMemoryRecallResult({ content: '123456789012345678901', refs: [] }, input),
    /soft budget limit: 21 > 20/,
  );
});

test('backend exportCheckpoint returns null before observer creation', async () => {
  const checkpoint = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    observer: {
        baseline: {
          turn: 10,
          session: 21,
          extraction: 8,
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
    turnTable: {},
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
    turnTable: {},
  }, 'default-observer');

  const first = registry.load('group-a', 'agent-a');
  const second = registry.load(' group-a ', 'agent-a');
  const [firstSession, secondSession] = await Promise.all([first, second]);

  assert.strictEqual(firstSession, secondSession);
});

test('session registry restores live sessions for checkpoint recent turns', async () => {
  const registry = new SessionRegistry({
    turnTable: {},
  }, 'default-observer');

  registry.restoreSession('group-a', 'agent-a', [{
    turnId: 'turn:101',
    updatedAt: '2024-01-01T00:00:00Z',
    prompt: 'pending prompt',
    response: '',
  }]);

  const session = await registry.load('group-a', 'agent-a');
  const exported = session.exportRecentSession();
  assert.deepEqual(exported?.turns.map((turn) => turn.turnId), ['turn:101']);
});

test('session registry replays persisted turns into recent windows', async () => {
  const registry = new SessionRegistry({
    turnTable: {},
  }, 'default-observer');

  registry.restoreSession('group-a', 'agent-a', [makeRecentTurn('turn:101', 'checkpoint')]);
  registry.rememberTurn(makePersistedTurn('turn:102', 'delta'));

  const exported = (await registry.load('group-a', 'agent-a')).exportRecentSession();
  assert.deepEqual(
    exported?.turns.map((turn) => turn.turnId),
    ['turn:101', 'turn:102'],
  );
});

test('session.accept serializes concurrent inserts for the same session', async () => {
  let concurrentInserts = 0;
  let maxConcurrentInserts = 0;
  let nextTurnId = 1;

  const session = new Session({
    turnTable: {
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
    turnTable: {
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

test('session.accept attaches recent three turns as transient extraction context', async () => {
  let nextTurnId = 1;
  const session = new Session({
    turnTable: {
      insert: async ({ turns }) => turns.map((turn) => ({
        ...turn,
        turnId: `turn:${nextTurnId++}`,
      })),
    },
  }, {
    sessionId: 'group-a',
    agent: 'agent-a',
    observer: 'default-observer',
  });

  for (const prompt of ['A', 'B', 'C']) {
    await session.accept({
      sessionId: 'group-a',
      agent: 'agent-a',
      prompt,
      response: `${prompt}-response`,
    }, 1);
  }

  const accepted = await session.accept({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'D',
    response: 'D-response',
  }, 1);

  assert.deepEqual(
    accepted.turn.recentContext.map((turn) => turn.turnId),
    ['turn:1', 'turn:2', 'turn:3'],
  );
  assert.deepEqual(
    accepted.turn.recentContext.map((turn) => turn.prompt),
    ['A', 'B', 'C'],
  );
});

test('session.accept drops stale recent turns before inserting a new turn', async () => {
  let nextTurnId = 1;
  const insertedTurns = new Map();

  const session = new Session({
    turnTable: {
      insert: async ({ turns }) => turns.map((turn) => {
        const persisted = {
          ...turn,
          turnId: `turn:${nextTurnId++}`,
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
      makeRecentTurn('turn:stale-1', 'stale'),
      makeRecentTurn('turn:stale-2', 'stale'),
    ],
  });

  const accepted = await session.accept({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'stale prompt',
    response: 'stale response',
  }, 1);

  assert.equal(accepted.deduped, false);
  assert.equal(accepted.turn.turnId, 'turn:1');
  assert.deepEqual(
    session.exportRecentSession()?.turns.map((turn) => turn.turnId),
    ['turn:1'],
  );
});

test('open epoch skips deduped turns when staging observable turns', async () => {
  const epoch = new OpenEpoch(7);
  const dedupedTurn = {
    turnId: 'turn:1',
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
      sessionTable: {
        insert: async () => {
          throw new Error('persist failed');
        },
      },
      extractionTable: {
        delete: async () => ({ deleted: 0 }),
        loadByIds: async () => [],
        upsert: async () => {
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
      observingId: 'session-a',
      sessionId: 'session-a',
      kind: 'session',
      snapshotId: 'snapshot-0',
      snapshotIds: ['snapshot-0'],
      observingEpoch: 0,
      title: 'Existing title',
      summary: 'Existing summary',
      snapshots: [
        { extractions: [], contextRefs: [], openQuestions: [], nextSteps: [], extractionDelta: { before: [], after: [] } },
      ],
      references: ['turn:existing'],
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

test('snapshot extraction state rewrite updates and deletes extraction rows', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const rows = [];
  const deleted = [];
  const client = {
    extractionTable: {
      loadByIds: async ({ ids }) => ids.map((id) => ({
        ...storedExtraction(id),
        text: `${id} old text`,
        createdAt: '2024-01-01T00:00:00Z',
      })),
      delete: async ({ ids }) => {
        deleted.push(...ids);
        return { deleted: ids.length };
      },
      upsert: async ({ rows: next }) => rows.push(...next),
    },
  };
  const state = applyExtractionChanges([
    { id: 'obs-a', text: 'obs-a old text', context: 'old context', anchors: ['Fact: old career'], category: 'Fact', references: ['turn:1'] },
    { id: 'obs-b', text: 'obs-b old text', category: 'Fact', references: ['turn:2'] },
  ], {
    title: 'T',
    threadMemory: 'S',
    extractions: [
      { id: 'obs-a', text: 'updated career memory', context: 'updated context', anchors: ['Decision: career plan'], category: 'Decision', references: ['turn:2'] },
      { text: 'new painting memory', context: 'new context', anchors: ['Preference: painting'], category: 'Preference', references: ['turn:3'] },
    ],
    openQuestions: [],
    nextSteps: [],
    contextRefs: [],
  });
  await applyExtractionTableChanges(client, {
    extractions: state.extractions,
    contextRefs: [],
    extractionChanges: state.extractionChanges,
  }, 'turn:12');

  assert.deepEqual(deleted.sort(), ['obs-b']);
  assert.equal(rows.length, 2);
  const updatedRow = rows.find((row) => row.id === 'obs-a');
  const addedRow = rows.find((row) => row.text === 'new painting memory');
  assert.equal(updatedRow.category, 'decision');
  assert.equal(updatedRow.context, 'updated context');
  assert.deepEqual(updatedRow.anchors, ['Decision: career plan']);
  assert.deepEqual(updatedRow.references, ['turn:2']);
  assert.equal(addedRow.category, 'preference');
  assert.equal(addedRow.context, 'new context');
  assert.deepEqual(addedRow.anchors, ['Preference: painting']);
  assert.deepEqual(addedRow.references, ['turn:3']);
});

test('extraction state rewrite computes update add and delete changes', () => {
  const current = [
    { id: 'obs-a', text: 'old career memory', category: 'Fact', references: ['turn:1'] },
    { id: 'obs-b', text: 'old low value memory', category: 'Fact', references: ['turn:2'] },
  ];

  const result = applyExtractionChanges(current, {
    title: 'T',
    threadMemory: 'S',
    extractions: [
      { id: 'obs-a', text: 'updated career memory', category: 'Decision', references: ['turn:1', 'turn:3'] },
      { text: 'new painting memory', category: 'Preference', references: ['turn:4'] },
    ],
    openQuestions: [],
    nextSteps: [],
    contextRefs: [],
  });

  assert.deepEqual(result.extractionChanges.map((change) => change.type), ['update', 'add', 'delete']);
  assert.equal(result.extractions[0].id, 'obs-a');
  assert.equal(result.extractions[0].category, 'Decision');
  assert.deepEqual(result.extractions[0].references, ['turn:1', 'turn:3']);
  assert.equal(result.extractions[1].category, 'Preference');
  assert.match(result.extractions[1].id, /^[a-f0-9]{24}$/);
});

test('extraction state rewrite rejects unknown and duplicate ids', () => {
  const current = [{ id: 'obs-a', text: 'A', category: 'Fact', references: ['turn:1'] }];

  assert.throws(
    () => applyExtractionChanges(current, {
      title: 'T',
      threadMemory: 'S',
      extractions: [{ id: 'missing', text: 'updated', category: 'Fact', references: ['turn:1'] }],
      openQuestions: [],
      nextSteps: [],
      contextRefs: [],
    }),
    /unknown extraction id/i,
  );

  assert.throws(
    () => applyExtractionChanges(current, {
      title: 'T',
      threadMemory: 'S',
      extractions: [
        { id: 'obs-a', text: 'updated', category: 'Fact', references: ['turn:1'] },
        { id: 'obs-a', text: 'duplicate', category: 'Fact', references: ['turn:1'] },
      ],
      openQuestions: [],
      nextSteps: [],
      contextRefs: [],
    }),
    /duplicate extraction id/i,
  );
});

test('extraction extraction validation rejects invalid category', async () => {
  const { __testing: extractionTesting } = await import('../dist/observer/extraction-extraction.js');
  assert.throws(
    () => extractionTesting.validateExtraction({
      extractions: [{ text: 'Caroline joined a support group.', category: 'Goal', references: ['turn:1'] }],
    }),
    /invalid extraction category/i,
  );
});

test('extraction extraction validation rejects empty text', async () => {
  const { __testing: extractionTesting } = await import('../dist/observer/extraction-extraction.js');
  assert.throws(
    () => extractionTesting.validateExtraction({
      extractions: [{ text: ' ', category: 'Fact', references: ['turn:1'] }],
    }),
    /text must be a non-empty string/i,
  );
});

test('extraction extraction validation rejects missing references', async () => {
  const { __testing: extractionTesting } = await import('../dist/observer/extraction-extraction.js');
  assert.throws(
    () => extractionTesting.validateExtraction({
      extractions: [{ text: 'Caroline joined a support group.', category: 'Fact', references: [] }],
    }),
    /references must include at least one reference/i,
  );
});

test('extraction extraction prompt can include a domain prompt supplement', async () => {
  const { __testing: extractionTesting } = await import('../dist/observer/extraction-extraction.js');
  const rendered = extractionTesting.renderExtractionPrompt({
    inputJson: JSON.stringify({ turns: [] }),
    domainPrompt: 'Category guide:\n- `Fact`: concrete answerable detail.',
  });

  assert.match(rendered.system, /domain-specific extraction guidance/i);
  assert.match(rendered.system, /Category guide/);
  assert.match(rendered.system, /concrete answerable detail/);
  assert.match(rendered.prompt, /"turns":\[\]/);
});

test('extraction extraction input includes recent context turns', async () => {
  const { __testing: extractionTesting } = await import('../dist/observer/extraction-extraction.js');
  const turn = extractionTesting.toExtractionTurn({
    turnId: 'turn:4',
    createdAt: '2026-01-01T00:00:04.000Z',
    updatedAt: '2026-01-01T00:00:04.000Z',
    sessionId: 'group-a',
    agent: 'agent-a',
    observer: 'default-observer',
    prompt: 'I am off to research that.',
    response: 'Recorded.',
    summary: 'research note',
    recentContext: [
      { turnId: 'turn:1', updatedAt: '2026-01-01T00:00:01.000Z', prompt: 'What career options?', response: 'Counseling.' },
      { turnId: 'turn:2', updatedAt: '2026-01-01T00:00:02.000Z', prompt: 'Any education plans?', response: 'Continue education.' },
    ],
  });

  assert.deepEqual(turn.recentContext.map((contextTurn) => contextTurn.turnId), ['turn:1', 'turn:2']);
  assert.equal(turn.recentContext[1].response, 'Continue education.');
  assert.equal(turn.prompt, 'I am off to research that.');
});

test('extraction review validation requires every new extraction to be reviewed', async () => {
  const { __testing: reviewTesting } = await import('../dist/observer/extraction-review.js');
  assert.throws(
    () => reviewTesting.validateReview({
      newExtractions: [storedExtraction('obs-1')],
      candidateExtractions: [],
    }, {
      removeExtractionIds: [],
      reviewedExtractionIds: [],
    }),
    /not reviewed/i,
  );
});

test('extraction review validation rejects unknown removals', async () => {
  const { __testing: reviewTesting } = await import('../dist/observer/extraction-review.js');
  assert.throws(
    () => reviewTesting.validateReview({
      newExtractions: [storedExtraction('obs-1')],
      candidateExtractions: [],
    }, {
      removeExtractionIds: ['obs-missing'],
      reviewedExtractionIds: ['obs-1'],
    }),
    /unknown extraction id/i,
  );
});

test('thread preparation validation rejects duplicate extraction coverage', async () => {
  const { __testing: preparationTesting } = await import('../dist/observer/thread-preparation.js');
  const input = {
    reviewedExtractions: [storedExtraction('obs-1'), storedExtraction('obs-2')],
    activeThreads: [{ threadId: 'thread-1', title: 'Thread one' }],
  };
  assert.throws(
    () => preparationTesting.validateThreadPreparation(input, {
      workItems: [{
        extractionIds: ['obs-1'],
        targetThreadId: 'thread-1',
        rationale: 'same topic',
      }],
      unthreadedExtractionIds: ['obs-1', 'obs-2'],
    }),
    /exactly once/i,
  );
});

test('thread preparation validation rejects single-extraction new threads', async () => {
  const { __testing: preparationTesting } = await import('../dist/observer/thread-preparation.js');
  const input = {
    reviewedExtractions: [storedExtraction('obs-1')],
    activeThreads: [],
  };
  assert.throws(
    () => preparationTesting.validateThreadPreparation(input, {
      workItems: [{
        extractionIds: ['obs-1'],
        newThreadTitle: 'Caroline support group',
        rationale: 'new durable subject',
      }],
      unthreadedExtractionIds: [],
    }),
    /at least two/i,
  );
});

test('thread preparation validation rejects unknown target threads', async () => {
  const { __testing: preparationTesting } = await import('../dist/observer/thread-preparation.js');
  const input = {
    reviewedExtractions: [storedExtraction('obs-1')],
    activeThreads: [{ threadId: 'thread-1', title: 'Thread one' }],
  };
  assert.throws(
    () => preparationTesting.validateThreadPreparation(input, {
      workItems: [{
        extractionIds: ['obs-1'],
        targetThreadId: 'thread-missing',
        rationale: 'same topic',
      }],
      unthreadedExtractionIds: [],
    }),
    /unknown targetThreadId/i,
  );
});

test('thread preparation model validation failure falls back to unthreaded extractions', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeOpenAiObserverConfig(configPath);

  const { __testing: preparationTesting } = await import('../dist/observer/thread-preparation.js');
  const input = {
    reviewedExtractions: [storedExtraction('obs-1'), storedExtraction('obs-2')],
    activeThreads: [],
    candidateMemories: [{ memoryId: 'extraction:candidate-1', title: 'Candidate', summary: 'Candidate' }],
  };

  const result = await preparationTesting.prepareThreadsWithModel(input, {
    model: async () => ({
      type: 'final',
      text: JSON.stringify({
        workItems: [{
          extractionIds: ['candidate-1'],
          newThreadTitle: 'Candidate thread',
          rationale: 'mistaken candidate id',
        }],
        unthreadedExtractionIds: ['obs-1', 'obs-2'],
      }),
    }),
  });

  assert.deepEqual(result, {
    workItems: [],
    unthreadedExtractionIds: ['obs-1', 'obs-2'],
  });
});

test('buildExtraction surfaces extraction write failures and leaves work pending', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const threads = [
    {
      sessionId: 'session-a',
      snapshotId: 'snapshot-1',
      snapshotIds: ['snapshot-0', 'snapshot-1'],
      observingEpoch: 7,
      title: 'Title',
      summary: 'Summary',
      snapshots: [
        {
          extractions: [],
          contextRefs: [],
          openQuestions: [],
          nextSteps: [],
          extractionChanges: [],
        },
        {
          extractions: [{ id: 'memory-1', text: 'remember this', category: 'Fact', references: ['session:existing'], updatedMemory: null }],
          contextRefs: [],
          openQuestions: [],
          nextSteps: [],
          extractionChanges: [{
              type: 'update',
              extractionId: 'memory-1',
              text: 'remember this',
              category: 'Fact',
              reason: 'refreshes the existing extraction wording',
            }],
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
    () => updateTesting.buildExtraction({
      sessionTable: {
        update: async ({ snapshots }) => snapshots,
      },
      extractionTable: {
        delete: async () => ({ deleted: 0 }),
        loadByIds: async () => [],
        upsert: async () => {
          semanticUpserts += 1;
          throw new Error('extraction write failed');
        },
      },
    }, threads),
    /extraction write failed/,
  );

  assert.equal(semanticUpserts, 1);
  assert.deepEqual(getPendingIndex(threads[0]), { start: 1, end: 1 });
});

test('gateway validation accepts session fragments', () => {
  const longContent = [
    'Caroline described attending the LGBTQ support group yesterday and finding it powerful.',
    'She said the transgender stories were inspiring and that she felt happy and thankful for the support.',
    'Melanie asked what the group had done for Caroline, which was answered in a later turn.',
    'This content needs to remain complete because the observer uses it as selected session material.',
  ].join(' ');
  const result = observingGatewayTesting.validateGatewayResultForTests(
    [{
      threadId: 'thread-1',
      kind: 'subject',
      title: 'Caroline counseling and mental-health career plans',
      summary: 'Caroline is exploring counseling and mental-health work.',
    }],
    [{ turnId: 'turn:1', text: 'Caroline mentions career plans.' }],
    {
      sessionFragments: [{
        threadId: 'thread-1',
        turnIds: ['turn:1'],
        content: longContent,
        reason: 'This content fits the existing career planning thread.',
      }],
    },
  );

  assert.deepEqual(result.sessionFragments, [{
    threadId: 'thread-1',
    turnIds: ['turn:1'],
    content: longContent,
    reason: 'This content fits the existing career planning thread.',
  }]);
  assert.ok(result.sessionFragments[0].content.length > 220);
});

test('gateway system prompt injects chat session thread definition only', () => {
  const system = observingGatewayTesting.buildGatewaySystemPromptForTests('chat');

  assert.match(system, /Observing thread definition/);
  assert.match(system, /tracks one coherent subject that can develop over time/);
  assert.match(system, /narrower than the whole conversation and more stable than a single message/);
  assert.match(system, /updates, answers, clarifies, corrects, supports, or directly continues/);
  assert.doesNotMatch(system, /Chat category guide/);
  assert.doesNotMatch(system, /Category selection/);
  assert.doesNotMatch(system, /Chat filtering/);
});

test('gateway validation rejects session fragments without reason', () => {
  assert.throws(
    () => observingGatewayTesting.validateGatewayResultForTests(
      [{
        threadId: 'thread-1',
        kind: 'subject',
        title: 'Caroline counseling and mental-health career plans',
        summary: 'Caroline is exploring counseling and mental-health work.',
      }],
      [{ turnId: 'turn:1', text: 'Caroline mentions career plans.' }],
      {
        sessionFragments: [{
          threadId: 'thread-1',
          turnIds: ['turn:1'],
          content: 'Caroline mentions career plans.',
        }],
      },
    ),
    /empty reason/i,
  );
});

test('gateway validation rejects session fragments with unknown threads', () => {
  assert.throws(
    () => observingGatewayTesting.validateGatewayResultForTests(
      [{
        threadId: 'thread-1',
        kind: 'subject',
        title: 'Caroline counseling and mental-health career plans',
        summary: 'Caroline is exploring counseling and mental-health work.',
      }],
      [{ turnId: 'turn:1', text: 'Caroline mentions career plans.' }],
      {
        sessionFragments: [{
          threadId: 'missing-thread',
          turnIds: ['turn:1'],
          content: 'Caroline mentions career plans.',
          reason: 'This content fits a missing thread.',
        }],
      },
    ),
    /unknown threadId/i,
  );
});

test('observer validation derives extractions from thread memory', () => {
  const result = observingGatewayTesting.validateObserveResultForTests(
    threadMemoryDocument([
      '<!-- refs: [turn:13] -->',
      '[Entity] Melanie',
      '[Fact] lake sunrise',
      '[Context] Caroline asked whether Melanie painted the lake sunrise herself.',
      '[Extraction] Melanie painted a lake sunrise in 2022.',
      '',
      '----',
      '',
      '<!-- refs: [turn:13] -->',
      '[Entity] lake painting',
      '[Fact] special painting',
      '[Extraction] The lake sunrise painting is special to Melanie.',
    ].join('\n'), {
      title: 'Melanie Painting',
      summary: 'Melanie painted a lake sunrise in 2022.',
    }),
    {
      observingContent: {
        title: 'Painting',
        summary: '',
        extractions: [],
        openQuestions: [],
        nextSteps: [],
      },
      turns: [{
        turnId: 'turn:13',
        summary: 'Melanie says she painted the lake sunrise in 2022, described as last year relative to 8 May 2023.',
      }],
    },
  );

  assert.equal(result.title, 'Melanie Painting');
  assert.equal(result.summary, 'Melanie painted a lake sunrise in 2022.');
  assert.deepEqual(result.contextRefs, [{
    turnId: 'turn:13',
    summary: 'Summary: Melanie says she painted the lake sunrise in 2022, described as last year relative to 8 May 2023.',
  }]);
  assert.equal(result.threadMemory, threadMemoryDocument([
      '<!-- refs: [turn:13] -->',
      '[Entity] Melanie',
    '[Fact] lake sunrise',
    '[Context] Caroline asked whether Melanie painted the lake sunrise herself.',
    '[Extraction] Melanie painted a lake sunrise in 2022.',
    '',
    '----',
    '',
      '<!-- refs: [turn:13] -->',
      '[Entity] lake painting',
      '[Fact] special painting',
      '[Extraction] The lake sunrise painting is special to Melanie.',
  ].join('\n'), {
    title: 'Melanie Painting',
    summary: 'Melanie painted a lake sunrise in 2022.',
  }));
  assert.deepEqual(result.extractions, [{
    text: 'Melanie painted a lake sunrise in 2022.',
    context: 'Caroline asked whether Melanie painted the lake sunrise herself.',
    anchors: ['Entity: Melanie', 'Fact: lake sunrise'],
    category: 'Entity',
    references: ['turn:13'],
  }, {
    text: 'The lake sunrise painting is special to Melanie.',
    context: null,
    anchors: ['Entity: lake painting', 'Fact: special painting'],
    category: 'Entity',
    references: ['turn:13'],
  }]);
});

test('observer validation rejects thread memory units without extraction marker', () => {
  assert.throws(
    () => observingGatewayTesting.validateObserveResultForTests(
      threadMemoryDocument([
        '<!-- refs: [turn:13] -->',
        '[Entity] Melanie',
        '[Context] Caroline asked whether Melanie painted the lake sunrise herself.',
        'Melanie painted a lake sunrise in 2022.',
      ].join('\n')),
      {
        observingContent: {
          title: 'Painting',
          summary: '',
          extractions: [],
          openQuestions: [],
          nextSteps: [],
        },
        turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
      },
    ),
    /must include \[Extraction\]/i,
  );
});

test('observer validation rejects legacy uppercase context and extraction markers', () => {
  assert.throws(
    () => observingGatewayTesting.validateObserveResultForTests(
      threadMemoryDocument([
        '<!-- refs: [turn:13] -->',
        '[Entity] Melanie',
        '[CONTEXT] Caroline asked whether Melanie painted the lake sunrise herself.',
        '[EXTRACTION] Melanie painted a lake sunrise in 2022.',
      ].join('\n')),
      {
        observingContent: {
          title: 'Painting',
          summary: '',
          extractions: [],
          openQuestions: [],
          nextSteps: [],
        },
        turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
      },
    ),
    /invalid thread memory anchor: CONTEXT/i,
  );
});

test('observer validation keeps independent refs per thread memory unit', () => {
  const result = observingGatewayTesting.validateObserveResultForTests(
    threadMemoryDocument([
      '<!-- refs: [turn:13] -->',
      '[Entity] Melanie',
      '[Fact] lake sunrise',
      '[Extraction] Melanie painted a lake sunrise in 2022.',
      '',
      '----',
      '',
      '<!-- refs: [turn:14, turn:15] -->',
      '[Entity] Caroline',
      '[Decision] counseling work',
      '[Extraction] Caroline plans to explore counseling work.',
    ].join('\n')),
    {
      observingContent: {
        title: 'Session',
        summary: '',
        extractions: [],
        openQuestions: [],
        nextSteps: [],
      },
      turns: [
        { turnId: 'turn:13', summary: 'Melanie discussed painting.' },
        { turnId: 'turn:14', summary: 'Caroline discussed education.' },
        { turnId: 'turn:15', summary: 'Caroline discussed counseling.' },
      ],
    },
  );

  assert.deepEqual(result.extractions.map((extraction) => extraction.references), [
    ['turn:13'],
    ['turn:14', 'turn:15'],
  ]);
});

test('observer validation accepts markdown fenced thread memory', () => {
  const result = observingGatewayTesting.validateObserveResultForTests(
    [
      '```markdown',
      '# Painting Memory',
      '',
      '## Summary',
      'Melanie discussed a lake sunrise painting.',
      '',
      '## Extractions',
      '<!-- refs: [turn:13] -->',
      '[Entity] Melanie',
      '[Extraction] Melanie painted a lake sunrise in 2022.',
      '```',
    ].join('\n'),
    {
      observingContent: {
        title: 'Painting',
        summary: '',
        extractions: [],
        openQuestions: [],
        nextSteps: [],
      },
      turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
    },
  );

  assert.equal(result.threadMemory, threadMemoryDocument(
    '<!-- refs: [turn:13] -->\n[Entity] Melanie\n[Extraction] Melanie painted a lake sunrise in 2022.',
    { title: 'Painting Memory', summary: 'Melanie discussed a lake sunrise painting.' },
  ));
  assert.deepEqual(result.extractions[0].references, ['turn:13']);
});

test('observer validation rejects thread memory units without metadata', () => {
  assert.throws(
    () => observingGatewayTesting.validateObserveResultForTests(
      threadMemoryDocument('[Fact]\nMelanie painted a lake sunrise in 2022.'),
      {
        observingContent: {
          title: 'Painting',
          summary: '',
          extractions: [],
          openQuestions: [],
          nextSteps: [],
        },
        turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
      },
    ),
    /must start with metadata comment/i,
  );
});

test('observer validation rejects legacy category metadata', () => {
  assert.throws(
    () => observingGatewayTesting.validateObserveResultForTests(
      threadMemoryDocument('<!-- categories: [Fact]; refs: [turn:13] -->\n[Entity] Melanie\n[Extraction] Melanie painted a lake sunrise in 2022.'),
      {
        observingContent: {
          title: 'Painting',
          summary: '',
          extractions: [],
          openQuestions: [],
          nextSteps: [],
        },
        turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
      },
    ),
    /must start with metadata comment/i,
  );
});

test('observer validation rejects thread memory units without anchors', () => {
  assert.throws(
    () => observingGatewayTesting.validateObserveResultForTests(
      threadMemoryDocument('<!-- refs: [turn:13] -->\n[Extraction] Melanie painted a lake sunrise in 2022.'),
      {
        observingContent: {
          title: 'Painting',
          summary: '',
          extractions: [],
          openQuestions: [],
          nextSteps: [],
        },
        turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
      },
    ),
    /must include at least one anchor/i,
  );
});

test('observer validation rejects unknown thread memory refs', () => {
  assert.throws(
    () => observingGatewayTesting.validateObserveResultForTests(
      threadMemoryDocument('<!-- refs: [session:missing] -->\n[Entity] Melanie\n[Extraction] Melanie painted a lake sunrise in 2022.'),
      {
        observingContent: {
          title: 'Painting',
          summary: '',
          extractions: [],
          openQuestions: [],
          nextSteps: [],
        },
        turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
      },
    ),
    /unknown ref: session:missing/i,
  );
});

test('observer validation rejects thread memory units without refs metadata', () => {
  assert.throws(
    () => observingGatewayTesting.validateObserveResultForTests(
      threadMemoryDocument('<!-- refs: [] -->\n[Entity] Melanie\n[Extraction] Melanie painted a lake sunrise in 2022.'),
      {
        observingContent: {
          title: 'Painting',
          summary: '',
          extractions: [],
          openQuestions: [],
          nextSteps: [],
        },
        turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
      },
    ),
    /metadata refs must include at least one reference/i,
  );
});

test('observer validation rejects JSON output', () => {
  assert.throws(
    () => observingGatewayTesting.validateObserveResultForTests(JSON.stringify({
      title: 'Painting',
      threadMemory: '<!-- refs: [turn:13] -->\n[Entity] Melanie\n[Extraction] Melanie painted a lake sunrise.',
      openQuestions: [],
      nextSteps: [],
      contextRefs: [],
    })),
    /must return thread memory Markdown, not JSON/i,
  );
});

test('observer validation rejects summaries longer than 500 words', () => {
  assert.throws(
    () => observingGatewayTesting.validateObserveResultForTests(
      threadMemoryDocument(
        '<!-- refs: [turn:13] -->\n[Entity] Melanie\n[Fact] painting\n[Extraction] Melanie painted a lake sunrise in 2022.',
        { summary: Array.from({ length: 501 }, (_, index) => `word${index}`).join(' ') },
      ),
      {
        observingContent: { title: 'Painting', summary: '', extractions: [], openQuestions: [], nextSteps: [] },
        turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
      },
    ),
    /summary must be 500 words or fewer/i,
  );
});

test('observer validation rejects invalid thread memory anchors', () => {
  assert.throws(
    () => observingGatewayTesting.validateObserveResultForTests(
      threadMemoryDocument('<!-- refs: [turn:13] -->\n[Goal] painting\n[Extraction] Melanie wants to paint more.'),
      {
        observingContent: {
          title: 'Painting',
          summary: '',
          extractions: [],
          openQuestions: [],
          nextSteps: [],
        },
        turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
      },
    ),
    /invalid thread memory anchor/i,
  );
});

test('observer validation rejects more than three thread memory anchors', () => {
  assert.throws(
    () => observingGatewayTesting.validateObserveResultForTests(
      threadMemoryDocument('<!-- refs: [turn:13] -->\n[Entity] Melanie\n[Fact] painting\n[Decision] paint more\n[Preference] creative outlet\n[Extraction] Melanie wants to paint more.'),
      {
        observingContent: {
          title: 'Painting',
          summary: '',
          extractions: [],
          openQuestions: [],
          nextSteps: [],
        },
        turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
      },
    ),
    /cannot include more than three anchors/i,
  );
});

test('observer validation rejects long thread memory anchor phrases', () => {
  assert.throws(
    () => observingGatewayTesting.validateObserveResultForTests(
      threadMemoryDocument('<!-- refs: [turn:13] -->\n[Fact] this anchor phrase has too many words\n[Extraction] Melanie wants to paint more.'),
      {
        observingContent: {
          title: 'Painting',
          summary: '',
          extractions: [],
          openQuestions: [],
          nextSteps: [],
        },
        turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
      },
    ),
    /anchor phrase must contain 1-5 words/i,
  );
});

test('thread session memory-get expands visible raw turns only', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeOpenAiObserverConfig(configPath);
  const tracePath = path.join(dir, 'thread-session-trace.jsonl');
  process.env.MUNINN_THREAD_OBSERVING_TRACE_FILE = tracePath;
  t.after(() => {
    delete process.env.MUNINN_THREAD_OBSERVING_TRACE_FILE;
  });

  const requests = [];
  const result = await observingGatewayModule.observeThread({
    observingContent: {
      title: 'Caroline support group',
      summary: 'Caroline discussed a support group.',
      threadMemory: threadMemoryDocument('', {
        title: 'Caroline support group',
        summary: 'Caroline discussed a support group.',
      }),
      extractions: [{ id: 'obs-1', text: 'Existing support extraction.', category: 'Fact', references: ['turn:1'] }],
      openQuestions: [],
      nextSteps: [],
    },
    turns: [{
      turnId: 'turn:1',
      prompt: 'DATE: 8 May 2023\nDIALOGUE:\nCaroline said she went to an LGBTQ support group yesterday.',
      response: '[imported dialogue event; no assistant response]',
    }],
  }, undefined, {
    memories: {
      get: async (memoryId) => ({
        memoryId,
        kind: memoryId.startsWith('extraction:') ? 'extraction' : memoryId.startsWith('session:') ? 'session' : 'session',
        title: memoryId,
        text: `detail for ${memoryId}`,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        detail: `detail for ${memoryId}`,
      }),
    },
    model: async (_task, request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          type: 'tool_calls',
          toolCalls: [{
            id: 'call-1',
            name: 'memory-get',
            arguments: {
              memoryIds: ['turn:1', 'extraction:obs-1', 'turn:1', 'session:missing'],
            },
          }],
        };
      }
      return {
        type: 'final',
        text: threadMemoryDocument(
          '<!-- refs: [turn:1] -->\n[Entity] Caroline\n[Fact] support group\n[Extraction] Caroline attended an LGBTQ support group on 7 May 2023.',
          { title: 'Caroline Support Group', summary: 'Caroline attended an LGBTQ support group.' },
        ),
      };
    },
  });

  assert.equal(requests[0].tools[0].name, 'memory-get');
  assert.match(requests[0].tools[0].description, /Get visible raw turn details/);
  assert.match(requests[0].tools[0].description, /verify context/);
  assert.match(requests[0].tools[0].description, /update memories/);
  assert.match(requests[0].tools[0].parameters.properties.memoryIds.description, /Visible turns\[\]\.turnId values/);
  const firstUserMessage = requests[0].messages.find((message) => message.role === 'user');
  assert.ok(firstUserMessage);
  assert.match(firstUserMessage.content, /# Caroline support group/);
  assert.doesNotMatch(firstUserMessage.content, /existingThreadMemory/);
  assert.match(firstUserMessage.content, /"newTurns"/);
  assert.match(firstUserMessage.content, /"prompt"/);
  assert.match(firstUserMessage.content, /"response"/);
  assert.doesNotMatch(firstUserMessage.content, /"fragments"/);
  assert.doesNotMatch(firstUserMessage.content, /"content"/);
  assert.doesNotMatch(firstUserMessage.content, /"sourceRefs"/);
  assert.doesNotMatch(firstUserMessage.content, /"excerpt"/);
  assert.doesNotMatch(firstUserMessage.content, /allowedMemoryIds/);
  const toolMessage = requests[1].messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage);
  const toolPayload = JSON.parse(toolMessage.content);
  assert.match(toolPayload.memories[0].content, /detail for turn:1/);
  assert.equal(toolPayload.memories[1].error, 'memory id is not allowlisted');
  assert.equal(toolPayload.memories[2].error, 'memory id is not allowlisted');
  assert.equal(result.extractions[0].text, 'Caroline attended an LGBTQ support group on 7 May 2023.');
  assert.deepEqual(result.extractions[0].references, ['turn:1']);
  const trace = JSON.parse(await readFile(tracePath, 'utf8'));
  assert.equal(trace.toolCalls[0].name, 'memory-get');
  assert.equal(trace.extractions[0].text, 'Caroline attended an LGBTQ support group on 7 May 2023.');
  assert.match(trace.finalText, /# Caroline Support Group/);
  assert.match(trace.finalText, /Caroline attended an LGBTQ support group on 7 May 2023/);
  assert.equal(trace.input.allowedMemoryIds, undefined);
  assert.equal(trace.input.threadMemoryId, undefined);
});

test('thread session traces invalid markdown attempts without JSON retry instructions', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeOpenAiObserverConfig(configPath);
  const tracePath = path.join(dir, 'thread-session-invalid-trace.jsonl');
  process.env.MUNINN_THREAD_OBSERVING_TRACE_FILE = tracePath;
  t.after(() => {
    delete process.env.MUNINN_THREAD_OBSERVING_TRACE_FILE;
  });

  const requests = [];
  const result = await observingGatewayModule.observeThread({
    observingContent: {
      title: 'Caroline support group',
      summary: '',
      extractions: [],
      openQuestions: [],
      nextSteps: [],
    },
    turns: [{
      turnId: 'turn:1',
      prompt: 'DATE: 8 May 2023\nDIALOGUE:\nCaroline said she went to an LGBTQ support group yesterday.',
      response: null,
    }],
  }, undefined, {
    model: async (_task, request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          type: 'final',
          text: '{"threadMemory":"<!-- refs: [turn:1] -->\\n[Entity] Caroline\\n[Extraction] Caroline attended an LGBTQ support group."}',
        };
      }
      return {
        type: 'final',
        text: threadMemoryDocument(
          '<!-- refs: [turn:1] -->\n[Entity] Caroline\n[Fact] support group\n[Extraction] Caroline attended an LGBTQ support group on 7 May 2023.',
          { title: 'Caroline Support Group', summary: 'Caroline attended an LGBTQ support group.' },
        ),
      };
    },
  });

  assert.equal(result.extractions[0].text, 'Caroline attended an LGBTQ support group on 7 May 2023.');
  assert.equal(requests.length, 2);
  const retryUserMessage = requests[1].messages.find((message) => message.role === 'user');
  assert.ok(retryUserMessage);
  assert.match(retryUserMessage.content, /Previous output was invalid/);
  assert.match(retryUserMessage.content, /Return only valid thread memory Markdown/);
  assert.doesNotMatch(retryUserMessage.content, /Return one JSON object only/);

  const traceLines = (await readFile(tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(traceLines.length, 2);
  assert.equal(traceLines[0].attempt, 1);
  assert.match(traceLines[0].rawText, /^\{"threadMemory"/);
  assert.match(traceLines[0].validationError, /must return thread memory Markdown, not JSON/);
  assert.equal(traceLines[1].attempt, 2);
  assert.match(traceLines[1].finalText, /# Caroline Support Group/);
});

test('thread session omits default session summary from memory input', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeOpenAiObserverConfig(configPath);

  const requests = [];
  await observingGatewayModule.observeThread({
    observingContent: {
      title: 'Session locomo',
      summary: 'Default session thread for session locomo:conv-26:session_1.',
      extractions: [],
      openQuestions: [],
      nextSteps: [],
    },
    turns: [{
      turnId: 'turn:1',
      prompt: 'DATE: 8 May 2023\nDIALOGUE:\nCaroline said she felt accepted.',
      response: null,
    }],
  }, undefined, {
    model: async (_task, request) => {
      requests.push(request);
      return {
        type: 'final',
        text: threadMemoryDocument(
          '<!-- refs: [turn:1] -->\n[Entity] Caroline\n[Fact] felt accepted\n[Extraction] Caroline felt accepted on 8 May 2023.',
          { title: 'Session Locomo', summary: 'Caroline felt accepted.' },
        ),
      };
    },
  });

  const firstUserMessage = requests[0].messages.find((message) => message.role === 'user');
  assert.ok(firstUserMessage);
  assert.match(firstUserMessage.content, /"memory": ""/);
  assert.doesNotMatch(firstUserMessage.content, /Default session thread/);
  assert.doesNotMatch(firstUserMessage.content, /existingThreadMemory/);
});

test('thread session inlines chat memory categories', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeOpenAiObserverConfig(configPath);

  const requests = [];
  await observingGatewayModule.observeThread({
    observingContent: {
      title: 'Caroline support group',
      summary: 'Caroline discussed a support group.',
      extractions: [],
      openQuestions: [],
      nextSteps: [],
    },
    turns: [{
      turnId: 'turn:1',
      prompt: 'Melanie said that was cool.',
      response: null,
    }],
  }, undefined, {
    model: async (_task, request) => {
      requests.push(request);
      return {
        type: 'final',
        text: threadMemoryDocument(
          '<!-- refs: [turn:1] -->\n[Entity] Melanie\n[Fact] brief reaction\n[Extraction] Melanie said that was cool.',
          { title: 'Caroline Support Group', summary: 'Melanie reacted to Caroline.' },
        ),
      };
    },
  });

  assert.match(requests[0].messages[0].content, /Memory anchors/);
  assert.match(requests[0].messages[0].content, /`Fact`: Concrete information that happened, exists, was described, or is currently true/);
  assert.match(requests[0].messages[0].content, /stable or recurring like/);
  assert.doesNotMatch(requests[0].messages[0].content, /Domain guidance/);
  assert.doesNotMatch(requests[0].messages[0].content, /domain_prompt/);
  assert.doesNotMatch(requests[0].messages[0].content, /Extraction granularity/);
  assert.doesNotMatch(requests[0].messages[0].content, /Chat filtering/);
  assert.doesNotMatch(requests[0].messages[0].content, /Use `update` plus `add`/);
});

test('session snapshots keep complete cumulative context refs', () => {
  const thread = createObservingThread(
    'default-observer',
    'Career',
    'Career thread',
    [],
    1,
    '2026-01-01T00:00:00.000Z',
  );
  const result = (summary, turnId) => ({
    title: 'Career',
    threadMemory: '',
    extractions: [],
    openQuestions: [],
    nextSteps: [],
    contextRefs: [{ turnId, summary }],
  });

  for (let index = 1; index <= 10; index += 1) {
    threadTesting.applyObserveResultForTests(
      thread,
      result(`slice ${index}`, `turn:${index}`),
      index,
      applyExtractionChanges,
      '2026-01-01T00:00:00.000Z',
    );
  }

  const latest = thread.snapshots[thread.snapshots.length - 1];
  assert.deepEqual(latest.contextRefs.map((reference) => reference.turnId), [
    'turn:1',
    'turn:2',
    'turn:3',
    'turn:4',
    'turn:5',
    'turn:6',
    'turn:7',
    'turn:8',
    'turn:9',
    'turn:10',
  ]);
  assert.deepEqual(thread.references, [
    'turn:1',
    'turn:2',
    'turn:3',
    'turn:4',
    'turn:5',
    'turn:6',
    'turn:7',
    'turn:8',
    'turn:9',
    'turn:10',
  ]);
  assert.deepEqual(toSessionSnapshot(thread).references, thread.references);
});

test('session context refs update duplicate turn summaries without duplicates', () => {
  const thread = createObservingThread(
    'default-observer',
    'Career',
    'Career thread',
    [],
    1,
    '2026-01-01T00:00:00.000Z',
  );
  const observeResult = (summary) => ({
    title: 'Career',
    threadMemory: '',
    extractions: [],
    openQuestions: [],
    nextSteps: [],
    contextRefs: [{ turnId: 'turn:1', summary }],
  });

  threadTesting.applyObserveResultForTests(
    thread,
    observeResult('initial summary'),
    1,
    applyExtractionChanges,
    '2026-01-01T00:00:00.000Z',
  );
  threadTesting.applyObserveResultForTests(
    thread,
    observeResult('updated summary'),
    2,
    applyExtractionChanges,
    '2026-01-01T00:00:01.000Z',
  );

  assert.deepEqual(thread.snapshots.at(-1).contextRefs, [{
    turnId: 'turn:1',
    summary: 'updated summary',
  }]);
  assert.deepEqual(thread.references, ['turn:1']);
});

test('session snapshot persists markdown content with parsed title and summary', () => {
  const thread = createObservingThread(
    'default-observer',
    'Draft title',
    'Draft summary',
    [],
    1,
    '2026-01-01T00:00:00.000Z',
  );
  const markdown = threadMemoryDocument(
    '<!-- refs: [turn:1] -->\n[Entity] Melanie\n[Fact] lake painting\n[Extraction] Melanie painted a lake sunrise in 2022.',
    {
      title: 'Melanie Painting',
      summary: 'Melanie painted a lake sunrise and considers it special.',
    },
  );

  threadTesting.applyObserveResultForTests(
    thread,
    {
      title: 'Melanie Painting',
      summary: 'Melanie painted a lake sunrise and considers it special.',
      threadMemory: markdown,
      extractions: [{
        text: 'Melanie painted a lake sunrise in 2022.',
        category: 'Fact',
        references: ['turn:1'],
      }],
      openQuestions: [],
      nextSteps: [],
      contextRefs: [{ turnId: 'turn:1', summary: 'Melanie discussed a lake sunrise painting.' }],
    },
    1,
    applyExtractionChanges,
    '2026-01-01T00:00:00.000Z',
  );

  const snapshot = toSessionSnapshot(thread);
  assert.equal(snapshot.title, 'Melanie Painting');
  assert.equal(snapshot.summary, 'Melanie painted a lake sunrise and considers it special.');
  assert.equal(snapshot.content, markdown);
  assert.doesNotMatch(snapshot.content, /^\s*\{/);
});

test('observeSessionThread passes raw turns to observer', async () => {
  const now = '2026-01-01T00:00:00.000Z';
  const thread = createObservingThread('default-observer', 'Session locomo', 'Default session thread for session locomo.', [], 1, now, 'session', 'locomo');
  const observedInputs = [];
  const observeThreadImpl = async (input) => {
    observedInputs.push(input);
    return {
      title: 'Painting',
      threadMemory: '<!-- refs: [turn:13] -->\n[Entity] Melanie\n[Fact] lake sunrise\n[Extraction] Melanie painted a lake sunrise in 2022.',
      extractions: [],
      openQuestions: [],
      nextSteps: [],
      contextRefs: [{
        turnId: 'turn:13',
        summary: 'Melanie says she painted the lake sunrise in 2022, described as last year relative to 8 May 2023.',
      }],
    };
  };

  await updateTesting.observeSessionThreadForTests({
    threads: [thread],
    observerName: 'default-observer',
    pendingTurns: [{
      turnId: 'turn:13',
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
    observeThreadImpl,
  });

  assert.deepEqual(observedInputs[0].turns, [{
    turnId: 'turn:13',
    prompt: 'DATE: 1:56 pm on 8 May, 2023\nDIALOGUE:\nMelanie said: "Yeah, I painted that lake sunrise last year!"',
    response: '[imported dialogue event; no assistant response]',
    summary: 'DATE: 1:56 pm on 8 May, 2023\nDIALOGUE:\nMelanie said: "Yeah, I painted that lake sunrise last year!"',
  }]);
  assert.deepEqual(thread.snapshots.at(-1).contextRefs, [{
    turnId: 'turn:13',
    summary: 'Melanie says she painted the lake sunrise in 2022, described as last year relative to 8 May 2023.',
  }]);
});

test('gateway input includes thread kind and prompt plus response turn text', () => {
  const thread = createObservingThread(
    'default-observer',
    'Career',
    'Career thread',
    [],
    1,
    '2026-01-01T00:00:00.000Z',
  );
  thread.snapshots.push({
    extractions: [],
    contextRefs: [
      { turnId: 'turn:10', summary: 'Caroline attended a LGBTQ support group.' },
      { turnId: 'turn:11', summary: 'Caroline is considering counseling work.' },
      { turnId: 'turn:12', summary: 'Melanie encouraged Caroline to pursue counseling.' },
    ],
    openQuestions: [],
    nextSteps: [],
    extractionDelta: { before: [], after: [] },
  });

  const turns = observingGatewayTesting.gatewayTurnsForTests([{
    turnId: 'turn:12',
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
    turnId: 'turn:12',
    text: 'Prompt:\nMelanie encouraged Caroline.\n\nResponse:\nplaceholder',
  });

  const responseOnlyTurns = observingGatewayTesting.gatewayTurnsForTests([{
    turnId: 'turn:13',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessionId: 'locomo',
    agent: 'Melanie',
    observer: 'default-observer',
    summary: 'Melanie talked about camping.',
    prompt: 'Melanie talked about camping.',
    response: 'Caroline researched adoption agencies.',
    observingEpoch: 2,
  }]);
  assert.equal(
    responseOnlyTurns[0].text,
    'Prompt:\nMelanie talked about camping.\n\nResponse:\nCaroline researched adoption agencies.',
  );
});

test('observed turns without observer context refs are not persisted as references', async () => {
  const now = '2026-01-01T00:00:00.000Z';
  const thread = createObservingThread('default-observer', 'Session locomo', 'Default session thread for session locomo.', [], 1, now, 'session', 'locomo');
  const observeThreadImpl = async () => ({
    title: 'Career',
    threadMemory: '',
    extractions: [],
    openQuestions: [],
    nextSteps: [],
    contextRefs: [],
  });

  await updateTesting.observeSessionThreadForTests({
    threads: [thread],
    observerName: 'default-observer',
    pendingTurns: [{
      turnId: 'turn:99',
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
    observeThreadImpl,
  });

  assert.deepEqual(thread.snapshots.at(-1).contextRefs, []);
  assert.deepEqual(thread.references, []);
});

test('raw-turn session only updates the session thread', async () => {
  const now = '2026-01-01T00:00:00.000Z';
  const thread = createObservingThread(
    'default-observer',
    'Session locomo',
    'Default session thread for session locomo.',
    [],
    1,
    now,
    'session',
    'locomo',
  );
  const threads = [thread];
  const observedInputs = [];
  const observeThreadImpl = async (input) => {
    observedInputs.push(input);
    return {
      title: 'Melanie lake sunrise painting and creative outlet',
      threadMemory: '<!-- refs: [turn:12] -->\n[Entity] Melanie\n[Fact] lake painting\n[Extraction] Melanie discusses her lake sunrise painting and painting as a creative outlet.',
      extractions: [],
      openQuestions: [],
      nextSteps: [],
      contextRefs: [{
        turnId: 'turn:12',
        summary: 'Melanie shared a photo of a lake painting.',
      }],
    };
  };

  await updateTesting.observeSessionThreadForTests({
    threads,
    observerName: 'default-observer',
    pendingTurns: [{
      turnId: 'turn:12',
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
    observeThreadImpl,
  });

  assert.equal(threads.length, 1);
  assert.equal(threads[0].kind, 'session');
  assert.equal(observedInputs[0].turns[0].prompt, 'Melanie said: "You would be a great counselor. By the way, take a look at this painting."');
});

test('observeEpoch groups mixed session turns before session', async () => {
  const threads = [];
  const observedInputs = [];
  const observingRows = [];
  const client = {
    sessionTable: {
      insert: async ({ snapshots }) => {
        observingRows.push(...snapshots);
        return snapshots.map((snapshot, index) => ({
          ...snapshot,
          snapshotId: `snapshot-${index + 1}`,
        }));
      },
    },
  };
  const observeThreadImpl = async (input) => {
    observedInputs.push(input);
    return {
      title: input.observingContent.title,
      threadMemory: '',
      extractions: [],
      openQuestions: [],
      nextSteps: [],
      contextRefs: input.turns.map((turn) => ({
        turnId: turn.turnId,
        summary: `${turn.turnId} relevant content`,
      })),
    };
  };

  const groupA1 = makeObservableTurn('session:a1', 2, 'a1');
  const groupB1 = { ...makeObservableTurn('session:b1', 2, 'b1'), sessionId: 'group-b' };
  const groupA2 = makeObservableTurn('session:a2', 2, 'a2');

  const result = await updateTesting.observeEpoch({
    client,
    observerName: 'default-observer',
    activeWindowDays: 3650,
    threads,
    sealedEpoch: {
      epoch: 2,
      turns: [groupA1, groupB1, groupA2],
    },
    observeThreadImpl,
  });

  assert.equal(observedInputs.length, 2);
  assert.deepEqual(observedInputs[0].turns.map((turn) => turn.turnId), ['session:a1', 'session:a2']);
  assert.deepEqual(observedInputs[1].turns.map((turn) => turn.turnId), ['session:b1']);
  assert.deepEqual(threads.map((thread) => thread.sessionId), ['group-a', 'group-b']);
  assert.equal(result.touchedIds.size, 2);
  assert.equal(observingRows.length, 2);
});

test('observeEpoch routes missing sessionId turns to default session thread', async () => {
  const threads = [];
  const observedInputs = [];
  const client = {
    sessionTable: {
      insert: async ({ snapshots }) => snapshots.map((snapshot, index) => ({
        ...snapshot,
        snapshotId: `snapshot-${index + 1}`,
      })),
    },
  };
  const observeThreadImpl = async (input) => {
    observedInputs.push(input);
    return {
      title: input.observingContent.title,
      threadMemory: '',
      extractions: [],
      openQuestions: [],
      nextSteps: [],
      contextRefs: input.turns.map((turn) => ({
        turnId: turn.turnId,
        summary: `${turn.turnId} relevant content`,
      })),
    };
  };

  await updateTesting.observeEpoch({
    client,
    observerName: 'default-observer',
    activeWindowDays: 3650,
    threads,
    sealedEpoch: {
      epoch: 2,
      turns: [
        { ...makeObservableTurn('turn:null-1', 2, 'null-1'), sessionId: null },
        { ...makeObservableTurn('turn:blank-1', 2, 'blank-1'), sessionId: '   ' },
      ],
    },
    observeThreadImpl,
  });

  assert.equal(observedInputs.length, 1);
  assert.deepEqual(observedInputs[0].turns.map((turn) => turn.turnId), ['turn:null-1', 'turn:blank-1']);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].sessionId, '__muninn_default_session__');
});

test('observeSessionThread rejects mixed session turns', async () => {
  const now = '2026-01-01T00:00:00.000Z';
  const thread = createObservingThread('default-observer', 'Session group-a', 'Default session thread for session group-a.', [], 1, now, 'session', 'group-a');
  const observeThreadImpl = async () => {
    throw new Error('observeThreadImpl should not be called for mixed session turns');
  };

  await assert.rejects(
    updateTesting.observeSessionThreadForTests({
      threads: [thread],
      observerName: 'default-observer',
      pendingTurns: [
        makeObservableTurn('session:a1', 2, 'a1'),
        { ...makeObservableTurn('session:b1', 2, 'b1'), sessionId: 'group-b' },
      ],
      observingEpoch: 2,
      observeThreadImpl,
    }),
    /single session/i,
  );
});

test('buildTouchedIndex immediately advances extraction index for touched threads', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  let semanticUpserts = 0;
  const threads = [{
    observingId: 'session-a',
    sessionId: 'session-a',
    kind: 'session',
    snapshotId: 'snapshot-1',
    snapshotIds: ['snapshot-0', 'snapshot-1'],
    observingEpoch: 1,
    title: 'Existing title',
    summary: 'Existing summary',
    snapshots: [
      { extractions: [], contextRefs: [], openQuestions: [], nextSteps: [], extractionChanges: [] },
      {
        extractions: [{ id: 'memory-1', text: 'remember this', category: 'Fact', references: ['turn:existing'], updatedMemory: null }],
        contextRefs: [],
        openQuestions: [],
        nextSteps: [],
        extractionChanges: [{
            type: 'update',
            extractionId: 'memory-1',
            text: 'remember this',
            category: 'Fact',
            reason: 'refreshes the existing extraction wording',
          }],
      },
    ],
    references: ['turn:existing'],
    indexedSnapshotSequence: 0,
    observer: 'default-observer',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  }];

  await updateTesting.buildTouchedIndex({
    sessionTable: {
      update: async ({ snapshots }) => snapshots,
    },
    extractionTable: {
      delete: async () => ({ deleted: 0 }),
      loadByIds: async () => [],
      upsert: async () => {
        semanticUpserts += 1;
      },
    },
  }, threads, new Set(['session-a']));

  assert.equal(semanticUpserts, 1);
  assert.equal(threads[0].indexedSnapshotSequence, 1);
  assert.equal(getPendingIndex(threads[0]), null);
});

test('observer.retryExtraction refreshes the committed checkpoint snapshot after session rows are updated', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const observer = new Observer({
    sessionTable: {
      update: async ({ snapshots }) => snapshots,
      stats: async () => ({
        version: 22,
        fragmentCount: 1,
        rowCount: 1,
      }),
    },
    extractionTable: {
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
    sessionId: 'session-a',
    snapshotId: 'snapshot-1',
    snapshotIds: ['snapshot-0', 'snapshot-1'],
    observingEpoch: 1,
    title: 'Existing title',
    summary: 'Existing summary',
    snapshots: [
      { extractions: [], contextRefs: [], openQuestions: [], nextSteps: [], extractionDelta: { before: [], after: [] } },
      {
        extractions: [],
        contextRefs: [],
        openQuestions: [],
        nextSteps: [],
        extractionDelta: {
          before: [],
          after: [{ id: 'memory-1', text: 'remember this', category: 'Fact', references: ['session:existing'], updatedMemory: null }],
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

  await observer.retryExtraction();

  assert.deepEqual(observer.exportCheckpoint(), {
    committedEpoch: 1,
    nextEpoch: 2,
    runs: [],
    curationRuns: [],
    threads: [{
      sessionId: 'session-a',
      latestSnapshotId: 'snapshot-1',
      latestSnapshotSequence: 1,
      indexedSnapshotSequence: 1,
      updatedAt: '2024-01-01T00:00:00Z',
    }],
  });
});

test('observer.observeCurrentEpoch commits session rows before retrying extraction changes', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  let extractionUpserts = 0;
  let indexAttempts = 0;
  const observer = new Observer({
    sessionTable: {
      insert: async ({ snapshots }) => snapshots.map((snapshot) => ({
        ...snapshot,
        snapshotId: 'snapshot-1',
      })),
      update: async ({ snapshots }) => snapshots,
    },
    extractionTable: {
      delete: async () => ({ deleted: 0 }),
      loadByIds: async () => [],
      upsert: async () => {
        extractionUpserts += 1;
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
    sessionId: 'session-a',
    snapshotId: 'snapshot-0',
    snapshotIds: ['snapshot-0'],
    observingEpoch: 0,
    title: 'Existing title',
    summary: 'Existing summary',
    snapshots: [
      { extractions: [], contextRefs: [], openQuestions: [], nextSteps: [], extractionDelta: { before: [], after: [] } },
    ],
    references: ['session:existing'],
    indexedSnapshotSequence: 0,
    observer: 'default-observer',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  }];
  observer.buildCurrentEpochIndex = async () => {
    indexAttempts += 1;
    throw new Error('extraction write failed');
  };

  await observer.observeCurrentEpoch();

  assert.equal(extractionUpserts, 0);
  assert.equal(indexAttempts, 1);
  assert.equal(observer.committedEpoch, 1);
  assert.equal(observer.currentEpoch, null);
  const touchedThread = observer.threads.find((thread) => thread.snapshotId === 'snapshot-1');
  assert.ok(touchedThread);
  assert.ok(getPendingIndex(touchedThread));
  assert.ok(observer.nextIndexRetryAt > Date.now());
});

test('observer.run retries pending extraction index before queued epochs when due', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const calls = [];
  const observer = new Observer({
    sessionTable: {
      update: async ({ snapshots }) => snapshots,
    },
    extractionTable: {
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
      sessionId: 'session-a',
      snapshotId: 'snapshot-1',
      snapshotIds: ['snapshot-0', 'snapshot-1'],
      observingEpoch: 7,
      title: 'Title',
      summary: 'Summary',
      snapshots: [
        {
          extractions: [],
          contextRefs: [],
          openQuestions: [],
          nextSteps: [],
          extractionDelta: { before: [], after: [] },
        },
        {
          extractions: [],
          contextRefs: [],
          openQuestions: [],
          nextSteps: [],
          extractionDelta: {
            before: [],
            after: [{ id: 'memory-1', text: 'remember this', category: 'Fact', references: ['session:existing'], updatedMemory: null }],
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

  observer.retryExtraction = async () => {
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

test('observer.accept keeps a partial epoch open until epochTurns is reached', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath, { epochTurns: 3, epochWindowMs: 10_000 });

  const observer = new Observer(makeObserverClient());
  observer.bootstrapped = true;
  observer.openEpoch = new OpenEpoch(1);
  t.after(async () => observer.shutdown());

  let acceptCount = 0;
  const registry = {
    load: async () => ({
      accept: async (_content, epoch) => {
        acceptCount += 1;
        return {
          turn: makeObservableTurn(`turn-${acceptCount}`, epoch, `turn ${acceptCount}`),
          deduped: false,
        };
      },
    }),
  };

  await observer.accept({ sessionId: 'group-a', agent: 'agent-a', prompt: 'one', response: 'one' }, registry);
  assert.equal(observer.openEpoch.epoch, 1);
  assert.deepEqual(observer.openEpoch.stagedTurns().map((turn) => turn.turnId), ['turn-1']);
  assert.deepEqual(observer.epochQueue.pendingTurns(), []);

  await observer.accept({ sessionId: 'group-a', agent: 'agent-a', prompt: 'two', response: 'two' }, registry);
  assert.equal(observer.openEpoch.epoch, 1);
  assert.deepEqual(observer.openEpoch.stagedTurns().map((turn) => turn.turnId), ['turn-1', 'turn-2']);
  assert.deepEqual(observer.epochQueue.pendingTurns(), []);

  await observer.accept({ sessionId: 'group-a', agent: 'agent-a', prompt: 'three', response: 'three' }, registry);
  await observer.publishChain;

  assert.equal(observer.openEpoch.epoch, 2);
  assert.deepEqual(observer.epochQueue.pendingTurns().map((turn) => turn.turnId), ['turn-1', 'turn-2', 'turn-3']);
});

test('observer.accept seals a partial epoch when the epoch window expires', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath, { epochTurns: 3, epochWindowMs: 20 });

  const observer = new Observer(makeObserverClient());
  observer.bootstrapped = true;
  observer.openEpoch = new OpenEpoch(1);
  t.after(async () => observer.shutdown());

  const registry = {
    load: async () => ({
      accept: async (_content, epoch) => ({
        turn: makeObservableTurn('turn-1', epoch, 'first'),
        deduped: false,
      }),
    }),
  };

  await observer.accept({ sessionId: 'group-a', agent: 'agent-a', prompt: 'one', response: 'one' }, registry);
  assert.equal(observer.openEpoch.epoch, 1);

  await waitFor(() => observer.openEpoch.epoch === 2);
  await observer.publishChain;

  assert.deepEqual(observer.epochQueue.pendingTurns().map((turn) => turn.turnId), ['turn-1']);
});

test('observer.accept does not start the epoch window for non-observable turns', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath, { epochTurns: 3, epochWindowMs: 20 });

  const observer = new Observer(makeObserverClient());
  observer.bootstrapped = true;
  observer.openEpoch = new OpenEpoch(1);
  t.after(async () => observer.shutdown());

  const registry = {
    load: async () => ({
      accept: async () => ({
        turn: {
          ...makeObservableTurn('turn-1', 1, 'first'),
          response: null,
        },
        deduped: false,
      }),
    }),
  };

  await observer.accept({ sessionId: 'group-a', agent: 'agent-a', prompt: 'one' }, registry);
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(observer.openEpoch.epoch, 1);
  assert.deepEqual(observer.openEpoch.stagedTurns(), []);
  assert.deepEqual(observer.epochQueue.pendingTurns(), []);
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
  while (observer.openEpoch.epoch !== 2) {
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

  assert.equal(secondEpoch, 2);

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
  const turn = makeObservableTurn('turn:42', 7, 'publishing');
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

test('flushThreads persists session state without inline ref or index builders', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const threads = [
    {
      observingId: 'session-child',
      sessionId: 'session-child',
      kind: 'session',
      snapshotId: undefined,
      snapshotIds: [],
      observingEpoch: 1,
      title: 'Child',
      summary: 'Child summary',
      snapshots: [
        {
          extractions: [],
          contextRefs: [],
          openQuestions: [],
          nextSteps: [],
          extractionDelta: {
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
    sessionTable: {
      insert: async ({ snapshots }) => {
        return snapshots.map((snapshot) => ({
          ...snapshot,
          snapshotId: snapshot.sessionId === 'session-child' ? 'snapshot-child' : snapshot.snapshotId,
        }));
      },
    },
  }, threads, new Set(['session-child']));

  assert.equal(threads[0].snapshotId, 'snapshot-child');
  assert.equal(threads[0].indexedSnapshotSequence, null);
});
