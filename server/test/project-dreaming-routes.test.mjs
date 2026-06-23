import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import core from '../dist/backend.js';
import { app } from '../dist/http.js';

test('GET /api/v1/dreaming/project requires project', async () => {
  const response = await app.request('/api/v1/dreaming/project');
  assert.equal(response.status, 400);
});

test('GET /app/api/dreaming/project requires project', async () => {
  const response = await app.request('/app/api/dreaming/project');
  assert.equal(response.status, 400);
});

test('GET /app/api/dreaming/projects returns an empty project list for an empty database', async (t) => {
  const previousHome = process.env.MUNINN_HOME;
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-dreaming-projects-route-'));
  const database = `dreaming-projects-empty-${process.pid}-${Date.now()}`;
  process.env.MUNINN_HOME = home;
  t.after(async () => {
    await core.shutdownCoreForTests();
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  });

  const response = await app.request(`/app/api/dreaming/projects?database=${database}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.projects, []);
  assert.equal(typeof body.requestId, 'string');
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
