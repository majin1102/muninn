import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import core from '../../dist/backend.js';
import native from '../../dist/native.js';
import { getExtractorLlmConfig } from '../../dist/config.js';
import { MuninnBackend } from '../../dist/backend.js';
import { resolveCheckpointPath } from '../../dist/checkpoint.js';

const { createNativeTables, getNativeTables } = native;

const {
  captureTurn,
  memories,
  memoryPipeline,
  turns,
  shutdownCoreForTests,
  validateSettings,
} = core;

async function makeDatasetUri() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-native-test-'));
  return {
    dir,
    homeDir: path.join(dir, 'muninn'),
    configPath: path.join(dir, 'muninn', 'muninn.json'),
  };
}

function cleanupDataset(dir) {
  return async () => {
    await shutdownCoreForTests();
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  };
}

async function waitForPipelineResolved({ timeoutMs = 2_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  await memoryPipeline.finalize();
  while (Date.now() < deadline) {
    const watermark = await memoryPipeline.watermark();
    if (memoryWatermarkResolved(watermark)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('timed out waiting for memory pipeline watermark');
}

async function waitForFile(filePath, { timeoutMs = 2_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, 'utf8');
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError ?? new Error(`timed out waiting for ${filePath}`);
}

async function waitForFileContent(filePath, predicate, { timeoutMs = 2_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let content = '';
  while (Date.now() < deadline) {
    try {
      content = await readFile(filePath, 'utf8');
      if (predicate(content)) {
        return content;
      }
    } catch {
      // Keep polling until the file exists and its content matches.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for matching content in ${filePath}: ${content}`);
}

function memoryWatermarkResolved(watermark) {
  return watermark.pending.turns.length === 0
    && watermark.phases.extractor === 'idle'
    && !watermark.error;
}

function makePendingTurn({
  sessionId,
  agent,
  extractor,
  prompt = null,
  events = [],
}) {
  const now = new Date().toISOString();
  return {
    turnId: 'turn:18446744073709551615',
    createdAt: now,
    updatedAt: now,
    session_id: sessionId ?? null,
    agent,
    extractor,
    events,
    artifacts: null,
    prompt,
    response: null,
    extractionEpoch: null,
  };
}

function makeTurnContent(overrides = {}) {
  const turn = {
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'default prompt',
    response: 'default response',
    ...overrides,
  };
  return {
    ...turn,
    events: overrides.events ?? [
      { type: 'userMessage', text: turn.prompt },
      { type: 'assistantMessage', text: turn.response },
    ],
  };
}

function sessionSnapshotRow(overrides = {}) {
  const now = overrides.updatedAt ?? '2026-06-18T00:00:00Z';
  return {
    snapshotId: overrides.snapshotId ?? 'session:18446744073709551615',
    sessionId: overrides.sessionId ?? 's1',
    project: overrides.project ?? '/repo/muninn',
    cwd: overrides.cwd ?? '/repo/muninn',
    agent: overrides.agent ?? 'codex',
    snapshotSequence: overrides.snapshotSequence ?? 0,
    createdAt: overrides.createdAt ?? now,
    updatedAt: now,
    extractor: overrides.extractor ?? 'test-extractor',
    title: overrides.title ?? 'Session',
    summary: overrides.summary ?? 'Session summary',
    memorySignals: overrides.memorySignals ?? [],
    skillSignals: overrides.skillSignals ?? [],
    skillDetails: overrides.skillDetails ?? '{}',
    content: overrides.content ?? '# Session\n\n## Summary\n\nSession summary',
    references: overrides.references ?? [],
  };
}

function normalizeTestSessionId(sessionId) {
  return typeof sessionId === 'string' ? sessionId.trim() : sessionId;
}

async function writeTurnAndGet(turn) {
  const content = turn.events ? turn : {
    ...turn,
    events: [
      { type: 'userMessage', text: turn.prompt },
      { type: 'assistantMessage', text: turn.response },
    ],
  };
  await captureTurn(content);
  const listed = await turns.list({
    mode: { type: 'recency', limit: 20 },
    agent: content.agent,
    sessionId: normalizeTestSessionId(content.sessionId),
  });
  const match = listed.find((candidate) => (
    candidate.prompt === content.prompt
    && candidate.response === content.response
  ));
  assert.ok(match);
  return match;
}

function toFileStoreUri(dir) {
  return `file-object-store://${path.resolve(dir)}`;
}

function defaultStorageTarget(homeDir) {
  return { uri: toFileStoreUri(path.join(homeDir, 'main')) };
}

function firstExtractionRef(hits) {
  for (const ref of hits.flatMap((hit) => [hit.memoryId, ...(hit.references ?? [])])) {
    if (ref.startsWith('ext:')) {
      return ref.slice('ext:'.length);
    }
    if (ref.startsWith('extraction:')) {
      return ref.slice('extraction:'.length);
    }
    if (
      ref
      && !ref.startsWith('turn:')
      && !ref.startsWith('session:')
    ) {
      return ref;
    }
  }
  return undefined;
}

async function writeMuninnConfig(configPath, {
  llmProvider = 'mock',
  semanticDimensions = 4,
  storageUri,
  storageOptions,
  watchdog,
  activeWindowDays,
  continuityHints,
  minEpochTurns = 1,
  maxEpochTurns,
  newBatchInputChars,
  snapshotInputChars,
  previewChars,
  epochWindowMs,
  omitEpochSealSettings = false,
} = {}) {
  const root = {};
  const providers = { llm: {}, embedding: {} };
  if (storageUri) {
    root.storage = { uri: storageUri };
    if (storageOptions) {
      root.storage.storageOptions = storageOptions;
    }
  }
  if (llmProvider) {
    root.extractor = {
      name: 'test-extractor',
      llmProvider: 'test_extractor_llm',
      embeddingProvider: 'default',
      maxAttempts: 3,
      ...(activeWindowDays === undefined ? {} : { activeWindowDays }),
      ...(continuityHints === undefined ? {} : { continuityHints }),
      ...(omitEpochSealSettings || minEpochTurns === undefined ? {} : { minEpochTurns }),
      ...(omitEpochSealSettings || maxEpochTurns === undefined ? {} : { maxEpochTurns }),
      ...(newBatchInputChars === undefined ? {} : { newBatchInputChars }),
      ...(snapshotInputChars === undefined ? {} : { snapshotInputChars }),
      ...(previewChars === undefined ? {} : { previewChars }),
      ...(omitEpochSealSettings || epochWindowMs === undefined ? {} : { epochWindowMs }),
    };
    providers.llm.test_extractor_llm = { type: llmProvider };
  }
  if (Object.keys(providers.llm).length > 0 || Object.keys(providers.embedding).length > 0) {
    root.providers = providers;
  }
  if (llmProvider) {
    providers.embedding.default = {
      type: 'mock',
      dimensions: semanticDimensions,
    };
  }
  if (watchdog) {
    root.watchdog = watchdog;
  }
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
}

function validSettings(overrides = {}) {
  const config = {
    providers: {
      llm: {
        test_extractor_llm: { type: 'mock' },
      },
      embedding: {
        default: {
          type: 'mock',
          dimensions: 8,
        },
      },
    },
    extractor: {
      name: 'test-extractor',
      llmProvider: 'test_extractor_llm',
      embeddingProvider: 'default',
    },
  };
  return mergeSettings(config, overrides);
}

function mergeSettings(target, overrides) {
  for (const [key, value] of Object.entries(overrides)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeSettings(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

test.beforeEach(async () => {
  await shutdownCoreForTests();
  delete process.env.MUNINN_HOME;
});

test.after(async () => {
  await shutdownCoreForTests();
  delete process.env.MUNINN_HOME;
});

test('extractor config defaults activeWindowDays, continuityHints, and epoch seal settings', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { llmProvider: 'mock', omitEpochSealSettings: true });

  let extractorConfig = getExtractorLlmConfig();
  assert.ok(extractorConfig);
  assert.equal(extractorConfig.activeWindowDays, 7);
  assert.equal(extractorConfig.continuityHints, 1);
  assert.equal(extractorConfig.minEpochTurns, 8);
  assert.equal(extractorConfig.maxEpochTurns, 32);
  assert.equal(extractorConfig.newBatchInputChars, 24_576);
  assert.equal(extractorConfig.snapshotInputChars, 16_384);
  assert.equal(extractorConfig.previewChars, 800);
  assert.equal(extractorConfig.epochWindowMs, 600_000);

  await writeMuninnConfig(configPath, {
    llmProvider: 'mock',
    activeWindowDays: 14,
    continuityHints: 3,
    minEpochTurns: 5,
    maxEpochTurns: 12,
    newBatchInputChars: 2048,
    snapshotInputChars: 1024,
    previewChars: 512,
    epochWindowMs: 2_500,
  });
  extractorConfig = getExtractorLlmConfig();
  assert.ok(extractorConfig);
  assert.equal(extractorConfig.activeWindowDays, 14);
  assert.equal(extractorConfig.continuityHints, 3);
  assert.equal(extractorConfig.minEpochTurns, 5);
  assert.equal(extractorConfig.maxEpochTurns, 12);
  assert.equal(extractorConfig.newBatchInputChars, 2048);
  assert.equal(extractorConfig.snapshotInputChars, 1024);
  assert.equal(extractorConfig.previewChars, 512);
  assert.equal(extractorConfig.epochWindowMs, 2_500);

  await writeMuninnConfig(configPath, {
    observerProvider: 'mock',
    omitEpochSealSettings: true,
  });
  const oldConfig = JSON.parse(await readFile(configPath, 'utf8'));
  oldConfig.extractor.epochTurns = 99;
  await writeFile(configPath, `${JSON.stringify(oldConfig, null, 2)}\n`, 'utf8');
  extractorConfig = getExtractorLlmConfig();
  assert.ok(extractorConfig);
  assert.equal(extractorConfig.minEpochTurns, 8);
  assert.equal(extractorConfig.maxEpochTurns, 32);
});

test('captureTurn and turns.get roundtrip through the native binding', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath);

  const created = await writeTurnAndGet(makeTurnContent({
    prompt: 'alpha prompt',
    response: 'alpha response',
  }));

  assert.ok(typeof created.turnId === 'string');
  assert.equal(created.sessionId, 'group-a');

  const detail = await turns.get(created.turnId);
  assert.ok(detail);
  assert.equal(detail.turnId, created.turnId);
  assert.equal(detail.sessionId, 'group-a');
  assert.equal(detail.agent, 'agent-a');
  assert.equal(detail.response, 'alpha response');
});

test('captureTurn normalizes sessionId whitespace through the native binding', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath);

  const first = await writeTurnAndGet(makeTurnContent({
    sessionId: ' group-a ',
    prompt: 'first prompt',
    response: 'first response',
  }));
  const second = await writeTurnAndGet(makeTurnContent({
    sessionId: 'group-a',
    prompt: 'second prompt',
    response: 'second response',
    events: [
      { type: 'userMessage', text: 'second prompt' },
      { type: 'toolCall', name: 'tool-a' },
      { type: 'assistantMessage', text: 'second response' },
    ],
  }));

  assert.equal(first.sessionId, 'group-a');
  assert.equal(second.sessionId, 'group-a');
  assert.notEqual(second.turnId, first.turnId);

  const detail = await turns.get(first.turnId);
  assert.ok(detail);
  assert.equal(detail.sessionId, 'group-a');

  const listed = await turns.list({
    mode: { type: 'recency', limit: 10 },
    sessionId: ' group-a ',
  });
  assert.equal(listed.length, 2);
  assert.ok(listed.every((turn) => turn.sessionId === 'group-a'));
});

test('blank sessionId is rejected', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath);

  await assert.rejects(
    () => captureTurn(makeTurnContent({
      sessionId: '   ',
      prompt: 'default prompt',
      response: 'default response',
    })),
    /turn must include sessionId/i,
  );
});

test('captureTurn without sessionId is rejected', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath);

  await assert.rejects(
    () => captureTurn(makeTurnContent({
      sessionId: undefined,
      prompt: 'default-session prompt',
      response: 'default-session response',
    })),
    /turn must include sessionId/i,
  );
});

test('captureTurn does not dedupe identical prompt and response without turnSequence', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath);

  await captureTurn(makeTurnContent({
    prompt: 'same prompt',
    response: 'same response',
    events: [
      { type: 'userMessage', text: 'same prompt' },
      { type: 'toolCall', name: 'tool-a' },
      { type: 'assistantMessage', text: 'same response' },
    ],
  }));
  await captureTurn(makeTurnContent({
    prompt: 'same prompt',
    response: 'same response',
    events: [
      { type: 'userMessage', text: 'same prompt' },
      { type: 'toolCall', name: 'tool-b' },
      { type: 'assistantMessage', text: 'same response' },
    ],
    artifacts: [{ key: 'artifact', kind: 'text', source: 'tool', content: 'value' }],
  }));

  const listed = await turns.list({
    mode: { type: 'page', offset: 0, limit: 20 },
    agent: 'agent-a',
    sessionId: 'group-a',
  });
  const matches = listed.filter((turn) => turn.prompt === 'same prompt' && turn.response === 'same response');
  assert.equal(matches.length, 2);
  assert.equal(new Set(matches.map((turn) => turn.turnId)).size, 2);
});

test('captureTurn dedupes identical turnSequence within the same session', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath);

  const first = makeTurnContent({
    turnSequence: 7,
    prompt: 'sequence prompt',
    response: 'sequence response',
  });
  await captureTurn(first);
  await captureTurn(makeTurnContent({
    turnSequence: 7,
    prompt: 'changed sequence prompt',
    response: 'changed sequence response',
  }));

  const listed = await turns.list({
    mode: { type: 'page', offset: 0, limit: 20 },
    agent: 'agent-a',
    sessionId: 'group-a',
  });
  const sequenceTurns = listed.filter((turn) => turn.turnSequence === 7);
  assert.equal(sequenceTurns.length, 1);
  assert.equal(sequenceTurns[0].prompt, first.prompt);
  assert.equal(sequenceTurns[0].response, first.response);
});

test('turns.list returns the recent window in chronological order, and memories.timeline covers the happy path', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath);

  const first = await writeTurnAndGet(makeTurnContent({
    prompt: 'first prompt',
    response: 'first response',
  }));
  const second = await writeTurnAndGet(makeTurnContent({
    prompt: 'second prompt',
    response: 'second response',
  }));
  await captureTurn(makeTurnContent({
    sessionId: 'group-b',
    agent: 'agent-b',
    prompt: 'other prompt',
    response: 'other response',
  }));

  const listed = await turns.list({ mode: { type: 'recency', limit: 2 } });
  assert.equal(listed.length, 2);
  assert.equal(listed[0].turnId, second.turnId);
  assert.equal(listed[1].sessionId, 'group-b');

  const timeline = await memories.timeline({
    memoryId: second.turnId,
    beforeLimit: 1,
    afterLimit: 1,
  });
  assert.ok(timeline.length >= 2);
  assert.ok(timeline.some((memory) => memory.memoryId === first.turnId));
  assert.ok(timeline.some((memory) => memory.memoryId === second.turnId));
});

test('pure read APIs work without extractor bootstrap config', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { llmProvider: 'mock' });

  const created = await writeTurnAndGet(makeTurnContent({
    prompt: 'bootstrap-free prompt',
    response: 'bootstrap-free response',
  }));

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const watermark = await memoryPipeline.watermark();
    if (memoryWatermarkResolved(watermark)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const hitsBefore = await memories.recall('bootstrap-free prompt', 1);
  assert.ok(hitsBefore[0]?.memoryId.startsWith('ext:'));
  const extractionId = hitsBefore[0].memoryId;

  await shutdownCoreForTests();
  await writeFile(configPath, '{}\n', 'utf8');

  const sessionDetail = await turns.get(created.turnId);
  assert.ok(sessionDetail);
  assert.equal(sessionDetail.turnId, created.turnId);

  const sessionList = await turns.list({ mode: { type: 'recency', limit: 10 } });
  assert.ok(sessionList.some((turn) => turn.turnId === created.turnId));

  const extractionDetail = await memories.get(extractionId);
  assert.ok(extractionDetail);
  assert.equal(extractionDetail.memoryId, extractionId);

  const renderedDetail = await memories.get(created.turnId);
  assert.ok(renderedDetail);
  assert.equal(renderedDetail.memoryId, created.turnId);

  const renderedList = await memories.list({ mode: { type: 'recency', limit: 10 } });
  assert.ok(renderedList.some((memory) => memory.memoryId === created.turnId));

  const renderedTimeline = await memories.timeline({
    memoryId: created.turnId,
    beforeLimit: 1,
    afterLimit: 1,
  });
  assert.ok(renderedTimeline.some((memory) => memory.memoryId === created.turnId));
});

test('invalid memory ids reject through the native binding', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath);

  await assert.rejects(
    () => turns.get('bad-memory-id'),
    /invalid/i,
  );

  await assert.rejects(
    () => turns.get('thinking:42'),
    /invalid/i,
  );
});

test('shutdownCoreForTests allows the native binding to restart cleanly', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath);

  await captureTurn(makeTurnContent({
    prompt: 'first prompt',
    response: 'first response',
  }));

  await shutdownCoreForTests();

  await captureTurn(makeTurnContent({
    prompt: 'second prompt',
    response: 'second response',
  }));
  const listed = await turns.list({ mode: { type: 'recency', limit: 10 } });
  const first = listed.find((turn) => turn.prompt === 'first prompt' && turn.response === 'first response');
  const second = listed.find((turn) => turn.prompt === 'second prompt' && turn.response === 'second response');
  assert.ok(first);
  assert.ok(second);
  assert.ok(second.turnId);
  assert.notEqual(second.turnId, first.turnId);

  const detail = await turns.get(first.turnId);
  assert.ok(detail);
  assert.equal(detail.prompt, 'first prompt');
});

test('checkpoint restore keeps recent turn dedupe within the same extractor', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { llmProvider: 'mock' });

  const firstBackend = await MuninnBackend.create(await getNativeTables());
  try {
    await firstBackend.accept(makeTurnContent({
      turnSequence: 0,
      prompt: 'same prompt',
      response: 'same response',
    }));
    const first = (await firstBackend.memories.listTurns({ mode: { type: 'recency', limit: 1 } }))[0];
    assert.ok(first);
    await firstBackend.accept(makeTurnContent({
      turnSequence: 1,
      prompt: 'before checkpoint',
      response: 'before checkpoint response',
    }));
    const exported = await firstBackend.exportCheckpoint();
    assert.ok(exported);
    await mkdir(path.dirname(resolveCheckpointPath()), { recursive: true });
    await writeFile(resolveCheckpointPath(), `${JSON.stringify({
      ...exported,
      writtenAt: new Date().toISOString(),
      writerPid: process.pid,
    }, null, 2)}\n`, 'utf8');
    await firstBackend.accept(makeTurnContent({
      turnSequence: 2,
      prompt: 'after checkpoint',
      response: 'after checkpoint response',
    }));
    await firstBackend.shutdown();
    await shutdownCoreForTests();

    const secondBackend = await MuninnBackend.create(await getNativeTables());
    try {
      await secondBackend.accept(makeTurnContent({
        turnSequence: 2,
        prompt: 'after checkpoint',
        response: 'after checkpoint response',
      }));
      await secondBackend.accept(makeTurnContent({
        turnSequence: 0,
        prompt: 'same prompt',
        response: 'same response',
      }));
      const listed = await secondBackend.memories.listTurns({ mode: { type: 'recency', limit: 10 } });
      assert.equal(listed.filter((turn) => turn.prompt === 'same prompt' && turn.response === 'same response').length, 1);
      assert.equal(listed.filter((turn) => turn.prompt === 'after checkpoint' && turn.response === 'after checkpoint response').length, 1);
      assert.equal(listed[0].turnId, first.turnId);
    } finally {
      await secondBackend.shutdown();
    }
  } finally {
    await firstBackend.shutdown().catch(() => undefined);
  }
});

test('cold start does not wait for the first watchdog interval before serving writes', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, {
    llmProvider: 'mock',
    watchdog: {
      enabled: true,
      intervalMs: 250,
      compactMinFragments: 1,
      extraction: {
        targetPartitionSize: 16,
        optimizeMergeCount: 2,
      },
    },
  });

  await captureTurn(makeTurnContent({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'cold-start prompt',
    response: 'cold-start response',
  }));
  const watchdogLogPath = path.join(homeDir, 'main', 'logs', 'watchdog.jsonl');
  await assert.rejects(
    () => readFile(watchdogLogPath, 'utf8'),
    /ENOENT/,
  );

  await waitForFileContent(watchdogLogPath, (content) => content.includes('"dataset":"turn"'));
});

test('captureTurn rejects empty turn payloads through the native binding', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath);

  await assert.rejects(
    () => captureTurn({ sessionId: 'group-a', agent: 'agent-a' }),
    /turn must include prompt/i,
  );
});

test('validateSettings rejects extraction index dimension changes that mismatch existing data', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { llmProvider: 'mock' });

  await captureTurn(makeTurnContent({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'extraction prompt',
    response: 'extraction response',
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));

  await assert.rejects(
    () => validateSettings(JSON.stringify(validSettings({
      extractor: { maxAttempts: 3 },
      providers: { embedding: { default: { dimensions: 8 } } },
    }), null, 2)),
    /extraction dimension mismatch/i,
  );
});

test('validateSettings reports invalid JSON before native storage initialization', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '{\n  "storage": {\n    "uri": ""\n  }\n}\n', 'utf8');

  await assert.rejects(
    () => validateSettings('{"watchdog": '),
    /invalid JSON/i,
  );
});

test('validateSettings rejects invalid extractor.activeWindowDays', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '{\n  "storage": {\n    "uri": ""\n  }\n}\n', 'utf8');

  await assert.rejects(
    () => validateSettings(JSON.stringify(validSettings({
      extractor: { activeWindowDays: 0 },
    }), null, 2)),
    /extractor\.activeWindowDays must be a positive integer/i,
  );
});

test('validateSettings rejects invalid extractor.continuityHints', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '{\n  "storage": {\n    "uri": ""\n  }\n}\n', 'utf8');

  await assert.rejects(
    () => validateSettings(JSON.stringify(validSettings({
      extractor: { continuityHints: 0 },
    }), null, 2)),
    /extractor\.continuityHints must be a positive integer/i,
  );
});

test('validateSettings rejects invalid extractor epoch seal settings', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '{\n  "storage": {\n    "uri": ""\n  }\n}\n', 'utf8');

  for (const [key, value] of [
    ['minEpochTurns', 0],
    ['maxEpochTurns', 0],
    ['newBatchInputChars', 0],
    ['snapshotInputChars', 0],
    ['previewChars', 0],
    ['epochWindowMs', 0],
    ['minEpochTurns', 1.5],
    ['maxEpochTurns', 1.5],
    ['newBatchInputChars', 1.5],
    ['snapshotInputChars', 1.5],
    ['previewChars', 1.5],
    ['epochWindowMs', 1.5],
  ]) {
    await assert.rejects(
      () => validateSettings(JSON.stringify(validSettings({
        extractor: { [key]: value },
      }), null, 2)),
      new RegExp(`extractor\\.${key} must be a positive integer`, 'i'),
    );
  }

  await assert.rejects(
    () => validateSettings(JSON.stringify(validSettings({
      extractor: {
        minEpochTurns: 8,
        maxEpochTurns: 7,
      },
    }), null, 2)),
    /extractor\.maxEpochTurns must be greater than or equal to extractor\.minEpochTurns/i,
  );

  await assert.rejects(
    () => validateSettings(JSON.stringify(validSettings({
      extractor: {
        newBatchInputChars: 800,
        previewChars: 800,
      },
    }), null, 2)),
    /extractor\.previewChars must be smaller than extractor\.newBatchInputChars/i,
  );

  await assert.rejects(
    () => validateSettings(JSON.stringify(validSettings({
      extractor: {
        maxInputChars: 800,
      },
    }), null, 2)),
    /extractor\.maxInputChars is no longer supported; use extractor\.newBatchInputChars instead/i,
  );
});

test('validateSettings rejects missing providers config', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.rejects(
    () => validateSettings(JSON.stringify(validSettings({
      providers: undefined,
    }), null, 2)),
    /providers is required/i,
  );
});

test('validateSettings accepts provider registry references', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.doesNotReject(
    () => validateSettings(JSON.stringify({
      providers: {
        llm: {
          default: {
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
      extractor: {
        name: 'test-extractor',
        llmProvider: 'default',
        embeddingProvider: 'default',
        recallMode: 'hybrid',
      },
    }, null, 2)),
  );
});

test('validateSettings rejects legacy provider shape', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.rejects(
    () => validateSettings(JSON.stringify({
      extractor: {
        name: 'test-extractor',
        llm: 'test_extractor_llm',
      },
      llm: {
        test_extractor_llm: {
          provider: 'mock',
        },
      },
      extraction: {
        embedding: {
          provider: 'mock',
          dimensions: 8,
        },
      },
    }, null, 2)),
    /extractor\.llm is no longer supported|unsupported top-level config key: llm/i,
  );
});

test('validateSettings rejects top-level extraction config', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.rejects(
    () => validateSettings(JSON.stringify(validSettings({
      extraction: {
        embeddingProvider: 'default',
      },
    }), null, 2)),
    /unsupported top-level config key: extraction/i,
  );
});

test('validateSettings rejects missing extractor.embeddingProvider config', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.rejects(
    () => validateSettings(JSON.stringify(validSettings({
      extractor: {
        embeddingProvider: undefined,
      },
    }), null, 2)),
    /extractor\.embeddingProvider must be a non-empty string/i,
  );
});

test('validateSettings rejects extractor.defaultImportance config', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.rejects(
    () => validateSettings(JSON.stringify(validSettings({
      extractor: {
        defaultImportance: 0.5,
      },
    }), null, 2)),
    /extractor\.defaultImportance is not supported/i,
  );
});

test('validateSettings accepts omitted extraction dimensions when the default runtime dimensions apply', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.doesNotReject(
    () => validateSettings(JSON.stringify(validSettings({
      providers: { embedding: { default: { dimensions: undefined } } },
    }), null, 2)),
  );
});

test('validateSettings rejects omitted extraction dimensions for an existing non-default table', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { llmProvider: 'mock', semanticDimensions: 4 });

  await captureTurn(makeTurnContent({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'extraction prompt',
    response: 'extraction response',
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));

  await assert.rejects(
    () => validateSettings(JSON.stringify(validSettings({
      extractor: { maxAttempts: 3 },
      providers: { embedding: { default: { dimensions: undefined } } },
    }), null, 2)),
    /extraction dimension mismatch/i,
  );
});

test('validateSettings rejects providers.embedding type when it is empty', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.rejects(
    () => validateSettings(JSON.stringify(validSettings({
      providers: {
        embedding: {
          default: {
            type: '',
          },
        },
      },
    }), null, 2)),
    /providers\.embedding\.default\.type must be a non-empty string/i,
  );
});

test('validateSettings rejects referenced llm entries without type', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.rejects(
    () => validateSettings(JSON.stringify(validSettings({
      providers: {
        llm: {
          test_extractor_llm: { type: undefined },
        },
      },
    }), null, 2)),
    /providers\.llm\.test_extractor_llm\.type must be a non-empty string/i,
  );
});

test('validateSettings rejects top-level turn config', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.rejects(
    () => validateSettings(JSON.stringify(validSettings({
      turn: { llmProvider: 'removed_provider' },
    }), null, 2)),
    /unsupported top-level config key: turn/i,
  );
});

test('validateSettings rejects openai extractor llm without apiKey', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.rejects(
    () => validateSettings(JSON.stringify(validSettings({
      providers: {
        llm: {
          test_extractor_llm: { type: 'openai' },
        },
      },
    }), null, 2)),
    /providers\.llm\.test_extractor_llm\.apiKey must be a non-empty string/i,
  );
});

test('validateSettings rejects openai extraction embeddings without apiKey', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.rejects(
    () => validateSettings(JSON.stringify(validSettings({
      providers: {
        embedding: {
          default: {
            type: 'openai',
            dimensions: 8,
          },
        },
      },
    }), null, 2)),
    /providers\.embedding\.default\.apiKey must be a non-empty string/i,
  );
});

test('validateSettings does not create the default storage root while checking settings', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.doesNotReject(() => validateSettings(JSON.stringify(validSettings(), null, 2)));

  await assert.rejects(() => access(homeDir));
});

test('validateSettings rejects extraction dimension changes when the table exists but is empty', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { llmProvider: 'mock' });

  const binding = await getNativeTables(defaultStorageTarget(homeDir));
  assert.ok(typeof binding.turnTable.describe === 'function');
  assert.ok(typeof binding.sessionTable.describe === 'function');
  assert.ok(typeof binding.dreamingTable.describe === 'function');
  assert.ok(typeof binding.extractionTable.describe === 'function');

  await binding.extractionTable.upsert({
    rows: [{
      id: 'mem-1',
      title: 'extraction text',
      summary: 'extraction text',
      content: '## Title\n\nextraction text\n\n## Summary\n\nextraction text\n\n## Content\n\n',
      cwd: '/workspace/project-a',
      turnRefs: ['turn:1'],
      vector: [0.1, 0.2, 0.3, 0.4],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }],
  });
  await binding.extractionTable.delete({ ids: ['mem-1'] });

  const description = await binding.extractionTable.describe();
  assert.ok(description);
  assert.equal(description.dimensions?.vector, 4);

  await assert.rejects(
    () => validateSettings(JSON.stringify(validSettings({
      extractor: { maxAttempts: 3 },
      providers: { embedding: { default: { dimensions: 8 } } },
    }), null, 2)),
    /extraction dimension mismatch/i,
  );
});

test('native dreaming update preserves stable row id and nested support turns', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { llmProvider: 'mock' });

  const binding = await getNativeTables(defaultStorageTarget(homeDir));
  const inserted = await binding.dreamingTable.append({
    row: {
      dreamingId: 'dreaming:18446744073709551615',
      project: '/repo/muninn',
      createdAt: '2026-06-18T00:00:00Z',
      updatedAt: '2026-06-18T00:00:00Z',
      content: '## Instruction Signal\nPrefer minimal changes.',
      supportTurns: [{
        turnId: 'turn:1',
        createdAt: '2026-06-18T00:00:00Z',
        contribution: 1,
      }],
    },
  });

  assert.match(inserted.dreamingId, /^dreaming:\d+$/);
  const updated = await binding.dreamingTable.update({
    row: {
      ...inserted,
      updatedAt: '2026-06-19T00:00:00Z',
      content: '## Instruction Signal\nPrefer subtractive changes.',
      supportTurns: [
        ...inserted.supportTurns,
        {
          turnId: 'turn:2',
          createdAt: '2026-06-19T00:00:00Z',
          contribution: 10,
        },
      ],
    },
  });

  assert.equal(updated.dreamingId, inserted.dreamingId);
  const reloaded = await binding.dreamingTable.get(inserted.dreamingId);
  assert.ok(reloaded);
  assert.equal(reloaded.dreamingId, inserted.dreamingId);
  assert.equal(reloaded.content, '## Instruction Signal\nPrefer subtractive changes.');
  assert.deepEqual(reloaded.supportTurns.map((turn) => [turn.turnId, turn.contribution]), [
    ['turn:1', 1],
    ['turn:2', 10],
  ]);
});

test('native session snapshots can be listed at a historical version', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { llmProvider: 'mock' });

  const binding = await getNativeTables(defaultStorageTarget(homeDir));
  await binding.sessionTable.insert({
    snapshots: [sessionSnapshotRow({
      snapshotId: 'session:18446744073709551615',
      sessionId: 's1',
      snapshotSequence: 0,
      memorySignals: ['- [turn:1 +1] Prefer minimal changes.'],
    })],
  });
  const baseline = await binding.sessionTable.listSnapshotsWithVersion({ extractor: 'test-extractor' });

  await binding.sessionTable.insert({
    snapshots: [sessionSnapshotRow({
      snapshotId: 'session:18446744073709551615',
      sessionId: 's1',
      snapshotSequence: 1,
      memorySignals: ['- [turn:1 +1, turn:2 +1] Prefer minimal changes.'],
    })],
  });
  const current = await binding.sessionTable.listSnapshotsWithVersion({ extractor: 'test-extractor' });
  const historical = await binding.sessionTable.listSnapshotsWithVersion({
    extractor: 'test-extractor',
    version: baseline.sourceVersion,
  });

  assert.equal(baseline.rows.length, 1);
  assert.equal(current.rows.length, 2);
  assert.equal(historical.sourceVersion, baseline.sourceVersion);
  assert.deepEqual(historical.rows.map((row) => row.snapshotSequence), [0]);
});

test('validateSettings checks the pending storage target instead of the current config storage', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  const storageA = path.join(dir, 'storage-a');
  const storageB = path.join(dir, 'storage-b');

  process.env.MUNINN_HOME = homeDir;

  await writeMuninnConfig(configPath, {
    llmProvider: 'mock',
    storageUri: toFileStoreUri(storageB),
  });
  await captureTurn(makeTurnContent({
    sessionId: 'group-b',
    agent: 'agent-b',
    prompt: 'storage b prompt',
    response: 'storage b response',
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));

  await shutdownCoreForTests();

  await writeMuninnConfig(configPath, {
    llmProvider: 'mock',
    storageUri: toFileStoreUri(storageA),
  });

  await assert.rejects(
    () => validateSettings(JSON.stringify(validSettings({
      storage: {
        uri: toFileStoreUri(storageB),
      },
      extractor: { maxAttempts: 3 },
      providers: { embedding: { default: { dimensions: 8 } } },
    }), null, 2)),
    /extraction dimension mismatch/i,
  );
});

test('validateSettings is not blocked by the current config storage when the pending storage target is valid', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  const storageB = path.join(dir, 'storage-b');

  process.env.MUNINN_HOME = homeDir;
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '{\n  "storage": {\n    "uri": ""\n  }\n}\n', 'utf8');

  await assert.doesNotReject(() => validateSettings(JSON.stringify(validSettings({
    storage: {
      uri: toFileStoreUri(storageB),
    },
  }), null, 2)));
});

test('getNativeTables initializes the native tables only once under concurrent access', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  const [first, second] = await Promise.all([getNativeTables(), getNativeTables()]);
  assert.strictEqual(first, second);
});

test('createNativeTables returns an independent native table binding', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  const singleton = await getNativeTables();
  const standalone = await createNativeTables();
  t.after(async () => standalone.close());

  assert.notStrictEqual(standalone, singleton);
  assert.notStrictEqual(standalone.turnTable, singleton.turnTable);
  assert.notStrictEqual(standalone.extractionTable, singleton.extractionTable);
});

test('memoryPipeline.watermark reports pending turns until extractor flush completes', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { llmProvider: 'mock' });

  const created = await writeTurnAndGet({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'extractor pending prompt',
    response: 'extractor pending response',
  });

  const current = await memoryPipeline.watermark();
  assert.equal(memoryWatermarkResolved(current), false);
  assert.ok(
    current.pending.turns.length === 0
    || (current.pending.turns.length === 1 && current.pending.turns[0] === created.turnId),
  );

  await memoryPipeline.finalize();
  let resolved = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    resolved = await memoryPipeline.watermark();
    if (memoryWatermarkResolved(resolved)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(resolved);
  assert.equal(memoryWatermarkResolved(resolved), true);
  assert.deepEqual(resolved.pending.turns, []);
});

test('memoryPipeline.flushPending drains the current extraction batch without finalize', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, {
    llmProvider: 'mock',
    minEpochTurns: 10,
    epochWindowMs: 60_000,
  });

  const created = await writeTurnAndGet(makeTurnContent({
    prompt: 'batch flush prompt',
    response: 'batch flush response',
  }));

  const pending = await memoryPipeline.watermark();
  assert.deepEqual(pending.pending.turns, [created.turnId]);

  await memoryPipeline.flushPending();
  let resolved = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    resolved = await memoryPipeline.watermark();
    if (resolved.pending.turns.length === 0 && resolved.phases.extractor === 'idle') {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(resolved);
  assert.deepEqual(resolved.pending.turns, []);
  assert.equal(resolved.phases.extractor, 'idle');
});

test('hook capture seals immediately even when the default epoch window is long', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, {
    llmProvider: 'mock',
    minEpochTurns: 8,
    epochWindowMs: 600_000,
  });

  await captureTurn(makeTurnContent({
    agent: 'codex',
    project: '/repo/muninn',
    metadata: { ingest: 'codex-hook' },
    prompt: 'low frequency hook prompt',
    response: 'low frequency hook response',
  }));

  let resolved = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    resolved = await memoryPipeline.watermark();
    if (memoryWatermarkResolved(resolved)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(resolved);
  assert.deepEqual(resolved.pending.turns, []);
  assert.equal(resolved.phases.extractor, 'idle');
  const hits = await memories.recall('low frequency hook prompt', 1);
  assert.ok(hits[0]?.memoryId.startsWith('extraction:'));
});

test('captureTurn persists raw prompt and response without title or summary', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath);

  const created = await writeTurnAndGet({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'summarize this',
    response: 'response body',
  });

  const detail = await turns.get(created.turnId);
  assert.ok(detail);
  assert.equal('title' in detail, false);
  assert.equal('summary' in detail, false);
  assert.equal(detail.prompt, 'summarize this');
  assert.equal(detail.response, 'response body');
});

test('captureTurn persists response turns when the summarizer is not configured', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath);

  const created = await writeTurnAndGet(makeTurnContent({
    prompt: 'response prompt',
    response: 'response body',
  }));

  const detail = await turns.get(created.turnId);
  assert.ok(detail);
  assert.equal(detail.response, 'response body');
  assert.equal('summary' in detail, false);
});

test('extractor writes atomic extractions before indexing snapshots', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { llmProvider: 'mock' });

  await writeTurnAndGet({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'Caroline is thinking about counseling.',
    response: 'Caroline will research counseling programs.',
  });

  await waitForPipelineResolved();

  const hits = await memories.recall('counseling programs', 5);
  const extractionRef = firstExtractionRef(hits);
  assert.ok(extractionRef);
  const extraction = await memories.get(`ext:${extractionRef}`);
  assert.ok(extraction);
  assert.match(extraction.summary ?? extraction.title ?? '', /counseling/i);
});

test('rendered memory binding returns unified turn and extraction reads', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { llmProvider: 'mock' });

  const turn = await writeTurnAndGet({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'rendered prompt',
    response: 'rendered response',
  });

  await waitForPipelineResolved();

  const listed = await memories.list({ mode: { type: 'recency', limit: 10 } });
  assert.ok(listed.some((memory) => memory.memoryId === turn.turnId));

  const turnDetail = await memories.get(turn.turnId);
  assert.ok(turnDetail);
  assert.equal(turnDetail.memoryId, turn.turnId);
  assert.ok(turnDetail.createdAt);
  assert.ok(turnDetail.updatedAt);
  assert.match(turnDetail.summary ?? turnDetail.detail ?? '', /rendered prompt|rendered response/);

  const recalled = await memories.recall('rendered', 10);
  const extractionRef = firstExtractionRef(recalled);
  assert.ok(extractionRef);
  const extraction = await memories.get(`ext:${extractionRef}`);
  assert.ok(extraction);
  assert.equal(extraction.memoryId, `ext:${extractionRef}`);
  assert.match(extraction.summary ?? extraction.title ?? '', /rendered prompt|rendered response/);
});

test('recall returns extraction memory ids and detail renders references', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { llmProvider: 'mock' });

  const binding = await getNativeTables(defaultStorageTarget(homeDir));
  await binding.extractionTable.upsert({
    rows: [{
      id: 'obs-1',
      title: 'Caroline support group',
      summary: 'Caroline joined an LGBTQ support group in May 2023.',
      content: '## Title\n\nCaroline support group\n\n## Summary\n\nCaroline joined an LGBTQ support group in May 2023.\n\n## Content\n\n',
      cwd: '/workspace/project-a',
      turnRefs: ['turn:1'],
      vector: [1, 0, 0, 0],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
  });

  const hits = await memories.recall('support group', 1);
  assert.equal(hits[0].memoryId, 'ext:obs-1');
  const detail = await memories.get('ext:obs-1');
  assert.ok(detail);
  assert.equal(detail.memoryId, 'ext:obs-1');
  assert.match(detail.detail ?? '', /turn:1/);
});

test('rendered memory page mode paginates after combining session and extraction results', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { llmProvider: 'mock' });

  for (let index = 0; index < 3; index += 1) {
    await captureTurn(makeTurnContent({
      sessionId: `group-${index}`,
      agent: `agent-${index}`,
      prompt: `prompt ${index}`,
      response: `response ${index}`,
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  await new Promise((resolve) => setTimeout(resolve, 80));

  const firstPage = await memories.list({ mode: { type: 'page', offset: 0, limit: 2 } });
  const secondPage = await memories.list({ mode: { type: 'page', offset: 2, limit: 2 } });
  const combinedPage = await memories.list({ mode: { type: 'page', offset: 0, limit: 10 } });

  assert.equal(firstPage.length, 2);
  assert.equal(secondPage.length, 2);
  assert.deepEqual(
    firstPage.map((memory) => memory.memoryId),
    combinedPage.slice(0, 2).map((memory) => memory.memoryId),
  );
  assert.deepEqual(
    secondPage.map((memory) => memory.memoryId),
    combinedPage.slice(2, 4).map((memory) => memory.memoryId),
  );
});
