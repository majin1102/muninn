import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
    { prompt: '$muninn-capture +1', response: ENABLE_MARKER },
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
      async deleteSession() {
        throw new Error('deleteSession should not run for enable marker');
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
});

test('captureFromTranscript advances progress for marker-only enable turn', async (t) => {
  const { home, transcriptPath } = await writeAgentSession([
    { prompt: '$muninn-capture +1', response: ENABLE_MARKER },
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

test('captureFromTranscript does not advance progress when marker capture fails', async (t) => {
  const { home, transcriptPath } = await writeAgentSession([
    { prompt: 'remember this', response: 'noted' },
    { prompt: '$muninn-capture +1', response: ENABLE_MARKER },
  ]);
  setMuninnHome(t, home);

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
    },
  });

  const sessionKey = muninnSessionKey({ project: 'github.com/example/muninn', sessionId: 'session-a', agent: 'codex' });
  const policy = JSON.parse(await readFile(path.join(home, 'capture.json'), 'utf8'));
  const progress = JSON.parse(await readFile(path.join(home, 'progress.json'), 'utf8'));
  assert.equal(ok, false);
  assert.equal(policy.capture.sessions[sessionKey], true);
  assert.equal(progress.sessions[sessionKey], undefined);
});

test('captureFromTranscript disables current session capture from marker and deletes session', async (t) => {
  const { home, transcriptPath } = await writeAgentSession([
    { prompt: 'remember this', response: 'noted' },
    { prompt: '$muninn-capture -1', response: DISABLE_MARKER },
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
