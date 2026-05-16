import type { Turn } from '../client.js';
import { Memories } from '../memories/memories.js';
import type { NativeTables } from '../native.js';
import { observeThread } from '../llm/extracting.js';
import { applyExtractionChanges, applyExtractionTableChanges } from './memory-delta.js';
import type { SealedEpoch } from './epoch.js';
import {
  isActiveThread,
  applyObserveResult,
  createObservingThread,
  currentObservingContent,
  getPendingIndex,
  snapshotRef,
  toSessionSnapshot,
} from './thread.js';
import type { FragmentTurnInput, ObservingThread } from './types.js';

type ObserveThreadImpl = typeof observeThread;
const DEFAULT_SESSION_ID = '__muninn_default_session__';

type ObserveSessionThreadParams = {
  threads: ObservingThread[];
  observerName: string;
  pendingTurns: Turn[];
  observingEpoch: number;
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
  observeThreadImpl?: ObserveThreadImpl;
}): Promise<{ threads: ObservingThread[]; touchedIds: Set<string> }> {
  throwIfAborted(params.signal);
  ensureActiveThreads(
    params.threads,
    params.activeWindowDays,
  );
  const memories = new Memories(params.client);
  const touchedIds = new Set<string>();
  for (const turns of groupTurnsBySession(params.sealedEpoch.turns)) {
    ensureSessionThread(
      params.threads,
      params.observerName,
      turns,
      params.sealedEpoch.epoch,
    );
    const groupTouchedIds = await observeSessionThread({
      threads: params.threads,
      observerName: params.observerName,
      pendingTurns: turns,
      observingEpoch: params.sealedEpoch.epoch,
      signal: params.signal,
      memories,
      observeThreadImpl: params.observeThreadImpl,
    });
    for (const touchedId of groupTouchedIds) {
      touchedIds.add(touchedId);
    }
  }
  await flushThreads(params.client, params.threads, touchedIds);
  return {
    threads: params.threads,
    touchedIds,
  };
}

function normalizedSessionId(turn: Pick<Turn, 'sessionId'>): string | null {
  const sessionId = turn.sessionId?.trim();
  return sessionId && sessionId.length > 0 ? sessionId : null;
}

function groupTurnsBySession(turns: Turn[]): Turn[][] {
  const groups = new Map<string, Turn[]>();
  const order: string[] = [];
  for (const turn of turns) {
    const sessionId = normalizedSessionId(turn);
    const key = sessionId ?? DEFAULT_SESSION_ID;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
      order.push(key);
    }
    group.push(turn);
  }
  return order.map((key) => groups.get(key)!);
}

function sessionIdForTurns(turns: Turn[]): string {
  let expected: string | null | undefined;
  for (const turn of turns) {
    const sessionId = normalizedSessionId(turn);
    if (expected === undefined) {
      expected = sessionId;
      continue;
    }
    if (sessionId !== expected) {
      throw new Error('observeSessionThread requires pendingTurns from a single session');
    }
  }
  return expected ?? DEFAULT_SESSION_ID;
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

function ensureSessionThread(
  threads: ObservingThread[],
  observerName: string,
  pendingTurns: Turn[],
  observingEpoch: number,
): ObservingThread | null {
  const sessionId = sessionIdForTurns(pendingTurns);
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

async function observeSessionThread(params: ObserveSessionThreadParams): Promise<Set<string>> {
  const {
    threads,
    observerName,
    pendingTurns,
    observingEpoch,
    signal,
    memories,
    observeThreadImpl = observeThread,
  } = params;
  throwIfAborted(signal);
  const touchedIds = new Set<string>();
  const now = new Date().toISOString();
  const sessionId = sessionIdForTurns(pendingTurns);
  const thread = threads.find((candidate) => (
    candidate.observer === observerName
    && candidate.kind === 'session'
    && (candidate.sessionId ?? null) === sessionId
  ));
  if (!thread || pendingTurns.length === 0) {
    return touchedIds;
  }

  const turns: FragmentTurnInput[] = pendingTurns.map((turn) => ({
    turnId: turn.turnId,
    prompt: turn.prompt,
    response: turn.response,
    summary: turn.summary,
  }));
  thread.updatedAt = now;
  thread.observingEpoch = observingEpoch;
  const result = await observeThreadImpl({
    observingContent: currentObservingContent(thread),
    turns,
  }, signal, { memories });
  applyObserveResult(thread, result, observingEpoch, applyExtractionChanges);
  touchedIds.add(thread.observingId);
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

  const persistedRows = await client.sessionTable.insert({
    snapshots: touched.map(toSessionSnapshot),
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
    const current = thread.snapshots[snapshotIndex];
    const previous = snapshotIndex > 0 ? thread.snapshots[snapshotIndex - 1] : undefined;
    const previousIds = new Set((previous?.extractions ?? [])
      .map((extraction) => extraction.id)
      .filter((id): id is string => Boolean(id)));
    const diff = applyExtractionChanges(previous?.extractions ?? [], {
      title: thread.title,
      summary: thread.summary,
      threadMemory: current.threadMemory,
      extractions: current.extractions.map((extraction) => (
        extraction.id && previousIds.has(extraction.id)
          ? extraction
          : { ...extraction, id: undefined }
      )),
      openQuestions: current.openQuestions ?? [],
      nextSteps: current.nextSteps ?? [],
      contextRefs: current.contextRefs,
    });
    await applyExtractionTableChanges(
      client,
      {
        ...current,
        extractions: diff.extractions,
        extractionChanges: diff.extractionChanges,
      },
      snapshotRef(thread, snapshotIndex),
      signal,
    );
    latestIndexedSequence = snapshotIndex;
  }

  if (latestIndexedSequence !== thread.indexedSnapshotSequence) {
    thread.indexedSnapshotSequence = latestIndexedSequence;
  }
}

export async function buildExtraction(
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
  rows: Array<import('./types.js').SessionSnapshot>,
): void {
  const rowsById = new Map(rows.map((row) => [row.sessionId, row]));
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

export const __testing = {
  flushThreads,
  buildTouchedIndex,
  buildExtraction,
  observeEpoch,
  activeThreadInputsForTests: activeThreadInputs,
  observeSessionThreadForTests: observeSessionThread,
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
