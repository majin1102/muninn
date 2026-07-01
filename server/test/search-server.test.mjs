import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadSearchServer() {
  const identitySource = await readFile(new URL('../../common/src/session-identity.ts', import.meta.url), 'utf8');
  const searchSource = await readFile(new URL('../src/web/search.ts', import.meta.url), 'utf8');
  const source = `${identitySource}\n${searchSource
    .replace("import * as SessionIdentity from '@muninn/common/session-identity';\n", '')
    .replaceAll('SessionIdentity.sessionIdentityKey', 'sessionIdentityKey')}`;
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

test('groupCandidates keeps top memories globally with a per-session cap', async () => {
  const { __testing } = await loadSearchServer();
  const grouped = __testing.groupCandidates([
    candidate({ sessionKey: 's1', sessionLabel: 'Session 1', projectKey: 'muninn', id: 'a', score: 10 }),
    candidate({ sessionKey: 's1', sessionLabel: 'Session 1', projectKey: 'muninn', id: 'b', score: 9 }),
    candidate({ sessionKey: 's1', sessionLabel: 'Session 1', projectKey: 'muninn', id: 'c', score: 8 }),
    candidate({ sessionKey: 's2', sessionLabel: 'Session 2', projectKey: 'lance', id: 'd', score: 7 }),
    candidate({ sessionKey: 's3', sessionLabel: 'Session 3', projectKey: 'lance', id: 'e', score: 6 }),
  ], { sessionTopN: 2, topN: 3 });

  assert.equal(grouped.reduce((count, result) => count + result.items.length, 0), 3);
  assert.deepEqual(grouped.map((result) => result.sessionKey), ['s1', 's2']);
  assert.deepEqual(grouped[0].items.map((item) => item.id), ['conversation:s1:a', 'conversation:s1:b']);
  assert.deepEqual(grouped[1].items.map((item) => item.id), ['conversation:s2:d']);
});

test('groupCandidates skips over a saturated session to fill global top memories', async () => {
  const { __testing } = await loadSearchServer();
  const grouped = __testing.groupCandidates([
    candidate({ sessionKey: 's1', sessionLabel: 'Session 1', projectKey: 'muninn', id: 'a', score: 100 }),
    candidate({ sessionKey: 's1', sessionLabel: 'Session 1', projectKey: 'muninn', id: 'b', score: 99 }),
    candidate({ sessionKey: 's1', sessionLabel: 'Session 1', projectKey: 'muninn', id: 'c', score: 98 }),
    candidate({ sessionKey: 's2', sessionLabel: 'Session 2', projectKey: 'muninn', id: 'd', score: 20 }),
    candidate({ sessionKey: 's3', sessionLabel: 'Session 3', projectKey: 'muninn', id: 'e', score: 19 }),
  ], { sessionTopN: 2, topN: 4 });

  assert.equal(grouped.reduce((count, result) => count + result.items.length, 0), 4);
  assert.deepEqual(grouped.flatMap((result) => result.items.map((item) => item.id)), [
    'conversation:s1:a',
    'conversation:s1:b',
    'conversation:s2:d',
    'conversation:s3:e',
  ]);
});

test('hitCandidates respects project and session scope from enriched recall metadata', async () => {
  const { __testing } = await loadSearchServer();
  const candidates = __testing.hitCandidates([
    recallHit({ memoryId: 'ext:1', sessionId: 'search-a', project: 'muninn', agent: 'codex' }),
    recallHit({ memoryId: 'ext:2', sessionId: 'search-b', project: 'muninn', agent: 'codex' }),
    recallHit({ memoryId: 'ext:3', sessionId: 'search-a', project: 'lance', agent: 'codex' }),
  ], {
    projectKeys: ['muninn'],
    sessionKeys: [sessionScopeKey('muninn', 'codex', 'search-a')],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sessionKey, sessionScopeKey('muninn', 'codex', 'search-a'));
  assert.equal(candidates[0].source, 'extraction');
});

test('hitCandidates keeps same raw session ids separate across projects and agents', async () => {
  const { __testing } = await loadSearchServer();
  const grouped = __testing.groupCandidates(__testing.hitCandidates([
    recallHit({ memoryId: 'ext:1', sessionId: 'same-session', project: 'muninn', agent: 'codex' }),
    recallHit({ memoryId: 'ext:2', sessionId: 'same-session', project: 'lance', agent: 'codex' }),
    recallHit({ memoryId: 'ext:3', sessionId: 'same-session', project: 'muninn', agent: 'claude' }),
  ], {}), { sessionTopN: 3, topN: 10 });

  assert.deepEqual(grouped.map((result) => result.sessionKey), [
    sessionScopeKey('muninn', 'codex', 'same-session'),
    sessionScopeKey('lance', 'codex', 'same-session'),
    sessionScopeKey('muninn', 'claude', 'same-session'),
  ]);
});

test('hitCandidates merges same project agent and raw session id across worktrees', async () => {
  const { __testing } = await loadSearchServer();
  const grouped = __testing.groupCandidates(__testing.hitCandidates([
    recallHit({
      memoryId: 'ext:1',
      sessionId: 'same-session',
      project: '/workspace/muninn',
      agent: 'codex',
      cwd: '/Users/Nathan/.codex/worktrees/aaaa/muninn',
      references: ['turn:1'],
    }),
    recallHit({
      memoryId: 'ext:2',
      sessionId: 'same-session',
      project: '/workspace/muninn',
      agent: 'codex',
      cwd: '/Users/Nathan/.codex/worktrees/bbbb/muninn',
      references: ['turn:2'],
    }),
  ], {}), { sessionTopN: 3, topN: 10 });

  assert.deepEqual(grouped.map((result) => result.sessionKey), [
    sessionScopeKey('/workspace/muninn', 'codex', 'same-session'),
  ]);
  assert.equal(grouped[0].items.length, 2);
});

test('hitCandidates filters extraction hits without real session metadata', async () => {
  const { __testing } = await loadSearchServer();
  const candidates = __testing.hitCandidates([
    recallHit({
      sessionId: undefined,
      project: 'project-a',
      agent: 'agent-a',
    }),
  ], {});

  assert.equal(candidates.length, 0);
});

test('hitCandidates ignores non-extraction hits for app recall', async () => {
  const { __testing } = await loadSearchServer();
  const candidates = __testing.hitCandidates([
    recallHit({ memoryId: 'session:1' }),
    recallHit({ memoryId: 'ext:1' }),
  ], {});

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].memoryId, 'ext:1');
});

test('search result items include recall turn references', async () => {
  const { __testing } = await loadSearchServer();
  const grouped = __testing.groupCandidates([
    candidate({
      sessionKey: 's1',
      sessionLabel: 'Session 1',
      projectKey: 'muninn',
      id: 'a',
      score: 9,
      references: ['turn:1', 'turn:2'],
    }),
  ], { sessionTopN: 1, topN: 1 });

  assert.deepEqual(grouped[0].items[0].references, ['turn:1', 'turn:2']);
});

test('groupCandidates removes covered duplicate extraction titles within a session', async () => {
  const { __testing } = await loadSearchServer();
  const grouped = __testing.groupCandidates([
    candidate({
      sessionKey: 's1',
      sessionLabel: 'Session 1',
      projectKey: 'muninn',
      id: 'broad',
      title: 'Board Search 产品与实现设计',
      score: 9,
      references: ['turn:1', 'turn:2', 'turn:3'],
    }),
    candidate({
      sessionKey: 's1',
      sessionLabel: 'Session 1',
      projectKey: 'muninn',
      id: 'covered',
      title: 'Board Search 产品与实现设计',
      score: 8,
      references: ['turn:1', 'turn:2'],
    }),
    candidate({
      sessionKey: 's1',
      sessionLabel: 'Session 1',
      projectKey: 'muninn',
      id: 'distinct',
      title: 'Board Search 产品与实现设计',
      score: 7,
      references: ['turn:4'],
    }),
  ], { sessionTopN: 5, topN: 2 });

  assert.deepEqual(grouped[0].items.map((item) => item.references), [
    ['turn:1', 'turn:2', 'turn:3'],
    ['turn:4'],
  ]);
});

test('searchAppMemory uses recall hits without scanning turns or building an answer', async () => {
  const { __testing } = await loadSearchServer();
  let recallOptions = null;
  const response = await __testing.searchAppMemory({
    query: 'app search',
    sessionTopN: 2,
    topN: 10,
  }, {
    listTurns: async () => {
      throw new Error('listTurns must not be called by app recall search');
    },
    recall: async (_query, _limit, options) => {
      recallOptions = options;
      return [
        recallHit({
          sessionId: 'search-a',
          project: 'muninn',
          agent: 'codex',
          cwd: '/workspace/muninn',
          displaySession: 'Search A',
        }),
      ];
    },
  });

  assert.equal('answer' in response, false);
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].sessionKey, sessionScopeKey('muninn', 'codex', 'search-a'));
  assert.equal(response.results[0].projectCwd, '/workspace/muninn');
});

function candidate(overrides) {
  return {
    sessionKey: overrides.sessionKey,
    sessionLabel: overrides.sessionLabel,
    projectKey: overrides.projectKey,
    latestUpdatedAt: '2026-06-04T00:00:00.000Z',
    source: 'conversation',
    title: overrides.title ?? overrides.id,
    content: `content ${overrides.id}`,
    references: overrides.references ?? [],
    createdAt: '2026-06-04T00:00:00.000Z',
    score: overrides.score,
  };
}

function recallHit(overrides) {
  return {
    memoryId: overrides.memoryId ?? 'ext:1',
    title: overrides.title ?? 'Provider routing',
    summary: overrides.summary ?? 'Provider routing summary',
    content: overrides.content ?? 'provider routing should remain visual first',
    references: overrides.references ?? ['turn:1'],
    project: overrides.project ?? 'project-a',
    sessionId: Object.prototype.hasOwnProperty.call(overrides, 'sessionId') ? overrides.sessionId : 'session-a',
    agent: overrides.agent ?? 'codex_cli',
    cwd: overrides.cwd ?? '/workspace/project-a',
    sessionKey: overrides.sessionKey,
    displaySession: overrides.displaySession,
    createdAt: overrides.createdAt ?? '2026-06-04T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-06-04T00:00:00.000Z',
  };
}

function sessionScopeKey(projectKey, agent, sessionKey) {
  return `${projectKey}\u001f${agent}\u001f${sessionKey}`;
}
