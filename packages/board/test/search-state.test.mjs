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

test('buildSearchParams omits sessionKey when project is all', async () => {
  const { buildSearchParams } = await loadSearchState();
  const params = buildSearchParams({
    query: 'board search',
    projectKey: 'all',
    sessionKey: 'muninn/session-a',
    sessionTopN: 3,
    topN: 20,
  });

  assert.equal(params.toString(), 'query=board+search&sessionTopN=3&topN=20');
});

test('sessionOptionsForProject disables sessions for all projects', async () => {
  const { sessionOptionsForProject } = await loadSearchState();
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
  }];

  assert.deepEqual(sessionOptionsForProject(projects, 'all'), []);
  assert.deepEqual(sessionOptionsForProject(projects, 'muninn'), [{
    label: 'search-design',
    value: 'muninn/search-design',
  }]);
});
