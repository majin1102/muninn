import assert from 'node:assert/strict';
import test from 'node:test';

import { app } from '../dist/http.js';

test('POST /api/v1/startup/recent requires cwd', async () => {
  const response = await app.request('/api/v1/startup/recent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).errorCode, 'invalidRequest');
});

test('POST /api/v1/startup/recent rejects malformed JSON and unsupported fields', async () => {
  const malformed = await app.request('/api/v1/startup/recent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);

  const unsupported = await app.request('/api/v1/startup/recent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp', budget: 100 }),
  });
  assert.equal(unsupported.status, 400);
});

test('POST /api/v1/startup/recent rejects a missing directory', async () => {
  const response = await app.request('/api/v1/startup/recent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: `/tmp/muninn-missing-${process.pid}-${Date.now()}` }),
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).errorCode, 'invalidRequest');
});
