import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadSearchServer() {
  const source = await readFile(new URL('../src/server/search.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

test('groupCandidates keeps top items per session and top sessions globally', async () => {
  const { __testing } = await loadSearchServer();
  const grouped = __testing.groupCandidates([
    candidate({ sessionKey: 's1', sessionLabel: 'Session 1', projectKey: 'muninn', id: 'a', score: 9 }),
    candidate({ sessionKey: 's1', sessionLabel: 'Session 1', projectKey: 'muninn', id: 'b', score: 8 }),
    candidate({ sessionKey: 's1', sessionLabel: 'Session 1', projectKey: 'muninn', id: 'c', score: 7 }),
    candidate({ sessionKey: 's2', sessionLabel: 'Session 2', projectKey: 'lance', id: 'd', score: 10 }),
  ], { sessionTopN: 2, topN: 1 });

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].sessionKey, 's2');
  assert.deepEqual(grouped[0].items.map((item) => item.id), ['conversation:s2:d']);
});

test('conversationCandidates respects query, project, and session scope', async () => {
  const { __testing } = await loadSearchServer();
  const candidates = __testing.conversationCandidates([
    turn({ sessionId: 'muninn/search-a', prompt: 'board search contract', response: 'response' }),
    turn({ sessionId: 'muninn/search-b', prompt: 'other topic', response: 'response' }),
    turn({ sessionId: 'lance/search-a', prompt: 'board search contract', response: 'response' }),
  ], {
    query: 'board search',
    projectKeys: ['muninn'],
    sessionKeys: ['muninn/search-a'],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sessionKey, 'muninn/search-a');
  assert.equal(candidates[0].source, 'conversation');
});

test('conversationCandidates includes default agent sessions without sessionId', async () => {
  const { __testing } = await loadSearchServer();
  const candidates = __testing.conversationCandidates([
    turn({
      sessionId: null,
      project: 'project-a',
      agent: 'agent-a',
      prompt: 'default session provider routing',
      response: 'response',
    }),
  ], {
    query: 'provider routing',
    projectKeys: ['project-a'],
    sessionKeys: ['__agent_default__:agent-a'],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sessionKey, '__agent_default__:agent-a');
  assert.equal(candidates[0].sessionLabel, 'Default Session');
  assert.equal(candidates[0].projectKey, 'project-a');
  assert.equal(candidates[0].links[0].sessionKey, '__agent_default__:agent-a');
});

test('extractionCandidates groups hits through default agent session references', async () => {
  const { __testing } = await loadSearchServer();
  const candidates = __testing.extractionCandidates([
    {
      memoryId: 'extraction:1',
      text: 'provider routing should remain visual first',
      references: ['turn:default-agent'],
    },
  ], [
    turn({
      memoryId: 'turn:default-agent',
      sessionId: null,
      project: 'project-a',
      agent: 'agent-a',
      prompt: 'provider routing',
      response: 'response',
    }),
  ], {
    projectKeys: ['project-a'],
    sessionKeys: ['__agent_default__:agent-a'],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sessionKey, '__agent_default__:agent-a');
  assert.equal(candidates[0].sessionLabel, 'Default Session');
  assert.equal(candidates[0].source, 'extraction');
  assert.equal(candidates[0].links[0].sessionKey, '__agent_default__:agent-a');
});

test('searchBoardMemory returns search results without building an answer', async () => {
  const { __testing } = await loadSearchServer();
  const response = await __testing.searchBoardMemory({
    query: 'board search',
    sessionTopN: 2,
    topN: 10,
  }, {
    listTurns: async () => [
      turn({ sessionId: 'muninn/search-a', prompt: 'board search contract', response: 'response' }),
    ],
    recall: async () => [],
  });

  assert.equal('answer' in response, false);
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].sessionKey, 'muninn/search-a');
});

function candidate(overrides) {
  return {
    sessionKey: overrides.sessionKey,
    sessionLabel: overrides.sessionLabel,
    projectKey: overrides.projectKey,
    latestUpdatedAt: '2026-06-04T00:00:00.000Z',
    source: 'conversation',
    title: overrides.id,
    content: `content ${overrides.id}`,
    createdAt: '2026-06-04T00:00:00.000Z',
    score: overrides.score,
    links: [],
  };
}

function turn(overrides) {
  return {
    memoryId: overrides.memoryId ?? `turn:${overrides.sessionId}`,
    sessionId: overrides.sessionId,
    project: overrides.project,
    agent: overrides.agent ?? 'codex_cli',
    observer: 'default',
    title: overrides.prompt,
    summary: overrides.prompt,
    prompt: overrides.prompt,
    response: overrides.response,
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:00:00.000Z',
  };
}
