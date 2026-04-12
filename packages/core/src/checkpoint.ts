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

export type OpenTurnSourceRef = OpenTurnRef & {
  observer: string;
};

export type ThreadRef = {
  observingId: string;
  latestSnapshotId: string;
  latestSnapshotSequence: number;
  indexedSnapshotSequence?: number | null;
  updatedAt: string;
};

export type ObserverState = {
  observerName: string;
  baseline: {
    observing: number;
    semanticIndex: number;
  };
  committedEpoch?: number;
  nextEpoch: number;
  threads: ThreadRef[];
};

export type ObserverSection = {
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

export type CheckpointFile = {
  schemaVersion: 1;
  writtenAt: string;
  writerPid: number;
  observers: Record<string, ObserverSection>;
};

export type CheckpointContributor = () =>
  | Promise<ObserverState | null>
  | ObserverState
  | null;

export function parseCheckpointFile(raw: string): CheckpointFile {
  const parsed = JSON.parse(raw) as Partial<CheckpointFile>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('checkpoint must be a JSON object');
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(`unsupported checkpoint schemaVersion: ${String(parsed.schemaVersion)}`);
  }
  if (!parsed.observers || typeof parsed.observers !== 'object' || Array.isArray(parsed.observers)) {
    throw new Error('checkpoint observers must be an object');
  }
  return {
    schemaVersion: 1,
    writtenAt: typeof parsed.writtenAt === 'string' ? parsed.writtenAt : new Date(0).toISOString(),
    writerPid: typeof parsed.writerPid === 'number' ? parsed.writerPid : 0,
    observers: parseObserverSections(parsed.observers),
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

export function resolveObserverCheckpointSection(
  file: CheckpointFile | null,
  observerName: string,
): ObserverSection | null {
  if (!file) {
    return null;
  }
  const section = file.observers[observerName];
  if (!section) {
    return null;
  }
  return section;
}

function parseObserverSections(value: unknown): Record<string, ObserverSection> {
  if (!isObjectRecord(value)) {
    return {};
  }
  const sections: Record<string, ObserverSection> = {};
  for (const [observerName, section] of Object.entries(value)) {
    const parsed = parseObserverSection(section);
    if (!parsed) {
      throw new Error(`invalid checkpoint observer section: ${observerName}`);
    }
    sections[observerName] = parsed;
  }
  return sections;
}

function parseObserverSection(value: unknown): ObserverSection | null {
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

function parseBaseline(value: unknown): ObserverSection['baseline'] | null {
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

export function groupOpenTurnsByObserver(
  turns: OpenTurnSourceRef[],
): Map<string, OpenTurnRef[]> {
  const grouped = new Map<string, OpenTurnRef[]>();
  for (const turn of turns) {
    const group = grouped.get(turn.observer);
    const entry: OpenTurnRef = {
      sessionId: turn.sessionId ?? null,
      agent: turn.agent,
      turnId: turn.turnId,
      updatedAt: turn.updatedAt,
    };
    if (group) {
      group.push(entry);
      continue;
    }
    grouped.set(turn.observer, [entry]);
  }
  return grouped;
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
