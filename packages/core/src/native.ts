import { accessSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';

import type { ListModeInput, ObservingSnapshot, SessionTurn } from './client.js';
import type { SemanticIndexRow, ObservingSnapshot as ObservingSnapshotPayload } from './observer/types.js';

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

type NativeCoreBinding = {
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
  sessionUpsert(params: {
    turns: Array<Record<string, unknown>>;
  }): MaybePromise<SessionTurn[]>;
  observingGetSnapshot(snapshotId: string): MaybePromise<ObservingSnapshotPayload | null>;
  observingListSnapshots(params: {
    observer?: string;
  }): MaybePromise<ObservingSnapshotPayload[]>;
  observingThreadSnapshots(observingId: string): MaybePromise<ObservingSnapshotPayload[]>;
  observingUpsert(params: {
    snapshots: ObservingSnapshotPayload[];
  }): MaybePromise<ObservingSnapshotPayload[]>;
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
  describeSessionTable(): MaybePromise<TableDescription | null>;
  describeObservingTable(): MaybePromise<TableDescription | null>;
  describeSemanticIndexTable(): MaybePromise<TableDescription | null>;
};

type NativeModule = {
  createCoreBinding(): NativeCoreBinding;
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
  upsert(params: {
    turns: Array<Record<string, unknown>>;
  }): Promise<SessionTurn[]>;
  describe(): Promise<TableDescription | null>;
}

export interface ObservingTableBinding {
  getSnapshot(snapshotId: string): Promise<ObservingSnapshot | null>;
  listSnapshots(params: {
    observer?: string;
  }): Promise<ObservingSnapshotPayload[]>;
  threadSnapshots(observingId: string): Promise<ObservingSnapshotPayload[]>;
  upsert(params: {
    snapshots: ObservingSnapshotPayload[];
  }): Promise<ObservingSnapshotPayload[]>;
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
  describe(): Promise<TableDescription | null>;
}

export interface CoreBinding {
  sessionTable: SessionTableBinding;
  observingTable: ObservingTableBinding;
  semanticIndexTable: SemanticIndexTableBinding;
}

let singleton: CoreBinding | null = null;

export function getCoreBinding(): CoreBinding {
  if (!singleton) {
    const native = loadNativeModule();
    singleton = wrapBinding(native.createCoreBinding());
  }
  return singleton;
}

export async function shutdownCoreBindingForTests(): Promise<void> {
  singleton = null;
}

export async function describeSemanticIndexForStorage(
  storageTarget: StorageTarget | null,
): Promise<TableDescription | null> {
  const native = loadNativeModule();
  return resolveNativeResult(native.describeSemanticIndexForStorage(storageTarget));
}

function wrapBinding(native: NativeCoreBinding): CoreBinding {
  return {
    sessionTable: {
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
      upsert: async (params) => resolveNativeResult(native.sessionUpsert(params)),
      describe: async () => resolveNativeResult(native.describeSessionTable()),
    },
    observingTable: {
      getSnapshot: async (snapshotId) => normalizeOptionalRecord(
        await resolveNativeResult(native.observingGetSnapshot(snapshotId)),
        'snapshotId',
      ),
      listSnapshots: async (params) => resolveNativeResult(native.observingListSnapshots(params)),
      threadSnapshots: async (observingId) => resolveNativeResult(native.observingThreadSnapshots(observingId)),
      upsert: async (params) => resolveNativeResult(native.observingUpsert(params)),
      describe: async () => resolveNativeResult(native.describeObservingTable()),
    },
    semanticIndexTable: {
      nearest: async (params) => resolveNativeResult(native.semanticNearest(params)),
      loadByIds: async (params) => resolveNativeResult(native.semanticLoadByIds(params)),
      upsert: async (params) => resolveNativeResult(native.semanticUpsert(params)),
      delete: async (params) => resolveNativeResult(native.semanticDelete(params)),
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
