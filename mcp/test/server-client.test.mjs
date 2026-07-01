import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ServerClient } from '../dist/server-client.js';

test('ServerClient defaults to live managed server URL', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-mcp-client-'));
  await mkdir(path.join(home, 'run'), { recursive: true });
  await writeFile(path.join(home, 'run', 'server.json'), JSON.stringify({
    pid: process.pid,
    host: '0.0.0.0',
    port: 52423,
  }));
  const previousEnv = {
    MUNINN_HOME: process.env.MUNINN_HOME,
    MUNINN_SERVER_BASE_URL: process.env.MUNINN_SERVER_BASE_URL,
    MUNINN_BASE_URL: process.env.MUNINN_BASE_URL,
  };
  process.env.MUNINN_HOME = home;
  delete process.env.MUNINN_SERVER_BASE_URL;
  delete process.env.MUNINN_BASE_URL;
  t.after(() => {
    restoreEnv('MUNINN_HOME', previousEnv.MUNINN_HOME);
    restoreEnv('MUNINN_SERVER_BASE_URL', previousEnv.MUNINN_SERVER_BASE_URL);
    restoreEnv('MUNINN_BASE_URL', previousEnv.MUNINN_BASE_URL);
  });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    requests.push(String(input));
    return {
      ok: true,
      status: 200,
      async text() {
        return 'ok';
      },
    };
  });

  const client = new ServerClient();
  await client.recall({ query: 'capture marker' });

  assert.deepEqual(requests, ['http://127.0.0.1:52423/api/v1/mcp/recall']);
});

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
