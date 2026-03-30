import { renderRenderedMemoryMarkdown, type RenderedMemoryRecord } from '@munnai/core';
import type { MemoryHit } from '@munnai/types';

export function renderRenderedMemoryHit(record: RenderedMemoryRecord): MemoryHit {
  return {
    memoryId: record.memoryId,
    content: renderRenderedMemoryMarkdown(record),
  };
}
