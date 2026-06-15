import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { app } from '../dist/http.js';

test.afterEach(() => {
  delete process.env.MUNINN_DESKTOP_TOKEN;
});

test('desktop token protects api routes when configured', async () => {
  process.env.MUNINN_DESKTOP_TOKEN = 'desktop-secret';

  const missing = await app.request('/app/api/recall/providers');
  assert.equal(missing.status, 401);

  const wrong = await app.request('/app/api/recall/providers', {
    headers: { authorization: 'Bearer wrong-secret' },
  });
  assert.equal(wrong.status, 401);
});

test('desktop token allows api routes with matching bearer token', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-desktop-auth-'));
  const previousHome = process.env.MUNINN_HOME;
  process.env.MUNINN_DESKTOP_TOKEN = 'desktop-secret';
  process.env.MUNINN_HOME = home;
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
  }, null, 2), 'utf8');

  try {
    const response = await app.request('/app/api/recall/providers', {
      headers: { authorization: 'Bearer desktop-secret' },
    });
    assert.equal(response.status, 200);
  } finally {
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});
