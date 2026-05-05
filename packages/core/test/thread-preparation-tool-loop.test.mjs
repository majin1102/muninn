import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import * as threadPreparationModule from '../dist/observer/thread-preparation.js';

const { __testing } = threadPreparationModule;

test('thread preparation memory-get expands allowlisted memories only', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);
  t.after(async () => {
    delete process.env.MUNINN_HOME;
    await rm(dir, { recursive: true, force: true });
  });

  const requested = [];
  const memories = {
    get: async (memoryId) => {
      requested.push(memoryId);
      return {
        memoryId,
        title: `title ${memoryId}`,
        summary: `summary ${memoryId}`,
        detail: `detail ${memoryId}`,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
    },
  };

  const result = await __testing.prepareThreadsWithModel({
    reviewedObservations: [
      storedObservation('obs-1'),
      storedObservation('obs-2'),
    ],
    activeThreads: [
      {
        threadId: 'thread-1',
        memoryId: 'observing:snapshot-1',
        title: 'Existing thread',
        summary: 'Existing summary',
      },
    ],
    candidateMemories: [
      { memoryId: 'session:1', title: 'Candidate session', summary: 'Candidate summary' },
    ],
  }, {
    memories,
    model: async (_task, request) => {
      assert.equal(request.tools[0].name, 'memory-get');
      const hasToolResult = request.messages.some((message) => message.role === 'tool');
      if (!hasToolResult) {
        return {
          type: 'tool_calls',
          toolCalls: [
            {
              id: 'call-1',
              name: 'memory-get',
              arguments: {
                memoryIds: [
                  'session:1',
                  'observing:snapshot-1',
                  'observation:obs-1',
                  'session:not-allowed',
                ],
              },
            },
          ],
        };
      }
      const toolMessage = request.messages.find((message) => message.role === 'tool');
      assert.match(toolMessage.content, /"memoryId":"session:1"/);
      assert.match(toolMessage.content, /"memoryId":"observing:snapshot-1"/);
      assert.match(toolMessage.content, /"memoryId":"observation:obs-1"/);
      assert.match(toolMessage.content, /"memoryId":"session:not-allowed","error":"memory id is not allowlisted"/);
      return {
        type: 'final',
        text: JSON.stringify({
          workItems: [
            {
              observationIds: ['obs-1', 'obs-2'],
              newThreadTitle: 'Related observations',
              rationale: 'The observations describe the same topic.',
            },
          ],
          unthreadedObservationIds: [],
        }),
      };
    },
  });

  assert.deepEqual(requested, ['session:1', 'observing:snapshot-1', 'observation:obs-1']);
  assert.deepEqual(result, {
    workItems: [
      {
        observationIds: ['obs-1', 'obs-2'],
        newThreadTitle: 'Related observations',
        rationale: 'The observations describe the same topic.',
      },
    ],
    unthreadedObservationIds: [],
  });
});

test('thread preparation candidates recall related memories and exclude reviewed observations', async () => {
  const calls = [];
  const memories = {
    recall: async (query, limit) => {
      calls.push({ query, limit });
      if (query.includes('support group')) {
        return [
          { memoryId: 'observation:obs-1', text: 'Current support observation' },
          { memoryId: 'observation:old-support', text: 'Older support observation' },
        ];
      }
      return [
        { memoryId: 'observation:old-support', text: 'Older support observation duplicate' },
        { memoryId: 'observation:career', text: 'Career observation' },
      ];
    },
  };

  const candidates = await __testing.collectCandidateMemories({
    reviewedObservations: [
      storedObservation('obs-1', 'Caroline joined a support group.'),
      storedObservation('obs-2', 'Caroline is considering counseling.'),
    ],
    memories,
    limitPerObservation: 2,
  });

  assert.deepEqual(calls, [
    { query: 'Caroline joined a support group.', limit: 2 },
    { query: 'Caroline is considering counseling.', limit: 2 },
  ]);
  assert.deepEqual(candidates, [
    {
      memoryId: 'observation:old-support',
      title: 'Older support observation',
      summary: 'Older support observation',
    },
    {
      memoryId: 'observation:career',
      title: 'Career observation',
      summary: 'Career observation',
    },
  ]);
});

test('thread preparation candidate recall fails open', async () => {
  const candidates = await __testing.collectCandidateMemories({
    reviewedObservations: [
      storedObservation('obs-1', 'Caroline joined a support group.'),
    ],
    memories: {
      recall: async () => {
        throw new Error('recall unavailable');
      },
    },
    limitPerObservation: 2,
  });

  assert.deepEqual(candidates, []);
});

test('thread preparation writes trace with input, tool calls, and final result', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  const tracePath = path.join(dir, 'thread-preparation-trace.jsonl');
  process.env.MUNINN_HOME = homeDir;
  process.env.MUNINN_THREAD_PREPARATION_TRACE_FILE = tracePath;
  await writeObserverConfig(configPath);
  t.after(async () => {
    delete process.env.MUNINN_HOME;
    delete process.env.MUNINN_THREAD_PREPARATION_TRACE_FILE;
    await rm(dir, { recursive: true, force: true });
  });

  await __testing.prepareThreadsWithModel({
    reviewedObservations: [
      storedObservation('obs-1', 'Caroline joined a support group.'),
    ],
    activeThreads: [],
    candidateMemories: [
      { memoryId: 'observation:old-support', title: 'Older support', summary: 'Older support summary' },
    ],
  }, {
    memories: {
      get: async (memoryId) => ({
        memoryId,
        title: 'Older support',
        summary: 'Older support summary',
        detail: 'Older support detail',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      }),
    },
    model: async (_task, request) => {
      if (!request.messages.some((message) => message.role === 'tool')) {
        return {
          type: 'tool_calls',
          toolCalls: [
            {
              id: 'call-1',
              name: 'memory-get',
              arguments: { memoryIds: ['observation:old-support'] },
            },
          ],
        };
      }
      return {
        type: 'final',
        text: JSON.stringify({
          workItems: [],
          unthreadedObservationIds: ['obs-1'],
        }),
      };
    },
  });

  const events = (await readFile(tracePath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].candidateMemories, [
    { memoryId: 'observation:old-support', title: 'Older support', summary: 'Older support summary' },
  ]);
  assert.deepEqual(events[0].toolCalls, [
    { id: 'call-1', name: 'memory-get', arguments: { memoryIds: ['observation:old-support'] } },
  ]);
  assert.equal(events[0].toolResults[0].id, 'call-1');
  assert.deepEqual(events[0].result, {
    workItems: [],
    unthreadedObservationIds: ['obs-1'],
  });
});

function storedObservation(id, text = `${id} text`) {
  return {
    id,
    text,
    vector: [1, 0, 0, 0],
    importance: 1,
    category: 'Fact',
    references: ['session:1'],
    createdAt: '2024-01-01T00:00:00Z',
  };
}

async function makeConfigHome() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-thread-preparation-'));
  return {
    dir,
    homeDir: path.join(dir, 'muninn'),
    configPath: path.join(dir, 'muninn', 'muninn.json'),
  };
}

async function writeObserverConfig(configPath) {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    observer: {
      name: 'test-observer',
      llm: 'observer_llm',
      maxAttempts: 3,
      activeWindowDays: 3650,
    },
    llm: {
      observer_llm: {
        provider: 'openai',
        apiKey: 'test-key',
      },
    },
    observation: {
      embedding: {
        provider: 'mock',
        dimensions: 4,
      },
      defaultImportance: 0.7,
    },
  }, null, 2)}\n`, 'utf8');
}
