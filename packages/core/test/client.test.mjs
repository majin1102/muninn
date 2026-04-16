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
  observings,
  sessions,
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

function makePendingSessionTurn({
  sessionId,
  agent,
  observer,
  prompt = null,
  toolCalls = null,
}) {
  const now = new Date().toISOString();
  return {
    turnId: 'session:18446744073709551615',
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
  const listed = await sessions.list({
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
    };
    llm.test_observer_llm = { provider: observerProvider };
  }
  if (Object.keys(llm).length > 0) {
    root.llm = llm;
  }
  if (observerProvider) {
    root.semanticIndex = {
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

test('observer config defaults activeWindowDays to 7 and accepts explicit overrides', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { observerProvider: 'mock' });

  let observerConfig = getObserverLlmConfig();
  assert.ok(observerConfig);
  assert.equal(observerConfig.activeWindowDays, 7);

  await writeMuninnConfig(configPath, { observerProvider: 'mock', activeWindowDays: 14 });
  observerConfig = getObserverLlmConfig();
  assert.ok(observerConfig);
  assert.equal(observerConfig.activeWindowDays, 14);
});

test('addMessage and sessions.get roundtrip through the native binding', async (t) => {
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

  const detail = await sessions.get(created.turnId);
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

  const detail = await sessions.get(first.turnId);
  assert.ok(detail);
  assert.equal(detail.sessionId, 'group-a');

  const listed = await sessions.list({
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

test('sessions.list returns the recent window in chronological order, and memories.timeline covers the happy path', async (t) => {
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

  const listed = await sessions.list({ mode: { type: 'recency', limit: 2 } });
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

  const observingListBefore = await observings.list({ mode: { type: 'recency', limit: 10 } });
  assert.ok(observingListBefore.length > 0);
  const observingId = observingListBefore[0].snapshotId;

  await shutdownCoreForTests();
  await writeFile(configPath, '{}\n', 'utf8');

  const sessionDetail = await sessions.get(created.turnId);
  assert.ok(sessionDetail);
  assert.equal(sessionDetail.turnId, created.turnId);

  const sessionList = await sessions.list({ mode: { type: 'recency', limit: 10 } });
  assert.ok(sessionList.some((turn) => turn.turnId === created.turnId));

  const observingDetail = await observings.get(observingId);
  assert.ok(observingDetail);
  assert.equal(observingDetail.snapshotId, observingId);

  const observingList = await observings.list({ mode: { type: 'recency', limit: 10 } });
  assert.ok(observingList.some((snapshot) => snapshot.snapshotId === observingId));

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
    () => sessions.get('bad-memory-id'),
    /invalid/i,
  );

  await assert.rejects(
    () => sessions.get('thinking:42'),
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
  const listed = await sessions.list({ mode: { type: 'recency', limit: 10 } });
  const first = listed.find((turn) => turn.prompt === 'first prompt' && turn.response === 'first response');
  const second = listed.find((turn) => turn.prompt === 'second prompt' && turn.response === 'second response');
  assert.ok(first);
  assert.ok(second);
  assert.ok(second.turnId);
  assert.notEqual(second.turnId, first.turnId);

  const detail = await sessions.get(first.turnId);
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
    const first = (await firstBackend.memories.listSessions({ mode: { type: 'recency', limit: 1 } }))[0];
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
      const listed = await secondBackend.memories.listSessions({ mode: { type: 'recency', limit: 10 } });
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
      semanticIndex: {
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
  assert.match(logContent, /"dataset":"semanticIndex"/);
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

test('validateSettings rejects semantic index dimension changes that mismatch existing data', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { observerProvider: 'mock' });

  await addMessage({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'semantic prompt',
    response: 'semantic response',
    summary: 'semantic summary',
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
      semanticIndex: {
        embedding: {
          provider: 'mock',
          dimensions: 8,
        },
        defaultImportance: 0.7,
      },
    }, null, 2)),
    /semantic_index dimension mismatch/i,
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
      semanticIndex: {
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
      semanticIndex: {
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
      semanticIndex: {
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

test('validateSettings rejects missing semanticIndex config', async (t) => {
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
    /semanticIndex is required/i,
  );
});

test('validateSettings rejects missing semanticIndex.embedding config', async (t) => {
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
      semanticIndex: {
        defaultImportance: 0.5,
      },
    }, null, 2)),
    /semanticIndex\.embedding is required/i,
  );
});

test('validateSettings accepts omitted semantic dimensions when the default runtime dimensions apply', async (t) => {
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
      semanticIndex: {
        embedding: {
          provider: 'mock',
        },
        defaultImportance: 0.5,
      },
    }, null, 2)),
  );
});

test('validateSettings rejects omitted semantic dimensions for an existing non-default table', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { observerProvider: 'mock', semanticDimensions: 4 });

  await addMessage({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'semantic prompt',
    response: 'semantic response',
    summary: 'semantic summary',
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
      semanticIndex: {
        embedding: {
          provider: 'mock',
        },
        defaultImportance: 0.5,
      },
    }, null, 2)),
    /semantic_index dimension mismatch/i,
  );
});

test('validateSettings rejects semanticIndex.embedding.provider when it is empty', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;

  await assert.rejects(
    () => validateSettings(JSON.stringify({
      semanticIndex: {
        embedding: {
          provider: '',
        },
      },
    }, null, 2)),
    /semanticIndex\.embedding\.provider must be a non-empty string/i,
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
      semanticIndex: {
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
      semanticIndex: {
        embedding: {
          provider: 'mock',
          dimensions: 8,
        },
      },
    }, null, 2)),
    /llm\.test_observer_llm\.apiKey must be a non-empty string/i,
  );
});

test('validateSettings rejects openai semantic embeddings without apiKey', async (t) => {
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
      semanticIndex: {
        embedding: {
          provider: 'openai',
          dimensions: 8,
        },
      },
    }, null, 2)),
    /semanticIndex\.embedding\.apiKey must be a non-empty string/i,
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
    semanticIndex: {
      embedding: {
        provider: 'mock',
        dimensions: 8,
      },
      defaultImportance: 0.5,
    },
  }, null, 2)));

  await assert.rejects(() => access(homeDir));
});

test('validateSettings rejects semantic index dimension changes when the table exists but is empty', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(cleanupDataset(dir));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { observerProvider: 'mock' });

  const binding = await getNativeTables();
  assert.ok(typeof binding.sessionTable.describe === 'function');
  assert.ok(typeof binding.observingTable.describe === 'function');
  assert.ok(typeof binding.semanticIndexTable.describe === 'function');

  await binding.semanticIndexTable.upsert({
    rows: [{
      id: 'mem-1',
      memoryId: 'observing:1',
      text: 'semantic text',
      vector: [0.1, 0.2, 0.3, 0.4],
      importance: 0.7,
      category: 'fact',
      createdAt: '2024-01-01T00:00:00Z',
    }],
  });
  await binding.semanticIndexTable.delete({ ids: ['mem-1'] });

  const description = await binding.semanticIndexTable.describe();
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
      semanticIndex: {
        embedding: {
          provider: 'mock',
          dimensions: 8,
        },
        defaultImportance: 0.7,
      },
    }, null, 2)),
    /semantic_index dimension mismatch/i,
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
      semanticIndex: {
        embedding: {
          provider: 'mock',
          dimensions: 8,
        },
        defaultImportance: 0.7,
      },
    }, null, 2)),
    /semantic_index dimension mismatch/i,
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
    semanticIndex: {
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

  const detail = await sessions.get(created.turnId);
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

  const detail = await sessions.get(created.turnId);
  assert.ok(detail);
  assert.equal(detail.response, 'response body');
  assert.equal(detail.summary, 'response prompt\n\nresponse body');
});

test('rendered memory binding returns unified turn and observing reads', async (t) => {
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

  await new Promise((resolve) => setTimeout(resolve, 50));

  const listed = await memories.list({ mode: { type: 'recency', limit: 10 } });
  assert.ok(listed.some((memory) => memory.memoryId === turn.turnId));
  const observing = listed.find((memory) => memory.memoryId.startsWith('observing:'));
  assert.ok(observing);
  assert.ok(observing.title);
  assert.ok(observing.summary || observing.detail);

  const turnDetail = await memories.get(turn.turnId);
  assert.ok(turnDetail);
  assert.equal(turnDetail.memoryId, turn.turnId);
  assert.ok(turnDetail.createdAt);
  assert.ok(turnDetail.updatedAt);
  assert.match(turnDetail.summary ?? turnDetail.detail ?? '', /rendered prompt|rendered response/);

  const observingDetail = await memories.get(observing.memoryId);
  assert.ok(observingDetail);
  assert.equal(observingDetail.memoryId, observing.memoryId);

  const observingTimeline = await memories.timeline({
    memoryId: observing.memoryId,
    beforeLimit: 1,
    afterLimit: 1,
  });
  assert.ok(observingTimeline.length >= 1);
  assert.equal(observingTimeline[0].memoryId, observing.memoryId);

  const recalled = await memories.recall('rendered', 10);
  assert.ok(recalled.some((memory) => memory.memoryId.startsWith('observing:')));
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
