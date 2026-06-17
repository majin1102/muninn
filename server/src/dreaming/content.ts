export type ProjectDreamSignals = {
  guidance: string[];
  skills: string[];
  openQuestions: string[];
};

export function validateProjectDreamContent(content: string): void {
  const text = stripFence(content).trim();
  if (!text.startsWith('# Project Dream')) {
    throw new Error('project dream content must start with # Project Dream');
  }
  if (!/^## Signals$/m.test(text)) {
    throw new Error('project dream content must include ## Signals');
  }
  for (const heading of ['### Guidance', '### Skills', '### Open Questions']) {
    if (!text.includes(heading)) {
      throw new Error(`project dream content must include ${heading}`);
    }
  }
  if (/\(refs:\s*session:\d+/i.test(text) || /session:<rowid>/i.test(text)) {
    throw new Error('project dream content must not include session refs');
  }
}

export function normalizeProjectDreamContent(content: string): string {
  const text = stripFence(content).trim();
  validateProjectDreamContent(text);
  return text;
}

export function parseProjectDreamSignals(content: string, limit = 5): ProjectDreamSignals {
  const text = normalizeProjectDreamContent(content);
  return {
    guidance: parseCategory(text, '### Guidance', limit),
    skills: parseCategory(text, '### Skills', limit),
    openQuestions: parseCategory(text, '### Open Questions', limit),
  };
}

function stripFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/i.exec(trimmed);
  return match ? match[1] : trimmed;
}

function parseCategory(content: string, heading: string, limit: number): string[] {
  const start = content.indexOf(heading);
  if (start < 0) {
    return [];
  }
  const afterHeading = content.slice(start + heading.length).split('\n');
  const blocks: Array<{ weight: number; index: number; text: string }> = [];
  let current: string[] | null = null;

  for (const line of afterHeading) {
    if (line.startsWith('### ')) {
      break;
    }
    if (/^- \[\d+\]\s+/.test(line)) {
      if (current) {
        blocks.push(block(current, blocks.length));
      }
      current = [line];
      continue;
    }
    if (current && (line.startsWith('  ') || line.trim() === '')) {
      current.push(line);
    }
  }
  if (current) {
    blocks.push(block(current, blocks.length));
  }

  return blocks
    .sort((left, right) => right.weight - left.weight || left.index - right.index)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.text);
}

function block(lines: string[], index: number): { weight: number; index: number; text: string } {
  const text = lines.join('\n').trimEnd();
  const weight = Number(/^- \[(\d+)\]/.exec(lines[0])?.[1] ?? '1');
  return { weight, index, text };
}
