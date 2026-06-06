import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import core from '@muninn/core';
import { getNativeTables } from '../../core/dist/native.js';
import { serializeTurn } from '../../core/dist/turn/types.js';
import { resetSessionTreeCacheForTests } from '@muninn/board/server';
import { app } from '../dist/app.js';
import { registerMuninnHooks } from '../../../openclaw/plugin/dist/src/hooks.js';

const { shutdownCoreForTests } = core;
const TEST_PROJECT = 'project-a';
const TEST_CWD = '/workspace/project-a';

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

function defaultStorageTarget(homeDir) {
  return { uri: toFileStoreUri(path.join(homeDir, 'main')) };
}

async function json(response) {
  return response.json();
}

function memoryWatermarkResolved(watermark) {
  return watermark.pending.turns.length === 0
    && watermark.pending.extractions.length === 0
    && watermark.phases.extractor === 'idle'
    && watermark.phases.observer === 'idle'
    && !watermark.error;
}

async function waitForWatermarkResolved() {
  let resolvedBody = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app.request('/api/v1/memory/watermark');
    assert.equal(response.status, 200);
    resolvedBody = await json(response);
    if (memoryWatermarkResolved(resolvedBody)) {
      return resolvedBody;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(resolvedBody);
  assert.equal(memoryWatermarkResolved(resolvedBody), true);
  return resolvedBody;
}

function makeTurnContent(overrides = {}) {
  const turn = {
    sessionId: 'group-a',
    project: TEST_PROJECT,
    cwd: TEST_CWD,
    agent: 'agent-a',
    prompt: 'alpha prompt',
    response: 'alpha response',
    ...overrides,
  };
  const events = overrides.events ?? [
    { type: 'userMessage', text: turn.prompt },
    { type: 'assistantMessage', text: turn.response },
  ];
  return {
    ...turn,
    events,
  };
}

async function captureTurn(turn) {
  return app.request('/api/v1/turn/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turn }),
  });
}

function sessionTurnsPath(agent, sessionKey, { cwd = TEST_CWD, offset = 0, limit = 10 } = {}) {
  const params = new URLSearchParams({
    cwd,
    offset: String(offset),
    limit: String(limit),
  });
  return `/api/v1/ui/session/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(sessionKey)}/turns?${params.toString()}`;
}

async function captureTurnAndGetTurn(turn) {
  const response = await captureTurn(turn);
  assert.equal(response.status, 204);
  const listResponse = await app.request('/api/v1/list?mode=recency&limit=20');
  assert.equal(listResponse.status, 200);
  const listed = await json(listResponse);
  const match = listed.memoryHits.find((candidate) => (
    typeof candidate.memoryId === 'string'
    && candidate.memoryId.startsWith('turn:')
    && candidate.content.includes(turn.prompt)
    && candidate.content.includes(turn.response)
  ));
  assert.ok(match);
  return { turnId: match.memoryId };
}

async function benchmarkCaptureTurn(turn) {
  return app.request('/api/v1/benchmark/locomo/turn/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turn }),
  });
}

async function writeMuninnConfig(configPath, {
  turnProvider,
  observerProvider = 'mock',
  semanticDimensions = 4,
  storageUri,
  storageOptions,
  activeWindowDays,
} = {}) {
  const root = {};
  const providers = { llm: {}, embedding: {} };

  if (storageUri) {
    root.storage = { uri: storageUri };
    if (storageOptions) {
      root.storage.storageOptions = storageOptions;
    }
  }

  if (turnProvider) {
    root.turn = { llmProvider: 'test_turn_llm' };
    providers.llm.test_turn_llm = { type: turnProvider };
  }

  if (observerProvider) {
    providers.embedding.default = {
      type: 'mock',
      dimensions: semanticDimensions,
    };
    root.extractor = {
      name: 'test-observer',
      llmProvider: 'test_extractor_llm',
      embeddingProvider: 'default',
      maxAttempts: 3,
      epochTurns: 1,
      ...(activeWindowDays === undefined ? {} : { activeWindowDays }),
    };
    root.observer = {
      name: 'test-observer-curator',
      llmProvider: 'test_observer_llm',
      maxAttempts: 3,
      anchorThreshold: 5,
    };
    providers.llm.test_extractor_llm = { type: observerProvider };
    providers.llm.test_observer_llm = { type: observerProvider };
  }

  if (Object.keys(providers.llm).length > 0 || Object.keys(providers.embedding).length > 0) {
    root.providers = providers;
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
    extractor: {
      name: 'default-extractor',
      llmProvider: 'default_extractor_llm',
      embeddingProvider: 'default',
      recallMode: 'hybrid',
      maxAttempts: 3,
      activeWindowDays,
    },
    observer: {
      name: 'default-observer',
      llmProvider: 'default_observer_llm',
      maxAttempts: 3,
      anchorThreshold: 5,
    },
    providers: {
      llm: {
        default_extractor_llm: {
          type: observerProvider,
        },
        default_observer_llm: {
          type: observerProvider,
        },
      },
      embedding: {
        default: {
          type: 'mock',
          dimensions: semanticDimensions,
        },
      },
    },
  };

  if (turnProvider) {
    config.turn = { llmProvider: 'default_turn_llm' };
    config.providers.llm.default_turn_llm = { type: turnProvider };
  }

  if (includeWatchdog) {
    config.watchdog = {
      enabled: true,
      intervalMs: 60000,
      compactMinFragments: 8,
      extraction: {
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
    events: [
      { type: 'userMessage', text: 'alpha prompt' },
      { type: 'toolCall', name: 'tool-a' },
      { type: 'assistantMessage', text: 'alpha response' },
    ],
    artifacts: [{ key: 'key', kind: 'text', source: 'tool', content: 'value' }],
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

test('openclaw hook capture persists artifacts through sidecar and native readback', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { turnProvider: 'mock' });
  await writeFile(path.join(dir, 'note.txt'), 'artifact body', 'utf8');

  const handlers = new Map();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = typeof url === 'string' ? new URL(url) : new URL(String(url));
    return app.request(target.pathname, {
      method: init?.method ?? 'GET',
      headers: init?.headers,
      body: init?.body,
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  registerMuninnHooks({
    pluginConfig: {
      enabled: true,
      baseUrl: 'http://muninn.test',
      timeoutMs: 1_000,
      recencyLimit: 5,
    },
    logger: {},
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  await handlers.get('after_tool_call')({
    toolName: 'read',
    params: { path: 'note.txt' },
    runId: 'run-1',
    toolCallId: 'tool-1',
    result: 'ok',
  }, {
    runId: 'run-1',
    sessionKey: 'group-a',
    agentId: 'agent-a',
    workspaceDir: dir,
  });

  await handlers.get('agent_end')({
    success: true,
    messages: [
      { role: 'user', content: 'hook prompt' },
      { role: 'assistant', content: [{ type: 'text', text: 'hook response' }] },
    ],
  }, {
    runId: 'run-1',
    sessionKey: 'group-a',
    agentId: 'agent-a',
    workspaceDir: dir,
  });

  const listResponse = await app.request('/api/v1/list?mode=recency&limit=20');
  assert.equal(listResponse.status, 200);
  const listed = await json(listResponse);
  const match = listed.memoryHits.find((candidate) => (
    typeof candidate.memoryId === 'string'
    && candidate.memoryId.startsWith('turn:')
    && candidate.content.includes('hook prompt')
    && candidate.content.includes('hook response')
  ));
  assert.ok(match);

  const tables = await getNativeTables(defaultStorageTarget(homeDir));
  const persisted = await tables.turnTable.getTurn(match.memoryId);
  assert.ok(persisted);
  assert.deepEqual(persisted.events, [
    { type: 'userMessage', text: 'hook prompt' },
    {
      type: 'toolCall',
      id: 'tool-1',
      name: 'read',
      input: '{"path":"note.txt"}',
    },
    {
      type: 'toolOutput',
      id: 'tool-1',
      output: 'ok',
    },
    { type: 'assistantMessage', text: 'hook response' },
  ]);
  assert.deepEqual(persisted.artifacts, [{
    key: 'note.txt',
    kind: 'text',
    source: 'tool',
    content: 'artifact body',
    name: 'note.txt',
    mimeType: 'text/plain',
    sizeBytes: 13,
    uri: null,
  }]);

  const detailResponse = await app.request(
    `/api/v1/detail?memoryId=${encodeURIComponent(match.memoryId)}`
  );
  assert.equal(detailResponse.status, 200);
  const detail = await json(detailResponse);
  assert.equal(detail.memoryHits.length, 1);
  assert.match(detail.memoryHits[0].content, /Artifacts: note\.txt: artifact body/);
});

test('turn/capture accepts typed image and file artifacts', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { turnProvider: 'mock' });

  const addResponse = await captureTurn({
    ...makeTurnContent(),
    artifacts: [
      {
        key: 'prompt-image',
        kind: 'image',
        source: 'prompt',
        uri: 'artifact://abc123.png',
        name: 'shot.png',
        mimeType: 'image/png',
        sizeBytes: 8,
      },
      {
        key: 'import-marker',
        kind: 'metadata',
        source: 'import',
        content: '{"marker":"session#1"}',
      },
    ],
  });
  assert.equal(addResponse.status, 204);

  const listResponse = await app.request(sessionTurnsPath('agent-a', 'group-a'));
  assert.equal(listResponse.status, 200);
  const list = await json(listResponse);
  assert.equal(list.turns.length, 1);

  const detailResponse = await app.request(`/api/v1/ui/memories/${encodeURIComponent(list.turns[0].memoryId)}/document`);
  assert.equal(detailResponse.status, 200);
  const detail = await json(detailResponse);
  assert.match(detail.document.markdown, /prompt-image/);
  assert.match(detail.document.markdown, /shot\.png/);
});

test('ui artifact endpoint serves only artifact store files by hash name', async (t) => {
  const { dir, homeDir } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  const artifactName = 'a'.repeat(64) + '.png';
  const artifactDir = path.join(homeDir, 'default', 'artifacts');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, artifactName), Buffer.from('89504e470d0a1a0a', 'hex'));

  const good = await app.request(`/api/v1/ui/artifacts/${artifactName}`);
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await good.arrayBuffer()), Buffer.from('89504e470d0a1a0a', 'hex'));

  const bad = await app.request('/api/v1/ui/artifacts/not-safe.png');
  assert.equal(bad.status, 400);
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
      { ...makeTurnContent(), events: [] },
      { ...makeTurnContent(), events: [{ type: 'toolCall', name: 123 }] },
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

test('list and timeline cover the written flow, and recall returns indexed memories', async (t) => {
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

  const listResponse = await app.request('/api/v1/list?mode=recency&limit=10');
  assert.equal(listResponse.status, 200);
  const listed = await json(listResponse);
  const turnHits = listed.memoryHits.filter((hit) => /^turn:/.test(hit.memoryId));
  assert.ok(turnHits.length >= 3);
  assert.ok(turnHits.some((hit) => /second alpha prompt/.test(hit.content)));
  assert.ok(turnHits.some((hit) => /third alpha prompt/.test(hit.content)));
  assert.ok(turnHits.some((hit) => /other beta prompt/.test(hit.content)));
  const secondTurnId = turnHits.find((hit) => /second alpha prompt/.test(hit.content))?.memoryId;
  assert.ok(secondTurnId);

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
  assert.ok(recalled.memoryHits.length > 0);
});

test('benchmark locomo capture returns turn id and recall returns body-only hits', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath);

  const captureResponse = await benchmarkCaptureTurn(makeTurnContent({
    sessionId: 'locomo:sample-a:session_1',
    prompt: 'alpha adoption agency prompt',
    response: 'alpha adoption agency response',
  }));
  assert.equal(captureResponse.status, 200);
  const captured = await json(captureResponse);
  assert.match(captured.turn.turnId, /^turn:/);

  const manifest = {
    sample_id: 'sample-a',
    turns: [{
      turn_id: captured.turn.turnId,
      source_id: 'D1:1',
      sample_id: 'sample-a',
      session_id: 'locomo:sample-a:session_1',
      date_time: '1:56 pm on 8 May, 2023',
      import_order: 0,
    }],
  };
  const finalizeResponse = await app.request('/api/v1/memory/finalize', { method: 'POST' });
  assert.equal(finalizeResponse.status, 200);
  await waitForWatermarkResolved();
  const recallResponse = await app.request('/api/v1/benchmark/locomo/recall', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'adoption agency',
      limit: 2,
      recallMode: 'hybrid',
      manifest,
    }),
  });
  assert.equal(recallResponse.status, 200);
  const recalled = await json(recallResponse);
  assert.ok(recalled.hits.length > 0);
  assert.equal(typeof recalled.hits[0].memory_id, 'string');
  assert.match(recalled.hits[0].detail, /adoption agency/);
  assert.equal('evidence_ids' in recalled.hits[0], false);
  assert.equal('references' in recalled.hits[0], false);
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

  const agentTurnsResponse = await app.request(sessionTurnsPath('agent-a', 'group-a'));
  assert.equal(agentTurnsResponse.status, 200);
  const agentTurns = await json(agentTurnsResponse);
  const firstTurnId = agentTurns.turns[0].memoryId;
  const secondTurnId = agentTurns.turns[1].memoryId;

  const otherTurnsResponse = await app.request(sessionTurnsPath('agent-b', 'group-a'));
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
      `/api/v1/timeline?memoryId=${encodeURIComponent('turn:999999')}`
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
      `/api/v1/timeline?memoryId=${encodeURIComponent('turn:999999')}&beforeLimit=1.5`
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

  const currentResponse = await app.request('/api/v1/memory/watermark');
  assert.equal(currentResponse.status, 200);
  const currentBody = await json(currentResponse);
  assert.equal(memoryWatermarkResolved(currentBody), false);
  assert.deepEqual(currentBody.pending.turns, [written.turnId]);

  process.env.MUNINN_OBSERVER_POLL_MS = '1';
  await shutdownCoreForTests();
  const finalizeResponse = await app.request('/api/v1/memory/finalize', { method: 'POST' });
  assert.equal(finalizeResponse.status, 200);

  const resolvedBody = await waitForWatermarkResolved();
  assert.deepEqual(resolvedBody.pending.turns, []);
});

test('detail returns notFound for missing memoryId', async () => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  process.env.MUNINN_HOME = homeDir;

  try {
    await writeMuninnConfig(configPath);

    const missingDetail = await app.request(
      `/api/v1/detail?memoryId=${encodeURIComponent('turn:999999')}`
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
      events: [
        { type: 'userMessage', text: 'document prompt' },
        { type: 'toolCall', name: 'grep' },
        { type: 'toolCall', name: 'sed' },
        { type: 'assistantMessage', text: 'document response' },
      ],
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

  const turnsResponse = await app.request(sessionTurnsPath('openclaw', 'group-a'));
  assert.equal(turnsResponse.status, 200);
  const turnsBody = await json(turnsResponse);
  assert.equal(turnsBody.turns.length, 2);
  assert.equal(turnsBody.turns[0].title, 'first alpha prompt');
  assert.match(turnsBody.turns[0].summary, /alpha/);
  assert.equal(
    sessionsBody.sessions[0].latestUpdatedAt,
    turnsBody.turns.reduce((latest, turn) => turn.updatedAt > latest ? turn.updatedAt : latest, turnsBody.turns[0].updatedAt),
  );

  const documentResponse = await app.request(
    `/api/v1/ui/memories/${encodeURIComponent(turnsBody.turns[0].memoryId)}/document`
  );
  assert.equal(documentResponse.status, 200);
  const documentBody = await json(documentResponse);
  assert.equal(documentBody.document.kind, 'turn');
  assert.match(documentBody.document.markdown, /## Created At/);
  assert.match(documentBody.document.markdown, /first alpha prompt/);

  const codexTurnsResponse = await app.request(sessionTurnsPath('codex_cli', 'group-b'));
  assert.equal(codexTurnsResponse.status, 200);
  const codexTurnsBody = await json(codexTurnsResponse);
  assert.equal(codexTurnsBody.turns.length, 1);
  const codexDocumentResponse = await app.request(
    `/api/v1/ui/memories/${encodeURIComponent(codexTurnsBody.turns[0].memoryId)}/document`
  );
  assert.equal(codexDocumentResponse.status, 200);
  const codexDocumentBody = await json(codexDocumentResponse);
  assert.deepEqual(codexDocumentBody.document.events, [
    { type: 'userMessage', text: 'document prompt' },
    { type: 'toolCall', name: 'grep' },
    { type: 'toolCall', name: 'sed' },
    { type: 'assistantMessage', text: 'document response' },
  ]);
});

test('board search groups conversation results by session and validates scope', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => {
    await shutdownCoreForTests();
    await rm(dir, { recursive: true, force: true });
  });
  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, {
    storageUri: defaultStorageTarget(homeDir).uri,
    observerProvider: undefined,
  });

  await captureTurn(makeTurnContent({
    sessionId: 'muninn/search-alpha',
    agent: 'codex_cli',
    prompt: 'board search should group by session',
    response: 'Search uses Session Top N and Top N controls.',
  }));
  await captureTurn(makeTurnContent({
    sessionId: 'lance/search-beta',
    agent: 'codex_cli',
    prompt: 'board search should also find this',
    response: 'This result belongs to a different project.',
  }));

  const response = await app.request('/api/v1/ui/search?query=board%20search&projectKey=muninn&sessionTopN=1&topN=10');
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.match(body.answer.text, /Based on the context/);
  assert.equal(body.answer.citations.length, 1);
  assert.equal(body.answer.citations[0].sessionKey, 'muninn/search-alpha');
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].projectKey, 'muninn');
  assert.equal(body.results[0].sessionKey, 'muninn/search-alpha');
  assert.equal(body.results[0].items.length, 1);
  assert.equal(body.results[0].items[0].source, 'conversation');

  const sessionScope = await app.request('/api/v1/ui/search?query=board&sessionKey=muninn%2Fsearch-alpha');
  assert.equal(sessionScope.status, 200);
  const sessionScopeBody = await json(sessionScope);
  assert.equal(sessionScopeBody.results.length, 1);
  assert.equal(sessionScopeBody.results[0].sessionKey, 'muninn/search-alpha');
});

test('ui session endpoints include native rows with indexed ownership fields', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => {
    await shutdownCoreForTests();
    resetSessionTreeCacheForTests();
    await rm(dir, { recursive: true, force: true });
  });

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { turnProvider: 'mock' });
  resetSessionTreeCacheForTests();

  const tables = await getNativeTables(defaultStorageTarget(homeDir));
  await tables.turnTable.insert({
    turns: [serializeTurn({
      turnId: 'turn:18446744073709551615',
      createdAt: '2026-06-03T01:00:00.000Z',
      updatedAt: '2026-06-03T01:01:00.000Z',
      sessionId: 'group-native',
      project: TEST_PROJECT,
      cwd: TEST_CWD,
      agent: 'agent-a',
      observer: 'default',
      title: 'historical default prompt',
      summary: 'historical default prompt historical default response',
      events: [
        { type: 'userMessage', text: 'historical default prompt' },
        { type: 'assistantMessage', text: 'historical default response' },
      ],
      artifacts: null,
      prompt: 'historical default prompt',
      response: 'historical default response',
    })],
  });

  const sessionsResponse = await app.request('/api/v1/ui/session/agents/agent-a/sessions');
  assert.equal(sessionsResponse.status, 200);
  const sessionsBody = await json(sessionsResponse);
  assert.equal(sessionsBody.sessions.length, 1);
  assert.equal(sessionsBody.sessions[0].sessionKey, 'group-native');
  assert.equal(sessionsBody.sessions[0].projectKey, TEST_PROJECT);
  assert.equal(sessionsBody.sessions[0].cwd, TEST_CWD);

  const turnsResponse = await app.request(
    sessionTurnsPath('agent-a', 'group-native')
  );
  assert.equal(turnsResponse.status, 200);
  const turnsBody = await json(turnsResponse);
  assert.equal(turnsBody.turns.length, 1);
  assert.equal(turnsBody.turns[0].prompt, 'historical default prompt');
});

test('ui session endpoints expose session index writes immediately', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { turnProvider: 'mock' });
  resetSessionTreeCacheForTests();

  const first = await app.request('/api/v1/ui/session/agents');
  assert.equal(first.status, 200);
  const firstBody = await json(first);
  assert.equal(firstBody.agents.length, 0);

  const second = await app.request('/api/v1/ui/session/agents');
  assert.equal(second.status, 200);
  const secondBody = await json(second);
  assert.equal(secondBody.agents.length, 0);

  const groups = await app.request('/api/v1/ui/session/agents/openclaw/sessions');
  assert.equal(groups.status, 200);
  const groupsBody = await json(groups);
  assert.equal(groupsBody.sessions.length, 0);

  const addResponse = await captureTurn(makeTurnContent({
    sessionId: 'group-a',
    agent: 'openclaw',
    prompt: 'invalidate cache',
    response: 'invalidate cache response',
  }));
  assert.equal(addResponse.status, 204);

  const third = await app.request('/api/v1/ui/session/agents');
  assert.equal(third.status, 200);
  const thirdBody = await json(third);
  assert.deepEqual(thirdBody.agents.map((agent) => agent.agent), ['openclaw']);

  const updatedGroups = await app.request('/api/v1/ui/session/agents/openclaw/sessions');
  assert.equal(updatedGroups.status, 200);
  const updatedGroupsBody = await json(updatedGroups);
  assert.equal(updatedGroupsBody.sessions.length, 1);
  assert.equal(updatedGroupsBody.sessions[0].sessionKey, 'group-a');
  assert.equal(updatedGroupsBody.sessions[0].cwd, TEST_CWD);
});

test('session snapshots are readable through list/detail/timeline', async (t) => {
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
  const snapshotHit = listed.memoryHits.find((hit) => hit.memoryId.startsWith('session:'));
  assert.ok(snapshotHit);
  assert.match(snapshotHit.content, /## Summary|## Detail/);
  assert.match(snapshotHit.content, /observe this prompt|observe this response/);

  const detailResponse = await app.request(
    `/api/v1/detail?memoryId=${encodeURIComponent(snapshotHit.memoryId)}`
  );
  assert.equal(detailResponse.status, 200);
  const detail = await json(detailResponse);
  assert.equal(detail.memoryHits.length, 1);
  assert.equal(detail.memoryHits[0].memoryId, snapshotHit.memoryId);
  assert.match(detail.memoryHits[0].content, /## Detail/);

  const timelineResponse = await app.request(
    `/api/v1/timeline?memoryId=${encodeURIComponent(snapshotHit.memoryId)}&beforeLimit=1&afterLimit=1`
  );
  assert.equal(timelineResponse.status, 200);
  const timeline = await json(timelineResponse);
  assert.equal(timeline.memoryHits.length, 1);
  assert.equal(timeline.memoryHits[0].memoryId, snapshotHit.memoryId);

});

test('ui session snapshots endpoint returns live session snapshots and documents', async (t) => {
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

  const snapshotsResponse = await app.request('/api/v1/ui/session-snapshots');
  assert.equal(snapshotsResponse.status, 200);
  const snapshots = await json(snapshotsResponse);
  assert.ok(snapshots.sessionSnapshots.length >= 1);
  const snapshot = snapshots.sessionSnapshots.find((item) => item.memoryId.startsWith('session:'));
  assert.ok(snapshot);
  assert.ok(snapshot.references.length >= 1);
  assert.match(snapshot.summary, /Default session memory thread for session group-ui/);

  const documentResponse = await app.request(
    `/api/v1/ui/memories/${encodeURIComponent(snapshot.memoryId)}/document`
  );
  assert.equal(documentResponse.status, 200);
  const document = await json(documentResponse);
  assert.equal(document.document.kind, 'session');
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
  assert.equal(readBody.validationError, undefined);

  const updatedConfig = createValidSettings({ includeWatchdog: true });
  updatedConfig.observer.name = 'live-observer';
  updatedConfig.extractor.recallMode = 'fts';
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
  assert.match(persisted, /"recallMode": "fts"/);
  assert.doesNotMatch(persisted, /"defaultImportance"/);
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
  assert.match(persisted, /"embeddingProvider": "default"/);
  assert.equal(Object.hasOwn(JSON.parse(persisted), 'extraction'), false);
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
  assert.equal(readBody.validationError, undefined);
  assert.match(readBody.content, /"name": "default-observer"/);
  assert.match(readBody.content, /"providers": \{/);
  assert.match(readBody.content, /"llmProvider": "default"/);
  assert.match(readBody.content, /"activeWindowDays": 7/);
  assert.match(readBody.content, /"embeddingProvider": "default"/);
  assert.equal(Object.hasOwn(JSON.parse(readBody.content), 'extraction'), false);
  assert.doesNotMatch(readBody.content, /"defaultImportance"/);
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
  assert.match(persisted, /"providers": \{/);
  assert.match(persisted, /"llmProvider": "default"/);
  assert.match(persisted, /"embeddingProvider": "default"/);
});

test('ui settings config reports validation errors on read without replacing content', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  const invalidConfig = createValidSettings();
  delete invalidConfig.extractor.embeddingProvider;
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(invalidConfig, null, 2)}\n`, 'utf8');

  const readResponse = await app.request('/api/v1/ui/settings/config');
  assert.equal(readResponse.status, 200);
  const readBody = await json(readResponse);
  assert.equal(readBody.pathLabel, configPath);
  assert.match(readBody.content, /"default-extractor"/);
  assert.doesNotMatch(readBody.content, /"embeddingProvider"/);
  assert.match(readBody.validationError, /extractor\.embeddingProvider must be a non-empty string/i);
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

test('ui settings config rejects invalid extractor.activeWindowDays server-side', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });
  const config = createValidSettings({ includeWatchdog: true });
  config.extractor.activeWindowDays = 0;

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
  assert.match(body.errorMessage, /extractor\.activeWindowDays must be a positive integer/i);
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

test('ui settings config rejects missing providers config', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });
  const config = createValidSettings();
  delete config.providers;

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
  assert.match(body.errorMessage, /providers is required/i);
});

test('ui settings config rejects top-level extraction config', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });
  const config = createValidSettings();
  config.extraction = { embeddingProvider: 'default' };

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
  assert.match(body.errorMessage, /extraction is no longer supported/i);
});

test('ui settings config rejects missing extractor.embeddingProvider config', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });
  const config = createValidSettings();
  delete config.extractor.embeddingProvider;

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
  assert.match(body.errorMessage, /extractor\.embeddingProvider must be a non-empty string/i);
});

test('ui settings config accepts omitted providers.embedding dimensions when the default runtime dimensions apply', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });
  const config = createValidSettings();
  delete config.providers.embedding.default.dimensions;

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
        ...createValidSettings(),
        providers: {
          ...createValidSettings().providers,
          embedding: {
            default: {
              type: 'mock',
            },
          },
        },
      }, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /extraction dimension mismatch/i);
});

test('ui settings config rejects providers.embedding type when it is empty', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: JSON.stringify({
        ...createValidSettings(),
        providers: {
          ...createValidSettings().providers,
          embedding: {
            default: {
              type: '',
            },
          },
        },
      }, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /providers\.embedding\.default\.type must be a non-empty string/i);
});

test('ui settings config rejects openai observer llm without apiKey', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });
  const config = createValidSettings({ observerProvider: 'openai' });
  config.providers.llm.default_extractor_llm.type = 'mock';
  delete config.providers.llm.default_observer_llm.apiKey;

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
  assert.match(body.errorMessage, /providers\.llm\.default_observer_llm\.apiKey must be a non-empty string/i);
});

test('ui settings config rejects openai semantic embeddings without apiKey', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });
  const config = createValidSettings();
  config.providers.embedding.default.type = 'openai';
  delete config.providers.embedding.default.apiKey;

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
  assert.match(body.errorMessage, /providers\.embedding\.default\.apiKey must be a non-empty string/i);
});

test('ui settings config rejects observer config without observer.llmProvider', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: JSON.stringify({
        ...createValidSettings(),
        observer: {
          name: 'test-observer',
        },
      }, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /observer\.llmProvider must be a non-empty string/i);
});

test('ui settings config rejects referenced llm entries without type', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });

  const writeResponse = await app.request('/api/v1/ui/settings/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: JSON.stringify({
        ...createValidSettings(),
        observer: {
          name: 'test-observer',
          llmProvider: 'test_observer_llm',
        },
        providers: {
          llm: {
            test_observer_llm: {},
          },
          embedding: createValidSettings().providers.embedding,
        },
      }, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /providers\.llm\.test_observer_llm\.type must be a non-empty string/i);
});

test('ui settings config rejects semantic index dimension changes that mismatch existing dataset', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({
      extractor: {
        name: 'test-extractor',
        llmProvider: 'test_extractor_llm',
        embeddingProvider: 'default',
        maxAttempts: 3,
        epochTurns: 1,
      },
      observer: {
        name: 'test-observer',
        llmProvider: 'test_observer_llm',
        maxAttempts: 3,
      },
      providers: {
        llm: {
          test_extractor_llm: {
            type: 'mock',
          },
          test_observer_llm: {
            type: 'mock',
          },
        },
        embedding: {
          default: {
            type: 'mock',
            dimensions: 4,
          },
        },
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
        ...createValidSettings(),
        providers: {
          ...createValidSettings().providers,
          embedding: {
            default: {
              type: 'mock',
              dimensions: 8,
            },
          },
        },
      }, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /extraction dimension mismatch/i);

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
        ...createValidSettings(),
        storage: {
          uri: toFileStoreUri(storageB),
        },
        providers: {
          ...createValidSettings().providers,
          embedding: {
            default: {
              type: 'mock',
              dimensions: 8,
            },
          },
        },
      }, null, 2),
    }),
  });
  assert.equal(writeResponse.status, 400);
  const body = await json(writeResponse);
  assert.equal(body.errorCode, 'invalidRequest');
  assert.match(body.errorMessage, /extraction dimension mismatch/i);

  const persisted = await readFile(configPath, 'utf8');
  assert.match(persisted, new RegExp(`"uri":\\s*"${toFileStoreUri(storageA)}"`));
});
