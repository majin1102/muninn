import type { TurnRow } from '../native.js';
import { Memories } from '../api/memory.js';
import type { NativeTables } from '../native.js';
import { extractSessionMemory } from '../llm/extractor.js';
import { chunkTurnsByInputBudget } from '../llm/extraction-input.js';
import { applyExtractionChanges } from './extraction.js';
import type { SealedEpoch } from './epoch.js';
import {
  parseSnapshotContent,
  type ContextRef,
  type ExtractionChange,
  type ExtractionUnit,
  type SkillDetails,
  type SnapshotContent,
  type SnapshotSignals,
  type SnapshotThreadKind,
} from './snapshot.js';

export {
  parseSnapshotContent,
  parseSnapshotPatch,
  parseSnapshotContentUnits,
  renderSnapshotContent,
  renderExtractionBlock,
  isValidSkillName,
  skillNamesFromSignals,
  signalEvidenceLabels,
  signalEvidenceTurnIds,
  stripMarkdownFence,
} from './snapshot.js';

export type {
  ContextRef,
  ExtractionChange,
  ExtractionUnit,
  ParsedSnapshotContent,
  ParsedSnapshotPatch,
  SkillDetails,
  SnapshotContent,
  SnapshotSignals,
} from './snapshot.js';

export type SessionThreadKind = SnapshotThreadKind;

export type SessionThread = {
  threadId: string;
  kind: SessionThreadKind;
  sessionId?: string | null;
  project: string;
  cwd: string;
  agent: string;
  snapshotId?: string;
  snapshotIds: string[];
  snapshotEpochs?: number[];
  extractionEpoch: number;
  title: string;
  summary: string;
  snapshots: SnapshotContent[];
  references: string[];
  indexedSnapshotSequence?: number | null;
  extractor: string;
  createdAt: string;
  updatedAt: string;
};

export type SessionSnapshot = {
  snapshotId: string;
  sessionId: string;
  project: string;
  cwd: string;
  agent: string;
  snapshotSequence: number;
  createdAt: string;
  updatedAt: string;
  extractor: string;
  title: string;
  summary: string;
  memorySignals: string[];
  skillSignals: string[];
  skillDetails: string;
  content: string;
  references: string[];
};

export type PendingIndex = {
  start: number;
  end: number;
};

export type TurnInput = {
  turnId: string;
  prompt?: string | null;
  response?: string | null;
};

export type SessionMemory = {
  title: string;
  summary: string;
  memorySignals: string[];
  skillSignals: string[];
  skillDetails: SkillDetails;
  snapshotContent?: string;
  extractions: ExtractionUnit[];
  nextSteps: string[];
};

export type SessionExtractionInput = {
  sessionMemory: SessionMemory;
  turns: TurnInput[];
  inputBudgetStoppedBy?: 'none' | 'new-batch-input-chars' | 'max-epoch-turns' | 'single-turn-oversize';
  candidateTurnCount?: number;
  deferredTurnCount?: number;
};

export type SessionExtractionResult = {
  title: string;
  summary: string;
  memorySignals: string[];
  skillSignals: string[];
  skillDetails: SkillDetails;
  snapshotContent: string;
  extractions: ExtractionUnit[];
  nextSteps: string[];
  contextRefs: ContextRef[];
};

const PENDING_SNAPSHOT_ID = 'session:18446744073709551615';
export const DEFAULT_SESSION_ID = '__muninn_default_session__';
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

function threadKey(value: {
  sessionId: string;
  agent: string;
  project: string;
  cwd: string;
}): string {
  return `${value.agent}\0${value.project}\0${value.cwd}\0${value.sessionId}`;
}

export function createSessionThread(
  extractor: string,
  title: string,
  summary: string,
  references: string[],
  extractionEpoch: number,
  now = new Date().toISOString(),
  kind: SessionThreadKind = 'subject',
  sessionId: string | null = null,
  ownership: { agent: string; project: string; cwd: string } = {
    agent: 'unknown',
    project: 'default',
    cwd: process.cwd(),
  },
): SessionThread {
  const threadSessionId = sessionId ?? 'default';
  return {
    threadId: threadSessionId,
    kind,
    sessionId: threadSessionId,
    project: ownership.project,
    cwd: ownership.cwd,
    agent: ownership.agent,
    snapshotIds: [],
    snapshotEpochs: [],
    extractionEpoch,
    title: normalizeTitle(title),
    summary: normalizeSummary(summary),
    snapshots: [],
    references,
    extractor,
    createdAt: now,
    updatedAt: now,
  };
}

export function cloneSessionThread(thread: SessionThread): SessionThread {
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
      project: snapshot.project ?? thread.project,
      cwd: snapshot.cwd ?? thread.cwd,
      agent: snapshot.agent ?? thread.agent,
      snapshotContent: snapshot.snapshotContent,
      memorySignals: [...(snapshot.memorySignals ?? [])],
      skillSignals: [...(snapshot.skillSignals ?? [])],
      skillDetails: { ...(snapshot.skillDetails ?? {}) },
      extractions: snapshot.extractions.map((extraction) => ({
        id: extraction.id ?? null,
        title: extraction.title ?? null,
        text: extraction.text,
        context: extraction.context ?? null,
        references: [...(extraction.references ?? [])],
        updatedMemory: extraction.updatedMemory ?? null,
      })),
      contextRefs: snapshot.contextRefs.map((reference) => ({ ...reference })),
      nextSteps: [...(snapshot.nextSteps ?? [])],
      extractionChanges: (snapshot.extractionChanges ?? []).map((change) => ({ ...change })),
    })),
    indexedSnapshotSequence: thread.indexedSnapshotSequence ?? null,
  };
}

export function cloneSessionThreads(threads: SessionThread[]): SessionThread[] {
  return threads.map(cloneSessionThread);
}

export function loadThreads(
  snapshots: SessionSnapshot[],
  extractor: string,
  activeWindowDays: number,
  extractionEpoch = 0,
): SessionThread[] {
  const grouped = new Map<string, SessionSnapshot[]>();
  for (const snapshot of snapshots) {
    if (snapshot.extractor !== extractor) {
      continue;
    }
    const key = threadKey(snapshot);
    const rows = grouped.get(key) ?? [];
    rows.push(snapshot);
    grouped.set(key, rows);
  }
  return [...grouped.values()]
    .map((rows) => threadFromSnapshots(rows, extractionEpoch))
    .filter((thread) => isActiveThread(thread.updatedAt, activeWindowDays))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
}

export function threadFromSnapshots(
  rows: SessionSnapshot[],
  extractionEpoch = 0,
  indexedSnapshotSequence: number | null = null,
): SessionThread {
  const ordered = [...rows].sort((left, right) => (
    left.snapshotSequence - right.snapshotSequence
    || left.updatedAt.localeCompare(right.updatedAt)
  ));
  const latest = ordered[ordered.length - 1];
  if (!latest) {
    throw new Error('missing snapshots for session memory thread');
  }
  const latestContent = deserializeSnapshot(latest);
  return {
    threadId: latest.sessionId,
    kind: latestContent.threadKind ?? 'subject',
    sessionId: latest.sessionId,
    project: latest.project,
    cwd: latest.cwd,
    agent: latest.agent,
    snapshotId: latest.snapshotId,
    snapshotIds: ordered.map((row) => row.snapshotId),
    snapshotEpochs: ordered.map(() => extractionEpoch),
    extractionEpoch,
    title: latest.title,
    summary: latest.summary,
    snapshots: ordered.map(deserializeSnapshot),
    references: [...latest.references],
    indexedSnapshotSequence,
    extractor: latest.extractor,
    createdAt: ordered[0]?.createdAt ?? latest.createdAt,
    updatedAt: latest.updatedAt,
  };
}

export function replaySnapshots(
  thread: SessionThread,
  rows: SessionSnapshot[],
  extractionEpoch = thread.extractionEpoch,
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
      throw new Error(`unexpected snapshot gap for session memory thread ${thread.threadId}`);
    }
    thread.snapshotId = row.snapshotId;
    thread.snapshotIds.push(row.snapshotId);
    thread.snapshotEpochs = [...(thread.snapshotEpochs ?? []), extractionEpoch];
    thread.extractionEpoch = extractionEpoch;
    thread.title = row.title;
    thread.summary = row.summary;
    const snapshot = deserializeSnapshot(row);
    thread.kind = snapshot.threadKind ?? thread.kind;
    thread.sessionId = snapshot.sessionId ?? thread.sessionId ?? null;
    thread.project = snapshot.project ?? thread.project;
    thread.cwd = snapshot.cwd ?? thread.cwd;
    thread.agent = snapshot.agent ?? thread.agent;
    thread.snapshots.push(snapshot);
    thread.references = [...row.references];
    thread.updatedAt = row.updatedAt;
  }
}

export function currentSessionMemory(thread: SessionThread): SessionMemory {
  const snapshot = latestSnapshot(thread) ?? emptySnapshot();
  return {
    title: thread.title,
    summary: thread.summary,
    memorySignals: [...(snapshot.memorySignals ?? [])],
    skillSignals: [...(snapshot.skillSignals ?? [])],
    skillDetails: { ...(snapshot.skillDetails ?? {}) },
    snapshotContent: snapshot.snapshotContent,
    extractions: snapshot.extractions,
    nextSteps: snapshot.nextSteps ?? [],
  };
}

export function applyExtraction(
  thread: SessionThread,
  result: SessionExtractionResult,
  extractionEpoch: number,
  applyExtractionChanges: (
    extractions: ExtractionUnit[],
    result: SessionExtractionResult,
  ) => { extractionChanges: SnapshotContent['extractionChanges']; extractions: ExtractionUnit[] },
  now = new Date().toISOString(),
): void {
  const current = latestSnapshot(thread) ?? emptySnapshot();
  const patched = applyExtractionChanges(current.extractions, result);
  thread.title = result.title;
  thread.summary = result.summary ?? thread.summary;
  thread.extractionEpoch = extractionEpoch;
  thread.snapshots.push({
    threadKind: thread.kind,
    sessionId: thread.sessionId ?? null,
    project: thread.project,
    cwd: thread.cwd,
    agent: thread.agent,
    snapshotContent: result.snapshotContent ?? '',
    memorySignals: [...(result.memorySignals ?? [])],
    skillSignals: [...(result.skillSignals ?? [])],
    skillDetails: { ...(result.skillDetails ?? {}) },
    extractions: patched.extractions,
    contextRefs: mergeContextRefs(
      current.contextRefs,
      result.contextRefs,
    ),
    nextSteps: result.nextSteps,
    extractionChanges: patched.extractionChanges,
  });
  thread.references = latestSnapshot(thread)?.contextRefs.map((reference) => reference.turnId) ?? [];
  thread.snapshotEpochs = [...(thread.snapshotEpochs ?? []), extractionEpoch];
  thread.snapshotId = undefined;
  thread.updatedAt = now;
}

export function pushReference(thread: SessionThread, reference: string): void {
  if (!thread.references.includes(reference)) {
    thread.references.push(reference);
    trimReferences(thread.references);
  }
}

export function toSessionSnapshot(thread: SessionThread): SessionSnapshot {
  if (thread.snapshots.length === 0) {
    throw new Error(`missing snapshots for session memory thread ${thread.threadId}`);
  }
  return toSessionSnapshotAt(thread, thread.snapshots.length - 1);
}

function toSessionSnapshotAt(thread: SessionThread, snapshotSequence: number): SessionSnapshot {
  const snapshot = thread.snapshots[snapshotSequence];
  if (!snapshot) {
    throw new Error(`missing snapshot for session memory thread ${thread.threadId} at sequence ${snapshotSequence}`);
  }
  return {
    snapshotId: thread.snapshotIds[snapshotSequence] ?? PENDING_SNAPSHOT_ID,
    sessionId: thread.sessionId ?? thread.threadId,
    project: thread.project,
    cwd: thread.cwd,
    agent: thread.agent,
    snapshotSequence,
    createdAt: thread.updatedAt,
    updatedAt: thread.updatedAt,
    extractor: thread.extractor,
    title: thread.title,
    summary: thread.summary,
    memorySignals: [...(snapshot.memorySignals ?? [])],
    skillSignals: [...(snapshot.skillSignals ?? [])],
    skillDetails: JSON.stringify(snapshot.skillDetails ?? {}),
    content: snapshot.snapshotContent,
    references: snapshot.contextRefs.map((reference) => reference.turnId),
  };
}

export function latestSnapshot(thread: SessionThread): SnapshotContent | undefined {
  return thread.snapshots[thread.snapshots.length - 1];
}

export function snapshotRef(thread: SessionThread, snapshotIndex: number): string {
  const snapshotId = thread.snapshotIds[snapshotIndex];
  if (!snapshotId) {
    throw new Error(`missing snapshot id for session memory thread ${thread.threadId} at sequence ${snapshotIndex}`);
  }
  return snapshotId;
}

export function threadIdentityKey(value: {
  agent: string;
  project: string;
  cwd: string;
  sessionId?: string | null;
  threadId?: string;
}): string {
  return `${value.agent}\0${value.cwd}\0${value.sessionId ?? value.threadId ?? DEFAULT_SESSION_ID}`;
}

export function getPendingIndex(thread: SessionThread): PendingIndex | null {
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
  thread: SessionThread,
  maxEpoch: number,
): PendingIndex | null {
  const snapshotEpochs = thread.snapshotEpochs ?? [];
  let latestSnapshotSequence = -1;
  for (let index = thread.snapshots.length - 1; index >= 0; index -= 1) {
    const snapshotEpoch = snapshotEpochs[index] ?? thread.extractionEpoch;
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

function deserializeSnapshot(row: SessionSnapshot): SnapshotContent {
  const parsed = parseSnapshotContent(row.content, new Set(row.references));
  return {
    threadKind: 'session',
    sessionId: row.sessionId,
    project: row.project,
    cwd: row.cwd,
    agent: row.agent,
    snapshotContent: parsed.snapshotContent,
    memorySignals: [...row.memorySignals],
    skillSignals: [...row.skillSignals],
    skillDetails: parseSkillDetailsJson(row.skillDetails),
    extractions: parsed.extractions,
    contextRefs: row.references.map((turnId) => ({ turnId, summary: turnId })),
    nextSteps: [],
    extractionChanges: [],
  };
}

function parseSkillDetailsJson(value: string): SkillDetails {
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`invalid session snapshot skillDetails JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('session snapshot skillDetails JSON must be an object');
  }
  const details: SkillDetails = {};
  for (const [key, detail] of Object.entries(parsed)) {
    if (typeof detail !== 'string') {
      throw new Error(`session snapshot skillDetails value must be a string: ${key}`);
    }
    details[key] = detail;
  }
  return details;
}

function emptySnapshot(): SnapshotContent {
  return {
    threadKind: 'subject',
    sessionId: null,
    project: 'default',
    cwd: process.cwd(),
    agent: 'unknown',
    snapshotContent: '',
    memorySignals: [],
    skillSignals: [],
    skillDetails: {},
    extractions: [],
    contextRefs: [],
    nextSteps: [],
    extractionChanges: [],
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
    const removableIndex = references.findIndex((reference) => reference.startsWith('turn:'));
    references.splice(removableIndex >= 0 ? removableIndex : 0, 1);
  }
}

type SessionExtractionImpl = typeof extractSessionMemory;

type ExtractSessionThreadParams = {
  thread: SessionThread;
  pendingTurns: TurnRow[];
  extractionEpoch: number;
  signal?: AbortSignal;
  database?: string;
  memories?: Pick<Memories, 'get'>;
  sessionExtractionImpl?: SessionExtractionImpl;
  inputBudgetStoppedBy?: SessionExtractionInput['inputBudgetStoppedBy'];
  candidateTurnCount?: number;
  deferredTurnCount?: number;
};

export async function extractEpoch(params: {
  client: NativeTables;
  extractorName: string;
  activeWindowDays: number;
  threads: SessionThread[];
  sealedEpoch: SealedEpoch;
  maxEpochTurns?: number;
  newBatchInputChars?: number;
  previewChars?: number;
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
  const maxEpochTurns = params.maxEpochTurns ?? Number.POSITIVE_INFINITY;
  if (maxEpochTurns !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxEpochTurns) || maxEpochTurns <= 0)) {
    throw new Error('maxEpochTurns must be a positive integer');
  }
  const newBatchInputChars = params.newBatchInputChars ?? Number.POSITIVE_INFINITY;
  if (newBatchInputChars !== Number.POSITIVE_INFINITY && (!Number.isInteger(newBatchInputChars) || newBatchInputChars <= 0)) {
    throw new Error('newBatchInputChars must be a positive integer');
  }
  const previewChars = params.previewChars ?? 800;
  if (!Number.isInteger(previewChars) || previewChars <= 0) {
    throw new Error('previewChars must be a positive integer');
  }
  for (const turns of groupTurnsBySession(params.sealedEpoch.turns)) {
    const thread = getOrCreateSessionThread(
      params.threads,
      params.extractorName,
      turns,
      params.sealedEpoch.epoch,
    );
    const chunks = chunkTurnsByInputBudget(turns, {
      maxEpochTurns,
      newBatchInputChars,
      previewChars,
    });
    let consumedTurns = 0;
    for (const chunk of chunks) {
      const groupTouchedIds = await extractSessionThread({
        thread,
        pendingTurns: chunk.turns,
        extractionEpoch: params.sealedEpoch.epoch,
        signal: params.signal,
        database: params.database,
        memories,
        sessionExtractionImpl: params.sessionExtractionImpl,
        inputBudgetStoppedBy: chunk.stoppedBy,
        candidateTurnCount: turns.length,
        deferredTurnCount: Math.max(0, turns.length - consumedTurns - chunk.turns.length),
      });
      consumedTurns += chunk.turns.length;
      for (const touchedId of groupTouchedIds) {
        touchedIds.add(touchedId);
      }
    }
  }
  await flushThreads(params.client, params.threads, touchedIds);
  return {
    threads: params.threads,
    touchedIds,
  };
}

function normalizedSessionId(turn: Pick<TurnRow, 'sessionId'>): string | null {
  const sessionId = turn.sessionId?.trim();
  return sessionId && sessionId.length > 0 ? sessionId : null;
}

function groupTurnsBySession(turns: TurnRow[]): TurnRow[][] {
  const groups = new Map<string, TurnRow[]>();
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

function sessionIdForTurns(turns: TurnRow[]): string {
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

function turnGroupKey(turn: TurnRow, sessionId: string): string {
  return `${turn.agent}\0${turn.cwd}\0${sessionId}`;
}

function ownershipForTurns(turns: TurnRow[]): { agent: string; project: string; cwd: string } {
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
  pendingTurns: TurnRow[],
  extractionEpoch: number,
): SessionThread {
  const sessionId = sessionIdForTurns(pendingTurns);
  const ownership = ownershipForTurns(pendingTurns);
  const existing = threads.find((thread) => (
    thread.extractor === extractorName
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
    inputBudgetStoppedBy,
    candidateTurnCount,
    deferredTurnCount,
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
  }));
  thread.updatedAt = now;
  thread.extractionEpoch = extractionEpoch;
  const result = await sessionExtractionImpl({
    sessionMemory: currentSessionMemory(thread),
    turns,
    inputBudgetStoppedBy,
    candidateTurnCount,
    deferredTurnCount,
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
  const snapshots = threads
    .filter((thread) => touchedIds.has(threadIdentityKey(thread)))
    .flatMap((thread) => {
      const rows: SessionSnapshot[] = [];
      for (let index = thread.snapshotIds.length; index < thread.snapshots.length; index += 1) {
        rows.push(toSessionSnapshotAt(thread, index));
      }
      return rows;
    });
  if (snapshots.length === 0) {
    return;
  }

  const persistedRows = await client.sessionTable.insert({
    snapshots,
  });
  updateThreadsFromRows(threads, persistedRows);
}

function updateThreadsFromRows(
  threads: SessionThread[],
  rows: SessionSnapshot[],
): void {
  const threadsById = new Map(threads.map((thread) => [threadIdentityKey(thread), thread]));
  const ordered = [...rows].sort((left, right) => left.snapshotSequence - right.snapshotSequence);
  for (const row of ordered) {
    const thread = threadsById.get(threadIdentityKey(row));
    if (!thread) {
      continue;
    }
    if (row.snapshotSequence > thread.snapshotIds.length) {
      throw new Error(`unexpected persisted snapshot gap for session memory thread ${thread.threadId}`);
    }
    const existingId = thread.snapshotIds[row.snapshotSequence];
    if (existingId && existingId !== row.snapshotId) {
      throw new Error(`conflicting snapshot id for session memory thread ${thread.threadId} at sequence ${row.snapshotSequence}`);
    }
    thread.snapshotIds[row.snapshotSequence] = row.snapshotId;
    if (row.snapshotSequence === thread.snapshots.length - 1) {
      thread.snapshotId = row.snapshotId;
      thread.references = [...row.references];
      thread.updatedAt = row.updatedAt;
    }
  }
}

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

export const __testing = {
  applyExtractionForTests: applyExtraction,
  flushThreads,
  extractEpoch,
  extractSessionThreadForTests: extractSessionThread,
};
