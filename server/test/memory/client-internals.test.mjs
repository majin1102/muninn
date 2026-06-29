import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';

import core from '../../dist/backend.js';
import { __testing } from '../../dist/backend.js';
import {
  getDreamingConfigFromConfigForTests,
  getExtractorLlmConfig,
  validateMuninnConfigInput,
} from '../../dist/config.js';
import { MuninnBackend } from '../../dist/backend.js';
import { Extractor } from '../../dist/pipeline/extractor.js';
import { EpochQueue, OpenEpoch } from '../../dist/pipeline/epoch.js';
import { parseCheckpointFile, readCheckpointFile, resolveCheckpointPath } from '../../dist/checkpoint.js';
import { IngestSessionRegistry } from '../../dist/pipeline/ingest.js';
import { normalizeSessionId, sessionKey } from '../../dist/pipeline/ingest.js';
import { IngestSession } from '../../dist/pipeline/ingest.js';
import { Watchdog } from '../../dist/watchdog.js';
import extractionIndexModule from '../../dist/pipeline/extraction.js';
import sessionModule from '../../dist/pipeline/session.js';
import extractorLlmModule from '../../dist/llm/extractor.js';
import { applyExtractionChanges, applyExtractionTableChanges } from '../../dist/pipeline/extraction.js';
import { recallMemories } from '../../dist/api/memory.js';
import { validateMemoryRecallResult } from '../../dist/api/memory.js';
import { getNativeTables } from '../../dist/native.js';

const { __testing: indexTesting } = extractionIndexModule;
const { __testing: sessionTesting } = sessionModule;
const { __testing: threadTesting } = sessionModule;
const { __testing: extractorLlmTesting } = extractorLlmModule;
const {
  createSessionThread,
  getPendingIndex,
  getPendingIndexUpTo,
  loadThreads,
  parseSnapshotContent,
  renderSnapshotContent,
  toSessionSnapshot,
} = sessionModule;
const { captureTurn, memoryPipeline: memoryPipelineApi, shutdownCoreForTests } = core;
const CHECKPOINT_SCHEMA_VERSION = 12;
let defaultConfigDir = null;

function createCheckpointBackend(exported = null) {
  return {
    exportCheckpoint: async () => exported,
  };
}

function makeExtractorCheckpoint(overrides = {}) {
  const baseline = {
    turn: 10,
    session: 21,
    extraction: 8,
    ...(overrides.baseline ?? {}),
  };
  return {
    baseline,
    committedEpoch: 12,
    nextEpoch: 13,
    recentSessions: [],
    threads: [],
    runs: [],
    ...overrides,
    baseline,
  };
}

function makeCheckpointContent(overrides = {}) {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    ...(overrides.writtenAt === undefined ? {} : { writtenAt: overrides.writtenAt }),
    ...(overrides.writerPid === undefined ? {} : { writerPid: overrides.writerPid }),
    extractor: overrides.extractor ?? makeExtractorCheckpoint(),
    sessionIndex: overrides.sessionIndex ?? {
      baseline: { turn: 10, session: 21 },
      entries: [],
    },
  };
}

function memoryWatermarkResolved(watermark) {
  return watermark.pending.turns.length === 0
    && watermark.phases.extractor === 'idle'
    && !watermark.error;
}

async function makeConfigHome() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-extractor-internals-'));
  return {
    dir,
    homeDir: path.join(dir, 'muninn'),
    configPath: path.join(dir, 'muninn', 'muninn.json'),
  };
}

async function writeExtractorConfig(configPath, {
  activeWindowDays = 3650,
  maxAttempts = 3,
  minEpochTurns,
  maxEpochTurns,
  epochWindowMs,
  failedEpochRetryIntervalMs,
  name = 'default-extractor',
} = {}) {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    extractor: {
      name,
      llmProvider: 'extractor_llm',
      embeddingProvider: 'default',
      maxAttempts,
      activeWindowDays,
      ...(minEpochTurns === undefined ? {} : { minEpochTurns }),
      ...(maxEpochTurns === undefined ? {} : { maxEpochTurns }),
      ...(epochWindowMs === undefined ? {} : { epochWindowMs }),
      ...(failedEpochRetryIntervalMs === undefined ? {} : { failedEpochRetryIntervalMs }),
    },
    providers: {
      llm: {
        extractor_llm: {
          type: 'mock',
        },
      },
      embedding: {
        default: {
          type: 'mock',
          dimensions: 8,
        },
      },
    },
  }, null, 2)}\n`, 'utf8');
}

async function writeOpenAiExtractorConfig(configPath) {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    extractor: {
      name: 'default-extractor',
      llmProvider: 'extractor_llm',
      embeddingProvider: 'default',
      maxAttempts: 3,
      activeWindowDays: 3650,
    },
    providers: {
      llm: {
        extractor_llm: {
          type: 'openai',
          apiKey: 'test-key',
        },
      },
      embedding: {
        default: {
          type: 'mock',
          dimensions: 8,
        },
      },
    },
  }, null, 2)}\n`, 'utf8');
}

test('config reads extraction embedding config and rejects unknown top-level keys', async () => {
  assert.doesNotThrow(() => validateMuninnConfigInput(JSON.stringify({
    storage: { uri: 'file:///tmp/muninn-test' },
    extractor: { name: 'default-extractor', llmProvider: 'extractor_llm', embeddingProvider: 'default' },
    providers: {
      llm: {
        extractor_llm: { type: 'mock' },
      },
      embedding: {
        default: { type: 'mock' },
      },
    },
  })));
  assert.throws(() => validateMuninnConfigInput(JSON.stringify({
    storage: { uri: 'file:///tmp/muninn-test' },
    extractor: { name: 'default-extractor', llmProvider: 'extractor_llm', embeddingProvider: 'default' },
    providers: {
      llm: {
        extractor_llm: { type: 'mock' },
      },
      embedding: {
        default: { type: 'mock' },
      },
    },
    unsupportedIndex: { embedding: { provider: 'mock' } },
  })), /unsupported top-level config key: unsupportedIndex/);
});

test('dreaming scheduler defaults to enabled thirty minute interval and validates positive integer', () => {
  const config = {
    storage: { uri: 'file:///tmp/muninn-test' },
    extractor: { name: 'default-extractor', llmProvider: 'extractor_llm', embeddingProvider: 'default' },
    providers: {
      llm: {
        extractor_llm: { type: 'mock' },
      },
      embedding: {
        default: { type: 'mock' },
      },
    },
  };
  assert.deepEqual(getDreamingConfigFromConfigForTests(config), {
    enabled: true,
    intervalMs: 1_800_000,
  });
  assert.deepEqual(getDreamingConfigFromConfigForTests({
    ...config,
    dreaming: { enabled: false, intervalMs: 60_000 },
  }), {
    enabled: false,
    intervalMs: 60_000,
  });
  assert.throws(() => validateMuninnConfigInput(JSON.stringify({
    ...config,
    dreaming: { intervalMs: 0 },
  })), /dreaming\.intervalMs must be a positive integer/);
});

test('native bindings expose turn session dreaming and extraction tables', async () => {
  const tables = await getNativeTables();
  assert.equal(typeof tables.turnTable.listTurns, 'function');
  assert.equal(typeof tables.sessionTable.listSnapshots, 'function');
  assert.equal(typeof tables.dreamingTable.list, 'function');
  assert.equal(typeof tables.dreamingTable.append, 'function');
  assert.equal(typeof tables.dreamingTable.update, 'function');
  assert.equal(typeof tables.extractionTable.list, 'function');
  assert.equal(typeof tables.extractionTable.delta, 'function');
  assert.equal(typeof tables.extractionTable.upsert, 'function');
  assert.equal(typeof tables.extractionTable.delete, 'function');
  assert.equal(typeof tables.extractionTable.search, 'function');
  assert.equal(typeof tables.extractionTable.stats, 'function');
  assert.equal(typeof tables.extractionTable.ensureVectorIndex, 'function');
  assert.equal(typeof tables.extractionTable.compact, 'function');
  assert.equal(typeof tables.extractionTable.cleanup, 'function');
  assert.equal(typeof tables.extractionTable.optimize, 'function');
});

test('table mutation locks serialize writes on the same table', async () => {
  const { TableMutationLocks } = await import('../../dist/native.js');
  const locks = new TableMutationLocks();
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const secondEntered = deferred();

  const first = locks.with('extraction', async () => {
    firstEntered.resolve();
    await releaseFirst.promise;
    return 'first';
  });
  await firstEntered.promise;

  const second = locks.with('extraction', async () => {
    secondEntered.resolve();
    return 'second';
  });

  const secondStartedEarly = await Promise.race([
    secondEntered.promise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 30)),
  ]);
  assert.equal(secondStartedEarly, false);

  releaseFirst.resolve();
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
});

test('table mutation locks allow writes on different tables to overlap', async () => {
  const { TableMutationLocks } = await import('../../dist/native.js');
  const locks = new TableMutationLocks();
  const extractionEntered = deferred();
  const sessionEntered = deferred();
  const release = deferred();

  const extraction = locks.with('extraction', async () => {
    extractionEntered.resolve();
    await release.promise;
  });
  const session = locks.with('session', async () => {
    sessionEntered.resolve();
    await release.promise;
  });

  await extractionEntered.promise;
  await sessionEntered.promise;
  release.resolve();
  await Promise.all([extraction, session]);
});

test('lockNativeTables serializes same-table mutations without locking reads', async () => {
  const { TableMutationLocks, lockNativeTables } = await import('../../dist/native.js');
  const locks = new TableMutationLocks();
  const upsertEntered = deferred();
  const releaseUpsert = deferred();
  const optimizeEntered = deferred();
  let searchCalls = 0;
  const tables = lockNativeTables({
    extractionTable: {
      upsert: async () => {
        upsertEntered.resolve();
        await releaseUpsert.promise;
      },
      optimize: async () => {
        optimizeEntered.resolve();
        return { changed: true };
      },
      search: async () => {
        searchCalls += 1;
        return [];
      },
    },
  }, locks);

  const upsert = tables.extractionTable.upsert({ rows: [] });
  await upsertEntered.promise;
  const optimize = tables.extractionTable.optimize({ mergeCount: 1 });
  await tables.extractionTable.search({ query: 'q', vector: [], limit: 1, mode: 'hybrid' });
  assert.equal(searchCalls, 1);

  const optimizeStartedEarly = await Promise.race([
    optimizeEntered.promise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 30)),
  ]);
  assert.equal(optimizeStartedEarly, false);

  releaseUpsert.resolve();
  await upsert;
  assert.deepEqual(await optimize, { changed: true });
});

test('memories.get renders extraction memories', async () => {
  const client = {
    extractionTable: {
      get: async ({ ids }) => ids.includes('ext-1')
        ? [{
            id: 'ext-1',
            title: 'Caroline research',
            summary: 'Caroline researched adoption agencies.',
            content: 'Caroline researched adoption agencies.',
            cwd: '/workspace/project',
            vector: [],
            turnRefs: ['turn:1'],
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          }]
        : [],
    },
    sessionTable: { get: async () => null },
    turnTable: { get: async () => null },
  };
  const { Memories } = await import('../../dist/api/memory.js');
  const memory = await new Memories(client).get('extraction:ext-1');

  assert.equal(memory.memoryId, 'extraction:ext-1');
  assert.equal(memory.title, 'Caroline research');
  assert.equal(memory.summary, 'Caroline researched adoption agencies.');
  assert.match(memory.detail, /References:/);
  assert.match(memory.detail, /turn:1/);
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

function makeExtractableTurn(turnId, extractionEpoch, text) {
  return {
    turnId,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    sessionId: 'group-a',
    project: 'project-a',
    cwd: '/workspace/project-a',
    agent: 'agent-a',
    extractor: 'default-extractor',
    summary: `${text} summary`,
    events: [
      { type: 'userMessage', text: `${text} prompt` },
      { type: 'assistantMessage', text: `${text} response` },
    ],
    prompt: `${text} prompt`,
    response: `${text} response`,
    extractionEpoch: extractionEpoch,
  };
}

function makeRecentTurn(turnId, text = turnId, overrides = {}) {
  return {
    turnId,
    updatedAt: '2024-01-01T00:00:00Z',
    prompt: `${text} prompt`,
    response: `${text} response`,
    ...overrides,
  };
}

function storedExtraction(id) {
  const title = `${id} title`;
  const summary = `${id} summary`;
  return {
    id,
    title,
    summary: `${title}\n\n${summary}`,
    content: extractionContent(title, summary, `${id} content`),
    anchors: [],
    vector: [1, 0, 0, 0],
    category: 'fact',
    references: ['turn:1'],
    createdAt: '2024-01-01T00:00:00Z',
  };
}

function extractionContent(title, summary, content = '') {
  return `## Title\n\n${title}\n\n## Summary\n\n${summary}\n\n## Content\n\n${content}`;
}

function snapshotContentFixture(units, {
  title = 'Painting Memory',
  summary = 'This thread tracks durable painting memory.',
  memorySignals = [],
  skillSignals = [],
  skillDetails = {},
} = {}) {
  const detailEntries = Object.entries(skillDetails)
    .map(([name, detail]) => [
      `### ${name}`,
      detail.trim(),
    ].join('\n').trimEnd())
    .join('\n\n');
  return [
    `# ${title}`,
    '',
    '## Summary',
    summary,
    '',
    '## Instruction Signals',
    memorySignals.join('\n'),
    '',
    '## Skill Signals',
    skillSignals.join('\n'),
    '',
    '## Skill Details',
    detailEntries,
    '',
    '## Extractions',
    typeof units === 'string' ? units : units.join('\n'),
  ].join('\n');
}

function emptySnapshotSignals() {
  return {
    memorySignals: [],
    skillSignals: [],
    skillDetails: '{}',
  };
}

function makePersistedTurn(turnId, text = turnId) {
  return {
    turnId,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    sessionId: 'group-a',
    project: 'project-a',
    cwd: '/workspace/project-a',
    agent: 'agent-a',
    extractor: 'default-extractor',
    events: [
      { type: 'userMessage', text: `${text} prompt` },
      { type: 'assistantMessage', text: `${text} response` },
    ],
    prompt: `${text} prompt`,
    response: `${text} response`,
  };
}

function makeTurnContent(prompt, response, overrides = {}) {
  return {
    sessionId: 'group-a',
    project: 'project-a',
    cwd: '/workspace/project-a',
    agent: 'agent-a',
    prompt,
    response,
    events: [
      { type: 'userMessage', text: prompt },
      { type: 'assistantMessage', text: response },
    ],
    ...overrides,
  };
}

test('createSessionThread preserves complete readable title and summary text', () => {
  const title = 'Caroline LGBTQ support group impact and counseling career direction';
  const summary = [
    'Caroline attended an LGBTQ support group on 7 May 2023.',
    'The group made Caroline feel accepted and gave her courage to embrace herself.',
    'Caroline plans to continue education and explore counseling or mental health work.',
    'Melanie believes Caroline would be a strong counselor because of Caroline\'s empathy and understanding.',
  ].join(' ');

  const thread = createSessionThread(
    'default-extractor',
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
    project: 'project-a',
    cwd: '/workspace/project-a',
    turns,
  };
}

function makeExtractorClient() {
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
      get: async () => [],
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
    const content = await readFile(path.join(homeDir, 'main', 'logs', 'watchdog.jsonl'), 'utf8');
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-core-internals-default-'));
  defaultConfigDir = dir;
  const homeDir = path.join(dir, 'muninn');
  await writeExtractorConfig(path.join(homeDir, 'muninn.json'));
  process.env.MUNINN_HOME = homeDir;
});

test.afterEach(async () => {
  await __testing.shutdownCoreForTests();
  if (defaultConfigDir) {
    await rm(defaultConfigDir, { recursive: true, force: true });
    defaultConfigDir = null;
  }
  delete process.env.MUNINN_HOME;
});

test.after(async () => {
  await __testing.shutdownCoreForTests();
  delete process.env.MUNINN_HOME;
});

test('getExtractorLlmConfig defaults activeWindowDays continuityHints and failed retry interval', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    extractor: {
      name: 'default-extractor',
      llmProvider: 'extractor_llm',
      embeddingProvider: 'default',
      maxAttempts: 3,
    },
    providers: {
      llm: {
        extractor_llm: {
          type: 'mock',
        },
      },
      embedding: {
        default: {
          type: 'mock',
          dimensions: 8,
        },
      },
    },
  }, null, 2)}\n`, 'utf8');

  const config = getExtractorLlmConfig();
  assert.ok(config);
  assert.equal(config.activeWindowDays, 7);
  assert.equal(config.continuityHints, 1);
  assert.equal(config.failedEpochRetryIntervalMs, 900_000);
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

test('watchdog compacts turn data once per indexed version without logging skips', async (t) => {
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
    database: 'main',
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

test('watchdog writes extractor checkpoint files', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

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
  }, createWatchdogConfig({ intervalMs: 25, compactMinFragments: 3 }), createCheckpointBackend(makeCheckpointContent({
    extractor: makeExtractorCheckpoint({
      recentSessions: [makeRecentSessionCheckpoint([makeRecentTurn('turn:101', 'checkpoint-1')])],
      threads: [{
        sessionId: 'obs-1',
        latestSnapshotId: 'turn:42',
        latestSnapshotSequence: 2,
        indexedSnapshotSequence: 1,
        updatedAt: '2024-01-01T00:00:00Z',
      }],
    }),
  })));
  t.after(async () => runtime.stop());

  runtime.start();
  await waitFor(async () => {
    try {
      const checkpoint = await readCheckpoint();
      return checkpoint.extractor?.threads?.length === 1;
    } catch {
      return false;
    }
  });

  const checkpoint = await readCheckpoint();
  assert.equal(checkpoint.schemaVersion, CHECKPOINT_SCHEMA_VERSION);
  assert.deepEqual(checkpoint.extractor, {
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
    runs: [],
  });
});

test('watchdog serializes concurrent checkpoint flushes', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  const checkpointContent = makeCheckpointContent({
    extractor: makeExtractorCheckpoint({
      recentSessions: [makeRecentSessionCheckpoint([makeRecentTurn('turn:101', 'checkpoint-concurrent')])],
    }),
  });
  let exportCalls = 0;
  let releaseExport;
  const exportGate = new Promise((resolve) => {
    releaseExport = resolve;
  });
  const runtime = new Watchdog({}, createWatchdogConfig({ intervalMs: 25 }), {
    exportCheckpoint: async () => {
      exportCalls += 1;
      await exportGate;
      return checkpointContent;
    },
  });

  const first = runtime.flushCheckpoint();
  const second = runtime.flushCheckpoint();
  const third = runtime.flushCheckpoint();
  await waitFor(() => exportCalls === 1);
  assert.equal(exportCalls, 1);
  releaseExport();
  await Promise.all([first, second, third]);

  assert.equal(exportCalls, 1);
  const checkpoint = await readCheckpoint();
  assert.deepEqual(checkpoint.extractor.recentSessions, checkpointContent.extractor.recentSessions);
});

test('watchdog skips checkpoint writes when contributors return no extractor state', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  const existing = makeCheckpointContent({
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    extractor: makeExtractorCheckpoint(),
  });
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

test('watchdog skips checkpoint writes when extractor content is unchanged', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  const checkpointContent = makeCheckpointContent({
    extractor: makeExtractorCheckpoint({
      recentSessions: [makeRecentSessionCheckpoint([makeRecentTurn('turn:101', 'checkpoint-2')])],
      threads: [{
        sessionId: 'obs-1',
        latestSnapshotId: 'turn:42',
        latestSnapshotSequence: 2,
        indexedSnapshotSequence: 1,
        updatedAt: '2024-01-01T00:00:00Z',
      }],
    }),
  });
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
  await writeExtractorConfig(configPath);

  const checkpointContent = makeCheckpointContent({
    extractor: makeExtractorCheckpoint({
      recentSessions: [makeRecentSessionCheckpoint([makeRecentTurn('turn:101', 'checkpoint-3')])],
      threads: [{
        sessionId: 'obs-1',
        latestSnapshotId: 'turn:42',
        latestSnapshotSequence: 2,
        indexedSnapshotSequence: 1,
        updatedAt: '2024-01-01T00:00:00Z',
      }],
    }),
  });
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
  assert.equal(checkpoint.extractor.committedEpoch, 12);
});

test('readCheckpointFile throws when the checkpoint file is invalid JSON', async (t) => {
  const { dir, homeDir } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), '{invalid-json', 'utf8');

  await assert.rejects(() => readCheckpointFile(), /Unexpected token|JSON/i);
});

test('readCheckpointFile ignores stale checkpoint schema cache', async (t) => {
  const { dir, homeDir } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify({
    schemaVersion: 6,
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    extractor: makeExtractorCheckpoint(),
  }, null, 2)}\n`, 'utf8');

  assert.equal(await readCheckpointFile(), null);
});

test('resolveCheckpointPath is scoped by extractor name', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await writeExtractorConfig(configPath, { name: 'extractor-a' });
  const firstPath = resolveCheckpointPath();

  await writeExtractorConfig(configPath, { name: 'extractor-b' });
  const secondPath = resolveCheckpointPath();

  assert.notEqual(firstPath, secondPath);
});

test('checkpoint preserves session runs', async () => {
  const { parseCheckpointFile, serializeCheckpointFile } = await import('../../dist/checkpoint.js');
  const file = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    writtenAt: new Date().toISOString(),
    writerPid: 1,
    extractor: {
      baseline: { turn: 1, session: 1, extraction: 1 },
      nextEpoch: 2,
      recentSessions: [],
      threads: [],
      runs: [{
        extractor: 'default',
        epoch: 1,
        status: 'running',
        stage: 'fittingThreads',
        inputTurnIds: ['turn:1'],
        pending: {
          snapshotResults: [],
        },
        committed: { extractionIds: ['obs-1'], snapshotIds: [] },
        traceRefs: [],
        errors: [],
      }],
    },
    sessionIndex: { baseline: { turn: 1, session: 1 }, entries: [] },
  };

  const parsed = parseCheckpointFile(serializeCheckpointFile(file));
  assert.equal(parsed.extractor.runs[0].stage, 'fittingThreads');
  assert.deepEqual(parsed.extractor.runs[0].pending.snapshotResults, []);
  assert.deepEqual(parsed.extractor.runs[0].committed.extractionIds, ['obs-1']);
});

test('watchdog rewrites checkpoint when extractor content changes', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify(makeCheckpointContent({
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    extractor: makeExtractorCheckpoint({ committedEpoch: 11, nextEpoch: 12 }),
  }), null, 2)}\n`, 'utf8');
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
  }, createWatchdogConfig({ intervalMs: 25 }), createCheckpointBackend(makeCheckpointContent({
    extractor: makeExtractorCheckpoint({ committedEpoch: 12, nextEpoch: 13 }),
  })));
  t.after(async () => runtime.stop());

  runtime.start();
  await waitFor(async () => {
    const checkpoint = await readCheckpoint();
    return checkpoint.extractor?.committedEpoch === 12;
  });

  const after = await readCheckpoint();
  const afterStat = await stat(resolveCheckpointPath());
  assert.equal(after.extractor.committedEpoch, 12);
  assert.equal(after.extractor.nextEpoch, 13);
  assert.ok(after.writtenAt !== '2024-01-01T00:00:00Z');
  assert.ok(afterStat.mtimeMs >= beforeStat.mtimeMs);
});

test('getPendingIndex returns the unindexed snapshot range', () => {
  const pending = getPendingIndex({
    sessionId: 'session-a',
    extractionEpoch: 7,
    title: 'Title',
    summary: 'Summary',
    snapshots: [
      { extractions: [], contextRefs: [], nextSteps: [], extractionDelta: { before: [], after: [] } },
      { extractions: [], contextRefs: [], nextSteps: [], extractionDelta: { before: [], after: [] } },
    ],
    snapshotIds: ['snapshot-0', 'snapshot-1'],
    indexedSnapshotSequence: 0,
    references: [],
    extractor: 'default-extractor',
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
    extractionEpoch: 8,
    title: 'Title',
    summary: 'Summary',
    snapshots: [
      { extractions: [], contextRefs: [], nextSteps: [], extractionDelta: { before: [], after: [] } },
      { extractions: [], contextRefs: [], nextSteps: [], extractionDelta: { before: [], after: [] } },
      { extractions: [], contextRefs: [], nextSteps: [], extractionDelta: { before: [], after: [] } },
    ],
    snapshotIds: ['snapshot-0', 'snapshot-1', 'snapshot-2'],
    snapshotEpochs: [6, 7, 8],
    indexedSnapshotSequence: 0,
    references: [],
    extractor: 'default-extractor',
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
      project: 'project-a',
      cwd: '/workspace/project-a',
      agent: 'agent-a',
      snapshotSequence: 0,
      createdAt: freshUpdatedAt,
      updatedAt: freshUpdatedAt,
      extractor: 'default-extractor',
      title: 'Fresh thread',
      summary: 'Fresh summary',
      ...emptySnapshotSignals(),
      content: snapshotContentFixture('', { title: 'Fresh thread', summary: 'Fresh summary' }),
      references: [],
    },
    {
      snapshotId: 'stale-snapshot',
      sessionId: 'stale-thread',
      project: 'project-a',
      cwd: '/workspace/project-a',
      agent: 'agent-a',
      snapshotSequence: 0,
      createdAt: staleUpdatedAt,
      updatedAt: staleUpdatedAt,
      extractor: 'default-extractor',
      title: 'Stale thread',
      summary: 'Stale summary',
      ...emptySnapshotSignals(),
      content: snapshotContentFixture('', { title: 'Stale thread', summary: 'Stale summary' }),
      references: [],
    },
  ];

  const threads = loadThreads(snapshots, 'default-extractor', 7);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].kind, 'session');
  assert.equal(threads[0].sessionId, 'fresh-thread');
});

test('loadThreads keeps full history for active threads', () => {
  const freshUpdatedAt = new Date().toISOString();
  const staleUpdatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const snapshots = [
    {
      snapshotId: 'snapshot-0',
      sessionId: 'mixed-thread',
      project: 'project-a',
      cwd: '/workspace/project-a',
      agent: 'agent-a',
      snapshotSequence: 0,
      createdAt: staleUpdatedAt,
      updatedAt: staleUpdatedAt,
      extractor: 'default-extractor',
      title: 'Thread',
      summary: 'Summary',
      ...emptySnapshotSignals(),
      content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
      references: [],
    },
    {
      snapshotId: 'snapshot-1',
      sessionId: 'mixed-thread',
      project: 'project-a',
      cwd: '/workspace/project-a',
      agent: 'agent-a',
      snapshotSequence: 1,
      createdAt: freshUpdatedAt,
      updatedAt: freshUpdatedAt,
      extractor: 'default-extractor',
      title: 'Thread',
      summary: 'Summary',
      ...emptySnapshotSignals(),
      content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
      references: [],
    },
  ];

  const threads = loadThreads(snapshots, 'default-extractor', 7);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].kind, 'session');
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
    extractor: 'default-extractor',
    summary: 'queued summary',
    response: 'queued response',
    extractionEpoch: 1,
  };

  queue.publishEpoch({ epoch: 1, turns: [turn] });

  assert.deepEqual(queue.shift(), {
    epoch: 1,
    turns: [turn],
  });
  assert.equal(queue.shift(), null);
});

test('extractor.watermark stays unresolved when only extraction index work is pending', async () => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  try {
    const extractor = new Extractor({});
    extractor.bootstrapped = true;
    extractor.openEpoch = new OpenEpoch(8);
    extractor.threads = [{
      sessionId: 'session-a',
      snapshotId: 'snapshot-1',
      snapshotIds: ['snapshot-0', 'snapshot-1'],
      extractionEpoch: 7,
      title: 'Title',
      summary: 'Summary',
      snapshots: [
        { extractions: [], contextRefs: [], nextSteps: [], extractionDelta: { before: [], after: [] } },
        { extractions: [], contextRefs: [], nextSteps: [], extractionDelta: { before: [], after: [] } },
      ],
      references: [],
      indexedSnapshotSequence: 0,
      extractor: 'default-extractor',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }];

    const watermark = await extractor.watermark();
    assert.deepEqual(watermark.pending.turns, []);
    assert.equal(memoryWatermarkResolved(watermark), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extractor checkpoint export omits threads outside the active window', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath, { activeWindowDays: 7 });

  const freshUpdatedAt = new Date().toISOString();
  const staleUpdatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const extractor = new Extractor({});
  t.after(async () => extractor.shutdown());

  extractor.bootstrapped = true;
  extractor.committedEpoch = 1;
  extractor.openEpoch = new OpenEpoch(2);
  extractor.threads = [
    {
      sessionId: 'fresh-thread',
      snapshotId: 'fresh-snapshot',
      snapshotIds: ['fresh-snapshot'],
      extractionEpoch: 1,
      title: 'Fresh',
      summary: 'Fresh',
      snapshots: [{ extractions: [], contextRefs: [], nextSteps: [], extractionDelta: { before: [], after: [] } }],
      references: [],
      indexedSnapshotSequence: 0,
      extractor: 'default-extractor',
      createdAt: freshUpdatedAt,
      updatedAt: freshUpdatedAt,
    },
    {
      sessionId: 'stale-thread',
      snapshotId: 'stale-snapshot',
      snapshotIds: ['stale-snapshot'],
      extractionEpoch: 1,
      title: 'Stale',
      summary: 'Stale',
      snapshots: [{ extractions: [], contextRefs: [], nextSteps: [], extractionDelta: { before: [], after: [] } }],
      references: [],
      indexedSnapshotSequence: 0,
      extractor: 'default-extractor',
      createdAt: staleUpdatedAt,
      updatedAt: staleUpdatedAt,
    },
  ];
  extractor.refreshCheckpointSnapshot();

  assert.deepEqual(extractor.exportCheckpoint().threads, [{
    sessionId: 'fresh-thread',
    latestSnapshotId: 'fresh-snapshot',
    latestSnapshotSequence: 0,
    indexedSnapshotSequence: 0,
    updatedAt: freshUpdatedAt,
  }]);
});

test('extractor checkpoint export returns null before bootstrap completes', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  const extractor = new Extractor({});
  t.after(async () => extractor.shutdown());

  assert.equal(extractor.exportCheckpoint(), null);
});

test('extractor bootstrap without checkpoint derives committedEpoch from session snapshots', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  const snapshot1At = new Date(Date.now() - 1_000).toISOString();
  const snapshot2At = new Date().toISOString();
  const rows = [
    {
      snapshotId: 'snapshot-1',
      sessionId: 'obs-1',
      project: 'project-a',
      cwd: '/workspace/project-a',
      agent: 'agent-a',
      snapshotSequence: 0,
      createdAt: snapshot1At,
      updatedAt: snapshot1At,
      extractor: 'default-extractor',
      title: 'Thread',
      summary: 'Summary',
      ...emptySnapshotSignals(),
      content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
      references: ['turn-13'],
    },
    {
      snapshotId: 'snapshot-2',
      sessionId: 'obs-1',
      project: 'project-a',
      cwd: '/workspace/project-a',
      agent: 'agent-a',
      snapshotSequence: 1,
      createdAt: snapshot2At,
      updatedAt: snapshot2At,
      extractor: 'default-extractor',
      title: 'Thread',
      summary: 'Summary',
      ...emptySnapshotSignals(),
      content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
      references: ['turn-13', 'turn-14'],
    },
  ];
  const extractor = new Extractor({
    turnTable: {
      loadTurnsAfterEpoch: async () => [
        makeExtractableTurn('turn-13', 13, 'epoch13'),
        makeExtractableTurn('turn-14', 14, 'epoch14'),
      ],
    },
    sessionTable: {
      listSnapshots: async () => rows,
      threadSnapshots: async () => rows,
    },
    extractionTable: {},
  });
  t.after(async () => extractor.shutdown());

  await extractor.ensureBootstrapped();

  assert.equal(extractor.committedEpoch, 14);
  assert.deepEqual((await extractor.watermark()).pending.turns, []);
  assert.deepEqual(extractor.threads[0].snapshotIds, ['snapshot-1', 'snapshot-2']);
});

test('extractor bootstrap publishes pending turns by their extractionEpoch', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  const published = [];
  const extractor = new Extractor({
    turnTable: {
      loadTurnsAfterEpoch: async () => [
        makeExtractableTurn('turn-13', 13, 'epoch13'),
        makeExtractableTurn('turn-14', 14, 'epoch14'),
      ],
    },
    sessionTable: {
      listSnapshots: async () => [],
    },
    extractionTable: {},
  });
  t.after(async () => extractor.shutdown());

  extractor.epochQueue.publishEpoch = (sealedEpoch) => {
    published.push({
      epoch: sealedEpoch.epoch,
      turnIds: sealedEpoch.turns.map((turn) => turn.turnId),
    });
  };

  await extractor.ensureBootstrapped();

  assert.deepEqual(published, [
    { epoch: 13, turnIds: ['turn-13'] },
    { epoch: 14, turnIds: ['turn-14'] },
  ]);
  assert.equal(extractor.openEpoch.epoch, 15);
});

test('extractor bootstrap restores committed state from checkpoint when baselines match', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify(makeCheckpointContent({
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    extractor: makeExtractorCheckpoint({
      recentSessions: [makeRecentSessionCheckpoint([makeRecentTurn('turn:101', 'checkpoint-4')])],
      threads: [{
        sessionId: 'obs-1',
        latestSnapshotId: 'turn:42',
        latestSnapshotSequence: 1,
        indexedSnapshotSequence: 1,
        updatedAt: '2024-01-01T00:00:01Z',
      }],
    }),
  }), null, 2)}\n`, 'utf8');

  let listSnapshotsCalls = 0;
  let loadTurnsAfterEpochCalls = 0;
  const checkpoint = (await readCheckpointFile())?.extractor ?? null;
  const extractor = new Extractor({
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
      delta: async () => ({ sourceVersion: 21, rows: [] }),
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
            project: 'project-a',
            cwd: '/workspace/project-a',
            agent: 'agent-a',
            snapshotSequence: 0,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
            extractor: 'default-extractor',
            title: 'Thread',
            summary: 'Summary',
            ...emptySnapshotSignals(),
            content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
            references: [],
          },
          {
            snapshotId: 'turn:42',
            sessionId: 'obs-1',
            project: 'project-a',
            cwd: '/workspace/project-a',
            agent: 'agent-a',
            snapshotSequence: 1,
            createdAt: '2024-01-01T00:00:01Z',
            updatedAt: '2024-01-01T00:00:01Z',
            extractor: 'default-extractor',
            title: 'Thread',
            summary: 'Summary',
            ...emptySnapshotSignals(),
            content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
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
  t.after(async () => extractor.shutdown());

  await extractor.ensureBootstrapped();

  assert.equal(listSnapshotsCalls, 0);
  assert.equal(loadTurnsAfterEpochCalls, 1);
  assert.deepEqual(extractor.exportCheckpoint(), {
    committedEpoch: 12,
    nextEpoch: 13,
    runs: [],
    threads: [{
      sessionId: 'obs-1',
      latestSnapshotId: 'turn:42',
      latestSnapshotSequence: 1,
      indexedSnapshotSequence: 1,
      updatedAt: '2024-01-01T00:00:01Z',
    }],
  });
});

test('extractor checkpoint restore keeps full history for active threads', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath, { activeWindowDays: 7 });

  const staleUpdatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const freshUpdatedAt = new Date().toISOString();
  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify(makeCheckpointContent({
    writtenAt: new Date().toISOString(),
    writerPid: 123,
    extractor: makeExtractorCheckpoint({
      recentSessions: [],
      threads: [{
        sessionId: 'mixed-thread',
        latestSnapshotId: 'snapshot-1',
        latestSnapshotSequence: 1,
        indexedSnapshotSequence: 1,
        updatedAt: freshUpdatedAt,
      }],
    }),
  }), null, 2)}\n`, 'utf8');

  const checkpoint = (await readCheckpointFile())?.extractor ?? null;
  const extractor = new Extractor({
    turnTable: {
      stats: async () => ({
        version: 10,
        fragmentCount: 1,
        rowCount: 0,
      }),
      loadTurnsAfterEpoch: async () => [],
    },
    sessionTable: {
      delta: async () => ({ sourceVersion: 21, rows: [] }),
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
            project: 'project-a',
            cwd: '/workspace/project-a',
            agent: 'agent-a',
            snapshotSequence: 0,
            createdAt: staleUpdatedAt,
            updatedAt: staleUpdatedAt,
            extractor: 'default-extractor',
            title: 'Thread',
            summary: 'Summary',
            ...emptySnapshotSignals(),
            content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
            references: [],
          },
          {
            snapshotId: 'snapshot-1',
            sessionId: 'mixed-thread',
            project: 'project-a',
            cwd: '/workspace/project-a',
            agent: 'agent-a',
            snapshotSequence: 1,
            createdAt: freshUpdatedAt,
            updatedAt: freshUpdatedAt,
            extractor: 'default-extractor',
            title: 'Thread',
            summary: 'Summary',
            ...emptySnapshotSignals(),
            content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
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
  t.after(async () => extractor.shutdown());

  await extractor.ensureBootstrapped();

  assert.equal(extractor.threads.length, 1);
  assert.deepEqual(extractor.threads[0].snapshotIds, ['snapshot-0', 'snapshot-1']);
  assert.equal(extractor.threads[0].snapshots.length, 2);
  assert.equal(extractor.threads[0].indexedSnapshotSequence, 1);
});

test('extractor restore advances committedEpoch and excludes extracted turns from pending', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath, { activeWindowDays: 7 });
  const snapshot0At = new Date(Date.now() - 2_000).toISOString();
  const snapshot1At = new Date(Date.now() - 1_000).toISOString();
  const snapshot2At = new Date().toISOString();

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify(makeCheckpointContent({
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    extractor: makeExtractorCheckpoint({
      threads: [{
        sessionId: 'obs-1',
        latestSnapshotId: 'snapshot-0',
        latestSnapshotSequence: 0,
        indexedSnapshotSequence: 0,
        updatedAt: snapshot0At,
      }],
    }),
  }), null, 2)}\n`, 'utf8');

  const checkpoint = (await readCheckpointFile())?.extractor ?? null;
  const extractor = new Extractor({
    turnTable: {
      loadTurnsAfterEpoch: async () => [
        makeExtractableTurn('turn-13', 13, 'epoch13'),
        makeExtractableTurn('turn-14', 14, 'epoch14'),
      ],
    },
    sessionTable: {
      delta: async () => ({
        sourceVersion: 21,
        rows: [
          {
            snapshotId: 'snapshot-1',
            sessionId: 'obs-1',
            project: 'project-a',
            cwd: '/workspace/project-a',
            agent: 'agent-a',
            snapshotSequence: 1,
            createdAt: snapshot1At,
            updatedAt: snapshot1At,
            extractor: 'default-extractor',
            title: 'Thread',
            summary: 'Summary',
            ...emptySnapshotSignals(),
            content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
            references: ['turn-13'],
          },
          {
            snapshotId: 'snapshot-2',
            sessionId: 'obs-1',
            project: 'project-a',
            cwd: '/workspace/project-a',
            agent: 'agent-a',
            snapshotSequence: 2,
            createdAt: snapshot2At,
            updatedAt: snapshot2At,
            extractor: 'default-extractor',
            title: 'Thread',
            summary: 'Summary',
            ...emptySnapshotSignals(),
            content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
            references: ['turn-13', 'turn-14'],
          },
        ],
      }),
      threadSnapshots: async () => [
        {
          snapshotId: 'snapshot-0',
          sessionId: 'obs-1',
          project: 'project-a',
          cwd: '/workspace/project-a',
          agent: 'agent-a',
          snapshotSequence: 0,
          createdAt: snapshot0At,
          updatedAt: snapshot0At,
          extractor: 'default-extractor',
          title: 'Thread',
          summary: 'Summary',
          ...emptySnapshotSignals(),
          content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
          references: [],
        },
        {
          snapshotId: 'snapshot-1',
          sessionId: 'obs-1',
          project: 'project-a',
          cwd: '/workspace/project-a',
          agent: 'agent-a',
          snapshotSequence: 1,
          createdAt: snapshot1At,
          updatedAt: snapshot1At,
          extractor: 'default-extractor',
          title: 'Thread',
          summary: 'Summary',
          ...emptySnapshotSignals(),
          content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
          references: ['turn-13'],
        },
        {
          snapshotId: 'snapshot-2',
          sessionId: 'obs-1',
          project: 'project-a',
          cwd: '/workspace/project-a',
          agent: 'agent-a',
          snapshotSequence: 2,
          createdAt: snapshot2At,
          updatedAt: snapshot2At,
          extractor: 'default-extractor',
          title: 'Thread',
          summary: 'Summary',
          ...emptySnapshotSignals(),
          content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
          references: ['turn-13', 'turn-14'],
        },
      ],
    },
    extractionTable: {},
  }, checkpoint);
  t.after(async () => extractor.shutdown());

  const restored = await extractor.restore();

  assert.equal(restored.committedEpoch, 14);
  assert.deepEqual(restored.pendingTurns, []);
  assert.deepEqual(restored.threads[0].snapshotIds, ['snapshot-0', 'snapshot-1', 'snapshot-2']);
  assert.deepEqual(restored.threads[0].snapshotEpochs, [12, 13, 14]);
});

test('extractor restore falls back when session delta refs are missing turn epochs', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath, { activeWindowDays: 7 });

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify(makeCheckpointContent({
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    extractor: makeExtractorCheckpoint({
      threads: [{
        sessionId: 'obs-1',
        latestSnapshotId: 'snapshot-0',
        latestSnapshotSequence: 0,
        indexedSnapshotSequence: 0,
        updatedAt: '2024-01-01T00:00:00Z',
      }],
    }),
  }), null, 2)}\n`, 'utf8');

  const checkpoint = (await readCheckpointFile())?.extractor ?? null;
  const extractor = new Extractor({
    turnTable: {
      loadTurnsAfterEpoch: async () => [makeExtractableTurn('turn-13', 13, 'epoch13')],
    },
    sessionTable: {
      delta: async () => ({
        sourceVersion: 21,
        rows: [
          {
            snapshotId: 'snapshot-1',
            sessionId: 'obs-1',
            project: 'project-a',
            cwd: '/workspace/project-a',
            agent: 'agent-a',
            snapshotSequence: 1,
            createdAt: '2024-01-01T00:00:01Z',
            updatedAt: '2024-01-01T00:00:01Z',
            extractor: 'default-extractor',
            title: 'Thread',
            summary: 'Summary',
            ...emptySnapshotSignals(),
            content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
            references: ['missing-turn'],
          },
        ],
      }),
      threadSnapshots: async () => [
        {
          snapshotId: 'snapshot-0',
          sessionId: 'obs-1',
          project: 'project-a',
          cwd: '/workspace/project-a',
          agent: 'agent-a',
          snapshotSequence: 0,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          extractor: 'default-extractor',
          title: 'Thread',
          summary: 'Summary',
          ...emptySnapshotSignals(),
          content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
          references: [],
        },
      ],
    },
    extractionTable: {},
  }, checkpoint);
  t.after(async () => extractor.shutdown());

  const restored = await extractor.restore();

  assert.equal(restored, null);
});

test('extractor restore skips stale threads resource only from session delta', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath, { activeWindowDays: 7 });
  const staleUpdatedAt = new Date(Date.now() - 4000 * 24 * 60 * 60 * 1000).toISOString();

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify(makeCheckpointContent({
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    extractor: makeExtractorCheckpoint({ threads: [] }),
  }), null, 2)}\n`, 'utf8');

  const checkpoint = (await readCheckpointFile())?.extractor ?? null;
  const staleRow = {
    snapshotId: 'snapshot-1',
    sessionId: 'obs-stale',
    project: 'project-a',
    cwd: '/workspace/project-a',
    agent: 'agent-a',
    snapshotSequence: 0,
    createdAt: staleUpdatedAt,
    updatedAt: staleUpdatedAt,
    extractor: 'default-extractor',
    title: 'Stale Thread',
    summary: 'Summary',
    ...emptySnapshotSignals(),
    content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
    references: ['turn-13'],
  };
  const extractor = new Extractor({
    turnTable: {
      loadTurnsAfterEpoch: async () => [makeExtractableTurn('turn-13', 13, 'epoch13')],
    },
    sessionTable: {
      delta: async () => ({ sourceVersion: 21, rows: [staleRow] }),
      threadSnapshots: async () => [staleRow],
    },
    extractionTable: {},
  }, checkpoint);
  t.after(async () => extractor.shutdown());

  const restored = await extractor.restore();

  assert.equal(restored.committedEpoch, 13);
  assert.equal(restored.threads.length, 0);
  assert.deepEqual(restored.pendingTurns, []);
});

test('extractor restore rebuilds delta-only threads from full history', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath, { activeWindowDays: 7 });
  const rowTimes = Array.from({ length: 8 }, (_, index) => new Date(Date.now() - (8 - index) * 1000).toISOString());

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify(makeCheckpointContent({
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    extractor: makeExtractorCheckpoint({ committedEpoch: 5, nextEpoch: 6, threads: [] }),
  }), null, 2)}\n`, 'utf8');

  const checkpoint = (await readCheckpointFile())?.extractor ?? null;
  const fullRows = Array.from({ length: 8 }, (_, index) => ({
    snapshotId: `snapshot-${index}`,
    sessionId: 'extraction-session',
    project: 'project-a',
    cwd: '/workspace/project-a',
    agent: 'agent-a',
    snapshotSequence: index,
    createdAt: rowTimes[index],
    updatedAt: rowTimes[index],
    extractor: 'default-extractor',
    title: 'Extraction Thread',
    summary: `Summary ${index}`,
    ...emptySnapshotSignals(),
    content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
    references: Array.from({ length: index + 1 }, (_, turnIndex) => `turn-${turnIndex + 1}`),
  }));
  const turnById = new Map(fullRows.map((row, index) => [
    `turn-${index + 1}`,
    makeExtractableTurn(`turn-${index + 1}`, index + 1, `epoch${index + 1}`),
  ]));
  const extractor = new Extractor({
    turnTable: {
      loadTurnsAfterEpoch: async () => [
        turnById.get('turn-6'),
        turnById.get('turn-7'),
        turnById.get('turn-8'),
      ],
      getTurn: async (turnId) => turnById.get(turnId) ?? null,
    },
    sessionTable: {
      delta: async () => ({ sourceVersion: 21, rows: [fullRows[6], fullRows[7]] }),
      threadSnapshots: async () => fullRows,
    },
    extractionTable: {},
  }, checkpoint);
  t.after(async () => extractor.shutdown());

  const restored = await extractor.restore();

  assert.equal(restored.committedEpoch, 8);
  assert.deepEqual(restored.pendingTurns, []);
  assert.deepEqual(
    restored.threads[0].snapshotIds,
    fullRows.map((row) => row.snapshotId),
  );
});

test('extractor bootstrap skips stale checkpoint threads', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath, { activeWindowDays: 7 });

  const staleUpdatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify(makeCheckpointContent({
    writtenAt: new Date().toISOString(),
    writerPid: 123,
    extractor: makeExtractorCheckpoint({
      threads: [{
        sessionId: 'stale-thread',
        latestSnapshotId: 'turn:42',
        latestSnapshotSequence: 0,
        indexedSnapshotSequence: 0,
        updatedAt: staleUpdatedAt,
      }],
    }),
  }), null, 2)}\n`, 'utf8');

  const checkpoint = (await readCheckpointFile())?.extractor ?? null;
  const extractor = new Extractor({
    turnTable: {
      stats: async () => ({
        version: 10,
        fragmentCount: 1,
        rowCount: 0,
      }),
      loadTurnsAfterEpoch: async () => [],
    },
    sessionTable: {
      delta: async () => ({ sourceVersion: 21, rows: [] }),
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
  t.after(async () => extractor.shutdown());

  await extractor.ensureBootstrapped();

  assert.equal(extractor.threads.length, 0);
  assert.equal(extractor.committedEpoch, 12);
  assert.equal(extractor.openEpoch.epoch, 13);
});

test('extractor exportCheckpoint keeps the last committed snapshot while extractCurrentEpoch is mid-flight', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  const entered = deferred();
  const release = deferred();
  const checkpoint = (await readCheckpointFile())?.extractor ?? null;
  const extractor = new Extractor({
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
      get: async () => [],
      upsert: async () => undefined,
      stats: async () => ({
        version: 7,
        fragmentCount: 1,
        rowCount: 1,
      }),
    },
  }, checkpoint);
  t.after(async () => extractor.shutdown());

  extractor.bootstrapped = true;
  extractor.committedEpoch = 0;
  extractor.openEpoch = new OpenEpoch(2);
  extractor.threads = [{
    sessionId: 'session-a',
    snapshotId: 'snapshot-0',
    snapshotIds: ['snapshot-0'],
    extractionEpoch: 0,
    title: 'Existing title',
    summary: 'Existing summary',
    snapshots: [
      { extractions: [], contextRefs: [], nextSteps: [], extractionDelta: { before: [], after: [] } },
    ],
    references: ['session:existing'],
    indexedSnapshotSequence: 0,
    extractor: 'default-extractor',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  }];
  extractor.refreshCheckpointSnapshot();
  extractor.currentEpoch = {
    epoch: 1,
    turns: [makeExtractableTurn('turn-1', 1, 'first')],
  };

  let midFlight;
  extractor.indexCurrentEpochSnapshots = async () => {
    midFlight = extractor.exportCheckpoint();
    entered.resolve();
    await release.promise;
  };

  const extractPromise = extractor.extractCurrentEpoch();
  await entered.promise;

  assert.deepEqual(midFlight, {
    committedEpoch: 0,
    nextEpoch: 2,
    runs: [],
    threads: [{
      sessionId: 'session-a',
      latestSnapshotId: 'snapshot-0',
      latestSnapshotSequence: 0,
      indexedSnapshotSequence: 0,
      updatedAt: '2024-01-01T00:00:00Z',
    }],
  });

  release.resolve();
  await extractPromise;

  const committed = extractor.exportCheckpoint();
  assert.equal(committed.committedEpoch, 1);
  assert.equal(committed.nextEpoch, 2);
  assert.deepEqual(committed.threads, extractor.threads.map((thread) => ({
    sessionId: thread.sessionId,
    latestSnapshotId: thread.snapshotId,
    latestSnapshotSequence: thread.snapshots.length - 1,
    indexedSnapshotSequence: thread.indexedSnapshotSequence ?? null,
    updatedAt: thread.updatedAt,
  })));
});

test('extractor bootstrap ignores extraction version mismatches when session baseline matches', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify(makeCheckpointContent({
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    extractor: makeExtractorCheckpoint({
      threads: [{
        sessionId: 'obs-1',
        latestSnapshotId: 'turn:42',
        latestSnapshotSequence: 1,
        indexedSnapshotSequence: 1,
        updatedAt: '2024-01-01T00:00:01Z',
      }],
    }),
  }), null, 2)}\n`, 'utf8');

  let listSnapshotsCalls = 0;
  const checkpoint = (await readCheckpointFile())?.extractor ?? null;
  const extractor = new Extractor({
    turnTable: {
      stats: async () => ({
        version: 10,
        fragmentCount: 1,
        rowCount: 1,
      }),
      loadTurnsAfterEpoch: async () => [],
    },
    sessionTable: {
      delta: async () => ({ sourceVersion: 21, rows: [] }),
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
          project: 'project-a',
          cwd: '/workspace/project-a',
          agent: 'agent-a',
          snapshotSequence: 0,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          extractor: 'default-extractor',
          title: 'Thread',
          summary: 'Summary',
          ...emptySnapshotSignals(),
          content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
          references: [],
        },
        {
          snapshotId: 'turn:42',
          sessionId: 'obs-1',
          project: 'project-a',
          cwd: '/workspace/project-a',
          agent: 'agent-a',
          snapshotSequence: 1,
          createdAt: '2024-01-01T00:00:01Z',
          updatedAt: '2024-01-01T00:00:01Z',
          extractor: 'default-extractor',
          title: 'Thread',
          summary: 'Summary',
          ...emptySnapshotSignals(),
          content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
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
  t.after(async () => extractor.shutdown());

  await extractor.ensureBootstrapped();

  assert.equal(listSnapshotsCalls, 0);
  assert.equal(extractor.exportCheckpoint().committedEpoch, 12);
});

test('readCheckpointFile throws when the checkpoint section is structurally invalid', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
  await writeFile(resolveCheckpointPath(), `${JSON.stringify(makeCheckpointContent({
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    extractor: makeExtractorCheckpoint({
      baseline: { turn: 'bad-turn-version' },
    }),
  }), null, 2)}\n`, 'utf8');

  await assert.rejects(
    () => readCheckpointFile(),
    /checkpoint extractor section is invalid/i,
  );
});

test('muninn.memoryFinalize triggers drain and returns pending watermark without blocking', async () => {
  const muninn = MuninnBackend.createForTests({});
  let extractorFinalizeCalls = 0;
  let extractorWatermarkCalls = 0;
  let extractorFlushCalls = 0;
  let checkpointFlushCalls = 0;

  const extractor = {
    finalize: async () => {
      extractorFinalizeCalls += 1;
      return {
        pending: { turns: ['turn:pending'] },
        phases: { extractor: 'running' },
      };
    },
    flushPending: async () => {
      extractorFlushCalls += 1;
      throw new Error('memoryFinalize must not synchronously flush extractor');
    },
    watermark: async () => {
      extractorWatermarkCalls += 1;
      return extractorWatermarkCalls === 1
        ? {
            pending: { turns: ['turn:pending'] },
            phases: { extractor: 'running' },
          }
        : {
            pending: { turns: [] },
            phases: { extractor: 'idle' },
          };
    },
    shutdown: async () => {},
  };
  muninn.extractor = extractor;
  muninn.ensureExtractor = async () => extractor;
  muninn.watchdog = {
    flushCheckpoint: async () => {
      checkpointFlushCalls += 1;
    },
  };

  const watermark = await muninn.memoryFinalize();

  assert.equal(extractorFinalizeCalls, 1);
  assert.equal(extractorFlushCalls, 0);
  assert.deepEqual(watermark.pending.turns, ['turn:pending']);
  assert.equal(watermark.phases.extractor, 'running');

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(checkpointFlushCalls, 1);
});

test('recallMemories searches extraction routes and enriches hits', async () => {
  const calls = [];
  const client = {
    turnTable: {
      getTurn: async (turnId) => {
        if (turnId !== 'turn:session-2') {
          return null;
        }
        return {
          turnId,
          sessionId: 'session-2',
          project: 'memory-project',
          cwd: '/workspace/memory-project',
          agent: 'codex',
          extractor: 'default-extractor',
          events: [],
          createdAt: '2024-01-02T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        };
      },
    },
    sessionTable: {
      threadSnapshots: async (sessionId) => (
        sessionId === 'session-2'
          ? [{
            snapshotId: 'session:snapshot-2',
            sessionId,
            project: 'memory-project',
            cwd: '/workspace/memory-project',
            agent: 'codex',
            snapshotSequence: 1,
            createdAt: '2024-01-03T00:00:00Z',
            updatedAt: '2024-01-03T00:00:00Z',
            extractor: 'default-extractor',
            title: 'Readable session title',
            summary: 'Readable summary',
            ...emptySnapshotSignals(),
            content: 'Readable content',
            references: ['turn:session-2'],
          }]
          : []
      ),
    },
    extractionTable: {
      search: async (params) => {
        calls.push(params);
        const title = 'Counseling work';
        const summary = 'Caroline is interested in counseling work.';
        return [{
          id: 'raw-2',
          title,
          summary: title + '\n\n' + summary,
          content: extractionContent(title, summary),
          vector: [],
          turnRefs: ['turn:session-2'],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        }];
      },
    },
  };

  const hits = await recallMemories(client, 'What are Caroline plans?', 3, { embed: async () => [1, 0] });

  assert.deepEqual(hits, [
    {
      memoryId: 'extraction:raw-2',
      title: 'Counseling work',
      summary: 'Counseling work\n\nCaroline is interested in counseling work.',
      content: extractionContent('Counseling work', 'Caroline is interested in counseling work.'),
      references: ['turn:session-2'],
      project: 'memory-project',
      sessionId: 'session-2',
      agent: 'codex',
      cwd: '/workspace/memory-project',
      sessionKey: 'cwd:/workspace/memory-project|session:session-2|agent:codex|extractor:default-extractor',
      displaySession: 'Readable session title',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
  ]);
  assert.deepEqual(calls[0], {
    query: 'What are Caroline plans?',
    vector: [1, 0],
    limit: 3,
    mode: 'hybrid',
  });
  assert.equal(calls.length, 1);
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
  let seenCandidates = [];
  const client = {
    extractionTable: {
      search: async (params) => {
        calls.push(params);
        return [
          {
            id: 'ext-1',
            title: 'Summer outing',
            summary: 'Caroline and Melanie planned a summer outing.',
            content: extractionContent('Summer outing', 'Caroline and Melanie planned a summer outing.'),
            vector: [],
            turnRefs: ['D12:17'],
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
          {
            id: 'ext-2',
            title: 'Adoption research',
            summary: 'Caroline researched adoption agencies.',
            content: extractionContent('Adoption research', 'Caroline researched adoption agencies.'),
            vector: [],
            turnRefs: ['D2:8'],
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        ];
      },
    },
  };

  const hits = await recallMemories(client, "What are Caroline's plans for the summer?", 0, {
    budget: 80,
    queryLimit: 20,
    embed: async () => [1, 0],
    recallMemory: async (input) => {
      seenCandidates = input.candidates;
      return {
        content: 'Caroline researched adoption agencies.',
        refs: ['D2:8'],
      };
    },
  });

  assert.deepEqual(hits, [{
    memoryId: 'recalled:memory',
    content: 'Caroline researched adoption agencies.',
    references: ['D12:17', 'D2:8'],
  }]);
  assert.equal(calls[0].limit, 20);
  assert.deepEqual(seenCandidates.map((candidate) => candidate.memoryId), [
    'extraction:ext-1',
    'extraction:ext-2',
  ]);
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

test('backend exportCheckpoint returns null before extractor creation', async () => {
  const checkpoint = makeCheckpointContent({
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    extractor: makeExtractorCheckpoint({ threads: [] }),
  });
  const backend = MuninnBackend.createForTests({}, checkpoint);

  const exported = await backend.exportCheckpoint();

  assert.equal(exported, null);
});

test('session registry reuses one in-flight session load per key', async () => {
  const registry = new IngestSessionRegistry({
    turnTable: {},
  }, 'default-extractor');

  const first = registry.load('group-a', 'agent-a', { project: 'project-a', cwd: '/workspace/project-a' });
  const second = registry.load('group-a', 'agent-a', { project: 'project-a', cwd: '/workspace/project-a' });
  await Promise.resolve();

  const [firstSession, secondSession] = await Promise.all([first, second]);
  assert.strictEqual(firstSession, secondSession);
});

test('session key normalizes sessionId whitespace', async () => {
  assert.equal(
    sessionKey('group-a', 'agent-a', 'default-extractor'),
    sessionKey(' group-a ', 'agent-a', 'default-extractor'),
  );
  assert.equal(normalizeSessionId(' group-a '), 'group-a');
  assert.equal(normalizeSessionId('   '), undefined);
});

test('session registry reuses the same load for trimmed session ids', async () => {
  const registry = new IngestSessionRegistry({
    turnTable: {},
  }, 'default-extractor');

  const first = registry.load('group-a', 'agent-a', { project: 'project-a', cwd: '/workspace/project-a' });
  const second = registry.load(' group-a ', 'agent-a', { project: 'project-a', cwd: '/workspace/project-a' });
  const [firstSession, secondSession] = await Promise.all([first, second]);

  assert.strictEqual(firstSession, secondSession);
});

test('session registry separates same raw session id across cwd ownership', async () => {
  const registry = new IngestSessionRegistry({
    turnTable: {},
  }, 'default-extractor');

  const first = registry.load('group-a', 'agent-a', { project: 'project-a', cwd: '/workspace/project-a' });
  const second = registry.load('group-a', 'agent-a', { project: 'project-b', cwd: '/workspace/project-b' });
  const [firstSession, secondSession] = await Promise.all([first, second]);

  assert.notStrictEqual(firstSession, secondSession);
});

test('session registry treats project as display metadata for the same cwd identity', async () => {
  const registry = new IngestSessionRegistry({
    turnTable: {},
  }, 'default-extractor');

  const first = registry.load('group-a', 'agent-a', { project: 'project-a', cwd: '/workspace/shared' });
  const second = registry.load('group-a', 'agent-a', { project: 'project-b', cwd: '/workspace/shared' });
  const [firstSession, secondSession] = await Promise.all([first, second]);

  assert.strictEqual(firstSession, secondSession);
});

test('session registry restores live sessions for checkpoint recent turns', async () => {
  const registry = new IngestSessionRegistry({
    turnTable: {},
  }, 'default-extractor');

  registry.restoreSession('group-a', 'agent-a', { project: 'project-a', cwd: '/workspace/project-a' }, [{
    turnId: 'turn:101',
    updatedAt: '2024-01-01T00:00:00Z',
    prompt: 'pending prompt',
    response: '',
  }]);

  const session = await registry.load('group-a', 'agent-a', { project: 'project-a', cwd: '/workspace/project-a' });
  const exported = session.exportRecentSession();
  assert.deepEqual(exported?.turns.map((turn) => turn.turnId), ['turn:101']);
});

test('session registry replays persisted turns into recent windows', async () => {
  const registry = new IngestSessionRegistry({
    turnTable: {},
  }, 'default-extractor');

  registry.restoreSession('group-a', 'agent-a', { project: 'project-a', cwd: '/workspace/project-a' }, [makeRecentTurn('turn:101', 'checkpoint')]);
  registry.rememberTurn(makePersistedTurn('turn:102', 'delta'));

  const exported = (await registry.load('group-a', 'agent-a', { project: 'project-a', cwd: '/workspace/project-a' })).exportRecentSession();
  assert.deepEqual(
    exported?.turns.map((turn) => turn.turnId),
    ['turn:101', 'turn:102'],
  );
});

test('session.accept serializes concurrent inserts for the same session', async () => {
  let concurrentInserts = 0;
  let maxConcurrentInserts = 0;
  let nextTurnId = 1;

  const session = new IngestSession({
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
    extractor: 'default-extractor',
    project: 'project-a',
    cwd: '/workspace/project-a',
  });

  const first = session.accept(makeTurnContent('first prompt', 'first response'), 1);
  const second = session.accept(makeTurnContent('second prompt', 'second response'), 1);

  const [firstTurn, secondTurn] = await Promise.all([first, second]);
  assert.equal(maxConcurrentInserts, 1);
  assert.notEqual(firstTurn.turn.turnId, secondTurn.turn.turnId);
  assert.equal(firstTurn.turn.prompt, 'first prompt');
  assert.equal(secondTurn.turn.prompt, 'second prompt');
  assert.equal(firstTurn.deduped, false);
  assert.equal(secondTurn.deduped, false);
});

test('session.accept dedupes turnSequence against the recent three turns', async () => {
  let nextTurnId = 1;
  const insertedTurns = new Map();

  const session = new IngestSession({
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
    extractor: 'default-extractor',
    project: 'project-a',
    cwd: '/workspace/project-a',
  });

  const accepted = [];
  for (const [index, prompt] of ['A', 'B', 'C'].entries()) {
    accepted.push(await session.accept(makeTurnContent(prompt, `${prompt}-response`, { turnSequence: index }), 1));
  }

  const duplicate = await session.accept(makeTurnContent('changed A', 'changed A-response', { turnSequence: 0 }), 1);
  assert.equal(duplicate.deduped, true);
  assert.equal(duplicate.turn, null);

  const fourth = await session.accept(makeTurnContent('D', 'D-response', { turnSequence: 3 }), 1);
  assert.equal(fourth.deduped, false);

  const expiredDuplicate = await session.accept(makeTurnContent('A', 'A-response', { turnSequence: 0 }), 1);
  assert.equal(expiredDuplicate.deduped, false);
  assert.notEqual(expiredDuplicate.turn.turnId, accepted[0].turn.turnId);
});

test('session.accept prefers turnSequence for recent duplicate detection', async () => {
  let nextTurnId = 1;
  const insertedTurns = new Map();

  const session = new IngestSession({
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
    extractor: 'default-extractor',
    project: 'project-a',
    cwd: '/workspace/project-a',
  });

  const first = await session.accept(makeTurnContent('A', 'A-response', { turnSequence: 1 }), 1);
  const sequenceDuplicate = await session.accept(makeTurnContent('changed prompt', 'changed response', { turnSequence: 1 }), 1);
  const sameTextDifferentSequence = await session.accept(makeTurnContent('A', 'A-response', { turnSequence: 2 }), 1);

  assert.equal(first.deduped, false);
  assert.equal(sequenceDuplicate.deduped, true);
  assert.equal(sequenceDuplicate.turn, null);
  assert.equal(sameTextDifferentSequence.deduped, false);
});

test('session.accept attaches recent three turns as transient extraction context', async () => {
  let nextTurnId = 1;
  const session = new IngestSession({
    turnTable: {
      insert: async ({ turns }) => turns.map((turn) => ({
        ...turn,
        turnId: `turn:${nextTurnId++}`,
      })),
    },
  }, {
    sessionId: 'group-a',
    agent: 'agent-a',
    extractor: 'default-extractor',
    project: 'project-a',
    cwd: '/workspace/project-a',
  });

  for (const prompt of ['A', 'B', 'C']) {
    await session.accept(makeTurnContent(prompt, `${prompt}-response`), 1);
  }

  const accepted = await session.accept(makeTurnContent('D', 'D-response'), 1);

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

  const session = new IngestSession({
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
    extractor: 'default-extractor',
    project: 'project-a',
    cwd: '/workspace/project-a',
    recentTurns: [
      makeRecentTurn('turn:stale-1', 'stale', { turnSequence: 7 }),
      makeRecentTurn('turn:stale-2', 'stale', { turnSequence: 7 }),
    ],
  });

  const accepted = await session.accept(makeTurnContent('stale prompt', 'stale response', { turnSequence: 7 }), 1);

  assert.equal(accepted.deduped, false);
  assert.equal(accepted.turn.turnId, 'turn:1');
  assert.deepEqual(
    session.exportRecentSession()?.turns.map((turn) => turn.turnId),
    ['turn:1'],
  );
});

test('open epoch skips deduped turns when staging extractable turns', async () => {
  const epoch = new OpenEpoch(7);
  const dedupedTurn = {
    turnId: 'turn:1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    sessionId: 'group-a',
    agent: 'agent-a',
    extractor: 'default-extractor',
    title: 'title',
    summary: 'summary',
    toolCalls: null,
    artifacts: null,
    prompt: 'prompt',
    response: 'response',
    extractionEpoch: 7,
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

test('extractor.extractCurrentEpoch keeps thread state unchanged when pre-commit work fails', async () => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  try {
    const extractor = new Extractor({
      sessionTable: {
        insert: async () => {
          throw new Error('persist failed');
        },
      },
      extractionTable: {
        delete: async () => ({ deleted: 0 }),
        get: async () => [],
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
      extractor: 'default-extractor',
      summary: 'pending summary',
      response: 'pending response',
      extractionEpoch: 1,
    };
    const originalThreads = [{
      threadId: 'session-a',
      sessionId: 'session-a',
      kind: 'session',
      snapshotId: 'snapshot-0',
      snapshotIds: ['snapshot-0'],
      extractionEpoch: 0,
      title: 'Existing title',
      summary: 'Existing summary',
      snapshots: [
        { extractions: [], contextRefs: [], nextSteps: [], extractionDelta: { before: [], after: [] } },
      ],
      references: ['turn:existing'],
      indexedSnapshotSequence: 0,
      extractor: 'default-extractor',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }];

    extractor.bootstrapped = true;
    extractor.openEpoch = new OpenEpoch(2);
    extractor.currentEpoch = { epoch: 1, turns: [turn] };
    extractor.threads = structuredClone(originalThreads);

    await assert.rejects(() => extractor.extractCurrentEpoch(), /persist failed/);
    assert.deepEqual(extractor.threads, originalThreads);
    assert.deepEqual(extractor.currentEpoch, { epoch: 1, turns: [turn] });
    assert.equal(extractor.committedEpoch, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('snapshot extraction state rewrite updates and deletes extraction rows', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  const rows = [];
  const deleted = [];
  const client = {
    extractionTable: {
      get: async ({ ids }) => ids.map((id) => ({
        ...storedExtraction(id),
        title: `${id} old title`,
        summary: `${id} old summary`,
        content: `## Title\n\n${id} old title\n\n## Summary\n\n${id} old summary\n\n## Content\n\nold context`,
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
    { id: 'obs-a', title: 'Old career', text: 'obs-a old text', context: 'old context', references: ['turn:1'] },
    { id: 'obs-b', title: 'Old low value memory', text: 'obs-b old text', references: ['turn:2'] },
  ], {
    title: 'T',
    snapshotContent: 'S',
    extractions: [
      { id: 'obs-a', title: 'Career plan', text: 'updated career memory', context: 'updated context', references: ['turn:2'] },
      { title: 'Painting preference', text: 'new painting memory', context: 'new context', references: ['turn:3'] },
    ],
    nextSteps: [],
    contextRefs: [],
  });
  await applyExtractionTableChanges(client, {
    project: 'project-a',
    cwd: '/workspace/project-a',
    agent: 'agent-a',
    snapshotContent: 'S',
    extractions: state.extractions,
    contextRefs: [],
    extractionChanges: state.extractionChanges,
  }, 'turn:12');

  assert.deepEqual(deleted.sort(), ['obs-b']);
  assert.equal(rows.length, 2);
  const updatedRow = rows.find((row) => row.id === 'obs-a');
  const addedRow = rows.find((row) => row.title === 'Painting preference');
  assert.equal(updatedRow.title, 'Career plan');
  assert.equal(updatedRow.summary, 'Career plan\n\nupdated career memory');
  assert.equal(updatedRow.content, '## Title\n\nCareer plan\n\n## Summary\n\nupdated career memory\n\n## Content\n\nupdated context');
  assert.equal(updatedRow.text, undefined);
  assert.equal(updatedRow.context, undefined);
  assert.equal(updatedRow.category, undefined);
  assert.equal(updatedRow.anchors, undefined);
  assert.deepEqual(updatedRow.turnRefs, ['turn:2']);
  assert.equal(addedRow.title, 'Painting preference');
  assert.equal(addedRow.summary, 'Painting preference\n\nnew painting memory');
  assert.equal(addedRow.content, '## Title\n\nPainting preference\n\n## Summary\n\nnew painting memory\n\n## Content\n\nnew context');
  assert.equal(addedRow.category, undefined);
  assert.equal(addedRow.anchors, undefined);
  assert.deepEqual(addedRow.turnRefs, ['turn:3']);
});

test('extraction state rewrite computes update add and delete changes', () => {
  const current = [
    { id: 'obs-a', title: 'Old career', text: 'old career memory', references: ['turn:1'] },
    { id: 'obs-b', title: 'Old low value memory', text: 'old low value memory', references: ['turn:2'] },
  ];

  const result = applyExtractionChanges(current, {
    title: 'T',
    snapshotContent: 'S',
    extractions: [
      { id: 'obs-a', title: 'Career plan', text: 'updated career memory', references: ['turn:1', 'turn:3'] },
      { title: 'Painting preference', text: 'new painting memory', references: ['turn:4'] },
    ],
    nextSteps: [],
    contextRefs: [],
  });

  assert.deepEqual(result.extractionChanges.map((change) => change.type), ['update', 'add', 'delete']);
  assert.equal(result.extractions[0].id, 'obs-a');
  assert.equal(result.extractions[0].title, 'Career plan');
  assert.deepEqual(result.extractions[0].references, ['turn:1', 'turn:3']);
  assert.equal(result.extractions[1].title, 'Painting preference');
  assert.match(result.extractions[1].id, /^[a-f0-9]{24}$/);
});

test('extraction state rewrite rejects unknown and duplicate ids', () => {
  const current = [{ id: 'obs-a', title: 'A', text: 'A', references: ['turn:1'] }];

  assert.throws(
    () => applyExtractionChanges(current, {
      title: 'T',
      snapshotContent: 'S',
      extractions: [{ id: 'missing', title: 'Updated', text: 'updated', references: ['turn:1'] }],
      nextSteps: [],
      contextRefs: [],
    }),
    /unknown extraction id/i,
  );

  assert.throws(
    () => applyExtractionChanges(current, {
      title: 'T',
      snapshotContent: 'S',
      extractions: [
        { id: 'obs-a', title: 'Updated', text: 'updated', references: ['turn:1'] },
        { id: 'obs-a', title: 'Duplicate', text: 'duplicate', references: ['turn:1'] },
      ],
      nextSteps: [],
      contextRefs: [],
    }),
    /duplicate extraction id/i,
  );
});

test('session extraction batch input uses turn headings without horizontal rules', () => {
  const rendered = extractorLlmTesting.renderNewTurnsForTests([
    {
      turnId: 'turn:1',
      prompt: 'First prompt',
      response: 'First response',
      summary: 'First summary should not be rendered',
    },
    {
      turnId: 'turn:2',
      prompt: 'Second prompt',
      response: 'Second response',
      summary: 'Second summary should not be rendered',
    },
  ]);

  assert.match(rendered, /## Current Batch Turns/);
  assert.match(rendered, /### turn:1/);
  assert.match(rendered, /### turn:2/);
  assert.match(rendered, /Prompt \(instruction signal evidence\):\nFirst prompt/);
  assert.match(rendered, /Response \(workflow context, not instruction signal evidence\):\nFirst response/);
  assert.doesNotMatch(rendered, /^----$/m);
  assert.doesNotMatch(rendered, /Summary:/);
});

test('session extraction batch input previews long responses and Codex prompt plans', () => {
  const longPlan = `${'p'.repeat(900)}middle${'q'.repeat(900)}`;
  const longResponse = `${'a'.repeat(900)}middle${'z'.repeat(900)}`;
  const rendered = extractorLlmTesting.renderNewTurnsBudgetForTests([{
    turnId: '123',
    prompt: `before <proposed_plan>${longPlan}</proposed_plan> after`,
    response: longResponse,
  }], { previewChars: 800 });

  assert.match(rendered.markdown, /## Current Batch Turns/);
  assert.match(rendered.markdown, /<proposed_plan>/);
  assert.match(rendered.markdown, /prompt plan middle omitted; omittedChars=/);
  assert.match(rendered.markdown, /response middle omitted; omittedChars=/);
  assert.match(rendered.markdown, /get_turn turnId=123/);
  assert.equal(rendered.turns[0].records.some((record) => record.reason === 'prompt-proposed-plan-preview'), true);
  assert.equal(rendered.turns[0].records.some((record) => record.reason === 'response-preview'), true);
});

test('session extraction batch input folds response code and diff fences before response preview', () => {
  const code = `\`\`\`ts\n${'const value = 1;\n'.repeat(120)}\`\`\``;
  const diff = `\`\`\`diff\ndiff --git a/a b/a\n${'+ changed\n'.repeat(120)}\`\`\``;
  const rendered = extractorLlmTesting.renderNewTurnsBudgetForTests([{
    turnId: '456',
    prompt: 'Inspect the generated response.',
    response: `${code}\n\n${diff}`,
  }], { previewChars: 300 });

  assert.equal(rendered.turns[0].records.some((record) => record.reason === 'code-fence'), true);
  assert.equal(rendered.turns[0].records.some((record) => record.reason === 'diff-log-or-command-output'), true);
  assert.equal(rendered.turns[0].records.some((record) => record.reason === 'response-preview'), true);
});

test('indexPendingExtractions surfaces extraction write failures and leaves work pending', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  const threads = [
    {
      sessionId: 'session-a',
      project: 'alpha',
      cwd: '/workspace/alpha',
      agent: 'codex',
      snapshotId: 'snapshot-1',
      snapshotIds: ['snapshot-0', 'snapshot-1'],
      extractionEpoch: 7,
      title: 'Title',
      summary: 'Summary',
      snapshots: [
        {
          project: 'alpha',
          cwd: '/workspace/alpha',
          agent: 'codex',
          snapshotContent: '',
          extractions: [],
          contextRefs: [],
          nextSteps: [],
          extractionChanges: [],
        },
        {
          project: 'alpha',
          cwd: '/workspace/alpha',
          agent: 'codex',
          snapshotContent: '',
          extractions: [{ id: 'memory-1', text: 'remember this', category: 'Fact', references: ['session:existing'], updatedMemory: null }],
          contextRefs: [],
          nextSteps: [],
          extractionChanges: [{
            type: 'update',
            extractionId: 'memory-1',
            text: 'remember this',
            reason: 'refreshes the existing extraction wording',
          }],
        },
      ],
      references: [],
      indexedSnapshotSequence: 0,
      extractor: 'default-extractor',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
  ];
  let semanticUpserts = 0;

  await assert.rejects(
    () => indexTesting.indexPendingExtractions({
      sessionTable: {
        update: async ({ snapshots }) => snapshots,
      },
      extractionTable: {
        delete: async () => ({ deleted: 0 }),
        get: async () => [],
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

test('extractor validation derives extractions from titled snapshot content', () => {
  const result = extractorLlmTesting.validateSessionExtractionResultForTests(
    snapshotContentFixture([
      '<!-- refs: [turn:13] -->',
      '### Title',
      'Lake sunrise painting',
      '',
      '### Summary',
      'Melanie painted a lake sunrise in 2022.',
      '',
      '### Content',
      'Caroline asked whether Melanie painted the lake sunrise herself.',
      '',
      '----',
      '',
      '<!-- refs: [turn:13] -->',
      '### Title',
      'Special lake painting',
      '',
      '### Summary',
      'The lake sunrise painting is special to Melanie.',
    ].join('\n'), {
      title: 'Melanie Painting',
      summary: 'Melanie painted a lake sunrise in 2022.',
    }),
    {
      sessionMemory: {
        title: 'Painting',
        summary: '',
        extractions: [],
        nextSteps: [],
      },
      turns: [{
        turnId: 'turn:13',
        prompt: 'Did Melanie paint the lake sunrise herself?',
        response: 'Melanie says she painted the lake sunrise in 2022, described as last year relative to 8 May 2023.',
        summary: 'Melanie says she painted the lake sunrise in 2022, described as last year relative to 8 May 2023.',
      }],
    },
  );

  assert.equal(result.title, 'Melanie Painting');
  assert.equal(result.summary, 'Melanie painted a lake sunrise in 2022.');
  assert.deepEqual(result.contextRefs, [{
    turnId: 'turn:13',
    summary: 'Prompt: Did Melanie paint the lake sunrise herself? Response: Melanie says she painted the lake sunrise in 2022, described as last year relative to 8 May 2023.',
  }]);
  assert.equal(result.snapshotContent, snapshotContentFixture([
    '<!-- refs: [turn:13] -->',
    '### Title',
    'Lake sunrise painting',
    '',
    '### Summary',
    'Melanie painted a lake sunrise in 2022.',
    '',
    '### Content',
    'Caroline asked whether Melanie painted the lake sunrise herself.',
    '',
    '----',
    '',
    '<!-- refs: [turn:13] -->',
    '### Title',
    'Special lake painting',
    '',
    '### Summary',
    'The lake sunrise painting is special to Melanie.',
  ].join('\n'), {
    title: 'Melanie Painting',
    summary: 'Melanie painted a lake sunrise in 2022.',
  }));
  assert.deepEqual(result.extractions, [{
    title: 'Lake sunrise painting',
    text: 'Melanie painted a lake sunrise in 2022.',
    context: 'Caroline asked whether Melanie painted the lake sunrise herself.',
    references: ['turn:13'],
  }, {
    title: 'Special lake painting',
    text: 'The lake sunrise painting is special to Melanie.',
    context: null,
    references: ['turn:13'],
  }]);
});

test('extractor validation preserves session-level signals in snapshot content', () => {
  const result = extractorLlmTesting.validateSessionExtractionResultForTests(
    snapshotContentFixture([
      '<!-- refs: [turn:13] -->',
      '### Title',
      'Extractor signal handling',
      '',
      '### Summary',
      'The extractor should record durable session-level signals in memory content.',
      '',
      '### Content',
      '- Keep the signal recall-ready without a rigid pseudo-schema.',
    ].join('\n'), {
      title: 'Extractor Signals',
      summary: 'Extractor prompt design refined durable signal handling.',
      memorySignals: [
        '- [turn:13 +1] The user prefers concise Markdown signals under named subsections.',
      ],
      skillSignals: [
        '- [turn:13 +1] Extractor signal review: Confirm parser support before asking the model to emit a new Markdown section.',
      ],
      skillDetails: {
        'Extractor signal review': 'Confirm parser support before asking the model to emit a new Markdown section.',
      },
    }),
    {
      sessionMemory: {
        title: 'Extractor Signals',
        summary: '',
        extractions: [],
        nextSteps: [],
      },
      turns: [{
        turnId: 'turn:13',
        summary: 'The user asked for durable signal handling in extractor memory content.',
      }],
    },
  );

  assert.deepEqual(result.memorySignals, [
    '- [turn:13 +1] The user prefers concise Markdown signals under named subsections.',
  ]);
  assert.deepEqual(result.skillSignals, [
    '- [turn:13 +1] Extractor signal review: Confirm parser support before asking the model to emit a new Markdown section.',
  ]);
  assert.equal('openQuestions' in result, false);
  assert.deepEqual(result.skillDetails, {
    'Extractor signal review': 'Confirm parser support before asking the model to emit a new Markdown section.',
  });
  assert.equal(result.extractions[0]?.context, '- Keep the signal recall-ready without a rigid pseudo-schema.');
  assert.match(result.snapshotContent, /## Instruction Signals\n- \[turn:13 \+1\] The user prefers/);
  assert.match(result.snapshotContent, /## Skill Signals\n- \[turn:13 \+1\] Extractor signal review:/);
  assert.match(result.snapshotContent, /## Skill Details\n### Extractor signal review/);
  assert.match(result.snapshotContent, /\[turn:13 \+1\] The user prefers concise Markdown signals/);
  assert.match(result.snapshotContent, /### Content\n- Keep the signal recall-ready/);
});

test('snapshot content round-trips split signal sections and skill details', () => {
  const signals = {
    memorySignals: [
      '- [turn:13 +1] Keep TypeScript session state aligned with native snapshot rows.',
    ],
    skillSignals: [
      '- [turn:13 +1] TypeScript native: Update native contracts and session snapshot state.',
    ],
    skillDetails: {
      'TypeScript native': [
        'Native rows expose split signal state.',
        '',
        'Session snapshots persist skill details as JSON.',
      ].join('\n'),
    },
  };
  const rendered = renderSnapshotContent(
    'TypeScript Native Contracts',
    'The TypeScript snapshot layer tracks split signal categories.',
    signals,
    [{
      title: 'Native contract shape',
      text: 'Session snapshots use split signal fields instead of a monolithic signals string.',
      context: null,
      references: ['turn:13'],
    }],
  );

  assert.match(rendered, /## Instruction Signals\n- \[turn:13 \+1\] Keep TypeScript session state/);
  assert.match(rendered, /## Skill Signals\n- \[turn:13 \+1\] TypeScript native:/);
  assert.doesNotMatch(rendered, /## Open Questions/);
  assert.match(rendered, /## Skill Details\n### TypeScript native/);

  const parsed = parseSnapshotContent(rendered, new Set(['turn:13']));
  assert.deepEqual(parsed.memorySignals, signals.memorySignals);
  assert.deepEqual(parsed.skillSignals, signals.skillSignals);
  assert.equal('openQuestions' in parsed, false);
  assert.deepEqual(parsed.skillDetails, signals.skillDetails);
});

test('snapshot content rejects removed Open Questions section', () => {
  assert.throws(
    () => parseSnapshotContent([
      '# Parser Boundaries',
      '',
      '## Summary',
      'Summary.',
      '',
      '## Instruction Signals',
      '',
      '## Skill Signals',
      '',
      '## Open Questions',
      '- [1] Should old signal sections be rejected?',
      '',
      '## Skill Details',
      '',
      '## Extractions',
    ].join('\n'), new Set()),
    /unsupported snapshot content document heading: ## Open Questions/i,
  );
});

test('snapshot parser treats skill details and extractions as section boundaries', () => {
  const signals = {
    memorySignals: [],
    skillSignals: [
      '- [turn:13 +1] TypeScript native: Preserve headings inside detail bodies.',
    ],
    skillDetails: {
      'TypeScript native': [
        'Skill detail can mention a heading-like line.',
        '',
        '## Summary',
        'This belongs to the skill detail body.',
      ].join('\n'),
    },
  };
  const rendered = renderSnapshotContent(
    'Parser Boundaries',
    'The parser keeps nested heading-like content inside the owning section.',
    signals,
    [{
      title: 'Extraction heading content',
      text: 'Extraction content can contain heading-like Markdown.',
      context: [
        'Context can mention a snapshot heading.',
        '',
        '## Instruction Signals',
        'This belongs to extraction content.',
      ].join('\n'),
      references: ['turn:13'],
    }],
  );

  const parsed = parseSnapshotContent(rendered, new Set(['turn:13']));
  assert.equal(parsed.skillDetails['TypeScript native'], signals.skillDetails['TypeScript native']);
  assert.equal(parsed.extractions[0].context, [
    'Context can mention a snapshot heading.',
    '',
    '## Instruction Signals',
    'This belongs to extraction content.',
  ].join('\n'));
});

test('snapshot parser rejects unknown top-level sections before extractions', () => {
  assert.throws(
    () => parseSnapshotContent([
      '# Parser Boundaries',
      '',
      '## Summary',
      'The parser rejects legacy instruction signal sections.',
      '',
      '## Memory Signals',
      '- [turn:13 +1] Legacy instruction signal section.',
      '',
      '## Extractions',
      '<!-- refs: [turn:13] -->',
      '### Title',
      'Parser boundary',
      '',
      '### Summary',
      'Legacy instruction signal sections are not accepted.',
    ].join('\n'), new Set(['turn:13'])),
    /unsupported snapshot content document heading: ## Memory Signals/i,
  );

  assert.throws(
    () => parseSnapshotContent([
      '# Parser Boundaries',
      '',
      '## Summary',
      'The parser rejects legacy signal sections.',
      '',
      '## Signals',
      '- [2] Legacy signal section.',
      '',
      '## Extractions',
      '<!-- refs: [turn:13] -->',
      '### Title',
      'Parser boundary',
      '',
      '### Summary',
      'Legacy signal sections are not accepted.',
    ].join('\n'), new Set(['turn:13'])),
    /unsupported snapshot content document heading: ## Signals/i,
  );

  assert.throws(
    () => extractorLlmTesting.validateSessionExtractionResultForTests([
      '## Signals',
      '- [2] Legacy signal section.',
    ].join('\n'), {
      sessionMemory: {
        title: 'Parser Boundaries',
        summary: 'The parser rejects legacy signal sections.',
        extractions: [],
        nextSteps: [],
      },
      turns: [{ turnId: 'turn:13', summary: 'The user requested current schema only.' }],
    }),
    /unsupported snapshot patch heading: ## Signals/i,
  );
});

test('snapshot parser rejects invalid skill signal and unmatched skill detail names', () => {
  assert.throws(
    () => parseSnapshotContent(snapshotContentFixture('', {
      title: 'Skill Signals',
      summary: 'Skill signal names are validated.',
    skillSignals: [
      '- [turn:13 +1] `Invalid Skill`: Skill names should not be wrapped in backticks.',
    ],
    }), new Set(['turn:13'])),
    /invalid skill signal name: `Invalid Skill`/i,
  );

  assert.throws(
    () => parseSnapshotContent(snapshotContentFixture('', {
      title: 'Skill Details',
      summary: 'Skill details must match skill signal names.',
      skillSignals: [
        '- [turn:13 +1] TypeScript native: Valid skill signal.',
      ],
      skillDetails: {
        'TypeScript parser': 'This detail does not have a matching Skill Signal card.',
      },
    }), new Set(['turn:13'])),
    /Skill Details key lacks matching ## Skill Signals card: TypeScript parser/i,
  );
});

test('session snapshot deserialization rejects invalid skillDetails JSON', () => {
  const row = (skillDetails) => ({
    snapshotId: 'snapshot-invalid-skill-details',
    sessionId: 'session-invalid-skill-details',
    project: 'project-a',
    cwd: '/workspace/project-a',
    agent: 'agent-a',
    snapshotSequence: 0,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    extractor: 'default-extractor',
    title: 'Invalid skill details',
    summary: 'Skill details JSON is validated.',
    memorySignals: [],
    skillSignals: [],
    skillDetails,
    content: snapshotContentFixture('', {
      title: 'Invalid skill details',
      summary: 'Skill details JSON is validated.',
    }),
    references: [],
  });

  assert.throws(
    () => loadThreads([row('[]')], 'default-extractor', 7),
    /skillDetails JSON must be an object/i,
  );
  assert.throws(
    () => loadThreads([row('{"TypeScript native":1}')], 'default-extractor', 7),
    /skillDetails value must be a string: TypeScript native/i,
  );
});

test('snapshot patch with unchanged title preserves existing content', () => {
  const baseInput = {
    sessionMemory: {
      title: 'Extractor Signals',
      summary: 'Extractor prompt design.',
      memorySignals: [
        '- [turn:13 +1] Keep signal bullets under named subsections.',
      ],
      skillSignals: [
        '- [turn:13 +1] Extractor signal review: Preserve parser support notes.',
      ],
      skillDetails: {
        'Extractor signal review': 'Preserve parser support notes.',
      },
      extractions: [{
        title: 'Signal handling',
        text: 'Signal handling preserves existing parser support notes.',
        context: null,
        references: ['turn:13'],
      }],
      nextSteps: [],
    },
    turns: [{
      turnId: 'turn:13',
      summary: 'The user refined extractor signal handling.',
    }],
  };

  const result = extractorLlmTesting.validateSessionExtractionResultForTests(
    '# Extractor Signals',
    baseInput,
  );

  assert.equal(result.title, 'Extractor Signals');
  assert.equal(result.summary, 'Extractor prompt design.');
  assert.deepEqual(result.memorySignals, baseInput.sessionMemory.memorySignals);
  assert.deepEqual(result.skillSignals, baseInput.sessionMemory.skillSignals);
  assert.deepEqual(result.skillDetails, baseInput.sessionMemory.skillDetails);
  assert.deepEqual(result.extractions.map((extraction) => ({
    title: extraction.title,
    text: extraction.text,
    context: extraction.context,
    references: extraction.references,
  })), baseInput.sessionMemory.extractions);
});

test('snapshot patch can preserve, replace, and clear session-level signals', () => {
  const baseInput = {
    sessionMemory: {
      title: 'Extractor Signals',
      summary: 'Extractor prompt design.',
      memorySignals: [
        '- [turn:13 +1] Keep signal bullets under named subsections.',
      ],
      skillSignals: [
        '- [turn:13 +1] Extractor signal review: Preserve parser support notes.',
      ],
      skillDetails: {
        'Extractor signal review': 'Preserve parser support notes.',
      },
      extractions: [],
      nextSteps: [],
    },
    turns: [{
      turnId: 'turn:13',
      summary: 'The user refined extractor signal handling.',
    }],
  };

  const preserved = extractorLlmTesting.validateSessionExtractionResultForTests([
    '## Summary',
    'Extractor prompt design continues.',
  ].join('\n'), baseInput);
  assert.deepEqual(preserved.memorySignals, [
    '- [turn:13 +1] Keep signal bullets under named subsections.',
  ]);
  assert.deepEqual(preserved.skillSignals, [
    '- [turn:13 +1] Extractor signal review: Preserve parser support notes.',
  ]);
  assert.equal('openQuestions' in preserved, false);
  assert.deepEqual(preserved.skillDetails, {
    'Extractor signal review': 'Preserve parser support notes.',
  });

  const replaced = extractorLlmTesting.validateSessionExtractionResultForTests([
    '## Instruction Signals',
    '- [turn:13 +1] Signals are session-level state.',
    '',
    '## Skill Signals',
    '- [turn:13 +1] Extractor patch: Patch parsing replaces signal state.',
    '',
    '## Skill Details',
    '### Extractor patch',
    'Patch parsing replaces signal state.',
  ].join('\n'), baseInput);
  assert.deepEqual(replaced.memorySignals, [
    '- [turn:13 +1] Signals are session-level state.',
  ]);
  assert.deepEqual(replaced.skillSignals, [
    '- [turn:13 +1] Extractor patch: Patch parsing replaces signal state.',
  ]);
  assert.equal('openQuestions' in replaced, false);
  assert.deepEqual(replaced.skillDetails, {
    'Extractor patch': 'Patch parsing replaces signal state.',
  });

  const cleared = extractorLlmTesting.validateSessionExtractionResultForTests([
    '## Instruction Signals',
    '',
    '## Skill Signals',
    '',
  ].join('\n'), baseInput);
  assert.deepEqual(cleared.memorySignals, []);
  assert.deepEqual(cleared.skillSignals, []);
  assert.deepEqual(cleared.skillDetails, {});

  assert.throws(
    () => extractorLlmTesting.validateSessionExtractionResultForTests([
      '## Open Questions',
      '- [1] Should old signal sections be rejected?',
    ].join('\n'), baseInput),
    /unsupported snapshot patch heading: ## Open Questions/i,
  );

  const deleted = extractorLlmTesting.validateSessionExtractionResultForTests([
    '## Skill Details',
    '### Extractor signal review',
  ].join('\n'), baseInput);
  assert.deepEqual(deleted.skillDetails, {});

  assert.throws(
    () => extractorLlmTesting.validateSessionExtractionResultForTests([
      '## Skill Details',
      '### Missing skill',
      'Patch-provided detail must not be silently dropped.',
    ].join('\n'), baseInput),
    /Skill Details key lacks matching ## Skill Signals card: Missing skill/i,
  );

  const existingEvidenceInput = {
    ...baseInput,
    sessionMemory: {
      ...baseInput.sessionMemory,
      memorySignals: [
        '- [turn:12 +1] Preserve exact existing evidence contribution.',
      ],
      skillSignals: [],
      skillDetails: {},
    },
    turns: [{
      turnId: 'turn:13',
      summary: 'The user refined extractor signal handling.',
    }],
  };
  assert.deepEqual(
    extractorLlmTesting.validateSessionExtractionResultForTests([
      '## Instruction Signals',
      '- [turn:12 +1] Preserve exact existing evidence contribution.',
    ].join('\n'), existingEvidenceInput).memorySignals,
    ['- [turn:12 +1] Preserve exact existing evidence contribution.'],
  );
  assert.throws(
    () => extractorLlmTesting.validateSessionExtractionResultForTests([
      '## Instruction Signals',
      '- [turn:12 +10] Preserve exact existing evidence contribution.',
    ].join('\n'), existingEvidenceInput),
    /referenced unknown evidence turn id: turn:12/i,
  );
});

test('extractor validation keeps independent refs per snapshot content unit', () => {
  const result = extractorLlmTesting.validateSessionExtractionResultForTests(
    snapshotContentFixture([
      '<!-- refs: [turn:13] -->',
      '### Title',
      'Lake sunrise painting',
      '',
      '### Summary',
      'Melanie painted a lake sunrise in 2022.',
      '',
      '----',
      '',
      '<!-- refs: [turn:14, turn:15] -->',
      '### Title',
      'Counseling work',
      '',
      '### Summary',
      'Caroline plans to explore counseling work.',
    ].join('\n'), {
      title: 'IngestSession',
      summary: 'Session memory.',
    }),
    {
      sessionMemory: {
        title: 'IngestSession',
        summary: '',
        extractions: [],
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

test('extractor validation splits adjacent metadata snapshot units without separators', () => {
  const result = extractorLlmTesting.validateSessionExtractionResultForTests(
    snapshotContentFixture([
      '<!-- refs: [turn:13] -->',
      '### Title',
      'Lake sunrise painting',
      '',
      '### Summary',
      'Melanie painted a lake sunrise in 2022.',
      '',
      '<!-- refs: [turn:14, turn:15] -->',
      '### Title',
      'Counseling work',
      '',
      '### Summary',
      'Caroline plans to explore counseling work.',
    ].join('\n'), {
      title: 'IngestSession',
      summary: 'Session memory.',
    }),
    {
      sessionMemory: {
        title: 'IngestSession',
        summary: '',
        extractions: [],
        nextSteps: [],
      },
      turns: [
        { turnId: 'turn:13', summary: 'Melanie discussed painting.' },
        { turnId: 'turn:14', summary: 'Caroline discussed education.' },
        { turnId: 'turn:15', summary: 'Caroline discussed counseling.' },
      ],
    },
  );

  assert.deepEqual(result.extractions.map((extraction) => extraction.title), [
    'Lake sunrise painting',
    'Counseling work',
  ]);
  assert.deepEqual(result.extractions.map((extraction) => extraction.references), [
    ['turn:13'],
    ['turn:14', 'turn:15'],
  ]);
});

test('session extraction turn input omits turn summary when prompt and response are present', () => {
  const markdown = extractorLlmTesting.renderNewTurnsForTests([{
    turnId: 'turn:13',
    prompt: 'User asked whether app session rows should use snapshot titles.',
    response: 'Agent confirmed the session index should cache the latest snapshot title.',
    summary: 'This old turn summary repeats the prompt and response and should not be sent.',
  }]);

  assert.match(markdown, /## Current Batch Turns/);
  assert.match(markdown, /Prompt \(instruction signal evidence\):\nUser asked whether app session rows should use snapshot titles\./);
  assert.match(markdown, /Response \(workflow context, not instruction signal evidence\):\nAgent confirmed the session index should cache the latest snapshot title\./);
  assert.doesNotMatch(markdown, /Summary:/);
  assert.doesNotMatch(markdown, /This old turn summary repeats/);
});

test('extractor validation accepts markdown fenced snapshot content', () => {
  const result = extractorLlmTesting.validateSessionExtractionResultForTests(
    [
      '```markdown',
      '# Painting Memory',
      '',
      '## Summary',
      'Melanie discussed a lake sunrise painting.',
      '',
      '## Extractions',
      '<!-- refs: [turn:13] -->',
      '### Title',
      'Lake sunrise painting',
      '',
      '### Summary',
      'Melanie painted a lake sunrise in 2022.',
      '```',
    ].join('\n'),
    {
      sessionMemory: {
        title: 'Painting',
        summary: '',
        extractions: [],
        nextSteps: [],
      },
      turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
    },
  );

  assert.equal(result.snapshotContent, snapshotContentFixture(
    '<!-- refs: [turn:13] -->\n### Title\nLake sunrise painting\n\n### Summary\nMelanie painted a lake sunrise in 2022.',
    { title: 'Painting Memory', summary: 'Melanie discussed a lake sunrise painting.' },
  ));
  assert.deepEqual(result.extractions[0].references, ['turn:13']);
});

test('snapshot patch allows signal-like headings inside extraction content', () => {
  const result = extractorLlmTesting.validateSessionExtractionResultForTests([
    '## Extractions',
    '<!-- refs: [turn:13] -->',
    '### Title',
    'Lake sunrise painting',
    '',
    '### Summary',
    'Melanie painted a lake sunrise in 2022.',
    '',
    '### Content',
    'The extraction context can include a heading-like line.',
    '',
    '## Instruction Signals',
    'This is extraction content, not a snapshot signal section.',
  ].join('\n'), {
    sessionMemory: {
      title: 'Painting',
      summary: '',
      extractions: [],
      nextSteps: [],
    },
    turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
  });

  assert.equal(result.extractions[0].context, [
    'The extraction context can include a heading-like line.',
    '',
    '## Instruction Signals',
    'This is extraction content, not a snapshot signal section.',
  ].join('\n'));
});

test('extractor validation rejects snapshot content units without metadata', () => {
  assert.throws(
    () => extractorLlmTesting.validateSessionExtractionResultForTests(
      snapshotContentFixture('### Title\nPainting\n\n### Summary\nMelanie painted a lake sunrise in 2022.'),
      {
        sessionMemory: {
          title: 'Painting',
          summary: '',
          extractions: [],
          nextSteps: [],
        },
        turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
      },
    ),
    /must start with metadata comment/i,
  );
});

test('extractor validation rejects legacy snapshot content format', () => {
  assert.throws(
    () => extractorLlmTesting.validateSessionExtractionResultForTests(
      snapshotContentFixture('<!-- categories: [Fact]; refs: [turn:13] -->\n[Entity] Melanie\n[Extraction] Melanie painted a lake sunrise in 2022.'),
      {
        sessionMemory: {
          title: 'Painting',
          summary: '',
          extractions: [],
          nextSteps: [],
        },
        turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
      },
    ),
    /snapshot unit must include ### Title|snapshot patch extraction must start with metadata comment/i,
  );
});

test('extractor validation rejects snapshot content units without title', () => {
  assert.throws(
    () => extractorLlmTesting.validateSessionExtractionResultForTests(
      snapshotContentFixture('<!-- refs: [turn:13] -->\n### Summary\nMelanie painted a lake sunrise in 2022.'),
      {
        sessionMemory: {
          title: 'Painting',
          summary: '',
          extractions: [],
          nextSteps: [],
        },
        turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
      },
    ),
    /must include ### Title/i,
  );
});

test('extractor validation rejects unknown snapshot content refs', () => {
  assert.throws(
    () => extractorLlmTesting.validateSessionExtractionResultForTests(
      snapshotContentFixture('<!-- refs: [session:missing] -->\n### Title\nPainting\n\n### Summary\nMelanie painted a lake sunrise in 2022.'),
      {
        sessionMemory: {
          title: 'Painting',
          summary: '',
          extractions: [],
          nextSteps: [],
        },
        turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
      },
    ),
    /unknown ref: session:missing/i,
  );
});

test('extractor validation rejects snapshot content units without refs metadata', () => {
  assert.throws(
    () => extractorLlmTesting.validateSessionExtractionResultForTests(
      snapshotContentFixture('<!-- refs: [] -->\n### Title\nPainting\n\n### Summary\nMelanie painted a lake sunrise in 2022.'),
      {
        sessionMemory: {
          title: 'Painting',
          summary: '',
          extractions: [],
          nextSteps: [],
        },
        turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
      },
    ),
    /metadata refs must include at least one reference/i,
  );
});

test('extractor validation rejects JSON output', () => {
  assert.throws(
    () => extractorLlmTesting.validateSessionExtractionResultForTests(JSON.stringify({
      title: 'Painting',
      snapshotContent: '<!-- refs: [turn:13] -->\n### Title\nPainting\n\n### Summary\nMelanie painted a lake sunrise.',
      nextSteps: [],
      contextRefs: [],
    })),
    /must return snapshot content Markdown, not JSON/i,
  );
});

test('extractor validation accepts long titles without runtime length rejection', () => {
  const result = extractorLlmTesting.validateSessionExtractionResultForTests(
    snapshotContentFixture(
      `<!-- refs: [turn:13] -->\n### Title\n${'x'.repeat(81)}\n\n### Summary\nMelanie painted a lake sunrise in 2022.`,
    ),
    {
      sessionMemory: { title: 'Painting', summary: '', extractions: [], nextSteps: [] },
      turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
    },
  );
  assert.equal(result.extractions[0].title, 'x'.repeat(81));
});

test('extractor validation rejects snapshot content units without summary', () => {
  assert.throws(
    () => extractorLlmTesting.validateSessionExtractionResultForTests(
      snapshotContentFixture('<!-- refs: [turn:13] -->\n### Title\nPainting'),
      {
        sessionMemory: {
          title: 'Painting',
          summary: '',
          extractions: [],
          nextSteps: [],
        },
        turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
      },
    ),
    /must include ### Summary/i,
  );
});

test('thread session get_extraction expands visible extraction sequences only', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeOpenAiExtractorConfig(configPath);
  const tracePath = path.join(dir, 'thread-session-trace.jsonl');
  process.env.MUNINN_SESSION_MEMORY_TRACE_FILE = tracePath;
  t.after(() => {
    delete process.env.MUNINN_SESSION_MEMORY_TRACE_FILE;
  });

  const requests = [];
  const result = await extractorLlmModule.extractSessionMemory({
    sessionMemory: {
      title: 'Caroline support group',
      summary: 'Caroline discussed a support group.',
      snapshotContent: [
        '# Caroline support group',
        '',
        '## Summary',
        'Caroline discussed a support group.',
        '',
        '## Extractions',
        '<!-- refs: [turn:0] -->',
        '### Title',
        'Support group attendance',
        '',
        '### Summary',
        'Existing support extraction.',
        '',
        '### Content',
        '- Existing full detail.',
      ].join('\n'),
      extractions: [{
        id: 'obs-1',
        title: 'Support group attendance',
        text: 'Existing support extraction.',
        context: '- Existing full detail.',
        category: 'Other',
        references: ['turn:0'],
      }],
      nextSteps: [],
    },
    turns: [{
      turnId: 'turn:1',
      prompt: 'DATE: 8 May 2023\nDIALOGUE:\nCaroline said she went to an LGBTQ support group yesterday.',
      response: '[imported dialogue event; no assistant response]',
    }],
  }, undefined, {
    model: async (_task, request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          type: 'tool_calls',
          toolCalls: [{
            id: 'call-1',
            name: 'get_extraction',
            arguments: {
              sequences: [0, 0, 42],
            },
          }],
        };
      }
      return {
        type: 'final',
        text: [
          '## Summary',
          'Caroline attended an LGBTQ support group.',
          '',
          '## Extractions',
          '<!-- sequence: 0; refs: [turn:1] -->',
          '### Title',
          'LGBTQ support group',
          '',
          '### Summary',
          'Caroline attended an LGBTQ support group on 7 May 2023.',
          '',
          '### Content',
          '- Caroline said she went to the support group yesterday relative to 8 May 2023.',
        ].join('\n'),
      };
    },
  });

  assert.equal(requests[0].tools[0].name, 'get_extraction');
  assert.match(requests[0].tools[0].description, /full extraction details/i);
  assert.equal(requests[0].tools[0].parameters.properties.sequences.items.type, 'number');
  const firstUserMessage = requests[0].messages.find((message) => message.role === 'user');
  assert.ok(firstUserMessage);
  assert.match(firstUserMessage.content, /## Current Snapshot/);
  assert.match(firstUserMessage.content, /# Caroline support group/);
  assert.match(firstUserMessage.content, /## Summary/);
  assert.match(firstUserMessage.content, /## Instruction Signals\n\(empty\)/);
  assert.match(firstUserMessage.content, /## Skill Signals\n\(empty\)/);
  assert.doesNotMatch(firstUserMessage.content, /## Open Questions/);
  assert.match(firstUserMessage.content, /## Extractions/);
  assert.match(firstUserMessage.content, /### Title/);
  assert.match(firstUserMessage.content, /### Summary/);
  assert.doesNotMatch(firstUserMessage.content, /Extraction Index/);
  assert.match(firstUserMessage.content, /<!-- sequence: 0 -->/);
  assert.match(firstUserMessage.content, /Support group attendance/);
  assert.match(firstUserMessage.content, /Existing support extraction\./);
  assert.doesNotMatch(firstUserMessage.content, /turn:0/);
  assert.doesNotMatch(firstUserMessage.content, /Existing full detail/);
  assert.doesNotMatch(firstUserMessage.content, /existingSnapshotContent/);
  assert.match(firstUserMessage.content, /## Current Batch Turns/);
  const toolMessage = requests[1].messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage);
  const toolPayload = JSON.parse(toolMessage.content);
  assert.match(toolPayload.extractions[0].content, /Existing full detail/);
  assert.equal(toolPayload.extractions[1].error, 'sequence is not visible');
  assert.equal(result.title, 'Caroline support group');
  assert.equal(result.extractions[0].title, 'LGBTQ support group');
  assert.equal(result.extractions[0].text, 'Caroline attended an LGBTQ support group on 7 May 2023.');
  assert.equal(result.extractions[0].context, '- Caroline said she went to the support group yesterday relative to 8 May 2023.');
  assert.equal(result.extractions[0].category, undefined);
  assert.deepEqual(result.extractions[0].references, ['turn:0', 'turn:1']);
  const trace = JSON.parse(await readFile(tracePath, 'utf8'));
  const systemMessage = requests[0].messages.find((message) => message.role === 'system');
  assert.ok(systemMessage);
  assert.equal(trace.inputBudget.newBatchInputChars, 24_576);
  assert.equal(trace.inputBudget.systemPromptChars, systemMessage.content.length);
  assert.equal(trace.inputBudget.initialRequestChars, systemMessage.content.length + firstUserMessage.content.length);
  assert.equal(trace.inputBudget.userPromptOverheadChars, firstUserMessage.content.length
    - trace.inputBudget.snapshotRenderedChars
    - trace.inputBudget.newBatchRenderedChars);
  assert.equal('maxInputChars' in trace.inputBudget, false);
  assert.equal(trace.toolCalls[0].name, 'get_extraction');
  assert.equal(trace.extractions[0].text, 'Caroline attended an LGBTQ support group on 7 May 2023.');
  assert.match(trace.finalText, /## Summary/);
  assert.match(trace.finalText, /Caroline attended an LGBTQ support group on 7 May 2023/);
});

test('thread session get_skill reads hidden skill details once per skill name', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeOpenAiExtractorConfig(configPath);
  const tracePath = path.join(dir, 'thread-session-skill-trace.jsonl');
  process.env.MUNINN_SESSION_MEMORY_TRACE_FILE = tracePath;
  t.after(() => {
    delete process.env.MUNINN_SESSION_MEMORY_TRACE_FILE;
  });

  const skillDetail = [
    '# Report export triage',
    '',
    '## When to Use',
    'Use when report export jobs fail.',
    '',
    '## Procedure',
    '- Check job logs before object storage permissions.',
  ].join('\n');
  const requests = [];
  const result = await extractorLlmModule.extractSessionMemory({
    sessionMemory: {
      title: 'Report exports',
      summary: 'Report export failures use reusable triage guidance.',
      memorySignals: [],
      skillSignals: [
        '- [turn:1 +1] Report export triage: Triage report export failures by checking job logs before object storage permissions.',
      ],
      skillDetails: {
        'Report export triage': skillDetail,
      },
      extractions: [],
      nextSteps: [],
    },
    turns: [{
      turnId: 'turn:1',
      prompt: 'Rename the report export triage skill only if its hidden detail still supports the new name.',
      response: 'I will inspect the hidden skill detail before deciding whether to rename it.',
    }],
  }, undefined, {
    model: async (_task, request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          type: 'tool_calls',
          toolCalls: [{
            id: 'call-1',
            name: 'get_skill',
            arguments: { skillName: 'Report export triage' },
          }, {
            id: 'call-2',
            name: 'get_skill',
            arguments: { skillName: 'Report export triage' },
          }],
        };
      }
      return {
        type: 'final',
        text: [
          '## Summary',
          'Report export failures continue to use reusable triage guidance.',
        ].join('\n'),
      };
    },
  });

  assert.deepEqual(requests[0].tools.map((tool) => tool.name), ['get_extraction', 'get_skill', 'get_turn']);
  const getSkillSpec = requests[0].tools.find((tool) => tool.name === 'get_skill');
  assert.ok(getSkillSpec);
  assert.match(getSkillSpec.description, /hidden detail/i);
  assert.equal(getSkillSpec.parameters.properties.skillName.type, 'string');

  const firstUserMessage = requests[0].messages.find((message) => message.role === 'user');
  assert.ok(firstUserMessage);
  assert.match(firstUserMessage.content, /## Skill Signals\n- \[turn:1 \+1\] Report export triage:/);
  assert.doesNotMatch(firstUserMessage.content, /## Skill Details/);
  assert.doesNotMatch(firstUserMessage.content, /Check job logs before object storage permissions/);

  const toolMessages = requests[1].messages.filter((message) => message.role === 'tool');
  assert.equal(toolMessages.length, 2);
  assert.deepEqual(JSON.parse(toolMessages[0].content), {
    skillName: 'Report export triage',
    content: skillDetail,
  });
  assert.deepEqual(JSON.parse(toolMessages[1].content), {
    skillName: 'Report export triage',
    error: 'skill already read',
  });
  assert.deepEqual(result.skillDetails, {
    'Report export triage': skillDetail,
  });

  const trace = JSON.parse(await readFile(tracePath, 'utf8'));
  assert.deepEqual(trace.readSkillNames, ['Report export triage']);
  assert.equal(trace.toolCalls[0].name, 'get_skill');
});

test('thread session get_turn reads only current batch prompt and response with bounded result shape', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeOpenAiExtractorConfig(configPath);
  const tracePath = path.join(dir, 'thread-session-turn-trace.jsonl');
  process.env.MUNINN_SESSION_MEMORY_TRACE_FILE = tracePath;
  t.after(() => {
    delete process.env.MUNINN_SESSION_MEMORY_TRACE_FILE;
  });

  const requests = [];
  await extractorLlmModule.extractSessionMemory({
    sessionMemory: {
      title: 'Turn lookup',
      summary: 'Turn lookup test.',
      memorySignals: [],
      skillSignals: [],
      skillDetails: {},
      extractions: [],
      nextSteps: [],
    },
    turns: [{
      turnId: 'turn:123',
      prompt: '用户说这个方案需要看完整 prompt。',
      response: '这里是完整 response。',
    }],
  }, undefined, {
    model: async (_task, request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          type: 'tool_calls',
          toolCalls: [{
            id: 'call-1',
            name: 'get_turn',
            arguments: { turnId: 'turn:123' },
          }, {
            id: 'call-2',
            name: 'get_turn',
            arguments: { turnId: '123' },
          }],
        };
      }
      return {
        type: 'final',
        text: [
          '## Summary',
          'Turn lookup stays available for omitted prompt or response details.',
        ].join('\n'),
      };
    },
  });

  const getTurnSpec = requests[0].tools.find((tool) => tool.name === 'get_turn');
  assert.ok(getTurnSpec);
  assert.match(getTurnSpec.description, /target conversation turn/i);
  assert.equal(getTurnSpec.parameters.properties.turnId.type, 'string');
  assert.match(getTurnSpec.parameters.properties.turnId.description, /exact current-batch turn id/i);
  assert.doesNotMatch(getTurnSpec.parameters.properties.turnId.description, /without a turn: prefix/i);

  const toolMessages = requests[1].messages.filter((message) => message.role === 'tool');
  assert.deepEqual(JSON.parse(toolMessages[0].content), {
    turnId: 'turn:123',
    prompt: '用户说这个方案需要看完整 prompt。',
    response: '这里是完整 response。',
  });
  assert.deepEqual(JSON.parse(toolMessages[1].content), {
    turnId: '123',
    error: 'turn is not in the current extraction request',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(toolMessages[0].content), 'omittedPromptChars'), false);

  const trace = JSON.parse(await readFile(tracePath, 'utf8'));
  assert.equal(trace.getTurnResults[0].turnId, 'turn:123');
  assert.equal(trace.getTurnResults[0].returnedPromptChars > 0, true);
  assert.equal(trace.getTurnResults[1].error, 'turn is not in the current extraction request');
});

test('thread session get_skill does not mark missing or invalid skills as read', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeOpenAiExtractorConfig(configPath);
  const tracePath = path.join(dir, 'thread-session-missing-skill-trace.jsonl');
  process.env.MUNINN_SESSION_MEMORY_TRACE_FILE = tracePath;
  t.after(() => {
    delete process.env.MUNINN_SESSION_MEMORY_TRACE_FILE;
  });

  const requests = [];
  await extractorLlmModule.extractSessionMemory({
    sessionMemory: {
      title: 'Report exports',
      summary: 'Report export failures use reusable triage guidance.',
      memorySignals: [],
      skillSignals: [
        '- [turn:1 +1] Report export triage: Triage report export failures by checking job logs before object storage permissions.',
      ],
      skillDetails: {},
      extractions: [],
      nextSteps: [],
    },
    turns: [{
      turnId: 'turn:1',
      prompt: 'Check hidden skill detail only when it exists.',
      response: 'Missing skill names should not count as read.',
    }],
  }, undefined, {
    model: async (_task, request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          type: 'tool_calls',
          toolCalls: [{
            id: 'call-1',
            name: 'get_skill',
            arguments: { skillName: 'missing.skill' },
          }, {
            id: 'call-2',
            name: 'get_skill',
            arguments: { skillName: 'missing.skill' },
          }, {
            id: 'call-3',
            name: 'get_skill',
            arguments: { skillName: 'Invalid: Skill' },
          }, {
            id: 'call-4',
            name: 'get_skill',
            arguments: {},
          }],
        };
      }
      return {
        type: 'final',
        text: [
          '## Summary',
          'Report export failures use reusable triage guidance.',
        ].join('\n'),
      };
    },
  });

  const toolMessages = requests[1].messages.filter((message) => message.role === 'tool');
  assert.equal(toolMessages.length, 4);
  assert.deepEqual(JSON.parse(toolMessages[0].content), {
    skillName: 'missing.skill',
    error: 'skill signal not found',
  });
  assert.deepEqual(JSON.parse(toolMessages[1].content), {
    skillName: 'missing.skill',
    error: 'skill signal not found',
  });
  assert.deepEqual(JSON.parse(toolMessages[2].content), {
    error: 'skillName is required',
  });
  assert.deepEqual(JSON.parse(toolMessages[3].content), {
    error: 'skillName is required',
  });

  const trace = JSON.parse(await readFile(tracePath, 'utf8'));
  assert.deepEqual(trace.readSkillNames, []);
});

test('thread session can create unrelated extraction without get_extraction', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeOpenAiExtractorConfig(configPath);

  const requests = [];
  const result = await extractorLlmModule.extractSessionMemory({
    sessionMemory: {
      title: 'Caroline support group',
      summary: 'Caroline discussed a support group.',
      snapshotContent: [
        '# Caroline support group',
        '',
        '## Summary',
        'Caroline discussed a support group.',
        '',
        '## Extractions',
        '<!-- refs: [turn:0] -->',
        '### Title',
        'Support group attendance',
        '',
        '### Summary',
        'Existing support extraction.',
      ].join('\n'),
      extractions: [{
        id: 'obs-1',
        title: 'Support group attendance',
        text: 'Existing support extraction.',
        context: null,
        category: 'Other',
        references: ['turn:0'],
      }],
      nextSteps: [],
    },
    turns: [{
      turnId: 'turn:1',
      prompt: 'Caroline asked to save her preferred report filename pattern.',
      response: 'The preferred report filename pattern is project-env-YYYYMMDD.csv.',
    }],
  }, undefined, {
    model: async (_task, request) => {
      requests.push(request);
      return {
        type: 'final',
        text: [
          '## Extractions',
          '<!-- refs: [turn:1] -->',
          '### Title',
          'Report filename pattern',
          '',
          '### Summary',
          'Caroline prefers report filenames to use project-env-YYYYMMDD.csv.',
        ].join('\n'),
      };
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(result.extractions.length, 2);
  assert.equal(result.extractions[1].title, 'Report filename pattern');
});

test('thread session requires get_extraction before updating an existing sequence', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeOpenAiExtractorConfig(configPath);
  const tracePath = path.join(dir, 'thread-session-sequence-read-trace.jsonl');
  process.env.MUNINN_SESSION_MEMORY_TRACE_FILE = tracePath;
  t.after(() => {
    delete process.env.MUNINN_SESSION_MEMORY_TRACE_FILE;
  });

  const requests = [];
  const result = await extractorLlmModule.extractSessionMemory({
    sessionMemory: {
      title: 'Caroline support group',
      summary: 'Caroline discussed a support group.',
      snapshotContent: '',
      extractions: [{
        id: 'obs-1',
        title: 'Support group attendance',
        text: 'Existing support extraction.',
        context: '- Existing full detail.',
        category: 'Other',
        references: ['turn:0'],
      }],
      nextSteps: [],
    },
    turns: [{
      turnId: 'turn:1',
      prompt: 'Caroline clarified the support group was on Sunday.',
      response: 'Update the support group memory with the Sunday timing.',
    }],
  }, undefined, {
    model: async (_task, request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          type: 'final',
          text: [
            '## Extractions',
            '<!-- sequence: 0; refs: [turn:1] -->',
            '### Title',
            'Support group attendance',
            '',
            '### Summary',
            'Caroline attended a support group on Sunday.',
          ].join('\n'),
        };
      }
      if (requests.length === 2) {
        return {
          type: 'tool_calls',
          toolCalls: [{
            id: 'call-1',
            name: 'get_extraction',
            arguments: { sequences: [0] },
          }],
        };
      }
      return {
        type: 'final',
        text: [
          '## Extractions',
          '<!-- sequence: 0; refs: [turn:1] -->',
          '### Title',
          'Support group attendance',
          '',
          '### Summary',
          'Caroline attended a support group on Sunday.',
        ].join('\n'),
      };
    },
  });

  assert.equal(result.extractions[0].text, 'Caroline attended a support group on Sunday.');
  assert.equal(requests.length, 3);
  const traceLines = (await readFile(tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.match(traceLines[0].validationError, /sequence 0 must be read with get_extraction/i);
});

test('thread session allows at most five get_extraction calls', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeOpenAiExtractorConfig(configPath);

  let calls = 0;
  await assert.rejects(
    extractorLlmModule.extractSessionMemory({
      sessionMemory: {
        title: 'Caroline support group',
        summary: 'Caroline discussed a support group.',
        extractions: [{
          id: 'obs-1',
          title: 'Support group attendance',
          text: 'Existing support extraction.',
          context: null,
          category: 'Other',
          references: ['turn:0'],
        }],
        nextSteps: [],
      },
      turns: [{
        turnId: 'turn:1',
        prompt: 'Caroline clarified more support group details.',
        response: 'Update the support group memory.',
      }],
    }, undefined, {
      model: async () => {
        calls += 1;
        return {
          type: 'tool_calls',
          toolCalls: [{
            id: `call-${calls}`,
            name: 'get_extraction',
            arguments: { sequences: [0] },
          }],
        };
      },
    }),
    /get_extraction exceeded max calls: 5|tool loop exceeded maxSteps=6/i,
  );
  assert.ok(calls >= 6);
});

test('thread session omits generated default session title from memory input', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeOpenAiExtractorConfig(configPath);

  const requests = [];
  await extractorLlmModule.extractSessionMemory({
    sessionMemory: {
      title: 'Session group-a',
      summary: 'Default session memory thread for session group-a.',
      snapshotContent: '',
      extractions: [],
      nextSteps: [],
    },
    turns: [{
      turnId: 'turn:1',
      prompt: '我们要让 session 标题使用文档里的语言。',
      response: '可以，把 prompt 示例和默认标题锚点一起调整。',
    }],
  }, undefined, {
    model: async (_task, request) => {
      requests.push(request);
      return {
        type: 'final',
        text: [
          '# 标题语言对齐',
          '',
          '## Summary',
          '本轮确定 session 标题应使用文档主语言。',
        ].join('\n'),
      };
    },
  });

  const firstUserMessage = requests[0].messages.find((message) => message.role === 'user');
  assert.ok(firstUserMessage);
  assert.match(firstUserMessage.content, /## Current Snapshot/);
  assert.match(firstUserMessage.content, /# \(empty\)/);
  assert.doesNotMatch(firstUserMessage.content, /# Session group-a/);
});

test('thread session traces invalid markdown attempts without JSON retry instructions', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeOpenAiExtractorConfig(configPath);
  const tracePath = path.join(dir, 'thread-session-invalid-trace.jsonl');
  process.env.MUNINN_SESSION_MEMORY_TRACE_FILE = tracePath;
  t.after(() => {
    delete process.env.MUNINN_SESSION_MEMORY_TRACE_FILE;
  });

  const requests = [];
  const result = await extractorLlmModule.extractSessionMemory({
    sessionMemory: {
      title: 'Caroline support group',
      summary: '',
      extractions: [],
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
          text: '{"snapshotContent":"<!-- refs: [turn:1] -->\\n[Entity] Caroline\\n[Extraction] Caroline attended an LGBTQ support group."}',
        };
      }
      return {
        type: 'final',
        text: snapshotContentFixture(
          [
            '<!-- refs: [turn:1] -->',
            '### Title',
            'LGBTQ support group',
            '',
            '### Summary',
            'Caroline attended an LGBTQ support group on 7 May 2023.',
          ].join('\n'),
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
  assert.match(retryUserMessage.content, /Return only a valid Markdown snapshot patch/);
  assert.match(retryUserMessage.content, /optional `## Instruction Signals`/);
  assert.match(retryUserMessage.content, /optional `## Skill Signals`/);
  assert.doesNotMatch(retryUserMessage.content, /optional `## Open Questions`/);
  assert.match(retryUserMessage.content, /optional `## Skill Details`/);
  assert.doesNotMatch(retryUserMessage.content, /Return one JSON object only/);

  const traceLines = (await readFile(tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(traceLines.length, 2);
  assert.equal(traceLines[0].attempt, 1);
  assert.match(traceLines[0].rawText, /^\{"snapshotContent"/);
  assert.match(traceLines[0].validationError, /must return snapshot content Markdown, not JSON/);
  assert.equal(traceLines[1].attempt, 2);
  assert.match(traceLines[1].finalText, /# Caroline Support Group/);
});

test('thread session omits default session summary from memory input', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeOpenAiExtractorConfig(configPath);

  const requests = [];
  await extractorLlmModule.extractSessionMemory({
    sessionMemory: {
      title: 'Session locomo',
      summary: 'Default session thread for session locomo:conv-26:session_1.',
      extractions: [],
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
        text: snapshotContentFixture(
          [
            '<!-- refs: [turn:1] -->',
            '### Title',
            'Caroline felt accepted',
            '',
            '### Summary',
            'Caroline felt accepted on 8 May 2023.',
          ].join('\n'),
          { title: 'Session Locomo', summary: 'Caroline felt accepted.' },
        ),
      };
    },
  });

  const firstUserMessage = requests[0].messages.find((message) => message.role === 'user');
  assert.ok(firstUserMessage);
  assert.match(firstUserMessage.content, /## Summary\n\(empty\)/);
  assert.doesNotMatch(firstUserMessage.content, /Default session thread/);
  assert.doesNotMatch(firstUserMessage.content, /existingSnapshotContent/);
});

test('thread session inlines chat memory categories', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeOpenAiExtractorConfig(configPath);

  const requests = [];
  await extractorLlmModule.extractSessionMemory({
    sessionMemory: {
      title: 'Caroline support group',
      summary: 'Caroline discussed a support group.',
      extractions: [],
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
        text: snapshotContentFixture(
          [
            '<!-- refs: [turn:1] -->',
            '### Title',
            'Melanie brief reaction',
            '',
            '### Summary',
            'Melanie said that was cool.',
          ].join('\n'),
          { title: 'Caroline Support Group', summary: 'Melanie reacted to Caroline.' },
        ),
      };
    },
  });

  assert.match(requests[0].messages[0].content, /Each extraction must include `### Title`/);
  assert.match(requests[0].messages[0].content, /`### Content` is optional/);
  assert.match(requests[0].messages[0].content, /durable topic: a decision, requirement, preference, correction/);
  assert.doesNotMatch(requests[0].messages[0].content, /Domain guidance/);
  assert.doesNotMatch(requests[0].messages[0].content, /domain_prompt/);
  assert.doesNotMatch(requests[0].messages[0].content, /Extraction granularity/);
  assert.doesNotMatch(requests[0].messages[0].content, /Chat filtering/);
  assert.doesNotMatch(requests[0].messages[0].content, /Use `update` plus `add`/);
});

test('session snapshots keep complete cumulative context refs', () => {
  const thread = createSessionThread(
    'default-extractor',
    'Career',
    'Career thread',
    [],
    1,
    '2026-01-01T00:00:00.000Z',
  );
  const result = (summary, turnId) => ({
    title: 'Career',
    snapshotContent: '',
    extractions: [],
    nextSteps: [],
    contextRefs: [{ turnId, summary }],
  });

  for (let index = 1; index <= 10; index += 1) {
    threadTesting.applyExtractionForTests(
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
  const thread = createSessionThread(
    'default-extractor',
    'Career',
    'Career thread',
    [],
    1,
    '2026-01-01T00:00:00.000Z',
  );
  const extractResult = (summary) => ({
    title: 'Career',
    snapshotContent: '',
    extractions: [],
    nextSteps: [],
    contextRefs: [{ turnId: 'turn:1', summary }],
  });

  threadTesting.applyExtractionForTests(
    thread,
    extractResult('initial summary'),
    1,
    applyExtractionChanges,
    '2026-01-01T00:00:00.000Z',
  );
  threadTesting.applyExtractionForTests(
    thread,
    extractResult('updated summary'),
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
  const thread = createSessionThread(
    'default-extractor',
    'Draft title',
    'Draft summary',
    [],
    1,
    '2026-01-01T00:00:00.000Z',
  );
  const markdown = snapshotContentFixture(
    [
      '<!-- refs: [turn:1] -->',
      '### Title',
      'Lake sunrise painting',
      '',
      '### Summary',
      'Melanie painted a lake sunrise in 2022.',
    ].join('\n'),
    {
      title: 'Melanie Painting',
      summary: 'Melanie painted a lake sunrise and considers it special.',
    },
  );

  threadTesting.applyExtractionForTests(
    thread,
    {
      title: 'Melanie Painting',
      summary: 'Melanie painted a lake sunrise and considers it special.',
      memorySignals: ['- [turn:1 +1] Melanie values art that captures important personal moments.'],
      skillSignals: [],
      skillDetails: {},
      snapshotContent: markdown,
      extractions: [{
        text: 'Melanie painted a lake sunrise in 2022.',
        category: 'Fact',
        references: ['turn:1'],
      }],
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
  assert.deepEqual(snapshot.memorySignals, ['- [turn:1 +1] Melanie values art that captures important personal moments.']);
  assert.deepEqual(snapshot.skillSignals, []);
  assert.equal('openQuestions' in snapshot, false);
  assert.equal(snapshot.skillDetails, '{}');
  assert.equal(snapshot.content, markdown);
  assert.doesNotMatch(snapshot.content, /^\s*\{/);
});

test('extractSessionThread passes raw turns to extractor', async () => {
  const now = '2026-01-01T00:00:00.000Z';
  const thread = createSessionThread(
    'default-extractor',
    'Session locomo',
    'Default session thread for session locomo.',
    [],
    1,
    now,
    'session',
    'locomo',
    { agent: 'Melanie', project: 'locomo', cwd: '/workspace/locomo' },
  );
  const extractionInputs = [];
  const sessionExtractionImpl = async (input) => {
    extractionInputs.push(input);
    return {
      title: 'Painting',
      snapshotContent: snapshotContentFixture(
        [
          '<!-- refs: [turn:13] -->',
          '### Title',
          'Lake sunrise painting',
          '',
          '### Summary',
          'Melanie painted a lake sunrise in 2022.',
        ].join('\n'),
        {
          title: 'Painting',
          summary: 'Melanie painted a lake sunrise.',
        },
      ),
      extractions: [],
      nextSteps: [],
      contextRefs: [{
        turnId: 'turn:13',
        summary: 'Melanie says she painted the lake sunrise in 2022, described as last year relative to 8 May 2023.',
      }],
    };
  };

  await sessionTesting.extractSessionThreadForTests({
    thread,
    pendingTurns: [{
      turnId: 'turn:13',
      createdAt: now,
      updatedAt: now,
      sessionId: 'locomo',
      project: 'locomo',
      cwd: '/workspace/locomo',
      agent: 'Melanie',
      extractor: 'default-extractor',
      prompt: 'DATE: 1:56 pm on 8 May, 2023\nDIALOGUE:\nMelanie said: "Yeah, I painted that lake sunrise last year!"',
      response: '[imported dialogue event; no assistant response]',
      extractionEpoch: 2,
    }],
    extractionEpoch: 2,
    sessionExtractionImpl,
  });

  assert.deepEqual(extractionInputs[0].turns, [{
    turnId: 'turn:13',
    prompt: 'DATE: 1:56 pm on 8 May, 2023\nDIALOGUE:\nMelanie said: "Yeah, I painted that lake sunrise last year!"',
    response: '[imported dialogue event; no assistant response]',
  }]);
  assert.deepEqual(thread.snapshots.at(-1).contextRefs, [{
    turnId: 'turn:13',
    summary: 'Melanie says she painted the lake sunrise in 2022, described as last year relative to 8 May 2023.',
  }]);
});

test('extracted turns without extractor context refs are not persisted as references', async () => {
  const now = '2026-01-01T00:00:00.000Z';
  const thread = createSessionThread(
    'default-extractor',
    'Session locomo',
    'Default session thread for session locomo.',
    [],
    1,
    now,
    'session',
    'locomo',
    { agent: 'Melanie', project: 'locomo', cwd: '/workspace/locomo' },
  );
  const sessionExtractionImpl = async () => ({
    title: 'Career',
    snapshotContent: '',
    extractions: [],
    nextSteps: [],
    contextRefs: [],
  });

  await sessionTesting.extractSessionThreadForTests({
    thread,
    pendingTurns: [{
      turnId: 'turn:99',
      createdAt: now,
      updatedAt: now,
      sessionId: 'locomo',
      project: 'locomo',
      cwd: '/workspace/locomo',
      agent: 'Melanie',
      extractor: 'default-extractor',
      title: null,
      summary: 'A routed but ultimately irrelevant turn.',
      prompt: 'A routed but ultimately irrelevant turn.',
      response: null,
      extractionEpoch: 2,
    }],
    extractionEpoch: 2,
    sessionExtractionImpl,
  });

  assert.deepEqual(thread.snapshots.at(-1).contextRefs, []);
  assert.deepEqual(thread.references, []);
});

test('raw-turn session only updates the session thread', async () => {
  const now = '2026-01-01T00:00:00.000Z';
  const thread = createSessionThread(
    'default-extractor',
    'Session locomo',
    'Default session thread for session locomo.',
    [],
    1,
    now,
    'session',
    'locomo',
    { agent: 'Melanie', project: 'locomo', cwd: '/workspace/locomo' },
  );
  const threads = [thread];
  const extractionInputs = [];
  const sessionExtractionImpl = async (input) => {
    extractionInputs.push(input);
    return {
      title: 'Melanie lake sunrise painting and creative outlet',
      snapshotContent: snapshotContentFixture(
        [
          '<!-- refs: [turn:12] -->',
          '### Title',
          'Lake painting outlet',
          '',
          '### Summary',
          'Melanie discusses her lake sunrise painting and painting as a creative outlet.',
        ].join('\n'),
        {
          title: 'Melanie lake sunrise painting and creative outlet',
          summary: 'Melanie shared a lake sunrise painting memory.',
        },
      ),
      extractions: [],
      nextSteps: [],
      contextRefs: [{
        turnId: 'turn:12',
        summary: 'Melanie shared a photo of a lake painting.',
      }],
    };
  };

  await sessionTesting.extractSessionThreadForTests({
    thread,
    pendingTurns: [{
      turnId: 'turn:12',
      createdAt: now,
      updatedAt: now,
      sessionId: 'locomo',
      project: 'locomo',
      cwd: '/workspace/locomo',
      agent: 'Melanie',
      extractor: 'default-extractor',
      title: null,
      summary: 'Melanie encouraged Caroline and shared a lake painting.',
      prompt: 'Melanie said: "You would be a great counselor. By the way, take a look at this painting."',
      response: null,
      extractionEpoch: 2,
    }],
    extractionEpoch: 2,
    sessionExtractionImpl,
  });

  assert.equal(threads.length, 1);
  assert.equal(threads[0].kind, 'session');
  assert.equal(extractionInputs[0].turns[0].prompt, 'Melanie said: "You would be a great counselor. By the way, take a look at this painting."');
});

test('extractEpoch groups mixed session turns before session', async () => {
  const threads = [];
  const extractionInputs = [];
  const snapshotRows = [];
  const client = {
    sessionTable: {
      insert: async ({ snapshots }) => {
        snapshotRows.push(...snapshots);
        return snapshots.map((snapshot, index) => ({
          ...snapshot,
          snapshotId: `snapshot-${index + 1}`,
        }));
      },
    },
  };
  const sessionExtractionImpl = async (input) => {
    extractionInputs.push(input);
    return {
      title: input.sessionMemory.title,
      snapshotContent: '',
      extractions: [],
      nextSteps: [],
      contextRefs: input.turns.map((turn) => ({
        turnId: turn.turnId,
        summary: `${turn.turnId} relevant content`,
      })),
    };
  };

  const groupA1 = makeExtractableTurn('session:a1', 2, 'a1');
  const groupB1 = { ...makeExtractableTurn('session:b1', 2, 'b1'), sessionId: 'group-b' };
  const groupA2 = makeExtractableTurn('session:a2', 2, 'a2');

  const result = await sessionTesting.extractEpoch({
    client,
    extractorName: 'default-extractor',
    activeWindowDays: 3650,
    threads,
    sealedEpoch: {
      epoch: 2,
      turns: [groupA1, groupB1, groupA2],
    },
    sessionExtractionImpl,
  });

  assert.equal(extractionInputs.length, 2);
  assert.deepEqual(extractionInputs[0].turns.map((turn) => turn.turnId), ['session:a1', 'session:a2']);
  assert.deepEqual(extractionInputs[1].turns.map((turn) => turn.turnId), ['session:b1']);
  assert.deepEqual(threads.map((thread) => thread.sessionId), ['group-a', 'group-b']);
  assert.equal(result.touchedIds.size, 2);
  assert.equal(snapshotRows.length, 2);
});

test('extractEpoch chunks same-session turns by maxEpochTurns', async () => {
  const threads = [];
  const extractionInputs = [];
  const snapshotRows = [];
  const client = {
    sessionTable: {
      insert: async ({ snapshots }) => {
        snapshotRows.push(...snapshots);
        return snapshots.map((snapshot, index) => ({
          ...snapshot,
          snapshotId: `snapshot-${index + 1}`,
        }));
      },
    },
  };
  const sessionExtractionImpl = async (input) => {
    extractionInputs.push(input);
    return {
      title: input.sessionMemory.title,
      snapshotContent: '',
      extractions: [],
      nextSteps: [],
      contextRefs: input.turns.map((turn) => ({
        turnId: turn.turnId,
        summary: `${turn.turnId} relevant content`,
      })),
    };
  };

  const turns = Array.from({ length: 70 }, (_, index) => makeExtractableTurn(`session:turn-${index + 1}`, 2, `turn ${index + 1}`));

  const result = await sessionTesting.extractEpoch({
    client,
    extractorName: 'default-extractor',
    activeWindowDays: 3650,
    maxEpochTurns: 32,
    threads,
    sealedEpoch: {
      epoch: 2,
      turns,
    },
    sessionExtractionImpl,
  });

  assert.deepEqual(extractionInputs.map((input) => input.turns.length), [32, 32, 6]);
  assert.deepEqual(extractionInputs[0].turns.map((turn) => turn.turnId).slice(0, 2), ['session:turn-1', 'session:turn-2']);
  assert.deepEqual(extractionInputs[2].turns.map((turn) => turn.turnId), [
    'session:turn-65',
    'session:turn-66',
    'session:turn-67',
    'session:turn-68',
    'session:turn-69',
    'session:turn-70',
  ]);
  assert.equal(result.touchedIds.size, 1);
  assert.equal(snapshotRows.length, 3);
  assert.deepEqual(snapshotRows.map((snapshot) => snapshot.snapshotSequence), [0, 1, 2]);
  assert.deepEqual(snapshotRows.map((snapshot) => snapshot.references.length), [32, 64, 70]);
  assert.deepEqual(result.threads[0].snapshotIds, ['snapshot-1', 'snapshot-2', 'snapshot-3']);
});

test('extractEpoch chunks same-session turns by rendered newBatchInputChars', async () => {
  const threads = [];
  const extractionInputs = [];
  const snapshotRows = [];
  const client = {
    sessionTable: {
      insert: async ({ snapshots }) => {
        snapshotRows.push(...snapshots);
        return snapshots.map((snapshot, index) => ({
          ...snapshot,
          snapshotId: `snapshot-${index + 1}`,
        }));
      },
    },
  };
  const sessionExtractionImpl = async (input) => {
    extractionInputs.push(input);
    return {
      title: input.sessionMemory.title,
      snapshotContent: '',
      extractions: [],
      nextSteps: [],
      contextRefs: input.turns.map((turn) => ({
        turnId: turn.turnId,
        summary: `${turn.turnId} relevant content`,
      })),
    };
  };

  const turns = Array.from({ length: 4 }, (_, index) => ({
    ...makeExtractableTurn(`session:budget-${index + 1}`, 2, `turn ${index + 1}`),
    response: 'x'.repeat(180),
  }));

  await sessionTesting.extractEpoch({
    client,
    extractorName: 'default-extractor',
    activeWindowDays: 3650,
    maxEpochTurns: 32,
    newBatchInputChars: 900,
    previewChars: 800,
    threads,
    sealedEpoch: {
      epoch: 2,
      turns,
    },
    sessionExtractionImpl,
  });

  assert.deepEqual(extractionInputs.map((input) => input.turns.length), [2, 2]);
  assert.deepEqual(extractionInputs.map((input) => input.inputBudgetStoppedBy), ['new-batch-input-chars', 'none']);
  assert.deepEqual(extractionInputs.map((input) => input.deferredTurnCount), [2, 0]);
  assert.equal(snapshotRows.length, 2);
});

test('extractEpoch routes missing sessionId turns to default session thread', async () => {
  const threads = [];
  const extractionInputs = [];
  const client = {
    sessionTable: {
      insert: async ({ snapshots }) => snapshots.map((snapshot, index) => ({
        ...snapshot,
        snapshotId: `snapshot-${index + 1}`,
      })),
    },
  };
  const sessionExtractionImpl = async (input) => {
    extractionInputs.push(input);
    return {
      title: input.sessionMemory.title,
      snapshotContent: '',
      extractions: [],
      nextSteps: [],
      contextRefs: input.turns.map((turn) => ({
        turnId: turn.turnId,
        summary: `${turn.turnId} relevant content`,
      })),
    };
  };

  await sessionTesting.extractEpoch({
    client,
    extractorName: 'default-extractor',
    activeWindowDays: 3650,
    threads,
    sealedEpoch: {
      epoch: 2,
      turns: [
        { ...makeExtractableTurn('turn:null-1', 2, 'null-1'), sessionId: null },
        { ...makeExtractableTurn('turn:blank-1', 2, 'blank-1'), sessionId: '   ' },
      ],
    },
    sessionExtractionImpl,
  });

  assert.equal(extractionInputs.length, 1);
  assert.deepEqual(extractionInputs[0].turns.map((turn) => turn.turnId), ['turn:null-1', 'turn:blank-1']);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].sessionId, '__muninn_default_session__');
});

test('extractSessionThread rejects mixed session turns', async () => {
  const now = '2026-01-01T00:00:00.000Z';
  const thread = createSessionThread('default-extractor', 'Session group-a', 'Default session thread for session group-a.', [], 1, now, 'session', 'group-a');
  const sessionExtractionImpl = async () => {
    throw new Error('sessionExtractionImpl should not be called for mixed session turns');
  };

  await assert.rejects(
    sessionTesting.extractSessionThreadForTests({
      thread,
      pendingTurns: [
        makeExtractableTurn('session:a1', 2, 'a1'),
        { ...makeExtractableTurn('session:b1', 2, 'b1'), sessionId: 'group-b' },
      ],
      extractionEpoch: 2,
      sessionExtractionImpl,
    }),
    /single session/i,
  );
});

test('indexTouchedExtractions immediately advances extraction index for touched threads', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  let semanticUpserts = 0;
  const threads = [{
    threadId: 'session-a',
    sessionId: 'session-a',
    project: 'alpha',
    cwd: '/workspace/alpha',
    agent: 'codex',
    kind: 'session',
    snapshotId: 'snapshot-1',
    snapshotIds: ['snapshot-0', 'snapshot-1'],
    extractionEpoch: 1,
    title: 'Existing title',
    summary: 'Existing summary',
    snapshots: [
      {
        project: 'alpha',
        cwd: '/workspace/alpha',
        agent: 'codex',
        extractions: [],
        contextRefs: [],
        nextSteps: [],
        extractionChanges: [],
      },
      {
        project: 'alpha',
        cwd: '/workspace/alpha',
        agent: 'codex',
        extractions: [{ id: 'memory-1', text: 'remember this', category: 'Fact', references: ['turn:existing'], updatedMemory: null }],
        contextRefs: [],
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
    extractor: 'default-extractor',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  }];

  await indexTesting.indexTouchedExtractions({
    sessionTable: {
      update: async ({ snapshots }) => snapshots,
    },
    extractionTable: {
      delete: async () => ({ deleted: 0 }),
      get: async () => [],
      upsert: async () => {
        semanticUpserts += 1;
      },
    },
  }, threads, new Set(['codex\0/workspace/alpha\0session-a']));

  assert.equal(semanticUpserts, 1);
  assert.equal(threads[0].indexedSnapshotSequence, 1);
  assert.equal(getPendingIndex(threads[0]), null);
});

test('extractor.retrySnapshotIndexing refreshes the committed checkpoint snapshot after session rows are updated', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  const extractor = new Extractor({
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
      get: async () => [],
      upsert: async () => undefined,
      stats: async () => ({
        version: 9,
        fragmentCount: 1,
        rowCount: 1,
      }),
    },
  });
  t.after(async () => extractor.shutdown());

  extractor.bootstrapped = true;
  extractor.committedEpoch = 1;
  extractor.openEpoch = new OpenEpoch(2);
  extractor.threads = [{
    sessionId: 'session-a',
    project: 'alpha',
    cwd: '/workspace/alpha',
    agent: 'codex',
    snapshotId: 'snapshot-1',
    snapshotIds: ['snapshot-0', 'snapshot-1'],
    extractionEpoch: 1,
    title: 'Existing title',
    summary: 'Existing summary',
    snapshots: [
      { project: 'alpha', cwd: '/workspace/alpha', agent: 'codex', snapshotContent: '', extractions: [], contextRefs: [], nextSteps: [], extractionChanges: [] },
      {
        project: 'alpha',
        cwd: '/workspace/alpha',
        agent: 'codex',
        snapshotContent: '',
        extractions: [{ id: 'memory-1', text: 'remember this', category: 'Fact', references: ['session:existing'], updatedMemory: null }],
        contextRefs: [],
        nextSteps: [],
        extractionChanges: [{
          type: 'update',
          extractionId: 'memory-1',
          text: 'remember this',
          reason: 'refreshes the existing extraction wording',
        }],
      },
    ],
    references: ['session:existing'],
    indexedSnapshotSequence: 0,
    extractor: 'default-extractor',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  }];
  extractor.refreshCheckpointSnapshot();

  await extractor.retrySnapshotIndexing();

  assert.deepEqual(extractor.exportCheckpoint(), {
    committedEpoch: 1,
    nextEpoch: 2,
    runs: [],
    threads: [{
      sessionId: 'session-a',
      latestSnapshotId: 'snapshot-1',
      latestSnapshotSequence: 1,
      indexedSnapshotSequence: 1,
      updatedAt: '2024-01-01T00:00:00Z',
    }],
  });
});

test('extractor.extractCurrentEpoch commits session rows before retrying extraction changes', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  let extractionUpserts = 0;
  let indexAttempts = 0;
  const extractor = new Extractor({
    sessionTable: {
      insert: async ({ snapshots }) => snapshots.map((snapshot) => ({
        ...snapshot,
        snapshotId: 'snapshot-1',
      })),
      update: async ({ snapshots }) => snapshots,
    },
    extractionTable: {
      delete: async () => ({ deleted: 0 }),
      get: async () => [],
      upsert: async () => {
        extractionUpserts += 1;
      },
    },
  });

  extractor.bootstrapped = true;
  extractor.openEpoch = new OpenEpoch(2);
  extractor.currentEpoch = {
    epoch: 1,
    turns: [makeExtractableTurn('turn-1', 1, 'first')],
  };
  extractor.threads = [{
    sessionId: 'session-a',
    snapshotId: 'snapshot-0',
    snapshotIds: ['snapshot-0'],
    extractionEpoch: 0,
    title: 'Existing title',
    summary: 'Existing summary',
    snapshots: [
      { extractions: [], contextRefs: [], nextSteps: [], extractionDelta: { before: [], after: [] } },
    ],
    references: ['session:existing'],
    indexedSnapshotSequence: 0,
    extractor: 'default-extractor',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  }];
  extractor.indexCurrentEpochSnapshots = async () => {
    indexAttempts += 1;
    throw new Error('extraction write failed');
  };

  await extractor.extractCurrentEpoch();

  assert.equal(extractionUpserts, 0);
  assert.equal(indexAttempts, 1);
  assert.equal(extractor.committedEpoch, 1);
  assert.equal(extractor.currentEpoch, null);
  const touchedThread = extractor.threads.find((thread) => thread.snapshotId === 'snapshot-1');
  assert.ok(touchedThread);
  assert.ok(getPendingIndex(touchedThread));
  assert.ok(extractor.nextIndexRetryAt > Date.now());
});

test('extractor.run retries pending extraction index before queued epochs when due', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  const calls = [];
  const extractor = new Extractor({
    sessionTable: {
      update: async ({ snapshots }) => snapshots,
    },
    extractionTable: {
      delete: async () => ({ deleted: 0 }),
      get: async () => [],
      upsert: async () => {
        calls.push('index');
      },
    },
  });

  extractor.bootstrapped = true;
  extractor.openEpoch = new OpenEpoch(9);
  extractor.threads = [
    {
      sessionId: 'session-a',
      project: 'alpha',
      cwd: '/workspace/alpha',
      agent: 'codex',
      snapshotId: 'snapshot-1',
      snapshotIds: ['snapshot-0', 'snapshot-1'],
      extractionEpoch: 7,
      title: 'Title',
      summary: 'Summary',
      snapshots: [
        {
          project: 'alpha',
          cwd: '/workspace/alpha',
          agent: 'codex',
          snapshotContent: '',
          extractions: [],
          contextRefs: [],
          nextSteps: [],
          extractionChanges: [],
        },
        {
          project: 'alpha',
          cwd: '/workspace/alpha',
          agent: 'codex',
          snapshotContent: '',
          extractions: [],
          contextRefs: [],
          nextSteps: [],
          extractionChanges: [{ type: 'add', text: 'remember this', references: ['session:existing'], reason: 'adds memory' }],
        },
      ],
      references: [],
      indexedSnapshotSequence: 0,
      extractor: 'default-extractor',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
  ];
  extractor.nextIndexRetryAt = Date.now() - 1;
  extractor.epochQueue.publishEpoch({
    epoch: 8,
    turns: [
      {
        turnId: 'turn-queued',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        agent: 'agent-a',
        extractor: 'default-extractor',
        summary: 'queued summary',
        response: 'queued response',
        extractionEpoch: 8,
      },
    ],
  });

  extractor.retrySnapshotIndexing = async () => {
    calls.push('index');
    extractor.nextIndexRetryAt = undefined;
    extractor.threads = [];
  };
  extractor.extractCurrentEpoch = async () => {
    calls.push('extract');
    extractor.currentEpoch = null;
    extractor.threads = [];
    extractor.shuttingDown = true;
    extractor.epochQueue.close();
  };

  await extractor.run();

  assert.deepEqual(calls, ['index', 'extract']);
});

test('extractor.watermark exposes extraction index retry failures', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  const extractor = new Extractor({
    sessionTable: {
      update: async ({ snapshots }) => snapshots,
    },
    extractionTable: {
      delete: async () => ({ deleted: 0 }),
      get: async () => [],
      upsert: async () => {
        throw new Error('extraction write failed');
      },
    },
  });

  extractor.bootstrapped = true;
  extractor.openEpoch = new OpenEpoch(9);
  extractor.threads = [{
    sessionId: 'session-a',
    project: 'alpha',
    cwd: '/workspace/alpha',
    agent: 'codex',
    snapshotId: 'snapshot-1',
    snapshotIds: ['snapshot-0', 'snapshot-1'],
    extractionEpoch: 7,
    title: 'Title',
    summary: 'Summary',
    snapshots: [
      {
        project: 'alpha',
        cwd: '/workspace/alpha',
        agent: 'codex',
        snapshotContent: '',
        extractions: [],
        contextRefs: [],
        nextSteps: [],
        extractionChanges: [],
      },
      {
        project: 'alpha',
        cwd: '/workspace/alpha',
        agent: 'codex',
        snapshotContent: '',
        extractions: [{ id: 'memory-1', text: 'remember this', category: 'Fact', references: ['session:existing'], updatedMemory: null }],
        contextRefs: [],
        nextSteps: [],
        extractionChanges: [{
          type: 'update',
          extractionId: 'memory-1',
          text: 'remember this',
          reason: 'refreshes the existing extraction wording',
        }],
      },
    ],
    references: [],
    indexedSnapshotSequence: 0,
    extractor: 'default-extractor',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  }];

  await extractor.retrySnapshotIndexing();

  const watermark = await extractor.watermark();
  assert.equal(watermark.phases.extractor, 'error');
  assert.deepEqual(watermark.error, {
    phase: 'extractor',
    message: 'Error: extraction write failed',
  });
});

test('extractor.watermark blocks later epochs after terminal epoch failures', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath, { maxAttempts: 2 });

  const extractor = new Extractor({});
  extractor.bootstrapped = true;
  extractor.openEpoch = new OpenEpoch(2);
  extractor.currentEpoch = {
    epoch: 1,
    turns: [makeExtractableTurn('turn-failed', 1, 'failed extraction')],
  };

  let attempts = 0;
  const completedEpochs = [];
  extractor.extractCurrentEpoch = async () => {
    if (extractor.currentEpoch?.epoch === 2) {
      completedEpochs.push(extractor.currentEpoch.epoch);
      extractor.currentEpoch = null;
      extractor.currentEpochAttempts = 0;
      extractor.notifyChange();
      return;
    }
    attempts += 1;
    throw new Error('provider returned empty output');
  };

  const runPromise = extractor.run();
  t.after(async () => {
    extractor.shuttingDown = true;
    extractor.notifyChange();
    extractor.epochQueue.close();
    await runPromise;
  });

  let watermark = await extractor.watermark();
  for (let attempt = 0; attempt < 50 && watermark.phases.extractor !== 'error'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    watermark = await extractor.watermark();
  }

  assert.equal(attempts, 2);
  assert.deepEqual(watermark.pending.turns, ['turn-failed']);
  assert.equal(watermark.phases.extractor, 'error');
  assert.deepEqual(watermark.error, {
    phase: 'extractor',
    message: 'Error: provider returned empty output',
  });

  extractor.epochQueue.publishEpoch({
    epoch: 2,
    turns: [makeExtractableTurn('turn-next', 2, 'next extraction')],
  });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.deepEqual(completedEpochs, []);
  watermark = await extractor.watermark();
  assert.deepEqual(watermark.pending.turns, ['turn-failed', 'turn-next']);
  assert.equal(watermark.phases.extractor, 'error');
});

test('extractor retries terminal failed epochs after configured cooldown', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath, {
    maxAttempts: 2,
    failedEpochRetryIntervalMs: 25,
  });

  const extractor = new Extractor({});
  extractor.bootstrapped = true;
  extractor.openEpoch = new OpenEpoch(2);
  extractor.currentEpoch = {
    epoch: 1,
    turns: [makeExtractableTurn('turn-retry', 1, 'retry extraction')],
  };

  let attempts = 0;
  extractor.extractCurrentEpoch = async () => {
    attempts += 1;
    if (attempts <= 2) {
      throw new Error('temporary provider outage');
    }
    extractor.currentEpoch = null;
    extractor.currentEpochAttempts = 0;
    extractor.lastEpochError = undefined;
    extractor.notifyChange();
  };

  const runPromise = extractor.run();
  t.after(async () => {
    extractor.shuttingDown = true;
    extractor.notifyChange();
    extractor.epochQueue.close();
    await runPromise;
  });

  let watermark = await extractor.watermark();
  for (let attempt = 0; attempt < 50 && watermark.phases.extractor !== 'error'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    watermark = await extractor.watermark();
  }

  assert.equal(attempts, 2);
  assert.equal(watermark.phases.extractor, 'error');
  assert.deepEqual(watermark.pending.turns, ['turn-retry']);

  for (let attempt = 0; attempt < 50 && attempts < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(attempts, 3);
  watermark = await extractor.watermark();
  assert.equal(watermark.phases.extractor, 'idle');
  assert.deepEqual(watermark.pending.turns, []);
});

test('extractor.accept keeps a partial epoch open until minEpochTurns is reached', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath, { minEpochTurns: 3, epochWindowMs: 10_000 });

  const extractor = new Extractor(makeExtractorClient());
  extractor.bootstrapped = true;
  extractor.openEpoch = new OpenEpoch(1);
  t.after(async () => extractor.shutdown());

  let acceptCount = 0;
  const registry = {
    load: async () => ({
      accept: async (_content, epoch) => {
        acceptCount += 1;
        return {
          turn: makeExtractableTurn(`turn-${acceptCount}`, epoch, `turn ${acceptCount}`),
          deduped: false,
        };
      },
    }),
  };

  await extractor.accept(makeTurnContent('one', 'one'), registry);
  assert.equal(extractor.openEpoch.epoch, 1);
  assert.deepEqual(extractor.openEpoch.stagedTurns().map((turn) => turn.turnId), ['turn-1']);
  assert.deepEqual(extractor.epochQueue.pendingTurns(), []);

  await extractor.accept(makeTurnContent('two', 'two'), registry);
  assert.equal(extractor.openEpoch.epoch, 1);
  assert.deepEqual(extractor.openEpoch.stagedTurns().map((turn) => turn.turnId), ['turn-1', 'turn-2']);
  assert.deepEqual(extractor.epochQueue.pendingTurns(), []);

  await extractor.accept(makeTurnContent('three', 'three'), registry);
  await extractor.publishChain;

  assert.equal(extractor.openEpoch.epoch, 2);
  assert.deepEqual(extractor.epochQueue.pendingTurns().map((turn) => turn.turnId), ['turn-1', 'turn-2', 'turn-3']);
});

test('extractor.accept seals a partial epoch when the epoch window expires', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath, { minEpochTurns: 3, epochWindowMs: 20 });

  const extractor = new Extractor(makeExtractorClient());
  extractor.bootstrapped = true;
  extractor.openEpoch = new OpenEpoch(1);
  t.after(async () => extractor.shutdown());

  const registry = {
    load: async () => ({
      accept: async (_content, epoch) => ({
        turn: makeExtractableTurn('turn-1', epoch, 'first'),
        deduped: false,
      }),
    }),
  };

  await extractor.accept(makeTurnContent('one', 'one'), registry);
  assert.equal(extractor.openEpoch.epoch, 1);

  await waitFor(() => extractor.openEpoch.epoch === 2);
  await extractor.publishChain;

  assert.deepEqual(extractor.epochQueue.pendingTurns().map((turn) => turn.turnId), ['turn-1']);
});

test('extractor.accept does not start the epoch window for non-extractable turns', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath, { minEpochTurns: 3, epochWindowMs: 20 });

  const extractor = new Extractor(makeExtractorClient());
  extractor.bootstrapped = true;
  extractor.openEpoch = new OpenEpoch(1);
  t.after(async () => extractor.shutdown());

  const registry = {
    load: async () => ({
      accept: async () => ({
        turn: {
          ...makeExtractableTurn('turn-1', 1, 'first'),
          response: null,
        },
        deduped: false,
      }),
    }),
  };

  await extractor.accept(makeTurnContent('one', ''), registry);
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(extractor.openEpoch.epoch, 1);
  assert.deepEqual(extractor.openEpoch.stagedTurns(), []);
  assert.deepEqual(extractor.epochQueue.pendingTurns(), []);
});

test('flushPending waits for an in-flight accept that started before the barrier', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  const extractor = new Extractor(makeExtractorClient());
  extractor.bootstrapped = true;
  extractor.openEpoch = new OpenEpoch(1);
  extractor.start();
  t.after(async () => extractor.shutdown());

  const firstEntered = deferred();
  const releaseFirst = deferred();
  const registry = {
    load: async () => ({
      accept: async (_content, epoch) => {
        firstEntered.resolve();
        await releaseFirst.promise;
        return {
          turn: makeExtractableTurn('turn-1', epoch, 'first'),
          deduped: false,
        };
      },
    }),
  };

  const acceptPromise = extractor.accept(makeTurnContent('first prompt', 'first response'), registry);
  await firstEntered.promise;

  const flushPromise = extractor.flushPending();
  const pendingState = await Promise.race([
    flushPromise.then(() => 'flushed'),
    new Promise((resolve) => setTimeout(() => resolve('waiting'), 25)),
  ]);
  assert.equal(pendingState, 'waiting');

  releaseFirst.resolve();
  await acceptPromise;
  await flushPromise;

  assert.equal(extractor.committedEpoch, 1);
});

test('flushPending does not wait for accepts that start after the barrier', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  const extractor = new Extractor(makeExtractorClient());
  extractor.bootstrapped = true;
  extractor.openEpoch = new OpenEpoch(1);
  extractor.start();
  t.after(async () => extractor.shutdown());

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
            turn: makeExtractableTurn('turn-1', epoch, 'first'),
            deduped: false,
          };
        }
        secondEpoch = epoch;
        secondEntered.resolve();
        await releaseSecond.promise;
        return {
          turn: makeExtractableTurn('turn-2', epoch, 'second'),
          deduped: true,
        };
      },
    }),
  };

  await extractor.accept(makeTurnContent('first prompt', 'first response'), registry);

  const flushPromise = extractor.flushPending();
  while (extractor.openEpoch.epoch !== 2) {
    await Promise.resolve();
  }

  const secondAccept = extractor.accept(makeTurnContent('second prompt', 'second response'), registry);
  await secondEntered.promise;

  await Promise.race([
    flushPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('flushPending waited on post-barrier accept')), 100)),
  ]);

  assert.equal(secondEpoch, 2);

  releaseSecond.resolve();
  await secondAccept;
});

test('flushPending rejects when a terminal epoch failure blocks the barrier', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath, { maxAttempts: 1 });

  const extractor = new Extractor({});
  extractor.bootstrapped = true;
  extractor.openEpoch = new OpenEpoch(2);
  extractor.currentEpoch = {
    epoch: 1,
    turns: [makeExtractableTurn('turn-failed', 1, 'failed extraction')],
  };
  extractor.extractCurrentEpoch = async () => {
    throw new Error('provider returned empty output');
  };

  const runPromise = extractor.run();
  t.after(async () => {
    extractor.shuttingDown = true;
    extractor.notifyChange();
    extractor.epochQueue.close();
    await runPromise;
  });

  await waitFor(async () => {
    const watermark = await extractor.watermark();
    return watermark.phases.extractor === 'error';
  });

  await assert.rejects(
    () => extractor.flushPending(),
    /extractor epoch 1 failed after 1 attempts: Error: provider returned empty output/,
  );
});

test('flushPending rejects when sealing the barrier epoch fails', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  const extractor = new Extractor(makeExtractorClient());
  extractor.bootstrapped = true;
  extractor.openEpoch = {
    epoch: 1,
    hasStagedTurns: () => true,
    stagedTurns: () => [],
    seal: async () => {
      throw new Error('seal failed');
    },
  };

  await assert.rejects(
    () => extractor.flushPending(),
    /seal failed/,
  );
});

test('extractor.accept rejects new writes after shutdown starts', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  const extractor = new Extractor(makeExtractorClient());
  extractor.bootstrapped = true;
  extractor.openEpoch = new OpenEpoch(1);

  await extractor.shutdown();

  await assert.rejects(
    () => extractor.accept(makeTurnContent('late prompt', 'late response'), {
      load: async () => ({
        accept: async () => makeExtractableTurn('turn-late', 1, 'late'),
      }),
    }),
    /extractor is shutting down/,
  );
});

test('extractor.shutdown does not wait for pending publish chain', async () => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  try {
    const extractor = new Extractor({});
    extractor.bootstrapped = true;
    extractor.openEpoch = new OpenEpoch(1);

    let releasePublish;
    extractor.publishChain = new Promise((resolve) => {
      releasePublish = resolve;
    });

    const shutdownPromise = extractor.shutdown();
    await Promise.race([
      shutdownPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown blocked on publish chain')), 50)),
    ]);

    releasePublish();
    await extractor.publishChain;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extractor.watermark keeps sealed turns visible while publish is in flight', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  const extractor = new Extractor({});
  extractor.bootstrapped = true;
  const turn = makeExtractableTurn('turn:42', 7, 'publishing');
  const openEpoch = new OpenEpoch(7, [turn]);
  extractor.openEpoch = openEpoch;

  let releasePublish;
  extractor.publishChain = new Promise((resolve) => {
    releasePublish = resolve;
  });

  const barrier = extractor.sealOpenEpoch(openEpoch);
  assert.ok(barrier);

  const watermark = await extractor.watermark();
  assert.deepEqual(watermark.pending.turns, [turn.turnId]);
  assert.equal(memoryWatermarkResolved(watermark), false);

  releasePublish();
  await extractor.publishChain;
});

test('extractor shutdown relies on restart replay for unpublished extractor work', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeOpenAiExtractorConfig(configPath);

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

  await captureTurn(makeTurnContent('replay prompt', 'replay response'));

  await shutdownCoreForTests();

  const watermark = await memoryPipelineApi.watermark();
  assert.ok(watermark.pending.turns.length > 0);

  await shutdownCoreForTests();
});

test('flushThreads persists session state without inline ref or index builders', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  const threads = [
    {
      threadId: 'session-child',
      sessionId: 'session-child',
      project: 'alpha',
      cwd: '/workspace/alpha',
      agent: 'codex',
      kind: 'session',
      snapshotId: undefined,
      snapshotIds: [],
      extractionEpoch: 1,
      title: 'Child',
      summary: 'Child summary',
      snapshots: [
        {
          threadKind: 'session',
          sessionId: 'session-child',
          project: 'alpha',
          cwd: '/workspace/alpha',
          agent: 'codex',
          snapshotContent: '',
          extractions: [],
          contextRefs: [],
          nextSteps: [],
          extractionChanges: [],
        },
      ],
      references: [],
      indexedSnapshotSequence: null,
      extractor: 'default-extractor',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
  ];

  await sessionTesting.flushThreads({
    sessionTable: {
      insert: async ({ snapshots }) => {
        return snapshots.map((snapshot) => ({
          ...snapshot,
          snapshotId: snapshot.sessionId === 'session-child' ? 'snapshot-child' : snapshot.snapshotId,
        }));
      },
    },
  }, threads, new Set(['codex\0/workspace/alpha\0session-child']));

  assert.equal(threads[0].snapshotId, 'snapshot-child');
  assert.equal(threads[0].indexedSnapshotSequence, null);
});

test('flushThreads keeps same raw session id isolated by cwd', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);

  const makeThread = (project, cwd) => ({
    threadId: 'shared-session',
    sessionId: 'shared-session',
    project,
    cwd,
    agent: 'codex',
    kind: 'session',
    snapshotId: undefined,
    snapshotIds: [],
    extractionEpoch: 1,
    title: `${project} session`,
    summary: `${project} summary`,
    snapshots: [
      {
        threadKind: 'session',
        sessionId: 'shared-session',
        project,
        cwd,
        agent: 'codex',
        snapshotContent: '',
        extractions: [],
        contextRefs: [],
        nextSteps: [],
        extractionChanges: [],
      },
    ],
    references: [],
    indexedSnapshotSequence: null,
    extractor: 'default-extractor',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  });
  const threads = [
    makeThread('alpha', '/workspace/alpha'),
    makeThread('beta', '/workspace/beta'),
  ];

  await sessionTesting.flushThreads({
    sessionTable: {
      insert: async ({ snapshots }) => snapshots.map((snapshot) => ({
        ...snapshot,
        snapshotId: `snapshot-${snapshot.project}`,
      })),
    },
  }, threads, new Set([
    'codex\0/workspace/alpha\0shared-session',
    'codex\0/workspace/beta\0shared-session',
  ]));

  assert.equal(threads[0].snapshotId, 'snapshot-alpha');
  assert.equal(threads[1].snapshotId, 'snapshot-beta');
});
