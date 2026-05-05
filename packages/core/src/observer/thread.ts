import { randomUUID } from 'node:crypto';

import type {
  ObserveResult,
  Observation,
  ObservingContent,
  ObservingSnapshot,
  ObservingThread,
  ObservingThreadKind,
  PendingIndex,
  ContextRef,
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
  kind: ObservingThreadKind = 'subject',
  sessionId: string | null = null,
): ObservingThread {
  return {
    observingId: randomUUID(),
    kind,
    sessionId,
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
    kind: thread.kind,
    sessionId: thread.sessionId ?? null,
    snapshotIds: [...thread.snapshotIds],
    snapshotEpochs: [...(thread.snapshotEpochs ?? [])],
    references: [...thread.references],
    snapshots: thread.snapshots.map((snapshot) => ({
      threadKind: snapshot.threadKind ?? thread.kind,
      sessionId: snapshot.sessionId ?? thread.sessionId ?? null,
      observations: snapshot.observations.map((observation) => ({
        id: observation.id ?? null,
        text: observation.text,
        category: observation.category,
        references: [...(observation.references ?? [])],
        updatedMemory: observation.updatedMemory ?? null,
      })),
      contextRefs: snapshot.contextRefs.map((reference) => ({ ...reference })),
      openQuestions: [...(snapshot.openQuestions ?? [])],
      nextSteps: [...(snapshot.nextSteps ?? [])],
      observationChanges: (snapshot.observationChanges ?? []).map((change) => ({ ...change })),
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
  const latestContent = deserializeSnapshot(latest);
  return {
    observingId: latest.observingId,
    kind: latestContent.threadKind ?? 'subject',
    sessionId: latestContent.sessionId ?? null,
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
    const snapshot = deserializeSnapshot(row);
    thread.kind = snapshot.threadKind ?? thread.kind;
    thread.sessionId = snapshot.sessionId ?? thread.sessionId ?? null;
    thread.snapshots.push(snapshot);
    thread.references = [...row.references];
    thread.updatedAt = row.updatedAt;
  }
}

export function currentObservingContent(thread: ObservingThread): ObservingContent {
  const snapshot = latestSnapshot(thread) ?? emptySnapshot();
  return {
    title: thread.title,
    summary: thread.summary,
    observations: snapshot.observations,
    openQuestions: snapshot.openQuestions ?? [],
    nextSteps: snapshot.nextSteps ?? [],
  };
}

export function applyObserveResult(
  thread: ObservingThread,
  result: ObserveResult,
  observingEpoch: number,
  applyObservationChanges: (
    observations: Observation[],
    result: ObserveResult,
  ) => { observationChanges: SnapshotContent['observationChanges']; observations: Observation[] },
  now = new Date().toISOString(),
): void {
  const current = latestSnapshot(thread) ?? emptySnapshot();
  const patched = applyObservationChanges(current.observations, result);
  thread.title = result.observingContent.title;
  thread.summary = result.observingContent.summary;
  thread.observingEpoch = observingEpoch;
  thread.snapshots.push({
    threadKind: thread.kind,
    sessionId: thread.sessionId ?? null,
    observations: patched.observations,
    contextRefs: mergeContextRefs(
      current.contextRefs,
      result.contextRefs,
    ),
    openQuestions: result.observingContent.openQuestions,
    nextSteps: result.observingContent.nextSteps,
    observationChanges: patched.observationChanges,
  });
  thread.references = latestSnapshot(thread)?.contextRefs.map((reference) => reference.turnId) ?? [];
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
    references: snapshot.contextRefs.map((reference) => reference.turnId),
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
    threadKind: parsed.threadKind,
    sessionId: parsed.sessionId ?? null,
    observations: Array.isArray(parsed.observations) ? parsed.observations as Observation[] : [],
    contextRefs: normalizeContextRefs(parsed.contextRefs),
    openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [],
    nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps : [],
    observationChanges: Array.isArray(parsed.observationChanges) ? parsed.observationChanges : [],
  };
}

function emptySnapshot(): SnapshotContent {
  return {
    threadKind: 'subject',
    sessionId: null,
    observations: [],
    contextRefs: [],
    openQuestions: [],
    nextSteps: [],
    observationChanges: [],
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
    const removableIndex = references.findIndex((reference) => reference.startsWith('session:'));
    references.splice(removableIndex >= 0 ? removableIndex : 0, 1);
  }
}

export const __testing = {
  applyObserveResultForTests: applyObserveResult,
};
