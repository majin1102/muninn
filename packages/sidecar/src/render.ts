import {
  renderRenderedMemoryMarkdown,
  type RecallHitRecord,
  type RenderedMemoryRecord,
} from '@munnai/core';
import type { MemoryHit } from '@munnai/types';

export function renderRenderedMemoryHit(record: RenderedMemoryRecord): MemoryHit {
  return {
    memoryId: record.memoryId,
    content: renderRenderedMemoryMarkdown(record),
  };
}

export function renderRecallHit(record: RecallHitRecord): MemoryHit {
  return {
    memoryId: record.memoryId,
    content: record.text,
  };
}
