import type {
  ExtractSessionMemoryResult,
  Extraction,
  SessionMemoryContent,
  SessionSnapshot,
  SessionMemoryThread,
  SessionMemoryThreadKind,
  PendingIndex,
  ContextRef,
  SnapshotContent,
} from './types.js';

const PENDING_SNAPSHOT_ID = 'session:18446744073709551615';
export const DEFAULT_SESSION_ID = '__muninn_default_session__';
const MAX_REFERENCES = 1000;

export function activeWindowMs(activeWindowDays: number): number {
  return activeWindowDays * 24 * 60 * 60 * 1000;
}

export function isActiveThread(
  updatedAt: string,
  activeWindowDays: number,
  nowMs = Date.now(),
): boolean {
  return Date.parse(updatedAt) >= nowMs - activeWindowMs(activeWindowDays);
}

function threadKey(value: {
  sessionId: string;
  agent: string;
  project: string;
  cwd: string;
}): string {
  return `${value.agent}\0${value.project}\0${value.cwd}\0${value.sessionId}`;
}

export function createSessionMemoryThread(
  observer: string,
  title: string,
  summary: string,
  references: string[],
  extractionEpoch: number,
  now = new Date().toISOString(),
  kind: SessionMemoryThreadKind = 'subject',
  sessionId: string | null = null,
  ownership: { agent: string; project: string; cwd: string } = {
    agent: 'unknown',
    project: 'default',
    cwd: process.cwd(),
  },
): SessionMemoryThread {
  const threadSessionId = sessionId ?? 'default';
  return {
    threadId: threadSessionId,
    kind,
    sessionId: threadSessionId,
    project: ownership.project,
    cwd: ownership.cwd,
    agent: ownership.agent,
    snapshotIds: [],
    snapshotEpochs: [],
    extractionEpoch,
    title: normalizeTitle(title),
    summary: normalizeSummary(summary),
    snapshots: [],
    references,
    observer,
    createdAt: now,
    updatedAt: now,
  };
}

export function cloneSessionMemoryThread(thread: SessionMemoryThread): SessionMemoryThread {
  return {
    ...thread,
    kind: thread.kind,
    sessionId: thread.sessionId ?? null,
    snapshotIds: [...thread.snapshotIds],
    snapshotEpochs: [...(thread.snapshotEpochs ?? [])],
    references: [...thread.references],
    snapshots: thread.snapshots.map((snapshot) => ({
      threadKind: snapshot.threadKind ?? thread.kind,
      sessionId: snapshot.sessionId ?? thread.sessionId ?? null,
      project: snapshot.project ?? thread.project,
      cwd: snapshot.cwd ?? thread.cwd,
      agent: snapshot.agent ?? thread.agent,
      snapshotContent: snapshot.snapshotContent,
      signals: snapshot.signals ?? '',
      extractions: snapshot.extractions.map((extraction) => ({
        id: extraction.id ?? null,
        title: extraction.title ?? null,
        text: extraction.text,
        context: extraction.context ?? null,
        references: [...(extraction.references ?? [])],
        updatedMemory: extraction.updatedMemory ?? null,
      })),
      contextRefs: snapshot.contextRefs.map((reference) => ({ ...reference })),
      openQuestions: [...(snapshot.openQuestions ?? [])],
      nextSteps: [...(snapshot.nextSteps ?? [])],
      extractionChanges: (snapshot.extractionChanges ?? []).map((change) => ({ ...change })),
    })),
    indexedSnapshotSequence: thread.indexedSnapshotSequence ?? null,
  };
}

export function cloneSessionMemoryThreads(threads: SessionMemoryThread[]): SessionMemoryThread[] {
  return threads.map(cloneSessionMemoryThread);
}

export function loadThreads(
  snapshots: SessionSnapshot[],
  observer: string,
  activeWindowDays: number,
  extractionEpoch = 0,
): SessionMemoryThread[] {
  const grouped = new Map<string, SessionSnapshot[]>();
  for (const snapshot of snapshots) {
    if (snapshot.extractor !== observer) {
      continue;
    }
    const key = threadKey(snapshot);
    const rows = grouped.get(key) ?? [];
    rows.push(snapshot);
    grouped.set(key, rows);
  }
  return [...grouped.values()]
    .map((rows) => threadFromSnapshots(rows, extractionEpoch))
    .filter((thread) => isActiveThread(thread.updatedAt, activeWindowDays))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
}

export function threadFromSnapshots(
  rows: SessionSnapshot[],
  extractionEpoch = 0,
  indexedSnapshotSequence: number | null = null,
): SessionMemoryThread {
  const ordered = [...rows].sort((left, right) => (
    left.snapshotSequence - right.snapshotSequence
    || left.updatedAt.localeCompare(right.updatedAt)
  ));
  const latest = ordered[ordered.length - 1];
  if (!latest) {
    throw new Error('missing snapshots for session memory thread');
  }
  const latestContent = deserializeSnapshot(latest);
  return {
    threadId: latest.sessionId,
    kind: latestContent.threadKind ?? 'subject',
    sessionId: latest.sessionId,
    project: latest.project,
    cwd: latest.cwd,
    agent: latest.agent,
    snapshotId: latest.snapshotId,
    snapshotIds: ordered.map((row) => row.snapshotId),
    snapshotEpochs: ordered.map(() => extractionEpoch),
    extractionEpoch,
    title: latest.title,
    summary: latest.summary,
    snapshots: ordered.map(deserializeSnapshot),
    references: [...latest.references],
    indexedSnapshotSequence,
    observer: latest.extractor,
    createdAt: ordered[0]?.createdAt ?? latest.createdAt,
    updatedAt: latest.updatedAt,
  };
}

export function replaySnapshots(
  thread: SessionMemoryThread,
  rows: SessionSnapshot[],
  extractionEpoch = thread.extractionEpoch,
): void {
  const ordered = [...rows].sort((left, right) => (
    left.snapshotSequence - right.snapshotSequence
    || left.updatedAt.localeCompare(right.updatedAt)
  ));
  for (const row of ordered) {
    if (row.snapshotSequence < thread.snapshots.length) {
      continue;
    }
    if (row.snapshotSequence !== thread.snapshots.length) {
      throw new Error(`unexpected snapshot gap for session memory thread ${thread.threadId}`);
    }
    thread.snapshotId = row.snapshotId;
    thread.snapshotIds.push(row.snapshotId);
    thread.snapshotEpochs = [...(thread.snapshotEpochs ?? []), extractionEpoch];
    thread.extractionEpoch = extractionEpoch;
    thread.title = row.title;
    thread.summary = row.summary;
    const snapshot = deserializeSnapshot(row);
    thread.kind = snapshot.threadKind ?? thread.kind;
    thread.sessionId = snapshot.sessionId ?? thread.sessionId ?? null;
    thread.project = snapshot.project ?? thread.project;
    thread.cwd = snapshot.cwd ?? thread.cwd;
    thread.agent = snapshot.agent ?? thread.agent;
    thread.snapshots.push(snapshot);
    thread.references = [...row.references];
    thread.updatedAt = row.updatedAt;
  }
}

export function currentSessionMemoryContent(thread: SessionMemoryThread): SessionMemoryContent {
  const snapshot = latestSnapshot(thread) ?? emptySnapshot();
  return {
    title: thread.title,
    summary: thread.summary,
    signals: snapshot.signals ?? '',
    snapshotContent: snapshot.snapshotContent,
    extractions: snapshot.extractions,
    openQuestions: snapshot.openQuestions ?? [],
    nextSteps: snapshot.nextSteps ?? [],
  };
}

export function applyExtraction(
  thread: SessionMemoryThread,
  result: ExtractSessionMemoryResult,
  extractionEpoch: number,
  applyExtractionChanges: (
    extractions: Extraction[],
    result: ExtractSessionMemoryResult,
  ) => { extractionChanges: SnapshotContent['extractionChanges']; extractions: Extraction[] },
  now = new Date().toISOString(),
): void {
  const current = latestSnapshot(thread) ?? emptySnapshot();
  const patched = applyExtractionChanges(current.extractions, result);
  thread.title = result.title;
  thread.summary = result.summary ?? thread.summary;
  thread.extractionEpoch = extractionEpoch;
  thread.snapshots.push({
    threadKind: thread.kind,
    sessionId: thread.sessionId ?? null,
    project: thread.project,
    cwd: thread.cwd,
    agent: thread.agent,
    snapshotContent: result.snapshotContent ?? '',
    signals: result.signals ?? '',
    extractions: patched.extractions,
    contextRefs: mergeContextRefs(
      current.contextRefs,
      result.contextRefs,
    ),
    openQuestions: result.openQuestions,
    nextSteps: result.nextSteps,
    extractionChanges: patched.extractionChanges,
  });
  thread.references = latestSnapshot(thread)?.contextRefs.map((reference) => reference.turnId) ?? [];
  thread.snapshotEpochs = [...(thread.snapshotEpochs ?? []), extractionEpoch];
  thread.snapshotId = undefined;
  thread.updatedAt = now;
}

export function pushReference(thread: SessionMemoryThread, reference: string): void {
  if (!thread.references.includes(reference)) {
    thread.references.push(reference);
    trimReferences(thread.references);
  }
}

export function toSessionSnapshot(thread: SessionMemoryThread): SessionSnapshot {
  if (thread.snapshots.length === 0) {
    throw new Error(`missing snapshots for session memory thread ${thread.threadId}`);
  }
  const snapshot = latestSnapshot(thread)!;
  return {
    snapshotId: thread.snapshotId ?? PENDING_SNAPSHOT_ID,
    sessionId: thread.sessionId ?? thread.threadId,
    project: thread.project,
    cwd: thread.cwd,
    agent: thread.agent,
    snapshotSequence: thread.snapshots.length - 1,
    createdAt: thread.updatedAt,
    updatedAt: thread.updatedAt,
    extractor: thread.observer,
    title: thread.title,
    summary: thread.summary,
    content: snapshot.snapshotContent,
    references: snapshot.contextRefs.map((reference) => reference.turnId),
  };
}

export function latestSnapshot(thread: SessionMemoryThread): SnapshotContent | undefined {
  return thread.snapshots[thread.snapshots.length - 1];
}

export function snapshotRef(thread: SessionMemoryThread, snapshotIndex: number): string {
  const snapshotId = thread.snapshotIds[snapshotIndex];
  if (!snapshotId) {
    throw new Error(`missing snapshot id for session memory thread ${thread.threadId} at sequence ${snapshotIndex}`);
  }
  return snapshotId;
}

export function threadIdentityKey(value: {
  agent: string;
  project: string;
  cwd: string;
  sessionId?: string | null;
  threadId?: string;
}): string {
  return `${value.agent}\0${value.cwd}\0${value.sessionId ?? value.threadId ?? DEFAULT_SESSION_ID}`;
}

export function getPendingIndex(thread: SessionMemoryThread): PendingIndex | null {
  const latestSnapshotSequence = thread.snapshots.length - 1;
  if (latestSnapshotSequence < 0) {
    return null;
  }
  const start = (thread.indexedSnapshotSequence ?? -1) + 1;
  if (start > latestSnapshotSequence) {
    return null;
  }
  return {
    start,
    end: latestSnapshotSequence,
  };
}

export function getPendingIndexUpTo(
  thread: SessionMemoryThread,
  maxEpoch: number,
): PendingIndex | null {
  const snapshotEpochs = thread.snapshotEpochs ?? [];
  let latestSnapshotSequence = -1;
  for (let index = thread.snapshots.length - 1; index >= 0; index -= 1) {
    const snapshotEpoch = snapshotEpochs[index] ?? thread.extractionEpoch;
    if (snapshotEpoch <= maxEpoch) {
      latestSnapshotSequence = index;
      break;
    }
  }
  if (latestSnapshotSequence < 0) {
    return null;
  }
  const start = (thread.indexedSnapshotSequence ?? -1) + 1;
  if (start > latestSnapshotSequence) {
    return null;
  }
  return {
    start,
    end: latestSnapshotSequence,
  };
}

function deserializeSnapshot(row: SessionSnapshot): SnapshotContent {
  const parsed = parseSnapshotContent(row.content, new Set(row.references));
  return {
    threadKind: 'session',
    sessionId: row.sessionId,
    project: row.project,
    cwd: row.cwd,
    agent: row.agent,
    snapshotContent: parsed.snapshotContent,
    signals: parsed.signals,
    extractions: parsed.extractions,
    contextRefs: row.references.map((turnId) => ({ turnId, summary: turnId })),
    openQuestions: [],
    nextSteps: [],
    extractionChanges: [],
  };
}

function emptySnapshot(): SnapshotContent {
  return {
    threadKind: 'subject',
    sessionId: null,
    project: 'default',
    cwd: process.cwd(),
    agent: 'unknown',
    snapshotContent: '',
    signals: '',
    extractions: [],
    contextRefs: [],
    openQuestions: [],
    nextSteps: [],
    extractionChanges: [],
  };
}

function mergeContextRefs(
  current: ContextRef[],
  next: ContextRef[],
): ContextRef[] {
  const merged = [...current];
  for (const reference of next) {
    const summary = normalizeText(reference.summary);
    if (!summary) {
      continue;
    }
    const existingIndex = merged.findIndex((item) => item.turnId === reference.turnId);
    if (existingIndex >= 0) {
      merged.splice(existingIndex, 1);
    }
    merged.push({ turnId: reference.turnId, summary });
  }
  return merged;
}

function normalizeContextRefs(value: unknown): ContextRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const record = item as Record<string, unknown>;
    const turnId = typeof record.turnId === 'string' ? record.turnId.trim() : '';
    const summary = typeof record.summary === 'string' ? normalizeText(record.summary) : '';
    if (!turnId || !summary) {
      return [];
    }
    return [{ turnId, summary }];
  });
}

function normalizeTitle(value: string): string {
  return normalizeText(value);
}

function normalizeSummary(value: string): string {
  return normalizeText(value);
}

function normalizeText(value: string): string {
  const collapsed = value.split(/\s+/).join(' ').trim();
  return collapsed;
}

function trimReferences(references: string[]): void {
  while (references.length > MAX_REFERENCES) {
    const removableIndex = references.findIndex((reference) => reference.startsWith('turn:'));
    references.splice(removableIndex >= 0 ? removableIndex : 0, 1);
  }
}

export type ParsedSnapshotContent = {
  title: string;
  summary: string;
  signals: string;
  snapshotContent: string;
  extractionMarkdown: string;
  extractions: Extraction[];
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
): Extraction[] {
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
  extractions: Extraction[],
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
  extraction: Extraction,
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

export const __testing = {
  applyExtractionForTests: applyExtraction,
};
