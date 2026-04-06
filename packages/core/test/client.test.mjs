import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import core from '../dist/index.js';
import { getCoreBinding } from '../dist/native.js';

const {
  addMessage,
  memories,
  observer,
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

function toFileStoreUri(dir) {
  return `file-object-store://${path.resolve(dir)}`;
}

async function writeMuninnConfig(configPath, {
  turnProvider,
  observerProvider,
  semanticDimensions = 4,
  storageUri,
  storageOptions,
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
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
}

test.afterEach(async () => {
  await shutdownCoreForTests();
  delete process.env.MUNINN_HOME;
  delete process.env.MUNINN_OBSERVE_WINDOW_MS;
});

test('addMessage and sessions.get roundtrip through the native binding', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  
  const created = await addMessage({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'alpha prompt',
    summary: 'alpha summary',
  });

  assert.ok(typeof created.turnId === 'string');
  assert.equal(created.sessionId, 'group-a');

  const detail = await sessions.get(created.turnId);
  assert.ok(detail);
  assert.equal(detail.turnId, created.turnId);
  assert.equal(detail.sessionId, 'group-a');
  assert.equal(detail.agent, 'agent-a');
  assert.equal(detail.summary, 'alpha summary');
});

test('addMessage without sessionId reuses the agent default session through the native binding', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;

  const first = await addMessage({
    agent: 'agent-a',
    prompt: 'default-session prompt',
  });
  const merged = await addMessage({
    agent: 'agent-a',
    toolCalling: ['tool-a'],
  });
  const otherAgent = await addMessage({
    agent: 'agent-b',
    toolCalling: ['tool-b'],
  });

  assert.equal(merged.turnId, first.turnId);
  assert.notEqual(otherAgent.turnId, first.turnId);

  const detail = await sessions.get(first.turnId);
  assert.ok(detail);
  assert.equal(detail.sessionId, null);
  assert.equal(detail.agent, 'agent-a');
  assert.deepEqual(detail.toolCalling, ['tool-a']);
});

test('sessions.list returns the recent window in chronological order, and memories.timeline covers the happy path', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  
  const first = await addMessage({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'first prompt',
    response: 'first response',
  });
  const second = await addMessage({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'second prompt',
    response: 'second response',
  });
  await addMessage({
    sessionId: 'group-b',
    agent: 'agent-b',
    prompt: 'other prompt',
  });

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

test('invalid memory ids reject through the native binding', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  
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
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  
  const first = await addMessage({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'first prompt',
  });
  assert.ok(first.turnId);

  await shutdownCoreForTests();

  const second = await addMessage({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'second prompt',
  });
  assert.ok(second.turnId);
  assert.equal(second.turnId, first.turnId);

  const detail = await sessions.get(first.turnId);
  assert.ok(detail);
  assert.equal(detail.prompt, 'first prompt\n\nsecond prompt');
});

test('addMessage rejects empty message payloads through the native binding', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  
  await assert.rejects(
    () => addMessage({
      sessionId: 'group-a',
      agent: 'agent-a',
    }),
    /at least one message field/i,
  );
});

test('validateSettings rejects semantic index dimension changes that mismatch existing data', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  process.env.MUNINN_OBSERVE_WINDOW_MS = '10';
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
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '{\n  "storage": {\n    "uri": ""\n  }\n}\n', 'utf8');

  await assert.rejects(
    () => validateSettings('{"watchdog": '),
    /invalid JSON/i,
  );
});

test('validateSettings accepts semanticIndex config when embedding is omitted', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;

  await assert.doesNotReject(() => validateSettings(JSON.stringify({
    semanticIndex: {
      defaultImportance: 0.5,
    },
  }, null, 2)));
});

test('validateSettings rejects observer config without observer.llm', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

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
  t.after(async () => rm(dir, { recursive: true, force: true }));

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

test('validateSettings does not create the default storage root while checking settings', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;

  await assert.doesNotReject(() => validateSettings(JSON.stringify({
    semanticIndex: {
      defaultImportance: 0.5,
    },
  }, null, 2)));

  await assert.rejects(() => access(homeDir));
});

test('validateSettings rejects semantic index dimension changes when the table exists but is empty', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { observerProvider: 'mock' });

  const binding = getCoreBinding();
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
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const storageA = path.join(dir, 'storage-a');
  const storageB = path.join(dir, 'storage-b');

  process.env.MUNINN_HOME = homeDir;
  process.env.MUNINN_OBSERVE_WINDOW_MS = '10';

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
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const storageB = path.join(dir, 'storage-b');

  process.env.MUNINN_HOME = homeDir;
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '{\n  "storage": {\n    "uri": ""\n  }\n}\n', 'utf8');

  await assert.doesNotReject(() => validateSettings(JSON.stringify({
    storage: {
      uri: toFileStoreUri(storageB),
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

test('observer.watermark reports pending turns until the observer flush completes', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { observerProvider: 'mock' });

  const created = await addMessage({
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'observer pending prompt',
    response: 'observer pending response',
  });

  let resolved = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    resolved = await observer.watermark();
    if (!resolved.resolved) {
      assert.deepEqual(resolved.pendingTurnIds, [created.turnId]);
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
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
    await writeMuninnConfig(configPath, { turnProvider: 'mock' });

  const created = await addMessage({
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
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  
  const created = await addMessage({
    sessionId: 'group-a',
    agent: 'agent-a',
    response: 'response body',
  });

  const detail = await sessions.get(created.turnId);
  assert.ok(detail);
  assert.equal(detail.response, 'response body');
  assert.equal(detail.summary, null);
});

test('rendered memory binding returns unified turn and observing reads', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  process.env.MUNINN_OBSERVE_WINDOW_MS = '10';
  await writeMuninnConfig(configPath, { turnProvider: 'mock', observerProvider: 'mock' });

  const turn = await addMessage({
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
