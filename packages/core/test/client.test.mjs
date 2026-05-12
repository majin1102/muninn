import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import core from '../dist/index.js';
import { getNativeTables } from '../dist/native.js';
import { getObserverLlmConfig } from '../dist/config.js';
import { MuninnBackend } from '../dist/backend.js';
import { resolveCheckpointPath } from '../dist/checkpoint.js';

const {
  addMessage,
  memories,
  observer,
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

async function waitForObserverResolved({ timeoutMs = 2_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const watermark = await observer.watermark();
    if (watermark.resolved) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('timed out waiting for observer watermark');
}

function makePendingTurn({
  sessionId,
  agent,
  observer,
  prompt = null,
  toolCalls = null,
}) {
  const now = new Date().toISOString();
  return {
    turnId: 'turn:18446744073709551615',
    createdAt: now,
    updatedAt: now,
    session_id: sessionId ?? null,
    agent,
    observer,
    title: null,
    summary: null,
    toolCalls,
    artifacts: null,
    prompt,
    response: null,
    observingEpoch: null,
  };
}

function makeTurnContent(overrides = {}) {
  return {
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'default prompt',
    response: 'default response',
    ...overrides,
  };
}

function normalizeTestSessionId(sessionId) {
  return typeof sessionId === 'string' ? sessionId.trim() : sessionId;
}

async function writeTurnAndGet(turn) {
  await addMessage(turn);
  const listed = await turns.list({
    mode: { type: 'recency', limit: 20 },
    agent: turn.agent,
    sessionId: normalizeTestSessionId(turn.sessionId),
  });
  const match = listed.find((candidate) => (
    candidate.prompt === turn.prompt
    && candidate.response === turn.response
  ));
  assert.ok(match);
  return match;
}

function toFileStoreUri(dir) {
  return `file-object-store://${path.resolve(dir)}`;
}

async function writeMuninnConfig(configPath, {
  turnProvider,
  observerProvider = 'mock',
  semanticDimensions = 4,
  storageUri,
  storageOptions,
  watchdog,
  activeWindowDays,
  continuityHints,
  epochTurns = 1,
  epochWindowMs,
  omitEpochSealSettings = false,
  domainPrompt,
} = {}) {
  const root = {};
  const llm = {};
  if (storageUri) {
    root.storage = { uri: storageUri };
    if (storageOptions) {
      root.storage.storageOptions = storageOptions;
    }
  }
  if (turnProvider) {
    root.turn = { llm: 'test_turn_llm' };
    llm.test_turn_llm = { provider: turnProvider };
  }
  if (observerProvider) {
    root.observer = {
      name: 'test-observer',
      llm: 'test_observer_llm',
      maxAttempts: 3,
      ...(activeWindowDays === undefined ? {} : { activeWindowDays }),
      ...(continuityHints === undefined ? {} : { continuityHints }),
      ...(omitEpochSealSettings || epochTurns === undefined ? {} : { epochTurns }),
      ...(omitEpochSealSettings || epochWindowMs === undefined ? {} : { epochWindowMs }),
      ...(domainPrompt === undefined ? {} : { domainPrompt }),
    };
    llm.test_observer_llm = { provider: observerProvider };
  }
  if (Object.keys(llm).length > 0) {
    root.llm = llm;
  }
  if (observerProvider) {
    root.extraction = {
      embedding: {
        provider: 'mock',
        dimensions: semanticDimensions,
      },
      defaultImportance: 0.7,
    };
  }
  if (watchdog) {
    root.watchdog = watchdog;
  }
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
}

test.beforeEach(async () => {
  await shutdownCoreForTests();
  delete process.env.MUNINN_HOME;
});

test.after(async () => {
  await shutdownCoreForTests();
  delete process.env.MUNINN_HOME;
});

test('observer config defaults activeWindowDays, continuityHints, and epoch seal settings', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { observerProvider: 'mock', omitEpochSealSettings: true });

  let observerConfig = getObserverLlmConfig();
  assert.ok(observerConfig);
  assert.equal(observerConfig.activeWindowDays, 7);
  assert.equal(observerConfig.continuityHints, 1);
  assert.equal(observerConfig.epochTurns, 3);
  assert.equal(observerConfig.epochWindowMs, 10_000);

  await writeMuninnConfig(configPath, {
    observerProvider: 'mock',
    activeWindowDays: 14,
    continuityHints: 3,
    epochTurns: 5,
    epochWindowMs: 2_500,
  });
  observerConfig = getObserverLlmConfig();
  assert.ok(observerConfig);
  assert.equal(observerConfig.activeWindowDays, 14);
  assert.equal(observerConfig.continuityHints, 3);
  assert.equal(observerConfig.epochTurns, 5);
  assert.equal(observerConfig.epochWindowMs, 2_500);
});

test('observer config accepts an optional domain prompt name', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { observerProvider: 'mock', domainPrompt: 'chat' });

  const observerConfig = getObserverLlmConfig();
  assert.ok(observerConfig);
  assert.equal(observerConfig.domainPrompt, 'chat');
});

test('addMessage and turns.get roundtrip through the native binding', async (t) => {
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

test('addMessage normalizes sessionId whitespace through the native binding', async (t) => {
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
    toolCalls: [{ name: 'tool-a' }],
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
    () => addMessage(makeTurnContent({
      sessionId: '   ',
      prompt: 'default prompt',
      response: 'default response',
    })),
    /turn must include sessionId/i,
  );
});

test('addMessage without sessionId is rejected', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath);

  await assert.rejects(
    () => addMessage(makeTurnContent({
      sessionId: undefined,
      prompt: 'default-session prompt',
      response: 'default-session response',
    })),
    /turn must include sessionId/i,
  );
});

test('addMessage dedupes identical prompt and response within the same session', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath);

  const first = await writeTurnAndGet(makeTurnContent({
    prompt: 'same prompt',
    response: 'same response',
    toolCalls: [{ name: 'tool-a' }],
  }));
  const second = await writeTurnAndGet(makeTurnContent({
    prompt: 'same prompt',
    response: 'same response',
    toolCalls: [{ name: 'tool-b' }],
    artifacts: [{ key: 'artifact', content: 'value' }],
  }));

  assert.equal(second.turnId, first.turnId);
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
  await addMessage(makeTurnContent({
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

test('pure read APIs work without observer bootstrap config', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { observerProvider: 'mock' });

  const created = await writeTurnAndGet(makeTurnContent({
    prompt: 'bootstrap-free prompt',
    response: 'bootstrap-free response',
  }));

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const watermark = await observer.watermark();
    if (watermark.resolved) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const hitsBefore = await memories.recall('bootstrap-free prompt', 1);
  assert.ok(hitsBefore[0]?.memoryId.startsWith('extraction:'));
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

  await addMessage(makeTurnContent({
    prompt: 'first prompt',
    response: 'first response',
  }));

  await shutdownCoreForTests();

  await addMessage(makeTurnContent({
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

test('checkpoint restore keeps recent turn dedupe within the same observer', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { observerProvider: 'mock' });

  const firstBackend = await MuninnBackend.create(await getNativeTables());
  try {
    await firstBackend.accept(makeTurnContent({
      prompt: 'same prompt',
      response: 'same response',
    }));
    const first = (await firstBackend.memories.listTurns({ mode: { type: 'recency', limit: 1 } }))[0];
    assert.ok(first);
    await firstBackend.accept(makeTurnContent({
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
      prompt: 'after checkpoint',
      response: 'after checkpoint response',
    }));
    await firstBackend.shutdown();
    await shutdownCoreForTests();

    const secondBackend = await MuninnBackend.create(await getNativeTables());
    try {
      await secondBackend.accept(makeTurnContent({
        prompt: 'after checkpoint',
        response: 'after checkpoint response',
      }));
      await secondBackend.accept(makeTurnContent({
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
    observerProvider: 'mock',
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

  await addMessage({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'cold-start prompt',
    response: 'cold-start response',
    summary: 'cold-start summary',
  });
  await assert.rejects(
    () => readFile(path.join(homeDir, 'watchdog.jsonl'), 'utf8'),
    /ENOENT/,
  );

  await new Promise((resolve) => setTimeout(resolve, 350));
  const logContent = await readFile(path.join(homeDir, 'watchdog.jsonl'), 'utf8');
  assert.match(logContent, /"dataset":"turn"/);
});

test('addMessage rejects empty message payloads through the native binding', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath);

  await assert.rejects(
    () => addMessage({ sessionId: 'group-a', agent: 'agent-a' }),
    /turn must include prompt/i,
  );
});

test('validateSettings rejects extraction index dimension changes that mismatch existing data', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { observerProvider: 'mock' });

  await addMessage({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'extraction prompt',
    response: 'extraction response',
    summary: 'extraction summary',
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  await assert.rejects(
    () => validateSettings(JSON.stringify({
      observer: {
        name: 'test-observer',
        llm: 'test_observer_llm',
        maxAttempts: 3,
      },
      llm: {
        test_observer_llm: {
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
    }, null, 2)),
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

test('validateSettings rejects invalid observer.activeWindowDays', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '{\n  "storage": {\n    "uri": ""\n  }\n}\n', 'utf8');

  await assert.rejects(
    () => validateSettings(JSON.stringify({
      observer: {
        name: 'test-observer',
        llm: 'test_observer_llm',
        activeWindowDays: 0,
      },
      llm: {
        test_observer_llm: {
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
    }, null, 2)),
    /observer\.activeWindowDays must be a positive integer/i,
  );
});

test('validateSettings rejects invalid observer.continuityHints', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '{\n  "storage": {\n    "uri": ""\n  }\n}\n', 'utf8');

  await assert.rejects(
    () => validateSettings(JSON.stringify({
      observer: {
        name: 'test-observer',
        llm: 'test_observer_llm',
        continuityHints: 0,
      },
      llm: {
        test_observer_llm: {
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
    }, null, 2)),
    /observer\.continuityHints must be a positive integer/i,
  );
});

test('validateSettings rejects invalid observer epoch seal settings', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '{\n  "storage": {\n    "uri": ""\n  }\n}\n', 'utf8');

  for (const [key, value] of [
    ['epochTurns', 0],
    ['epochWindowMs', 0],
    ['epochTurns', 1.5],
    ['epochWindowMs', 1.5],
  ]) {
    await assert.rejects(
      () => validateSettings(JSON.stringify({
        observer: {
          name: 'test-observer',
          llm: 'test_observer_llm',
          [key]: value,
        },
        llm: {
          test_observer_llm: {
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
      }, null, 2)),
      new RegExp(`observer\\.${key} must be a positive integer`, 'i'),
    );
  }
});

test('validateSettings rejects unknown observer.domainPrompt', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '{\n  "storage": {\n    "uri": ""\n  }\n}\n', 'utf8');

  await assert.rejects(
    () => validateSettings(JSON.stringify({
      observer: {
        name: 'test-observer',
        llm: 'test_observer_llm',
        domainPrompt: 'unknown',
      },
      llm: {
        test_observer_llm: {
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
    }, null, 2)),
    /observer\.domainPrompt must be one of: chat/i,
  );
});

test('validateSettings rejects missing observer config', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.rejects(
    () => validateSettings(JSON.stringify({
      llm: {
        test_observer_llm: {
          provider: 'mock',
        },
      },
      extraction: {
        embedding: {
          provider: 'mock',
          dimensions: 8,
        },
        defaultImportance: 0.5,
      },
    }, null, 2)),
    /observer is required/i,
  );
});

test('validateSettings rejects missing llm config', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.rejects(
    () => validateSettings(JSON.stringify({
      observer: {
        name: 'test-observer',
        llm: 'test_observer_llm',
      },
      extraction: {
        embedding: {
          provider: 'mock',
          dimensions: 8,
        },
        defaultImportance: 0.5,
      },
    }, null, 2)),
    /llm is required/i,
  );
});

test('validateSettings rejects missing extraction config', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.rejects(
    () => validateSettings(JSON.stringify({
      observer: {
        name: 'test-observer',
        llm: 'test_observer_llm',
      },
      llm: {
        test_observer_llm: {
          provider: 'mock',
        },
      },
    }, null, 2)),
    /extraction is required/i,
  );
});

test('validateSettings rejects missing extraction.embedding config', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.rejects(
    () => validateSettings(JSON.stringify({
      observer: {
        name: 'test-observer',
        llm: 'test_observer_llm',
      },
      llm: {
        test_observer_llm: {
          provider: 'mock',
        },
      },
      extraction: {
        defaultImportance: 0.5,
      },
    }, null, 2)),
    /extraction\.embedding is required/i,
  );
});

test('validateSettings accepts omitted extraction dimensions when the default runtime dimensions apply', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.doesNotReject(
    () => validateSettings(JSON.stringify({
      observer: {
        name: 'test-observer',
        llm: 'test_observer_llm',
      },
      llm: {
        test_observer_llm: {
          provider: 'mock',
        },
      },
      extraction: {
        embedding: {
          provider: 'mock',
        },
        defaultImportance: 0.5,
      },
    }, null, 2)),
  );
});

test('validateSettings rejects omitted extraction dimensions for an existing non-default table', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { observerProvider: 'mock', semanticDimensions: 4 });

  await addMessage({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'extraction prompt',
    response: 'extraction response',
    summary: 'extraction summary',
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  await assert.rejects(
    () => validateSettings(JSON.stringify({
      observer: {
        name: 'test-observer',
        llm: 'test_observer_llm',
        maxAttempts: 3,
      },
      llm: {
        test_observer_llm: {
          provider: 'mock',
        },
      },
      extraction: {
        embedding: {
          provider: 'mock',
        },
        defaultImportance: 0.5,
      },
    }, null, 2)),
    /extraction dimension mismatch/i,
  );
});

test('validateSettings rejects extraction.embedding.provider when it is empty', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.rejects(
    () => validateSettings(JSON.stringify({
      extraction: {
        embedding: {
          provider: '',
        },
      },
    }, null, 2)),
    /extraction\.embedding\.provider must be a non-empty string/i,
  );
});

test('validateSettings rejects observer config without observer.llm', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.rejects(
    () => validateSettings(JSON.stringify({
      observer: {
        name: 'test-observer',
      },
      llm: {
        test_observer_llm: {
          provider: 'mock',
        },
      },
    }, null, 2)),
    /observer\.llm must be a non-empty string/i,
  );
});

test('validateSettings rejects referenced llm entries without provider', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.rejects(
    () => validateSettings(JSON.stringify({
      turn: {
        llm: 'test_turn_llm',
      },
      observer: {
        name: 'test-observer',
        llm: 'test_observer_llm',
      },
      llm: {
        test_turn_llm: {},
        test_observer_llm: {},
      },
    }, null, 2)),
    /llm\.(test_turn_llm|test_observer_llm)\.provider must be a non-empty string/i,
  );
});

test('validateSettings rejects openai turn llm without apiKey', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.rejects(
    () => validateSettings(JSON.stringify({
      turn: {
        llm: 'test_turn_llm',
      },
      observer: {
        name: 'test-observer',
        llm: 'test_observer_llm',
      },
      llm: {
        test_turn_llm: {
          provider: 'openai',
        },
        test_observer_llm: {
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
    /llm\.test_turn_llm\.apiKey must be a non-empty string/i,
  );
});

test('validateSettings rejects openai observer llm without apiKey', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.rejects(
    () => validateSettings(JSON.stringify({
      observer: {
        name: 'test-observer',
        llm: 'test_observer_llm',
      },
      llm: {
        test_observer_llm: {
          provider: 'openai',
        },
      },
      extraction: {
        embedding: {
          provider: 'mock',
          dimensions: 8,
        },
      },
    }, null, 2)),
    /llm\.test_observer_llm\.apiKey must be a non-empty string/i,
  );
});

test('validateSettings rejects openai extraction embeddings without apiKey', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.rejects(
    () => validateSettings(JSON.stringify({
      observer: {
        name: 'test-observer',
        llm: 'test_observer_llm',
      },
      llm: {
        test_observer_llm: {
          provider: 'mock',
        },
      },
      extraction: {
        embedding: {
          provider: 'openai',
          dimensions: 8,
        },
      },
    }, null, 2)),
    /extraction\.embedding\.apiKey must be a non-empty string/i,
  );
});

test('validateSettings does not create the default storage root while checking settings', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.doesNotReject(() => validateSettings(JSON.stringify({
    observer: {
      name: 'test-observer',
      llm: 'test_observer_llm',
    },
    llm: {
      test_observer_llm: {
        provider: 'mock',
      },
    },
    extraction: {
      embedding: {
        provider: 'mock',
        dimensions: 8,
      },
      defaultImportance: 0.5,
    },
  }, null, 2)));

  await assert.rejects(() => access(homeDir));
});

test('validateSettings rejects extraction dimension changes when the table exists but is empty', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { observerProvider: 'mock' });

  const binding = await getNativeTables();
  assert.ok(typeof binding.turnTable.describe === 'function');
  assert.ok(typeof binding.sessionTable.describe === 'function');
  assert.ok(typeof binding.extractionTable.describe === 'function');

  await binding.extractionTable.upsert({
    rows: [{
      id: 'mem-1',
      text: 'extraction text',
      context: null,
      anchors: [],
      vector: [0.1, 0.2, 0.3, 0.4],
      importance: 0.7,
      category: 'fact',
      references: ['turn:1'],
      createdAt: '2024-01-01T00:00:00Z',
    }],
  });
  await binding.extractionTable.delete({ ids: ['mem-1'] });

  const description = await binding.extractionTable.describe();
  assert.ok(description);
  assert.equal(description.dimensions?.vector, 4);

  await assert.rejects(
    () => validateSettings(JSON.stringify({
      observer: {
        name: 'test-observer',
        llm: 'test_observer_llm',
        maxAttempts: 3,
      },
      llm: {
        test_observer_llm: {
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
    }, null, 2)),
    /extraction dimension mismatch/i,
  );
});

test('validateSettings checks the pending storage target instead of the current config storage', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  const storageA = path.join(dir, 'storage-a');
  const storageB = path.join(dir, 'storage-b');

  process.env.MUNINN_HOME = homeDir;

  await writeMuninnConfig(configPath, {
    observerProvider: 'mock',
    storageUri: toFileStoreUri(storageB),
  });
  await addMessage({
    sessionId: 'group-b',
    agent: 'agent-b',
    prompt: 'storage b prompt',
    response: 'storage b response',
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  await shutdownCoreForTests();

  await writeMuninnConfig(configPath, {
    observerProvider: 'mock',
    storageUri: toFileStoreUri(storageA),
  });

  await assert.rejects(
    () => validateSettings(JSON.stringify({
      storage: {
        uri: toFileStoreUri(storageB),
      },
      observer: {
        name: 'test-observer',
        llm: 'test_observer_llm',
        maxAttempts: 3,
      },
      llm: {
        test_observer_llm: {
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
    }, null, 2)),
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

  await assert.doesNotReject(() => validateSettings(JSON.stringify({
    storage: {
      uri: toFileStoreUri(storageB),
    },
    observer: {
      name: 'test-observer',
      llm: 'test_observer_llm',
    },
    llm: {
      test_observer_llm: {
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
  }, null, 2)));
});

test('getNativeTables initializes the native tables only once under concurrent access', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  const [first, second] = await Promise.all([getNativeTables(), getNativeTables()]);
  assert.strictEqual(first, second);
});

test('observer.watermark reports pending turns until the observer flush completes', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { observerProvider: 'mock' });

  const created = await writeTurnAndGet({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'observer pending prompt',
    response: 'observer pending response',
  });

  let resolved = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    resolved = await observer.watermark();
    if (!resolved.resolved) {
      assert.ok(
        resolved.pendingTurnIds.length === 0
        || (resolved.pendingTurnIds.length === 1 && resolved.pendingTurnIds[0] === created.turnId),
      );
    } else {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(resolved);
  assert.equal(resolved.resolved, true);
  assert.deepEqual(resolved.pendingTurnIds, []);
});

test('addMessage summarizes response turns when a summary provider is configured', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
    await writeMuninnConfig(configPath, { turnProvider: 'mock' });

  const created = await writeTurnAndGet({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'summarize this',
    response: 'response body',
  });

  const detail = await turns.get(created.turnId);
  assert.ok(detail);
  assert.equal(detail.title, 'summarize this');
  assert.equal(detail.summary, 'summarize this\n\nresponse body');
  assert.equal(detail.response, 'response body');
});

test('addMessage persists response turns when the summarizer is not configured', async (t) => {
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
  assert.equal(detail.summary, 'response prompt\n\nresponse body');
});

test('observer writes atomic extractions before observing snapshots', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { turnProvider: 'mock', observerProvider: 'mock' });

  await writeTurnAndGet({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'Caroline is thinking about counseling.',
    response: 'Caroline will research counseling programs.',
  });

  await waitForObserverResolved();

  const hits = await memories.recall('counseling programs', 5);
  assert.ok(hits.some((hit) => hit.memoryId.startsWith('extraction:')));
});

test('rendered memory binding returns unified turn and extraction reads', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { turnProvider: 'mock', observerProvider: 'mock' });

  const turn = await writeTurnAndGet({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'rendered prompt',
    response: 'rendered response',
  });

  await waitForObserverResolved();

  const listed = await memories.list({ mode: { type: 'recency', limit: 10 } });
  assert.ok(listed.some((memory) => memory.memoryId === turn.turnId));

  const turnDetail = await memories.get(turn.turnId);
  assert.ok(turnDetail);
  assert.equal(turnDetail.memoryId, turn.turnId);
  assert.ok(turnDetail.createdAt);
  assert.ok(turnDetail.updatedAt);
  assert.match(turnDetail.summary ?? turnDetail.detail ?? '', /rendered prompt|rendered response/);

  const recalled = await memories.recall('rendered', 10);
  const extraction = recalled.find((memory) => memory.memoryId.startsWith('extraction:'));
  assert.ok(extraction);

  const extractionDetail = await memories.get(extraction.memoryId);
  assert.ok(extractionDetail);
  assert.equal(extractionDetail.memoryId, extraction.memoryId);
  assert.match(extractionDetail.summary ?? extractionDetail.title ?? '', /rendered prompt|rendered response/);
});

test('recall returns extraction memory ids and detail renders references', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { observerProvider: 'mock' });

  const binding = await getNativeTables();
  await binding.extractionTable.upsert({
    rows: [{
      id: 'obs-1',
      text: 'Caroline joined an LGBTQ support group in May 2023.',
      context: null,
      anchors: [],
      vector: [1, 0, 0, 0],
      importance: 1,
      category: 'fact',
      references: ['turn:1'],
      createdAt: new Date().toISOString(),
    }],
  });

  const hits = await memories.recall('support group', 1);
  assert.equal(hits[0].memoryId, 'extraction:obs-1');
  const detail = await memories.get('extraction:obs-1');
  assert.ok(detail);
  assert.equal(detail.memoryId, 'extraction:obs-1');
  assert.match(detail.detail ?? '', /turn:1/);
});

test('rendered memory page mode paginates after combining session and observing results', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { turnProvider: 'mock', observerProvider: 'mock' });

  for (let index = 0; index < 3; index += 1) {
    await addMessage({
      sessionId: `group-${index}`,
      agent: `agent-${index}`,
      prompt: `prompt ${index}`,
      response: `response ${index}`,
    });
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
