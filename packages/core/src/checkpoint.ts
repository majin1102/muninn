import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadMuninnConfig, resolveMuninnHome, resolveStorageTarget } from './config.js';

export type OpenTurnRef = {
  sessionId?: string | null;
  agent: string;
  turnId: string;
  updatedAt: string;
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
  openTurns: OpenTurnRef[];
  threads: ThreadRef[];
};

export type CheckpointContent = {
  schemaVersion: 1;
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
  if (parsed.schemaVersion !== 1) {
    throw new Error(`unsupported checkpoint schemaVersion: ${String(parsed.schemaVersion)}`);
  }
  const observer = parseObserverSection(parsed.observer);
  if (!observer) {
    throw new Error('checkpoint observer section is invalid');
  }
  return {
    schemaVersion: 1,
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
  const openTurns = parseOpenTurns(value.openTurns);
  const threads = parseThreads(value.threads);
  if (!baseline || typeof nextEpoch !== 'number' || !openTurns || !threads) {
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
    openTurns,
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

function parseOpenTurns(value: unknown): OpenTurnRef[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const turns: OpenTurnRef[] = [];
  for (const turn of value) {
    if (!isObjectRecord(turn)) {
      return null;
    }
    if (
      (turn.sessionId != null && typeof turn.sessionId !== 'string')
      || typeof turn.agent !== 'string'
      || typeof turn.turnId !== 'string'
      || typeof turn.updatedAt !== 'string'
    ) {
      return null;
    }
    turns.push({
      sessionId: turn.sessionId ?? null,
      agent: turn.agent,
      turnId: turn.turnId,
      updatedAt: turn.updatedAt,
    });
  }
  return turns;
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
  if (!storage) {
    return `local:${resolveMuninnHome()}`;
  }
  const options = storage.storageOptions
    ? Object.entries(storage.storageOptions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('&')
    : '';
  return `${storage.uri}#${options}`;
}
