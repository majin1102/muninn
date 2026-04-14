import { randomUUID } from 'node:crypto';

import type {
  ObserveResult,
  ObservedMemory,
  ObservingContent,
  ObservingSnapshot,
  ObservingThread,
  PendingIndex,
  SnapshotContent,
} from './types.js';

const PENDING_SNAPSHOT_ID = 'observing:18446744073709551615';
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
    snapshotEpochs: [],
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

export function cloneObservingThread(thread: ObservingThread): ObservingThread {
  return {
    ...thread,
    snapshotIds: [...thread.snapshotIds],
    snapshotEpochs: [...(thread.snapshotEpochs ?? [])],
    references: [...thread.references],
    snapshots: thread.snapshots.map((snapshot) => ({
      memories: snapshot.memories.map((memory) => ({
        id: memory.id ?? null,
        text: memory.text,
        category: memory.category,
        updatedMemory: memory.updatedMemory ?? null,
      })),
      openQuestions: [...(snapshot.openQuestions ?? [])],
      nextSteps: [...(snapshot.nextSteps ?? [])],
      memoryDelta: {
        before: snapshot.memoryDelta.before.map((memory) => ({
          id: memory.id ?? null,
          text: memory.text,
          category: memory.category,
          updatedMemory: memory.updatedMemory ?? null,
        })),
        after: snapshot.memoryDelta.after.map((memory) => ({
          id: memory.id ?? null,
          text: memory.text,
          category: memory.category,
          updatedMemory: memory.updatedMemory ?? null,
        })),
      },
    })),
    indexedSnapshotSequence: thread.indexedSnapshotSequence ?? null,
  };
}

export function cloneObservingThreads(threads: ObservingThread[]): ObservingThread[] {
  return threads.map(cloneObservingThread);
}

export function loadThreads(
  snapshots: ObservingSnapshot[],
  observer: string,
  activeWindowDays: number,
  observingEpoch = 0,
): ObservingThread[] {
  const grouped = new Map<string, ObservingSnapshot[]>();
  for (const snapshot of snapshots) {
    if (snapshot.observer !== observer) {
      continue;
    }
    const rows = grouped.get(snapshot.observingId) ?? [];
    rows.push(snapshot);
    grouped.set(snapshot.observingId, rows);
  }
  return [...grouped.values()]
    .map((rows) => threadFromSnapshots(rows, observingEpoch))
    .filter((thread) => isActiveThread(thread.updatedAt, activeWindowDays))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
}

export function threadFromSnapshots(
  rows: ObservingSnapshot[],
  observingEpoch = 0,
  indexedSnapshotSequence: number | null = null,
): ObservingThread {
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
    snapshotEpochs: ordered.map(() => observingEpoch),
    observingEpoch,
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
  thread: ObservingThread,
  rows: ObservingSnapshot[],
  observingEpoch = thread.observingEpoch,
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
      throw new Error(`unexpected snapshot gap for observing thread ${thread.observingId}`);
    }
    thread.snapshotId = row.snapshotId;
    thread.snapshotIds.push(row.snapshotId);
    thread.snapshotEpochs = [...(thread.snapshotEpochs ?? []), observingEpoch];
    thread.observingEpoch = observingEpoch;
    thread.title = row.title;
    thread.summary = row.summary;
    thread.snapshots.push(deserializeSnapshot(row));
    thread.references = [...row.references];
    thread.updatedAt = row.updatedAt;
  }
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
  thread.snapshotEpochs = [...(thread.snapshotEpochs ?? []), observingEpoch];
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

export function getPendingIndex(thread: ObservingThread): PendingIndex | null {
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
  thread: ObservingThread,
  maxEpoch: number,
): PendingIndex | null {
  const snapshotEpochs = thread.snapshotEpochs ?? [];
  let latestSnapshotSequence = -1;
  for (let index = thread.snapshots.length - 1; index >= 0; index -= 1) {
    const snapshotEpoch = snapshotEpochs[index] ?? thread.observingEpoch;
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
