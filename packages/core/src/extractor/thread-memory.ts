import type { SessionObservation } from './types.js';

export type ParsedSnapshotContent = {
  title: string;
  summary: string;
  snapshotContent: string;
  extractionMarkdown: string;
  extractions: SessionObservation[];
};

export type ParsedSnapshotPatch = {
  title?: string;
  summary?: string;
  updates: Array<{
    sequence: number;
    refs: string[];
    title: string;
    summary: string;
    content?: string | null;
  }>;
  additions: Array<{
    refs: string[];
    title: string;
    summary: string;
    content?: string | null;
  }>;
};

type UnitMetadata = {
  sequence?: number;
  references: string[];
};

export function parseSnapshotContent(
  raw: string,
  validReferences: Set<string>,
): ParsedSnapshotContent {
  const snapshotContent = stripMarkdownFence(typeof raw === 'string' ? raw.trim() : '');
  if (!snapshotContent) {
    throw new Error('extraction update returned empty snapshot content');
  }
  rejectJson(snapshotContent);

  const lines = snapshotContent.split(/\r?\n/);
  const title = parseRequiredTitle(lines);
  const summaryIndex = headingIndex(lines, 2, 'Summary');
  if (summaryIndex === undefined) {
    throw new Error('snapshot content document must include ## Summary');
  }
  const extractionsIndex = headingIndex(lines, 2, 'Extractions');
  if (extractionsIndex !== undefined && summaryIndex > extractionsIndex) {
    throw new Error('snapshot content document headings must order ## Summary before ## Extractions');
  }

  const summaryEnd = extractionsIndex ?? lines.length;
  const summary = lines.slice(summaryIndex + 1, summaryEnd).join('\n').trim();
  if (!normalizeText(summary)) {
    throw new Error('snapshot content document summary cannot be empty');
  }

  const extractionMarkdown = extractionsIndex === undefined
    ? ''
    : lines.slice(extractionsIndex + 1).join('\n').trim();

  return {
    title,
    summary,
    snapshotContent,
    extractionMarkdown,
    extractions: parseSnapshotContentUnits(extractionMarkdown, validReferences),
  };
}

export function parseSnapshotPatch(
  raw: string,
  validNewReferences: Set<string>,
): ParsedSnapshotPatch {
  const patch = stripMarkdownFence(typeof raw === 'string' ? raw.trim() : '');
  if (!patch) {
    return { updates: [], additions: [] };
  }
  rejectJson(patch);

  const lines = patch.split(/\r?\n/);
  const title = parseOptionalTitle(lines);
  const summaryIndex = headingIndex(lines, 2, 'Summary');
  const extractionsIndex = headingIndex(lines, 2, 'Extractions');
  const summary = summaryIndex === undefined
    ? undefined
    : lines
      .slice(summaryIndex + 1, extractionsIndex === undefined ? lines.length : extractionsIndex)
      .join('\n')
      .trim();
  if (summaryIndex !== undefined && !normalizeText(summary ?? '')) {
    throw new Error('snapshot patch summary cannot be empty');
  }

  const extractionMarkdown = extractionsIndex === undefined
    ? ''
    : lines.slice(extractionsIndex + 1).join('\n').trim();
  const units = parsePatchUnits(extractionMarkdown, validNewReferences);
  return {
    ...(title === undefined ? {} : { title }),
    ...(summary === undefined ? {} : { summary }),
    updates: units.updates,
    additions: units.additions,
  };
}

export function parseSnapshotContentUnits(
  snapshotContent: string,
  validReferences: Set<string>,
): SessionObservation[] {
  if (!snapshotContent.trim()) {
    return [];
  }

  return splitUnits(snapshotContent).map((unit) => {
    const lines = unit.split(/\r?\n/);
    const metadata = parseSnapshotContentMetadata(lines[0] ?? '');
    if (!metadata || metadata.sequence !== undefined) {
      throw new Error('snapshot unit must start with refs metadata comment');
    }
    validateSnapshotContentReferences(metadata.references, validReferences);
    const body = parseTitleSummaryContent(lines.slice(1));
    return {
      title: body.title,
      text: normalizeText(body.summary),
      context: normalizeContext(body.content ?? ''),
      references: metadata.references,
    };
  });
}

export function renderSnapshotContent(title: string, summary: string, extractions: SessionObservation[]): string {
  return [
    `# ${normalizeTitle(title)}`,
    '',
    '## Summary',
    summary.trim(),
    '',
    '## Extractions',
    extractions.map((extraction) => renderSessionObservationBlock(extraction)).join('\n\n----\n\n'),
  ].join('\n').trimEnd();
}

export function renderSessionObservationBlock(
  sessionObservation: SessionObservation,
  options: { sequence?: number; includeRefs?: boolean } = {},
): string {
  const metadata = renderMetadata({
    sequence: options.sequence,
    references: options.includeRefs === false ? [] : sessionObservation.references,
  });
  return [
    metadata,
    '### Title',
    normalizeTitle(sessionObservation.title ?? sessionObservation.text),
    '',
    '### Summary',
    sessionObservation.text.trim(),
    ...(normalizeContext(sessionObservation.context ?? '')
      ? ['', '### Content', sessionObservation.context!.trim()]
      : []),
  ].join('\n');
}

export function stripMarkdownFence(value: string): string {
  const match = value.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  return (match?.[1] ?? value).trim();
}

function parsePatchUnits(
  extractionMarkdown: string,
  validReferences: Set<string>,
): {
  updates: ParsedSnapshotPatch['updates'];
  additions: ParsedSnapshotPatch['additions'];
} {
  const updates: ParsedSnapshotPatch['updates'] = [];
  const additions: ParsedSnapshotPatch['additions'] = [];
  if (!extractionMarkdown.trim()) {
    return { updates, additions };
  }

  for (const unit of splitUnits(extractionMarkdown)) {
    const lines = unit.split(/\r?\n/);
    const metadata = parseSnapshotContentMetadata(lines[0] ?? '');
    if (!metadata) {
      throw new Error('snapshot patch extraction must start with metadata comment');
    }
    validateSnapshotContentReferences(metadata.references, validReferences);
    const body = parseTitleSummaryContent(lines.slice(1));
    const record = {
      refs: metadata.references,
      title: body.title,
      summary: normalizeText(body.summary),
      content: normalizeContext(body.content ?? ''),
    };
    if (metadata.sequence === undefined) {
      additions.push(record);
    } else {
      updates.push({
        sequence: metadata.sequence,
        ...record,
      });
    }
  }
  return { updates, additions };
}

function parseTitleSummaryContent(lines: string[]): { title: string; summary: string; content?: string | null } {
  const titleIndex = headingIndex(lines, 3, 'Title');
  if (titleIndex === undefined) {
    throw new Error('snapshot unit must include ### Title');
  }
  const summaryIndex = headingIndex(lines, 3, 'Summary');
  if (summaryIndex === undefined) {
    throw new Error('snapshot unit must include ### Summary');
  }
  if (titleIndex > summaryIndex) {
    throw new Error('snapshot unit headings must order ### Title before ### Summary');
  }
  const contentIndex = headingIndex(lines, 3, 'Content');
  if (contentIndex !== undefined && contentIndex < summaryIndex) {
    throw new Error('snapshot unit headings must order ### Summary before ### Content');
  }
  const nextUnexpectedHeading = lines.find((line) => /^###\s+(.+?)\s*$/.test(line)
    && !/^###\s+(Title|Summary|Content)\s*$/i.test(line));
  if (nextUnexpectedHeading) {
    throw new Error(`unsupported snapshot unit heading: ${nextUnexpectedHeading.trim()}`);
  }

  const titleEnd = summaryIndex;
  const title = normalizeTitle(lines.slice(titleIndex + 1, titleEnd).join('\n'));
  const summaryEnd = contentIndex ?? lines.length;
  const summary = lines.slice(summaryIndex + 1, summaryEnd).join('\n').trim();
  if (!normalizeText(summary)) {
    throw new Error('snapshot unit summary cannot be empty');
  }
  const content = contentIndex === undefined
    ? null
    : lines.slice(contentIndex + 1).join('\n').trim() || null;
  return { title, summary, content };
}

function parseSnapshotContentMetadata(value: string): UnitMetadata | null {
  const match = value.match(/^\s*<!--\s*(.*?)\s*-->\s*$/);
  if (!match) {
    return null;
  }
  const body = match[1] ?? '';
  const refsMatch = body.match(/(?:^|;)\s*refs:\s*\[([^\]]*)\]\s*(?:;|$)/i);
  if (!refsMatch) {
    return null;
  }
  const sequenceMatch = body.match(/(?:^|;)\s*sequence:\s*([^;]+?)\s*(?:;|$)/i);
  const sequence = sequenceMatch ? Number(sequenceMatch[1]!.trim()) : undefined;
  if (sequence !== undefined && (!Number.isInteger(sequence) || sequence < 0)) {
    throw new Error(`invalid extraction sequence: ${sequenceMatch?.[1] ?? ''}`);
  }
  return {
    ...(sequence === undefined ? {} : { sequence }),
    references: parseSnapshotContentRefs(refsMatch[1]),
  };
}

function renderMetadata(value: UnitMetadata): string {
  const parts = [];
  if (value.sequence !== undefined) {
    parts.push(`sequence: ${value.sequence}`);
  }
  if (value.references.length > 0) {
    parts.push(`refs: [${value.references.join(', ')}]`);
  }
  return `<!-- ${parts.join('; ')} -->`;
}

function splitUnits(value: string): string[] {
  const units: string[] = [];
  let current: string[] = [];

  for (const line of value.split(/\r?\n/)) {
    if (/^\s*----\s*$/.test(line)) {
      pushCurrentUnit(units, current);
      current = [];
      continue;
    }

    if (current.length > 0 && isUnitMetadataLine(line)) {
      pushCurrentUnit(units, current);
      current = [line];
      continue;
    }

    current.push(line);
  }

  pushCurrentUnit(units, current);
  return units;
}

function pushCurrentUnit(units: string[], lines: string[]): void {
  const unit = lines.join('\n').trim();
  if (unit) {
    units.push(unit);
  }
}

function isUnitMetadataLine(line: string): boolean {
  try {
    return parseSnapshotContentMetadata(line) !== null;
  } catch {
    return false;
  }
}

function parseSnapshotContentRefs(value: string): string[] {
  const references = value
    .split(',')
    .map((reference) => reference.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  if (references.length === 0) {
    throw new Error('snapshot content metadata refs must include at least one reference');
  }
  return [...new Set(references)];
}

function validateSnapshotContentReferences(references: string[], validReferences: Set<string>): void {
  if (references.length === 0) {
    throw new Error('snapshot content metadata must include refs');
  }
  for (const reference of references) {
    if (!validReferences.has(reference)) {
      throw new Error(`snapshot content referenced unknown ref: ${reference}`);
    }
  }
}

function headingIndex(lines: string[], level: number, label: string): number | undefined {
  const hashes = '#'.repeat(level);
  const regex = new RegExp(`^${hashes}\\s+${escapeRegExp(label)}\\s*$`, 'i');
  const index = lines.findIndex((line) => regex.test(line));
  return index >= 0 ? index : undefined;
}

function parseRequiredTitle(lines: string[]): string {
  const title = parseOptionalTitle(lines);
  if (title === undefined) {
    throw new Error('snapshot content document must include # title');
  }
  return title;
}

function parseOptionalTitle(lines: string[]): string | undefined {
  const index = lines.findIndex((line) => /^#\s+(.+?)\s*$/.test(line));
  if (index < 0) {
    return undefined;
  }
  return normalizeTitle(lines[index]!.replace(/^#\s+/, ''));
}

function rejectJson(value: string): void {
  if (/^\s*\{/.test(value)) {
    throw new Error('extraction result must return snapshot content Markdown, not JSON');
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value: string): string {
  return value.split(/\s+/).join(' ').trim();
}

function normalizeTitle(value: string): string {
  const title = normalizeText(value);
  if (!title) {
    throw new Error('snapshot title cannot be empty');
  }
  return title;
}

function normalizeContext(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}
