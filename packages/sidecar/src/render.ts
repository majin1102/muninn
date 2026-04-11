import {
  renderRenderedMemoryMarkdown,
  type RecallHit,
  type RenderedMemory,
} from '@muninn/core';
import type { MemoryHit } from '@muninn/types';

export function renderRenderedMemoryHit(record: RenderedMemory): MemoryHit {
  return {
    memoryId: record.memoryId,
    content: renderRenderedMemoryMarkdown(record),
  };
}

export function renderRecallHit(record: RecallHit): MemoryHit {
  return {
    memoryId: record.memoryId,
    content: record.text,
  };
}
