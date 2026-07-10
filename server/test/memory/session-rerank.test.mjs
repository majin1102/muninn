import assert from 'node:assert/strict';
import test from 'node:test';

import { recallMemories } from '../../dist/api/memory.js';

test('recall session mode reranks session candidates by default', async () => {
  const client = {
    sessionTable: {
      search: async (params) => {
        assert.deepEqual(params, {
          query: 'lance wiki',
          vector: [0, 1],
          limit: 8,
        });
        return [
          sessionRow({
            snapshotId: 'session:26',
            sessionId: 'session-26',
            title: 'Session topic recall',
            summary: 'Muninn recall and import session topic entry.',
            updatedAt: '2024-01-04T00:00:00Z',
          }),
          sessionRow({
            snapshotId: 'session:28',
            sessionId: 'session-28',
            title: 'Muninn LLM Wiki design',
            summary: 'GitHub-first LLM Wiki compiler design for Lance docs.',
            updatedAt: '2024-01-02T00:00:00Z',
          }),
        ];
      },
    },
    extractionTable: {
      search: async () => {
        throw new Error('extractionTable.search should not be called by session recall');
      },
    },
  };

  const hits = await recallMemories(client, 'lance wiki', 2, {
    mode: 'session',
    embed: async () => [0, 1],
    sessionRerank: async () => ({
      contextIds: [
        'session:28',
        'session:26',
      ],
      filteredContextIds: [],
    }),
  });

  assert.deepEqual(hits.map((hit) => hit.sessionId), ['session-28', 'session-26']);
});

test('recall session mode falls back when reranker returns invalid ids', async () => {
  const client = {
    sessionTable: {
      search: async () => [
        sessionRow({
          snapshotId: 'session:51',
          sessionId: 'newer-broad',
          title: 'Recent broad Lance notes',
          summary: 'General Lance discussion.',
          updatedAt: '2024-02-01T00:00:00Z',
        }),
        sessionRow({
          snapshotId: 'session:52',
          sessionId: 'older-direct',
          title: 'Lance Wiki design',
          summary: 'Focused wiki compiler session for Lance.',
          updatedAt: '2024-01-01T00:00:00Z',
        }),
      ],
    },
    extractionTable: {
      search: async () => {
        throw new Error('extractionTable.search should not be called by session recall');
      },
    },
  };

  const hits = await recallMemories(client, 'lance wiki', 2, {
    mode: 'session',
    embed: async () => [0, 1],
    sessionRerank: async () => ({ contextIds: ['session:999', 'session:999'], filteredContextIds: [] }),
  });

  assert.deepEqual(hits.map((hit) => hit.sessionId), ['older-direct', 'newer-broad']);
});

test('recall session mode filters unrelated reranker candidates', async () => {
  const client = {
    sessionTable: {
      search: async () => [
        sessionRow({
          snapshotId: 'session:26',
          sessionId: 'session-26',
          title: 'Session topic recall',
          summary: 'Muninn recall and import session topic entry.',
          updatedAt: '2024-01-04T00:00:00Z',
        }),
        sessionRow({
          snapshotId: 'session:28',
          sessionId: 'session-28',
          title: 'Muninn LLM Wiki design',
          summary: 'GitHub-first LLM Wiki compiler design for Lance docs.',
          updatedAt: '2024-01-02T00:00:00Z',
        }),
        sessionRow({
          snapshotId: 'session:35',
          sessionId: 'session-35',
          title: 'Amoro release chores',
          summary: 'Packaging, labels, and unrelated release checklist notes.',
          updatedAt: '2024-01-03T00:00:00Z',
        }),
      ],
    },
    extractionTable: {
      search: async () => {
        throw new Error('extractionTable.search should not be called by session recall');
      },
    },
  };

  const hits = await recallMemories(client, 'lance wiki', 10, {
    mode: 'session',
    embed: async () => [0, 1],
    sessionRerank: async () => ({
      contextIds: ['session:28', 'session:26'],
      filteredContextIds: ['session:35'],
    }),
  });

  assert.deepEqual(hits.map((hit) => hit.sessionId), ['session-28', 'session-26']);
});

test('recall session mode can return no hits when reranker filters every candidate', async () => {
  const client = {
    sessionTable: {
      search: async () => [
        sessionRow({
          snapshotId: 'session:41',
          sessionId: 'session-41',
          title: 'Amoro release chores',
          summary: 'Packaging and release checklist notes.',
          updatedAt: '2024-01-04T00:00:00Z',
        }),
        sessionRow({
          snapshotId: 'session:42',
          sessionId: 'session-42',
          title: 'Codex authentication',
          summary: 'Local auth and proxy setup notes.',
          updatedAt: '2024-01-02T00:00:00Z',
        }),
      ],
    },
    extractionTable: {
      search: async () => {
        throw new Error('extractionTable.search should not be called by session recall');
      },
    },
  };

  const hits = await recallMemories(client, 'lance wiki', 10, {
    mode: 'session',
    embed: async () => [0, 1],
    sessionRerank: async () => ({
      contextIds: [],
      filteredContextIds: ['session:41', 'session:42'],
    }),
  });

  assert.deepEqual(hits, []);
});

test('recall session mode lets reranker filter a single unrelated candidate', async () => {
  const client = {
    sessionTable: {
      search: async () => [
        sessionRow({
          snapshotId: 'session:61',
          sessionId: 'session-61',
          title: 'Codex authentication',
          summary: 'Local auth and proxy setup notes.',
          updatedAt: '2024-01-02T00:00:00Z',
        }),
      ],
    },
    extractionTable: {
      search: async () => {
        throw new Error('extractionTable.search should not be called by session recall');
      },
    },
  };

  const hits = await recallMemories(client, 'lance wiki', 10, {
    mode: 'session',
    embed: async () => [0, 1],
    sessionRerank: async () => ({
      contextIds: [],
      filteredContextIds: ['session:61'],
    }),
  });

  assert.deepEqual(hits, []);
});

function sessionRow({
  snapshotId,
  sessionId,
  title,
  summary,
  updatedAt,
}) {
  return {
    latestSnapshotId: snapshotId,
    project: 'project-a',
    cwd: '/workspace/project-a',
    agent: 'codex',
    sessionId,
    title,
    summary,
    searchText: `${title}\n\n${summary}`,
    vector: [0, 1],
    updatedAt,
  };
}
