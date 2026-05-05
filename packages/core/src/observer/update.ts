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
  snapshotRef,
  toObservingSnapshot,
} from './thread.js';
import type { ObserveFragmentInput, ObservingThread, SessionFragment } from './types.js';

type ObserveThreadImpl = typeof observeThread;

type ApplyGatewayUpdatesParams = {
  threads: ObservingThread[];
  observerName: string;
  pendingTurns: SessionTurn[];
  observingEpoch: number;
  sessionFragments: SessionFragment[];
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
  ensureSessionThread(
    params.threads,
    params.observerName,
    params.sealedEpoch.turns,
    params.sealedEpoch.epoch,
  );
  const memories = new Memories(params.client);
  const gatewayStartedAt = Date.now();
  const fitting = await routeObservingThreads(
    activeGatewayInputs(
      params.threads,
      params.observerName,
      params.activeWindowDays,
    ),
    params.sealedEpoch.turns,
    params.signal,
  );
  const gatewayDurationMs = Date.now() - gatewayStartedAt;
  await writeGatewayTrace({
    observingEpoch: params.sealedEpoch.epoch,
    durationMs: gatewayDurationMs,
    sessionFragments: fitting.sessionFragments,
  });
  const touchedIds = await applyGatewayUpdates({
    threads: params.threads,
    observerName: params.observerName,
    pendingTurns: params.sealedEpoch.turns,
    observingEpoch: params.sealedEpoch.epoch,
    sessionFragments: fitting.sessionFragments,
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
) {
  return threads
    .filter((thread) => thread.observer === observerName)
    .filter((thread) => isActiveThread(thread.updatedAt, activeWindowDays))
    .map((thread) => ({
      threadId: thread.observingId,
      kind: thread.kind,
      title: thread.title,
      summary: thread.summary,
    }));
}

function ensureSessionThread(
  threads: ObservingThread[],
  observerName: string,
  pendingTurns: SessionTurn[],
  observingEpoch: number,
): ObservingThread | null {
  const sessionId = pendingTurns.find((turn) => turn.sessionId?.trim())?.sessionId?.trim() ?? null;
  const existing = threads.find((thread) => (
    thread.observer === observerName
    && thread.kind === 'session'
    && (thread.sessionId ?? null) === sessionId
  ));
  if (existing) {
    return existing;
  }
  const title = sessionId ? `Session ${sessionId}` : 'Session observing thread';
  const summary = sessionId
    ? `Default observing thread for session ${sessionId}.`
    : 'Default observing thread for this session.';
  const thread = createObservingThread(
    observerName,
    title,
    summary,
    [],
    observingEpoch,
    new Date().toISOString(),
    'session',
    sessionId,
  );
  threads.push(thread);
  return thread;
}

async function applyGatewayUpdates(params: ApplyGatewayUpdatesParams): Promise<Set<string>> {
  const {
    threads,
    observerName,
    pendingTurns,
    observingEpoch,
    sessionFragments,
    signal,
    memories,
    observeThreadImpl = observeThread,
  } = params;
  throwIfAborted(signal);
  const turnMap = new Map(pendingTurns.map((turn) => [turn.turnId, turn]));
  const observeFragmentsByThread = new Map<string, ObserveFragmentInput[]>();
  const touchedIds = new Set<string>();
  const now = new Date().toISOString();

  for (const fragment of sessionFragments) {
    const turns = fragment.turnIds.flatMap((turnId): ObserveFragmentInput['turns'] => {
      const turn = turnMap.get(turnId);
      if (!turn) {
        return [];
      }
      return [{
        turnId: turn.turnId,
        prompt: turn.prompt,
        response: turn.response,
      }];
    });
    if (turns.length === 0) {
      continue;
    }

    const threadId = fragment.threadId.trim();
    const thread = threads.find((candidate) => candidate.observingId === threadId);
    if (!thread) {
      continue;
    }
    touchedIds.add(threadId);
    mergeObservingFragments(observeFragmentsByThread, threadId, [{
      content: fragment.content,
      turns,
    }]);
    thread.updatedAt = now;
    thread.observingEpoch = observingEpoch;
  }

  for (const [observingId, fragments] of observeFragmentsByThread.entries()) {
    throwIfAborted(signal);
    const thread = threads.find((candidate) => candidate.observingId === observingId);
    if (!thread) {
      continue;
    }
    const result = await observeThreadImpl({
      observingContent: currentObservingContent(thread),
      fragments,
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

function mergeObservingFragments(
  byThread: Map<string, ObserveFragmentInput[]>,
  observingId: string,
  inputs: ObserveFragmentInput[],
): void {
  const fragments = byThread.get(observingId) ?? [];
  fragments.push(...inputs);
  byThread.set(observingId, fragments);
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
