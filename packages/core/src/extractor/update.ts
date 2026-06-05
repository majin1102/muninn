import type { Turn } from '../client.js';
import type { QueuedSessionObservationChange } from '../checkpoint.js';
import { Memories } from '../memories/memories.js';
import type { NativeTables } from '../native.js';
import { extractSessionMemory } from '../llm/extracting.js';
import { applySessionObservationChanges, applySessionObservationTableChanges } from './memory-delta.js';
import type { SealedEpoch } from './epoch.js';
import {
  isActiveThread,
  applySessionObservationResult,
  createSessionMemoryThread,
  currentSessionMemoryContent,
  getPendingIndex,
  snapshotRef,
  toSessionSnapshot,
} from './thread.js';
import type { FragmentTurnInput, SessionMemoryThread } from './types.js';

type ExtractSessionMemoryImpl = typeof extractSessionMemory;
const DEFAULT_SESSION_ID = '__muninn_default_session__';

type ExtractSessionThreadParams = {
  threads: SessionMemoryThread[];
  extractorName: string;
  pendingTurns: Turn[];
  extractionEpoch: number;
  signal?: AbortSignal;
  database?: string;
  memories?: Pick<Memories, 'get'>;
  extractSessionMemoryImpl?: ExtractSessionMemoryImpl;
};

export async function extractEpoch(params: {
  client: NativeTables;
  extractorName: string;
  activeWindowDays: number;
  threads: SessionMemoryThread[];
  sealedEpoch: SealedEpoch;
  signal?: AbortSignal;
  database?: string;
  extractSessionMemoryImpl?: ExtractSessionMemoryImpl;
}): Promise<{ threads: SessionMemoryThread[]; touchedIds: Set<string> }> {
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
      params.extractorName,
      turns,
      params.sealedEpoch.epoch,
    );
    const groupTouchedIds = await extractSessionThread({
      threads: params.threads,
      extractorName: params.extractorName,
      pendingTurns: turns,
      extractionEpoch: params.sealedEpoch.epoch,
      signal: params.signal,
      database: params.database,
      memories,
      extractSessionMemoryImpl: params.extractSessionMemoryImpl,
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
    const key = turnGroupKey(turn, sessionId ?? DEFAULT_SESSION_ID);
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
      throw new Error('extractSessionThread requires pendingTurns from a single session');
    }
  }
  return expected ?? DEFAULT_SESSION_ID;
}

function turnGroupKey(turn: Turn, sessionId: string): string {
  return `${turn.agent}\0${turn.project}\0${turn.cwd}\0${sessionId}`;
}

function ownershipForTurns(turns: Turn[]): { agent: string; project: string; cwd: string } {
  const first = turns[0];
  if (!first) {
    throw new Error('missing turns for session ownership');
  }
  for (const turn of turns) {
    if (turn.agent !== first.agent || turn.project !== first.project || turn.cwd !== first.cwd) {
      throw new Error('extractSessionThread requires pendingTurns from a single project/cwd/agent');
    }
  }
  return {
    agent: first.agent,
    project: first.project,
    cwd: first.cwd,
  };
}

function activeThreadInputs(
  threads: SessionMemoryThread[],
  extractorName: string,
  activeWindowDays: number,
) {
  return threads
    .filter((thread) => thread.observer === extractorName)
    .filter((thread) => isActiveThread(thread.updatedAt, activeWindowDays))
    .map((thread) => ({
      threadId: thread.threadId,
      ...(thread.snapshotId ? { memoryId: thread.snapshotId } : {}),
      title: thread.title,
      summary: thread.summary,
    }));
}

function ensureActiveThreads(
  threads: SessionMemoryThread[],
  activeWindowDays: number,
): void {
  const activeThreads = threads.filter((thread) => isActiveThread(thread.updatedAt, activeWindowDays));
  threads.splice(0, threads.length, ...activeThreads);
}

function ensureSessionThread(
  threads: SessionMemoryThread[],
  extractorName: string,
  pendingTurns: Turn[],
  extractionEpoch: number,
): SessionMemoryThread | null {
  const sessionId = sessionIdForTurns(pendingTurns);
  const ownership = ownershipForTurns(pendingTurns);
  const existing = threads.find((thread) => (
    thread.observer === extractorName
    && thread.kind === 'session'
    && (thread.sessionId ?? null) === sessionId
    && thread.agent === ownership.agent
    && thread.project === ownership.project
    && thread.cwd === ownership.cwd
  ));
  if (existing) {
    return existing;
  }
  const title = sessionId ? `Session ${sessionId}` : 'Session memory thread';
  const summary = sessionId
    ? `Default session memory thread for session ${sessionId}.`
    : 'Default session memory thread for this session.';
  const thread = createSessionMemoryThread(
    extractorName,
    title,
    summary,
    [],
    extractionEpoch,
    new Date().toISOString(),
    'session',
    sessionId,
    ownership,
  );
  threads.push(thread);
  return thread;
}

async function extractSessionThread(params: ExtractSessionThreadParams): Promise<Set<string>> {
  const {
    threads,
    extractorName,
    pendingTurns,
    extractionEpoch,
    signal,
    memories,
    extractSessionMemoryImpl = extractSessionMemory,
  } = params;
  throwIfAborted(signal);
  const touchedIds = new Set<string>();
  const now = new Date().toISOString();
  const sessionId = sessionIdForTurns(pendingTurns);
  const ownership = ownershipForTurns(pendingTurns);
  const thread = threads.find((candidate) => (
    candidate.observer === extractorName
    && candidate.kind === 'session'
    && (candidate.sessionId ?? null) === sessionId
    && candidate.agent === ownership.agent
    && candidate.project === ownership.project
    && candidate.cwd === ownership.cwd
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
  thread.extractionEpoch = extractionEpoch;
  const result = await extractSessionMemoryImpl({
    sessionMemoryContent: currentSessionMemoryContent(thread),
    turns,
  }, signal, { memories, database: params.database });
  applySessionObservationResult(thread, result, extractionEpoch, applySessionObservationChanges);
  touchedIds.add(thread.threadId);
  return touchedIds;
}

async function flushThreads(
  client: NativeTables,
  threads: SessionMemoryThread[],
  touchedIds: Set<string>,
): Promise<void> {
  const touched = threads
    .filter((thread) => touchedIds.has(thread.threadId))
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
  thread: SessionMemoryThread,
  signal?: AbortSignal,
): Promise<QueuedSessionObservationChange[]> {
  const pending = getPendingIndex(thread);
  if (!pending) {
    return [];
  }

  let latestIndexedSequence = thread.indexedSnapshotSequence ?? null;
  const queued: QueuedSessionObservationChange[] = [];
  for (let snapshotIndex = pending.start; snapshotIndex <= pending.end; snapshotIndex += 1) {
    throwIfAborted(signal);
    const current = thread.snapshots[snapshotIndex];
    const previous = snapshotIndex > 0 ? thread.snapshots[snapshotIndex - 1] : undefined;
    const previousIds = new Set((previous?.extractions ?? [])
      .map((extraction) => extraction.id)
      .filter((id): id is string => Boolean(id)));
    const diff = applySessionObservationChanges(previous?.extractions ?? [], {
      title: thread.title,
      summary: thread.summary,
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
    queued.push(...await applySessionObservationTableChanges(
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

export async function buildSessionObservation(
  client: NativeTables,
  threads: SessionMemoryThread[],
  signal?: AbortSignal,
): Promise<QueuedSessionObservationChange[]> {
  let firstError: unknown = null;
  const queued: QueuedSessionObservationChange[] = [];
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
): Promise<QueuedSessionObservationChange[]> {
  let firstError: unknown = null;
  const queued: QueuedSessionObservationChange[] = [];
  for (const thread of threads) {
    throwIfAborted(signal);
    if (!touchedIds.has(thread.threadId) || !getPendingIndex(thread)) {
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

function updateThreadsFromRows(
  threads: SessionMemoryThread[],
  rows: Array<import('./types.js').SessionSnapshot>,
): void {
  const rowsById = new Map(rows.map((row) => [row.sessionId, row]));
  for (const thread of threads) {
    const row = rowsById.get(thread.threadId);
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
  buildSessionObservation,
  extractEpoch,
  activeThreadInputsForTests: activeThreadInputs,
  extractSessionThreadForTests: extractSessionThread,
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
