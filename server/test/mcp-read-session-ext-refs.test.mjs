import assert from 'node:assert/strict';
import test from 'node:test';

import core, { memories as backendMemories } from '../dist/backend.js';
import { app } from '../dist/http.js';

test.afterEach(async () => {
  await core.shutdownCoreForTests();
});

test('MCP read returns compact session extraction summaries with context ids', async (t) => {
  const extractionId = '123e4567-e89b-42d3-a456-426614174000';
  const sessionContext = 'session:34';
  const longSummary = [
    'Caroline compared adoption agency options across cost, wait time, and LGBT friendliness.',
    'She wanted enough detail for later follow-up without importing the complete source notes.',
  ].join(' ');
  const originalGetContext = backendMemories.getContext;
  t.after(() => {
    backendMemories.getContext = originalGetContext;
  });

  backendMemories.getContext = async (contextId) => {
    assert.equal(contextId, sessionContext);
    return {
      contextId: sessionContext,
      title: 'Session title',
      summary: 'Session summary',
      detail: [
        '# Session title',
        '',
        '## Summary',
        'Session summary',
        '',
        '## Instruction Signals',
        '',
        '## Skill Signals',
        '',
        '## Skill Details',
        '',
        '## Extractions',
        `<!-- context_id: ext:${extractionId}; refs: [turn:1] -->`,
        '### Title',
        'Adoption agencies hidden title',
        '',
        '### Summary',
        longSummary,
        '',
        '### Content',
        'Hidden detailed content that should only be loaded through ext:*.',
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
    body: JSON.stringify({ context_ids: [sessionContext] }),
  });

  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /## Extraction Context References/);
  assert.match(text, new RegExp(`context_id: ext:${extractionId}`));
  assert.match(text, /summary: Caroline compared adoption agency options/);
  assert.doesNotMatch(text, /Adoption agencies hidden title/);
  assert.doesNotMatch(text, /Hidden detailed content/);
  assert.doesNotMatch(text, /refs: \[turn:1\]/);
  const summaryLine = text.split('\n').find((line) => line.trim().startsWith('summary:'));
  assert.ok(summaryLine);
  assert.ok(summaryLine.trim().slice('summary: '.length).length <= 100);
});
