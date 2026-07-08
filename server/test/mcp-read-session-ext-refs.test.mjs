import assert from 'node:assert/strict';
import test from 'node:test';

import core, { memories as backendMemories } from '../dist/backend.js';
import { app } from '../dist/http.js';

test.afterEach(async () => {
  await core.shutdownCoreForTests();
});

test('MCP read returns inline session context ids without appended extraction references', async (t) => {
  const extractionId = '123e4567-e89b-42d3-a456-426614174000';
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
      detail: [
        '# Session title',
        '',
        '## Extractions',
        `<!-- context_id: ext:${extractionId}; refs: [turn:1] -->`,
        '### Title',
        'Adoption agencies',
      ].join('\n'),
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
      extractionContextRefs: [{
        contextId: `ext:${extractionId}`,
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
  assert.doesNotMatch(text, /## Extraction Context References/);
  assert.match(text, new RegExp(`context_id: ext:${extractionId}`));
  assert.match(text, /Adoption agencies/);
});
