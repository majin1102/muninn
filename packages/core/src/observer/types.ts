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

export type LlmFieldUpdate<T> = {
  before: T[];
  after: T[];
};

export type SnapshotContent = {
  observations: Observation[];
  contextRefs: ContextRef[];
  openQuestions?: string[];
  nextSteps?: string[];
  observationDelta: LlmFieldUpdate<Observation>;
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
  sourceSlice?: string | null;
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
  contextRefs: ContextRef[];
  observationDelta: LlmFieldUpdate<Observation>;
};

export type GatewayRoute = {
  turnId: string;
  targetThreadId?: string | null;
  newThreadTitle?: string | null;
  sourceSlice: string;
  rationale: string;
};

export type GatewayResult = {
  routes: GatewayRoute[];
};

export type ThreadCandidateMemory = {
  memoryId: string;
  title?: string | null;
  summary?: string | null;
};

export type ThreadPreparationThread = {
  threadId: string;
  title: string;
  summary?: string | null;
};

export type ThreadWorkItem = {
  observationIds: string[];
  targetThreadId?: string | null;
  newThreadTitle?: string | null;
  rationale: string;
};

export type ThreadPreparationResult = {
  workItems: ThreadWorkItem[];
  unthreadedObservationIds: string[];
};
