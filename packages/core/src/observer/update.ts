import type { SessionTurn } from '../client.js';
import { Memories } from '../memories/memories.js';
import type { NativeTables } from '../native.js';
import { routeObservingThreads, observeThread } from '../llm/observing-gateway.js';
import { applyObservationChanges, applyObservationTableChanges } from './memory-delta.js';
import type { SealedEpoch } from './epoch.js';
import { writeGatewayTrace } from './gateway-trace.js';
import {
  isActiveThread,
  applyObserveResult,
  createObservingThread,
  currentObservingContent,
  getPendingIndex,
  latestSnapshot,
  snapshotRef,
  toObservingSnapshot,
} from './thread.js';
import type { ObservingThread, ObservingTurnInput, ThreadWorkItem } from './types.js';

type ObserveThreadImpl = typeof observeThread;

type ApplyGatewayUpdatesParams = {
  threads: ObservingThread[];
  observerName: string;
  pendingTurns: SessionTurn[];
  observingEpoch: number;
  updates: ThreadWorkItem[];
  signal?: AbortSignal;
  memories?: Pick<Memories, 'get'>;
  observeThreadImpl?: ObserveThreadImpl;
};

export async function observeEpoch(params: {
  client: NativeTables;
  observerName: string;
  activeWindowDays: number;
  threads: ObservingThread[];
  sealedEpoch: SealedEpoch;
  signal?: AbortSignal;
}): Promise<{ threads: ObservingThread[]; touchedIds: Set<string> }> {
  throwIfAborted(params.signal);
  ensureActiveThreads(
    params.threads,
    params.activeWindowDays,
  );
  const memories = new Memories(params.client);
  const fitting = await routeObservingThreads(
    activeGatewayInputs(
      params.threads,
      params.observerName,
      params.activeWindowDays,
    ),
    params.sealedEpoch.turns,
    params.signal,
  );
  await writeGatewayTrace({
    observingEpoch: params.sealedEpoch.epoch,
    workItems: fitting.workItems,
    ignoredTurnIds: fitting.ignoredTurnIds,
  });
  const touchedIds = await applyGatewayUpdates({
    threads: params.threads,
    observerName: params.observerName,
    pendingTurns: params.sealedEpoch.turns,
    observingEpoch: params.sealedEpoch.epoch,
    updates: fitting.workItems,
    signal: params.signal,
    memories,
  });
  await flushThreads(params.client, params.threads, touchedIds);
  return {
    threads: params.threads,
    touchedIds,
  };
}

function activeThreadInputs(
  threads: ObservingThread[],
  observerName: string,
  activeWindowDays: number,
) {
  return threads
    .filter((thread) => thread.observer === observerName)
    .filter((thread) => isActiveThread(thread.updatedAt, activeWindowDays))
    .map((thread) => ({
      threadId: thread.observingId,
      ...(thread.snapshotId ? { memoryId: thread.snapshotId } : {}),
      title: thread.title,
      summary: thread.summary,
    }));
}

function ensureActiveThreads(
  threads: ObservingThread[],
  activeWindowDays: number,
): void {
  const activeThreads = threads.filter((thread) => isActiveThread(thread.updatedAt, activeWindowDays));
  threads.splice(0, threads.length, ...activeThreads);
}

function activeGatewayInputs(
  threads: ObservingThread[],
  observerName: string,
  activeWindowDays: number,
  continuityHintCount = 1,
) {
  return threads
    .filter((thread) => thread.observer === observerName)
    .filter((thread) => isActiveThread(thread.updatedAt, activeWindowDays))
    .map((thread) => {
      const continuityHints = latestSnapshot(thread)?.contextRefs
        .slice(-continuityHintCount)
        .map((reference) => reference.summary)
        .filter((summary) => summary.trim()) ?? [];
      return {
        threadId: thread.observingId,
        title: thread.title,
        ...(continuityHints.length > 0 ? { continuityHints } : {}),
      };
    });
}

async function applyGatewayUpdates(params: ApplyGatewayUpdatesParams): Promise<Set<string>> {
  const {
    threads,
    observerName,
    pendingTurns,
    observingEpoch,
    updates,
    signal,
    memories,
    observeThreadImpl = observeThread,
  } = params;
  throwIfAborted(signal);
  const turnMap = new Map(pendingTurns.map((turn) => [turn.turnId, turn]));
  const observeTurnsByThread = new Map<string, ObservingTurnInput[]>();
  const touchedIds = new Set<string>();
  const now = new Date().toISOString();

  for (const item of updates) {
    const observeTurns = item.sourceRefs.flatMap((reference): ObservingTurnInput[] => {
      const turn = turnMap.get(reference.turnId);
      if (!turn) {
        return [];
      }
      return [{
        turnId: turn.turnId,
        excerpt: reference.excerpt,
        prompt: turn.prompt,
        response: turn.response,
      }];
    });
    if (observeTurns.length === 0) {
      continue;
    }

    const targetId = item.targetThreadId?.trim() || null;
    if (targetId) {
      const thread = threads.find((candidate) => candidate.observingId === targetId);
      if (!thread) {
        continue;
      }
      touchedIds.add(targetId);
      mergeObservingTurnInputs(observeTurnsByThread, targetId, observeTurns);
      thread.updatedAt = now;
      thread.observingEpoch = observingEpoch;
      continue;
    }

    const newThreadTitle = item.newThreadTitle?.trim();
    if (!newThreadTitle) {
      continue;
    }
    const thread = createObservingThread(
      observerName,
      newThreadTitle,
      newThreadTitle,
      [],
      observingEpoch,
      now,
    );
    threads.push(thread);
    touchedIds.add(thread.observingId);
    mergeObservingTurnInputs(observeTurnsByThread, thread.observingId, observeTurns);
  }

  for (const [observingId, sourceRefs] of observeTurnsByThread.entries()) {
    throwIfAborted(signal);
    const thread = threads.find((candidate) => candidate.observingId === observingId);
    if (!thread) {
      continue;
    }
    const result = await observeThreadImpl({
      observingContent: currentObservingContent(thread),
      sourceRefs,
      threadMemoryId: thread.snapshotId ?? null,
    }, signal, {
      memories,
    });
    applyObserveResult(thread, result, observingEpoch, applyObservationChanges);
    touchedIds.add(observingId);
  }

  return touchedIds;
}

async function flushThreads(
  client: NativeTables,
  threads: ObservingThread[],
  touchedIds: Set<string>,
): Promise<void> {
  const touched = threads
    .filter((thread) => touchedIds.has(thread.observingId))
    .filter((thread) => thread.snapshots.length > 0);
  if (touched.length === 0) {
    return;
  }

  const persistedRows = await client.observingTable.insert({
    snapshots: touched.map(toObservingSnapshot),
  });
  updateThreadsFromRows(threads, persistedRows);
}

async function catchUpIndex(
  client: NativeTables,
  thread: ObservingThread,
  signal?: AbortSignal,
): Promise<void> {
  const pending = getPendingIndex(thread);
  if (!pending) {
    return;
  }

  let latestIndexedSequence = thread.indexedSnapshotSequence ?? null;
  for (let snapshotIndex = pending.start; snapshotIndex <= pending.end; snapshotIndex += 1) {
    throwIfAborted(signal);
    await applyObservationTableChanges(
      client,
      thread.snapshots[snapshotIndex],
      snapshotRef(thread, snapshotIndex),
      signal,
    );
    latestIndexedSequence = snapshotIndex;
  }

  if (latestIndexedSequence !== thread.indexedSnapshotSequence) {
    thread.indexedSnapshotSequence = latestIndexedSequence;
  }
}

export async function buildObservation(
  client: NativeTables,
  threads: ObservingThread[],
  signal?: AbortSignal,
): Promise<void> {
  let firstError: unknown = null;
  for (const thread of threads) {
    throwIfAborted(signal);
    if (!getPendingIndex(thread)) {
      continue;
    }
    try {
      await catchUpIndex(client, thread, signal);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) {
    throw firstError;
  }
}

export async function buildTouchedIndex(
  client: NativeTables,
  threads: ObservingThread[],
  touchedIds: Set<string>,
  signal?: AbortSignal,
): Promise<void> {
  let firstError: unknown = null;
  for (const thread of threads) {
    throwIfAborted(signal);
    if (!touchedIds.has(thread.observingId) || !getPendingIndex(thread)) {
      continue;
    }
    try {
      await catchUpIndex(client, thread, signal);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) {
    throw firstError;
  }
}

function updateThreadsFromRows(
  threads: ObservingThread[],
  rows: Array<import('./types.js').ObservingSnapshot>,
): void {
  const rowsById = new Map(rows.map((row) => [row.observingId, row]));
  for (const thread of threads) {
    const row = rowsById.get(thread.observingId);
    if (!row) {
      continue;
    }
    thread.snapshotId = row.snapshotId;
    if (thread.snapshotIds[thread.snapshotIds.length - 1] !== row.snapshotId) {
      thread.snapshotIds.push(row.snapshotId);
    }
    thread.references = [...row.references];
    thread.updatedAt = row.updatedAt;
  }
}

function mergeObservingTurnInputs(
  byThread: Map<string, ObservingTurnInput[]>,
  observingId: string,
  inputs: ObservingTurnInput[],
): void {
  const turns = byThread.get(observingId) ?? [];
  turns.push(...inputs);
  byThread.set(observingId, turns);
}

export const __testing = {
  flushThreads,
  buildTouchedIndex,
  buildObservation,
  observeEpoch,
  activeThreadInputsForTests: activeThreadInputs,
  activeGatewayInputsForTests: activeGatewayInputs,
  applyGatewayUpdatesForTests: applyGatewayUpdates,
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
