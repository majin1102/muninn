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
import { parseSnapshotContent } from './thread-memory.js';

const PENDING_SNAPSHOT_ID = 'session:18446744073709551615';
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

export function createSessionMemoryThread(
  observer: string,
  title: string,
  summary: string,
  references: string[],
  extractionEpoch: number,
  now = new Date().toISOString(),
  kind: SessionMemoryThreadKind = 'subject',
  sessionId: string | null = null,
): SessionMemoryThread {
  const threadSessionId = sessionId ?? 'default';
  return {
    threadId: threadSessionId,
    kind,
    sessionId: threadSessionId,
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
      snapshotContent: snapshot.snapshotContent,
      extractions: snapshot.extractions.map((extraction) => ({
        id: extraction.id ?? null,
        title: extraction.title ?? null,
        text: extraction.text,
        context: extraction.context ?? null,
        anchors: [...(extraction.anchors ?? [])],
        category: extraction.category,
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
    if (snapshot.observer !== observer) {
      continue;
    }
    const rows = grouped.get(snapshot.sessionId) ?? [];
    rows.push(snapshot);
    grouped.set(snapshot.sessionId, rows);
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
    snapshotId: latest.snapshotId,
    snapshotIds: ordered.map((row) => row.snapshotId),
    snapshotEpochs: ordered.map(() => extractionEpoch),
    extractionEpoch,
    title: latest.title,
    summary: latest.summary,
    snapshots: ordered.map(deserializeSnapshot),
    references: [...latest.references],
    indexedSnapshotSequence,
    observer: latest.observer,
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
    snapshotContent: snapshot.snapshotContent,
    extractions: snapshot.extractions,
    openQuestions: snapshot.openQuestions ?? [],
    nextSteps: snapshot.nextSteps ?? [],
  };
}

export function applyExtractionResult(
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
    snapshotContent: result.snapshotContent ?? '',
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
    snapshotSequence: thread.snapshots.length - 1,
    createdAt: thread.updatedAt,
    updatedAt: thread.updatedAt,
    observer: thread.observer,
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
    snapshotContent: parsed.snapshotContent,
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
    snapshotContent: '',
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

export const __testing = {
  applyExtractionResultForTests: applyExtractionResult,
};
