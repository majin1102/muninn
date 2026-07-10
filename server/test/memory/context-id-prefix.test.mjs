import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inferRenderedContextKind,
  parseContextId,
  renderExtraction,
} from '../../dist/api/memory.js';

function extraction(overrides = {}) {
  return {
    id: '123e4567-e89b-42d3-a456-426614174002',
    title: 'MCP schema',
    summary: 'Recall/read/explain naming',
    content: 'Use short public context ids.',
    turnRefs: ['turn:one'],
    createdAt: '2026-06-27T00:00:00.000Z',
    updatedAt: '2026-06-27T00:00:00.000Z',
    ...overrides,
  };
}

test('extraction context ids use the ext prefix', () => {
  assert.equal(parseContextId('ext:123e4567-e89b-42d3-a456-426614174002').id, '123e4567-e89b-42d3-a456-426614174002');
  assert.equal(renderExtraction(extraction()).contextId, 'ext:123e4567-e89b-42d3-a456-426614174002');
  assert.equal(inferRenderedContextKind('ext:123e4567-e89b-42d3-a456-426614174002'), 'extraction');
});
