import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadSearchState() {
  const identitySource = await readFile(new URL('../../common/src/session-identity.ts', import.meta.url), 'utf8');
  const stateSource = await readFile(new URL('../src/lib/search-state.ts', import.meta.url), 'utf8');
  const source = `${identitySource}\n${stateSource
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
      cwd: '/workspace/muninn',
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
      cwd: '/workspace/lance',
      latestUpdatedAt: '2026-06-04T00:00:00.000Z',
      turns: [],
      segments: [],
      nextOffset: null,
      loading: false,
      loaded: false,
    }],
  }];

  assert.deepEqual(sessionOptionsForProjects(projects, []).map(({ agent, label, sessionKey, value }) => ({ agent, label, sessionKey, value })), [{
    agent: 'codex_cli',
    label: 'search-design',
    sessionKey: 'muninn/search-design',
    value: sessionOptionValue('muninn', 'codex_cli', 'muninn/search-design'),
  }, {
    agent: 'claude_code',
    label: 'lance-search',
    sessionKey: 'lance/search-design',
    value: sessionOptionValue('lance', 'claude_code', 'lance/search-design'),
  }]);
  assert.deepEqual(sessionOptionsForProjects(projects, ['muninn']).map(({ agent, label, sessionKey, value }) => ({ agent, label, sessionKey, value })), [{
    agent: 'codex_cli',
    label: 'search-design',
    sessionKey: 'muninn/search-design',
    value: sessionOptionValue('muninn', 'codex_cli', 'muninn/search-design'),
  }]);
});

test('sessionOptionsForProjects disambiguates duplicate session keys by agent', async () => {
  const { sessionKeysForRequest, sessionOptionsForProjects } = await loadSearchState();
  const projects = [{
    projectKey: 'auth-refactor',
    label: 'auth-refactor',
    latestUpdatedAt: '2026-06-04T00:00:00.000Z',
    sessions: ['openclaw', 'claude_code'].map((agent) => ({
      agent,
      sessionKey: 'auth-refactor',
      displaySessionId: 'auth-refactor',
      cwd: `/workspace/${agent}/auth-refactor`,
      latestUpdatedAt: '2026-06-04T00:00:00.000Z',
      turns: [],
      segments: [],
      nextOffset: null,
      loading: false,
      loaded: false,
    })),
  }];

  const options = sessionOptionsForProjects(projects, []);

  assert.notEqual(options[0].value, options[1].value);
  assert.deepEqual(options.map((option) => option.description), [
    'auth-refactor / openclaw',
    'auth-refactor / claude_code',
  ]);
  assert.deepEqual(sessionKeysForRequest([options[0].value], options), [sessionOptionValue('auth-refactor', 'openclaw', 'auth-refactor')]);
});

test('sessionOptionsForProjects treats duplicate session keys across cwd as one identity', async () => {
  const { sessionKeysForRequest, sessionOptionsForProjects } = await loadSearchState();
  const projects = [{
    projectKey: '/workspace/muninn',
    label: 'muninn',
    latestUpdatedAt: '2026-06-04T00:00:00.000Z',
    sessions: ['aaaa', 'bbbb'].map((worktree) => ({
      agent: 'codex',
      sessionKey: 'same-session',
      displaySessionId: 'same-session',
      cwd: `/Users/Nathan/.codex/worktrees/${worktree}/muninn`,
      latestUpdatedAt: '2026-06-04T00:00:00.000Z',
      turns: [],
      segments: [],
      nextOffset: null,
      loading: false,
      loaded: false,
    })),
  }];

  const options = sessionOptionsForProjects(projects, []);

  assert.equal(options[0].value, options[1].value);
  assert.deepEqual(sessionKeysForRequest([options[1].value], options), [
    sessionOptionValue('/workspace/muninn', 'codex', 'same-session'),
  ]);
});

test('normalizeSearchN keeps positive integer select values only', async () => {
  const { normalizeSearchN } = await loadSearchState();
  assert.equal(normalizeSearchN('5', 3), 5);
  assert.equal(normalizeSearchN('0', 3), 3);
  assert.equal(normalizeSearchN('abc', 3), 3);
});

function sessionOptionValue(projectKey, agent, sessionKey) {
  return `${projectKey}\u001f${agent}\u001f${sessionKey}`;
}
