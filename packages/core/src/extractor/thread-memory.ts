import type { Extraction, ExtractionCategory } from './types.js';

type ThreadMemoryAnchor = {
  name: Extract<ExtractionCategory, 'Entity' | 'Fact' | 'Decision' | 'Preference'>;
  phrase: string;
};

export type ParsedThreadMemoryDocument = {
  title: string;
  summary: string;
  threadMemory: string;
  extractionMarkdown: string;
  extractions: Extraction[];
};

export function parseThreadMemoryDocument(
  raw: string,
  validReferences: Set<string>,
): ParsedThreadMemoryDocument {
  const threadMemory = stripMarkdownFence(typeof raw === 'string' ? raw.trim() : '');
  if (!threadMemory) {
    throw new Error('extraction update returned empty threadMemory');
  }
  if (/^\s*\{/.test(threadMemory)) {
    throw new Error('observe result must return thread memory Markdown, not JSON');
  }

  const lines = threadMemory.split(/\r?\n/);
  const titleIndexes = headingIndexes(lines, 1, null);
  if (titleIndexes.length !== 1) {
    throw new Error('threadMemory document must include exactly one # title');
  }
  const summaryIndex = headingIndexes(lines, 2, 'Summary')[0];
  if (summaryIndex === undefined) {
    throw new Error('threadMemory document must include ## Summary');
  }
  const extractionsIndex = headingIndexes(lines, 2, 'Extractions')[0];
  if (extractionsIndex === undefined) {
    throw new Error('threadMemory document must include ## Extractions');
  }
  if (!(titleIndexes[0] < summaryIndex && summaryIndex < extractionsIndex)) {
    throw new Error('threadMemory document headings must be ordered # title, ## Summary, ## Extractions');
  }

  const title = normalizeText(lines[titleIndexes[0]]!.replace(/^#\s+/, ''));
  if (!title) {
    throw new Error('threadMemory document title cannot be empty');
  }
  const summary = lines.slice(summaryIndex + 1, extractionsIndex).join('\n').trim();
  if (!normalizeText(summary)) {
    throw new Error('threadMemory document summary cannot be empty');
  }
  if (wordCount(summary) > 500) {
    throw new Error('threadMemory document summary must be 500 words or fewer');
  }

  const extractionMarkdown = lines.slice(extractionsIndex + 1).join('\n').trim();
  return {
    title,
    summary: summary.trim(),
    threadMemory,
    extractionMarkdown,
    extractions: parseThreadMemoryUnits(extractionMarkdown, validReferences),
  };
}

export function parseThreadMemoryUnits(
  threadMemory: string,
  validReferences: Set<string>,
): Extraction[] {
  if (!threadMemory.trim()) {
    return [];
  }

  const extractions: Extraction[] = [];
  const units = threadMemory
    .split(/^\s*----\s*$/m)
    .map((unit) => unit.trim())
    .filter(Boolean);

  for (const unit of units) {
    const lines = unit.split(/\r?\n/);
    const metadata = parseThreadMemoryMetadata(lines[0] ?? '');
    if (!metadata) {
      throw new Error('threadMemory unit must start with metadata comment');
    }
    const body = parseThreadMemoryBody(lines.slice(1));
    const text = normalizeText(body.extraction);
    if (!text) {
      throw new Error('threadMemory unit must include [Extraction]');
    }
    validateThreadMemoryReferences(metadata.references, validReferences);
    extractions.push({
      text,
      context: normalizeText(body.context ?? '') || null,
      anchors: renderThreadMemoryAnchors(body.anchors),
      category: body.anchors[0].name,
      references: metadata.references,
    });
  }
  return extractions;
}

export function stripMarkdownFence(value: string): string {
  const match = value.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  return (match?.[1] ?? value).trim();
}

function headingIndexes(lines: string[], level: number, label: string | null): number[] {
  const hashes = '#'.repeat(level);
  const regex = new RegExp(`^${hashes}\\s+(.+?)\\s*$`);
  return lines.flatMap((line, index) => {
    const match = line.match(regex);
    if (!match) {
      return [];
    }
    const text = normalizeText(match[1] ?? '');
    if (label !== null && text.toLowerCase() !== label.toLowerCase()) {
      return [];
    }
    return [index];
  });
}

function parseThreadMemoryBody(lines: string[]): { anchors: ThreadMemoryAnchor[]; context?: string; extraction: string } {
  const content = lines.join('\n').trim();
  const extractionMatch = content.match(/(?:^|\n)\s*\[Extraction\]\s*([\s\S]*?)(?=\n\s*\[Context\]|\n\s*\[Extraction\]|\s*$)/);
  if (!extractionMatch) {
    return { anchors: parseThreadMemoryAnchors(lines), extraction: '' };
  }
  const contextMatch = content.match(/(?:^|\n)\s*\[Context\]\s*([\s\S]*?)(?=\n\s*\[Extraction\]|\n\s*\[Context\]|\s*$)/);
  return {
    anchors: parseThreadMemoryAnchors(lines),
    context: contextMatch?.[1],
    extraction: extractionMatch[1] ?? '',
  };
}

function parseThreadMemoryMetadata(
  value: string,
): { references: string[] } | null {
  const match = value.match(/^\s*<!--\s*refs:\s*\[([^\]]*)\]\s*-->\s*$/i);
  if (!match) {
    return null;
  }
  return {
    references: parseThreadMemoryRefs(match[1]),
  };
}

function parseThreadMemoryRefs(value: string): string[] {
  const references = value
    .split(',')
    .map((reference) => reference.trim())
    .filter(Boolean);
  if (references.length === 0) {
    throw new Error('threadMemory metadata refs must include at least one reference');
  }
  return [...new Set(references)];
}

function validateThreadMemoryReferences(references: string[], validReferences: Set<string>): void {
  if (references.length === 0) {
    throw new Error('threadMemory metadata must include refs');
  }
  for (const reference of references) {
    if (!validReferences.has(reference)) {
      throw new Error(`threadMemory referenced unknown ref: ${reference}`);
    }
  }
}

function parseThreadMemoryAnchors(lines: string[]): ThreadMemoryAnchor[] {
  const anchors: ThreadMemoryAnchor[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*\[([A-Za-z]+)\]\s*(.*?)\s*$/);
    if (!match) {
      continue;
    }
    const label = match[1] ?? '';
    if (label === 'Context' || label === 'Extraction') {
      continue;
    }
    anchors.push({
      name: normalizeThreadMemoryAnchorName(label),
      phrase: normalizeText(match[2] ?? ''),
    });
  }

  if (anchors.length === 0) {
    throw new Error('threadMemory unit must include at least one anchor');
  }
  if (anchors.length > 3) {
    throw new Error('threadMemory unit cannot include more than three anchors');
  }
  for (const anchor of anchors) {
    validateThreadMemoryAnchorPhrase(anchor.phrase);
  }
  return anchors;
}

function renderThreadMemoryAnchors(anchors: ThreadMemoryAnchor[]): string[] {
  return anchors.map((anchor) => `${anchor.name}: ${anchor.phrase}`);
}

function normalizeThreadMemoryAnchorName(value: string): ThreadMemoryAnchor['name'] {
  const text = value.trim();
  if (
    text !== 'Preference'
    && text !== 'Fact'
    && text !== 'Decision'
    && text !== 'Entity'
  ) {
    throw new Error(`invalid thread memory anchor: ${value}`);
  }
  return text;
}

function validateThreadMemoryAnchorPhrase(value: string): void {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 5) {
    throw new Error('threadMemory anchor phrase must contain 1-5 words');
  }
}

function wordCount(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

function normalizeText(value: string): string {
  return value.split(/\s+/).join(' ').trim();
}
