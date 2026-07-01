import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureFromTranscript, resolveHookConfig } from '../dist/agent-hook.js';
import { muninnSessionKey } from '../dist/session-identity.js';

const ENABLE_MARKER = '<MUNINN_CAPTURE_CURRENT_SESSION action="enable" nonce="muninn-capture-v1" />';
const DISABLE_MARKER = '<MUNINN_CAPTURE_CURRENT_SESSION action="disable" nonce="muninn-capture-v1" />';

test('hook config reads server base URL and trims trailing slashes', () => {
  const config = resolveHookConfig({
    MUNINN_SERVER_BASE_URL: 'http://127.0.0.1:9000///',
  });

  assert.equal(config.baseUrl, 'http://127.0.0.1:9000');
});

test('hook config falls back to live managed server state', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-hook-config-'));
  await mkdir(path.join(home, 'run'), { recursive: true });
  await writeFile(path.join(home, 'run', 'server.json'), JSON.stringify({
    pid: process.pid,
    host: '0.0.0.0',
    port: 52423,
    home,
    startedAt: '2026-06-27T09:00:00.000Z',
  }));
  setMuninnHome(t, home);

  const config = resolveHookConfig({});

  assert.equal(config.baseUrl, 'http://127.0.0.1:52423');
});

test('captureFromTranscript enables current session capture from marker and captures prior turns', async (t) => {
  const { home, transcriptPath } = await writeAgentSession([
    { prompt: 'remember this', response: 'noted' },
    { prompt: '$remember-session', response: ENABLE_MARKER },
  ]);
  setMuninnHome(t, home);
  const captured = [];
  let finalized = 0;

  const ok = await captureFromTranscript({
    transcriptPath,
    readSession,
    toTurnContent,
    toTurnOptions: { agent: 'codex', ingest: 'codex-hook' },
    label: 'test-hook',
    client: {
      async captureTurn(request) {
        captured.push(request.turn);
        return true;
      },
      async deleteSession() {
        throw new Error('deleteSession should not run for enable marker');
      },
      async finalizeMemory() {
        finalized += 1;
        return true;
      },
    },
  });

  const sessionKey = muninnSessionKey({ project: 'github.com/example/muninn', sessionId: 'session-a', agent: 'codex' });
  const policy = JSON.parse(await readFile(path.join(home, 'capture.json'), 'utf8'));
  const progress = JSON.parse(await readFile(path.join(home, 'progress.json'), 'utf8'));
  assert.equal(ok, true);
  assert.equal(policy.capture.sessions[sessionKey], true);
  assert.equal(progress.sessions[sessionKey].nextTurnSequence, 2);
  assert.deepEqual(captured.map((turn) => [turn.prompt, turn.response, turn.turnSequence]), [
    ['remember this', 'noted', 0],
  ]);
  assert.equal(finalized, 1);
});

test('captureFromTranscript advances progress for marker-only enable turn', async (t) => {
  const { home, transcriptPath } = await writeAgentSession([
    { prompt: '$remember-session', response: ENABLE_MARKER },
  ]);
  setMuninnHome(t, home);
  const captured = [];

  const ok = await captureFromTranscript({
    transcriptPath,
    readSession,
    toTurnContent,
    toTurnOptions: { agent: 'codex', ingest: 'codex-hook' },
    label: 'test-hook',
    client: {
      async captureTurn(request) {
        captured.push(request.turn);
        return true;
      },
    },
  });

  const sessionKey = muninnSessionKey({ project: 'github.com/example/muninn', sessionId: 'session-a', agent: 'codex' });
  const progress = JSON.parse(await readFile(path.join(home, 'progress.json'), 'utf8'));
  assert.equal(ok, true);
  assert.deepEqual(captured, []);
  assert.equal(progress.sessions[sessionKey].nextTurnSequence, 1);
});

test('captureFromTranscript enables current session capture without replaying cached turns', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-agent-hook-incremental-'));
  const home = path.join(root, 'home');
  const transcriptPath = path.join(root, 'session.jsonl');
  const sessionKey = muninnSessionKey({ project: 'github.com/example/muninn', sessionId: 'session-a', agent: 'codex' });
  const capturedPrefix = [
    JSON.stringify({ type: 'session_meta', payload: { id: 'session-a', cwd: '/workspace/muninn', timestamp: '2026-06-10T03:00:00.000Z' } }),
    JSON.stringify({ type: 'turn', prompt: 'already captured', response: 'done', promptTimestamp: '2026-06-10T03:00:01.000Z', responseTimestamp: '2026-06-10T03:00:02.000Z' }),
    '',
  ].join('\n');
  await writeFile(transcriptPath, capturedPrefix);
  const cachedInfo = await stat(transcriptPath);
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'progress.json'), JSON.stringify({
    sessions: {
      [sessionKey]: {
        agent: 'codex',
        project: 'github.com/example/muninn',
        cwd: '/workspace/muninn',
        sessionId: 'session-a',
        transcriptPath,
        updatedAt: '2026-06-10T03:00:00.000Z',
        dev: cachedInfo.dev,
        ino: cachedInfo.ino,
        size: cachedInfo.size,
        mtimeMs: cachedInfo.mtimeMs,
        tailHash: sha256(capturedPrefix),
        lastByteOffset: cachedInfo.size,
        nextTurnSequence: 1,
      },
    },
  }));
  await writeFile(transcriptPath, `${capturedPrefix}${JSON.stringify({
    type: 'turn',
    prompt: '$remember-session',
    response: ENABLE_MARKER,
    promptTimestamp: '2026-06-10T03:01:01.000Z',
    responseTimestamp: '2026-06-10T03:01:02.000Z',
  })}\n`);
  setMuninnHome(t, home);
  const captured = [];

  const ok = await captureFromTranscript({
    transcriptPath,
    readSession: readJsonlSession,
    toTurnContent,
    toTurnOptions: { agent: 'codex', ingest: 'codex-hook' },
    label: 'test-hook',
    client: {
      async captureTurn(request) {
        captured.push(request.turn);
        return true;
      },
    },
  });

  const policy = JSON.parse(await readFile(path.join(home, 'capture.json'), 'utf8'));
  const progress = JSON.parse(await readFile(path.join(home, 'progress.json'), 'utf8'));
  assert.equal(ok, true);
  assert.equal(policy.capture.sessions[sessionKey], true);
  assert.deepEqual(captured, []);
  assert.equal(progress.sessions[sessionKey].nextTurnSequence, 2);
});

test('captureFromTranscript does not advance progress when marker capture fails', async (t) => {
  const { home, transcriptPath } = await writeAgentSession([
    { prompt: 'remember this', response: 'noted' },
    { prompt: '$remember-session', response: ENABLE_MARKER },
  ]);
  setMuninnHome(t, home);
  let finalized = 0;

  const ok = await captureFromTranscript({
    transcriptPath,
    readSession,
    toTurnContent,
    toTurnOptions: { agent: 'codex', ingest: 'codex-hook' },
    label: 'test-hook',
    client: {
      async captureTurn() {
        return false;
      },
      async finalizeMemory() {
        finalized += 1;
        return true;
      },
    },
  });

  const sessionKey = muninnSessionKey({ project: 'github.com/example/muninn', sessionId: 'session-a', agent: 'codex' });
  const policy = JSON.parse(await readFile(path.join(home, 'capture.json'), 'utf8'));
  assert.equal(ok, false);
  assert.equal(policy.capture.sessions[sessionKey], true);
  assert.equal(finalized, 0);
  await assert.rejects(() => readFile(path.join(home, 'progress.json'), 'utf8'));
});

test('captureFromTranscript disables current session capture from marker and deletes session', async (t) => {
  const { home, transcriptPath } = await writeAgentSession([
    { prompt: 'remember this', response: 'noted' },
    { prompt: '$forget-session', response: DISABLE_MARKER },
  ]);
  setMuninnHome(t, home);
  const sessionKey = muninnSessionKey({ project: 'github.com/example/muninn', sessionId: 'session-a', agent: 'codex' });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'capture.json'), JSON.stringify({
    capture: { sessions: { [sessionKey]: true } },
  }));
  await writeFile(path.join(home, 'progress.json'), JSON.stringify({
    sessions: {
      [sessionKey]: {
        agent: 'codex',
        project: 'github.com/example/muninn',
        cwd: '/workspace/muninn',
        sessionId: 'session-a',
        transcriptPath,
        updatedAt: '2026-06-10T03:00:00.000Z',
        dev: 1,
        ino: 1,
        size: 1,
        mtimeMs: 1,
        tailHash: 'old',
        lastByteOffset: 1,
        nextTurnSequence: 1,
      },
    },
  }));
  const captured = [];
  const deleted = [];

  const ok = await captureFromTranscript({
    transcriptPath,
    readSession,
    toTurnContent,
    toTurnOptions: { agent: 'codex', ingest: 'codex-hook' },
    label: 'test-hook',
    client: {
      async captureTurn(request) {
        captured.push(request.turn);
        return true;
      },
      async deleteSession(identity) {
        deleted.push(identity);
        return true;
      },
    },
  });

  const policy = JSON.parse(await readFile(path.join(home, 'capture.json'), 'utf8'));
  const progress = JSON.parse(await readFile(path.join(home, 'progress.json'), 'utf8'));
  assert.equal(ok, false);
  assert.equal(policy.capture.sessions[sessionKey], false);
  assert.equal(progress.sessions[sessionKey], undefined);
  assert.deepEqual(captured, []);
  assert.deepEqual(deleted, [{ project: 'github.com/example/muninn', sessionId: 'session-a', agent: 'codex' }]);
});

test('captureFromTranscript ignores malformed capture marker text', async (t) => {
  const { home, transcriptPath } = await writeAgentSession([
    { prompt: 'normal', response: `prefix ${ENABLE_MARKER}` },
  ]);
  setMuninnHome(t, home);
  const captured = [];

  const ok = await captureFromTranscript({
    transcriptPath,
    readSession,
    toTurnContent,
    toTurnOptions: { agent: 'codex', ingest: 'codex-hook' },
    label: 'test-hook',
    client: {
      async captureTurn(request) {
        captured.push(request.turn);
        return true;
      },
    },
  });

  assert.equal(ok, false);
  assert.deepEqual(captured, []);
  await assert.rejects(() => readFile(path.join(home, 'capture.json'), 'utf8'));
});

function setMuninnHome(t, home) {
  const previousHome = process.env.MUNINN_HOME;
  process.env.MUNINN_HOME = home;
  t.after(() => {
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
  });
}

async function writeAgentSession(turns) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-agent-hook-'));
  const home = path.join(root, 'home');
  const transcriptPath = path.join(root, 'session.json');
  await writeFile(transcriptPath, JSON.stringify({
    sessionId: 'session-a',
    cwd: '/workspace/muninn',
    project: 'github.com/example/muninn',
    sourcePath: transcriptPath,
    updatedAt: '2026-06-10T03:00:00.000Z',
    turns: turns.map((turn, index) => ({
      prompt: turn.prompt,
      response: turn.response,
      promptTimestamp: `2026-06-10T03:0${index}:01.000Z`,
      responseTimestamp: `2026-06-10T03:0${index}:02.000Z`,
    })),
  }));
  return { home, transcriptPath };
}

async function readSession(sourcePath) {
  return JSON.parse(await readFile(sourcePath, 'utf8'));
}

async function readJsonlSession(sourcePath) {
  const session = {
    sessionId: 'session-a',
    cwd: '/workspace/muninn',
    project: 'github.com/example/muninn',
    sourcePath,
    updatedAt: '2026-06-10T03:00:00.000Z',
    turns: [],
  };
  const lines = (await readFile(sourcePath, 'utf8')).split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const line of lines) {
    const record = JSON.parse(line);
    if (record.type === 'session_meta') {
      session.sessionId = record.payload?.id ?? session.sessionId;
      session.cwd = record.payload?.cwd ?? session.cwd;
      session.updatedAt = record.payload?.timestamp ?? session.updatedAt;
      continue;
    }
    if (record.type === 'turn') {
      session.turns.push({
        prompt: record.prompt,
        response: record.response,
        promptTimestamp: record.promptTimestamp,
        responseTimestamp: record.responseTimestamp,
      });
    }
  }
  return session;
}

function toTurnContent(session, turn, index, options) {
  return {
    sessionId: session.sessionId,
    project: session.project,
    cwd: session.cwd,
    agent: options.agent,
    metadata: { ingest: options.ingest },
    createdAt: turn.promptTimestamp,
    updatedAt: turn.responseTimestamp,
    turnSequence: index,
    events: [
      { type: 'userMessage', text: turn.prompt, timestamp: turn.promptTimestamp },
      { type: 'assistantMessage', text: turn.response, timestamp: turn.responseTimestamp },
    ],
    prompt: turn.prompt,
    response: turn.response,
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
