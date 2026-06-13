import assert from 'node:assert/strict';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { captureFromTranscript } from '../dist/hook.js';
import { CLAUDE_AGENT, CLAUDE_MARKER_KEY, readClaudeSession, readClaudeSessionSummary, toTurnContent } from '../dist/mapping.js';

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

test('toTurnContent for claude-code has no title and the claude marker', async () => {
  const { file, artifactStore } = await writeFixture();
  const session = await readClaudeSession(file, { artifactStore, artifactMode: 'copy' });
  const turn = toTurnContent(session, session.turns[0], 0, {
    agent: 'claude-code',
    ingest: 'claude-code-import',
    markerKey: 'claude-code.import',
  });

  assert.equal(turn.agent, 'claude-code');
  assert.equal(turn.title, undefined);
  assert.equal(turn.metadata.sourceTurnSequence, 0);
  const marker = turn.artifacts.find((artifact) => artifact.key === 'claude-code.import');
  assert.ok(marker, 'expected the claude-code.import marker artifact');
  const markerContent = JSON.parse(marker.content);
  assert.equal(markerContent.marker, '0aba-claude-session#1');
  assert.equal(markerContent.sourceTurnSequence, 0);
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

  assert.equal(await captureFromTranscript({ transcriptPath: sessionB, readSession: readClaudeSession, toTurnOptions: options, label: 'test-claude-hook', client }), true);
  assert.equal(await captureFromTranscript({ transcriptPath: sessionA, readSession: readClaudeSession, toTurnOptions: options, label: 'test-claude-hook', client }), true);
  await appendClaudeTurn(sessionA, 'claude-hook-a', '/Users/dev/workspace/alpha', 'alpha second prompt', 'alpha second response', 1);
  assert.equal(await captureFromTranscript({ transcriptPath: sessionA, readSession: readClaudeSession, toTurnOptions: options, label: 'test-claude-hook', client }), true);

  assert.equal(captured.length, 3);
  assert.deepEqual(captured.map(({ turn }) => [turn.sessionId, turn.prompt, turn.metadata.sourceTurnSequence]), [
    ['claude-hook-b', 'beta second prompt', 1],
    ['claude-hook-a', 'alpha first prompt', 0],
    ['claude-hook-a', 'alpha second prompt', 1],
  ]);
});
