import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inferRenderedMemoryKind,
  parseExtractionMemoryId,
  renderExtraction,
} from '../../dist/api/memory.js';

function extraction(overrides = {}) {
  return {
    id: 'abc123',
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
  assert.equal(parseExtractionMemoryId('ext:abc123'), 'abc123');
  assert.equal(renderExtraction(extraction()).memoryId, 'ext:abc123');
  assert.equal(inferRenderedMemoryKind('ext:abc123'), 'extraction');
});
