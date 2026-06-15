import { accessSync, constants as fsConstants } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { Artifact, TurnEvent } from '@muninn/common';
import type { RecallMode } from './config.js';

type MaybePromise<T> = Promise<T> | T;

export interface TableDescription {
  // describe() exposes table facts surfaced by the opened dataset. It does not
  // imply that every table runs a full schema-health validation before returning.
  metadata: Record<string, string>;
  fieldMetadata: Record<string, Record<string, string>>;
  dimensions?: Record<string, number>;
}

export interface StorageTarget {
  uri: string;
  storageOptions?: Record<string, string>;
}

export interface TableStats {
  version: number;
  fragmentCount: number;
  rowCount: number;
}

export interface CompactResult {
  changed: boolean;
}

export interface EnsureVectorIndexResult {
  created: boolean;
}

export type ListModeInput =
  | { type: 'recency'; limit: number }
  | { type: 'page'; offset: number; limit: number };

export interface TurnRow {
  turnId: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string | null;
  turnSequence?: number | null;
  project: string;
  cwd: string;
  agent: string;
  observer: string;
  events: TurnEvent[];
  artifacts?: Artifact[] | null;
  metadata?: Record<string, unknown> | null;
  prompt?: string | null;
  response?: string | null;
  observingEpoch?: number | null;
  previousTurnSummary?: string | null;
  recentContext?: import('./checkpoint.js').RecentTurn[];
}

export interface SessionSnapshotRow {
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
  content: string;
  references: string[];
}

export type ExtractionRow = {
  id: string;
  title: string;
  summary: string;
  content: string;
  cwd: string;
  vector: number[];
  turnRefs: string[];
  observationPaths: string[];
  createdAt: string;
  updatedAt: string;
};

export type ObservationContextRow = {
  id: string;
  path: string;
  parentId?: string | null;
  position: number;
  content: string;
  sourceRefs: string[];
  expandRefs: string[];
  observer: string;
  createdAt: string;
  updatedAt: string;
};

export type ObservationRow = {
  id: string;
  path: string;
  text: string;
  vector: number[];
  extractionRefs: string[];
  createdAt: string;
  updatedAt: string;
};

export type Turn = TurnRow;
export type SessionSnapshot = SessionSnapshotRow;
export type Extraction = ExtractionRow;
export type ObservationContext = ObservationContextRow;
export type Observation = ObservationRow;


type NativeCoreBinding = {
  close(): MaybePromise<void>;
  turnGet(turnId: string): MaybePromise<Turn | null>;
  turnList(params: {
    mode: ListModeInput;
    agent?: string;
    sessionId?: string;
  }): MaybePromise<Turn[]>;
  turnTimeline(params: {
    memoryId: string;
    beforeLimit?: number;
    afterLimit?: number;
  }): MaybePromise<Turn[]>;
  turnLoadAfterEpoch(params: {
    observer: string;
    committedEpoch?: number | null;
  }): MaybePromise<Turn[]>;
  turnDelta(params: {
    observer: string;
    baselineVersion: number;
  }): MaybePromise<Turn[]>;
  turnInsert(params: {
    turns: Array<Record<string, unknown>>;
  }): MaybePromise<Turn[]>;
  turnDelete(params: {
    turnIds: string[];
  }): MaybePromise<{ deleted: number }>;
  turnTableStats(): MaybePromise<TableStats | null>;
  turnCompact(): MaybePromise<CompactResult>;
  turnCleanup(params: {
    floorVersion: number;
  }): MaybePromise<CompactResult>;
  sessionGetSnapshot(snapshotId: string): MaybePromise<SessionSnapshotRow | null>;
  sessionListSnapshots(params: {
    observer?: string;
  }): MaybePromise<SessionSnapshotRow[]>;
  sessionSnapshots(sessionId: string): MaybePromise<SessionSnapshotRow[]>;
  sessionDelta(params: {
    observer: string;
    baselineVersion: number;
  }): MaybePromise<SessionSnapshotRow[]>;
  sessionInsert(params: {
    snapshots: SessionSnapshotRow[];
  }): MaybePromise<SessionSnapshotRow[]>;
  sessionTableStats(): MaybePromise<TableStats | null>;
  sessionCompact(): MaybePromise<CompactResult>;
  sessionCleanup(params: {
    floorVersion: number;
  }): MaybePromise<CompactResult>;
  extractionNearest(params: {
    vector: number[];
    limit: number;
  }): MaybePromise<Extraction[]>;
  extractionSearch(params: {
    query: string;
    vector: number[];
    limit: number;
    mode: RecallMode;
  }): MaybePromise<Extraction[]>;
  extractionGet(params: {
    ids: string[];
  }): MaybePromise<Extraction[]>;
  extractionList(params: {
    limit?: number;
  }): MaybePromise<Extraction[]>;
  extractionDelta(params: {
    baselineVersion: number;
  }): MaybePromise<Extraction[]>;
  extractionUpsert(params: {
    rows: Extraction[];
  }): MaybePromise<void>;
  extractionDelete(params: {
    ids: string[];
  }): MaybePromise<{ deleted: number }>;
  extractionValidateDimensions(params: {
    expected: number;
  }): MaybePromise<void>;
  extractionTableStats(): MaybePromise<TableStats | null>;
  extractionEnsureVectorIndex(params: {
    targetPartitionSize: number;
  }): MaybePromise<EnsureVectorIndexResult>;
  extractionCompact(): MaybePromise<CompactResult>;
  extractionCleanup(params: {
    floorVersion: number;
  }): MaybePromise<CompactResult>;
  extractionOptimize(params: {
    mergeCount: number;
  }): MaybePromise<CompactResult>;
  observationContextUpsert(params: {
    rows: ObservationContext[];
  }): MaybePromise<void>;
  observationContextList(params: {
    observer?: string;
  }): MaybePromise<ObservationContext[]>;
  observationContextGet(params: {
    ids: string[];
  }): MaybePromise<ObservationContext[]>;
  observationContextDelete(params: {
    ids: string[];
  }): MaybePromise<{ deleted: number }>;
  observationContextTableStats(): MaybePromise<TableStats | null>;
  observationContextEnsureIdIndex(): MaybePromise<EnsureVectorIndexResult>;
  observationContextOptimize(params: {
    mergeCount: number;
  }): MaybePromise<CompactResult>;
  observationUpsert(params: {
    rows: Observation[];
  }): MaybePromise<void>;
  observationDelete(params: {
    ids: string[];
  }): MaybePromise<{ deleted: number }>;
  observationSearch(params: {
    query: string;
    vector: number[];
    limit: number;
    mode: RecallMode;
  }): MaybePromise<Observation[]>;
  observationGet(params: {
    ids: string[];
  }): MaybePromise<Observation[]>;
  observationTableStats(): MaybePromise<TableStats | null>;
  observationEnsureVectorIndex(params: {
    targetPartitionSize: number;
  }): MaybePromise<EnsureVectorIndexResult>;
  observationCompact(): MaybePromise<CompactResult>;
  observationCleanup(params: {
    floorVersion: number;
  }): MaybePromise<CompactResult>;
  observationOptimize(params: {
    mergeCount: number;
  }): MaybePromise<CompactResult>;
  describeTurnTable(): MaybePromise<TableDescription | null>;
  describeSessionTable(): MaybePromise<TableDescription | null>;
  describeExtractionTable(): MaybePromise<TableDescription | null>;
};

type NativeModule = {
  createCoreBinding(storageTarget?: StorageTarget | null): MaybePromise<NativeCoreBinding>;
  describeExtractionForStorage(storageTarget: StorageTarget | null): MaybePromise<TableDescription | null>;
};

export interface TurnTableBinding {
  getTurn(turnId: string): Promise<Turn | null>;
  listTurns(params: {
    mode: ListModeInput;
    agent?: string;
    sessionId?: string;
  }): Promise<Turn[]>;
  timelineTurns(params: {
    memoryId: string;
    beforeLimit?: number;
    afterLimit?: number;
  }): Promise<Turn[]>;
  loadTurnsAfterEpoch(params: {
    observer: string;
    committedEpoch?: number | null;
  }): Promise<Turn[]>;
  delta(params: {
    observer: string;
    baselineVersion: number;
  }): Promise<Turn[]>;
  insert(params: {
    turns: Array<Record<string, unknown>>;
  }): Promise<Turn[]>;
  deleteTurns(params: {
    turnIds: string[];
  }): Promise<{ deleted: number }>;
  stats(): Promise<TableStats | null>;
  compact(): Promise<CompactResult>;
  cleanup(params: {
    floorVersion: number;
  }): Promise<CompactResult>;
  describe(): Promise<TableDescription | null>;
}

export interface SessionTableBinding {
  getSnapshot(snapshotId: string): Promise<SessionSnapshot | null>;
  listSnapshots(params: {
    observer?: string;
  }): Promise<SessionSnapshotRow[]>;
  threadSnapshots(sessionId: string): Promise<SessionSnapshotRow[]>;
  delta(params: {
    observer: string;
    baselineVersion: number;
  }): Promise<SessionSnapshotRow[]>;
  insert(params: {
    snapshots: SessionSnapshotRow[];
  }): Promise<SessionSnapshotRow[]>;
  stats(): Promise<TableStats | null>;
  compact(): Promise<CompactResult>;
  cleanup(params: {
    floorVersion: number;
  }): Promise<CompactResult>;
  describe(): Promise<TableDescription | null>;
}

export interface ExtractionTableBinding {
  nearest(params: {
    vector: number[];
    limit: number;
  }): Promise<Extraction[]>;
  search(params: {
    query: string;
    vector: number[];
    limit: number;
    mode: RecallMode;
  }): Promise<Extraction[]>;
  get(params: {
    ids: string[];
  }): Promise<Extraction[]>;
  list(params: {
    limit?: number;
  }): Promise<Extraction[]>;
  delta(params: {
    baselineVersion: number;
  }): Promise<Extraction[]>;
  upsert(params: {
    rows: Extraction[];
  }): Promise<void>;
  delete(params: {
    ids: string[];
  }): Promise<{ deleted: number }>;
  validateDimensions(params: {
    expected: number;
  }): Promise<void>;
  stats(): Promise<TableStats | null>;
  ensureVectorIndex(params: {
    targetPartitionSize: number;
  }): Promise<EnsureVectorIndexResult>;
  compact(): Promise<CompactResult>;
  cleanup(params: {
    floorVersion: number;
  }): Promise<CompactResult>;
  optimize(params: {
    mergeCount: number;
  }): Promise<CompactResult>;
  describe(): Promise<TableDescription | null>;
}

export interface ObservationContextTableBinding {
  upsert(params: {
    rows: ObservationContext[];
  }): Promise<void>;
  list(params: {
    observer?: string;
  }): Promise<ObservationContext[]>;
  get(params: {
    ids: string[];
  }): Promise<ObservationContext[]>;
  delete(params: {
    ids: string[];
  }): Promise<{ deleted: number }>;
  stats(): Promise<TableStats | null>;
  ensureIdIndex(): Promise<EnsureVectorIndexResult>;
  optimize(params: {
    mergeCount: number;
  }): Promise<CompactResult>;
}

export interface ObservationTableBinding {
  upsert(params: {
    rows: Observation[];
  }): Promise<void>;
  delete(params: {
    ids: string[];
  }): Promise<{ deleted: number }>;
  search(params: {
    query: string;
    vector: number[];
    limit: number;
    mode: RecallMode;
  }): Promise<Observation[]>;
  get(params: {
    ids: string[];
  }): Promise<Observation[]>;
  stats(): Promise<TableStats | null>;
  ensureVectorIndex(params: {
    targetPartitionSize: number;
  }): Promise<EnsureVectorIndexResult>;
  compact(): Promise<CompactResult>;
  cleanup(params: {
    floorVersion: number;
  }): Promise<CompactResult>;
  optimize(params: {
    mergeCount: number;
  }): Promise<CompactResult>;
}

export interface NativeTables {
  close(): Promise<void>;
  turnTable: TurnTableBinding;
  sessionTable: SessionTableBinding;
  extractionTable: ExtractionTableBinding;
  observationContextTable: ObservationContextTableBinding;
  observationTable: ObservationTableBinding;
}

const singletons = new Map<string, NativeTables>();
const singletonPromises = new Map<string, Promise<NativeTables>>();

export async function createNativeTables(storageTarget?: StorageTarget | null): Promise<NativeTables> {
  const native = loadNativeModule();
  await ensureLocalStorageRoot(storageTarget);
  return wrapBinding(await resolveNativeResult(native.createCoreBinding(storageTarget ?? null)));
}

export async function getNativeTables(storageTarget?: StorageTarget | null): Promise<NativeTables> {
  const key = storageTargetKey(storageTarget);
  const cached = singletons.get(key);
  if (cached) {
    return cached;
  }
  const pending = singletonPromises.get(key);
  if (pending) {
    return pending;
  }
  const promise = createNativeTables(storageTarget)
      .then((tables) => {
        singletons.set(key, tables);
        return tables;
      })
      .catch((error) => {
        singletonPromises.delete(key);
        throw error;
      });
  singletonPromises.set(key, promise);
  return promise;
}

export async function shutdownNativeTablesForTests(): Promise<void> {
  singletons.clear();
  singletonPromises.clear();
}

export async function describeExtractionForStorage(
  storageTarget: StorageTarget | null,
): Promise<TableDescription | null> {
  const native = loadNativeModule();
  return resolveNativeResult(native.describeExtractionForStorage(storageTarget));
}

export function probeNativeAddon(): void {
  loadNativeModule();
}

function wrapBinding(native: NativeCoreBinding): NativeTables {
  const turnTable: TurnTableBinding = {
    getTurn: async (turnId) => normalizeOptionalRecord(
      await resolveNativeResult(native.turnGet(turnId)),
      'turnId',
    ),
    listTurns: async (params) => resolveNativeResult(native.turnList(params)),
    timelineTurns: async (params) => resolveNativeResult(native.turnTimeline(params)),
    loadTurnsAfterEpoch: async (params) => resolveNativeResult(native.turnLoadAfterEpoch(params)),
    delta: async (params) => resolveNativeResult(native.turnDelta(params)),
    insert: async (params) => resolveNativeResult(native.turnInsert(params)),
    deleteTurns: async (params) => resolveNativeResult(native.turnDelete(params)),
    stats: async () => resolveNativeResult(native.turnTableStats()),
    compact: async () => resolveNativeResult(native.turnCompact()),
    cleanup: async (params) => resolveNativeResult(native.turnCleanup(params)),
    describe: async () => resolveNativeResult(native.describeTurnTable()),
  };
  return {
    close: async () => resolveNativeResult(native.close()),
    turnTable,
    sessionTable: {
      getSnapshot: async (snapshotId) => normalizeOptionalRecord(
        await resolveNativeResult(native.sessionGetSnapshot(snapshotId)),
        'snapshotId',
      ),
      listSnapshots: async (params) => resolveNativeResult(native.sessionListSnapshots(params)),
      threadSnapshots: async (sessionId) => resolveNativeResult(native.sessionSnapshots(sessionId)),
      delta: async (params) => resolveNativeResult(native.sessionDelta(params)),
      insert: async (params) => resolveNativeResult(native.sessionInsert(params)),
      stats: async () => resolveNativeResult(native.sessionTableStats()),
      compact: async () => resolveNativeResult(native.sessionCompact()),
      cleanup: async (params) => resolveNativeResult(native.sessionCleanup(params)),
      describe: async () => resolveNativeResult(native.describeSessionTable()),
    },
    extractionTable: {
      nearest: async (params) => resolveNativeResult(native.extractionNearest(params)),
      search: async (params) => resolveNativeResult(native.extractionSearch(params)),
      get: async (params) => resolveNativeResult(native.extractionGet(params)),
      list: async (params) => resolveNativeResult(native.extractionList(params)),
      delta: async (params) => resolveNativeResult(native.extractionDelta(params)),
      upsert: async (params) => resolveNativeResult(native.extractionUpsert(params)),
      delete: async (params) => resolveNativeResult(native.extractionDelete(params)),
      validateDimensions: async (params) => resolveNativeResult(native.extractionValidateDimensions(params)),
      stats: async () => resolveNativeResult(native.extractionTableStats()),
      ensureVectorIndex: async (params) => resolveNativeResult(native.extractionEnsureVectorIndex(params)),
      compact: async () => resolveNativeResult(native.extractionCompact()),
      cleanup: async (params) => resolveNativeResult(native.extractionCleanup(params)),
      optimize: async (params) => resolveNativeResult(native.extractionOptimize(params)),
      describe: async () => resolveNativeResult(native.describeExtractionTable()),
    },
    observationContextTable: {
      upsert: async (params) => resolveNativeResult(native.observationContextUpsert(params)),
      list: async (params) => resolveNativeResult(native.observationContextList(params)),
      get: async (params) => resolveNativeResult(native.observationContextGet(params)),
      delete: async (params) => resolveNativeResult(native.observationContextDelete(params)),
      stats: async () => resolveNativeResult(native.observationContextTableStats()),
      ensureIdIndex: async () => resolveNativeResult(native.observationContextEnsureIdIndex()),
      optimize: async (params) => resolveNativeResult(native.observationContextOptimize(params)),
    },
    observationTable: {
      upsert: async (params) => resolveNativeResult(native.observationUpsert(params)),
      delete: async (params) => resolveNativeResult(native.observationDelete(params)),
      search: async (params) => resolveNativeResult(native.observationSearch(params)),
      get: async (params) => resolveNativeResult(native.observationGet(params)),
      stats: async () => resolveNativeResult(native.observationTableStats()),
      ensureVectorIndex: async (params) => resolveNativeResult(native.observationEnsureVectorIndex(params)),
      compact: async () => resolveNativeResult(native.observationCompact()),
      cleanup: async (params) => resolveNativeResult(native.observationCleanup(params)),
      optimize: async (params) => resolveNativeResult(native.observationOptimize(params)),
    },
  };
}

function loadNativeModule(): NativeModule {
  const bindingPath = resolveNativeBindingPath();
  accessSync(bindingPath, fsConstants.R_OK);
  return require(bindingPath) as NativeModule;
}

export function resolveNativeBindingPath(): string {
  return path.resolve(__dirname, '..', 'native', 'muninn_native.node');
}

export const __testing = {
  resolveNativeBindingPath,
};

export type TableName =
  | 'turn'
  | 'session'
  | 'extraction'
  | 'observationContext'
  | 'observation';

export class TableMutationLocks {
  private readonly queues = new Map<TableName, Promise<void>>();

  async with<T>(table: TableName, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.queues.get(table) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current, () => current);
    this.queues.set(table, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(table) === tail) {
        this.queues.delete(table);
      }
    }
  }
}

export function lockNativeTables<T extends NativeTables>(tables: T, locks: TableMutationLocks): T {
  return {
    ...tables,
    turnTable: tables.turnTable && {
      ...tables.turnTable,
      insert: (params) => locks.with('turn', () => tables.turnTable.insert(params)),
      deleteTurns: (params) => locks.with('turn', () => tables.turnTable.deleteTurns(params)),
      compact: () => locks.with('turn', () => tables.turnTable.compact()),
      cleanup: (params) => locks.with('turn', () => tables.turnTable.cleanup(params)),
    },
    sessionTable: tables.sessionTable && {
      ...tables.sessionTable,
      insert: (params) => locks.with('session', () => tables.sessionTable.insert(params)),
      compact: () => locks.with('session', () => tables.sessionTable.compact()),
      cleanup: (params) => locks.with('session', () => tables.sessionTable.cleanup(params)),
    },
    extractionTable: tables.extractionTable && {
      ...tables.extractionTable,
      upsert: (params) => locks.with('extraction', () => tables.extractionTable.upsert(params)),
      delete: (params) => locks.with('extraction', () => tables.extractionTable.delete(params)),
      ensureVectorIndex: (params) => locks.with('extraction', () => tables.extractionTable.ensureVectorIndex(params)),
      compact: () => locks.with('extraction', () => tables.extractionTable.compact()),
      cleanup: (params) => locks.with('extraction', () => tables.extractionTable.cleanup(params)),
      optimize: (params) => locks.with('extraction', () => tables.extractionTable.optimize(params)),
    },
    observationContextTable: tables.observationContextTable && {
      ...tables.observationContextTable,
      upsert: (params) => locks.with('observationContext', () => tables.observationContextTable.upsert(params)),
      delete: (params) => locks.with('observationContext', () => tables.observationContextTable.delete(params)),
      ensureIdIndex: () => locks.with('observationContext', () => tables.observationContextTable.ensureIdIndex()),
      optimize: (params) => locks.with('observationContext', () => tables.observationContextTable.optimize(params)),
    },
    observationTable: tables.observationTable && {
      ...tables.observationTable,
      upsert: (params) => locks.with('observation', () => tables.observationTable.upsert(params)),
      delete: (params) => locks.with('observation', () => tables.observationTable.delete(params)),
      ensureVectorIndex: (params) => locks.with('observation', () => tables.observationTable.ensureVectorIndex(params)),
      compact: () => locks.with('observation', () => tables.observationTable.compact()),
      cleanup: (params) => locks.with('observation', () => tables.observationTable.cleanup(params)),
      optimize: (params) => locks.with('observation', () => tables.observationTable.optimize(params)),
    },
  };
}

function storageTargetKey(storageTarget?: StorageTarget | null): string {
  if (!storageTarget) {
    return 'default';
  }
  const options = storageTarget.storageOptions
    ? Object.entries(storageTarget.storageOptions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('&')
    : '';
  return `${storageTarget.uri}#${options}`;
}

async function ensureLocalStorageRoot(storageTarget?: StorageTarget | null): Promise<void> {
  if (!storageTarget?.uri.startsWith('file-object-store://')) {
    return;
  }
  const filePath = storageTarget.uri.slice('file-object-store://'.length);
  await mkdir(filePath, { recursive: true });
}

function normalizeOptionalRecord<T>(
  value: T | null | undefined,
  idField: string,
): T | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  return record[idField] == null ? null : value;
}

async function resolveNativeResult<T>(value: MaybePromise<T>): Promise<T> {
  const resolved = await Promise.resolve(value);
  if (resolved instanceof Error) {
    throw resolved;
  }
  return resolved;
}
