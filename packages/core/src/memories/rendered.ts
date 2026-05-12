import type { SessionSnapshot, RenderedMemory, Turn } from '../client.js';
import type { Extraction } from '../native.js';

export function inferRenderedMemoryKind(memoryId: string): 'turn' | 'session' | 'extraction' {
  if (memoryId.startsWith('turn:')) {
    return 'turn';
  }
  if (memoryId.startsWith('extraction:')) {
    return 'extraction';
  }
  return 'session';
}

export function fallbackRenderedMemoryTitle(memory: RenderedMemory): string {
  return memory.title ?? memory.summary ?? memory.detail ?? memory.memoryId;
}

export function renderRenderedMemoryMarkdown(memory: RenderedMemory): string {
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

export function renderTurn(memory: Turn): RenderedMemory | null {
  const title = trimText(memory.title);
  const summary = trimText(memory.summary);
  const detail = renderTurnDetail(memory);
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

export function renderSessionSnapshot(memory: SessionSnapshot): RenderedMemory | null {
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

export function renderExtraction(memory: Extraction): RenderedMemory {
  const anchors = (memory.anchors ?? []).length > 0
    ? `Anchors:\n${memory.anchors.map((anchor) => `- ${anchor}`).join('\n')}`
    : undefined;
  const context = trimText(memory.context)
    ? `Context:\n${memory.context!.trim()}`
    : undefined;
  const references = memory.references.length > 0
    ? `References:\n${memory.references.map((ref) => `- ${ref}`).join('\n')}`
    : undefined;
  const detail = [anchors, context, references].filter(Boolean).join('\n\n') || undefined;
  return {
    memoryId: `extraction:${memory.id}`,
    title: memory.text,
    summary: memory.text,
    detail,
    createdAt: memory.createdAt,
    updatedAt: memory.createdAt,
  };
}

export function renderTurnDetail(turn: Turn): string | undefined {
  const lines: string[] = [];
  if (trimText(turn.prompt)) {
    lines.push(`Prompt: ${turn.prompt!.trim()}`);
  }
  if (trimText(turn.response)) {
    lines.push(`Response: ${turn.response!.trim()}`);
  }
  if (turn.toolCalls && turn.toolCalls.length > 0) {
    lines.push(`Tools: ${turn.toolCalls.map((toolCall) => toolCall.name).join(', ')}`);
  }
  if (turn.artifacts && turn.artifacts.length > 0) {
    const rendered = [...turn.artifacts]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((artifact) => `${artifact.key}: ${artifact.content}`)
      .join(', ');
    lines.push(`Artifacts: ${rendered}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function trimText(value?: string | null): string | undefined {
  return value?.trim() ? value.trim() : undefined;
}
