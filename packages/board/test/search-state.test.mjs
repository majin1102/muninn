import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadSearchState() {
  const source = await readFile(new URL('../src/lib/search_state.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

test('buildSearchParams appends multi-select scope params', async () => {
  const { buildSearchParams } = await loadSearchState();
  const params = buildSearchParams({
    query: 'board search',
    projectKeys: ['muninn', 'lance'],
    sessionKeys: ['muninn/session-a', 'lance/session-b'],
    sessionTopN: 3,
    topN: 20,
  });

  assert.equal(params.toString(), 'query=board+search&sessionTopN=3&topN=20&projectKey=muninn&projectKey=lance&sessionKey=muninn%2Fsession-a&sessionKey=lance%2Fsession-b');
});

test('sessionOptionsForProjects lists all sessions until projects are selected', async () => {
  const { sessionOptionsForProjects } = await loadSearchState();
  const projects = [{
    projectKey: 'muninn',
    label: 'muninn',
    latestUpdatedAt: '2026-06-04T00:00:00.000Z',
    sessions: [{
      agent: 'codex_cli',
      sessionKey: 'muninn/search-design',
      displaySessionId: 'search-design',
      latestUpdatedAt: '2026-06-04T00:00:00.000Z',
      turns: [],
      segments: [],
      nextOffset: null,
      loading: false,
      loaded: false,
    }],
  }, {
    projectKey: 'lance',
    label: 'lance',
    latestUpdatedAt: '2026-06-04T00:00:00.000Z',
    sessions: [{
      agent: 'claude_code',
      sessionKey: 'lance/search-design',
      displaySessionId: 'lance-search',
      latestUpdatedAt: '2026-06-04T00:00:00.000Z',
      turns: [],
      segments: [],
      nextOffset: null,
      loading: false,
      loaded: false,
    }],
  }];

  assert.deepEqual(sessionOptionsForProjects(projects, []).map(({ label, value }) => ({ label, value })), [{
    label: 'search-design',
    value: 'muninn/search-design',
  }, {
    label: 'lance-search',
    value: 'lance/search-design',
  }]);
  assert.deepEqual(sessionOptionsForProjects(projects, ['muninn']).map(({ label, value }) => ({ label, value })), [{
    label: 'search-design',
    value: 'muninn/search-design',
  }]);
});

test('normalizeSearchN keeps positive integer select values only', async () => {
  const { normalizeSearchN } = await loadSearchState();
  assert.equal(normalizeSearchN('5', 3), 5);
  assert.equal(normalizeSearchN('0', 3), 3);
  assert.equal(normalizeSearchN('abc', 3), 3);
});
