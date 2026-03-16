import type { MemoryHit } from '@munnai/types';
import type { StoredTurn } from './storage.js';

function renderRecordBlock(title: string, value: Record<string, string>): string {
  const lines = Object.entries(value).map(([key, entry]) => `- ${key}: ${entry}`);
  return [`## ${title}`, '', ...lines].join('\n');
}

function renderListBlock(title: string, value: string[]): string {
  const lines = value.map((entry) => `- ${entry}`);
  return [`## ${title}`, '', ...lines].join('\n');
}

export function renderTurnHit(turn: StoredTurn): MemoryHit {
  const sections = [
    `# ${turn.turnId}`,
    '',
    `- Agent: ${turn.agent}`,
    `- Created At: ${turn.createdAt}`,
  ];

  if (turn.summary) {
    sections.push('', '## Summary', '', turn.summary);
  }

  if (turn.details) {
    sections.push('', '## Details', '', turn.details);
  }

  if (turn.prompt) {
    sections.push('', '## Prompt', '', turn.prompt);
  }

  if (turn.response) {
    sections.push('', '## Response', '', turn.response);
  }

  if (turn.tool_calling && turn.tool_calling.length > 0) {
    sections.push('', renderListBlock('Tool Calling', turn.tool_calling));
  }

  if (turn.artifacts && Object.keys(turn.artifacts).length > 0) {
    sections.push('', renderRecordBlock('Tool Artifacts', turn.artifacts));
  }

  return {
    memoryId: turn.turnId,
    content: sections.join('\n'),
  };
}
