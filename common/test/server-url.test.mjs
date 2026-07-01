import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveMuninnServerBaseUrl } from '../dist/server-url.js';

test('resolveMuninnServerBaseUrl prefers explicit env URL', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-server-url-'));
  assert.equal(resolveMuninnServerBaseUrl({
    home,
    env: {
      MUNINN_SERVER_BASE_URL: 'http://127.0.0.1:9000///',
    },
  }), 'http://127.0.0.1:9000');
});

test('resolveMuninnServerBaseUrl reads live managed server state', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-server-url-'));
  await mkdir(path.join(home, 'run'), { recursive: true });
  await writeFile(path.join(home, 'run', 'server.json'), JSON.stringify({
    pid: process.pid,
    host: '0.0.0.0',
    port: 52423,
    home,
    startedAt: '2026-06-27T09:00:00.000Z',
  }));

  assert.equal(resolveMuninnServerBaseUrl({ home, env: {} }), 'http://127.0.0.1:52423');
});

test('resolveMuninnServerBaseUrl ignores stale managed server state and reads muninn config', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-server-url-'));
  await mkdir(path.join(home, 'run'), { recursive: true });
  await writeFile(path.join(home, 'run', 'server.json'), JSON.stringify({
    pid: 999999999,
    host: '0.0.0.0',
    port: 52423,
  }));
  await writeFile(path.join(home, 'muninn.json'), JSON.stringify({
    server: {
      host: '0.0.0.0',
      port: 61234,
    },
  }));

  assert.equal(resolveMuninnServerBaseUrl({ home, env: {} }), 'http://127.0.0.1:61234');
});
