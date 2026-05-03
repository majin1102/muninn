export type ObservationCategory = 'Preference' | 'Fact' | 'Decision' | 'Entity' | 'Concept' | 'Other';

export type Observation = {
  id?: string | null;
  text: string;
  category: ObservationCategory;
  updatedMemory?: string | null;
};

export type ObservationInput = {
  text: string;
  category: ObservationCategory;
  references: string[];
};

export type ContextRef = {
  turnId: string;
  summary: string;
};

export type ObservationChange =
  | {
    type: 'add';
    text: string;
    category: ObservationCategory;
    references: string[];
    reason: string;
  }
  | {
    type: 'merge';
    observationIds: string[];
    text: string;
    category: ObservationCategory;
    reason: string;
  }
  | {
    type: 'update';
    observationId: string;
    text: string;
    category?: ObservationCategory;
    references?: string[];
    reason: string;
  }
  | {
    type: 'delete';
    observationId: string;
    reason: string;
  };

export type SnapshotContent = {
  observations: Observation[];
  contextRefs: ContextRef[];
  openQuestions?: string[];
  nextSteps?: string[];
  observationChanges: ObservationChange[];
};

export type ObservingThread = {
  observingId: string;
  snapshotId?: string;
  snapshotIds: string[];
  snapshotEpochs?: number[];
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

export type ObservingSnapshot = {
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
};

export type PendingIndex = {
  start: number;
  end: number;
};

export type ObservingThreadGatewayInput = {
  threadId: string;
  title: string;
  continuityHints?: string[];
};

export type ObservingTurnInput = {
  turnId: string;
  excerpt?: string | null;
  prompt?: string | null;
  response?: string | null;
};

export type ObservingContent = {
  title: string;
  summary: string;
  observations: Observation[];
  openQuestions: string[];
  nextSteps: string[];
};

export type ObserveRequest = {
  observingContent: ObservingContent;
  sourceRefs: ObservingTurnInput[];
  threadMemoryId?: string | null;
};

export type ObserveResult = {
  observingContent: ObservingContent;
  contextRefs: ContextRef[];
  observationChanges: ObservationChange[];
};

export type ThreadWorkItem = {
  targetThreadId?: string | null;
  newThreadTitle?: string | null;
  sourceRefs: Array<{
    turnId: string;
    excerpt: string;
  }>;
  routingReason: string;
};

export type GatewayResult = {
  workItems: ThreadWorkItem[];
  ignoredTurnIds?: string[];
};

export type ThreadCandidateMemory = {
  memoryId: string;
  title?: string | null;
  summary?: string | null;
};

export type ThreadPreparationThread = {
  threadId: string;
  memoryId?: string | null;
  title: string;
  summary?: string | null;
};

export type ThreadPreparationWorkItem = {
  observationIds: string[];
  targetThreadId?: string | null;
  newThreadTitle?: string | null;
  rationale: string;
};

export type ThreadPreparationResult = {
  workItems: ThreadPreparationWorkItem[];
  unthreadedObservationIds: string[];
};
