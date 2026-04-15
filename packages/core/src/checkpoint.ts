import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadMuninnConfig, resolveMuninnHome, resolveStorageTarget } from './config.js';

export type RecentTurn = {
  turnId: string;
  updatedAt: string;
  prompt: string;
  response: string;
};

export type RecentSessionCheckpoint = {
  sessionId?: string | null;
  agent: string;
  turns: RecentTurn[];
};

export type ThreadRef = {
  observingId: string;
  latestSnapshotId: string;
  latestSnapshotSequence: number;
  indexedSnapshotSequence?: number | null;
  updatedAt: string;
};

export type ObserverCheckpoint = {
  baseline: {
    turn: number;
    observing: number;
    semanticIndex: number;
  };
  committedEpoch?: number;
  nextEpoch: number;
  recentSessions: RecentSessionCheckpoint[];
  threads: ThreadRef[];
};

export type CheckpointContent = {
  schemaVersion: 3;
  observer: ObserverCheckpoint;
};

export type CheckpointFile = CheckpointContent & {
  writtenAt: string;
  writerPid: number;
};

export function parseCheckpointFile(raw: string): CheckpointFile {
  const parsed = JSON.parse(raw) as Partial<CheckpointFile>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('checkpoint must be a JSON object');
  }
  if (parsed.schemaVersion !== 3) {
    throw new Error(`unsupported checkpoint schemaVersion: ${String(parsed.schemaVersion)}`);
  }
  const observer = parseObserverSection(parsed.observer);
  if (!observer) {
    throw new Error('checkpoint observer section is invalid');
  }
  return {
    schemaVersion: 3,
    writtenAt: typeof parsed.writtenAt === 'string' ? parsed.writtenAt : new Date(0).toISOString(),
    writerPid: typeof parsed.writerPid === 'number' ? parsed.writerPid : 0,
    observer,
  };
}

export async function readCheckpointFile(): Promise<CheckpointFile | null> {
  try {
    const raw = await readFile(resolveCheckpointPath(), 'utf8');
    return parseCheckpointFile(raw);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function serializeCheckpointFile(file: CheckpointFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

function parseObserverSection(value: unknown): ObserverCheckpoint | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  const baseline = parseBaseline(value.baseline);
  const nextEpoch = value.nextEpoch;
  const recentSessions = parseRecentSessions(value.recentSessions);
  const threads = parseThreads(value.threads);
  if (!baseline || typeof nextEpoch !== 'number' || !recentSessions || !threads) {
    return null;
  }
  const committedEpoch = value.committedEpoch;
  if (committedEpoch != null && typeof committedEpoch !== 'number') {
    return null;
  }
  return {
    baseline,
    committedEpoch: committedEpoch ?? undefined,
    nextEpoch,
    recentSessions,
    threads,
  };
}

function parseBaseline(value: unknown): ObserverCheckpoint['baseline'] | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  if (
    typeof value.turn !== 'number'
    || typeof value.observing !== 'number'
    || typeof value.semanticIndex !== 'number'
  ) {
    return null;
  }
  return {
    turn: value.turn,
    observing: value.observing,
    semanticIndex: value.semanticIndex,
  };
}

function parseRecentSessions(value: unknown): RecentSessionCheckpoint[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const sessions: RecentSessionCheckpoint[] = [];
  for (const session of value) {
    if (!isObjectRecord(session)) {
      return null;
    }
    if (
      (session.sessionId != null && typeof session.sessionId !== 'string')
      || typeof session.agent !== 'string'
    ) {
      return null;
    }
    const turns = parseRecentTurns(session.turns);
    if (!turns) {
      return null;
    }
    sessions.push({
      sessionId: session.sessionId ?? null,
      agent: session.agent,
      turns,
    });
  }
  return sessions;
}

function parseRecentTurns(value: unknown): RecentTurn[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const turns: RecentTurn[] = [];
  for (const turn of value) {
    const parsed = parseRecentTurn(turn);
    if (!parsed) {
      return null;
    }
    turns.push(parsed);
  }
  return turns;
}

function parseRecentTurn(value: unknown): RecentTurn | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  if (
    typeof value.turnId !== 'string'
    || typeof value.updatedAt !== 'string'
    || typeof value.prompt !== 'string'
    || typeof value.response !== 'string'
  ) {
    return null;
  }
  return {
    turnId: value.turnId,
    updatedAt: value.updatedAt,
    prompt: value.prompt,
    response: value.response,
  };
}

function parseThreads(value: unknown): ThreadRef[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const threads: ThreadRef[] = [];
  for (const thread of value) {
    if (!isObjectRecord(thread)) {
      return null;
    }
    if (
      typeof thread.observingId !== 'string'
      || typeof thread.latestSnapshotId !== 'string'
      || typeof thread.latestSnapshotSequence !== 'number'
      || typeof thread.updatedAt !== 'string'
      || (
        thread.indexedSnapshotSequence != null
        && typeof thread.indexedSnapshotSequence !== 'number'
      )
    ) {
      return null;
    }
    threads.push({
      observingId: thread.observingId,
      latestSnapshotId: thread.latestSnapshotId,
      latestSnapshotSequence: thread.latestSnapshotSequence,
      indexedSnapshotSequence: thread.indexedSnapshotSequence ?? null,
      updatedAt: thread.updatedAt,
    });
  }
  return threads;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function resolveCheckpointPath(): string {
  const home = resolveMuninnHome();
  const hash = createHash('sha256')
    .update(storageScopeKey())
    .digest('hex')
    .slice(0, 16);
  return path.join(home, 'checkpoints', `${hash}.json`);
}

function storageScopeKey(): string {
  const config = loadMuninnConfig();
  const storage = config ? resolveStorageTarget(config) : null;
  const observer = config?.observer?.name ?? '';
  if (!storage) {
    return `local:${resolveMuninnHome()}#observer=${observer}`;
  }
  const options = storage.storageOptions
    ? Object.entries(storage.storageOptions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('&')
    : '';
  return `${storage.uri}#${options}#observer=${observer}`;
}
