import assert from 'node:assert/strict';
import test from 'node:test';

import { recallMemories } from '../../dist/api/memory.js';

test('session recall hit uses latest session snapshot id as context id', async () => {
  const identity = {
    project: 'project-a',
    agent: 'codex',
    sessionId: 'session-a',
  };
  const client = {
    sessionTable: {
      search: async () => [{
        latestSnapshotId: 'session:42',
        project: identity.project,
        cwd: '/workspace/project-a',
        agent: identity.agent,
        sessionId: identity.sessionId,
        title: 'Readable session title',
        summary: 'Readable session summary',
        searchText: 'Readable session title\n\nReadable session summary',
        vector: [0, 1],
        updatedAt: '2024-01-03T00:00:00Z',
      }],
    },
  };

  const hits = await recallMemories(client, 'readable session', 10, {
    mode: 'session',
    embed: async () => [0, 1],
  });

  assert.equal(hits.length, 1);
  assert.equal(hits[0].contextId, 'session:42');
  assert.equal(hits[0].project, identity.project);
  assert.equal(hits[0].agent, identity.agent);
  assert.equal(hits[0].sessionId, identity.sessionId);
});
