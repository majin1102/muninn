import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handleStop, isStopEvent } from '../dist/hook.js';

// Minimal Codex rollout transcript: one turn with a tool call.
const TRANSCRIPT_LINES = [
  { type: 'session_meta', payload: { id: '019eabcd-codex-session', cwd: '/Users/dev/workspace/muninn', timestamp: '2026-06-10T03:00:00.000Z' } },
  { type: 'response_item', timestamp: '2026-06-10T03:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list the files' }] } },
  { type: 'response_item', timestamp: '2026-06-10T03:00:02.000Z', payload: { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{"command":"ls"}' } },
  { type: 'response_item', timestamp: '2026-06-10T03:00:03.000Z', payload: { type: 'function_call_output', call_id: 'call-1', output: 'README.md' } },
  { type: 'response_item', timestamp: '2026-06-10T03:00:04.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'There is one file: README.md' }] } },
];

async function writeFixtureTranscript() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-hook-'));
  process.env.MUNINN_HOME = path.join(dir, 'muninn-home');
  const file = path.join(dir, 'rollout-2026-06-10-019eabcd-codex-session.jsonl');
  await writeFile(file, TRANSCRIPT_LINES.map((line) => JSON.stringify(line)).join('\n'));
  return file;
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

test('isStopEvent matches Stop case-insensitively and rejects others', () => {
  assert.equal(isStopEvent({ hook_event_name: 'Stop' }), true);
  assert.equal(isStopEvent({ hook_event_name: 'stop' }), true);
  assert.equal(isStopEvent({ hook_event_name: 'UserPromptSubmit' }), false);
  assert.equal(isStopEvent({}), false);
});

test('handleStop maps the latest transcript turn to TurnContent and captures it', async () => {
  const transcriptPath = await writeFixtureTranscript();
  const { captured, client } = captureClient();

  const ok = await handleStop(
    { hook_event_name: 'Stop', transcript_path: transcriptPath, session_id: '019eabcd-codex-session' },
    { client },
  );

  assert.equal(ok, true);
  assert.equal(captured.length, 1);
  const { turn } = captured[0];

  assert.equal(turn.sessionId, '019eabcd-codex-session');
  assert.equal(turn.agent, 'codex');
  assert.equal(turn.project, 'muninn');
  assert.equal(turn.cwd, '/Users/dev/workspace/muninn');
  assert.equal(turn.prompt, 'list the files');
  assert.equal(turn.response, 'There is one file: README.md');
  assert.equal(turn.metadata.ingest, 'codex-hook');

  assert.deepEqual(turn.events.map((event) => event.type), [
    'userMessage',
    'toolCall',
    'toolOutput',
    'assistantMessage',
  ]);

  const marker = turn.artifacts.find((artifact) => artifact.key === 'codex.import');
  assert.ok(marker, 'expected codex.import marker artifact');
  assert.equal(JSON.parse(marker.content).marker, '019eabcd-codex-session#1');
});

test('handleStop returns false when transcript is missing', async () => {
  const { captured, client } = captureClient();
  const ok = await handleStop(
    { hook_event_name: 'Stop', transcript_path: '/nonexistent/path.jsonl' },
    { client, sessionsRoot: path.join(os.tmpdir(), 'codex-hook-empty-root') },
  );
  assert.equal(ok, false);
  assert.equal(captured.length, 0);
});
