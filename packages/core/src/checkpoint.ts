import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadMuninnConfig, resolveMuninnHome, resolveStorageTarget } from './config.js';
import type {
  SessionSnapshot,
  SessionFragment,
} from './observer/types.js';

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
  sessionId: string;
  latestSnapshotId: string;
  latestSnapshotSequence: number;
  indexedSnapshotSequence?: number | null;
  updatedAt: string;
};

export type ObserverCheckpoint = {
  baseline: {
    turn: number;
    session: number;
    extraction: number;
    curation: number;
    observation: number;
  };
  committedEpoch?: number;
  nextEpoch: number;
  recentSessions: RecentSessionCheckpoint[];
  threads: ThreadRef[];
  runs: ObservingRun[];
  curationRuns: CurationRun[];
};

export type CheckpointContent = {
  schemaVersion: 4;
  observer: ObserverCheckpoint;
};

export type CheckpointFile = CheckpointContent & {
  writtenAt: string;
  writerPid: number;
};

export type ObservingRunStatus = 'running' | 'completed' | 'failed';

export type ObservingRunStage =
  | 'fittingThreads'
  | 'committingExtractions'
  | 'observingThreads'
  | 'committingSnapshots'
  | 'indexingSnapshots'
  | 'completed';

export type ObservingRunError = {
  stage: string;
  message: string;
  at: string;
};

export type ObservingRun = {
  observer: string;
  epoch: number;
  status: ObservingRunStatus;
  stage: ObservingRunStage;
  inputTurnIds: string[];
  pending?: {
    sessionFragments?: SessionFragment[];
    snapshotResults?: SessionSnapshot[];
  };
  committed: {
    extractionIds: string[];
    snapshotIds: string[];
  };
  traceRefs: string[];
  errors: ObservingRunError[];
};

export type CurationRunStage =
  | 'selectingExtractions'
  | 'generatingCuration'
  | 'committingSnapshot'
  | 'committingObservations'
  | 'completed'
  | 'failed';

export type CurationRun = {
  runId: string;
  curationId: string;
  anchor: string;
  stage: CurationRunStage;
  pendingExtractionIds: string[];
  generatedContent?: string;
  parsedObservationDrafts?: Array<{
    id: string;
    text: string;
    references: string[];
  }>;
  committedSnapshotId?: string;
  committedObservationIds?: string[];
  errors: Array<{
    message: string;
    stage: string;
  }>;
};

export function parseCheckpointFile(raw: string): CheckpointFile {
  const parsed = JSON.parse(raw) as Partial<CheckpointFile>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('checkpoint must be a JSON object');
  }
  if (parsed.schemaVersion !== 4) {
    throw new Error(`unsupported checkpoint schemaVersion: ${String(parsed.schemaVersion)}`);
  }
  const observer = parseObserverSection(parsed.observer);
  if (!observer) {
    throw new Error('checkpoint observer section is invalid');
  }
  return {
    schemaVersion: 4,
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
  const runs = parseObservingRuns(value.runs ?? []);
  const curationRuns = parseCurationRuns(value.curationRuns ?? []);
  if (!baseline || typeof nextEpoch !== 'number' || !recentSessions || !threads || !runs || !curationRuns) {
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
    curationRuns,
  };
}

function parseBaseline(value: unknown): ObserverCheckpoint['baseline'] | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  if (
    typeof value.turn !== 'number'
    || typeof value.session !== 'number'
    || typeof value.extraction !== 'number'
    || (value.curation != null && typeof value.curation !== 'number')
    || (value.observation != null && typeof value.observation !== 'number')
  ) {
    return null;
  }
  return {
    turn: value.turn,
    session: value.session,
    extraction: value.extraction,
    curation: value.curation ?? 0,
    observation: value.observation ?? 0,
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

function parseObservingRuns(value: unknown): ObservingRun[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const runs: ObservingRun[] = [];
  for (const run of value) {
    const parsed = parseObservingRun(run);
    if (!parsed) {
      return null;
    }
    runs.push(parsed);
  }
  return runs;
}

function parseObservingRun(value: unknown): ObservingRun | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  if (
    typeof value.observer !== 'string'
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
    observer: value.observer,
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

function parseRunCommitted(value: unknown): ObservingRun['committed'] | null {
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

function parseRunPending(value: unknown): NonNullable<ObservingRun['pending']> | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  const pending: NonNullable<ObservingRun['pending']> = {};
  if (value.sessionFragments != null) {
    if (!Array.isArray(value.sessionFragments)) {
      return null;
    }
    pending.sessionFragments = value.sessionFragments as SessionFragment[];
  }
  if (value.snapshotResults != null) {
    if (!Array.isArray(value.snapshotResults)) {
      return null;
    }
    pending.snapshotResults = value.snapshotResults as SessionSnapshot[];
  }
  return pending;
}

function parseRunErrors(value: unknown): ObservingRunError[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const errors: ObservingRunError[] = [];
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

function parseCurationRuns(value: unknown): CurationRun[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const runs: CurationRun[] = [];
  for (const run of value) {
    const parsed = parseCurationRun(run);
    if (!parsed) {
      return null;
    }
    runs.push(parsed);
  }
  return runs;
}

function parseCurationRun(value: unknown): CurationRun | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  if (
    typeof value.runId !== 'string'
    || typeof value.curationId !== 'string'
    || typeof value.anchor !== 'string'
    || !isCurationRunStage(value.stage)
  ) {
    return null;
  }
  const pendingExtractionIds = parseStringArray(value.pendingExtractionIds);
  const errors = parseCurationRunErrors(value.errors);
  if (!pendingExtractionIds || !errors) {
    return null;
  }
  const parsedObservationDrafts = value.parsedObservationDrafts == null
    ? undefined
    : parseObservationDrafts(value.parsedObservationDrafts);
  if (value.parsedObservationDrafts != null && !parsedObservationDrafts) {
    return null;
  }
  const committedObservationIds = value.committedObservationIds == null
    ? undefined
    : parseStringArray(value.committedObservationIds);
  if (value.committedObservationIds != null && !committedObservationIds) {
    return null;
  }
  if (
    (value.generatedContent != null && typeof value.generatedContent !== 'string')
    || (value.committedSnapshotId != null && typeof value.committedSnapshotId !== 'string')
  ) {
    return null;
  }
  return {
    runId: value.runId,
    curationId: value.curationId,
    anchor: value.anchor,
    stage: value.stage,
    pendingExtractionIds,
    ...(value.generatedContent == null ? {} : { generatedContent: value.generatedContent }),
    ...(parsedObservationDrafts ? { parsedObservationDrafts } : {}),
    ...(value.committedSnapshotId == null ? {} : { committedSnapshotId: value.committedSnapshotId }),
    ...(committedObservationIds ? { committedObservationIds } : {}),
    errors,
  };
}

function parseObservationDrafts(value: unknown): NonNullable<CurationRun['parsedObservationDrafts']> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const drafts: NonNullable<CurationRun['parsedObservationDrafts']> = [];
  for (const draft of value) {
    if (
      !isObjectRecord(draft)
      || typeof draft.id !== 'string'
      || typeof draft.text !== 'string'
    ) {
      return null;
    }
    const references = parseStringArray(draft.references);
    if (!references) {
      return null;
    }
    drafts.push({
      id: draft.id,
      text: draft.text,
      references,
    });
  }
  return drafts;
}

function parseCurationRunErrors(value: unknown): CurationRun['errors'] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const errors: CurationRun['errors'] = [];
  for (const error of value) {
    if (
      !isObjectRecord(error)
      || typeof error.stage !== 'string'
      || typeof error.message !== 'string'
    ) {
      return null;
    }
    errors.push({
      stage: error.stage,
      message: error.message,
    });
  }
  return errors;
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return null;
  }
  return [...value];
}

function isRunStatus(value: unknown): value is ObservingRunStatus {
  return value === 'running' || value === 'completed' || value === 'failed';
}

function isRunStage(value: unknown): value is ObservingRunStage {
  return value === 'fittingThreads'
    || value === 'committingExtractions'
    || value === 'observingThreads'
    || value === 'committingSnapshots'
    || value === 'indexingSnapshots'
    || value === 'completed';
}

function isCurationRunStage(value: unknown): value is CurationRunStage {
  return value === 'selectingExtractions'
    || value === 'generatingCuration'
    || value === 'committingSnapshot'
    || value === 'committingObservations'
    || value === 'completed'
    || value === 'failed';
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
