import assert from 'node:assert/strict';
import test from 'node:test';
import chatTimeline from '../dist-server/chat_timeline.js';

const { __testing } = chatTimeline;

test('builds ordered timeline entries from interleaved codex events', () => {
  const entries = __testing.entriesFromEvents([
    { type: 'userMessage', text: 'start', timestamp: '2026-06-02T10:00:00.000Z' },
    { type: 'assistantMessage', text: 'assistant A', timestamp: '2026-06-02T10:00:05.000Z' },
    { type: 'toolCall', id: 'call-1', name: 'exec_command', input: '{"cmd":"pwd"}', timestamp: '2026-06-02T10:00:06.000Z' },
    { type: 'toolOutput', id: 'call-1', output: '/repo', timestamp: '2026-06-02T10:00:07.000Z' },
    { type: 'assistantMessage', text: 'assistant B', timestamp: '2026-06-02T10:00:08.000Z' },
    { type: 'toolCall', id: 'call-2', name: 'read_file', input: '{"path":"README.md"}', timestamp: '2026-06-02T10:00:09.000Z' },
    { type: 'toolOutput', id: 'call-2', output: 'content', timestamp: '2026-06-02T10:00:10.000Z' },
    { type: 'assistantMessage', text: 'assistant C', timestamp: '2026-06-02T10:00:11.000Z' },
  ], {
    memoryId: 'turn:1',
    agent: 'codex',
    startedAt: '2026-06-02T10:00:00.000Z',
    completedAt: '2026-06-02T10:00:12.000Z',
  });

  assert.deepEqual(entries.map((entry) => entry.type), [
    'message',
    'message',
    'toolGroup',
    'message',
    'toolGroup',
    'message',
    'cost',
  ]);
  assert.equal(entries[2].group.toolCalls[0].name, 'exec_command');
  assert.equal(entries[2].group.toolCalls[0].output, '/repo');
  assert.equal(entries[4].group.toolCalls[0].name, 'read_file');
  assert.equal(entries[4].group.toolCalls[0].output, 'content');
});

test('groups consecutive tool calls before the next message', () => {
  const entries = __testing.entriesFromEvents([
    { type: 'userMessage', text: 'start' },
    { type: 'assistantMessage', text: 'working' },
    { type: 'toolCall', id: 'call-1', name: 'exec_command', input: '{"cmd":"pwd"}' },
    { type: 'toolCall', id: 'call-2', name: 'exec_command', input: '{"cmd":"ls"}' },
    { type: 'toolOutput', id: 'call-1', output: '/repo' },
    { type: 'toolOutput', id: 'call-2', output: 'README.md' },
    { type: 'assistantMessage', text: 'done' },
  ], {
    memoryId: 'turn:2',
    agent: 'codex',
  });

  assert.deepEqual(entries.map((entry) => entry.type), ['message', 'message', 'toolGroup', 'message']);
  assert.equal(entries[2].group.toolCalls.length, 2);
  assert.equal(entries[2].group.toolCalls[1].output, 'README.md');
});

test('fallback data still renders tool calls and cost', () => {
  const entries = __testing.entriesFromFallback({
    memoryId: 'turn:3',
    agent: 'codex',
    createdAt: '2026-06-02T10:00:00.000Z',
    updatedAt: '2026-06-02T10:00:05.000Z',
    prompt: 'prompt',
    response: 'response',
    toolCalls: [{ id: 'call-1', name: 'exec_command', input: '{"cmd":"pwd"}', output: '/repo' }],
  });

  assert.deepEqual(entries.map((entry) => entry.type), ['message', 'message', 'toolGroup', 'cost']);
  assert.equal(entries[2].group.toolCalls[0].name, 'exec_command');
});
