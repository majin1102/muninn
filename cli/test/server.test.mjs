import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { checkHealth, resolveHealthHost, resolveServerProcessPaths, startManagedServer } from '../dist/server.js';

test('resolveServerProcessPaths keeps CLI-managed state under Muninn home', () => {
  const paths = resolveServerProcessPaths('/tmp/muninn-home');
  assert.deepEqual(paths, {
    runDir: path.join('/tmp/muninn-home', 'run'),
    stateFile: path.join('/tmp/muninn-home', 'run', 'server.json'),
    stdoutLog: path.join('/tmp/muninn-home', 'run', 'server.stdout.log'),
    stderrLog: path.join('/tmp/muninn-home', 'run', 'server.stderr.log'),
  });
});

test('checkHealth probes wildcard bind addresses through local loopback without proxy agent', async (t) => {
  assert.equal(resolveHealthHost('0.0.0.0'), '127.0.0.1');
  assert.equal(resolveHealthHost('::'), '::1');
  assert.equal(resolveHealthHost('127.0.0.1'), '127.0.0.1');

  const calls = [];
  t.mock.method(http, 'get', (options, callback) => {
    calls.push(options);
    const response = new EventEmitter();
    response.statusCode = 200;
    response.resume = () => {};

    const request = new EventEmitter();
    request.destroy = (error) => {
      request.emit('error', error);
    };

    queueMicrotask(() => {
      callback(response);
    });
    return request;
  });

  assert.equal(await checkHealth('0.0.0.0', 8080), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].host, '127.0.0.1');
  assert.equal(calls[0].agent, false);
});

test('startManagedServer cleans up spawned child when health wait fails', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'muninn-cli-server-'));
  const home = path.join(tempDir, 'home');
  const childPidFile = path.join(tempDir, 'child.pid');
  const entryPath = path.join(tempDir, 'fake-cli.mjs');

  await writeFile(entryPath, [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(process.env.MUNINN_TEST_CHILD_PID_FILE, String(process.pid));",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));

  const previousPidFile = process.env.MUNINN_TEST_CHILD_PID_FILE;
  process.env.MUNINN_TEST_CHILD_PID_FILE = childPidFile;
  try {
    await assert.rejects(
      startManagedServer({
        host: '127.0.0.1',
        port: 9,
        home,
        startTimeoutMs: 150,
      }, entryPath),
      /did not become healthy/,
    );

    const childPid = Number(await readFile(childPidFile, 'utf8'));
    await waitUntil(() => !isProcessAlive(childPid), 2_000);
    assert.equal(isProcessAlive(childPid), false);
  } finally {
    if (previousPidFile === undefined) {
      delete process.env.MUNINN_TEST_CHILD_PID_FILE;
    } else {
      process.env.MUNINN_TEST_CHILD_PID_FILE = previousPidFile;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}
