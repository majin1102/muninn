import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { __testing } from '../src/lib/chat_timeline.ts';

async function loadSourceChatTimeline() {
  const source = await readFile(new URL('../src/lib/chat_timeline.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

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
    'totalTime',
  ]);
  assert.equal(entries[2].group.toolCalls[0].name, 'exec_command');
  assert.equal(entries[2].group.toolCalls[0].output, '/repo');
  assert.equal(entries[1].message.startedAt, '2026-06-02T10:00:00.000Z');
  assert.equal(entries[1].message.completedAt, '2026-06-02T10:00:05.000Z');
  assert.equal(entries[3].message.startedAt, '2026-06-02T10:00:07.000Z');
  assert.equal(entries[3].message.completedAt, '2026-06-02T10:00:08.000Z');
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

test('attaches tool output artifacts to the matching timeline tool call', async () => {
  const { entriesFromEvents } = await loadSourceChatTimeline();
  const entries = entriesFromEvents([
    { type: 'toolCall', id: 'call-1', name: 'view_image', input: '{"path":"render.png"}' },
    {
      type: 'toolOutput',
      id: 'call-1',
      output: 'rendered',
      artifacts: [{
        key: 'tool-call-1-artifact-1',
        kind: 'image',
        source: 'tool',
        uri: 'artifact://sessions/codex-session/render-20260608T140000Z.png',
        name: 'render.png',
      }],
    },
  ], {
    memoryId: 'turn:tool-artifact',
    agent: 'codex',
  });

  assert.deepEqual(entries.map((entry) => entry.type), ['toolGroup']);
  assert.equal(entries[0].group.toolCalls[0].artifacts.length, 1);
  assert.equal(entries[0].group.toolCalls[0].artifacts[0].uri, 'artifact://sessions/codex-session/render-20260608T140000Z.png');
});

test('fallback data still renders tool calls and total time', () => {
  const entries = __testing.entriesFromFallback({
    memoryId: 'turn:3',
    agent: 'codex',
    createdAt: '2026-06-02T10:00:00.000Z',
    updatedAt: '2026-06-02T10:00:05.000Z',
    prompt: 'prompt',
    response: 'response',
    toolCalls: [{ id: 'call-1', name: 'exec_command', input: '{"cmd":"pwd"}', output: '/repo' }],
  });

  assert.deepEqual(entries.map((entry) => entry.type), ['message', 'message', 'toolGroup', 'totalTime']);
  assert.equal(entries[2].group.toolCalls[0].name, 'exec_command');
  assert.equal(entries[1].message.startedAt, '2026-06-02T10:00:00.000Z');
  assert.equal(entries[1].message.completedAt, '2026-06-02T10:00:05.000Z');
});

test('source timeline records total and tool call time ranges from event timestamps', async () => {
  const { entriesFromEvents } = await loadSourceChatTimeline();
  const entries = entriesFromEvents([
    { type: 'userMessage', text: 'start', timestamp: '2026-06-02T10:00:00.000Z' },
    { type: 'assistantMessage', text: 'working', timestamp: '2026-06-02T10:00:01.000Z' },
    { type: 'toolCall', id: 'call-1', name: 'exec_command', input: '{"cmd":"pwd"}', timestamp: '2026-06-02T10:00:02.000Z' },
    { type: 'toolOutput', id: 'call-1', output: '/repo', timestamp: '2026-06-02T10:00:05.000Z' },
    { type: 'toolCall', id: 'call-2', name: 'read_file', input: '{"path":"README.md"}', timestamp: '2026-06-02T10:00:06.000Z' },
    { type: 'toolOutput', id: 'call-2', output: 'content', timestamp: '2026-06-02T10:00:09.000Z' },
    { type: 'assistantMessage', text: 'done', timestamp: '2026-06-02T10:00:10.000Z' },
  ], {
    memoryId: 'turn:1',
    agent: 'codex',
    startedAt: '2026-06-02T10:00:00.000Z',
    completedAt: '2026-06-02T10:00:12.000Z',
  });

  assert.deepEqual(entries.map((entry) => entry.type), ['message', 'message', 'toolGroup', 'message', 'totalTime']);
  assert.deepEqual({
    groupStartedAt: entries[2].group.startedAt,
    groupCompletedAt: entries[2].group.completedAt,
    firstStartedAt: entries[2].group.toolCalls[0].startedAt,
    firstCompletedAt: entries[2].group.toolCalls[0].completedAt,
    secondStartedAt: entries[2].group.toolCalls[1].startedAt,
    secondCompletedAt: entries[2].group.toolCalls[1].completedAt,
    firstAssistantStartedAt: entries[1].message.startedAt,
    firstAssistantCompletedAt: entries[1].message.completedAt,
    secondAssistantStartedAt: entries[3].message.startedAt,
    secondAssistantCompletedAt: entries[3].message.completedAt,
    totalStartedAt: entries[4].totalTime.startedAt,
    totalCompletedAt: entries[4].totalTime.completedAt,
  }, {
    groupStartedAt: '2026-06-02T10:00:02.000Z',
    groupCompletedAt: '2026-06-02T10:00:09.000Z',
    firstStartedAt: '2026-06-02T10:00:02.000Z',
    firstCompletedAt: '2026-06-02T10:00:05.000Z',
    secondStartedAt: '2026-06-02T10:00:06.000Z',
    secondCompletedAt: '2026-06-02T10:00:09.000Z',
    firstAssistantStartedAt: '2026-06-02T10:00:00.000Z',
    firstAssistantCompletedAt: '2026-06-02T10:00:01.000Z',
    secondAssistantStartedAt: '2026-06-02T10:00:09.000Z',
    secondAssistantCompletedAt: '2026-06-02T10:00:10.000Z',
    totalStartedAt: '2026-06-02T10:00:00.000Z',
    totalCompletedAt: '2026-06-02T10:00:12.000Z',
  });
});

test('source timeline omits tool row time when timestamps are incomplete', async () => {
  const { entriesFromEvents } = await loadSourceChatTimeline();
  const entries = entriesFromEvents([
    { type: 'assistantMessage', text: 'working' },
    { type: 'toolCall', id: 'call-1', name: 'exec_command', input: '{"cmd":"pwd"}', timestamp: '2026-06-02T10:00:02.000Z' },
    { type: 'toolOutput', id: 'call-1', output: '/repo' },
  ], {
    memoryId: 'turn:2',
    agent: 'codex',
  });

  assert.deepEqual(entries.map((entry) => entry.type), ['message', 'toolGroup']);
  assert.equal(entries[1].group.completedAt, undefined);
  assert.equal(entries[1].group.toolCalls[0].startedAt, '2026-06-02T10:00:02.000Z');
  assert.equal(entries[1].group.toolCalls[0].completedAt, undefined);
});
