import {
  fallbackRenderedMemoryTitle,
  inferRenderedMemoryKind,
  type RecallHit,
  renderRenderedMemoryMarkdown,
  type RenderedMemory,
} from '../api/memory.js';
import type { MemoryDocument, MemoryHit } from '@muninn/common';

export function renderRenderedMemoryDocument(memory: RenderedMemory): MemoryDocument {
  return {
    memoryId: memory.memoryId,
    kind: inferRenderedMemoryKind(memory.memoryId) as MemoryDocument['kind'],
    title: fallbackRenderedMemoryTitle(memory),
    markdown: renderRenderedMemoryMarkdown(memory),
    updatedAt: memory.updatedAt,
  };
}

export function renderRenderedMemoryHit(record: RenderedMemory): MemoryHit {
  return {
    memoryId: record.memoryId,
    content: renderRenderedMemoryMarkdown(record),
  };
}

export function renderRecallHit(record: RecallHit): MemoryHit {
  return {
    memoryId: record.memoryId,
    title: record.title,
    summary: record.summary,
    content: record.content,
    references: record.references,
    project: record.project,
    sessionId: record.sessionId,
    agent: record.agent,
    cwd: record.cwd,
    sessionKey: record.sessionKey,
    displaySession: record.displaySession,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
