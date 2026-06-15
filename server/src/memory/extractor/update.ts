import type { QueuedExtractionChange } from '../checkpoint.js';
import type { NativeTables } from '../native.js';
import { applyExtractionChanges, applyExtractionTableChanges } from './extraction-index.js';
import {
  getPendingIndex,
  snapshotRef,
} from './snapshot.js';
import { threadIdentityKey } from './session.js';
import type { SessionMemoryThread } from './types.js';

async function catchUpIndex(
  client: NativeTables,
  thread: SessionMemoryThread,
  signal?: AbortSignal,
): Promise<QueuedExtractionChange[]> {
  const pending = getPendingIndex(thread);
  if (!pending) {
    return [];
  }

  let latestIndexedSequence = thread.indexedSnapshotSequence ?? null;
  const queued: QueuedExtractionChange[] = [];
  for (let snapshotIndex = pending.start; snapshotIndex <= pending.end; snapshotIndex += 1) {
    throwIfAborted(signal);
    const current = thread.snapshots[snapshotIndex];
    const previous = snapshotIndex > 0 ? thread.snapshots[snapshotIndex - 1] : undefined;
    const previousIds = new Set((previous?.extractions ?? [])
      .map((extraction) => extraction.id)
      .filter((id): id is string => Boolean(id)));
    const diff = applyExtractionChanges(previous?.extractions ?? [], {
      title: thread.title,
      summary: thread.summary,
      signals: current.signals ?? '',
      snapshotContent: current.snapshotContent,
      extractions: current.extractions.map((extraction) => (
        extraction.id && previousIds.has(extraction.id)
          ? extraction
          : { ...extraction, id: undefined }
      )),
      openQuestions: current.openQuestions ?? [],
      nextSteps: current.nextSteps ?? [],
      contextRefs: current.contextRefs,
    });
    queued.push(...await applyExtractionTableChanges(
      client,
      {
        ...current,
        extractions: diff.extractions,
        extractionChanges: diff.extractionChanges,
      },
      snapshotRef(thread, snapshotIndex),
      signal,
    ));
    latestIndexedSequence = snapshotIndex;
  }

  if (latestIndexedSequence !== thread.indexedSnapshotSequence) {
    thread.indexedSnapshotSequence = latestIndexedSequence;
  }
  return queued;
}

export async function buildExtraction(
  client: NativeTables,
  threads: SessionMemoryThread[],
  signal?: AbortSignal,
): Promise<QueuedExtractionChange[]> {
  let firstError: unknown = null;
  const queued: QueuedExtractionChange[] = [];
  for (const thread of threads) {
    throwIfAborted(signal);
    if (!getPendingIndex(thread)) {
      continue;
    }
    try {
      queued.push(...await catchUpIndex(client, thread, signal));
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) {
    throw firstError;
  }
  return queued;
}

export async function buildTouchedIndex(
  client: NativeTables,
  threads: SessionMemoryThread[],
  touchedIds: Set<string>,
  signal?: AbortSignal,
): Promise<QueuedExtractionChange[]> {
  let firstError: unknown = null;
  const queued: QueuedExtractionChange[] = [];
  for (const thread of threads) {
    throwIfAborted(signal);
    if (!touchedIds.has(threadIdentityKey(thread)) || !getPendingIndex(thread)) {
      continue;
    }
    try {
      queued.push(...await catchUpIndex(client, thread, signal));
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) {
    throw firstError;
  }
  return queued;
}

export const __testing = {
  buildTouchedIndex,
  buildExtraction,
};

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }
  const error = new Error('operation aborted');
  error.name = 'AbortError';
  throw error;
}
