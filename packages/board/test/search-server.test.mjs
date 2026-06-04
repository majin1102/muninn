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
    memoryId: `turn:${overrides.sessionId}`,
    sessionId: overrides.sessionId,
    agent: 'codex_cli',
    observer: 'default',
    title: overrides.prompt,
    summary: overrides.prompt,
    prompt: overrides.prompt,
    response: overrides.response,
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:00:00.000Z',
  };
}
