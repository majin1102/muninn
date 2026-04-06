import type { CoreBinding } from '../native.js';
import type { SessionTurn } from '../client.js';
import { observeThread, routeObservingThreads } from '../llm/observing-gateway.js';
import { applyMemoriesDelta, applySemanticMemoryDelta } from './memory-delta.js';
import {
  applyObserveResult,
  createObservingThread,
  currentObservingContent,
  pushReference,
  snapshotRef,
  threadHasPendingIndex,
  toObservingSnapshot,
} from './thread.js';
import type { GatewayUpdate, IndexBatch, ObservingThread } from './types.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REFERENCES = 1000;

export async function flushObserverWindow(params: {
  client: CoreBinding;
  observerName: string;
  threads: ObservingThread[];
  epoch: number;
  pendingTurns: SessionTurn[];
}): Promise<{ threads: ObservingThread[]; failedIndexIds: string[] }> {
  ensureRootThread(params.threads, params.observerName, params.pendingTurns, params.epoch);

  const gatewayResult = await routeObservingThreads(
    activeGatewayInputs(params.threads, params.observerName),
    params.pendingTurns,
  );
  const touchedIds = await applyGatewayUpdates(
    params.threads,
    params.observerName,
    params.pendingTurns,
    params.epoch,
    gatewayResult.updates,
  );
  const failedIndexIds = await flushThreads(params.client, params.threads, touchedIds);
  return {
    threads: params.threads,
    failedIndexIds,
  };
}

export async function retryIndexBatches(
  client: CoreBinding,
  threads: ObservingThread[],
  indexBatches: IndexBatch[],
): Promise<IndexBatch[]> {
  const nextBatches: IndexBatch[] = [];
  for (const batch of indexBatches) {
    const failedIds = await retryIndexBatch(client, threads, batch.observingIds);
    if (failedIds.length > 0) {
      nextBatches.push({
        turns: batch.turns,
        observingIds: failedIds,
      });
    }
  }
  return nextBatches;
}

export function restoreIndexBatches(
  threads: ObservingThread[],
  pendingTurns: SessionTurn[],
): IndexBatch[] {
  const observingIdsByEpoch = new Map<number, Set<string>>();
  for (const thread of threads.filter(threadHasPendingIndex)) {
    const ids = observingIdsByEpoch.get(thread.observingEpoch) ?? new Set<string>();
    ids.add(thread.observingId);
    observingIdsByEpoch.set(thread.observingEpoch, ids);
  }
  if (observingIdsByEpoch.size === 0) {
    return [];
  }

  const turnsByEpoch = new Map<number, SessionTurn[]>();
  for (const turn of pendingTurns) {
    if (turn.observingEpoch == null) {
      continue;
    }
    const turns = turnsByEpoch.get(turn.observingEpoch) ?? [];
    turns.push(turn);
    turnsByEpoch.set(turn.observingEpoch, turns);
  }

  return [...observingIdsByEpoch.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([epoch, ids]) => {
      const turns = turnsByEpoch.get(epoch);
      return turns && ids.size > 0 ? [{ turns, observingIds: [...ids] }] : [];
    });
}

function ensureRootThread(
  threads: ObservingThread[],
  observerName: string,
  pendingTurns: SessionTurn[],
  epoch: number,
): void {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const activeThreads = threads.filter((thread) => Date.parse(thread.updatedAt) >= cutoff);
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
) {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  return threads
    .filter((thread) => thread.observer === observerName)
    .filter((thread) => Date.parse(thread.updatedAt) >= cutoff)
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
): Promise<Set<string>> {
  const turnMap = new Map(pendingTurns.map((turn) => [turn.turnId, turn]));
  const observeTurnsByThread = new Map<string, Map<string, { turnId: string; summary: string; whyRelated: string }>>();
  const turnParentById = new Map<string, string>();
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
      if (!turnParentById.has(turn.turnId)) {
        turnParentById.set(turn.turnId, targetId);
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
    thread.pendingParentId = turnParentById.get(turn.turnId) ?? null;
    threads.push(thread);
    touchedIds.add(thread.observingId);
    mergeObservingTurnInput(observeTurnsByThread, thread.observingId, observeTurn);
  }

  for (const [observingId, turnsById] of observeTurnsByThread.entries()) {
    const thread = threads.find((candidate) => candidate.observingId === observingId);
    if (!thread) {
      continue;
    }
    const result = await observeThread({
      observingContent: currentObservingContent(thread),
      pendingTurns: [...turnsById.values()],
    });
    applyObserveResult(thread, result, observingEpoch, applyMemoriesDelta);
    touchedIds.add(observingId);
  }

  return touchedIds;
}

async function flushThreads(
  client: CoreBinding,
  threads: ObservingThread[],
  touchedIds: Set<string>,
): Promise<string[]> {
  const touched = threads
    .filter((thread) => touchedIds.has(thread.observingId))
    .filter((thread) => thread.snapshots.length > 0);
  if (touched.length === 0) {
    return [];
  }

  const persistedRows = await client.observingTable.upsert({
    snapshots: touched.map(toObservingSnapshot),
  });
  updateThreadsFromRows(threads, persistedRows);
  await applyParentRefs(client, threads, touchedIds);

  const failedIndexIds: string[] = [];
  for (const observingId of touchedIds) {
    const thread = threads.find((candidate) => candidate.observingId === observingId);
    if (!thread) {
      continue;
    }
    try {
      await catchUpIndex(client, thread);
    } catch (error) {
      console.error(`[muninn:observer] semantic index flush failed for ${thread.observingId}: ${String(error)}`);
      failedIndexIds.push(thread.observingId);
    }
  }
  return failedIndexIds;
}

async function applyParentRefs(
  client: CoreBinding,
  threads: ObservingThread[],
  touchedIds: Set<string>,
): Promise<void> {
  const snapshotById = new Map(
    threads
      .filter((thread) => thread.snapshotId)
      .map((thread) => [thread.observingId, thread.snapshotId!]),
  );

  const pending = threads
    .filter((thread) => touchedIds.has(thread.observingId))
    .filter((thread) => thread.pendingParentId)
    .map((thread) => {
      const parentSnapshotId = snapshotById.get(thread.pendingParentId!);
      if (!parentSnapshotId) {
        return null;
      }
      const updated: ObservingThread = {
        ...thread,
        references: [...thread.references],
        pendingParentId: null,
      };
      updated.references = updated.references.filter((reference) => reference !== parentSnapshotId);
      updated.references.unshift(parentSnapshotId);
      while (updated.references.length > MAX_REFERENCES) {
        const removableIndex = updated.references.findIndex((reference, index) => (
          index > 0 && reference.startsWith('session:')
        ));
        updated.references.splice(removableIndex >= 0 ? removableIndex : updated.references.length - 1, 1);
      }
      return updated;
    })
    .filter((thread): thread is ObservingThread => Boolean(thread));

  if (pending.length === 0) {
    return;
  }

  const persisted = await client.observingTable.upsert({
    snapshots: pending.map(toObservingSnapshot),
  });
  updateThreadsFromRows(threads, persisted);
}

async function catchUpIndex(client: CoreBinding, thread: ObservingThread): Promise<void> {
  const start = (thread.indexedSnapshotSequence ?? -1) + 1;
  if (start >= thread.snapshots.length) {
    return;
  }

  let latestIndexedSequence = thread.indexedSnapshotSequence ?? null;
  for (let snapshotIndex = start; snapshotIndex < thread.snapshots.length; snapshotIndex += 1) {
    await applySemanticMemoryDelta(client, thread.snapshots[snapshotIndex], snapshotRef(thread, snapshotIndex));
    latestIndexedSequence = snapshotIndex;
  }

  if (latestIndexedSequence !== thread.indexedSnapshotSequence) {
    thread.indexedSnapshotSequence = latestIndexedSequence;
    if (thread.snapshotId) {
      const [persisted] = await client.observingTable.upsert({
        snapshots: [toObservingSnapshot(thread)],
      });
      updateThreadsFromRows([thread], [persisted]);
    }
  }
}

async function retryIndexBatch(
  client: CoreBinding,
  threads: ObservingThread[],
  observingIds: string[],
): Promise<string[]> {
  const failedIds: string[] = [];
  for (const observingId of observingIds) {
    const thread = threads.find((candidate) => candidate.observingId === observingId);
    if (!thread) {
      continue;
    }
    try {
      await catchUpIndex(client, thread);
    } catch (error) {
      console.error(`[muninn:observer] semantic index retry failed for ${thread.observingId}: ${String(error)}`);
      failedIds.push(thread.observingId);
    }
  }
  return failedIds;
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
    thread.pendingParentId = row.checkpoint.pendingParentId ?? null;
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
