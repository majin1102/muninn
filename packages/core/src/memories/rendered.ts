import type { SessionSnapshot, RenderedMemory, Turn } from '../client.js';
import type { SessionObservation, GlobalObservation } from '../native.js';

export function inferRenderedMemoryKind(memoryId: string): 'turn' | 'session' | 'session_observation' | 'global_observation' {
  if (memoryId.startsWith('turn:')) {
    return 'turn';
  }
  if (memoryId.startsWith('session_observation:')) {
    return 'session_observation';
  }
  if (memoryId.startsWith('global_observation:')) {
    return 'global_observation';
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

export function renderSessionObservation(memory: SessionObservation): RenderedMemory {
  const content = trimText(memory.content)
    ? `Content:\n${memory.content.trim()}`
    : undefined;
  const references = memory.turnRefs.length > 0
    ? `References:\n${memory.turnRefs.map((ref) => `- ${ref}`).join('\n')}`
    : undefined;
  const detail = [content, references].filter(Boolean).join('\n\n') || undefined;
  return {
    memoryId: `session_observation:${memory.id}`,
    title: memory.title,
    summary: memory.summary,
    detail,
    createdAt: memory.createdAt,
    updatedAt: memory.createdAt,
  };
}

export function renderGlobalObservation(memory: GlobalObservation): RenderedMemory {
  const references = memory.sessionObservationRefs.length > 0
    ? `References:\n${memory.sessionObservationRefs.map((ref) => `- ${renderSessionObservationRef(ref)}`).join('\n')}`
    : undefined;
  return {
    memoryId: `global_observation:${memory.id}`,
    title: memory.text,
    summary: memory.text,
    detail: references,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

function renderSessionObservationRef(ref: string): string {
  return ref.startsWith('session_observation:') ? ref : `session_observation:${ref}`;
}

export function renderTurnDetail(turn: Turn): string | undefined {
  const lines: string[] = [];
  if (trimText(turn.prompt)) {
    lines.push(`Prompt: ${turn.prompt!.trim()}`);
  }
  if (trimText(turn.response)) {
    lines.push(`Response: ${turn.response!.trim()}`);
  }
  const toolNames = turn.events
    .filter((event) => event.type === 'toolCall')
    .map((event) => event.name);
  if (toolNames.length > 0) {
    lines.push(`Tools: ${toolNames.join(', ')}`);
  }
  if (turn.artifacts && turn.artifacts.length > 0) {
    const rendered = [...turn.artifacts]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((artifact) => {
        const value = artifact.content ?? artifact.name ?? artifact.uri ?? artifact.kind;
        return `${artifact.key}: ${value}`;
      })
      .join(', ');
    lines.push(`Artifacts: ${rendered}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function trimText(value?: string | null): string | undefined {
  return value?.trim() ? value.trim() : undefined;
}
