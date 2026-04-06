import type { RenderedMemoryRecord } from '../client.js';
import type { SessionTurnRow } from '../session/types.js';
import type { ObservingRecord } from '../client.js';

export function inferRenderedMemoryKind(memoryId: string): 'session' | 'observing' {
  return memoryId.startsWith('observing:') ? 'observing' : 'session';
}

export function fallbackRenderedMemoryTitle(memory: RenderedMemoryRecord): string {
  return memory.title ?? memory.summary ?? memory.detail ?? memory.memoryId;
}

export function renderRenderedMemoryMarkdown(memory: RenderedMemoryRecord): string {
  const sections = [`# ${memory.memoryId}`];
  if (memory.title) {
    sections.push('', '## Title', '', memory.title);
  }
  sections.push('', '## Created At', '', memory.createdAt);
  sections.push('', '## Updated At', '', memory.updatedAt);
  if (memory.summary) {
    sections.push('', '## Summary', '', memory.summary);
  }
  if (memory.detail) {
    sections.push('', '## Detail', '', memory.detail);
  }
  return sections.join('\n');
}

export function renderSessionTurn(memory: SessionTurnRow): RenderedMemoryRecord | null {
  const title = trimText(memory.title);
  const summary = trimText(memory.summary);
  const detail = renderSessionTurnDetail(memory);
  if (!title && !summary && !detail) {
    return null;
  }
  return {
    memoryId: memory.turnId,
    title,
    summary,
    detail,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

export function renderObservingSnapshot(memory: ObservingRecord): RenderedMemoryRecord | null {
  const title = trimText(memory.title);
  const summary = trimText(memory.summary);
  const detail = trimText(memory.content);
  if (!title && !summary && !detail) {
    return null;
  }
  return {
    memoryId: memory.snapshotId,
    title,
    summary,
    detail,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

export function renderSessionTurnDetail(turn: SessionTurnRow): string | undefined {
  const lines: string[] = [];
  if (trimText(turn.prompt)) {
    lines.push(`Prompt: ${turn.prompt!.trim()}`);
  }
  if (trimText(turn.response)) {
    lines.push(`Response: ${turn.response!.trim()}`);
  }
  if (turn.toolCalling && turn.toolCalling.length > 0) {
    lines.push(`Tools: ${turn.toolCalling.join(', ')}`);
  }
  if (turn.artifacts && Object.keys(turn.artifacts).length > 0) {
    const rendered = Object.entries(turn.artifacts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ');
    lines.push(`Artifacts: ${rendered}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function trimText(value?: string | null): string | undefined {
  return value?.trim() ? value.trim() : undefined;
}
