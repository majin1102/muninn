import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import core from '@munnai/core';
import { app } from '../dist/app.js';

const { shutdownCoreForTests } = core;

async function makeDatasetUri() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'munnai-sidecar-test-'));
  return {
    dir,
    homeDir: path.join(dir, 'munnai'),
    configPath: path.join(dir, 'munnai', 'settings.json'),
  };
}

async function json(response) {
  return response.json();
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
  delete process.env.MUNNAI_OBSERVE_WINDOW_MS;
});

test('session/messages writes a message into a session and detail reads it back', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNNAI_HOME = homeDir;
  await writeMunnaiConfig(configPath, { turnProvider: 'mock' });

  const addResponse = await app.request('/api/v1/session/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session: {
        session_id: 'group-a',
        agent: 'agent-a',
        prompt: 'alpha prompt',
        response: 'alpha response',
        tool_calling: ['tool-a'],
        artifacts: { key: 'value' },
        extra: { source: 'test' },
      },
    }),
  });
  assert.equal(addResponse.status, 200);
  const added = await json(addResponse);
  assert.ok(typeof added.turnId === 'string');

  const detailResponse = await app.request(
    `/api/v1/detail?memoryId=${encodeURIComponent(`SESSION:${added.turnId}`)}`
  );
  assert.equal(detailResponse.status, 200);
  const detail = await json(detailResponse);
  assert.equal(detail.memoryHits.length, 1);
  assert.equal(detail.memoryHits[0].memoryId, `SESSION:${added.turnId}`);
  assert.match(detail.memoryHits[0].content, /## Title/);
  assert.match(detail.memoryHits[0].content, /alpha prompt/);
  assert.match(detail.memoryHits[0].content, /## Created At/);
  assert.match(detail.memoryHits[0].content, /## Summary/);
  assert.match(detail.memoryHits[0].content, /## Detail/);
  assert.match(detail.memoryHits[0].content, /alpha prompt/);
  assert.match(detail.memoryHits[0].content, /alpha response/);
});

test('session/messages validates request shape and requires at least one message field', async () => {
  const { dir, homeDir } = await makeDatasetUri();
  process.env.MUNNAI_HOME = homeDir;
  
  try {
    const response = await app.request('/api/v1/session/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session: {
          session_id: 123,
          agent: 'agent-a',
        },
      }),
    });
    assert.equal(response.status, 400);
    const body = await json(response);
    assert.equal(body.errorCode, 'invalidRequest');

    for (const badSession of [
      { agent: 'agent-a' },
      { agent: 'agent-a', tool_calling: 'tool-a' },
      { agent: 'agent-a', prompt: 123, tool_calling: ['tool-a'] },
      { agent: 'agent-a', artifacts: { key: 1 } },
      { agent: 'agent-a', extra: { key: 1 } },
    ]) {
      const invalidResponse = await app.request('/api/v1/session/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: badSession }),
      });
      assert.equal(invalidResponse.status, 400);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('session/messages maps core write validation failures to invalidRequest', async () => {
  const { dir, homeDir } = await makeDatasetUri();
  process.env.MUNNAI_HOME = homeDir;

  try {
    const response = await app.request('/api/v1/session/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session: {
          session_id: 'group-a',
          agent: 'agent-a',
          summary: 'summary only',
        },
      }),
    });
    assert.equal(response.status, 400);
    const body = await json(response);
    assert.equal(body.errorCode, 'invalidRequest');
    assert.match(body.errorMessage, /at least one message field/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('session/messages accepts prompt-only, response-only, and tool-only payloads', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNNAI_HOME = homeDir;
    await writeMunnaiConfig(configPath, { turnProvider: 'mock' });

  for (const payload of [
    { session_id: 'group-a', agent: 'agent-a', prompt: 'prompt only' },
    { session_id: 'group-a', agent: 'agent-a', response: 'response only' },
    { session_id: 'group-a', agent: 'agent-a', tool_calling: ['tool-a'] },
  ]) {
    const response = await app.request('/api/v1/session/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: payload }),
    });
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.ok(typeof body.turnId === 'string');
  }
});

test('session/messages reuses the agent default session when session_id is omitted', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNNAI_HOME = homeDir;
  await writeMunnaiConfig(configPath, { turnProvider: 'mock' });

  const first = await app.request('/api/v1/session/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session: {
        agent: 'agent-a',
        prompt: 'default-session prompt',
      },
    }),
  });
  assert.equal(first.status, 200);
  const firstBody = await json(first);

  const merged = await app.request('/api/v1/session/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session: {
        agent: 'agent-a',
        tool_calling: ['tool-a'],
      },
    }),
  });
  assert.equal(merged.status, 200);
  const mergedBody = await json(merged);

  const otherAgent = await app.request('/api/v1/session/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session: {
        agent: 'agent-b',
        tool_calling: ['tool-b'],
      },
    }),
  });
  assert.equal(otherAgent.status, 200);
  const otherAgentBody = await json(otherAgent);

  assert.equal(mergedBody.turnId, firstBody.turnId);
  assert.notEqual(otherAgentBody.turnId, firstBody.turnId);
});

test('session/messages accepts extra at the API layer but does not treat it as message content', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNNAI_HOME = homeDir;
    await writeMunnaiConfig(configPath, { turnProvider: 'mock' });

  const success = await app.request('/api/v1/session/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session: {
        session_id: 'group-a',
        agent: 'agent-a',
        prompt: 'prompt with extra',
        extra: { source: 'openclaw' },
      },
    }),
  });
  assert.equal(success.status, 200);

  const rejected = await app.request('/api/v1/session/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session: {
        session_id: 'group-a',
        agent: 'agent-a',
        extra: { source: 'openclaw' },
      },
    }),
  });
  assert.equal(rejected.status, 400);
});

test('list returns the recent window in chronological order, and timeline/recall cover the written flow', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNNAI_HOME = homeDir;
  
  const created = [];
  for (const payload of [
    { session_id: 'group-a', agent: 'agent-a', prompt: 'first alpha prompt', response: 'first alpha response' },
    { session_id: 'group-a', agent: 'agent-a', prompt: 'second alpha prompt', response: 'second alpha response' },
    { session_id: 'group-a', agent: 'agent-a', prompt: 'third alpha prompt', response: 'third alpha response' },
    { session_id: 'group-b', agent: 'agent-b', prompt: 'other beta prompt' },
  ]) {
    const response = await app.request('/api/v1/session/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: payload }),
    });
    assert.equal(response.status, 200);
    created.push(await json(response));
  }

  const listResponse = await app.request('/api/v1/list?mode=recency&limit=3');
  assert.equal(listResponse.status, 200);
  const listed = await json(listResponse);
  assert.equal(listed.memoryHits.length, 3);
  assert.match(listed.memoryHits[0].memoryId, /^SESSION:/);
  assert.match(listed.memoryHits[0].content, /second alpha prompt/);
  assert.match(listed.memoryHits[1].content, /third alpha prompt/);
  assert.match(listed.memoryHits[2].content, /other beta prompt/);

  const timelineResponse = await app.request(
    `/api/v1/timeline?memoryId=${encodeURIComponent(`SESSION:${created[1].turnId}`)}&beforeLimit=1&afterLimit=1`
  );
  assert.equal(timelineResponse.status, 200);
  const timeline = await json(timelineResponse);
  assert.equal(timeline.memoryHits.length, 3);
  assert.equal(timeline.memoryHits[1].memoryId, `SESSION:${created[1].turnId}`);

  const recallResponse = await app.request('/api/v1/recall?query=alpha&limit=2');
  assert.equal(recallResponse.status, 200);
  const recalled = await json(recallResponse);
  assert.equal(recalled.memoryHits.length, 2);
  assert.match(recalled.memoryHits[0].content, /alpha/);
});

test('timeline stays scoped to the full session key when agents share a session_id', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNNAI_HOME = homeDir;

  const first = await app.request('/api/v1/session/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session: {
        session_id: 'group-a',
        agent: 'agent-a',
        prompt: 'agent a prompt 1',
        response: 'agent a response 1',
      },
    }),
  });
  assert.equal(first.status, 200);
  const firstBody = await json(first);

  const otherAgent = await app.request('/api/v1/session/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session: {
        session_id: 'group-a',
        agent: 'agent-b',
        prompt: 'agent b prompt',
        response: 'agent b response',
      },
    }),
  });
  assert.equal(otherAgent.status, 200);
  const otherAgentBody = await json(otherAgent);

  const second = await app.request('/api/v1/session/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session: {
        session_id: 'group-a',
        agent: 'agent-a',
        prompt: 'agent a prompt 2',
        response: 'agent a response 2',
      },
    }),
  });
  assert.equal(second.status, 200);
  const secondBody = await json(second);

  const timelineResponse = await app.request(
    `/api/v1/timeline?memoryId=${encodeURIComponent(`SESSION:${secondBody.turnId}`)}&beforeLimit=1&afterLimit=1`
  );
  assert.equal(timelineResponse.status, 200);
  const timeline = await json(timelineResponse);
  const memoryIds = timeline.memoryHits.map((hit) => hit.memoryId);
  assert.deepEqual(memoryIds, [
    `SESSION:${firstBody.turnId}`,
    `SESSION:${secondBody.turnId}`,
  ]);
  assert.ok(!memoryIds.includes(`SESSION:${otherAgentBody.turnId}`));
});

test('recall and timeline surface request and not-found errors', async () => {
  const { dir, homeDir } = await makeDatasetUri();
  process.env.MUNNAI_HOME = homeDir;
  
  try {
    const missingQuery = await app.request('/api/v1/recall');
    assert.equal(missingQuery.status, 400);

    const missingTimeline = await app.request(
      `/api/v1/timeline?memoryId=${encodeURIComponent('SESSION:01JQ7Y8YQ6V7D4M1N9K2F5T8ZX')}`
    );
    assert.equal(missingTimeline.status, 404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recall, list, and timeline reject invalid numeric query parameters', async () => {
  const { dir, homeDir } = await makeDatasetUri();
  process.env.MUNNAI_HOME = homeDir;

  try {
    const badRecall = await app.request('/api/v1/recall?query=alpha&limit=abc');
    assert.equal(badRecall.status, 400);
    const badRecallBody = await json(badRecall);
    assert.equal(badRecallBody.errorCode, 'invalidRequest');

    const badList = await app.request('/api/v1/list?mode=recency&limit=-1');
    assert.equal(badList.status, 400);
    const badListBody = await json(badList);
    assert.equal(badListBody.errorCode, 'invalidRequest');

    const badTimeline = await app.request(
      `/api/v1/timeline?memoryId=${encodeURIComponent('SESSION:01JQ7Y8YQ6V7D4M1N9K2F5T8ZX')}&beforeLimit=1.5`
    );
    assert.equal(badTimeline.status, 400);
    const badTimelineBody = await json(badTimeline);
    assert.equal(badTimelineBody.errorCode, 'invalidRequest');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detail and timeline map invalid memoryId inputs to invalidRequest', async () => {
  const { dir, homeDir } = await makeDatasetUri();
  process.env.MUNNAI_HOME = homeDir;
  
  try {
    const badDetail = await app.request('/api/v1/detail?memoryId=bad');
    assert.equal(badDetail.status, 400);
    const badDetailBody = await json(badDetail);
    assert.equal(badDetailBody.errorCode, 'invalidRequest');

    const wrongLayerTimeline = await app.request(
      `/api/v1/timeline?memoryId=${encodeURIComponent('THINKING:01JQ7Y8YQ6V7D4M1N9K2F5T8ZX')}`
    );
    assert.equal(wrongLayerTimeline.status, 400);
    const wrongLayerBody = await json(wrongLayerTimeline);
    assert.equal(wrongLayerBody.errorCode, 'invalidRequest');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('session/messages accepts response payloads when turn summarization is not configured', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNNAI_HOME = homeDir;
  
  const response = await app.request('/api/v1/session/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session: {
        session_id: 'group-a',
        agent: 'agent-a',
        response: 'response only',
      },
    }),
  });

  assert.equal(response.status, 200);
  const body = await json(response);
  const detailResponse = await app.request(
    `/api/v1/detail?memoryId=${encodeURIComponent(`SESSION:${body.turnId}`)}`
  );
  assert.equal(detailResponse.status, 200);
  const detail = await json(detailResponse);
  assert.equal(detail.memoryHits.length, 1);
  assert.doesNotMatch(detail.memoryHits[0].content, /## Summary/);
  assert.match(detail.memoryHits[0].content, /## Detail/);
  assert.match(detail.memoryHits[0].content, /response only/);
});

test('ui session endpoints group by agent/session and return rendered turn documents', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNNAI_HOME = homeDir;
    await writeMunnaiConfig(configPath, { turnProvider: 'mock' });

  const payloads = [
    { session_id: 'group-a', agent: 'openclaw', prompt: 'first alpha prompt', response: 'first alpha response' },
    { session_id: 'group-a', agent: 'openclaw', prompt: 'second alpha prompt', response: 'second alpha response' },
    { session_id: 'group-b', agent: 'codex_cli', tool_calling: ['grep', 'sed'] },
  ];

  const created = [];
  for (const session of payloads) {
    const response = await app.request('/api/v1/session/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session }),
    });
    assert.equal(response.status, 200);
    created.push(await json(response));
  }

  const agentsResponse = await app.request('/api/v1/ui/session/agents');
  assert.equal(agentsResponse.status, 200);
  const agentsBody = await json(agentsResponse);
  assert.equal(agentsBody.agents.length, 1);
  assert.equal(agentsBody.agents[0].agent, 'openclaw');

  const sessionsResponse = await app.request('/api/v1/ui/session/agents/openclaw/sessions');
  assert.equal(sessionsResponse.status, 200);
  const sessionsBody = await json(sessionsResponse);
  assert.equal(sessionsBody.sessions.length, 1);
  assert.equal(sessionsBody.sessions[0].displaySessionId, 'group-a');

  const ungroupedResponse = await app.request('/api/v1/ui/session/agents/codex_cli/sessions');
  assert.equal(ungroupedResponse.status, 200);
  const ungroupedBody = await json(ungroupedResponse);
  assert.equal(ungroupedBody.sessions.length, 0);

  const turnsResponse = await app.request('/api/v1/ui/session/agents/openclaw/sessions/group-a/turns?offset=0&limit=10');
  assert.equal(turnsResponse.status, 200);
  const turnsBody = await json(turnsResponse);
  assert.equal(turnsBody.turns.length, 2);
  assert.equal(turnsBody.turns[0].title, 'second alpha prompt');
  assert.match(turnsBody.turns[0].summary, /alpha/);

  const documentResponse = await app.request(
    `/api/v1/ui/memories/${encodeURIComponent(`SESSION:${created[0].turnId}`)}/document`
  );
  assert.equal(documentResponse.status, 200);
  const documentBody = await json(documentResponse);
  assert.equal(documentBody.document.kind, 'session');
  assert.match(documentBody.document.markdown, /## Created At/);
  assert.match(documentBody.document.markdown, /first alpha prompt/);
});

test('observing memories are readable through list/detail/timeline/recall', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNNAI_HOME = homeDir;
    process.env.MUNNAI_OBSERVE_WINDOW_MS = '10';
  await writeMunnaiConfig(configPath, { turnProvider: 'mock', observerProvider: 'mock' });

  const addResponse = await app.request('/api/v1/session/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session: {
        session_id: 'group-a',
        agent: 'agent-a',
        prompt: 'observe this prompt',
        response: 'observe this response',
      },
    }),
  });
  assert.equal(addResponse.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 50));

  const listResponse = await app.request('/api/v1/list?mode=recency&limit=10');
  assert.equal(listResponse.status, 200);
  const listed = await json(listResponse);
  const observingHit = listed.memoryHits.find((hit) => hit.memoryId.startsWith('OBSERVING:'));
  assert.ok(observingHit);
  assert.match(observingHit.content, /## Summary|## Detail/);
  assert.match(observingHit.content, /observe this prompt|observe this response/);

  const detailResponse = await app.request(
    `/api/v1/detail?memoryId=${encodeURIComponent(observingHit.memoryId)}`
  );
  assert.equal(detailResponse.status, 200);
  const detail = await json(detailResponse);
  assert.equal(detail.memoryHits.length, 1);
  assert.equal(detail.memoryHits[0].memoryId, observingHit.memoryId);
  assert.match(detail.memoryHits[0].content, /## Detail/);

  const timelineResponse = await app.request(
    `/api/v1/timeline?memoryId=${encodeURIComponent(observingHit.memoryId)}&beforeLimit=1&afterLimit=1`
  );
  assert.equal(timelineResponse.status, 200);
  const timeline = await json(timelineResponse);
  assert.equal(timeline.memoryHits.length, 1);
  assert.equal(timeline.memoryHits[0].memoryId, observingHit.memoryId);

  const recallResponse = await app.request('/api/v1/recall?query=observe&limit=10');
  assert.equal(recallResponse.status, 200);
  const recalled = await json(recallResponse);
  assert.ok(recalled.memoryHits.some((hit) => hit.memoryId === observingHit.memoryId));
});

test('ui observing endpoints return live observings and documents', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNNAI_HOME = homeDir;
    process.env.MUNNAI_OBSERVE_WINDOW_MS = '10';
  await writeMunnaiConfig(configPath, { turnProvider: 'mock', observerProvider: 'mock' });

  const addResponse = await app.request('/api/v1/session/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session: {
        session_id: 'group-ui',
        agent: 'agent-ui',
        prompt: 'ui observing prompt',
        response: 'ui observing response',
      },
    }),
  });
  assert.equal(addResponse.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 50));

  const observingsResponse = await app.request('/api/v1/ui/observing');
  assert.equal(observingsResponse.status, 200);
  const observings = await json(observingsResponse);
  assert.ok(observings.observations.length >= 1);
  const observing = observings.observations.find((item) => item.memoryId.startsWith('OBSERVING:'));
  assert.ok(observing);
  assert.ok(observing.references.length >= 1);
  assert.match(observing.summary, /ui observing prompt|ui observing response/);

  const documentResponse = await app.request(
    `/api/v1/ui/memories/${encodeURIComponent(observing.memoryId)}/document`
  );
  assert.equal(documentResponse.status, 200);
  const document = await json(documentResponse);
  assert.equal(document.document.kind, 'observing');
  assert.match(document.document.markdown, /## Detail/);
  assert.doesNotMatch(document.document.markdown, /## References/);
});

test('ui settings config reads and writes settings.json through sidecar', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNNAI_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '{\n  "provider": "mock"\n}\n', 'utf8');

  const readResponse = await app.request('/api/v1/ui/settings/config');
  assert.equal(readResponse.status, 200);
  const readBody = await json(readResponse);
  assert.equal(readBody.pathLabel, configPath);
  assert.match(readBody.content, /"provider": "mock"/);

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: '{\n  "provider": "live"\n}\n',
    }),
  });
  assert.equal(writeResponse.status, 200);

  const persisted = await readFile(configPath, 'utf8');
  assert.match(persisted, /"provider": "live"/);
});

test('ui settings config returns default watchdog template when settings.json is missing', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNNAI_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });

  const readResponse = await app.request('/api/v1/ui/settings/config');
  assert.equal(readResponse.status, 200);
  const readBody = await json(readResponse);
  assert.equal(readBody.pathLabel, configPath);
  assert.match(readBody.content, /"watchdog": \{/);
  assert.match(readBody.content, /"intervalMs": 60000/);
  assert.match(readBody.content, /"optimizeMergeCount": 4/);
});

test('ui settings config rejects invalid watchdog values server-side', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNNAI_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: JSON.stringify({
        watchdog: {
          intervalMs: 0,
        },
      }, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /watchdog\.intervalMs must be a positive integer/i);
});

test('ui settings config rejects semantic index dimension changes that mismatch existing dataset', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNNAI_HOME = homeDir;
  process.env.MUNNAI_OBSERVE_WINDOW_MS = '10';

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({
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
          dimensions: 4,
        },
        defaultImportance: 0.7,
      },
    }, null, 2)}\n`,
    'utf8',
  );

  const addResponse = await app.request('/api/v1/session/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session: {
        session_id: 'group-a',
        agent: 'agent-a',
        prompt: 'semantic prompt',
        response: 'semantic response',
        summary: 'semantic summary',
      },
    }),
  });
  assert.equal(addResponse.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: JSON.stringify({
        semanticIndex: {
          embedding: {
            provider: 'mock',
            dimensions: 8,
          },
          defaultImportance: 0.7,
        },
      }, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /semantic_index dimension mismatch/i);

  const persisted = await readFile(configPath, 'utf8');
  assert.match(persisted, /"dimensions": 4/);
});
