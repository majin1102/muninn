import assert from 'node:assert/strict';
import test from 'node:test';

import core, { memories as backendMemories } from '../dist/backend.js';
import { app } from '../dist/http.js';

test.afterEach(async () => {
  await core.shutdownCoreForTests();
});

test('MCP read renders extraction context references for session contexts', async (t) => {
  const originalGet = backendMemories.get;
  t.after(() => {
    backendMemories.get = originalGet;
  });

  backendMemories.get = async (memoryId) => {
    assert.equal(memoryId, 'session:42');
    return {
      memoryId: 'session:42',
      title: 'Session title',
      summary: 'Session summary',
      detail: '# Session title\n\n## Extractions\n...',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
      extractionContextRefs: [{
        contextId: 'ext:memory-1',
        title: 'Adoption agencies',
        summary: 'Adoption agencies\n\nCaroline compared adoption agencies.',
      }],
    };
  };

  const response = await app.request('/api/v1/mcp/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context_ids: ['session_42'] }),
  });

  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /## Extraction Context References/);
  assert.match(text, /context_id: ext:memory-1/);
  assert.match(text, /Adoption agencies/);
});
