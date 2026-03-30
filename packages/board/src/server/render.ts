import {
  fallbackRenderedMemoryTitle,
  inferRenderedMemoryKind,
  renderRenderedMemoryMarkdown,
  type RenderedMemoryRecord,
} from '@munnai/core';
import type { MemoryDocument } from '@munnai/types';

export function renderRenderedMemoryDocument(memory: RenderedMemoryRecord): MemoryDocument {
  return {
    memoryId: memory.memoryId,
    kind: inferRenderedMemoryKind(memory.memoryId) as MemoryDocument['kind'],
    title: fallbackRenderedMemoryTitle(memory),
    markdown: renderRenderedMemoryMarkdown(memory),
    updatedAt: memory.updatedAt,
  };
}
