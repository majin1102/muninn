import { accessSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';

import type { ListModeInput, SessionSnapshot, Turn } from './client.js';
import type { SessionSnapshot as SessionSnapshotPayload } from './extractor/types.js';
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

export type Extraction = {
  id: string;
  text: string;
  context?: string | null;
  anchors: string[];
  vector: number[];
  importance: number;
  category: string;
  turnRefs: string[];
  observationIds: string[];
  observedRootAnchors: string[];
  createdAt: string;
  updatedAt: string;
};

export type ObservationContext = {
  id: string;
  observingPath: string;
  parentId?: string | null;
  position: number;
  content: string;
  observer: string;
  createdAt: string;
  updatedAt: string;
};

export type Observation = {
  id: string;
  observingPath: string;
  text: string;
  vector: number[];
  extractionRefs: string[];
  createdAt: string;
  updatedAt: string;
};

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
  sessionGetSnapshot(snapshotId: string): MaybePromise<SessionSnapshotPayload | null>;
  sessionListSnapshots(params: {
    observer?: string;
  }): MaybePromise<SessionSnapshotPayload[]>;
  sessionSnapshots(sessionId: string): MaybePromise<SessionSnapshotPayload[]>;
  sessionDelta(params: {
    observer: string;
    baselineVersion: number;
  }): MaybePromise<SessionSnapshotPayload[]>;
  sessionInsert(params: {
    snapshots: SessionSnapshotPayload[];
  }): MaybePromise<SessionSnapshotPayload[]>;
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
  extractionLoadByIds(params: {
    ids: string[];
  }): MaybePromise<Extraction[]>;
  extractionList(params: {
    limit?: number;
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
  observationContextLoadByIds(params: {
    ids: string[];
  }): MaybePromise<ObservationContext[]>;
  observationContextDelete(params: {
    ids: string[];
  }): MaybePromise<{ deleted: number }>;
  observationContextTableStats(): MaybePromise<TableStats | null>;
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
  observationLoadByIds(params: {
    ids: string[];
  }): MaybePromise<Observation[]>;
  observationTableStats(): MaybePromise<TableStats | null>;
  describeTurnTable(): MaybePromise<TableDescription | null>;
  describeSessionTable(): MaybePromise<TableDescription | null>;
  describeExtractionTable(): MaybePromise<TableDescription | null>;
};

type NativeModule = {
  createCoreBinding(): MaybePromise<NativeCoreBinding>;
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
  }): Promise<SessionSnapshotPayload[]>;
  threadSnapshots(sessionId: string): Promise<SessionSnapshotPayload[]>;
  delta(params: {
    observer: string;
    baselineVersion: number;
  }): Promise<SessionSnapshotPayload[]>;
  insert(params: {
    snapshots: SessionSnapshotPayload[];
  }): Promise<SessionSnapshotPayload[]>;
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
  loadByIds(params: {
    ids: string[];
  }): Promise<Extraction[]>;
  list(params: {
    limit?: number;
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
  loadByIds(params: {
    ids: string[];
  }): Promise<ObservationContext[]>;
  delete(params: {
    ids: string[];
  }): Promise<{ deleted: number }>;
  stats(): Promise<TableStats | null>;
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
  loadByIds(params: {
    ids: string[];
  }): Promise<Observation[]>;
  stats(): Promise<TableStats | null>;
}

export interface NativeTables {
  close(): Promise<void>;
  turnTable: TurnTableBinding;
  sessionTable: SessionTableBinding;
  extractionTable: ExtractionTableBinding;
  observationContextTable: ObservationContextTableBinding;
  observationTable: ObservationTableBinding;
}

let singleton: NativeTables | null = null;
let singletonPromise: Promise<NativeTables> | null = null;

export async function getNativeTables(): Promise<NativeTables> {
  if (singleton) {
    return singleton;
  }
  if (!singletonPromise) {
    const native = loadNativeModule();
    singletonPromise = resolveNativeResult(native.createCoreBinding())
      .then((binding) => {
        singleton = wrapBinding(binding);
        return singleton;
      })
      .catch((error) => {
        singletonPromise = null;
        throw error;
      });
  }
  return singletonPromise;
}

export async function shutdownNativeTablesForTests(): Promise<void> {
  singleton = null;
  singletonPromise = null;
}

export async function describeExtractionForStorage(
  storageTarget: StorageTarget | null,
): Promise<TableDescription | null> {
  const native = loadNativeModule();
  return resolveNativeResult(native.describeExtractionForStorage(storageTarget));
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
      loadByIds: async (params) => resolveNativeResult(native.extractionLoadByIds(params)),
      list: async (params) => resolveNativeResult(native.extractionList(params)),
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
      loadByIds: async (params) => resolveNativeResult(native.observationContextLoadByIds(params)),
      delete: async (params) => resolveNativeResult(native.observationContextDelete(params)),
      stats: async () => resolveNativeResult(native.observationContextTableStats()),
    },
    observationTable: {
      upsert: async (params) => resolveNativeResult(native.observationUpsert(params)),
      delete: async (params) => resolveNativeResult(native.observationDelete(params)),
      search: async (params) => resolveNativeResult(native.observationSearch(params)),
      loadByIds: async (params) => resolveNativeResult(native.observationLoadByIds(params)),
      stats: async () => resolveNativeResult(native.observationTableStats()),
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
