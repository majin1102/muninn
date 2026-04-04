import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import core from '../dist/index.js';

const {
  addMessage,
  memories,
  observer,
  sessions,
  shutdownCoreForTests,
} = core;

async function makeDatasetUri() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-core-test-'));
  return {
    dir,
    homeDir: path.join(dir, 'muninn'),
    configPath: path.join(dir, 'muninn', 'muninn.json'),
  };
}

async function writeMuninnConfig(configPath, { turnProvider, observerProvider } = {}) {
  const root = {};
  const llm = {};
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
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
}

test.afterEach(async () => {
  await shutdownCoreForTests();
  delete process.env.MUNINN_HOME;
  delete process.env.MUNINN_CORE_ALLOW_CARGO_FALLBACK;
  delete process.env.MUNINN_OBSERVER_POLL_MS;
});

test.beforeEach(() => {
  process.env.MUNINN_CORE_ALLOW_CARGO_FALLBACK = '1';
});

test('addMessage and sessions.get roundtrip through the Rust bridge', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  
  const created = await addMessage({
    session_id: 'group-a',
    agent: 'agent-a',
    prompt: 'alpha prompt',
    summary: 'alpha summary',
  });

  assert.ok(typeof created.turnId === 'string');
  assert.equal(created.session_id, 'group-a');

  const detail = await sessions.get(created.turnId);
  assert.ok(detail);
  assert.equal(detail.turnId, created.turnId);
  assert.equal(detail.session_id, 'group-a');
  assert.equal(detail.agent, 'agent-a');
  assert.equal(detail.summary, 'alpha summary');
});

test('addMessage without session_id reuses the agent default session through the Rust bridge', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;

  const first = await addMessage({
    agent: 'agent-a',
    prompt: 'default-session prompt',
  });
  const merged = await addMessage({
    agent: 'agent-a',
    tool_calling: ['tool-a'],
  });
  const otherAgent = await addMessage({
    agent: 'agent-b',
    tool_calling: ['tool-b'],
  });

  assert.equal(merged.turnId, first.turnId);
  assert.notEqual(otherAgent.turnId, first.turnId);

  const detail = await sessions.get(first.turnId);
  assert.ok(detail);
  assert.equal(detail.session_id, null);
  assert.equal(detail.agent, 'agent-a');
  assert.deepEqual(detail.toolCalling, ['tool-a']);
});

test('sessions.list returns the recent window in chronological order, and memories.timeline covers the happy path', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  
  const first = await addMessage({
    session_id: 'group-a',
    agent: 'agent-a',
    prompt: 'first prompt',
    response: 'first response',
  });
  const second = await addMessage({
    session_id: 'group-a',
    agent: 'agent-a',
    prompt: 'second prompt',
    response: 'second response',
  });
  await addMessage({
    session_id: 'group-b',
    agent: 'agent-b',
    prompt: 'other prompt',
  });

  const listed = await sessions.list({ mode: { type: 'recency', limit: 2 } });
  assert.equal(listed.length, 2);
  assert.equal(listed[0].turnId, second.turnId);
  assert.equal(listed[1].session_id, 'group-b');

  const timeline = await memories.timeline({
    memoryId: second.turnId,
    beforeLimit: 1,
    afterLimit: 1,
  });
  assert.ok(timeline.length >= 2);
  assert.ok(timeline.some((memory) => memory.memoryId === first.turnId));
  assert.ok(timeline.some((memory) => memory.memoryId === second.turnId));
});

test('invalid memory ids reject through the bridge', async (t) => {
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

test('shutdownCoreForTests allows the daemon to restart cleanly', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  
  const first = await addMessage({
    session_id: 'group-a',
    agent: 'agent-a',
    prompt: 'first prompt',
  });
  assert.ok(first.turnId);

  await shutdownCoreForTests();

  const second = await addMessage({
    session_id: 'group-a',
    agent: 'agent-a',
    prompt: 'second prompt',
  });
  assert.ok(second.turnId);
  assert.equal(second.turnId, first.turnId);

  const detail = await sessions.get(first.turnId);
  assert.ok(detail);
  assert.equal(detail.prompt, 'first prompt\n\nsecond prompt');
});

test('addMessage rejects empty message payloads through the bridge', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  
  await assert.rejects(
    () => addMessage({
      session_id: 'group-a',
      agent: 'agent-a',
    }),
    /at least one message field/i,
  );
});

test('observer.watermark reports pending turns until the observer flush completes', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  process.env.MUNINN_OBSERVER_POLL_MS = '60000';
  await writeMuninnConfig(configPath, { observerProvider: 'mock' });

  const created = await addMessage({
    session_id: 'group-a',
    agent: 'agent-a',
    prompt: 'observer pending prompt',
    response: 'observer pending response',
  });

  const current = await observer.watermark();
  assert.equal(current.resolved, false);
  assert.deepEqual(current.pendingTurnIds, [created.turnId]);

  process.env.MUNINN_OBSERVER_POLL_MS = '1';
  await shutdownCoreForTests();

  let resolved = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    resolved = await observer.watermark();
    if (resolved.resolved) {
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
    session_id: 'group-a',
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
    session_id: 'group-a',
    agent: 'agent-a',
    response: 'response body',
  });

  const detail = await sessions.get(created.turnId);
  assert.ok(detail);
  assert.equal(detail.response, 'response body');
  assert.equal(detail.summary, null);
});

test('rendered memory bridge returns unified turn and observing reads', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  process.env.MUNINN_OBSERVE_WINDOW_MS = '10';
  await writeMuninnConfig(configPath, { turnProvider: 'mock', observerProvider: 'mock' });

  const turn = await addMessage({
    session_id: 'group-a',
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
