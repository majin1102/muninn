import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadMuninnConfig, resolveDatabaseHome, resolveDatabaseName, resolveStorageTarget } from './config.js';
import type {
  SessionSnapshot,
  SessionFragment,
} from './extractor/types.js';
import type { Extraction } from './native.js';

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

export type ExtractorCheckpoint = {
  baseline: {
    turn: number;
    session: number;
    extraction: number;
    observation: number;
  };
  committedEpoch?: number;
  nextEpoch: number;
  recentSessions: RecentSessionCheckpoint[];
  threads: ThreadRef[];
  runs: ObservingRun[];
  pendingExtractionChanges: QueuedExtractionChange[];
};

export type QueuedExtractionChange =
  | { type: 'upsert'; extraction: Extraction }
  | { type: 'delete'; extraction: Extraction };

export type CheckpointContent = {
  schemaVersion: 6;
  extractor: ExtractorCheckpoint;
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

export type ObserverRunStage =
  | 'selectingExtractions'
  | 'generatingObservation'
  | 'committingSnapshot'
  | 'committingObservations'
  | 'completed'
  | 'failed';

export type ObserverRun = {
  runId: string;
  observeId: string;
  anchor: string;
  stage: ObserverRunStage;
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

export type ObserverCheckpoint = {
  baseline: {
    observationContext: number;
    observation: number;
  };
  observeQueue: {
    anchors: Array<{
      key: string;
      anchor: string;
      extractionChanges: QueuedExtractionChange[];
    }>;
  };
  runs: ObserverRun[];
};

export function parseCheckpointFile(raw: string): CheckpointFile {
  const parsed = JSON.parse(raw) as Partial<CheckpointFile>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('checkpoint must be a JSON object');
  }
  if (parsed.schemaVersion !== 6) {
    throw new Error(`unsupported checkpoint schemaVersion: ${String(parsed.schemaVersion)}`);
  }
  const extractor = parseExtractorSection(parsed.extractor);
  const observer = parseObserverSection(parsed.observer);
  if (!extractor) {
    throw new Error('checkpoint extractor section is invalid');
  }
  if (!observer) {
    throw new Error('checkpoint observer section is invalid');
  }
  return {
    schemaVersion: 6,
    writtenAt: typeof parsed.writtenAt === 'string' ? parsed.writtenAt : new Date(0).toISOString(),
    writerPid: typeof parsed.writerPid === 'number' ? parsed.writerPid : 0,
    extractor,
    observer,
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
    throw error;
  }
}

export function serializeCheckpointFile(file: CheckpointFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

function parseExtractorSection(value: unknown): ExtractorCheckpoint | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  const baseline = parseExtractorBaseline(value.baseline);
  const nextEpoch = value.nextEpoch;
  const recentSessions = parseRecentSessions(value.recentSessions);
  const threads = parseThreads(value.threads);
  const runs = parseObservingRuns(value.runs ?? []);
  const pendingExtractionChanges = parseQueuedExtractionChanges(value.pendingExtractionChanges);
  if (!baseline || typeof nextEpoch !== 'number' || !recentSessions || !threads || !runs || !pendingExtractionChanges) {
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
    pendingExtractionChanges,
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
    || (value.observation != null && typeof value.observation !== 'number')
  ) {
    return null;
  }
  return {
    turn: value.turn,
    session: value.session,
    extraction: value.extraction,
    observation: value.observation ?? 0,
  };
}

function parseObserverSection(value: unknown): ObserverCheckpoint | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  const baseline = parseObserverBaseline(value.baseline);
  const runs = parseObserverRuns(value.runs ?? []);
  const observeQueue = parseObserveQueue(value.observeQueue);
  if (!baseline || !runs || !observeQueue) {
    return null;
  }
  return { baseline, observeQueue, runs };
}

function parseObserverBaseline(value: unknown): ObserverCheckpoint['baseline'] | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  if (
    typeof value.observationContext !== 'number'
    || typeof value.observation !== 'number'
  ) {
    return null;
  }
  return {
    observationContext: value.observationContext,
    observation: value.observation,
  };
}

function parseObserveQueue(value: unknown): ObserverCheckpoint['observeQueue'] | null {
  if (!isObjectRecord(value) || !Array.isArray(value.anchors)) {
    return null;
  }
  const anchors: ObserverCheckpoint['observeQueue']['anchors'] = [];
  for (const bucket of value.anchors) {
    if (
      !isObjectRecord(bucket)
      || typeof bucket.key !== 'string'
      || typeof bucket.anchor !== 'string'
    ) {
      return null;
    }
    const extractionChanges = parseQueuedExtractionChanges(bucket.extractionChanges);
    if (!extractionChanges) {
      return null;
    }
    anchors.push({
      key: bucket.key,
      anchor: bucket.anchor,
      extractionChanges,
    });
  }
  return { anchors };
}

function parseQueuedExtractionChanges(value: unknown): QueuedExtractionChange[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const changes: QueuedExtractionChange[] = [];
  for (const entry of value) {
    if (!isObjectRecord(entry) || (entry.type !== 'upsert' && entry.type !== 'delete')) {
      return null;
    }
    const extraction = parseStoredExtraction(entry.extraction);
    if (!extraction) {
      return null;
    }
    changes.push({ type: entry.type, extraction });
  }
  return changes;
}

function parseStoredExtraction(value: unknown): Extraction | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  if (
    typeof value.id !== 'string'
    || typeof value.text !== 'string'
    || (value.context != null && typeof value.context !== 'string')
    || !isStringArray(value.anchors)
    || !isNumberArray(value.vector)
    || typeof value.importance !== 'number'
    || typeof value.category !== 'string'
    || !isStringArray(value.turnRefs)
    || !isStringArray(value.observationPaths)
    || !isStringArray(value.observedRootAnchors)
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
  ) {
    return null;
  }
  return {
    id: value.id,
    text: value.text,
    context: value.context ?? null,
    anchors: [...value.anchors],
    vector: [...value.vector],
    importance: value.importance,
    category: value.category,
    turnRefs: [...value.turnRefs],
    observationPaths: [...value.observationPaths],
    observedRootAnchors: [...value.observedRootAnchors],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
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

function parseObserverRuns(value: unknown): ObserverRun[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const runs: ObserverRun[] = [];
  for (const run of value) {
    const parsed = parseObserverRun(run);
    if (!parsed) {
      return null;
    }
    runs.push(parsed);
  }
  return runs;
}

function parseObserverRun(value: unknown): ObserverRun | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  if (
    typeof value.runId !== 'string'
    || typeof value.observeId !== 'string'
    || typeof value.anchor !== 'string'
    || !isObserverRunStage(value.stage)
  ) {
    return null;
  }
  const pendingExtractionIds = parseStringArray(value.pendingExtractionIds);
  const errors = parseObserverRunErrors(value.errors);
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
    observeId: value.observeId,
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

function parseObservationDrafts(value: unknown): NonNullable<ObserverRun['parsedObservationDrafts']> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const drafts: NonNullable<ObserverRun['parsedObservationDrafts']> = [];
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

function parseObserverRunErrors(value: unknown): ObserverRun['errors'] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const errors: ObserverRun['errors'] = [];
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
  if (!isStringArray(value)) {
    return null;
  }
  return [...value];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number');
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

function isObserverRunStage(value: unknown): value is ObserverRunStage {
  return value === 'selectingExtractions'
    || value === 'generatingObservation'
    || value === 'committingSnapshot'
    || value === 'committingObservations'
    || value === 'completed'
    || value === 'failed';
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
