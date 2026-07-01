import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadMuninnConfig, resolveDatabaseHome, resolveDatabaseName, resolveStorageTarget } from './config.js';
import type {
  SessionSnapshot,
} from './pipeline/session.js';

export type RecentTurn = {
  turnId: string;
  updatedAt: string;
  turnSequence?: number;
  prompt: string;
  response: string;
};

export type RecentSessionCheckpoint = {
  sessionId?: string | null;
  agent: string;
  project: string;
  cwd: string;
  turns: RecentTurn[];
};

export type ThreadRef = {
  sessionId: string;
  latestSnapshotId: string;
  latestSnapshotSequence: number;
  indexedSnapshotSequence?: number | null;
  updatedAt: string;
};

export type ExtractorCheckpoint = {
  baseline: {
    turn: number;
    session: number;
    extraction: number;
  };
  committedEpoch?: number;
  nextEpoch: number;
  recentSessions: RecentSessionCheckpoint[];
  threads: ThreadRef[];
  runs: ExtractorRun[];
};

export type SessionIndexEntry = {
  sessionId: string;
  agent: string;
  project: string;
  cwd: string;
  latestUpdatedAt: string;
  firstTurnSequence?: number;
  snapshotId?: string;
  title?: string;
};

export type SessionIndexCheckpoint = {
  baseline: {
    turn: number;
    session: number;
  };
  entries: SessionIndexEntry[];
};

export type DreamingCheckpoint = {
  projects: Record<string, {
    sessionSnapshotVersion: number;
  }>;
};

export type CheckpointContent = {
  schemaVersion: 13;
  extractor: ExtractorCheckpoint;
  sessionIndex: SessionIndexCheckpoint;
  dreaming: DreamingCheckpoint;
};

export type CheckpointFile = CheckpointContent & {
  writtenAt: string;
  writerPid: number;
};

export type ExtractorRunStatus = 'running' | 'completed' | 'failed';

export type ExtractorRunStage =
  | 'fittingThreads'
  | 'committingExtractions'
  | 'extractingSessionMemory'
  | 'committingSnapshots'
  | 'indexingSnapshots'
  | 'completed';

export type ExtractorRunError = {
  stage: string;
  message: string;
  at: string;
};

export type ExtractorRun = {
  extractor: string;
  epoch: number;
  status: ExtractorRunStatus;
  stage: ExtractorRunStage;
  inputTurnIds: string[];
  pending?: {
    snapshotResults?: SessionSnapshot[];
  };
  committed: {
    extractionIds: string[];
    snapshotIds: string[];
  };
  traceRefs: string[];
  errors: ExtractorRunError[];
};

export function parseCheckpointFile(raw: string): CheckpointFile {
  const parsed = JSON.parse(raw) as Partial<CheckpointFile>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('checkpoint must be a JSON object');
  }
  if (parsed.schemaVersion !== 13) {
    throw new Error(`unsupported checkpoint schemaVersion: ${String(parsed.schemaVersion)}`);
  }
  const extractor = parseExtractorSection(parsed.extractor);
  const sessionIndex = parseSessionIndexSection(parsed.sessionIndex);
  const dreaming = parseDreamingSection(parsed.dreaming);
  if (!extractor) {
    throw new Error('checkpoint extractor section is invalid');
  }
  if (!sessionIndex) {
    throw new Error('checkpoint sessionIndex section is invalid');
  }
  if (!dreaming) {
    throw new Error('checkpoint dreaming section is invalid');
  }
  return {
    schemaVersion: 13,
    writtenAt: typeof parsed.writtenAt === 'string' ? parsed.writtenAt : new Date(0).toISOString(),
    writerPid: typeof parsed.writerPid === 'number' ? parsed.writerPid : 0,
    extractor,
    sessionIndex,
    dreaming,
  };
}

export async function readCheckpointFile(database?: string | null): Promise<CheckpointFile | null> {
  try {
    const raw = await readFile(resolveCheckpointPath(database), 'utf8');
    return parseCheckpointFile(raw);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    if (error instanceof Error && /^unsupported checkpoint schemaVersion: /.test(error.message)) {
      return null;
    }
    throw error;
  }
}

export function serializeCheckpointFile(file: CheckpointFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export async function writeCheckpointFile(file: CheckpointFile, database?: string | null): Promise<void> {
  const targetPath = resolveCheckpointPath(database);
  const directory = path.dirname(targetPath);
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(tmpPath, serializeCheckpointFile(file), 'utf8');
  await rename(tmpPath, targetPath);
}

function parseExtractorSection(value: unknown): ExtractorCheckpoint | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  const baseline = parseExtractorBaseline(value.baseline);
  const nextEpoch = value.nextEpoch;
  const recentSessions = parseRecentSessions(value.recentSessions);
  const threads = parseThreads(value.threads);
  const runs = parseExtractorRuns(value.runs ?? []);
  if (!baseline || typeof nextEpoch !== 'number' || !recentSessions || !threads || !runs) {
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
    runs,
  };
}

function parseExtractorBaseline(value: unknown): ExtractorCheckpoint['baseline'] | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  if (
    typeof value.turn !== 'number'
    || typeof value.session !== 'number'
    || typeof value.extraction !== 'number'
  ) {
    return null;
  }
  return {
    turn: value.turn,
    session: value.session,
    extraction: value.extraction,
  };
}

function parseSessionIndexSection(value: unknown): SessionIndexCheckpoint | null {
  if (!isObjectRecord(value) || !Array.isArray(value.entries)) {
    return null;
  }
  const baseline = parseSessionIndexBaseline(value.baseline);
  if (!baseline) {
    return null;
  }
  const entries: SessionIndexEntry[] = [];
  for (const entry of value.entries) {
    if (
      !isObjectRecord(entry)
      || typeof entry.sessionId !== 'string'
      || typeof entry.agent !== 'string'
      || typeof entry.project !== 'string'
      || typeof entry.cwd !== 'string'
      || typeof entry.latestUpdatedAt !== 'string'
      || (entry.snapshotId != null && typeof entry.snapshotId !== 'string')
      || (entry.title != null && typeof entry.title !== 'string')
    ) {
      return null;
    }
    const firstTurnSequence = typeof entry.firstTurnSequence === 'number'
      && Number.isInteger(entry.firstTurnSequence)
      && entry.firstTurnSequence >= 0
      ? entry.firstTurnSequence
      : undefined;
    entries.push({
      sessionId: entry.sessionId,
      agent: entry.agent,
      project: entry.project,
      cwd: entry.cwd,
      latestUpdatedAt: entry.latestUpdatedAt,
      ...(firstTurnSequence !== undefined ? { firstTurnSequence } : {}),
      snapshotId: entry.snapshotId ?? undefined,
      title: entry.title ?? undefined,
    });
  }
  return { baseline, entries };
}

function parseSessionIndexBaseline(value: unknown): SessionIndexCheckpoint['baseline'] | null {
  if (!isObjectRecord(value) || typeof value.turn !== 'number' || typeof value.session !== 'number') {
    return null;
  }
  return {
    turn: value.turn,
    session: value.session,
  };
}

function parseDreamingSection(value: unknown): DreamingCheckpoint | null {
  if (!isObjectRecord(value) || !isObjectRecord(value.projects)) {
    return null;
  }
  const projects: DreamingCheckpoint['projects'] = {};
  for (const [project, watermark] of Object.entries(value.projects)) {
    if (!isObjectRecord(watermark) || !isNonNegativeInteger(watermark.sessionSnapshotVersion)) {
      return null;
    }
    projects[project] = {
      sessionSnapshotVersion: watermark.sessionSnapshotVersion,
    };
  }
  return { projects };
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
      || typeof session.project !== 'string'
      || typeof session.cwd !== 'string'
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
      project: session.project,
      cwd: session.cwd,
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
    || (value.turnSequence !== undefined && !isTurnSequence(value.turnSequence))
    || typeof value.prompt !== 'string'
    || typeof value.response !== 'string'
  ) {
    return null;
  }
  return {
    turnId: value.turnId,
    updatedAt: value.updatedAt,
    ...(isTurnSequence(value.turnSequence) ? { turnSequence: value.turnSequence } : {}),
    prompt: value.prompt,
    response: value.response,
  };
}

function isTurnSequence(value: unknown): value is number {
  return isNonNegativeInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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
      typeof thread.sessionId !== 'string'
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
      sessionId: thread.sessionId,
      latestSnapshotId: thread.latestSnapshotId,
      latestSnapshotSequence: thread.latestSnapshotSequence,
      indexedSnapshotSequence: thread.indexedSnapshotSequence ?? null,
      updatedAt: thread.updatedAt,
    });
  }
  return threads;
}

function parseExtractorRuns(value: unknown): ExtractorRun[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const runs: ExtractorRun[] = [];
  for (const run of value) {
    const parsed = parseExtractorRun(run);
    if (!parsed) {
      return null;
    }
    runs.push(parsed);
  }
  return runs;
}

function parseExtractorRun(value: unknown): ExtractorRun | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  if (
    typeof value.extractor !== 'string'
    || typeof value.epoch !== 'number'
    || !isRunStatus(value.status)
    || !isRunStage(value.stage)
  ) {
    return null;
  }
  const inputTurnIds = parseStringArray(value.inputTurnIds);
  const committed = parseRunCommitted(value.committed);
  const traceRefs = parseStringArray(value.traceRefs);
  const errors = parseRunErrors(value.errors);
  if (!inputTurnIds || !committed || !traceRefs || !errors) {
    return null;
  }
  const pending = value.pending == null ? undefined : parseRunPending(value.pending);
  if (value.pending != null && !pending) {
    return null;
  }
  return {
    extractor: value.extractor,
    epoch: value.epoch,
    status: value.status,
    stage: value.stage,
    inputTurnIds,
    ...(pending ? { pending } : {}),
    committed,
    traceRefs,
    errors,
  };
}

function parseRunCommitted(value: unknown): ExtractorRun['committed'] | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  const extractionIds = parseStringArray(value.extractionIds);
  const snapshotIds = parseStringArray(value.snapshotIds);
  if (!extractionIds || !snapshotIds) {
    return null;
  }
  return { extractionIds, snapshotIds };
}

function parseRunPending(value: unknown): NonNullable<ExtractorRun['pending']> | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  const pending: NonNullable<ExtractorRun['pending']> = {};
  if (value.snapshotResults != null) {
    if (!Array.isArray(value.snapshotResults)) {
      return null;
    }
    pending.snapshotResults = value.snapshotResults as SessionSnapshot[];
  }
  return pending;
}

function parseRunErrors(value: unknown): ExtractorRunError[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const errors: ExtractorRunError[] = [];
  for (const error of value) {
    if (
      !isObjectRecord(error)
      || typeof error.stage !== 'string'
      || typeof error.message !== 'string'
      || typeof error.at !== 'string'
    ) {
      return null;
    }
    errors.push({
      stage: error.stage,
      message: error.message,
      at: error.at,
    });
  }
  return errors;
}

function parseStringArray(value: unknown): string[] | null {
  if (!isStringArray(value)) {
    return null;
  }
  return [...value];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRunStatus(value: unknown): value is ExtractorRunStatus {
  return value === 'running' || value === 'completed' || value === 'failed';
}

function isRunStage(value: unknown): value is ExtractorRunStage {
  return value === 'fittingThreads'
    || value === 'committingExtractions'
    || value === 'extractingSessionMemory'
    || value === 'committingSnapshots'
    || value === 'indexingSnapshots'
    || value === 'completed';
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function resolveCheckpointPath(database?: string | null): string {
  const databaseName = resolveDatabaseName(database);
  const home = resolveDatabaseHome(databaseName);
  const hash = createHash('sha256')
    .update(storageScopeKey(databaseName))
    .digest('hex')
    .slice(0, 16);
  return path.join(home, 'checkpoints', `${hash}.json`);
}

function storageScopeKey(database: string): string {
  const config = loadMuninnConfig();
  const storage = resolveStorageTarget(config ?? {}, database);
  const extractor = config?.extractor?.name ?? '';
  const options = storage.storageOptions
    ? Object.entries(storage.storageOptions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('&')
    : '';
  return `${storage.uri}#${options}#extractor=${extractor}`;
}
