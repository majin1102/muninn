import { accessSync, constants as fsConstants } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { Artifact, TurnEvent } from '@muninn/common';

type MaybePromise<T> = Promise<T> | T;

export type RecallMode = 'vector' | 'fts' | 'hybrid';

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

export type SourceRows<T> = {
  sourceVersion: number;
  rows: T[];
};

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
  extractor: string;
  events: TurnEvent[];
  artifacts?: Artifact[] | null;
  metadata?: Record<string, unknown> | null;
  prompt?: string | null;
  response?: string | null;
  extractionEpoch?: number | null;
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
  memorySignals: string[];
  skillSignals: string[];
  skillDetails: string;
  content: string;
  references: string[];
}

export type SessionIdentity = {
  project: string;
  agent: string;
  sessionId: string;
};

export type SessionSnapshotThreadScope = SessionIdentity & {
  extractor?: string;
};

export type SessionRow = {
  latestSnapshotId: string;
  sessionId: string;
  project: string;
  cwd: string;
  agent: string;
  title: string;
  summary: string;
  searchText: string;
  vector: number[];
  updatedAt: string;
};

export type DreamingSupportTurn = {
  turnId: string;
  createdAt: string;
  contribution: number;
};

export type DreamingRow = {
  dreamingId: string;
  project: string;
  createdAt: string;
  updatedAt: string;
  content: string;
  supportTurns: DreamingSupportTurn[];
};

export type ExtractionRow = {
  id: string;
  title: string;
  summary: string;
  content: string;
  cwd: string;
  vector: number[];
  turnRefs: string[];
  createdAt: string;
  updatedAt: string;
};

export type Turn = TurnRow;
export type SessionSnapshot = SessionSnapshotRow;
export type Session = SessionRow;
export type Dreaming = DreamingRow;
export type Extraction = ExtractionRow;


type NativeCoreBinding = {
  close(): MaybePromise<void>;
  turnGet(turnId: string): MaybePromise<Turn | null>;
  turnList(params: {
    mode: ListModeInput;
    agent?: string;
    sessionId?: string;
    extractor?: string;
  }): MaybePromise<Turn[]>;
  turnTimeline(params: {
    contextId: string;
    beforeLimit?: number;
    afterLimit?: number;
  }): MaybePromise<Turn[]>;
  turnLoadAfterEpoch(params: {
    extractor: string;
    committedEpoch?: number | null;
  }): MaybePromise<Turn[]>;
  turnDelta(params: {
    extractor: string;
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
  sessionSnapshotGet(snapshotId: string): MaybePromise<SessionSnapshotRow | null>;
  sessionSnapshotList(params: {
    extractor?: string;
  }): MaybePromise<SessionSnapshotRow[]>;
  sessionSnapshotListWithVersion(params: {
    extractor?: string;
    version?: number;
  }): MaybePromise<SourceRows<SessionSnapshotRow>>;
  sessionSnapshotThread(scope: SessionSnapshotThreadScope): MaybePromise<SessionSnapshotRow[]>;
  sessionSnapshotDelta(params: {
    extractor: string;
    baselineVersion: number;
  }): MaybePromise<SourceRows<SessionSnapshotRow>>;
  sessionSnapshotInsert(params: {
    snapshots: SessionSnapshotRow[];
  }): MaybePromise<SessionSnapshotRow[]>;
  sessionSnapshotDelete(params: {
    snapshotIds: string[];
  }): MaybePromise<{ deleted: number }>;
  sessionSnapshotTableStats(): MaybePromise<TableStats | null>;
  sessionSnapshotCompact(): MaybePromise<CompactResult>;
  sessionSnapshotCleanup(params: {
    floorVersion: number;
  }): MaybePromise<CompactResult>;
  sessionQuery(params: {
    query: string;
    vector: number[];
    limit: number;
  }): MaybePromise<Session[]>;
  sessionGet(params: {
    identities?: SessionIdentity[];
  }): MaybePromise<Session[]>;
  sessionList(params: {
    limit?: number;
  }): MaybePromise<Session[]>;
  sessionUpsert(params: {
    rows: Session[];
  }): MaybePromise<void>;
  sessionReplaceAll(params: {
    rows: Session[];
  }): MaybePromise<void>;
  sessionDelete(params: {
    identities: SessionIdentity[];
  }): MaybePromise<{ deleted: number }>;
  sessionValidateDimensions(params: {
    expected: number;
  }): MaybePromise<void>;
  sessionTableStats(): MaybePromise<TableStats | null>;
  sessionEnsureVectorIndex(params: {
    targetPartitionSize: number;
  }): MaybePromise<EnsureVectorIndexResult>;
  sessionCompact(): MaybePromise<CompactResult>;
  sessionCleanup(params: {
    floorVersion: number;
  }): MaybePromise<CompactResult>;
  sessionOptimize(params: {
    mergeCount: number;
  }): MaybePromise<CompactResult>;
  dreamingGet(dreamingId: string): MaybePromise<DreamingRow | null>;
  dreamingList(): MaybePromise<DreamingRow[]>;
  dreamingDelta(params: {
    baselineVersion: number;
  }): MaybePromise<SourceRows<DreamingRow>>;
  dreamingAppend(params: {
    row: DreamingRow;
  }): MaybePromise<DreamingRow>;
  dreamingUpdate(params: {
    row: DreamingRow;
  }): MaybePromise<DreamingRow>;
  dreamingDelete(params: {
    dreamingIds: string[];
  }): MaybePromise<{ deleted: number }>;
  dreamingTableStats(): MaybePromise<TableStats | null>;
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
  describeTurnTable(): MaybePromise<TableDescription | null>;
  describeSessionSnapshotTable(): MaybePromise<TableDescription | null>;
  describeSessionTable(): MaybePromise<TableDescription | null>;
  describeDreamingTable(): MaybePromise<TableDescription | null>;
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
    project?: string;
    agent?: string;
    sessionId?: string;
    extractor?: string;
  }): Promise<Turn[]>;
  timelineTurns(params: {
    contextId: string;
    beforeLimit?: number;
    afterLimit?: number;
  }): Promise<Turn[]>;
  loadTurnsAfterEpoch(params: {
    extractor: string;
    committedEpoch?: number | null;
  }): Promise<Turn[]>;
  delta(params: {
    extractor: string;
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

export interface SessionSnapshotTableBinding {
  getSnapshot(snapshotId: string): Promise<SessionSnapshot | null>;
  listSnapshots(params: {
    extractor?: string;
  }): Promise<SessionSnapshotRow[]>;
  listSnapshotsWithVersion(params: {
    extractor?: string;
    version?: number;
  }): Promise<SourceRows<SessionSnapshotRow>>;
  threadSnapshots(scope: SessionSnapshotThreadScope): Promise<SessionSnapshotRow[]>;
  delta(params: {
    extractor: string;
    baselineVersion: number;
  }): Promise<SourceRows<SessionSnapshotRow>>;
  insert(params: {
    snapshots: SessionSnapshotRow[];
  }): Promise<SessionSnapshotRow[]>;
  delete(params: {
    snapshotIds: string[];
  }): Promise<{ deleted: number }>;
  stats(): Promise<TableStats | null>;
  compact(): Promise<CompactResult>;
  cleanup(params: {
    floorVersion: number;
  }): Promise<CompactResult>;
  describe(): Promise<TableDescription | null>;
}

export interface DreamingTableBinding {
  get(dreamingId: string): Promise<DreamingRow | null>;
  list(): Promise<DreamingRow[]>;
  delta(params: {
    baselineVersion: number;
  }): Promise<SourceRows<DreamingRow>>;
  append(params: {
    row: DreamingRow;
  }): Promise<DreamingRow>;
  update(params: {
    row: DreamingRow;
  }): Promise<DreamingRow>;
  delete(params: {
    dreamingIds: string[];
  }): Promise<{ deleted: number }>;
  stats(): Promise<TableStats | null>;
  describe(): Promise<TableDescription | null>;
}

export interface SessionTableBinding {
  search(params: {
    query: string;
    vector: number[];
    limit: number;
  }): Promise<SessionRow[]>;
  get(params: {
    identities?: SessionIdentity[];
  }): Promise<SessionRow[]>;
  list(params: {
    limit?: number;
  }): Promise<SessionRow[]>;
  upsert(params: {
    rows: SessionRow[];
  }): Promise<void>;
  replaceAll(params: {
    rows: SessionRow[];
  }): Promise<void>;
  delete(params: {
    identities: SessionIdentity[];
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

export interface NativeTables {
  close(): Promise<void>;
  turnTable: TurnTableBinding;
  sessionSnapshotTable: SessionSnapshotTableBinding;
  dreamingTable: DreamingTableBinding;
  sessionTable: SessionTableBinding;
  extractionTable: ExtractionTableBinding;
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
    sessionSnapshotTable: {
      getSnapshot: async (snapshotId) => normalizeOptionalRecord(
        await resolveNativeResult(native.sessionSnapshotGet(snapshotId)),
        'snapshotId',
      ),
      listSnapshots: async (params) => resolveNativeResult(native.sessionSnapshotList(params)),
      listSnapshotsWithVersion: async (params) => resolveNativeResult(native.sessionSnapshotListWithVersion(params)),
      threadSnapshots: async (scope) => resolveNativeResult(native.sessionSnapshotThread(scope)),
      delta: async (params) => resolveNativeResult(native.sessionSnapshotDelta(params)),
      insert: async (params) => resolveNativeResult(native.sessionSnapshotInsert(params)),
      delete: async (params) => resolveNativeResult(native.sessionSnapshotDelete(params)),
      stats: async () => resolveNativeResult(native.sessionSnapshotTableStats()),
      compact: async () => resolveNativeResult(native.sessionSnapshotCompact()),
      cleanup: async (params) => resolveNativeResult(native.sessionSnapshotCleanup(params)),
      describe: async () => resolveNativeResult(native.describeSessionSnapshotTable()),
    },
    dreamingTable: {
      get: async (dreamingId) => normalizeOptionalRecord(
        await resolveNativeResult(native.dreamingGet(dreamingId)),
        'dreamingId',
      ),
      list: async () => resolveNativeResult(native.dreamingList()),
      delta: async (params) => resolveNativeResult(native.dreamingDelta(params)),
      append: async (params) => resolveNativeResult(native.dreamingAppend(params)),
      update: async (params) => resolveNativeResult(native.dreamingUpdate(params)),
      delete: async (params) => resolveNativeResult(native.dreamingDelete(params)),
      stats: async () => resolveNativeResult(native.dreamingTableStats()),
      describe: async () => resolveNativeResult(native.describeDreamingTable()),
    },
    sessionTable: {
      search: async (params) => resolveNativeResult(native.sessionQuery(params)),
      get: async (params) => resolveNativeResult(native.sessionGet(params)),
      list: async (params) => resolveNativeResult(native.sessionList(params)),
      upsert: async (params) => resolveNativeResult(native.sessionUpsert(params)),
      replaceAll: async (params) => resolveNativeResult(native.sessionReplaceAll(params)),
      delete: async (params) => resolveNativeResult(native.sessionDelete(params)),
      validateDimensions: async (params) => resolveNativeResult(native.sessionValidateDimensions(params)),
      stats: async () => resolveNativeResult(native.sessionTableStats()),
      ensureVectorIndex: async (params) => resolveNativeResult(native.sessionEnsureVectorIndex(params)),
      compact: async () => resolveNativeResult(native.sessionCompact()),
      cleanup: async (params) => resolveNativeResult(native.sessionCleanup(params)),
      optimize: async (params) => resolveNativeResult(native.sessionOptimize(params)),
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
  | 'sessionSnapshot'
  | 'session'
  | 'dreaming'
  | 'extraction';

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
    sessionSnapshotTable: tables.sessionSnapshotTable && {
      ...tables.sessionSnapshotTable,
      insert: (params) => locks.with('sessionSnapshot', () => tables.sessionSnapshotTable.insert(params)),
      compact: () => locks.with('sessionSnapshot', () => tables.sessionSnapshotTable.compact()),
      cleanup: (params) => locks.with('sessionSnapshot', () => tables.sessionSnapshotTable.cleanup(params)),
    },
    dreamingTable: tables.dreamingTable && {
      ...tables.dreamingTable,
      append: (params) => locks.with('dreaming', () => tables.dreamingTable.append(params)),
      update: (params) => locks.with('dreaming', () => tables.dreamingTable.update(params)),
      delete: (params) => locks.with('dreaming', () => tables.dreamingTable.delete(params)),
    },
    sessionTable: tables.sessionTable && {
      ...tables.sessionTable,
      upsert: (params) => locks.with('session', () => tables.sessionTable.upsert(params)),
      replaceAll: (params) => locks.with('session', () => tables.sessionTable.replaceAll(params)),
      delete: (params) => locks.with('session', () => tables.sessionTable.delete(params)),
      ensureVectorIndex: (params) => locks.with('session', () => tables.sessionTable.ensureVectorIndex(params)),
      compact: () => locks.with('session', () => tables.sessionTable.compact()),
      cleanup: (params) => locks.with('session', () => tables.sessionTable.cleanup(params)),
      optimize: (params) => locks.with('session', () => tables.sessionTable.optimize(params)),
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
