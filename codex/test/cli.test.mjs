import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { muninnSessionKey } from '@muninn/common/session-identity';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliPath = path.join(repoRoot, 'codex', 'dist', 'cli.js');

test('codex hook CLI uses --server-url for capture endpoint', async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    request.setEncoding('utf8');
    for await (const chunk of request) {
      body += chunk;
    }
    requests.push({ url: request.url, method: request.method, body });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await listen(server);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const transcriptPath = await writeTranscript();

    const result = await runHook([
      '--server-url',
      `http://127.0.0.1:${address.port}`,
    ], {
      hook_event_name: 'Stop',
      transcript_path: transcriptPath,
    });

    assert.equal(result.code, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/api/v1/turn/capture');
  } finally {
    await close(server);
  }
});

test('codex hook CLI reads server URL from hook sidecar config', async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    request.setEncoding('utf8');
    for await (const chunk of request) {
      body += chunk;
    }
    requests.push({ url: request.url, method: request.method, body });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await listen(server);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const transcriptPath = await writeTranscript();
    const configPath = path.join(path.dirname(transcriptPath), 'muninn-hook.json');
    await writeFile(configPath, JSON.stringify({
      serverUrl: `http://127.0.0.1:${address.port}`,
    }));

    const result = await runHook([], {
      hook_event_name: 'Stop',
      transcript_path: transcriptPath,
    }, {
      MUNINN_CODEX_HOOK_CONFIG: configPath,
    });

    assert.equal(result.code, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/api/v1/turn/capture');
  } finally {
    await close(server);
  }
});

async function writeTranscript() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-codex-cli-'));
  process.env.MUNINN_HOME = path.join(root, 'muninn-home');
  await mkdir(process.env.MUNINN_HOME, { recursive: true });
  const transcriptPath = path.join(root, 'rollout-2026-06-24-cli-session.jsonl');
  const lines = [
    { type: 'session_meta', payload: { id: 'cli-session', cwd: root, timestamp: '2026-06-24T01:00:00.000Z' } },
    { type: 'response_item', timestamp: '2026-06-24T01:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'capture me' }] } },
    { type: 'response_item', timestamp: '2026-06-24T01:00:02.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'captured' }] } },
  ];
  await writeFile(transcriptPath, lines.map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(path.join(process.env.MUNINN_HOME, 'capture.json'), JSON.stringify({
    capture: {
      sessions: {
        [muninnSessionKey({ project: root, agent: 'codex', sessionId: 'cli-session' })]: true,
      },
    },
  }));
  return transcriptPath;
}

function runHook(args, payload, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        MUNINN_SERVER_BASE_URL: 'http://127.0.0.1:1',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
