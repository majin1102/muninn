import type { Turn } from '../backend.js';
import { Memories } from '../memories.js';
import type { NativeTables } from '../native.js';
import { extractSessionMemory } from '../llm/extracting.js';
import { applyExtractionChanges } from './extraction-index.js';
import type { SealedEpoch } from './epoch.js';
import {
  applyExtraction,
  createSessionThread,
  currentSessionMemory,
  DEFAULT_SESSION_ID,
  isActiveThread,
  threadIdentityKey,
  toSessionSnapshot,
} from './snapshot.js';
import type { TurnInput, SessionThread, SessionSnapshot } from './snapshot.js';

type SessionExtractionImpl = typeof extractSessionMemory;

type ExtractSessionThreadParams = {
  thread: SessionThread;
  pendingTurns: Turn[];
  extractionEpoch: number;
  signal?: AbortSignal;
  database?: string;
  memories?: Pick<Memories, 'get'>;
  sessionExtractionImpl?: SessionExtractionImpl;
};

export async function extractEpoch(params: {
  client: NativeTables;
  extractorName: string;
  activeWindowDays: number;
  threads: SessionThread[];
  sealedEpoch: SealedEpoch;
  signal?: AbortSignal;
  database?: string;
  sessionExtractionImpl?: SessionExtractionImpl;
}): Promise<{ threads: SessionThread[]; touchedIds: Set<string> }> {
  throwIfAborted(params.signal);
  ensureActiveThreads(
    params.threads,
    params.activeWindowDays,
  );
  const memories = new Memories(params.client);
  const touchedIds = new Set<string>();
  for (const turns of groupTurnsBySession(params.sealedEpoch.turns)) {
    const thread = getOrCreateSessionThread(
      params.threads,
      params.extractorName,
      turns,
      params.sealedEpoch.epoch,
    );
    const groupTouchedIds = await extractSessionThread({
      thread,
      pendingTurns: turns,
      extractionEpoch: params.sealedEpoch.epoch,
      signal: params.signal,
      database: params.database,
      memories,
      sessionExtractionImpl: params.sessionExtractionImpl,
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
  return `${turn.agent}\0${turn.cwd}\0${sessionId}`;
}

function ownershipForTurns(turns: Turn[]): { agent: string; project: string; cwd: string } {
  const first = turns[0];
  if (!first) {
    throw new Error('missing turns for session ownership');
  }
  for (const turn of turns) {
    if (turn.agent !== first.agent || turn.cwd !== first.cwd) {
      throw new Error('extractSessionThread requires pendingTurns from a single cwd/agent');
    }
  }
  return {
    agent: first.agent,
    project: first.project,
    cwd: first.cwd,
  };
}

function ensureActiveThreads(
  threads: SessionThread[],
  activeWindowDays: number,
): void {
  const activeThreads = threads.filter((thread) => isActiveThread(thread.updatedAt, activeWindowDays));
  threads.splice(0, threads.length, ...activeThreads);
}

function getOrCreateSessionThread(
  threads: SessionThread[],
  extractorName: string,
  pendingTurns: Turn[],
  extractionEpoch: number,
): SessionThread {
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
  const thread = createSessionThread(
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
    thread,
    pendingTurns,
    extractionEpoch,
    signal,
    memories,
    sessionExtractionImpl = extractSessionMemory,
  } = params;
  throwIfAborted(signal);
  const touchedIds = new Set<string>();
  sessionIdForTurns(pendingTurns);
  ownershipForTurns(pendingTurns);
  if (pendingTurns.length === 0) {
    return touchedIds;
  }

  const now = new Date().toISOString();
  const turns: TurnInput[] = pendingTurns.map((turn) => ({
    turnId: turn.turnId,
    prompt: turn.prompt,
    response: turn.response,
    summary: turn.summary,
  }));
  thread.updatedAt = now;
  thread.extractionEpoch = extractionEpoch;
  const result = await sessionExtractionImpl({
    sessionMemory: currentSessionMemory(thread),
    turns,
  }, signal, { memories, database: params.database });
  applyExtraction(thread, result, extractionEpoch, applyExtractionChanges);
  touchedIds.add(threadIdentityKey(thread));
  return touchedIds;
}

async function flushThreads(
  client: NativeTables,
  threads: SessionThread[],
  touchedIds: Set<string>,
): Promise<void> {
  const touched = threads
    .filter((thread) => touchedIds.has(threadIdentityKey(thread)))
    .filter((thread) => thread.snapshots.length > 0);
  if (touched.length === 0) {
    return;
  }

  const persistedRows = await client.sessionTable.insert({
    snapshots: touched.map(toSessionSnapshot),
  });
  updateThreadsFromRows(threads, persistedRows);
}

function updateThreadsFromRows(
  threads: SessionThread[],
  rows: SessionSnapshot[],
): void {
  const rowsById = new Map(rows.map((row) => [threadIdentityKey(row), row]));
  for (const thread of threads) {
    const row = rowsById.get(threadIdentityKey(thread));
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
  extractEpoch,
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
