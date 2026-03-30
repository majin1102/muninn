import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import core from '../dist/index.js';

const {
  addMessage,
  memories,
  sessions,
  shutdownCoreForTests,
} = core;

async function makeDatasetUri() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'munnai-core-test-'));
  return {
    dir,
    homeDir: path.join(dir, 'munnai'),
    configPath: path.join(dir, 'munnai', 'settings.json'),
  };
}

async function writeMunnaiConfig(configPath, { turnProvider, observerProvider } = {}) {
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
  delete process.env.MUNNAI_HOME;
});

test('addMessage and sessions.get roundtrip through the Rust bridge', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNNAI_HOME = homeDir;
  
  const created = await addMessage({
    session_id: 'group-a',
    agent: 'agent-a',
    prompt: 'alpha prompt',
    summary: 'alpha summary',
  });

  assert.ok(typeof created.turnId === 'string');
  assert.equal(created.session_id, 'group-a');

  const detail = await sessions.get(`SESSION:${created.turnId}`);
  assert.ok(detail);
  assert.equal(detail.turnId, created.turnId);
  assert.equal(detail.session_id, 'group-a');
  assert.equal(detail.agent, 'agent-a');
  assert.equal(detail.summary, 'alpha summary');
});

test('addMessage without session_id reuses the agent default session through the Rust bridge', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNNAI_HOME = homeDir;

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

  const detail = await sessions.get(`SESSION:${first.turnId}`);
  assert.ok(detail);
  assert.equal(detail.session_id, null);
  assert.equal(detail.agent, 'agent-a');
  assert.deepEqual(detail.toolCalling, ['tool-a']);
});

test('sessions.list returns the recent window in chronological order, and memories.timeline covers the happy path', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNNAI_HOME = homeDir;
  
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
    memoryId: `SESSION:${second.turnId}`,
    beforeLimit: 1,
    afterLimit: 1,
  });
  assert.ok(timeline.length >= 2);
  assert.ok(timeline.some((memory) => memory.memoryId === `SESSION:${first.turnId}`));
  assert.ok(timeline.some((memory) => memory.memoryId === `SESSION:${second.turnId}`));
});

test('invalid memory ids reject through the bridge', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNNAI_HOME = homeDir;
  
  await assert.rejects(
    () => sessions.get('bad-memory-id'),
    /invalid/i,
  );

  await assert.rejects(
    () => sessions.get('THINKING:01JQ7Y8YQ6V7D4M1N9K2F5T8ZX'),
    /invalid/i,
  );
});

test('shutdownCoreForTests allows the daemon to restart cleanly', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNNAI_HOME = homeDir;
  
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

  const detail = await sessions.get(`SESSION:${first.turnId}`);
  assert.ok(detail);
  assert.equal(detail.prompt, 'first prompt\n\nsecond prompt');
});

test('addMessage rejects empty message payloads through the bridge', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNNAI_HOME = homeDir;
  
  await assert.rejects(
    () => addMessage({
      session_id: 'group-a',
      agent: 'agent-a',
    }),
    /at least one message field/i,
  );
});

test('addMessage summarizes response turns when a summary provider is configured', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNNAI_HOME = homeDir;
    await writeMunnaiConfig(configPath, { turnProvider: 'mock' });

  const created = await addMessage({
    session_id: 'group-a',
    agent: 'agent-a',
    prompt: 'summarize this',
    response: 'response body',
  });

  const detail = await sessions.get(`SESSION:${created.turnId}`);
  assert.ok(detail);
  assert.equal(detail.title, 'summarize this');
  assert.equal(detail.summary, 'summarize this\n\nresponse body');
  assert.equal(detail.response, 'response body');
});

test('addMessage persists response turns when the summarizer is not configured', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNNAI_HOME = homeDir;
  
  const created = await addMessage({
    session_id: 'group-a',
    agent: 'agent-a',
    response: 'response body',
  });

  const detail = await sessions.get(`SESSION:${created.turnId}`);
  assert.ok(detail);
  assert.equal(detail.response, 'response body');
  assert.equal(detail.summary, null);
});

test('rendered memory bridge returns unified turn and observing reads', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNNAI_HOME = homeDir;
  process.env.MUNNAI_OBSERVE_WINDOW_MS = '10';
  await writeMunnaiConfig(configPath, { turnProvider: 'mock', observerProvider: 'mock' });

  const turn = await addMessage({
    session_id: 'group-a',
    agent: 'agent-a',
    prompt: 'rendered prompt',
    response: 'rendered response',
  });

  await new Promise((resolve) => setTimeout(resolve, 50));

  const listed = await memories.list({ mode: { type: 'recency', limit: 10 } });
  assert.ok(listed.some((memory) => memory.memoryId === `SESSION:${turn.turnId}`));
  const observing = listed.find((memory) => memory.memoryId.startsWith('OBSERVING:'));
  assert.ok(observing);
  assert.ok(observing.title);
  assert.ok(observing.summary || observing.detail);

  const turnDetail = await memories.get(`SESSION:${turn.turnId}`);
  assert.ok(turnDetail);
  assert.equal(turnDetail.memoryId, `SESSION:${turn.turnId}`);
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
  assert.ok(recalled.some((memory) => memory.memoryId === `SESSION:${turn.turnId}`));
  assert.ok(recalled.some((memory) => memory.memoryId.startsWith('OBSERVING:')));
});
