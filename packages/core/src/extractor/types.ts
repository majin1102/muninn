export type Extraction = {
  id?: string | null;
  text: string;
  context?: string | null;
  anchors?: string[];
  references: string[];
  updatedMemory?: string | null;
};

export type ExtractionInput = {
  text: string;
  context?: string | null;
  anchors?: string[];
  references: string[];
};

export type ContextRef = {
  turnId: string;
  summary: string;
};

export type ExtractionChange =
  | {
    type: 'add';
    text: string;
    context?: string | null;
    anchors?: string[];
    references: string[];
    reason: string;
  }
  | {
    type: 'merge';
    extractionIds: string[];
    text: string;
    context?: string | null;
    anchors?: string[];
    reason: string;
  }
  | {
    type: 'update';
    extractionId: string;
    text: string;
    context?: string | null;
    anchors?: string[];
    references?: string[];
    reason: string;
  }
  | {
    type: 'delete';
    extractionId: string;
    reason: string;
  };

export type SnapshotContent = {
  threadKind?: ObservingThreadKind;
  sessionId?: string | null;
  threadMemory: string;
  extractions: Extraction[];
  contextRefs: ContextRef[];
  openQuestions?: string[];
  nextSteps?: string[];
  extractionChanges: ExtractionChange[];
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

export type SessionSnapshot = {
  snapshotId: string;
  sessionId: string;
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
  summary?: string | null;
};

export type ObservingContent = {
  title: string;
  summary: string;
  threadMemory?: string;
  extractions: Extraction[];
  openQuestions: string[];
  nextSteps: string[];
};

export type ObservingContentUpdate = Omit<ObservingContent, 'extractions'>;

export type ObserveRequest = {
  observingContent: ObservingContent;
  turns: FragmentTurnInput[];
};

export type ObserveResult = {
  title: string;
  summary: string;
  threadMemory: string;
  extractions: Extraction[];
  openQuestions: string[];
  nextSteps: string[];
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
  extractionIds: string[];
  targetThreadId?: string | null;
  newThreadTitle?: string | null;
  rationale: string;
};

export type ThreadPreparationResult = {
  workItems: ThreadPreparationWorkItem[];
  unthreadedExtractionIds: string[];
};
