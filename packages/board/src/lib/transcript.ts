import type { MemoryDocument } from '@muninn/types';

export type TranscriptMessage = {
  role: 'user' | 'agent';
  label: string;
  body: string;
};

const rolePattern = /^##\s+(User|Human|Assistant|Agent|Model)\b[^\n]*\n([\s\S]*)$/i;

export function transcriptMessages(document: MemoryDocument): TranscriptMessage[] {
  const fromRoles = roleSectionMessages(document.markdown);
  if (fromRoles.length > 0) {
    return fromRoles;
  }

  const fromTurn = turnSectionMessages(document.markdown);
  if (fromTurn.length > 0) {
    return fromTurn;
  }

  const fromTurnDetail = turnDetailMessages(document.markdown);
  if (fromTurnDetail.length > 0) {
    return fromTurnDetail;
  }

  return [{
    role: 'agent',
    label: document.agent ?? document.observer ?? 'Memory',
    body: document.markdown,
  }];
}

function turnDetailMessages(markdown: string): TranscriptMessage[] {
  const detail = sectionBody(markdown, 'Detail');
  if (!detail) {
    return [];
  }

  const prompt = labeledBlock(detail, 'Prompt', ['Response']);
  const response = labeledBlock(detail, 'Response', ['Tools', 'Artifacts']);
  const messages: TranscriptMessage[] = [];
  if (prompt) {
    messages.push({ role: 'user', label: 'User', body: prompt });
  }
  if (response) {
    messages.push({ role: 'agent', label: 'Agent', body: response });
  }
  return messages;
}

function sectionBody(markdown: string, heading: string): string | null {
  const pattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, 'im');
  const match = markdown.match(pattern);
  return match?.[1]?.trim() || null;
}

function labeledBlock(text: string, label: string, stopLabels: string[]): string | null {
  const startPattern = new RegExp(`^${escapeRegExp(label)}:\\s*`, 'm');
  const start = text.search(startPattern);
  if (start < 0) {
    return null;
  }
  const valueStart = start + text.slice(start).match(startPattern)![0].length;
  let valueEnd = text.length;
  for (const stopLabel of stopLabels) {
    const stopPattern = new RegExp(`^${escapeRegExp(stopLabel)}:\\s*`, 'm');
    const relativeStop = text.slice(valueStart).search(stopPattern);
    if (relativeStop >= 0) {
      valueEnd = Math.min(valueEnd, valueStart + relativeStop);
    }
  }
  return text.slice(valueStart, valueEnd).trim() || null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function roleSectionMessages(markdown: string): TranscriptMessage[] {
  const blocks = markdown
    .split(/\n(?=##\s+)/)
    .map((block) => block.trim())
    .filter(Boolean);
  const messages: TranscriptMessage[] = [];

  for (const block of blocks) {
    if (/^#\s+/.test(block) && !/^##\s+/.test(block)) {
      continue;
    }

    const match = block.match(rolePattern);
    if (!match) {
      return [];
    }

    const label = match[1];
    const role = /^(user|human)$/i.test(label) ? 'user' : 'agent';
    messages.push({
      role,
      label: role === 'user' ? 'User' : 'Agent',
      body: match[2].trim(),
    });
  }

  return messages;
}

function turnSectionMessages(markdown: string): TranscriptMessage[] {
  const sections = new Map<string, string>();
  const matches = markdown.matchAll(/^##\s+(.+?)\s*\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/gm);

  for (const match of matches) {
    sections.set(match[1].trim().toLowerCase(), match[2].trim());
  }

  const messages: TranscriptMessage[] = [];
  const prompt = sections.get('prompt');
  const response = sections.get('response');
  const toolCalling = sections.get('tool calling');
  const toolArtifacts = sections.get('tool artifacts');

  if (prompt) {
    messages.push({ role: 'user', label: 'User', body: prompt });
  }
  if (toolCalling) {
    messages.push({ role: 'agent', label: 'Agent', body: `### Tool Calling\n\n${toolCalling}` });
  }
  if (response) {
    messages.push({ role: 'agent', label: 'Agent', body: response });
  }
  if (toolArtifacts) {
    messages.push({ role: 'agent', label: 'Agent', body: `### Artifacts\n\n${toolArtifacts}` });
  }

  return messages;
}
