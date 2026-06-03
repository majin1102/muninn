export type ExtractionCategory = 'Preference' | 'Fact' | 'Decision' | 'Entity' | 'Concept' | 'Other';

export type Extraction = {
  id?: string | null;
  title?: string | null;
  text: string;
  context?: string | null;
  anchors?: string[];
  category: ExtractionCategory;
  references: string[];
  updatedMemory?: string | null;
};

export type ExtractionInput = {
  title?: string | null;
  text: string;
  context?: string | null;
  anchors?: string[];
  category: ExtractionCategory;
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
    category: ExtractionCategory;
    references: string[];
    reason: string;
  }
  | {
    type: 'merge';
    extractionIds: string[];
    text: string;
    context?: string | null;
    anchors?: string[];
    category: ExtractionCategory;
    reason: string;
  }
  | {
    type: 'update';
    extractionId: string;
    text: string;
    context?: string | null;
    anchors?: string[];
    category?: ExtractionCategory;
    references?: string[];
    reason: string;
  }
  | {
    type: 'delete';
    extractionId: string;
    reason: string;
  };

export type SnapshotContent = {
  threadKind?: SessionMemoryThreadKind;
  sessionId?: string | null;
  snapshotContent: string;
  extractions: Extraction[];
  contextRefs: ContextRef[];
  openQuestions?: string[];
  nextSteps?: string[];
  extractionChanges: ExtractionChange[];
};

export type SessionMemoryThreadKind = 'session' | 'subject';

export type SessionMemoryThread = {
  threadId: string;
  kind: SessionMemoryThreadKind;
  sessionId?: string | null;
  snapshotId?: string;
  snapshotIds: string[];
  snapshotEpochs?: number[];
  extractionEpoch: number;
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

export type SessionMemoryThreadGatewayInput = {
  threadId: string;
  kind: SessionMemoryThreadKind;
  title: string;
  summary: string;
};

export type FragmentTurnInput = {
  turnId: string;
  prompt?: string | null;
  response?: string | null;
  summary?: string | null;
};

export type SessionMemoryContent = {
  title: string;
  summary: string;
  snapshotContent?: string;
  extractions: Extraction[];
  openQuestions: string[];
  nextSteps: string[];
};

export type SessionMemoryContentUpdate = Omit<SessionMemoryContent, 'extractions'>;

export type ExtractSessionMemoryRequest = {
  sessionMemoryContent: SessionMemoryContent;
  turns: FragmentTurnInput[];
};

export type ExtractSessionMemoryResult = {
  title: string;
  summary: string;
  snapshotContent: string;
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
