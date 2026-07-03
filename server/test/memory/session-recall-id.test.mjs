import assert from 'node:assert/strict';
import test from 'node:test';

import { recallMemories } from '../../dist/api/memory.js';

test('session recall hit uses latest snapshot id as memoryId', async () => {
  const client = {
    sessionTable: {
      search: async () => [{
        latestSnapshotId: 'session:42',
        project: 'project-a',
        cwd: '/workspace/project-a',
        agent: 'codex',
        sessionId: 'session-a',
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
  assert.equal(hits[0].memoryId, 'session:42');
  assert.equal(hits[0].project, 'project-a');
  assert.equal(hits[0].agent, 'codex');
  assert.equal(hits[0].sessionId, 'session-a');
});
