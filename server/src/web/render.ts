import {
  fallbackRenderedContextTitle,
  inferRenderedContextKind,
  type RecallHit,
  renderRenderedContextMarkdown,
  type RenderedContext,
} from '../api/memory.js';
import type { MemoryDocument, MemoryHit } from '@muninn/common';

export function renderRenderedContextDocument(context: RenderedContext): MemoryDocument {
  return {
    contextId: context.contextId,
    kind: inferRenderedContextKind(context.contextId) as MemoryDocument['kind'],
    title: fallbackRenderedContextTitle(context),
    markdown: renderRenderedContextMarkdown(context),
    updatedAt: context.updatedAt,
  };
}

export function renderRenderedContextHit(record: RenderedContext): MemoryHit {
  return {
    contextId: record.contextId,
    content: renderRenderedContextMarkdown(record),
  };
}

export function renderRecallHit(record: RecallHit): MemoryHit {
  return {
    contextId: record.contextId ?? 'synthesis',
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
