import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';

import core from '../../dist/backend.js';
import { __testing } from '../../dist/backend.js';
import {
  getObserverRuntimeConfigFromConfigForTests,
  getExtractorLlmConfig,
  getObserverLlmConfig,
  validateMuninnConfigInput,
} from '../../dist/config.js';
import { MuninnBackend } from '../../dist/backend.js';
import { Extractor as Observer } from '../../dist/pipeline/extractor.js';
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
const { createSessionThread, getPendingIndex, getPendingIndexUpTo, loadThreads, toSessionSnapshot } = sessionModule;
const { captureTurn, observer: observerApi, shutdownCoreForTests } = core;
const CHECKPOINT_SCHEMA_VERSION = 10;
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
    observation: 0,
    ...(overrides.baseline ?? {}),
  };
  return {
    baseline,
    committedEpoch: 12,
    nextEpoch: 13,
    recentSessions: [],
    threads: [],
    runs: [],
    pendingExtractionChanges: [],
    ...overrides,
    baseline,
  };
}

function makeObserverCheckpoint(overrides = {}) {
  const baseline = {
    observationContext: 0,
    observation: 0,
    ...(overrides.baseline ?? {}),
  };
  return {
    baseline,
    observeQueue: { cwdBuckets: [] },
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
    observer: overrides.observer ?? makeObserverCheckpoint(),
    sessionIndex: overrides.sessionIndex ?? {
      baseline: { turn: 10, session: 21 },
      entries: [],
    },
  };
}

function memoryWatermarkResolved(watermark) {
  return watermark.pending.turns.length === 0
    && watermark.pending.extractions.length === 0
    && watermark.phases.extractor === 'idle'
    && watermark.phases.observer === 'idle'
    && !watermark.error;
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
    extractor: {
      name,
      llmProvider: 'extractor_llm',
      embeddingProvider: 'default',
      maxAttempts: 3,
      activeWindowDays,
      ...(epochTurns === undefined ? {} : { epochTurns }),
      ...(epochWindowMs === undefined ? {} : { epochWindowMs }),
    },
    observer: {
      name: 'default-observer',
      llmProvider: 'observer_llm',
      maxAttempts: 3,
      cwdThreshold: 5,
    },
    providers: {
      llm: {
        extractor_llm: {
          type: 'mock',
        },
        observer_llm: {
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

async function writeOpenAiObserverConfig(configPath) {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    extractor: {
      name: 'default-observer',
      llmProvider: 'extractor_llm',
      embeddingProvider: 'default',
      maxAttempts: 3,
      activeWindowDays: 3650,
    },
    observer: {
      name: 'default-observer',
      llmProvider: 'observer_llm',
      maxAttempts: 3,
      cwdThreshold: 5,
    },
    providers: {
      llm: {
        extractor_llm: {
          type: 'openai',
          apiKey: 'test-key',
        },
        observer_llm: {
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

test('config reads extraction embedding config and rejects semanticIndex', async () => {
  assert.doesNotThrow(() => validateMuninnConfigInput(JSON.stringify({
    storage: { uri: 'file:///tmp/muninn-test' },
    extractor: { name: 'default-extractor', llmProvider: 'extractor_llm', embeddingProvider: 'default' },
    observer: { name: 'default-observer', llmProvider: 'observer_llm' },
    providers: {
      llm: {
        extractor_llm: { type: 'mock' },
        observer_llm: { type: 'mock' },
      },
      embedding: {
        default: { type: 'mock' },
      },
    },
  })));
  assert.throws(() => validateMuninnConfigInput(JSON.stringify({
    storage: { uri: 'file:///tmp/muninn-test' },
    extractor: { name: 'default-extractor', llmProvider: 'extractor_llm', embeddingProvider: 'default' },
    observer: { name: 'default-observer', llmProvider: 'observer_llm' },
    providers: {
      llm: {
        extractor_llm: { type: 'mock' },
        observer_llm: { type: 'mock' },
      },
      embedding: {
        default: { type: 'mock' },
      },
    },
    semanticIndex: { embedding: { provider: 'mock' } },
  })), /semanticIndex/);
});

test('observer cwd threshold defaults to eight and validates positive integer', () => {
  const config = {
    storage: { uri: 'file:///tmp/muninn-test' },
    extractor: { name: 'default-extractor', llmProvider: 'extractor_llm', embeddingProvider: 'default' },
    observer: { name: 'default-observer', llmProvider: 'observer_llm' },
    providers: {
      llm: {
        extractor_llm: { type: 'mock' },
        observer_llm: { type: 'mock' },
      },
      embedding: {
        default: { type: 'mock' },
      },
    },
  };
  assert.equal(getObserverRuntimeConfigFromConfigForTests(config).cwdThreshold, 8);
  assert.throws(() => validateMuninnConfigInput(JSON.stringify({
    ...config,
    observer: { name: 'default-observer', llmProvider: 'observer_llm', cwdThreshold: 0 },
  })), /observer\.cwdThreshold must be a positive integer/);
});

test('native bindings expose observation context and observation tables', async () => {
  const tables = await getNativeTables();
  assert.equal(typeof tables.extractionTable.list, 'function');
  assert.equal(typeof tables.extractionTable.delta, 'function');
  assert.equal(typeof tables.observationContextTable.upsert, 'function');
  assert.equal(typeof tables.observationContextTable.list, 'function');
  assert.equal(typeof tables.observationContextTable.stats, 'function');
  assert.equal(typeof tables.observationContextTable.ensureIdIndex, 'function');
  assert.equal(typeof tables.observationContextTable.optimize, 'function');
  assert.equal(typeof tables.observationTable.upsert, 'function');
  assert.equal(typeof tables.observationTable.delete, 'function');
  assert.equal(typeof tables.observationTable.search, 'function');
  assert.equal(typeof tables.observationTable.stats, 'function');
  assert.equal(typeof tables.observationTable.ensureVectorIndex, 'function');
  assert.equal(typeof tables.observationTable.compact, 'function');
  assert.equal(typeof tables.observationTable.cleanup, 'function');
  assert.equal(typeof tables.observationTable.optimize, 'function');
});

test('table mutation locks serialize writes on the same table', async () => {
  const { TableMutationLocks } = await import('../../dist/native.js');
  const locks = new TableMutationLocks();
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const secondEntered = deferred();

  const first = locks.with('observation', async () => {
    firstEntered.resolve();
    await releaseFirst.promise;
    return 'first';
  });
  await firstEntered.promise;

  const second = locks.with('observation', async () => {
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
  const observationEntered = deferred();
  const release = deferred();

  const extraction = locks.with('extraction', async () => {
    extractionEntered.resolve();
    await release.promise;
  });
  const observation = locks.with('observation', async () => {
    observationEntered.resolve();
    await release.promise;
  });

  await extractionEntered.promise;
  await observationEntered.promise;
  release.resolve();
  await Promise.all([extraction, observation]);
});

test('lockNativeTables serializes same-table mutations without locking reads', async () => {
  const { TableMutationLocks, lockNativeTables } = await import('../../dist/native.js');
  const locks = new TableMutationLocks();
  const upsertEntered = deferred();
  const releaseUpsert = deferred();
  const optimizeEntered = deferred();
  let searchCalls = 0;
  const tables = lockNativeTables({
    observationTable: {
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

  const upsert = tables.observationTable.upsert({ rows: [] });
  await upsertEntered.promise;
  const optimize = tables.observationTable.optimize({ mergeCount: 1 });
  await tables.observationTable.search({ query: 'q', vector: [], limit: 1, mode: 'hybrid' });
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

test('memories.get renders curated observation memories', async () => {
  const client = {
    observationTable: {
      get: async ({ ids }) => ids.includes('obs-1')
        ? [{
            id: 'obs-1',
            path: 'Caroline / Research',
            text: 'Caroline researched adoption agencies.',
            vector: [],
            extractionRefs: ['ext-1'],
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          }]
        : [],
    },
    extractionTable: { get: async () => [] },
    sessionTable: { get: async () => null },
    turnTable: { get: async () => null },
  };
  const { Memories } = await import('../../dist/api/memory.js');
  const memory = await new Memories(client).get('observation:obs-1');

  assert.equal(memory.memoryId, 'observation:obs-1');
  assert.equal(memory.title, 'Caroline researched adoption agencies.');
  assert.equal(memory.summary, 'Caroline researched adoption agencies.');
  assert.match(memory.detail, /References:/);
  assert.match(memory.detail, /extraction:ext-1/);
});

test('memories.get returns null for unknown curated observation memories', async () => {
  const client = {
    observationTable: { get: async () => [] },
    extractionTable: { get: async () => [] },
    sessionTable: { get: async () => null },
    turnTable: { get: async () => null },
  };
  const { Memories } = await import('../../dist/api/memory.js');
  assert.equal(await new Memories(client).get('observation:missing'), null);
});

test('memories.get accepts observation paths containing colons', async () => {
  const pathId = 'Caroline / Work: schedule';
  const client = {
    observationTable: {
      get: async ({ ids }) => ids.includes(pathId)
        ? [{
            id: pathId,
            path: pathId,
            text: 'Caroline adjusted her work schedule.',
            vector: [],
            extractionRefs: [],
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          }]
        : [],
    },
    extractionTable: { get: async () => [] },
    sessionTable: { get: async () => null },
    turnTable: { get: async () => null },
  };
  const { Memories } = await import('../../dist/api/memory.js');
  const memory = await new Memories(client).get(`observation:${pathId}`);

  assert.equal(memory.memoryId, `observation:${pathId}`);
  assert.equal(memory.title, 'Caroline adjusted her work schedule.');
});

test('observation memory id parser rejects empty and wrong prefixes', async () => {
  const { parseObservationMemoryId } = await import('../../dist/api/memory.js');

  assert.throws(() => parseObservationMemoryId('observation:'), /invalid observation memory id/);
  assert.throws(() => parseObservationMemoryId('extraction:Caroline / Work: schedule'), /invalid observation memory id/);
});

test('observer markdown parser derives parent and child observations', async () => {
  const { parseObservationDocument } = await import('../../dist/pipeline/observation.js');
  const parsed = parseObservationDocument([
    '# Alex',
    '',
    '## Who is Alex?',
    '',
    'Alex is a product lead focused on onboarding.',
    '',
    '### What changed recently?',
    '',
    'Alex moved the onboarding review to Thursday.',
    '',
    'Source extractions:',
    '- [extraction:c]',
  ].join('\n'), new Set(['extraction:c']));

  assert.equal(parsed.title, 'Alex');
  assert.equal(parsed.sections.length, 1);
  assert.equal(parsed.sections[0].heading, 'Who is Alex?');
  assert.equal(parsed.sections[0].children[0].heading, 'What changed recently?');
  assert.deepEqual(parsed.sections[0].children[0].sourceRefs, ['extraction:c']);
});

test('observer markdown parser normalizes unique extraction id prefixes', async () => {
  const { parseObservationDocument } = await import('../../dist/pipeline/observation.js');
  const parsed = parseObservationDocument([
    '# Alex',
    '',
    '## Who is Alex?',
    '',
    'Alex finished a pottery project.',
    '',
    'Source extractions:',
    '- [08d7c1e281aa5df631a8]',
  ].join('\n'), new Set(['08d7c1e281aa5df631a8c1c3']));

  assert.deepEqual(parsed.sections[0].sourceRefs, ['08d7c1e281aa5df631a8c1c3']);
});

test('observer markdown parser rejects invalid refs and missing refs', async () => {
  const { parseObservationDocument } = await import('../../dist/pipeline/observation.js');
  assert.throws(() => parseObservationDocument([
    '# Alex',
    '',
    '## Who is Alex?',
    '',
    'Alex is a product lead.',
    '',
    'Source extractions:',
    '- [session:a]',
  ].join('\n'), new Set(['extraction:a'])), /unknown extraction id|unknown extraction/i);

  assert.throws(() => parseObservationDocument([
    '# Alex',
    '',
    '## Who is Alex?',
    '',
    'Alex is a product lead.',
  ].join('\n'), new Set(['extraction:a'])), /leaf observer section must include Source extractions/i);

  assert.throws(() => parseObservationDocument([
    '# Alex',
    '',
    '## Who is Alex?',
    '',
    'Alex is a product lead.',
    '',
    'Source extractions:',
    '- [extraction:missing]',
  ].join('\n'), new Set(['extraction:a'])), /unknown extraction id|unknown extraction/i);
});

test('observer prompt renders status and extraction inputs', async () => {
  const { __testing: observerLlmTesting } = await import('../../dist/llm/observer.js');
  const rendered = observerLlmTesting.renderExtractions([{
    id: 'abc',
    status: 'new',
    text: 'Alex moved onboarding review to Thursday.',
    context: 'The team compared review days.',
    cwd: '/workspace/project-a',
    turnRefs: ['session:1'],
  }]);

  assert.match(rendered, /- abc/);
  assert.match(rendered, /Status: new/);
  assert.match(rendered, /CWD: \/workspace\/project-a/);
  assert.match(rendered, /Context: The team compared review days\./);
  assert.match(rendered, /Extraction: Alex moved onboarding review to Thursday\./);
  assert.match(rendered, /Source refs: session:1/);
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
    observer: 'default-observer',
    summary: `${text} summary`,
    events: [
      { type: 'userMessage', text: `${text} prompt` },
      { type: 'assistantMessage', text: `${text} response` },
    ],
    prompt: `${text} prompt`,
    response: `${text} response`,
    observingEpoch: extractionEpoch,
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
  signals = '',
} = {}) {
  return [
    `# ${title}`,
    '',
    '## Summary',
    summary,
    '',
    '## Signals',
    signals,
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
    project: 'project-a',
    cwd: '/workspace/project-a',
    agent: 'agent-a',
    observer: 'default-observer',
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
    project: 'project-a',
    cwd: '/workspace/project-a',
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
  await writeObserverConfig(path.join(homeDir, 'muninn.json'));
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

test('getExtractorLlmConfig defaults activeWindowDays to 7 and continuityHints to 1', async (t) => {
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
    observer: {
      name: 'default-observer',
      llmProvider: 'observer_llm',
      maxAttempts: 3,
    },
    providers: {
      llm: {
        extractor_llm: {
          type: 'mock',
        },
        observer_llm: {
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

test('watchdog creates and optimizes observation index only once for an unchanged version', async (t) => {
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
      ensureVectorIndex: async () => ({ created: false }),
      stats: async () => null,
      compact: async () => ({ changed: false }),
      optimize: async () => ({ changed: false }),
    },
    observationTable: {
      ensureVectorIndex: async () => {
        ensureCalls += 1;
        return { created: ensureCalls === 1 };
      },
      stats: async () => ({
        version: 17,
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
    && record.version === 17
  )));
  assert.ok(records.some((record) => (
    record.dataset === 'observation'
    && record.event === 'optimized'
    && record.details?.indexCreated === true
  )));
  assert.equal(records.length, 2);
});

test('watchdog creates and optimizes observation context id index only once for an unchanged version', async (t) => {
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
      ensureVectorIndex: async () => ({ created: false }),
      stats: async () => null,
      compact: async () => ({ changed: false }),
      optimize: async () => ({ changed: false }),
    },
    observationContextTable: {
      ensureIdIndex: async () => {
        ensureCalls += 1;
        return { created: ensureCalls === 1 };
      },
      stats: async () => ({
        version: 19,
        fragmentCount: 1,
        rowCount: 3,
      }),
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
    record.dataset === 'observationContext'
    && record.event === 'index_created'
    && record.version === 19
  )));
  assert.ok(records.some((record) => (
    record.dataset === 'observationContext'
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
      observation: 0,
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
    pendingExtractionChanges: [],
  });
});

test('watchdog serializes concurrent checkpoint flushes', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

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

test('watchdog skips checkpoint writes when contributors return no observer state', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

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

test('watchdog skips checkpoint writes when observer content is unchanged', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

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
  await writeObserverConfig(configPath);

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
    observer: makeObserverCheckpoint(),
  }, null, 2)}\n`, 'utf8');

  assert.equal(await readCheckpointFile(), null);
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
    /checkpoint extractor section is invalid/i,
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
  const { parseCheckpointFile, serializeCheckpointFile } = await import('../../dist/checkpoint.js');
  const file = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    writtenAt: new Date().toISOString(),
    writerPid: 1,
    extractor: {
      baseline: { turn: 1, session: 1, extraction: 1, observation: 0 },
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
          snapshotResults: [],
        },
        committed: { extractionIds: ['obs-1'], snapshotIds: [] },
        traceRefs: [],
        errors: [],
      }],
      pendingExtractionChanges: [],
    },
    observer: makeObserverCheckpoint({ baseline: { observationContext: 0, observation: 0 } }),
    sessionIndex: { baseline: { turn: 1, session: 1 }, entries: [] },
  };

  const parsed = parseCheckpointFile(serializeCheckpointFile(file));
  assert.equal(parsed.extractor.runs[0].stage, 'fittingThreads');
  assert.deepEqual(parsed.extractor.runs[0].pending.snapshotResults, []);
  assert.deepEqual(parsed.extractor.runs[0].committed.extractionIds, ['obs-1']);
});

test('watchdog rewrites checkpoint when observer content changes', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

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
    extractionEpoch: 8,
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
      project: 'project-a',
      cwd: '/workspace/project-a',
      agent: 'agent-a',
      snapshotSequence: 0,
      createdAt: freshUpdatedAt,
      updatedAt: freshUpdatedAt,
      extractor: 'default-observer',
      title: 'Fresh thread',
      summary: 'Fresh summary',
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
      extractor: 'default-observer',
      title: 'Stale thread',
      summary: 'Stale summary',
      content: snapshotContentFixture('', { title: 'Stale thread', summary: 'Stale summary' }),
      references: [],
    },
  ];

  const threads = loadThreads(snapshots, 'default-observer', 7);
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
      extractor: 'default-observer',
      title: 'Thread',
      summary: 'Summary',
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
      extractor: 'default-observer',
      title: 'Thread',
      summary: 'Summary',
      content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
      references: [],
    },
  ];

  const threads = loadThreads(snapshots, 'default-observer', 7);
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
    observer: 'default-observer',
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
      extractionEpoch: 7,
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
    assert.deepEqual(watermark.pending.turns, []);
    assert.equal(memoryWatermarkResolved(watermark), false);
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
      extractionEpoch: 1,
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
      extractionEpoch: 1,
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
      content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
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
      content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
      references: ['turn-13', 'turn-14'],
    },
  ];
  const observer = new Observer({
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
  t.after(async () => observer.shutdown());

  await observer.ensureBootstrapped();

  assert.equal(observer.committedEpoch, 14);
  assert.deepEqual((await observer.watermark()).pending.turns, []);
  assert.deepEqual(observer.threads[0].snapshotIds, ['snapshot-1', 'snapshot-2']);
});

test('observer bootstrap publishes pending turns by their extractionEpoch', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const published = [];
  const observer = new Observer({
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
            content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
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
  t.after(async () => observer.shutdown());

  await observer.ensureBootstrapped();

  assert.equal(listSnapshotsCalls, 0);
  assert.equal(loadTurnsAfterEpochCalls, 1);
  assert.deepEqual(observer.exportCheckpoint(), {
    committedEpoch: 12,
    nextEpoch: 13,
    runs: [],
    pendingExtractionChanges: [],
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
            content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
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
  t.after(async () => observer.shutdown());

  await observer.ensureBootstrapped();

  assert.equal(observer.threads.length, 1);
  assert.deepEqual(observer.threads[0].snapshotIds, ['snapshot-0', 'snapshot-1']);
  assert.equal(observer.threads[0].snapshots.length, 2);
  assert.equal(observer.threads[0].indexedSnapshotSequence, 1);
});

test('extractor restore advances committedEpoch and excludes extracted turns from pending', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath, { activeWindowDays: 7 });
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
  const observer = new Observer({
    turnTable: {
      loadTurnsAfterEpoch: async () => [
        makeExtractableTurn('turn-13', 13, 'epoch13'),
        makeExtractableTurn('turn-14', 14, 'epoch14'),
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
          content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
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
          content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
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
          content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
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
          content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
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
          content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
          references: ['turn-13', 'turn-14'],
        },
      ],
    },
    extractionTable: {},
  }, checkpoint);
  t.after(async () => observer.shutdown());

  const restored = await observer.restore();

  assert.equal(restored.committedEpoch, 14);
  assert.deepEqual(restored.pendingTurns, []);
  assert.deepEqual(restored.threads[0].snapshotIds, ['snapshot-0', 'snapshot-1', 'snapshot-2']);
  assert.deepEqual(restored.threads[0].snapshotEpochs, [12, 13, 14]);
});

test('observer restore falls back when session delta refs are missing turn epochs', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath, { activeWindowDays: 7 });

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
  const observer = new Observer({
    turnTable: {
      loadTurnsAfterEpoch: async () => [makeExtractableTurn('turn-13', 13, 'epoch13')],
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
          content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
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
          content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
          references: [],
        },
      ],
    },
    extractionTable: {},
  }, checkpoint);
  t.after(async () => observer.shutdown());

  const restored = await observer.restore();

  assert.equal(restored, null);
});

test('observer restore skips stale threads resource only from session delta', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath, { activeWindowDays: 7 });
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
    snapshotSequence: 0,
    createdAt: staleUpdatedAt,
    updatedAt: staleUpdatedAt,
    observer: 'default-observer',
    title: 'Stale Thread',
    summary: 'Summary',
    content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
    references: ['turn-13'],
  };
  const observer = new Observer({
    turnTable: {
      loadTurnsAfterEpoch: async () => [makeExtractableTurn('turn-13', 13, 'epoch13')],
    },
    sessionTable: {
      delta: async () => [staleRow],
      threadSnapshots: async () => [staleRow],
    },
    extractionTable: {},
  }, checkpoint);
  t.after(async () => observer.shutdown());

  const restored = await observer.restore();

  assert.equal(restored.committedEpoch, 13);
  assert.equal(restored.threads.length, 0);
  assert.deepEqual(restored.pendingTurns, []);
});

test('observer restore rebuilds delta-only threads from full history', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath, { activeWindowDays: 7 });
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
    sessionId: 'obs-legacy',
    snapshotSequence: index,
    createdAt: rowTimes[index],
    updatedAt: rowTimes[index],
    observer: 'default-observer',
    title: 'Legacy Thread',
    summary: `Summary ${index}`,
    content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
    references: Array.from({ length: index + 1 }, (_, turnIndex) => `turn-${turnIndex + 1}`),
  }));
  const turnById = new Map(fullRows.map((row, index) => [
    `turn-${index + 1}`,
    makeExtractableTurn(`turn-${index + 1}`, index + 1, `epoch${index + 1}`),
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

  const restored = await observer.restore();

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

test('observer exportCheckpoint keeps the last committed snapshot while extractCurrentEpoch is mid-flight', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const entered = deferred();
  const release = deferred();
  const checkpoint = (await readCheckpointFile())?.extractor ?? null;
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
      get: async () => [],
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
    extractionEpoch: 0,
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
    turns: [makeExtractableTurn('turn-1', 1, 'first')],
  };

  let midFlight;
  observer.indexCurrentEpochSnapshots = async () => {
    midFlight = observer.exportCheckpoint();
    entered.resolve();
    await release.promise;
  };

  const observePromise = observer.extractCurrentEpoch();
  await entered.promise;

  assert.deepEqual(midFlight, {
    committedEpoch: 0,
    nextEpoch: 2,
    runs: [],
    pendingExtractionChanges: [],
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
          content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary' }),
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
  await writeFile(resolveCheckpointPath(), `${JSON.stringify(makeCheckpointContent({
    writtenAt: '2024-01-01T00:00:00Z',
    writerPid: 123,
    extractor: makeExtractorCheckpoint({
      threads: [{
        sessionId: 'obs-1',
        latestSnapshotId: 'turn:42',
        latestSnapshotSequence: 'bad-sequence',
        indexedSnapshotSequence: 1,
        updatedAt: '2024-01-01T00:00:01Z',
      }],
    }),
  }), null, 2)}\n`, 'utf8');

  await assert.rejects(
    () => readCheckpointFile(),
    /checkpoint extractor section is invalid/i,
  );
});

test('muninn.recallMemories does not wait for observer flushes', async () => {
  const muninn = MuninnBackend.createForTests({});
  let flushPendingCalls = 0;
  let recallCalls = 0;

  muninn.ensureObserver = async () => ({
    flushPending: async () => {
      flushPendingCalls += 1;
    },
    shutdown: async () => {},
    watermark: async () => ({
      pending: { turns: [], extractions: [] },
      phases: { extractor: 'idle', observer: 'idle' },
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

test('muninn.memoryFinalize triggers drain and returns pending watermark without blocking', async () => {
  const muninn = MuninnBackend.createForTests({});
  let extractorFinalizeCalls = 0;
  let extractorWatermarkCalls = 0;
  let extractorFlushCalls = 0;
  let observerFinalizeCalls = 0;
  let checkpointFlushCalls = 0;

  const extractor = {
    finalize: async () => {
      extractorFinalizeCalls += 1;
      return {
        pending: { turns: ['turn:pending'], extractions: [] },
        phases: { extractor: 'running', observer: 'idle' },
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
            pending: { turns: ['turn:pending'], extractions: [] },
            phases: { extractor: 'running', observer: 'idle' },
          }
        : {
            pending: { turns: [], extractions: [] },
            phases: { extractor: 'idle', observer: 'idle' },
          };
    },
    shutdown: async () => {},
  };
  const observer = {
    finalize: async () => {
      observerFinalizeCalls += 1;
      return {
        pending: { turns: [], extractions: ['extraction:pending'] },
        phases: { extractor: 'idle', observer: 'draining' },
      };
    },
    watermark: async () => {
      throw new Error('memoryFinalize must use observer.finalize watermark');
    },
    shutdown: async () => {},
  };
  muninn.extractor = extractor;
  muninn.observer = observer;
  muninn.ensureExtractor = async () => extractor;
  muninn.ensureObserver = async () => observer;
  muninn.watchdog = {
    flushCheckpoint: async () => {
      checkpointFlushCalls += 1;
    },
  };

  const watermark = await muninn.memoryFinalize();

  assert.equal(extractorFinalizeCalls, 1);
  assert.equal(observerFinalizeCalls, 1);
  assert.equal(extractorFlushCalls, 0);
  assert.deepEqual(watermark.pending.turns, ['turn:pending']);
  assert.deepEqual(watermark.pending.extractions, ['extraction:pending']);
  assert.equal(watermark.phases.extractor, 'running');
  assert.equal(watermark.phases.observer, 'draining');

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(observerFinalizeCalls, 2);
  assert.equal(checkpointFlushCalls, 1);
});

test('recallMemories searches curated and raw routes then returns curated-first hits', async () => {
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
          observer: 'default-extractor',
          title: 'Session 2 title',
          summary: 'Session 2 summary',
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
            content: 'Readable content',
            references: ['turn:session-2'],
          }]
          : []
      ),
    },
    observationTable: {
      search: async (params) => {
        calls.push(['observation', params]);
        return [{
          id: 'curated-1',
          path: 'Caroline / Plans',
          text: 'Caroline plans to research adoption agencies.',
          vector: [],
          extractionRefs: ['extraction:raw-1'],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        }];
      },
    },
    extractionTable: {
      search: async (params) => {
        calls.push(['extraction', params]);
        const title = 'Counseling work';
        const summary = 'Caroline is interested in counseling work.';
        return [{
          id: 'raw-2',
          title,
          summary: `${title}\n\n${summary}`,
          content: extractionContent(title, summary),
          anchors: [],
          vector: [],
          category: 'Fact',
          turnRefs: ['turn:session-2'],
          observationPaths: [],
          observedRootAnchors: [],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        }];
      },
    },
  };

  const hits = await recallMemories(client, 'What are Caroline plans?', 3, { embed: async () => [1, 0] });

  assert.deepEqual(hits, [
    {
      memoryId: 'observation:curated-1',
      title: 'Caroline plans to research adoption agencies.',
      summary: 'Caroline plans to research adoption agencies.',
      content: 'OBSERVATION: Caroline plans to research adoption agencies.',
      references: ['extraction:raw-1'],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
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
      sessionKey: 'cwd:/workspace/memory-project|session:session-2|agent:codex|observer:default-extractor',
      displaySession: 'Readable session title',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
  ]);
  assert.deepEqual(calls.map(([table]) => table), ['observation', 'extraction']);
  assert.deepEqual(calls[0][1], {
    query: 'What are Caroline plans?',
    vector: [1, 0],
    limit: 3,
    mode: 'hybrid',
  });
  assert.deepEqual(calls[1][1], {
    query: 'What are Caroline plans?',
    vector: [1, 0],
    limit: 3,
    mode: 'hybrid',
  });
});

test('recallMemories enriches extraction hits from raw turn session_id', async () => {
  const client = {
    turnTable: {
      getTurn: async (turnId) => {
        assert.equal(turnId, 'turn:raw-session');
        return {
          turnId,
          session_id: ' session-from-native ',
          project: 'memory-project',
          cwd: '/workspace/memory-project',
          agent: 'codex',
          observer: 'default-extractor',
          title: 'Raw session title',
          summary: 'Raw session summary',
          events: [],
          createdAt: '2024-01-02T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        };
      },
    },
    sessionTable: {
      threadSnapshots: async (sessionId) => {
        assert.equal(sessionId, 'session-from-native');
        return [{
          snapshotId: 'session:snapshot-native',
          sessionId,
          project: 'memory-project',
          cwd: '/workspace/memory-project',
          agent: 'codex',
          snapshotSequence: 1,
          createdAt: '2024-01-03T00:00:00Z',
          updatedAt: '2024-01-03T00:00:00Z',
          extractor: 'default-extractor',
          title: 'Native session title',
          summary: 'Native summary',
          content: 'Native content',
          references: ['turn:raw-session'],
        }];
      },
    },
    observationTable: {
      search: async () => [],
    },
    extractionTable: {
      search: async () => [{
        id: 'raw-native',
        title: 'Native turn ownership',
        summary: 'Native row uses snake case session id.',
        content: extractionContent('Native turn ownership', 'Native row uses snake case session id.'),
        anchors: [],
        vector: [],
        category: 'Fact',
        turnRefs: ['turn:raw-session'],
        observationPaths: [],
        observedRootAnchors: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      }],
    },
  };

  const hits = await recallMemories(client, 'native session', 1, {
    embed: async () => [1, 0],
    includeObservations: false,
  });

  assert.equal(hits[0]?.memoryId, 'extraction:raw-native');
  assert.equal(hits[0]?.sessionId, 'session-from-native');
  assert.equal(hits[0]?.project, 'memory-project');
  assert.equal(hits[0]?.cwd, '/workspace/memory-project');
  assert.equal(hits[0]?.agent, 'codex');
  assert.equal(hits[0]?.sessionKey, 'cwd:/workspace/memory-project|session:session-from-native|agent:codex|observer:default-extractor');
  assert.equal(hits[0]?.displaySession, 'Native session title');
});

test('recallMemories enriches curated hits from referenced extraction ownership', async () => {
  const client = {
    turnTable: {
      getTurn: async (turnId) => {
        assert.equal(turnId, 'turn:curated-session');
        return {
          turnId,
          session_id: 'codex-e2e-session',
          project: 'github.com/muninn/e2e-fixture',
          cwd: '/tmp/muninn-e2e/project',
          agent: 'codex',
          observer: 'default-extractor',
          title: 'Codex E2E title',
          summary: 'Codex E2E summary',
          events: [],
          createdAt: '2024-01-02T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        };
      },
    },
    sessionTable: {
      threadSnapshots: async (sessionId) => {
        assert.equal(sessionId, 'codex-e2e-session');
        return [{
          snapshotId: 'session:snapshot-curated',
          sessionId,
          project: 'github.com/muninn/e2e-fixture',
          cwd: '/tmp/muninn-e2e/project',
          agent: 'codex',
          snapshotSequence: 1,
          createdAt: '2024-01-03T00:00:00Z',
          updatedAt: '2024-01-03T00:00:00Z',
          extractor: 'default-extractor',
          title: 'Codex E2E session',
          summary: 'Curated summary',
          content: 'Curated content',
          references: ['turn:curated-session'],
        }];
      },
    },
    observationTable: {
      search: async () => [{
        id: 'curated-1',
        path: 'Muninn / Release',
        text: 'Codex dist-tag next stays until MVP1 beta exits.',
        vector: [],
        extractionRefs: ['extraction:raw-1'],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      }],
    },
    extractionTable: {
      search: async () => [{
        id: 'raw-1',
        title: 'Codex dist tag',
        summary: 'Codex uses dist-tag next until MVP1 beta exits.',
        content: extractionContent('Codex dist tag', 'Codex uses dist-tag next until MVP1 beta exits.'),
        anchors: [],
        vector: [],
        category: 'Fact',
        turnRefs: ['turn:curated-session'],
        observationPaths: [],
        observedRootAnchors: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      }],
      get: async ({ ids }) => [{
        id: 'raw-1',
        title: 'Codex dist tag',
        summary: 'Codex uses dist-tag next until MVP1 beta exits.',
        content: extractionContent('Codex dist tag', 'Codex uses dist-tag next until MVP1 beta exits.'),
        anchors: [],
        vector: [],
        category: 'Fact',
        turnRefs: ['turn:curated-session'],
        observationPaths: [],
        observedRootAnchors: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      }].filter((row) => ids.includes(row.id)),
    },
  };

  const hits = await recallMemories(client, 'codex dist-tag next MVP1 beta', 1, { embed: async () => [1, 0] });

  assert.equal(hits[0]?.memoryId, 'observation:curated-1');
  assert.equal(hits[0]?.project, 'github.com/muninn/e2e-fixture');
  assert.equal(hits[0]?.sessionId, 'codex-e2e-session');
  assert.equal(hits[0]?.agent, 'codex');
  assert.equal(hits[0]?.cwd, '/tmp/muninn-e2e/project');
  assert.equal(hits[0]?.sessionKey, 'cwd:/tmp/muninn-e2e/project|session:codex-e2e-session|agent:codex|observer:default-extractor');
  assert.equal(hits[0]?.displaySession, 'Codex E2E session');
  assert.match(hits[0]?.content, /Codex uses dist-tag next until MVP1 beta exits/);
});

test('recallMemories filters raw hits source by selected curated hits', async () => {
  const client = {
    observationTable: {
      search: async () => [
        {
          id: 'curated-1',
          path: 'Caroline / Research',
          text: 'Caroline researched adoption agencies.',
          vector: [],
          extractionRefs: [],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
    },
    observationContextTable: {
      get: async ({ ids }) => ids.includes('curated-1')
        ? [{
            id: 'curated-1',
            path: 'Caroline / Research',
            parentId: null,
            position: 0,
            content: 'Caroline researched adoption agencies.',
            sourceRefs: ['extraction:raw-1'],
            expandRefs: [],
            observer: 'test-observer',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          }]
        : [],
    },
    extractionTable: {
      search: async () => [
        {
          id: 'raw-1',
          text: 'Caroline researched adoption agencies.',
          context: null,
          anchors: [],
          vector: [],
          category: 'Fact',
          turnRefs: ['session:1'],
          observationPaths: [],
          observedRootAnchors: [],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'raw-2',
          text: 'Melanie painted a lake sunrise in 2022.',
          context: null,
          anchors: [],
          vector: [],
          category: 'Fact',
          turnRefs: ['session:2'],
          observationPaths: [],
          observedRootAnchors: [],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
    },
  };

  const hits = await recallMemories(client, 'Caroline research', 2, { embed: async () => [1, 0] });
  assert.deepEqual(hits.map((hit) => hit.memoryId), ['observation:curated-1', 'extraction:raw-2']);
});

test('recallMemories renders observation context source refs when extraction refs are empty', async () => {
  const client = {
    observationTable: {
      search: async () => [
        {
          id: 'curated-1',
          path: 'Caroline / Research',
          text: 'Caroline researched adoption agencies.',
          vector: [],
          extractionRefs: [],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
    },
    observationContextTable: {
      get: async ({ ids }) => ids.includes('curated-1')
        ? [{
            id: 'curated-1',
            path: 'Caroline / Research',
            parentId: null,
            position: 0,
            content: 'Caroline researched adoption agencies.',
            sourceRefs: ['extraction:raw-1'],
            expandRefs: [],
            observer: 'test-observer',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          }]
        : [],
    },
    extractionTable: {
      search: async () => [],
      get: async ({ ids }) => [{
        id: 'raw-1',
        title: 'Adoption agency research',
        summary: 'Caroline researched adoption agencies.',
        content: extractionContent('Adoption agency research', 'Caroline researched adoption agencies.'),
        anchors: [],
        vector: [],
        category: 'Fact',
        turnRefs: ['turn:1'],
        observationPaths: [],
        observedRootAnchors: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      }].filter((row) => ids.includes(row.id)),
    },
  };

  const hits = await recallMemories(client, 'Caroline research', 1, { embed: async () => [1, 0] });

  assert.equal(hits[0]?.memoryId, 'observation:curated-1');
  assert.deepEqual(hits[0]?.references, ['extraction:raw-1']);
  assert.match(hits[0]?.content, /^EXTRACTION: ## Title$/m);
  assert.match(hits[0]?.content, /^Adoption agency research$/m);
});

test('recallMemories includes referenced extraction text for observation hits', async () => {
  const calls = [];
  const client = {
    observationTable: {
      search: async () => [
        {
          id: 'curated-1',
          path: 'Caroline / Summer plans',
          text: [
            'Caroline is working on summer plans.',
            '- [priority] adoption research',
            '',
            'Source extractions:',
            '- [raw-1]',
            '- [raw-2, raw-3] Caroline compared multiple adoption options.',
          ].join('\n'),
          vector: [],
          extractionRefs: ['raw-1', 'raw-2'],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
    },
    extractionTable: {
      search: async (params) => {
        calls.push(['extraction', params]);
        const title = 'Adoption agency research';
        const summary = 'Caroline researched adoption agencies.';
        return [
          {
            id: 'raw-1',
            title,
            summary: `${title}\n\n${summary}`,
            content: extractionContent(title, summary),
            anchors: [],
            turnRefs: ['turn:1'],
            vector: [],
            category: 'Fact',
            observationPaths: [],
            observedRootAnchors: [],
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        ];
      },
      get: async ({ ids }) => {
        calls.push(['get', ids]);
        const raw1Title = 'Adoption agency research';
        const raw1Summary = 'Caroline researched adoption agencies.\nShe compared options.';
        const raw1Content = 'Melanie asked Caroline about her summer plans.\nThe discussion focused on next steps.';
        const raw2Title = 'Inclusive adoption agency';
        const raw2Summary = 'Caroline chose an LGBTQ+ inclusive adoption agency.';
        return [
        {
          id: 'raw-1',
          title: raw1Title,
          summary: `${raw1Title}\n\n${raw1Summary}`,
          content: extractionContent(raw1Title, raw1Summary, raw1Content),
          anchors: ['Entity: Caroline'],
          turnRefs: ['turn:1'],
          vector: [],
          category: 'Fact',
          observationPaths: [],
          observedRootAnchors: [],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'raw-2',
          title: raw2Title,
          summary: `${raw2Title}\n\n${raw2Summary}`,
          content: extractionContent(raw2Title, raw2Summary),
          anchors: [],
          turnRefs: ['turn:2'],
          vector: [],
          category: 'Fact',
          observationPaths: [],
          observedRootAnchors: [],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ].filter((row) => ids.includes(row.id));
      },
    },
  };

  const hits = await recallMemories(client, 'Caroline summer plans', 1, { embed: async () => [1, 0] });

  assert.equal(hits[0].memoryId, 'observation:curated-1');
  assert.match(hits[0].content, /OBSERVATION: Caroline is working on summer plans/);
  assert.match(hits[0].content, /- \[priority\] adoption research/);
  assert.match(hits[0].content, /- extraction: ## Title/);
  assert.match(hits[0].content, /^  Adoption agency research$/m);
  assert.match(hits[0].content, /^  ## Content$/m);
  assert.match(hits[0].content, /^  Melanie asked Caroline about her summer plans\.$/m);
  assert.match(hits[0].content, /^  The discussion focused on next steps\.$/m);
  assert.match(hits[0].content, /- Caroline compared multiple adoption options\./);
  assert.doesNotMatch(hits[0].content, /\[raw-2, raw-3\]/);
  assert.doesNotMatch(hits[0].content, /\[raw-1\]/);
  assert.doesNotMatch(hits[0].content, /^CONTEXT: Melanie asked Caroline about her summer plans\.$/m);
  assert.doesNotMatch(hits[0].content, /^EXTRACTION: Caroline researched adoption agencies\.$/m);
  assert.match(hits[0].content, /^EXTRACTION: ## Title$/m);
  assert.match(hits[0].content, /^Inclusive adoption agency$/m);
  assert.match(hits[0].content, /Source extractions:/);
  assert.deepEqual(hits[0].references, ['raw-1', 'raw-2']);
  assert.deepEqual(calls, [
    ['extraction', {
      query: 'Caroline summer plans',
      vector: [1, 0],
      limit: 1,
      mode: 'hybrid',
    }],
    ['get', ['raw-1', 'raw-2']],
  ]);
});

test('recallMemories filters parent observation contexts from curated hits', async () => {
  const calls = [];
  const client = {
    observationContextTable: {
      list: async () => [
        {
          id: 'parent-1',
          path: 'Caroline / Family plans',
          parentId: null,
          position: 0,
          content: 'Caroline is pursuing adoption.',
          observer: 'default',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'leaf-1',
          path: 'Caroline / Family plans / Summer plans',
          parentId: 'parent-1',
          position: 0,
          content: 'Caroline researched adoption agencies.',
          observer: 'default',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'leaf-2',
          path: 'Caroline / Family plans / Agency choice',
          parentId: 'parent-1',
          position: 1,
          content: 'Caroline chose an LGBTQ-supportive adoption agency.',
          observer: 'default',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
    },
    observationTable: {
      search: async (params) => {
        calls.push(params);
        return [
          {
            id: 'parent-1',
            path: 'Caroline / Family plans',
            text: 'Caroline is pursuing adoption.',
            vector: [],
            extractionRefs: ['extraction:raw-parent'],
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
          {
            id: 'leaf-1',
            path: 'Caroline / Family plans / Summer plans',
            text: 'Caroline researched adoption agencies.',
            vector: [],
            extractionRefs: ['extraction:raw-1'],
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
          {
            id: 'leaf-2',
            path: 'Caroline / Family plans / Agency choice',
            text: 'Caroline chose an LGBTQ-supportive adoption agency.',
            vector: [],
            extractionRefs: ['extraction:raw-2'],
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        ];
      },
    },
    extractionTable: {
      search: async () => [],
    },
  };

  const hits = await recallMemories(client, 'Caroline summer plans', 2, { embed: async () => [1, 0] });

  assert.deepEqual(hits.map((hit) => hit.memoryId), ['observation:leaf-1', 'observation:leaf-2']);
  assert.equal(calls[0].limit, 8);
});

test('recallMemories does not filter raw hits source only by unselected curated candidates', async () => {
  const curated = Array.from({ length: 5 }, (_, index) => ({
    id: `curated-${index + 1}`,
    path: `Entity ${index + 1}`,
    text: `Curated memory ${index + 1}.`,
    vector: [],
    extractionRefs: [`extraction:raw-${index + 1}`],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  }));
  const client = {
    observationTable: {
      search: async () => curated,
    },
    extractionTable: {
      search: async () => [
        {
          id: 'raw-5',
          text: 'Raw memory source only by unselected curated memory.',
          context: null,
          anchors: [],
          vector: [],
          category: 'Fact',
          turnRefs: ['session:5'],
          observationPaths: [],
          observedRootAnchors: [],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
    },
  };

  const hits = await recallMemories(client, 'query', 5, { embed: async () => [1, 0] });
  assert.deepEqual(hits.map((hit) => hit.memoryId), [
    'observation:curated-1',
    'observation:curated-2',
    'observation:curated-3',
    'observation:curated-4',
    'extraction:raw-5',
  ]);
});

test('recallMemories supports fts mode without embedding the query', async () => {
  let embedCalls = 0;
  const calls = [];
  const client = {
    observationTable: {
      search: async (params) => {
        calls.push(['observation', params]);
        return [];
      },
    },
    extractionTable: {
      search: async (params) => {
        calls.push(['extraction', params]);
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
  assert.deepEqual(calls[0][1], {
    query: 'adoption agencies',
    vector: [],
    limit: 2,
    mode: 'fts',
  });
  assert.deepEqual(calls.map(([table]) => table), ['observation', 'extraction']);
});

test('recallMemories returns recalled memory when budget is positive', async () => {
  const calls = [];
  let seenCandidates = [];
  const client = {
    observationTable: {
      search: async () => [{
        id: 'curated-1',
        path: 'Caroline / Research',
        text: 'Caroline plans to research adoption agencies.',
        vector: [],
        extractionRefs: ['extraction:obs-2'],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      }],
    },
    extractionTable: {
      search: async (params) => {
        calls.push(params);
        return [
          {
            id: 'obs-1',
            text: 'Caroline and Melanie planned a summer outing.',
            context: 'They discussed summer plans together.',
            vector: [],
            category: 'Fact',
            anchors: [],
            turnRefs: ['D12:17'],
            observationPaths: [],
            observedRootAnchors: [],
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
          {
            id: 'obs-2',
            text: 'Caroline researched adoption agencies.',
            context: 'Melanie asked Caroline about her summer plans.',
            vector: [],
            category: 'Fact',
            anchors: [],
            turnRefs: ['D2:8'],
            observationPaths: [],
            observedRootAnchors: [],
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
        raw: '{"content":"Caroline researched adoption agencies.","refs":["D2:8"]}',
        candidates: input.candidates,
      };
    },
  });

  assert.deepEqual(hits, [{
    memoryId: 'recalled:memory',
    content: 'Caroline researched adoption agencies.',
    references: ['extraction:obs-2', 'D12:17'],
  }]);
  assert.equal(calls[0].limit, 20);
  assert.deepEqual(seenCandidates.map((candidate) => candidate.memoryId), [
    'observation:curated-1',
    'extraction:obs-1',
  ]);
});

test('recallMemories uses candidate refs for recalled memory', async () => {
  const client = {
    observationTable: {
      search: async () => [{
        id: 'curated-1',
        path: 'Caroline / Research',
        text: 'Caroline plans to research adoption agencies.',
        vector: [],
        extractionRefs: ['extraction:curated-source'],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      }],
    },
    extractionTable: {
      search: async () => [
        {
          id: 'obs-1',
          text: 'Caroline researched adoption agencies.',
          context: null,
          vector: [],
          category: 'Fact',
          anchors: [],
          turnRefs: ['D2:8'],
          observationPaths: [],
          observedRootAnchors: [],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
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
    content: 'Caroline researched adoption agencies.',
    references: ['extraction:curated-source', 'D2:8'],
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
  }, 'default-observer');

  const first = registry.load('group-a', 'agent-a', { project: 'project-a', cwd: '/workspace/project-a' });
  const second = registry.load('group-a', 'agent-a', { project: 'project-a', cwd: '/workspace/project-a' });
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
  const registry = new IngestSessionRegistry({
    turnTable: {},
  }, 'default-observer');

  const first = registry.load('group-a', 'agent-a', { project: 'project-a', cwd: '/workspace/project-a' });
  const second = registry.load(' group-a ', 'agent-a', { project: 'project-a', cwd: '/workspace/project-a' });
  const [firstSession, secondSession] = await Promise.all([first, second]);

  assert.strictEqual(firstSession, secondSession);
});

test('session registry separates same raw session id across cwd ownership', async () => {
  const registry = new IngestSessionRegistry({
    turnTable: {},
  }, 'default-observer');

  const first = registry.load('group-a', 'agent-a', { project: 'project-a', cwd: '/workspace/project-a' });
  const second = registry.load('group-a', 'agent-a', { project: 'project-b', cwd: '/workspace/project-b' });
  const [firstSession, secondSession] = await Promise.all([first, second]);

  assert.notStrictEqual(firstSession, secondSession);
});

test('session registry treats project as display metadata for the same cwd identity', async () => {
  const registry = new IngestSessionRegistry({
    turnTable: {},
  }, 'default-observer');

  const first = registry.load('group-a', 'agent-a', { project: 'project-a', cwd: '/workspace/shared' });
  const second = registry.load('group-a', 'agent-a', { project: 'project-b', cwd: '/workspace/shared' });
  const [firstSession, secondSession] = await Promise.all([first, second]);

  assert.strictEqual(firstSession, secondSession);
});

test('session registry restores live sessions for checkpoint recent turns', async () => {
  const registry = new IngestSessionRegistry({
    turnTable: {},
  }, 'default-observer');

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
  }, 'default-observer');

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
    observer: 'default-observer',
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
    observer: 'default-observer',
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
    observer: 'default-observer',
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
    observer: 'default-observer',
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
    observer: 'default-observer',
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
    observer: 'default-observer',
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

test('observer.extractCurrentEpoch keeps thread state unchanged when pre-commit work fails', async () => {
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
      observer: 'default-observer',
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

    await assert.rejects(() => observer.extractCurrentEpoch(), /persist failed/);
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
    openQuestions: [],
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
  assert.deepEqual(updatedRow.observationPaths, []);
  assert.equal(addedRow.title, 'Painting preference');
  assert.equal(addedRow.summary, 'Painting preference\n\nnew painting memory');
  assert.equal(addedRow.content, '## Title\n\nPainting preference\n\n## Summary\n\nnew painting memory\n\n## Content\n\nnew context');
  assert.equal(addedRow.category, undefined);
  assert.equal(addedRow.anchors, undefined);
  assert.deepEqual(addedRow.turnRefs, ['turn:3']);
  assert.deepEqual(addedRow.observationPaths, []);
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
    openQuestions: [],
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
      openQuestions: [],
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
      openQuestions: [],
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
  assert.doesNotMatch(rendered, /^----$/m);
  assert.doesNotMatch(rendered, /Summary:/);
});

test('indexPendingExtractions surfaces extraction write failures and leaves work pending', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

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
          openQuestions: [],
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
          openQuestions: [],
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
      observer: 'default-observer',
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

test('observer validation derives extractions from titled snapshot content', () => {
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
        openQuestions: [],
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

test('observer validation preserves session-level signals in snapshot content', () => {
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
      signals: [
        '### Guidance',
        '',
        '- [2] The user prefers concise Markdown signals under named subsections.',
        '',
        '### Skills',
        '',
        '- [1] Extractor signal prompt review:',
        '  - Confirm parser support before asking the model to emit a new Markdown section.',
        '',
        '### Open Questions',
      ].join('\n'),
    }),
    {
      sessionMemory: {
        title: 'Extractor Signals',
        summary: '',
        extractions: [],
        openQuestions: [],
        nextSteps: [],
      },
      turns: [{
        turnId: 'turn:13',
        summary: 'The user asked for durable signal handling in extractor memory content.',
      }],
    },
  );

  assert.equal(result.signals, [
    '### Guidance',
    '',
    '- [2] The user prefers concise Markdown signals under named subsections.',
    '',
    '### Skills',
    '',
    '- [1] Extractor signal prompt review:',
    '  - Confirm parser support before asking the model to emit a new Markdown section.',
    '',
    '### Open Questions',
  ].join('\n'));
  assert.equal(result.extractions[0]?.context, '- Keep the signal recall-ready without a rigid pseudo-schema.');
  assert.match(result.snapshotContent, /## Signals\n### Guidance/);
  assert.match(result.snapshotContent, /\[2\] The user prefers concise Markdown signals/);
  assert.match(result.snapshotContent, /### Content\n- Keep the signal recall-ready/);
});

test('snapshot patch can preserve, replace, and clear session-level signals', () => {
  const baseInput = {
    sessionMemory: {
      title: 'Extractor Signals',
      summary: 'Extractor prompt design.',
      signals: [
        '### Guidance',
        '',
        '- [2] Keep signal bullets under named subsections.',
        '',
        '### Skills',
        '',
        '### Open Questions',
      ].join('\n'),
      extractions: [],
      openQuestions: [],
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
  assert.equal(preserved.signals, [
    '### Guidance',
    '',
    '- [2] Keep signal bullets under named subsections.',
    '',
    '### Skills',
    '',
    '### Open Questions',
  ].join('\n'));

  const replaced = extractorLlmTesting.validateSessionExtractionResultForTests([
    '## Signals',
    '### Guidance',
    '',
    '- [2] Signals are session-level state.',
    '',
    '### Skills',
    '',
    '### Open Questions',
  ].join('\n'), baseInput);
  assert.equal(replaced.signals, [
    '### Guidance',
    '',
    '- [2] Signals are session-level state.',
    '',
    '### Skills',
    '',
    '### Open Questions',
  ].join('\n'));

  const cleared = extractorLlmTesting.validateSessionExtractionResultForTests([
    '## Signals',
    '',
  ].join('\n'), baseInput);
  assert.equal(cleared.signals, '');
});

test('observer validation keeps independent refs per snapshot content unit', () => {
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

test('observer validation splits adjacent metadata snapshot units without separators', () => {
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
  assert.match(markdown, /Prompt:\nUser asked whether app session rows should use snapshot titles\./);
  assert.match(markdown, /Response:\nAgent confirmed the session index should cache the latest snapshot title\./);
  assert.doesNotMatch(markdown, /Summary:/);
  assert.doesNotMatch(markdown, /This old turn summary repeats/);
});

test('observer validation accepts markdown fenced snapshot content', () => {
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
        openQuestions: [],
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

test('observer validation rejects session signals after extractions', () => {
  assert.throws(
    () => extractorLlmTesting.validateSessionExtractionResultForTests([
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
      '',
      '## Signals',
      '### Guidance',
      '',
      '- [2] Keep signals before extractions.',
      '',
      '### Skills',
      '',
      '### Open Questions',
    ].join('\n'), {
      sessionMemory: {
        title: 'Painting',
        summary: '',
        extractions: [],
        openQuestions: [],
        nextSteps: [],
      },
      turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
    }),
    /order ## Signals before ## Extractions/i,
  );
});

test('snapshot patch rejects session signals after extractions', () => {
  assert.throws(
    () => extractorLlmTesting.validateSessionExtractionResultForTests([
      '## Extractions',
      '<!-- refs: [turn:13] -->',
      '### Title',
      'Lake sunrise painting',
      '',
      '### Summary',
      'Melanie painted a lake sunrise in 2022.',
      '',
      '## Signals',
      '### Guidance',
      '',
      '- [2] Keep signals before extractions.',
      '',
      '### Skills',
      '',
      '### Open Questions',
    ].join('\n'), {
      sessionMemory: {
        title: 'Painting',
        summary: '',
        extractions: [],
        openQuestions: [],
        nextSteps: [],
      },
      turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
    }),
    /order ## Signals before ## Extractions/i,
  );
});

test('observer validation rejects snapshot content units without metadata', () => {
  assert.throws(
    () => extractorLlmTesting.validateSessionExtractionResultForTests(
      snapshotContentFixture('### Title\nPainting\n\n### Summary\nMelanie painted a lake sunrise in 2022.'),
      {
        sessionMemory: {
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

test('observer validation rejects legacy snapshot content format', () => {
  assert.throws(
    () => extractorLlmTesting.validateSessionExtractionResultForTests(
      snapshotContentFixture('<!-- categories: [Fact]; refs: [turn:13] -->\n[Entity] Melanie\n[Extraction] Melanie painted a lake sunrise in 2022.'),
      {
        sessionMemory: {
          title: 'Painting',
          summary: '',
          extractions: [],
          openQuestions: [],
          nextSteps: [],
        },
        turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
      },
    ),
    /snapshot unit must include ### Title|snapshot patch extraction must start with metadata comment/i,
  );
});

test('observer validation rejects snapshot content units without title', () => {
  assert.throws(
    () => extractorLlmTesting.validateSessionExtractionResultForTests(
      snapshotContentFixture('<!-- refs: [turn:13] -->\n### Summary\nMelanie painted a lake sunrise in 2022.'),
      {
        sessionMemory: {
          title: 'Painting',
          summary: '',
          extractions: [],
          openQuestions: [],
          nextSteps: [],
        },
        turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
      },
    ),
    /must include ### Title/i,
  );
});

test('observer validation rejects unknown snapshot content refs', () => {
  assert.throws(
    () => extractorLlmTesting.validateSessionExtractionResultForTests(
      snapshotContentFixture('<!-- refs: [session:missing] -->\n### Title\nPainting\n\n### Summary\nMelanie painted a lake sunrise in 2022.'),
      {
        sessionMemory: {
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

test('observer validation rejects snapshot content units without refs metadata', () => {
  assert.throws(
    () => extractorLlmTesting.validateSessionExtractionResultForTests(
      snapshotContentFixture('<!-- refs: [] -->\n### Title\nPainting\n\n### Summary\nMelanie painted a lake sunrise in 2022.'),
      {
        sessionMemory: {
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
    () => extractorLlmTesting.validateSessionExtractionResultForTests(JSON.stringify({
      title: 'Painting',
      snapshotContent: '<!-- refs: [turn:13] -->\n### Title\nPainting\n\n### Summary\nMelanie painted a lake sunrise.',
      openQuestions: [],
      nextSteps: [],
      contextRefs: [],
    })),
    /must return snapshot content Markdown, not JSON/i,
  );
});

test('observer validation accepts long titles without runtime length rejection', () => {
  const result = extractorLlmTesting.validateSessionExtractionResultForTests(
    snapshotContentFixture(
      `<!-- refs: [turn:13] -->\n### Title\n${'x'.repeat(81)}\n\n### Summary\nMelanie painted a lake sunrise in 2022.`,
    ),
    {
      sessionMemory: { title: 'Painting', summary: '', extractions: [], openQuestions: [], nextSteps: [] },
      turns: [{ turnId: 'turn:13', summary: 'Melanie discussed painting.' }],
    },
  );
  assert.equal(result.extractions[0].title, 'x'.repeat(81));
});

test('observer validation rejects snapshot content units without summary', () => {
  assert.throws(
    () => extractorLlmTesting.validateSessionExtractionResultForTests(
      snapshotContentFixture('<!-- refs: [turn:13] -->\n### Title\nPainting'),
      {
        sessionMemory: {
          title: 'Painting',
          summary: '',
          extractions: [],
          openQuestions: [],
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
  await writeOpenAiObserverConfig(configPath);
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
      openQuestions: [],
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
  assert.match(firstUserMessage.content, /## Signals\n\(empty\)/);
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
  assert.equal(trace.toolCalls[0].name, 'get_extraction');
  assert.equal(trace.extractions[0].text, 'Caroline attended an LGBTQ support group on 7 May 2023.');
  assert.match(trace.finalText, /## Summary/);
  assert.match(trace.finalText, /Caroline attended an LGBTQ support group on 7 May 2023/);
});

test('thread session can create unrelated extraction without get_extraction', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeOpenAiObserverConfig(configPath);

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
      openQuestions: [],
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
  await writeOpenAiObserverConfig(configPath);
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
      openQuestions: [],
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
  await writeOpenAiObserverConfig(configPath);

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
        openQuestions: [],
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
  await writeOpenAiObserverConfig(configPath);

  const requests = [];
  await extractorLlmModule.extractSessionMemory({
    sessionMemory: {
      title: 'Session group-a',
      summary: 'Default session memory thread for session group-a.',
      snapshotContent: '',
      extractions: [],
      openQuestions: [],
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
  await writeOpenAiObserverConfig(configPath);
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
  await writeOpenAiObserverConfig(configPath);

  const requests = [];
  await extractorLlmModule.extractSessionMemory({
    sessionMemory: {
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
  await writeOpenAiObserverConfig(configPath);

  const requests = [];
  await extractorLlmModule.extractSessionMemory({
    sessionMemory: {
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
    'default-observer',
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
    openQuestions: [],
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
    'default-observer',
    'Career',
    'Career thread',
    [],
    1,
    '2026-01-01T00:00:00.000Z',
  );
  const observeResult = (summary) => ({
    title: 'Career',
    snapshotContent: '',
    extractions: [],
    openQuestions: [],
    nextSteps: [],
    contextRefs: [{ turnId: 'turn:1', summary }],
  });

  threadTesting.applyExtractionForTests(
    thread,
    observeResult('initial summary'),
    1,
    applyExtractionChanges,
    '2026-01-01T00:00:00.000Z',
  );
  threadTesting.applyExtractionForTests(
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
  const thread = createSessionThread(
    'default-observer',
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
      snapshotContent: markdown,
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

test('extractSessionThread passes raw turns to observer', async () => {
  const now = '2026-01-01T00:00:00.000Z';
  const thread = createSessionThread(
    'default-observer',
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
      openQuestions: [],
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
      observer: 'default-observer',
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
    'default-observer',
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
    openQuestions: [],
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
      observer: 'default-observer',
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
    'default-observer',
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
      openQuestions: [],
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
      observer: 'default-observer',
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
      openQuestions: [],
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
    extractorName: 'default-observer',
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
      openQuestions: [],
      nextSteps: [],
      contextRefs: input.turns.map((turn) => ({
        turnId: turn.turnId,
        summary: `${turn.turnId} relevant content`,
      })),
    };
  };

  await sessionTesting.extractEpoch({
    client,
    extractorName: 'default-observer',
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
  const thread = createSessionThread('default-observer', 'Session group-a', 'Default session thread for session group-a.', [], 1, now, 'session', 'group-a');
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
  await writeObserverConfig(configPath);

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
        openQuestions: [],
        nextSteps: [],
        extractionChanges: [],
      },
      {
        project: 'alpha',
        cwd: '/workspace/alpha',
        agent: 'codex',
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

test('observer.retrySnapshotIndexing refreshes the committed checkpoint snapshot after session rows are updated', async (t) => {
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
      get: async () => [],
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
    project: 'alpha',
    cwd: '/workspace/alpha',
    agent: 'codex',
    snapshotId: 'snapshot-1',
    snapshotIds: ['snapshot-0', 'snapshot-1'],
    extractionEpoch: 1,
    title: 'Existing title',
    summary: 'Existing summary',
    snapshots: [
      { project: 'alpha', cwd: '/workspace/alpha', agent: 'codex', snapshotContent: '', extractions: [], contextRefs: [], openQuestions: [], nextSteps: [], extractionChanges: [] },
      {
        project: 'alpha',
        cwd: '/workspace/alpha',
        agent: 'codex',
        snapshotContent: '',
        extractions: [{ id: 'memory-1', text: 'remember this', category: 'Fact', references: ['session:existing'], updatedMemory: null }],
        contextRefs: [],
        openQuestions: [],
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
    observer: 'default-observer',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  }];
  observer.refreshCheckpointSnapshot();

  await observer.retrySnapshotIndexing();

  assert.deepEqual(observer.exportCheckpoint(), {
    committedEpoch: 1,
    nextEpoch: 2,
    runs: [],
    pendingExtractionChanges: [],
    threads: [{
      sessionId: 'session-a',
      latestSnapshotId: 'snapshot-1',
      latestSnapshotSequence: 1,
      indexedSnapshotSequence: 1,
      updatedAt: '2024-01-01T00:00:00Z',
    }],
  });
});

test('observer.extractCurrentEpoch commits session rows before retrying extraction changes', async (t) => {
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
      get: async () => [],
      upsert: async () => {
        extractionUpserts += 1;
      },
    },
  });

  observer.bootstrapped = true;
  observer.openEpoch = new OpenEpoch(2);
  observer.currentEpoch = {
    epoch: 1,
    turns: [makeExtractableTurn('turn-1', 1, 'first')],
  };
  observer.threads = [{
    sessionId: 'session-a',
    snapshotId: 'snapshot-0',
    snapshotIds: ['snapshot-0'],
    extractionEpoch: 0,
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
  observer.indexCurrentEpochSnapshots = async () => {
    indexAttempts += 1;
    throw new Error('extraction write failed');
  };

  await observer.extractCurrentEpoch();

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
      get: async () => [],
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
          openQuestions: [],
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
          openQuestions: [],
          nextSteps: [],
          extractionChanges: [{ type: 'add', text: 'remember this', references: ['session:existing'], reason: 'adds memory' }],
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
        extractionEpoch: 8,
      },
    ],
  });

  observer.retrySnapshotIndexing = async () => {
    calls.push('index');
    observer.nextIndexRetryAt = undefined;
    observer.threads = [];
  };
  observer.extractCurrentEpoch = async () => {
    calls.push('observe');
    observer.currentEpoch = null;
    observer.threads = [];
    observer.shuttingDown = true;
    observer.epochQueue.close();
  };

  await observer.run();

  assert.deepEqual(calls, ['index', 'observe']);
});

test('observer.watermark exposes extraction index retry failures', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

  const observer = new Observer({
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

  observer.bootstrapped = true;
  observer.openEpoch = new OpenEpoch(9);
  observer.threads = [{
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
        openQuestions: [],
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
        openQuestions: [],
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
    observer: 'default-observer',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  }];

  await observer.retrySnapshotIndexing();

  const watermark = await observer.watermark();
  assert.equal(watermark.phases.extractor, 'error');
  assert.deepEqual(watermark.error, {
    phase: 'extractor',
    message: 'Error: extraction write failed',
  });
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
          turn: makeExtractableTurn(`turn-${acceptCount}`, epoch, `turn ${acceptCount}`),
          deduped: false,
        };
      },
    }),
  };

  await observer.accept(makeTurnContent('one', 'one'), registry);
  assert.equal(observer.openEpoch.epoch, 1);
  assert.deepEqual(observer.openEpoch.stagedTurns().map((turn) => turn.turnId), ['turn-1']);
  assert.deepEqual(observer.epochQueue.pendingTurns(), []);

  await observer.accept(makeTurnContent('two', 'two'), registry);
  assert.equal(observer.openEpoch.epoch, 1);
  assert.deepEqual(observer.openEpoch.stagedTurns().map((turn) => turn.turnId), ['turn-1', 'turn-2']);
  assert.deepEqual(observer.epochQueue.pendingTurns(), []);

  await observer.accept(makeTurnContent('three', 'three'), registry);
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
        turn: makeExtractableTurn('turn-1', epoch, 'first'),
        deduped: false,
      }),
    }),
  };

  await observer.accept(makeTurnContent('one', 'one'), registry);
  assert.equal(observer.openEpoch.epoch, 1);

  await waitFor(() => observer.openEpoch.epoch === 2);
  await observer.publishChain;

  assert.deepEqual(observer.epochQueue.pendingTurns().map((turn) => turn.turnId), ['turn-1']);
});

test('observer.accept does not start the epoch window for non-extractable turns', async (t) => {
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
          ...makeExtractableTurn('turn-1', 1, 'first'),
          response: null,
        },
        deduped: false,
      }),
    }),
  };

  await observer.accept(makeTurnContent('one', ''), registry);
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
          turn: makeExtractableTurn('turn-1', epoch, 'first'),
          deduped: false,
        };
      },
    }),
  };

  const acceptPromise = observer.accept(makeTurnContent('first prompt', 'first response'), registry);
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

  await observer.accept(makeTurnContent('first prompt', 'first response'), registry);

  const flushPromise = observer.flushPending();
  while (observer.openEpoch.epoch !== 2) {
    await Promise.resolve();
  }

  const secondAccept = observer.accept(makeTurnContent('second prompt', 'second response'), registry);
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
    () => observer.accept(makeTurnContent('late prompt', 'late response'), {
      load: async () => ({
        accept: async () => makeExtractableTurn('turn-late', 1, 'late'),
      }),
    }),
    /extractor is shutting down/,
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
  const turn = makeExtractableTurn('turn:42', 7, 'publishing');
  const openEpoch = new OpenEpoch(7, [turn]);
  observer.openEpoch = openEpoch;

  let releasePublish;
  observer.publishChain = new Promise((resolve) => {
    releasePublish = resolve;
  });

  const barrier = observer.sealOpenEpoch(openEpoch);
  assert.ok(barrier);

  const watermark = await observer.watermark();
  assert.deepEqual(watermark.pending.turns, [turn.turnId]);
  assert.equal(memoryWatermarkResolved(watermark), false);

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

  await captureTurn(makeTurnContent('replay prompt', 'replay response'));

  await shutdownCoreForTests();

  const watermark = await observerApi.watermark();
  assert.ok(watermark.pending.turns.length > 0);

  await shutdownCoreForTests();
});

test('flushThreads persists session state without inline ref or index builders', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);

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
          openQuestions: [],
          nextSteps: [],
          extractionChanges: [],
        },
      ],
      references: [],
      indexedSnapshotSequence: null,
      observer: 'default-observer',
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
  await writeObserverConfig(configPath);

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
        openQuestions: [],
        nextSteps: [],
        extractionChanges: [],
      },
    ],
    references: [],
    indexedSnapshotSequence: null,
    observer: 'default-observer',
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
