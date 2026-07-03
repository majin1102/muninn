import assert from 'node:assert/strict';
import test from 'node:test';

import core, { memories as backendMemories, sessions as backendSessions } from '../dist/backend.js';
import { app } from '../dist/http.js';

test.afterEach(async () => {
  await core.shutdownCoreForTests();
});

test('MCP list searches session recall mode directly', async (t) => {
  const originalRecall = backendMemories.recall;
  const originalList = backendSessions.list;
  t.after(() => {
    backendMemories.recall = originalRecall;
    backendSessions.list = originalList;
  });

  let seenOptions = null;
  backendMemories.recall = async (query, limit, options) => {
    assert.equal(query, 'readable session');
    assert.equal(limit, 8);
    seenOptions = options;
    return [{
      memoryId: 'session:42',
      title: 'Readable session title',
      summary: 'Readable session summary',
      content: 'Readable session title\n\nReadable session summary',
      references: [],
      project: 'project-a',
      agent: 'codex',
      sessionId: 'session-a',
      cwd: '/workspace/project-a',
    }];
  };
  backendSessions.list = async () => {
    throw new Error('MCP list should not scan session snapshots after session recall');
  };

  const response = await app.request('/api/v1/mcp/list', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'readable session', top_k: 2 }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(seenOptions, { mode: 'session' });
  const text = await response.text();
  assert.match(text, /context_id: session_42/);
  assert.match(text, /Readable session title/);
});

test('MCP list fills candidates after excluding current session', async (t) => {
  const originalRecall = backendMemories.recall;
  const originalList = backendSessions.list;
  t.after(() => {
    backendMemories.recall = originalRecall;
    backendSessions.list = originalList;
  });

  backendMemories.recall = async (query, limit, options) => {
    assert.equal(query, 'topic');
    assert.equal(limit, 8);
    assert.deepEqual(options, { mode: 'session' });
    return [
      {
        memoryId: 'session:current',
        title: 'Current session',
        summary: 'Should be excluded',
        content: 'Current session\n\nShould be excluded',
        references: [],
        project: 'project-a',
        agent: 'codex',
        sessionId: 'current-session',
        cwd: '/workspace/project-a',
      },
      {
        memoryId: 'session:first',
        title: 'First importable session',
        summary: 'First summary',
        content: 'First importable session\n\nFirst summary',
        references: [],
        project: 'project-a',
        agent: 'codex',
        sessionId: 'first-session',
        cwd: '/workspace/project-a',
      },
      {
        memoryId: 'session:second',
        title: 'Second importable session',
        summary: 'Second summary',
        content: 'Second importable session\n\nSecond summary',
        references: [],
        project: 'project-a',
        agent: 'codex',
        sessionId: 'second-session',
        cwd: '/workspace/project-a',
      },
    ];
  };
  backendSessions.list = async () => {
    throw new Error('MCP list should not scan session snapshots after session recall');
  };

  const response = await app.request('/api/v1/mcp/list', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'topic',
      top_k: 2,
      session_identity: {
        project: 'project-a',
        agent: 'codex',
        sessionId: 'current-session',
      },
    }),
  });

  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /Current session/);
  assert.match(text, /context_id: session_first/);
  assert.match(text, /context_id: session_second/);
});
