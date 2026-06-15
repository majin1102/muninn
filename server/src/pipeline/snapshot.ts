export type SnapshotThreadKind = 'session' | 'subject';

export type ExtractionUnit = {
  id?: string | null;
  title?: string | null;
  text: string;
  context?: string | null;
  references: string[];
  updatedMemory?: string | null;
};

export type ContextRef = {
  turnId: string;
  summary: string;
};

export type ExtractionChange =
  | {
    type: 'add';
    text: string;
    context?: string | null;
    references: string[];
    reason: string;
  }
  | {
    type: 'merge';
    extractionIds: string[];
    text: string;
    context?: string | null;
    reason: string;
  }
  | {
    type: 'update';
    extractionId: string;
    text: string;
    context?: string | null;
    references?: string[];
    reason: string;
  }
  | {
    type: 'delete';
    extractionId: string;
    reason: string;
  };

export type SnapshotContent = {
  threadKind?: SnapshotThreadKind;
  sessionId?: string | null;
  project?: string;
  cwd?: string;
  agent?: string;
  snapshotContent: string;
  signals?: string;
  extractions: ExtractionUnit[];
  contextRefs: ContextRef[];
  openQuestions?: string[];
  nextSteps?: string[];
  extractionChanges: ExtractionChange[];
};

export type ParsedSnapshotContent = {
  title: string;
  summary: string;
  signals: string;
  snapshotContent: string;
  extractionMarkdown: string;
  extractions: ExtractionUnit[];
};

export type ParsedSnapshotPatch = {
  title?: string;
  summary?: string;
  signals?: string;
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
  const signalsIndex = headingIndex(lines, 2, 'Signals');
  if (signalsIndex !== undefined && summaryIndex > signalsIndex) {
    throw new Error('snapshot content document headings must order ## Summary before ## Signals');
  }
  const extractionsIndex = headingIndex(lines, 2, 'Extractions');
  if (extractionsIndex !== undefined && summaryIndex > extractionsIndex) {
    throw new Error('snapshot content document headings must order ## Summary before ## Extractions');
  }
  if (signalsIndex !== undefined && extractionsIndex !== undefined && signalsIndex > extractionsIndex) {
    throw new Error('snapshot content document headings must order ## Signals before ## Extractions');
  }

  const summaryEnd = Math.min(
    signalsIndex ?? lines.length,
    extractionsIndex ?? lines.length,
  );
  const summary = lines.slice(summaryIndex + 1, summaryEnd).join('\n').trim();
  if (!normalizeText(summary)) {
    throw new Error('snapshot content document summary cannot be empty');
  }
  const signals = signalsIndex === undefined
    ? ''
    : lines.slice(signalsIndex + 1, extractionsIndex ?? lines.length).join('\n').trim();

  const extractionMarkdown = extractionsIndex === undefined
    ? ''
    : lines.slice(extractionsIndex + 1).join('\n').trim();

  return {
    title,
    summary,
    signals,
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
  const signalsIndex = headingIndex(lines, 2, 'Signals');
  const extractionsIndex = headingIndex(lines, 2, 'Extractions');
  if (summaryIndex !== undefined && signalsIndex !== undefined && summaryIndex > signalsIndex) {
    throw new Error('snapshot patch headings must order ## Summary before ## Signals');
  }
  if (summaryIndex !== undefined && extractionsIndex !== undefined && summaryIndex > extractionsIndex) {
    throw new Error('snapshot patch headings must order ## Summary before ## Extractions');
  }
  if (signalsIndex !== undefined && extractionsIndex !== undefined && signalsIndex > extractionsIndex) {
    throw new Error('snapshot patch headings must order ## Signals before ## Extractions');
  }
  const summary = summaryIndex === undefined
    ? undefined
    : lines
      .slice(summaryIndex + 1, Math.min(signalsIndex ?? lines.length, extractionsIndex ?? lines.length))
      .join('\n')
      .trim();
  if (summaryIndex !== undefined && !normalizeText(summary ?? '')) {
    throw new Error('snapshot patch summary cannot be empty');
  }
  const signals = signalsIndex === undefined
    ? undefined
    : lines.slice(signalsIndex + 1, extractionsIndex ?? lines.length).join('\n').trim();

  const extractionMarkdown = extractionsIndex === undefined
    ? ''
    : lines.slice(extractionsIndex + 1).join('\n').trim();
  const units = parsePatchUnits(extractionMarkdown, validNewReferences);
  return {
    ...(title === undefined ? {} : { title }),
    ...(summary === undefined ? {} : { summary }),
    ...(signals === undefined ? {} : { signals }),
    updates: units.updates,
    additions: units.additions,
  };
}

export function parseSnapshotContentUnits(
  snapshotContent: string,
  validReferences: Set<string>,
): ExtractionUnit[] {
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

export function renderSnapshotContent(
  title: string,
  summary: string,
  signals: string,
  extractions: ExtractionUnit[],
): string {
  return [
    `# ${normalizeRequiredTitle(title)}`,
    '',
    '## Summary',
    summary.trim(),
    '',
    '## Signals',
    signals.trim(),
    '',
    '## Extractions',
    extractions.map((extraction) => renderExtractionBlock(extraction)).join('\n\n----\n\n'),
  ].join('\n').trimEnd();
}

export function renderExtractionBlock(
  extraction: ExtractionUnit,
  options: { sequence?: number; includeRefs?: boolean } = {},
): string {
  const metadata = renderMetadata({
    sequence: options.sequence,
    references: options.includeRefs === false ? [] : extraction.references,
  });
  return [
    metadata,
    '### Title',
    normalizeRequiredTitle(extraction.title ?? extraction.text),
    '',
    '### Summary',
    extraction.text.trim(),
    ...(normalizeContext(extraction.context ?? '')
      ? ['', '### Content', extraction.context!.trim()]
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
  const title = normalizeRequiredTitle(lines.slice(titleIndex + 1, titleEnd).join('\n'));
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
  return normalizeRequiredTitle(lines[index]!.replace(/^#\s+/, ''));
}

function normalizeRequiredTitle(value: string): string {
  const title = normalizeText(value);
  if (!title) {
    throw new Error('snapshot title cannot be empty');
  }
  return title;
}

function normalizeText(value: string): string {
  return value.split(/\s+/).join(' ').trim();
}

function rejectJson(value: string): void {
  if (/^\s*\{/.test(value)) {
    throw new Error('extraction result must return snapshot content Markdown, not JSON');
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeContext(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}
