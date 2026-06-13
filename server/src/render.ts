import {
  renderRenderedMemoryMarkdown,
  type RecallHit,
  type RenderedMemory,
} from './memory/index.js';
import type { MemoryHit } from '@muninn/common';

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
