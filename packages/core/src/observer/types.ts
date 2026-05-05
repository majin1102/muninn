export type ObservationCategory = 'Preference' | 'Fact' | 'Decision' | 'Entity' | 'Concept' | 'Other';

export type Observation = {
  id?: string | null;
  text: string;
  category: ObservationCategory;
  references: string[];
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
  threadKind?: ObservingThreadKind;
  sessionId?: string | null;
  observations: Observation[];
  contextRefs: ContextRef[];
  openQuestions?: string[];
  nextSteps?: string[];
  observationChanges: ObservationChange[];
};

export type ObservingThreadKind = 'session' | 'subject';

export type ObservingThread = {
  observingId: string;
  kind: ObservingThreadKind;
  sessionId?: string | null;
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
  kind: ObservingThreadKind;
  title: string;
  summary: string;
};

export type FragmentTurnInput = {
  turnId: string;
  prompt?: string | null;
  response?: string | null;
};

export type ObserveFragmentInput = {
  content: string;
  turns: FragmentTurnInput[];
};

export type ObservingContent = {
  title: string;
  summary: string;
  observations: Observation[];
  openQuestions: string[];
  nextSteps: string[];
};

export type ObservingContentUpdate = Omit<ObservingContent, 'observations'>;

export type ObserveRequest = {
  observingContent: ObservingContent;
  fragments: ObserveFragmentInput[];
};

export type ObserveResult = {
  observingContent: ObservingContent;
  contextRefs: ContextRef[];
};

export type SessionFragment = {
  threadId: string;
  turnIds: string[];
  content: string;
  reason: string;
};

export type GatewayResult = {
  sessionFragments: SessionFragment[];
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
