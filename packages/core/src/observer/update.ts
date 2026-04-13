import type { NativeTables } from '../native.js';
import type { SessionTurn } from '../client.js';
import { observeThread, routeObservingThreads } from '../llm/observing-gateway.js';
import { applyMemoriesDelta, applySemanticMemoryDelta } from './memory-delta.js';
import type { SealedEpoch } from './epoch.js';
import {
  isActiveThread,
  applyObserveResult,
  createObservingThread,
  currentObservingContent,
  getPendingIndex,
  pushReference,
  snapshotRef,
  toObservingSnapshot,
} from './thread.js';
import type { GatewayUpdate, ObservingThread } from './types.js';

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
    params.observerName,
    params.activeWindowDays,
    params.sealedEpoch.turns,
    params.sealedEpoch.epoch,
  );

  const gatewayResult = await routeObservingThreads(
    activeGatewayInputs(params.threads, params.observerName, params.activeWindowDays),
    params.sealedEpoch.turns,
    params.signal,
  );
  const touchedIds = await applyGatewayUpdates(
    params.threads,
    params.observerName,
    params.sealedEpoch.turns,
    params.sealedEpoch.epoch,
    gatewayResult.updates,
    params.signal,
  );
  await flushThreads(params.client, params.threads, touchedIds);
  return {
    threads: params.threads,
    touchedIds,
  };
}

function ensureActiveThreads(
  threads: ObservingThread[],
  observerName: string,
  activeWindowDays: number,
  pendingTurns: SessionTurn[],
  epoch: number,
): void {
  const activeThreads = threads.filter((thread) => isActiveThread(thread.updatedAt, activeWindowDays));
  threads.splice(0, threads.length, ...activeThreads);
  if (threads.length > 0) {
    return;
  }
  const seed = pendingTurns
    .map((turn) => turn.summary ?? turn.prompt ?? turn.response ?? '')
    .find((value) => value.trim()) ?? 'Session root';
  threads.push(createObservingThread(observerName, seed, seed, [], epoch));
}

function activeGatewayInputs(
  threads: ObservingThread[],
  observerName: string,
  activeWindowDays: number,
) {
  return threads
    .filter((thread) => thread.observer === observerName)
    .filter((thread) => isActiveThread(thread.updatedAt, activeWindowDays))
    .map((thread) => ({
      observingId: thread.observingId,
      title: thread.title,
      summary: thread.summary,
    }));
}

async function applyGatewayUpdates(
  threads: ObservingThread[],
  observerName: string,
  pendingTurns: SessionTurn[],
  observingEpoch: number,
  updates: GatewayUpdate[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  throwIfAborted(signal);
  const turnMap = new Map(pendingTurns.map((turn) => [turn.turnId, turn]));
  const observeTurnsByThread = new Map<string, Map<string, { turnId: string; summary: string; whyRelated: string }>>();
  const touchedIds = new Set<string>();
  const now = new Date().toISOString();

  for (const update of updates) {
    const turn = turnMap.get(update.turnId);
    if (!turn) {
      continue;
    }
    const observeTurn = {
      turnId: turn.turnId,
      summary: turn.summary ?? turn.prompt ?? turn.response ?? '',
      whyRelated: normalizeText(update.why, 100),
    };

    if (update.action === 'append') {
      const targetId = update.observingId;
      if (!targetId) {
        continue;
      }
      const thread = threads.find((candidate) => candidate.observingId === targetId);
      if (!thread) {
        continue;
      }
      touchedIds.add(targetId);
      mergeObservingTurnInput(observeTurnsByThread, targetId, observeTurn);
      pushReference(thread, turn.turnId);
      thread.updatedAt = now;
      thread.observingEpoch = observingEpoch;
      continue;
    }

    const newThread = update.newThread;
    if (!newThread) {
      continue;
    }
    const thread = createObservingThread(
      observerName,
      newThread.title,
      newThread.summary,
      [turn.turnId],
      observingEpoch,
      now,
    );
    threads.push(thread);
    touchedIds.add(thread.observingId);
    mergeObservingTurnInput(observeTurnsByThread, thread.observingId, observeTurn);
  }

  for (const [observingId, turnsById] of observeTurnsByThread.entries()) {
    throwIfAborted(signal);
    const thread = threads.find((candidate) => candidate.observingId === observingId);
    if (!thread) {
      continue;
    }
    const result = await observeThread({
      observingContent: currentObservingContent(thread),
      pendingTurns: [...turnsById.values()],
    }, signal);
    applyObserveResult(thread, result, observingEpoch, applyMemoriesDelta);
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
    await applySemanticMemoryDelta(
      client,
      thread.snapshots[snapshotIndex],
      snapshotRef(thread, snapshotIndex),
      signal,
    );
    latestIndexedSequence = snapshotIndex;
  }

  if (latestIndexedSequence !== thread.indexedSnapshotSequence) {
    thread.indexedSnapshotSequence = latestIndexedSequence;
    if (thread.snapshotId) {
      const [persisted] = await client.observingTable.update({
        snapshots: [toObservingSnapshot(thread)],
      });
      updateThreadsFromRows([thread], [persisted]);
    }
  }
}

export async function buildSemanticIndex(
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
    thread.indexedSnapshotSequence = row.checkpoint.indexedSnapshotSequence ?? null;
    thread.observingEpoch = row.checkpoint.observingEpoch;
    thread.updatedAt = row.updatedAt;
  }
}

function mergeObservingTurnInput(
  byThread: Map<string, Map<string, { turnId: string; summary: string; whyRelated: string }>>,
  observingId: string,
  input: { turnId: string; summary: string; whyRelated: string },
): void {
  const turns = byThread.get(observingId) ?? new Map<string, { turnId: string; summary: string; whyRelated: string }>();
  const existing = turns.get(input.turnId);
  if (existing && !existing.whyRelated.includes(input.whyRelated)) {
    existing.whyRelated = normalizeText(`${existing.whyRelated} ${input.whyRelated}`, 180);
  } else if (!existing) {
    turns.set(input.turnId, input);
  }
  byThread.set(observingId, turns);
}

function normalizeText(value: string, maxChars: number): string {
  const collapsed = value.split(/\s+/).join(' ').trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(maxChars - 3, 0))}...`;
}

export const __testing = {
  flushThreads,
  buildTouchedIndex,
  buildSemanticIndex,
  observeEpoch,
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
