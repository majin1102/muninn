import test from 'node:test';
import assert from 'node:assert/strict';

import { app } from '../dist/http.js';

test('GET /api/v1/dreaming/project requires project', async () => {
  const response = await app.request('/api/v1/dreaming/project');
  assert.equal(response.status, 400);
});

test('GET /api/v1/dreaming/project/signals requires project', async () => {
  const response = await app.request('/api/v1/dreaming/project/signals');
  assert.equal(response.status, 400);
});

test('POST /api/v1/dreaming/project requires project', async () => {
  const response = await app.request('/api/v1/dreaming/project', { method: 'POST' });
  assert.equal(response.status, 400);
});

test('POST /api/v1/dreaming/project rejects malformed JSON', async () => {
  const response = await app.request('/api/v1/dreaming/project?project=/repo/muninn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).errorCode, 'invalidRequest');
});

test('GET /api/v1/dreaming/project maps backend errors to JSON errors', async () => {
  const response = await app.request('/api/v1/dreaming/project?project=/repo/muninn&database=..');
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.errorCode, 'invalidRequest');
  assert.equal(typeof body.requestId, 'string');
});
