import type { MemoryHit } from '@munnai/types';
import type { StoredMessage } from './storage.js';

function renderRecordBlock(title: string, value: Record<string, string>): string {
  const lines = Object.entries(value).map(([key, entry]) => `- ${key}: ${entry}`);
  return [`## ${title}`, '', ...lines].join('\n');
}

function renderListBlock(title: string, value: string[]): string {
  const lines = value.map((entry) => `- ${entry}`);
  return [`## ${title}`, '', ...lines].join('\n');
}

export function renderMessageHit(message: StoredMessage): MemoryHit {
  const sections = [
    `# ${message.turnId}`,
    '',
    `- Agent: ${message.agent}`,
    `- Created At: ${message.createdAt}`,
  ];

  if (message.summary) {
    sections.push('', '## Summary', '', message.summary);
  }

  if (message.details) {
    sections.push('', '## Details', '', message.details);
  }

  if (message.prompt) {
    sections.push('', '## Prompt', '', message.prompt);
  }

  if (message.response) {
    sections.push('', '## Response', '', message.response);
  }

  if (message.trace && message.trace.length > 0) {
    sections.push('', renderListBlock('Trace', message.trace));
  }

  if (message.artifacts && Object.keys(message.artifacts).length > 0) {
    sections.push('', renderRecordBlock('Artifacts', message.artifacts));
  }

  return {
    memoryId: message.turnId,
    content: sections.join('\n'),
  };
}
