import assert from 'node:assert/strict';
import test from 'node:test';

import core, { memories as backendMemories, sessions as backendSessions } from '../dist/backend.js';
import { app } from '../dist/http.js';

test.afterEach(async () => {
  await core.shutdownCoreForTests();
});

test('MCP recall default extraction mode does not render session candidate list', async (t) => {
  const originalRecall = backendMemories.recall;
  t.after(() => {
    backendMemories.recall = originalRecall;
  });

  let seenOptions = null;
  backendMemories.recall = async (query, limit, options) => {
    assert.equal(query, 'muninn wiki');
    assert.equal(limit, 3);
    seenOptions = options;
    return [{
      contextId: 'ext:123e4567-e89b-42d3-a456-426614174000',
      title: 'Muninn LLM Wiki extraction',
      summary: 'Extraction summary with session metadata.',
      content: 'Extraction detail.',
      references: [],
      project: 'project-a',
      agent: 'codex',
      sessionId: 'session-a',
      cwd: '/workspace/project-a',
    }];
  };

  const response = await app.request('/api/v1/mcp/recall', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'muninn wiki', top_k: 3 }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(seenOptions, {
    mode: 'extraction',
    budget: 4000,
    queryLimit: 3,
  });
  const text = await response.text();
  assert.match(text, /## ext:123e4567-e89b-42d3-a456-426614174000/);
  assert.match(text, /Preview: Extraction detail/);
  assert.doesNotMatch(text, /1\. Muninn LLM Wiki extraction/);
  assert.doesNotMatch(text, /context_id: session_/);
});

test('MCP recall session mode returns numbered session candidates', async (t) => {
  const originalRecall = backendMemories.recall;
  const originalList = backendSessions.list;
  t.after(() => {
    backendMemories.recall = originalRecall;
    backendSessions.list = originalList;
  });

  let seenOptions = null;
  backendMemories.recall = async (query, limit, options) => {
    assert.equal(query, 'readable session');
    assert.equal(limit, 2);
    seenOptions = options;
    return [{
      contextId: 'session:34',
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
    throw new Error('MCP session recall should not scan session snapshots after recall');
  };

  const response = await app.request('/api/v1/mcp/recall', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'readable session', top_k: 2, mode: 'session' }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(seenOptions, { mode: 'session' });
  const text = await response.text();
  assert.match(text, /# Muninn Recall/);
  assert.match(text, /1\. Readable session title/);
  assert.match(text, /context_id: session:34/);
  assert.match(text, /Readable session title/);
  assert.doesNotMatch(text, /Preview:/);
});

test('MCP recall session mode excludes current session when identity is provided by adapter', async (t) => {
  const originalRecall = backendMemories.recall;
  const originalList = backendSessions.list;
  t.after(() => {
    backendMemories.recall = originalRecall;
    backendSessions.list = originalList;
  });

  backendMemories.recall = async (query, limit, options) => {
    assert.equal(query, 'topic');
    assert.equal(limit, 2);
    assert.deepEqual(options, {
      mode: 'session',
      excludeSession: {
        project: 'project-a',
        agent: 'codex',
        sessionId: 'current-session',
      },
    });
    return [
      {
        contextId: 'session:41',
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
        contextId: 'session:42',
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
    throw new Error('MCP session recall should not scan session snapshots after recall');
  };

  const response = await app.request('/api/v1/mcp/recall', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'topic',
      top_k: 2,
      mode: 'session',
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
  assert.match(text, /First importable session/);
  assert.match(text, /Second importable session/);
});
