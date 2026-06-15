import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import core, { sessions, turns } from '../dist/backend.js';
import { app } from '../dist/http.js';
import { getCapturePolicy, setCaptureEnabled } from '../dist/api/capture.js';

const { shutdownCoreForTests } = core;
const PROJECT = 'github.com/muninn/e2e-fixture';

async function writeTestConfig(home) {
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'muninn.json'), JSON.stringify({
    extractor: {
      name: 'default',
      llmProvider: 'mock',
      embeddingProvider: 'mock',
    },
    observer: {
      name: 'default',
      llmProvider: 'mock',
    },
    providers: {
      llm: {
        mock: {
          type: 'mock',
        },
      },
      embedding: {
        mock: {
          type: 'mock',
          dimensions: 4,
        },
      },
    },
  }, null, 2));
}

function makeTurn(sessionId, sequence, prompt) {
  return {
    sessionId,
    agent: 'codex',
    project: PROJECT,
    cwd: '/tmp/muninn-e2e-project',
    prompt,
    response: `${prompt} response`,
    createdAt: `2026-06-14T10:0${sequence}:00.000Z`,
    turnSequence: sequence,
    events: [
      { type: 'userMessage', text: prompt },
      { type: 'assistantMessage', text: `${prompt} response` },
    ],
    metadata: {
      ingest: 'codex-import',
    },
  };
}

async function capture(turn) {
  const response = await app.request('/api/v1/turn/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turn }),
  });
  assert.equal(response.status, 204);
}

test('delete imported session removes only one session and keeps project capture policy', async (t) => {
  const previousHome = process.env.MUNINN_HOME;
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-delete-session-'));
  process.env.MUNINN_HOME = home;
  await writeTestConfig(home);
  t.after(async () => {
    await shutdownCoreForTests();
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
  });

  await capture(makeTurn('e2e-delete-session-a', 0, 'keep this session'));
  await capture(makeTurn('e2e-delete-session-b', 0, 'delete this session'));
  await setCaptureEnabled('codex', PROJECT, true);

  const response = await app.request('/app/api/import/codex/session', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: PROJECT, sessionId: 'e2e-delete-session-b' }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.deletedSessions, 1);
  assert.equal(body.deletedTurns, 1);
  assert.match(body.requestId, /^req_/);

  const indexed = await sessions.index();
  assert.ok(indexed.some((entry) => entry.sessionId === 'e2e-delete-session-a'));
  assert.ok(!indexed.some((entry) => entry.sessionId === 'e2e-delete-session-b'));

  const remainingTurns = await turns.list({ mode: { type: 'page', offset: 0, limit: 100 }, agent: 'codex' });
  assert.ok(remainingTurns.some((entry) => entry.sessionId === 'e2e-delete-session-a'));
  assert.ok(!remainingTurns.some((entry) => entry.sessionId === 'e2e-delete-session-b'));

  const policy = await getCapturePolicy('codex');
  assert.equal(policy[PROJECT], true);
});
