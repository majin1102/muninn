import type { RenderedMemoryRecord } from './client.js';

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
