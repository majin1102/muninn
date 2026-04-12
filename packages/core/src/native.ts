import { accessSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';

import type { OpenTurnSourceRef } from './checkpoint.js';
import type { ListModeInput, ObservingSnapshot, SessionTurn } from './client.js';
import type { SemanticIndexRow, ObservingSnapshot as ObservingSnapshotPayload } from './observer/types.js';

type MaybePromise<T> = Promise<T> | T;
const EXPORT_PAGE_SIZE = 1_000;

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

type NativeCoreBinding = {
  close(): MaybePromise<void>;
  sessionLoadOpenTurn(params: {
    sessionId?: string;
    agent: string;
    observer: string;
  }): MaybePromise<SessionTurn | null>;
  sessionGetTurn(turnId: string): MaybePromise<SessionTurn | null>;
  sessionListTurns(params: {
    mode: ListModeInput;
    agent?: string;
    sessionId?: string;
  }): MaybePromise<SessionTurn[]>;
  sessionTimelineTurns(params: {
    memoryId: string;
    beforeLimit?: number;
    afterLimit?: number;
  }): MaybePromise<SessionTurn[]>;
  sessionLoadTurnsAfterEpoch(params: {
    observer: string;
    committedEpoch?: number | null;
  }): MaybePromise<SessionTurn[]>;
  sessionInsert(params: {
    turns: Array<Record<string, unknown>>;
  }): MaybePromise<SessionTurn[]>;
  sessionUpdate(params: {
    turns: Array<Record<string, unknown>>;
  }): MaybePromise<SessionTurn[]>;
  sessionDeleteTurns(params: {
    turnIds: string[];
  }): MaybePromise<{ deleted: number }>;
  sessionTableStats(): MaybePromise<TableStats | null>;
  sessionCompact(): MaybePromise<CompactResult>;
  observingGetSnapshot(snapshotId: string): MaybePromise<ObservingSnapshotPayload | null>;
  observingListSnapshots(params: {
    observer?: string;
  }): MaybePromise<ObservingSnapshotPayload[]>;
  observingThreadSnapshots(observingId: string): MaybePromise<ObservingSnapshotPayload[]>;
  observingInsert(params: {
    snapshots: ObservingSnapshotPayload[];
  }): MaybePromise<ObservingSnapshotPayload[]>;
  observingUpdate(params: {
    snapshots: ObservingSnapshotPayload[];
  }): MaybePromise<ObservingSnapshotPayload[]>;
  observingTableStats(): MaybePromise<TableStats | null>;
  observingCompact(): MaybePromise<CompactResult>;
  semanticNearest(params: {
    vector: number[];
    limit: number;
  }): MaybePromise<SemanticIndexRow[]>;
  semanticLoadByIds(params: {
    ids: string[];
  }): MaybePromise<SemanticIndexRow[]>;
  semanticUpsert(params: {
    rows: SemanticIndexRow[];
  }): MaybePromise<void>;
  semanticDelete(params: {
    ids: string[];
  }): MaybePromise<{ deleted: number }>;
  semanticValidateDimensions(params: {
    expected: number;
  }): MaybePromise<void>;
  semanticTableStats(): MaybePromise<TableStats | null>;
  semanticEnsureVectorIndex(params: {
    targetPartitionSize: number;
  }): MaybePromise<EnsureVectorIndexResult>;
  semanticCompact(): MaybePromise<CompactResult>;
  semanticOptimize(params: {
    mergeCount: number;
  }): MaybePromise<CompactResult>;
  describeSessionTable(): MaybePromise<TableDescription | null>;
  describeObservingTable(): MaybePromise<TableDescription | null>;
  describeSemanticIndexTable(): MaybePromise<TableDescription | null>;
};

type NativeModule = {
  createCoreBinding(): MaybePromise<NativeCoreBinding>;
  describeSemanticIndexForStorage(storageTarget: StorageTarget | null): MaybePromise<TableDescription | null>;
};

export interface SessionTableBinding {
  loadOpenTurn(params: {
    sessionId?: string;
    agent: string;
    observer: string;
  }): Promise<SessionTurn | null>;
  getTurn(turnId: string): Promise<SessionTurn | null>;
  listTurns(params: {
    mode: ListModeInput;
    agent?: string;
    sessionId?: string;
  }): Promise<SessionTurn[]>;
  timelineTurns(params: {
    memoryId: string;
    beforeLimit?: number;
    afterLimit?: number;
  }): Promise<SessionTurn[]>;
  loadTurnsAfterEpoch(params: {
    observer: string;
    committedEpoch?: number | null;
  }): Promise<SessionTurn[]>;
  insert(params: {
    turns: Array<Record<string, unknown>>;
  }): Promise<SessionTurn[]>;
  update(params: {
    turns: Array<Record<string, unknown>>;
  }): Promise<SessionTurn[]>;
  deleteTurns(params: {
    turnIds: string[];
  }): Promise<{ deleted: number }>;
  exportOpenTurnRefs(): Promise<{
    version: number;
    turns: OpenTurnSourceRef[];
  }>;
  stats(): Promise<TableStats | null>;
  compact(): Promise<CompactResult>;
  describe(): Promise<TableDescription | null>;
}

export interface ObservingTableBinding {
  getSnapshot(snapshotId: string): Promise<ObservingSnapshot | null>;
  listSnapshots(params: {
    observer?: string;
  }): Promise<ObservingSnapshotPayload[]>;
  threadSnapshots(observingId: string): Promise<ObservingSnapshotPayload[]>;
  insert(params: {
    snapshots: ObservingSnapshotPayload[];
  }): Promise<ObservingSnapshotPayload[]>;
  update(params: {
    snapshots: ObservingSnapshotPayload[];
  }): Promise<ObservingSnapshotPayload[]>;
  stats(): Promise<TableStats | null>;
  compact(): Promise<CompactResult>;
  describe(): Promise<TableDescription | null>;
}

export interface SemanticIndexTableBinding {
  nearest(params: {
    vector: number[];
    limit: number;
  }): Promise<SemanticIndexRow[]>;
  loadByIds(params: {
    ids: string[];
  }): Promise<SemanticIndexRow[]>;
  upsert(params: {
    rows: SemanticIndexRow[];
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
  optimize(params: {
    mergeCount: number;
  }): Promise<CompactResult>;
  describe(): Promise<TableDescription | null>;
}

export interface NativeTables {
  close(): Promise<void>;
  sessionTable: SessionTableBinding;
  observingTable: ObservingTableBinding;
  semanticIndexTable: SemanticIndexTableBinding;
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
  const binding = singleton ?? (singletonPromise ? await singletonPromise : null);
  if (binding) {
    await binding.close();
  }
  singleton = null;
  singletonPromise = null;
}

export async function describeSemanticIndexForStorage(
  storageTarget: StorageTarget | null,
): Promise<TableDescription | null> {
  const native = loadNativeModule();
  return resolveNativeResult(native.describeSemanticIndexForStorage(storageTarget));
}

function wrapBinding(native: NativeCoreBinding): NativeTables {
  const sessionTable: SessionTableBinding = {
    loadOpenTurn: async (params) => normalizeOptionalRecord(
      await resolveNativeResult(native.sessionLoadOpenTurn(params)),
      'turnId',
    ),
    getTurn: async (turnId) => normalizeOptionalRecord(
      await resolveNativeResult(native.sessionGetTurn(turnId)),
      'turnId',
    ),
    listTurns: async (params) => resolveNativeResult(native.sessionListTurns(params)),
    timelineTurns: async (params) => resolveNativeResult(native.sessionTimelineTurns(params)),
    loadTurnsAfterEpoch: async (params) => resolveNativeResult(native.sessionLoadTurnsAfterEpoch(params)),
    insert: async (params) => resolveNativeResult(native.sessionInsert(params)),
    update: async (params) => resolveNativeResult(native.sessionUpdate(params)),
    deleteTurns: async (params) => resolveNativeResult(native.sessionDeleteTurns(params)),
    exportOpenTurnRefs: async () => exportOpenTurnRefs(sessionTable),
    stats: async () => resolveNativeResult(native.sessionTableStats()),
    compact: async () => resolveNativeResult(native.sessionCompact()),
    describe: async () => resolveNativeResult(native.describeSessionTable()),
  };
  return {
    close: async () => resolveNativeResult(native.close()),
    sessionTable,
    observingTable: {
      getSnapshot: async (snapshotId) => normalizeOptionalRecord(
        await resolveNativeResult(native.observingGetSnapshot(snapshotId)),
        'snapshotId',
      ),
      listSnapshots: async (params) => resolveNativeResult(native.observingListSnapshots(params)),
      threadSnapshots: async (observingId) => resolveNativeResult(native.observingThreadSnapshots(observingId)),
      insert: async (params) => resolveNativeResult(native.observingInsert(params)),
      update: async (params) => resolveNativeResult(native.observingUpdate(params)),
      stats: async () => resolveNativeResult(native.observingTableStats()),
      compact: async () => resolveNativeResult(native.observingCompact()),
      describe: async () => resolveNativeResult(native.describeObservingTable()),
    },
    semanticIndexTable: {
      nearest: async (params) => resolveNativeResult(native.semanticNearest(params)),
      loadByIds: async (params) => resolveNativeResult(native.semanticLoadByIds(params)),
      upsert: async (params) => resolveNativeResult(native.semanticUpsert(params)),
      delete: async (params) => resolveNativeResult(native.semanticDelete(params)),
      validateDimensions: async (params) => resolveNativeResult(native.semanticValidateDimensions(params)),
      stats: async () => resolveNativeResult(native.semanticTableStats()),
      ensureVectorIndex: async (params) => resolveNativeResult(native.semanticEnsureVectorIndex(params)),
      compact: async () => resolveNativeResult(native.semanticCompact()),
      optimize: async (params) => resolveNativeResult(native.semanticOptimize(params)),
      describe: async () => resolveNativeResult(native.describeSemanticIndexTable()),
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

async function exportOpenTurnRefs(
  sessionTable: SessionTableBinding,
): Promise<{ version: number; turns: OpenTurnSourceRef[] }> {
  const stats = await sessionTable.stats();
  if (!stats) {
    return {
      version: 0,
      turns: [],
    };
  }
  const turns: OpenTurnSourceRef[] = [];
  for (let offset = 0; ; offset += EXPORT_PAGE_SIZE) {
    const page = await sessionTable.listTurns({
      mode: { type: 'page', offset, limit: EXPORT_PAGE_SIZE },
    });
    for (const turn of page) {
      if (!isOpenTurn(turn)) {
        continue;
      }
      turns.push({
        sessionId: turn.sessionId ?? null,
        agent: turn.agent,
        observer: turn.observer,
        turnId: turn.turnId,
        updatedAt: turn.updatedAt,
      });
    }
    if (page.length < EXPORT_PAGE_SIZE) {
      break;
    }
  }
  return {
    version: stats.version,
    turns,
  };
}

function isOpenTurn(turn: SessionTurn): boolean {
  return typeof turn.response !== 'string' || turn.response.trim().length === 0;
}
