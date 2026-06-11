import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readClaudeSession, toTurnContent } from '../dist/mapping.js';

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
  const file = path.join(dir, '0aba-claude-session.jsonl');
  await writeFile(file, TRANSCRIPT.map((line) => JSON.stringify(line)).join('\n'));
  return { file, artifactStore: path.join(dir, 'artifacts') };
}

test('readClaudeSession parses one turn with tool events and an image artifact', async () => {
  const { file, artifactStore } = await writeFixture();
  const session = await readClaudeSession(file, { artifactStore, artifactMode: 'copy' });

  assert.ok(session, 'expected a session');
  assert.equal(session.sessionId, '0aba-claude-session');
  assert.equal(session.projectKey, 'muninn');
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
  const marker = turn.artifacts.find((artifact) => artifact.key === 'claude-code.import');
  assert.ok(marker, 'expected the claude-code.import marker artifact');
  assert.equal(JSON.parse(marker.content).marker, '0aba-claude-session#1');
});
