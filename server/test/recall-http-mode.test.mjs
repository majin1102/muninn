import assert from 'node:assert/strict';
import test from 'node:test';

import core from '../dist/backend.js';
import { app } from '../dist/http.js';

const { shutdownCoreForTests } = core;

async function json(response) {
  return response.json();
}

test.afterEach(async () => {
  await shutdownCoreForTests();
});

test('recall routes reject obsolete and extraction-only mode options before backend lookup', async () => {
  const obsoleteResponse = await app.request('/api/v1/recall?query=alpha&recallMode=hybrid');
  assert.equal(obsoleteResponse.status, 400);
  assert.match((await json(obsoleteResponse)).errorMessage, /recallMode is no longer supported/);

  const invalidModeResponse = await app.request('/api/v1/recall?query=alpha&mode=hybrid');
  assert.equal(invalidModeResponse.status, 400);
  assert.equal((await json(invalidModeResponse)).errorMessage, 'mode must be one of: session, extraction');

  const sessionBudgetResponse = await app.request('/api/v1/recall?query=alpha&mode=session&budget=0');
  assert.equal(sessionBudgetResponse.status, 400);
  assert.equal(
    (await json(sessionBudgetResponse)).errorMessage,
    'budget, queryLimit, and thinkingRatio are only supported in extraction recall mode',
  );

  const locomoObsoleteResponse = await app.request('/api/v1/benchmark/locomo/recall', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'alpha', recallMode: 'hybrid' }),
  });
  assert.equal(locomoObsoleteResponse.status, 400);
  assert.match((await json(locomoObsoleteResponse)).errorMessage, /recallMode is no longer supported/);

  const locomoSessionBudgetResponse = await app.request('/api/v1/benchmark/locomo/recall', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'alpha', mode: 'session', budget: 0 }),
  });
  assert.equal(locomoSessionBudgetResponse.status, 400);
  assert.equal(
    (await json(locomoSessionBudgetResponse)).errorMessage,
    'budget, queryLimit, and thinkingRatio are only supported in extraction recall mode',
  );
});
