import { accessSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';

import type { ObservingRecord, SessionTurnRecord } from './client.js';
import type { SemanticIndexRow, ObservingSnapshotRow } from './observer/types.js';
import type { ListModeInput } from './client.js';

type MaybePromise<T> = Promise<T> | T;

type NativeCoreBinding = {
  sessionLoadOpenTurn(params: {
    sessionId?: string;
    agent: string;
    observer: string;
  }): MaybePromise<SessionTurnRecord | null>;
  sessionGetTurn(turnId: string): MaybePromise<SessionTurnRecord | null>;
  sessionListTurns(params: {
    mode: ListModeInput;
    agent?: string;
    sessionId?: string;
  }): MaybePromise<SessionTurnRecord[]>;
  sessionTimelineTurns(params: {
    memoryId: string;
    beforeLimit?: number;
    afterLimit?: number;
  }): MaybePromise<SessionTurnRecord[]>;
  sessionLoadTurnsAfterEpoch(params: {
    observer: string;
    committedEpoch?: number | null;
  }): MaybePromise<SessionTurnRecord[]>;
  sessionUpsert(params: {
    turns: Array<Record<string, unknown>>;
  }): MaybePromise<SessionTurnRecord[]>;
  observingGetSnapshot(snapshotId: string): MaybePromise<ObservingSnapshotRow | null>;
  observingListSnapshots(params: {
    observer?: string;
  }): MaybePromise<ObservingSnapshotRow[]>;
  observingThreadSnapshots(observingId: string): MaybePromise<ObservingSnapshotRow[]>;
  observingUpsert(params: {
    snapshots: ObservingSnapshotRow[];
  }): MaybePromise<ObservingSnapshotRow[]>;
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
};

type NativeModule = {
  createCoreBinding(): NativeCoreBinding;
};

export interface CoreBinding {
  sessionLoadOpenTurn(params: {
    sessionId?: string;
    agent: string;
    observer: string;
  }): Promise<SessionTurnRecord | null>;
  sessionGetTurn(turnId: string): Promise<SessionTurnRecord | null>;
  sessionListTurns(params: {
    mode: ListModeInput;
    agent?: string;
    sessionId?: string;
  }): Promise<SessionTurnRecord[]>;
  sessionTimelineTurns(params: {
    memoryId: string;
    beforeLimit?: number;
    afterLimit?: number;
  }): Promise<SessionTurnRecord[]>;
  sessionLoadTurnsAfterEpoch(params: {
    observer: string;
    committedEpoch?: number | null;
  }): Promise<SessionTurnRecord[]>;
  sessionUpsert(params: {
    turns: Array<Record<string, unknown>>;
  }): Promise<SessionTurnRecord[]>;
  observingGetSnapshot(snapshotId: string): Promise<ObservingRecord | null>;
  observingListSnapshots(params: {
    observer?: string;
  }): Promise<ObservingSnapshotRow[]>;
  observingThreadSnapshots(observingId: string): Promise<ObservingSnapshotRow[]>;
  observingUpsert(params: {
    snapshots: ObservingSnapshotRow[];
  }): Promise<ObservingSnapshotRow[]>;
  semanticNearest(params: {
    vector: number[];
    limit: number;
  }): Promise<SemanticIndexRow[]>;
  semanticLoadByIds(params: {
    ids: string[];
  }): Promise<SemanticIndexRow[]>;
  semanticUpsert(params: {
    rows: SemanticIndexRow[];
  }): Promise<void>;
  semanticDelete(params: {
    ids: string[];
  }): Promise<{ deleted: number }>;
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

function wrapBinding(native: NativeCoreBinding): CoreBinding {
  return {
    sessionLoadOpenTurn: async (params) => normalizeOptionalRecord(
      await resolveNativeResult(native.sessionLoadOpenTurn(params)),
      'turnId',
    ),
    sessionGetTurn: async (turnId) => normalizeOptionalRecord(
      await resolveNativeResult(native.sessionGetTurn(turnId)),
      'turnId',
    ),
    sessionListTurns: async (params) => resolveNativeResult(native.sessionListTurns(params)),
    sessionTimelineTurns: async (params) => resolveNativeResult(native.sessionTimelineTurns(params)),
    sessionLoadTurnsAfterEpoch: async (params) => resolveNativeResult(native.sessionLoadTurnsAfterEpoch(params)),
    sessionUpsert: async (params) => resolveNativeResult(native.sessionUpsert(params)),
    observingGetSnapshot: async (snapshotId) => normalizeOptionalRecord(
      await resolveNativeResult(native.observingGetSnapshot(snapshotId)),
      'snapshotId',
    ),
    observingListSnapshots: async (params) => resolveNativeResult(native.observingListSnapshots(params)),
    observingThreadSnapshots: async (observingId) => resolveNativeResult(native.observingThreadSnapshots(observingId)),
    observingUpsert: async (params) => resolveNativeResult(native.observingUpsert(params)),
    semanticNearest: async (params) => resolveNativeResult(native.semanticNearest(params)),
    semanticLoadByIds: async (params) => resolveNativeResult(native.semanticLoadByIds(params)),
    semanticUpsert: async (params) => resolveNativeResult(native.semanticUpsert(params)),
    semanticDelete: async (params) => resolveNativeResult(native.semanticDelete(params)),
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
