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
