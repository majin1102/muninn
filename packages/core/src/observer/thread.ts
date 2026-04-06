import { randomUUID } from 'node:crypto';

import type { ObserveResult, ObservedMemory, ObservingContent, ObservingSnapshot, ObservingThread, SnapshotContent } from './types.js';

const PENDING_SNAPSHOT_ID = 'observing:18446744073709551615';
const MAX_REFERENCES = 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function createObservingThread(
  observer: string,
  title: string,
  summary: string,
  references: string[],
  observingEpoch: number,
  now = new Date().toISOString(),
): ObservingThread {
  return {
    observingId: randomUUID(),
    snapshotIds: [],
    observingEpoch,
    title: normalizeTitle(title),
    summary: normalizeSummary(summary),
    snapshots: [],
    references,
    observer,
    createdAt: now,
    updatedAt: now,
  };
}

export function loadThreads(
  snapshots: ObservingSnapshot[],
  observer: string,
): ObservingThread[] {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const grouped = new Map<string, ObservingSnapshot[]>();
  for (const snapshot of snapshots) {
    if (snapshot.observer !== observer) {
      continue;
    }
    if (Date.parse(snapshot.updatedAt) < cutoff) {
      continue;
    }
    const rows = grouped.get(snapshot.observingId) ?? [];
    rows.push(snapshot);
    grouped.set(snapshot.observingId, rows);
  }
  return [...grouped.values()]
    .map((rows) => threadFromSnapshots(rows))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
}

export function threadFromSnapshots(rows: ObservingSnapshot[]): ObservingThread {
  const ordered = [...rows].sort((left, right) => (
    left.snapshotSequence - right.snapshotSequence
    || left.updatedAt.localeCompare(right.updatedAt)
  ));
  const latest = ordered[ordered.length - 1];
  if (!latest) {
    throw new Error('missing snapshots for observing thread');
  }
  return {
    observingId: latest.observingId,
    snapshotId: latest.snapshotId,
    snapshotIds: ordered.map((row) => row.snapshotId),
    pendingParentId: latest.checkpoint.pendingParentId ?? null,
    observingEpoch: latest.checkpoint.observingEpoch,
    title: latest.title,
    summary: latest.summary,
    snapshots: ordered.map(deserializeSnapshot),
    references: [...latest.references],
    indexedSnapshotSequence: latest.checkpoint.indexedSnapshotSequence ?? null,
    observer: latest.observer,
    createdAt: ordered[0]?.createdAt ?? latest.createdAt,
    updatedAt: latest.updatedAt,
  };
}

export function currentObservingContent(thread: ObservingThread): ObservingContent {
  const snapshot = latestSnapshot(thread) ?? emptySnapshot();
  return {
    title: thread.title,
    summary: thread.summary,
    memories: snapshot.memories,
    openQuestions: snapshot.openQuestions ?? [],
    nextSteps: snapshot.nextSteps ?? [],
  };
}

export function applyObserveResult(
  thread: ObservingThread,
  result: ObserveResult,
  observingEpoch: number,
  applyMemoriesDelta: (
    memories: ObservedMemory[],
    result: ObserveResult,
  ) => { memoryDelta: SnapshotContent['memoryDelta']; memories: ObservedMemory[] },
  now = new Date().toISOString(),
): void {
  const current = latestSnapshot(thread) ?? emptySnapshot();
  const patched = applyMemoriesDelta(current.memories, result);
  thread.title = result.observingContentUpdate.title;
  thread.summary = result.observingContentUpdate.summary;
  thread.observingEpoch = observingEpoch;
  thread.snapshots.push({
    memories: patched.memories,
    openQuestions: result.observingContentUpdate.openQuestions,
    nextSteps: result.observingContentUpdate.nextSteps,
    memoryDelta: patched.memoryDelta,
  });
  thread.snapshotId = undefined;
  thread.updatedAt = now;
}

export function pushReference(thread: ObservingThread, reference: string): void {
  if (!thread.references.includes(reference)) {
    thread.references.push(reference);
    trimReferences(thread.references);
  }
}

export function toObservingSnapshot(thread: ObservingThread): ObservingSnapshot {
  if (thread.snapshots.length === 0) {
    throw new Error(`missing snapshots for observing thread ${thread.observingId}`);
  }
  const snapshot = latestSnapshot(thread)!;
  return {
    snapshotId: thread.snapshotId ?? PENDING_SNAPSHOT_ID,
    observingId: thread.observingId,
    snapshotSequence: thread.snapshots.length - 1,
    createdAt: thread.updatedAt,
    updatedAt: thread.updatedAt,
    observer: thread.observer,
    title: thread.title,
    summary: thread.summary,
    content: JSON.stringify(snapshot, null, 2),
    references: [...thread.references],
    checkpoint: {
      observingEpoch: thread.observingEpoch,
      indexedSnapshotSequence: thread.indexedSnapshotSequence ?? null,
      pendingParentId: thread.pendingParentId ?? null,
    },
  };
}

export function latestSnapshot(thread: ObservingThread): SnapshotContent | undefined {
  return thread.snapshots[thread.snapshots.length - 1];
}

export function snapshotRef(thread: ObservingThread, snapshotIndex: number): string {
  const snapshotId = thread.snapshotIds[snapshotIndex];
  if (!snapshotId) {
    throw new Error(`missing snapshot id for observing thread ${thread.observingId} at sequence ${snapshotIndex}`);
  }
  return snapshotId;
}

export function threadHasPendingIndex(thread: ObservingThread): boolean {
  const latestSnapshotSequence = thread.snapshots.length - 1;
  if (latestSnapshotSequence < 0) {
    return false;
  }
  return thread.indexedSnapshotSequence == null || thread.indexedSnapshotSequence < latestSnapshotSequence;
}

function deserializeSnapshot(row: ObservingSnapshot): SnapshotContent {
  const parsed = JSON.parse(row.content) as Partial<SnapshotContent>;
  return {
    memories: Array.isArray(parsed.memories) ? parsed.memories as ObservedMemory[] : [],
    openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [],
    nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps : [],
    memoryDelta: {
      before: Array.isArray(parsed.memoryDelta?.before) ? parsed.memoryDelta!.before : [],
      after: Array.isArray(parsed.memoryDelta?.after) ? parsed.memoryDelta!.after : [],
    },
  };
}

function emptySnapshot(): SnapshotContent {
  return {
    memories: [],
    openQuestions: [],
    nextSteps: [],
    memoryDelta: { before: [], after: [] },
  };
}

function normalizeTitle(value: string): string {
  return normalizeText(value, 48);
}

function normalizeSummary(value: string): string {
  return normalizeText(value, 220);
}

function normalizeText(value: string, maxChars: number): string {
  const collapsed = value.split(/\s+/).join(' ').trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(maxChars - 3, 0))}...`;
}

function trimReferences(references: string[]): void {
  while (references.length > MAX_REFERENCES) {
    const removableIndex = references.findIndex((reference) => reference.startsWith('session:'));
    references.splice(removableIndex >= 0 ? removableIndex : 0, 1);
  }
}
