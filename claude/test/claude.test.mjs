import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { captureFromTranscript } from '@muninn/common/agent-hook';
import { muninnSessionKey } from '@muninn/common/session-identity';
import { CLAUDE_AGENT, CLAUDE_MARKER_KEY, readClaudeSession, readClaudeSessionSummary, toTurnContent } from '../dist/claude.js';

const execFileAsync = promisify(execFile);
const LEGACY_SEQUENCE_KEY = 'source' + 'TurnSequence';
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

const META = { cwd: '/Users/dev/workspace/muninn', sessionId: '0aba-claude-session' };
const TRANSCRIPT = [
  { type: 'user', ...META, timestamp: '2026-06-10T03:00:01.000Z', message: { role: 'user', content: 'list the files' } },
  { type: 'assistant', ...META, timestamp: '2026-06-10T03:00:02.000Z', message: { role: 'assistant', content: [
    { type: 'text', text: 'Let me look.' },
    { type: 'tool_use', id: 'tu1', name: 'bash', input: { command: 'ls' } },
  ] } },
  { type: 'user', ...META, timestamp: '2026-06-10T03:00:03.000Z', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'tu1', content: [
      { type: 'text', text: 'README.md' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1x1 } },
    ] },
  ] } },
  { type: 'assistant', ...META, timestamp: '2026-06-10T03:00:04.000Z', message: { role: 'assistant', content: [
    { type: 'text', text: 'There is one file: README.md' },
  ] } },
  // sidechain entry must be ignored
  { type: 'assistant', ...META, isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent noise' }] } },
];

async function writeFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-import-'));
  process.env.MUNINN_HOME = path.join(dir, 'muninn-home');
  const file = path.join(dir, '0aba-claude-session.jsonl');
  await writeFile(file, TRANSCRIPT.map((line) => JSON.stringify(line)).join('\n'));
  return { file, artifactStore: path.join(dir, 'artifacts') };
}

function claudeTurnLines(sessionId, cwd, turns) {
  const lines = [];
  for (const [index, turn] of turns.entries()) {
    const minute = String(index).padStart(2, '0');
    lines.push(
      { type: 'user', sessionId, cwd, timestamp: `2026-06-10T04:${minute}:01.000Z`, message: { role: 'user', content: turn.prompt } },
      { type: 'assistant', sessionId, cwd, timestamp: `2026-06-10T04:${minute}:02.000Z`, message: { role: 'assistant', content: [{ type: 'text', text: turn.response }] } },
    );
  }
  return lines;
}

async function writeClaudeTranscript(dir, sessionId, cwd, turns) {
  const file = path.join(dir, `${sessionId}.jsonl`);
  await writeFile(file, claudeTurnLines(sessionId, cwd, turns).map((line) => JSON.stringify(line)).join('\n'));
  return file;
}

async function appendClaudeTurn(transcriptPath, sessionId, cwd, prompt, response, index) {
  const lines = claudeTurnLines(sessionId, cwd, [{ prompt, response }]).map((line) => {
    const parsed = { ...line };
    parsed.timestamp = parsed.timestamp.replace('04:00:', `04:${String(index).padStart(2, '0')}:`);
    return parsed;
  });
  await appendFile(transcriptPath, `\n${lines.map((line) => JSON.stringify(line)).join('\n')}`);
}

function captureClient() {
  const captured = [];
  return {
    captured,
    client: {
      async captureTurn(request) {
        captured.push(request);
        return true;
      },
    },
  };
}

async function allowCaptureSession(project, sessionId, agent = CLAUDE_AGENT) {
  const home = process.env.MUNINN_HOME;
  assert.ok(home, 'MUNINN_HOME must be set before allowing capture');
  await mkdir(home, { recursive: true });
  let policy = {};
  try {
    policy = JSON.parse(await readFile(path.join(home, 'capture.json'), 'utf8'));
  } catch {
    policy = {};
  }
  policy.capture ??= {};
  policy.capture.sessions ??= {};
  policy.capture.sessions[muninnSessionKey({ project, agent, sessionId })] = true;
  await writeFile(path.join(home, 'capture.json'), JSON.stringify({
    capture: policy.capture,
  }));
}

test('readClaudeSession parses one turn with tool events and an image artifact', async () => {
  const { file, artifactStore } = await writeFixture();
  const session = await readClaudeSession(file, { artifactStore, artifactMode: 'copy' });

  assert.ok(session, 'expected a session');
  assert.equal(session.sessionId, '0aba-claude-session');
  assert.equal(session.project, '/Users/dev/workspace/muninn');
  assert.equal(session.turns.length, 1);

  const turn = session.turns[0];
  assert.equal(turn.prompt, 'list the files');
  assert.match(turn.response, /Let me look\./);
  assert.match(turn.response, /There is one file: README\.md/);

  const types = turn.events.map((event) => event.type);
  assert.ok(types.includes('userMessage'));
  assert.ok(types.includes('toolCall'));
  assert.ok(types.includes('toolOutput'));
  assert.ok(types.includes('assistantMessage'));

  const toolCall = turn.events.find((event) => event.type === 'toolCall');
  assert.equal(toolCall.name, 'bash');
  const toolOutput = turn.events.find((event) => event.type === 'toolOutput');
  assert.match(toolOutput.output, /README\.md/);

  const image = turn.artifacts.find((artifact) => artifact.kind === 'image');
  assert.ok(image, 'expected an image artifact');
  assert.match(image.uri, /^artifact:\/\//);
});

test('toTurnContent for claude-code includes the claude marker', async () => {
  const { file, artifactStore } = await writeFixture();
  const session = await readClaudeSession(file, { artifactStore, artifactMode: 'copy' });
  const turn = toTurnContent(session, session.turns[0], 0, {
    agent: 'claude-code',
    ingest: 'claude-code-import',
    markerKey: 'claudeImport',
  });

  assert.equal(turn.agent, 'claude-code');
  assert.equal(turn.turnSequence, 0);
  assert.equal(turn.metadata[LEGACY_SEQUENCE_KEY], undefined);
  const marker = turn.artifacts.find((artifact) => artifact.key === 'claudeImport');
  assert.ok(marker, 'expected the claudeImport marker artifact');
  const markerContent = JSON.parse(marker.content);
  assert.equal(markerContent.marker, '0aba-claude-session#1');
  assert.equal(markerContent[LEGACY_SEQUENCE_KEY], undefined);
});

test('readClaudeSession and summary keep multiple transcript files independent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-import-multiple-'));
  process.env.MUNINN_HOME = path.join(root, 'muninn-home');
  const sessionA = await writeClaudeTranscript(root, 'claude-session-a', '/Users/dev/workspace/alpha', [
    { prompt: 'alpha first prompt', response: 'alpha first response' },
  ]);
  const sessionB = await writeClaudeTranscript(root, 'claude-session-b', '/Users/dev/workspace/beta', [
    { prompt: 'beta first prompt', response: 'beta first response' },
    { prompt: 'beta second prompt', response: 'beta second response' },
  ]);

  const [summaryA, summaryB] = await Promise.all([
    readClaudeSessionSummary(sessionA),
    readClaudeSessionSummary(sessionB),
  ]);
  const [fullA, fullB] = await Promise.all([
    readClaudeSession(sessionA, { artifactStore: path.join(root, 'artifacts'), artifactMode: 'preview' }),
    readClaudeSession(sessionB, { artifactStore: path.join(root, 'artifacts'), artifactMode: 'preview' }),
  ]);

  assert.equal(summaryA?.sessionId, 'claude-session-a');
  assert.equal(summaryA?.title, 'alpha first prompt');
  assert.equal(summaryA?.project, '/Users/dev/workspace/alpha');
  assert.equal(summaryB?.sessionId, 'claude-session-b');
  assert.equal(summaryB?.title, 'beta first prompt');
  assert.equal(summaryB?.project, '/Users/dev/workspace/beta');
  assert.equal(fullA?.turns.length, 1);
  assert.equal(fullA?.turns[0].prompt, 'alpha first prompt');
  assert.equal(fullB?.turns.length, 2);
  assert.equal(fullB?.turns[1].prompt, 'beta second prompt');
});

test('readClaudeSession resolves repo subdirectories to the GitHub project identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-subdir-project-'));
  process.env.MUNINN_HOME = path.join(root, 'muninn-home');
  const repo = path.join(root, 'muninn');
  const nestedDir = path.join(repo, 'server');
  await mkdir(nestedDir, { recursive: true });
  await execFileAsync('git', ['-C', repo, 'init']);
  await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'Test User']);
  await writeFile(path.join(repo, 'README.md'), 'muninn\n');
  await execFileAsync('git', ['-C', repo, 'add', 'README.md']);
  await execFileAsync('git', ['-C', repo, 'commit', '-m', 'init']);
  await execFileAsync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/majin1102/muninn.git']);
  const transcript = await writeClaudeTranscript(root, 'claude-subdir-session', nestedDir, [
    { prompt: 'check subdir', response: 'ok' },
  ]);

  const session = await readClaudeSession(transcript, { artifactStore: path.join(root, 'artifacts'), artifactMode: 'preview' });

  assert.ok(session);
  assert.equal(session.cwd, nestedDir);
  assert.equal(session.project, 'github.com/majin1102/muninn');
});

test('readClaudeSessionSummary uses the transcript latest timestamp instead of file mtime', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-summary-updated-at-'));
  process.env.MUNINN_HOME = path.join(root, 'muninn-home');
  const transcript = path.join(root, 'claude-session.jsonl');
  const lines = [
    {
      sessionId: 'claude-session',
      cwd: root,
      type: 'user',
      timestamp: '2026-06-12T04:00:00.000Z',
      message: { content: 'Sort Claude import sessions by transcript time' },
    },
    {
      sessionId: 'claude-session',
      cwd: root,
      type: 'assistant',
      timestamp: '2026-06-12T04:00:02.000Z',
      message: { content: [{ type: 'text', text: 'Done' }] },
    },
    {
      sessionId: 'claude-session',
      cwd: root,
      type: 'user',
      timestamp: '2026-06-12T04:35:00.000Z',
      message: { content: [{ type: 'tool_result', content: 'late event' }] },
    },
  ];
  await writeFile(transcript, lines.map((line) => JSON.stringify(line)).join('\n'));
  await utimes(transcript, new Date('2026-06-13T00:00:00.000Z'), new Date('2026-06-13T00:00:00.000Z'));

  const summary = await readClaudeSessionSummary(transcript);

  assert.ok(summary);
  assert.equal(summary.updatedAt, '2026-06-12T04:35:00.000Z');
});

test('captureFromTranscript keeps separate cache entries for multiple Claude transcripts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-hook-multiple-'));
  process.env.MUNINN_HOME = path.join(root, 'muninn-home');
  const sessionA = await writeClaudeTranscript(root, 'claude-hook-a', '/Users/dev/workspace/alpha', [
    { prompt: 'alpha first prompt', response: 'alpha first response' },
  ]);
  const sessionB = await writeClaudeTranscript(root, 'claude-hook-b', '/Users/dev/workspace/beta', [
    { prompt: 'beta first prompt', response: 'beta first response' },
    { prompt: 'beta second prompt', response: 'beta second response' },
  ]);
  const { captured, client } = captureClient();
  const options = { agent: CLAUDE_AGENT, ingest: 'claude-hook', markerKey: CLAUDE_MARKER_KEY };
  await allowCaptureSession('/Users/dev/workspace/alpha', 'claude-hook-a');
  await allowCaptureSession('/Users/dev/workspace/beta', 'claude-hook-b');

  assert.equal(await captureFromTranscript({ transcriptPath: sessionB, readSession: readClaudeSession, toTurnContent, toTurnOptions: options, label: 'test-claude-hook', client }), true);
  assert.equal(await captureFromTranscript({ transcriptPath: sessionA, readSession: readClaudeSession, toTurnContent, toTurnOptions: options, label: 'test-claude-hook', client }), true);
  await appendClaudeTurn(sessionA, 'claude-hook-a', '/Users/dev/workspace/alpha', 'alpha second prompt', 'alpha second response', 1);
  assert.equal(await captureFromTranscript({ transcriptPath: sessionA, readSession: readClaudeSession, toTurnContent, toTurnOptions: options, label: 'test-claude-hook', client }), true);

  assert.equal(captured.length, 4);
  assert.deepEqual(captured.map(({ turn }) => [turn.sessionId, turn.prompt, turn.turnSequence]), [
    ['claude-hook-b', 'beta first prompt', 0],
    ['claude-hook-b', 'beta second prompt', 1],
    ['claude-hook-a', 'alpha first prompt', 0],
    ['claude-hook-a', 'alpha second prompt', 1],
  ]);
});
