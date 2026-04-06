import type { SessionTurnRow } from '../session/types.js';

export type MemoryCategory = 'Preference' | 'Fact' | 'Decision' | 'Entity' | 'Concept' | 'Other';

export type ObservedMemory = {
  id?: string | null;
  text: string;
  category: MemoryCategory;
  updatedMemory?: string | null;
};

export type LlmFieldUpdate<T> = {
  before: T[];
  after: T[];
};

export type SnapshotContent = {
  memories: ObservedMemory[];
  openQuestions?: string[];
  nextSteps?: string[];
  memoryDelta: LlmFieldUpdate<ObservedMemory>;
};

export type ObservingThread = {
  observingId: string;
  snapshotId?: string;
  snapshotIds: string[];
  pendingParentId?: string | null;
  observingEpoch: number;
  title: string;
  summary: string;
  snapshots: SnapshotContent[];
  references: string[];
  indexedSnapshotSequence?: number | null;
  observer: string;
  createdAt: string;
  updatedAt: string;
};

export type ObservingSnapshotRow = {
  snapshotId: string;
  observingId: string;
  snapshotSequence: number;
  createdAt: string;
  updatedAt: string;
  observer: string;
  title: string;
  summary: string;
  content: string;
  references: string[];
  checkpoint: {
    observingEpoch: number;
    indexedSnapshotSequence?: number | null;
    pendingParentId?: string | null;
  };
};

export type IndexBatch = {
  turns: SessionTurnRow[];
  observingIds: string[];
};

export type SemanticIndexRow = {
  id: string;
  memoryId: string;
  text: string;
  vector: number[];
  importance: number;
  category: string;
  createdAt: string;
};

export type ObservingThreadGatewayInput = {
  observingId: string;
  title: string;
  summary: string;
};

export type ObservingTurnInput = {
  turnId: string;
  summary: string;
  whyRelated: string;
};

export type ObservingContent = {
  title: string;
  summary: string;
  memories: ObservedMemory[];
  openQuestions: string[];
  nextSteps: string[];
};

export type ObserveRequest = {
  observingContent: ObservingContent;
  pendingTurns: ObservingTurnInput[];
};

export type ObservingContentUpdate = {
  title: string;
  summary: string;
  openQuestions: string[];
  nextSteps: string[];
};

export type ObserveResult = {
  observingContentUpdate: ObservingContentUpdate;
  memoryDelta: LlmFieldUpdate<ObservedMemory>;
};

export type GatewayAction = 'append' | 'new';

export type NewThreadHint = {
  title: string;
  summary: string;
};

export type GatewayUpdate = {
  turnId: string;
  action: GatewayAction;
  observingId?: string | null;
  summary: string;
  newThread?: NewThreadHint | null;
  why: string;
};

export type GatewayResult = {
  updates: GatewayUpdate[];
};
