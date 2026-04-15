import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import core from '@muninn/core';
import {
  getSessionTreeLoadCountForTests,
  resetSessionTreeCacheForTests,
} from '@muninn/board/server';
import { app } from '../dist/app.js';

const { shutdownCoreForTests } = core;

async function makeDatasetUri() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-format-test-'));
  return {
    dir,
    homeDir: path.join(dir, 'muninn'),
    configPath: path.join(dir, 'muninn', 'muninn.json'),
  };
}

function toFileStoreUri(dir) {
  return `file-object-store://${path.resolve(dir)}`;
}

async function json(response) {
  return response.json();
}

function makeTurnContent(overrides = {}) {
  return {
    sessionId: 'group-a',
    agent: 'agent-a',
    prompt: 'alpha prompt',
    response: 'alpha response',
    ...overrides,
  };
}

async function captureTurn(turn) {
  return app.request('/api/v1/turn/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turn }),
  });
}

async function captureTurnAndGetTurn(turn) {
  const response = await captureTurn(turn);
  assert.equal(response.status, 204);
  const listResponse = await app.request('/api/v1/list?mode=recency&limit=20');
  assert.equal(listResponse.status, 200);
  const listed = await json(listResponse);
  const match = listed.memoryHits.find((candidate) => (
    typeof candidate.memoryId === 'string'
    && candidate.memoryId.startsWith('session:')
    && candidate.content.includes(turn.prompt)
    && candidate.content.includes(turn.response)
  ));
  assert.ok(match);
  return { turnId: match.memoryId };
}

async function writeMuninnConfig(configPath, {
  turnProvider,
  observerProvider = 'openai',
  semanticDimensions = 4,
  storageUri,
  storageOptions,
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
    root.semanticIndex = {
      embedding: {
        provider: 'mock',
        dimensions: semanticDimensions,
      },
      defaultImportance: 0.7,
    };
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

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
}

function createValidSettings({
  turnProvider,
  observerProvider = 'mock',
  semanticDimensions = 8,
  includeWatchdog = false,
  activeWindowDays = 7,
} = {}) {
  const config = {
    observer: {
      name: 'default-observer',
      llm: 'default_observer_llm',
      maxAttempts: 3,
      activeWindowDays,
    },
    llm: {
      default_observer_llm: {
        provider: observerProvider,
      },
    },
    semanticIndex: {
      embedding: {
        provider: 'mock',
        dimensions: semanticDimensions,
      },
      defaultImportance: 0.7,
    },
  };

  if (turnProvider) {
    config.turn = { llm: 'default_turn_llm' };
    config.llm.default_turn_llm = { provider: turnProvider };
  }

  if (includeWatchdog) {
    config.watchdog = {
      enabled: true,
      intervalMs: 60000,
      compactMinFragments: 8,
      semanticIndex: {
        targetPartitionSize: 1024,
        optimizeMergeCount: 4,
      },
    };
  }

  return config;
}

test.afterEach(async () => {
  await shutdownCoreForTests();
  resetSessionTreeCacheForTests();
  delete process.env.MUNINN_HOME;
  delete process.env.MUNINN_OBSERVER_POLL_MS;
});

test('turn/capture writes a complete turn and detail reads it back', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { turnProvider: 'mock' });

  const addedTurn = await captureTurnAndGetTurn(makeTurnContent({
    toolCalls: [{ name: 'tool-a' }],
    artifacts: [{ key: 'key', content: 'value' }],
  }));

  const detailResponse = await app.request(
    `/api/v1/detail?memoryId=${encodeURIComponent(addedTurn.turnId)}`
  );
  assert.equal(detailResponse.status, 200);
  const detail = await json(detailResponse);
  assert.equal(detail.memoryHits.length, 1);
  assert.equal(detail.memoryHits[0].memoryId, addedTurn.turnId);
  assert.match(detail.memoryHits[0].content, /## Title/);
  assert.match(detail.memoryHits[0].content, /alpha prompt/);
  assert.match(detail.memoryHits[0].content, /## Created At/);
  assert.match(detail.memoryHits[0].content, /## Summary/);
  assert.match(detail.memoryHits[0].content, /## Detail/);
  assert.match(detail.memoryHits[0].content, /alpha prompt/);
  assert.match(detail.memoryHits[0].content, /alpha response/);
});

test('turn/capture rejects legacy snake_case turn fields', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { turnProvider: 'mock' });

  const addResponse = await captureTurn({
    session_id: 'group-a',
    agent: 'agent-a',
    prompt: 'legacy prompt',
    response: 'legacy response',
    tool_calling: ['tool-a'],
  });
  assert.equal(addResponse.status, 400);
  const body = await json(addResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /unexpected fields: session_id, tool_calling/i);
});

test('turn/capture validates request shape and requires a complete turn', async () => {
  const { dir, homeDir } = await makeDatasetUri();
  process.env.MUNINN_HOME = homeDir;
  
  try {
    const response = await captureTurn({
      ...makeTurnContent(),
      sessionId: 123,
    });
    assert.equal(response.status, 400);
    const body = await json(response);
    assert.equal(body.errorCode, 'invalidRequest');

    for (const badTurn of [
      { ...makeTurnContent(), sessionId: '' },
      { ...makeTurnContent(), sessionId: '   ' },
      { ...makeTurnContent(), agent: '' },
      { ...makeTurnContent(), prompt: '   ' },
      { ...makeTurnContent(), response: '' },
      { ...makeTurnContent(), toolCalls: 'tool-a' },
      { ...makeTurnContent(), toolCalls: [{ name: 123 }] },
      { ...makeTurnContent(), artifacts: { key: 'artifact', content: 'value' } },
      { ...makeTurnContent(), artifacts: [{ key: 'artifact', content: 1 }] },
      { ...makeTurnContent(), observer: 'unexpected' },
    ]) {
      const invalidResponse = await captureTurn(badTurn);
      assert.equal(invalidResponse.status, 400);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('turn/capture rejects incomplete turns', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { turnProvider: 'mock' });

  for (const turn of [
    { ...makeTurnContent(), response: undefined },
    { ...makeTurnContent(), prompt: undefined },
    { ...makeTurnContent(), sessionId: undefined },
    { ...makeTurnContent(), agent: undefined },
  ]) {
    const response = await captureTurn(turn);
    assert.equal(response.status, 400);
  }
});

test('turn/capture requires sessionId and does not accept omitted default sessions', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { turnProvider: 'mock' });

  const first = await captureTurn({
    agent: 'agent-a',
    prompt: 'default-session prompt',
    response: 'default-session response',
  });
  assert.equal(first.status, 400);

  const body = await json(first);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /turn\.sessionId is required/i);
});

test('list and timeline cover the written flow, and recall is empty when observing work does not index memories', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath);

  for (const payload of [
    makeTurnContent({ prompt: 'first alpha prompt', response: 'first alpha response' }),
    makeTurnContent({ prompt: 'second alpha prompt', response: 'second alpha response' }),
    makeTurnContent({ prompt: 'third alpha prompt', response: 'third alpha response' }),
    makeTurnContent({
      sessionId: 'group-b',
      agent: 'agent-b',
      prompt: 'other beta prompt',
      response: 'other beta response',
    }),
  ]) {
    const response = await captureTurn(payload);
    assert.equal(response.status, 204);
  }

  const listResponse = await app.request('/api/v1/list?mode=recency&limit=3');
  assert.equal(listResponse.status, 200);
  const listed = await json(listResponse);
  assert.equal(listed.memoryHits.length, 3);
  assert.match(listed.memoryHits[0].memoryId, /^session:/);
  assert.match(listed.memoryHits[0].content, /second alpha prompt/);
  assert.match(listed.memoryHits[1].content, /third alpha prompt/);
  assert.match(listed.memoryHits[2].content, /other beta prompt/);
  const secondTurnId = listed.memoryHits[0].memoryId;

  const timelineResponse = await app.request(
    `/api/v1/timeline?memoryId=${encodeURIComponent(secondTurnId)}&beforeLimit=1&afterLimit=1`
  );
  assert.equal(timelineResponse.status, 200);
  const timeline = await json(timelineResponse);
  assert.equal(timeline.memoryHits.length, 3);
  assert.equal(timeline.memoryHits[1].memoryId, secondTurnId);

  const recallResponse = await app.request('/api/v1/recall?query=alpha&limit=2');
  assert.equal(recallResponse.status, 200);
  const recalled = await json(recallResponse);
  assert.equal(recalled.memoryHits.length, 0);
});

test('timeline stays scoped to the full session key when agents share a sessionId', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath);

  for (const turn of [
    makeTurnContent({
      prompt: 'agent a prompt 1',
      response: 'agent a response 1',
    }),
    makeTurnContent({
      agent: 'agent-b',
      prompt: 'agent b prompt',
      response: 'agent b response',
    }),
    makeTurnContent({
      prompt: 'agent a prompt 2',
      response: 'agent a response 2',
    }),
  ]) {
    const response = await captureTurn(turn);
    assert.equal(response.status, 204);
  }

  const agentTurnsResponse = await app.request('/api/v1/ui/session/agents/agent-a/sessions/group-a/turns?offset=0&limit=10');
  assert.equal(agentTurnsResponse.status, 200);
  const agentTurns = await json(agentTurnsResponse);
  const firstTurnId = agentTurns.turns[1].memoryId;
  const secondTurnId = agentTurns.turns[0].memoryId;

  const otherTurnsResponse = await app.request('/api/v1/ui/session/agents/agent-b/sessions/group-a/turns?offset=0&limit=10');
  assert.equal(otherTurnsResponse.status, 200);
  const otherTurns = await json(otherTurnsResponse);
  const otherAgentTurnId = otherTurns.turns[0].memoryId;

  const timelineResponse = await app.request(
    `/api/v1/timeline?memoryId=${encodeURIComponent(secondTurnId)}&beforeLimit=1&afterLimit=1`
  );
  assert.equal(timelineResponse.status, 200);
  const timeline = await json(timelineResponse);
  const memoryIds = timeline.memoryHits.map((hit) => hit.memoryId);
  assert.deepEqual(memoryIds, [
    firstTurnId,
    secondTurnId,
  ]);
  assert.ok(!memoryIds.includes(otherAgentTurnId));
});

test('recall and timeline surface request and not-found errors', async () => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  process.env.MUNINN_HOME = homeDir;
  
  try {
    await writeMuninnConfig(configPath);

    const missingQuery = await app.request('/api/v1/recall');
    assert.equal(missingQuery.status, 400);

    const missingTimeline = await app.request(
      `/api/v1/timeline?memoryId=${encodeURIComponent('session:999999')}`
    );
    assert.equal(missingTimeline.status, 404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recall, list, and timeline reject invalid numeric query parameters', async () => {
  const { dir, homeDir } = await makeDatasetUri();
  process.env.MUNINN_HOME = homeDir;

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
      `/api/v1/timeline?memoryId=${encodeURIComponent('session:999999')}&beforeLimit=1.5`
    );
    assert.equal(badTimeline.status, 400);
    const badTimelineBody = await json(badTimeline);
    assert.equal(badTimelineBody.errorCode, 'invalidRequest');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detail and timeline map invalid memoryId inputs to invalidRequest', async () => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  process.env.MUNINN_HOME = homeDir;
  
  try {
    await writeMuninnConfig(configPath);

    const badDetail = await app.request('/api/v1/detail?memoryId=bad');
    assert.equal(badDetail.status, 400);
    const badDetailBody = await json(badDetail);
    assert.equal(badDetailBody.errorCode, 'invalidRequest');

    const wrongLayerTimeline = await app.request(
      `/api/v1/timeline?memoryId=${encodeURIComponent('thinking:42')}`
    );
    assert.equal(wrongLayerTimeline.status, 400);
    const wrongLayerBody = await json(wrongLayerTimeline);
    assert.equal(wrongLayerBody.errorCode, 'invalidRequest');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('observer watermark reports pending turns until the observer flush completes', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  process.env.MUNINN_OBSERVER_POLL_MS = '60000';
  await writeMuninnConfig(configPath, { observerProvider: 'mock' });

  const written = await captureTurnAndGetTurn(makeTurnContent({
    prompt: 'watermark prompt',
    response: 'watermark response',
  }));

  const currentResponse = await app.request('/api/v1/observer/watermark');
  assert.equal(currentResponse.status, 200);
  const currentBody = await json(currentResponse);
  assert.equal(currentBody.resolved, false);
  assert.deepEqual(currentBody.pendingTurnIds, [written.turnId]);

  process.env.MUNINN_OBSERVER_POLL_MS = '1';
  await shutdownCoreForTests();

  let resolvedBody = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const resolvedResponse = await app.request('/api/v1/observer/watermark');
    assert.equal(resolvedResponse.status, 200);
    resolvedBody = await json(resolvedResponse);
    if (resolvedBody.resolved) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(resolvedBody);
  assert.equal(resolvedBody.resolved, true);
  assert.deepEqual(resolvedBody.pendingTurnIds, []);
});

test('detail returns notFound for missing observing memoryId', async () => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  process.env.MUNINN_HOME = homeDir;

  try {
    await writeMuninnConfig(configPath);

    const missingDetail = await app.request(
      `/api/v1/detail?memoryId=${encodeURIComponent('observing:999999')}`
    );
    assert.equal(missingDetail.status, 404);
    const missingDetailBody = await json(missingDetail);
    assert.equal(missingDetailBody.errorCode, 'notFound');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('turn/capture accepts complete turns when turn summarization is not configured', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath);

  const created = await captureTurnAndGetTurn(makeTurnContent({
    prompt: 'response prompt',
    response: 'response only',
  }));
  const detailResponse = await app.request(
    `/api/v1/detail?memoryId=${encodeURIComponent(created.turnId)}`
  );
  assert.equal(detailResponse.status, 200);
  const detail = await json(detailResponse);
  assert.equal(detail.memoryHits.length, 1);
  assert.match(detail.memoryHits[0].content, /## Summary/);
  assert.match(detail.memoryHits[0].content, /## Detail/);
  assert.match(detail.memoryHits[0].content, /response prompt/);
  assert.match(detail.memoryHits[0].content, /response only/);
});

test('ui session endpoints group by agent/session and return rendered turn documents', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { turnProvider: 'mock' });

  const payloads = [
    makeTurnContent({
      sessionId: 'group-a',
      agent: 'openclaw',
      prompt: 'first alpha prompt',
      response: 'first alpha response',
    }),
    makeTurnContent({
      sessionId: 'group-a',
      agent: 'openclaw',
      prompt: 'second alpha prompt',
      response: 'second alpha response',
    }),
    makeTurnContent({
      sessionId: 'group-b',
      agent: 'codex_cli',
      prompt: 'codex prompt',
      response: 'codex response',
      toolCalls: [{ name: 'grep' }, { name: 'sed' }],
    }),
  ];

  for (const turn of payloads) {
    const response = await captureTurn(turn);
    assert.equal(response.status, 204);
  }

  const agentsResponse = await app.request('/api/v1/ui/session/agents');
  assert.equal(agentsResponse.status, 200);
  const agentsBody = await json(agentsResponse);
  assert.equal(agentsBody.agents.length, 2);
  assert.deepEqual(
    agentsBody.agents.map((agent) => agent.agent).sort(),
    ['codex_cli', 'openclaw'],
  );

  const sessionsResponse = await app.request('/api/v1/ui/session/agents/openclaw/sessions');
  assert.equal(sessionsResponse.status, 200);
  const sessionsBody = await json(sessionsResponse);
  assert.equal(sessionsBody.sessions.length, 1);
  assert.equal(sessionsBody.sessions[0].displaySessionId, 'group-a');

  const ungroupedResponse = await app.request('/api/v1/ui/session/agents/codex_cli/sessions');
  assert.equal(ungroupedResponse.status, 200);
  const ungroupedBody = await json(ungroupedResponse);
  assert.equal(ungroupedBody.sessions.length, 1);
  assert.equal(ungroupedBody.sessions[0].displaySessionId, 'group-b');

  const turnsResponse = await app.request('/api/v1/ui/session/agents/openclaw/sessions/group-a/turns?offset=0&limit=10');
  assert.equal(turnsResponse.status, 200);
  const turnsBody = await json(turnsResponse);
  assert.equal(turnsBody.turns.length, 2);
  assert.equal(turnsBody.turns[0].title, 'second alpha prompt');
  assert.match(turnsBody.turns[0].summary, /alpha/);

  const documentResponse = await app.request(
    `/api/v1/ui/memories/${encodeURIComponent(turnsBody.turns[1].memoryId)}/document`
  );
  assert.equal(documentResponse.status, 200);
  const documentBody = await json(documentResponse);
  assert.equal(documentBody.document.kind, 'session');
  assert.match(documentBody.document.markdown, /## Created At/);
  assert.match(documentBody.document.markdown, /first alpha prompt/);
});

test('ui session endpoints reuse the cached session tree until a write invalidates it', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { turnProvider: 'mock' });
  resetSessionTreeCacheForTests();

  const first = await app.request('/api/v1/ui/session/agents');
  assert.equal(first.status, 200);
  assert.equal(getSessionTreeLoadCountForTests(), 1);

  const second = await app.request('/api/v1/ui/session/agents');
  assert.equal(second.status, 200);
  assert.equal(getSessionTreeLoadCountForTests(), 1);

  const groups = await app.request('/api/v1/ui/session/agents/openclaw/sessions');
  assert.equal(groups.status, 200);
  assert.equal(getSessionTreeLoadCountForTests(), 1);

  const addResponse = await captureTurn(makeTurnContent({
    sessionId: 'group-a',
    agent: 'openclaw',
    prompt: 'invalidate cache',
    response: 'invalidate cache response',
  }));
  assert.equal(addResponse.status, 204);

  const third = await app.request('/api/v1/ui/session/agents');
  assert.equal(third.status, 200);
  assert.equal(getSessionTreeLoadCountForTests(), 2);
});

test('observing memories are readable through list/detail/timeline/recall', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { turnProvider: 'mock', observerProvider: 'mock' });

  const addResponse = await captureTurn(makeTurnContent({
    prompt: 'observe this prompt',
    response: 'observe this response',
  }));
  assert.equal(addResponse.status, 204);

  await new Promise((resolve) => setTimeout(resolve, 50));

  const listResponse = await app.request('/api/v1/list?mode=recency&limit=10');
  assert.equal(listResponse.status, 200);
  const listed = await json(listResponse);
  const observingHit = listed.memoryHits.find((hit) => hit.memoryId.startsWith('observing:'));
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

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { turnProvider: 'mock', observerProvider: 'mock' });

  const addResponse = await captureTurn(makeTurnContent({
    sessionId: 'group-ui',
    agent: 'agent-ui',
    prompt: 'ui observing prompt',
    response: 'ui observing response',
  }));
  assert.equal(addResponse.status, 204);

  await new Promise((resolve) => setTimeout(resolve, 50));

  const observingsResponse = await app.request('/api/v1/ui/observing');
  assert.equal(observingsResponse.status, 200);
  const observings = await json(observingsResponse);
  assert.ok(observings.observations.length >= 1);
  const observing = observings.observations.find((item) => item.memoryId.startsWith('observing:'));
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

test('ui settings config reads and writes muninn.json through sidecar', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  const initialConfig = createValidSettings();
  initialConfig.observer.name = 'test-observer';

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, 'utf8');

  const readResponse = await app.request('/api/v1/ui/settings/config');
  assert.equal(readResponse.status, 200);
  const readBody = await json(readResponse);
  assert.equal(readBody.pathLabel, configPath);
  assert.match(readBody.content, /"name": "test-observer"/);

  const updatedConfig = createValidSettings({ includeWatchdog: true });
  updatedConfig.observer.name = 'live-observer';
  updatedConfig.semanticIndex.defaultImportance = 0.5;
  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: JSON.stringify(updatedConfig, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 200);

  const persisted = await readFile(configPath, 'utf8');
  assert.match(persisted, /"name": "live-observer"/);
  assert.match(persisted, /"defaultImportance": 0.5/);
});

test('ui settings config creates the parent directory on first save', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  const content = JSON.stringify(createValidSettings({ includeWatchdog: true }), null, 2);
  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content,
    }),
  });
  assert.equal(writeResponse.status, 200);

  const persisted = await readFile(configPath, 'utf8');
  assert.match(persisted, /"observer"/);
  assert.match(persisted, /"semanticIndex"/);
  assert.match(persisted, /"watchdog"/);
});

test('ui settings config returns a saveable default template when muninn.json is missing', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });

  const readResponse = await app.request('/api/v1/ui/settings/config');
  assert.equal(readResponse.status, 200);
  const readBody = await json(readResponse);
  assert.equal(readBody.pathLabel, configPath);
  assert.match(readBody.content, /"name": "default-observer"/);
  assert.match(readBody.content, /"default_observer_llm"/);
  assert.match(readBody.content, /"activeWindowDays": 7/);
  assert.match(readBody.content, /"semanticIndex": \{/);
  assert.match(readBody.content, /"dimensions": 8/);
  assert.match(readBody.content, /"watchdog": \{/);
  assert.match(readBody.content, /"intervalMs": 60000/);
  assert.match(readBody.content, /"optimizeMergeCount": 4/);

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: readBody.content,
    }),
  });
  assert.equal(writeResponse.status, 200);

  const persisted = await readFile(configPath, 'utf8');
  assert.match(persisted, /"default_observer_llm"/);
});

test('ui settings config rejects invalid watchdog values server-side', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });
  const config = createValidSettings({ includeWatchdog: true });
  config.watchdog.intervalMs = 0;

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: JSON.stringify(config, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /watchdog\.intervalMs must be a positive integer/i);
});

test('ui settings config rejects invalid observer.activeWindowDays server-side', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });
  const config = createValidSettings({ includeWatchdog: true });
  config.observer.activeWindowDays = 0;

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: JSON.stringify(config, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /observer\.activeWindowDays must be a positive integer/i);
});

test('ui settings config reports invalid JSON before native storage initialization', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '{\n  "storage": {\n    "uri": ""\n  }\n}\n', 'utf8');

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: '{"watchdog": ',
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /invalid JSON/i);
});

test('ui settings config rejects missing observer config', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });
  const config = createValidSettings();
  delete config.observer;

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: JSON.stringify(config, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /observer is required/i);
});

test('ui settings config rejects missing llm config', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });
  const config = createValidSettings();
  delete config.llm;

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: JSON.stringify(config, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /llm is required/i);
});

test('ui settings config rejects missing semanticIndex config', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });
  const config = createValidSettings();
  delete config.semanticIndex;

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: JSON.stringify(config, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /semanticIndex is required/i);
});

test('ui settings config rejects missing semanticIndex.embedding config', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });
  const config = createValidSettings();
  delete config.semanticIndex.embedding;

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: JSON.stringify(config, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /semanticIndex\.embedding is required/i);
});

test('ui settings config accepts omitted semanticIndex.embedding.dimensions when the default runtime dimensions apply', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });
  const config = createValidSettings();
  delete config.semanticIndex.embedding.dimensions;

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: JSON.stringify(config, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 200);
});

test('ui settings config rejects omitted semantic dimensions for an existing non-default table', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await writeMuninnConfig(configPath, {
    observerProvider: 'mock',
    semanticDimensions: 4,
  });

  const addResponse = await captureTurn(makeTurnContent({
    prompt: 'semantic prompt',
    response: 'semantic response',
  }));
  assert.equal(addResponse.status, 204);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: JSON.stringify({
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
      }, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /semantic_index dimension mismatch/i);
});

test('ui settings config rejects semanticIndex.embedding.provider when it is empty', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: JSON.stringify({
        semanticIndex: {
          embedding: {
            provider: '',
          },
        },
      }, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /semanticIndex\.embedding\.provider must be a non-empty string/i);
});

test('ui settings config rejects openai observer llm without apiKey', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });
  const config = createValidSettings({ observerProvider: 'openai' });
  delete config.llm.default_observer_llm.apiKey;

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: JSON.stringify(config, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /llm\.default_observer_llm\.apiKey must be a non-empty string/i);
});

test('ui settings config rejects openai semantic embeddings without apiKey', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });
  const config = createValidSettings();
  config.semanticIndex.embedding.provider = 'openai';
  delete config.semanticIndex.embedding.apiKey;

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: JSON.stringify(config, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /semanticIndex\.embedding\.apiKey must be a non-empty string/i);
});

test('ui settings config rejects observer config without observer.llm', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: JSON.stringify({
        observer: {
          name: 'test-observer',
        },
      }, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /observer\.llm must be a non-empty string/i);
});

test('ui settings config rejects referenced llm entries without provider', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: JSON.stringify({
        observer: {
          name: 'test-observer',
          llm: 'test_observer_llm',
        },
        llm: {
          test_observer_llm: {},
        },
      }, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /llm\.test_observer_llm\.provider must be a non-empty string/i);
});

test('ui settings config rejects semantic index dimension changes that mismatch existing dataset', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

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

  const addResponse = await captureTurn(makeTurnContent({
    prompt: 'semantic prompt',
    response: 'semantic response',
  }));
  assert.equal(addResponse.status, 204);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: JSON.stringify({
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

test('ui settings config validates semantic dimensions against the pending storage target', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  const storageA = path.join(dir, 'storage-a');
  const storageB = path.join(dir, 'storage-b');

  await writeMuninnConfig(configPath, {
    observerProvider: 'mock',
    storageUri: toFileStoreUri(storageB),
  });

  const addResponse = await captureTurn(makeTurnContent({
    sessionId: 'group-b',
    agent: 'agent-b',
    prompt: 'storage b prompt',
    response: 'storage b response',
  }));
  assert.equal(addResponse.status, 204);
  await new Promise((resolve) => setTimeout(resolve, 50));

  await shutdownCoreForTests();

  await writeMuninnConfig(configPath, {
    observerProvider: 'mock',
    storageUri: toFileStoreUri(storageA),
  });

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: JSON.stringify({
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
      }, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /semantic_index dimension mismatch/i);

  const persisted = await readFile(configPath, 'utf8');
  assert.match(persisted, new RegExp(`"uri":\\s*"${toFileStoreUri(storageA)}"`));
});
