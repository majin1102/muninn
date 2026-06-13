import {
  fallbackRenderedMemoryTitle,
  inferRenderedMemoryKind,
  renderRenderedMemoryMarkdown,
  type RenderedMemory,
} from '../memory/index.js';
import type { MemoryDocument } from '@muninn/common';

export function renderRenderedMemoryDocument(memory: RenderedMemory): MemoryDocument {
  return {
    memoryId: memory.memoryId,
    kind: inferRenderedMemoryKind(memory.memoryId) as MemoryDocument['kind'],
    title: fallbackRenderedMemoryTitle(memory),
    markdown: renderRenderedMemoryMarkdown(memory),
    updatedAt: memory.updatedAt,
  };
}
