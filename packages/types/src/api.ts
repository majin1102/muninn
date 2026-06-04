export interface MemoryHit {
  memoryId: string;
  content: string;
}

export interface MemoryResponse {
  memoryHits: MemoryHit[];
  requestId: string;
}

export interface ErrorResponse {
  errorCode: string;
  errorMessage: string;
  requestId: string;
}

export interface MemoryWatermark {
  pending: {
    turns: string[];
    extractions: string[];
  };
  phases: {
    extractor: 'idle' | 'pending' | 'running' | 'draining' | 'error';
    observer: 'idle' | 'pending' | 'running' | 'draining' | 'error';
  };
  error?: {
    phase: 'extractor' | 'observer';
    message: string;
  };
}

export interface MemoryWatermarkResponse extends MemoryWatermark {
  requestId: string;
}

export interface RecallRequest {
  query: string;
  database?: string;
  limit?: number;
  budget?: number;
  queryLimit?: number;
  thinkingRatio?: number;
  recallMode?: 'vector' | 'fts' | 'hybrid';
}

export interface ListRequest {
  mode: 'recency';
  database?: string;
  limit?: number;
  thinkingRatio?: number;
}

export interface GetTimelineRequest {
  database?: string;
  memoryId: string;
  beforeLimit?: number;
  afterLimit?: number;
}

export interface GetDetailRequest {
  database?: string;
  memoryId: string;
}

export interface Artifact {
  key: string;
  kind: 'metadata' | 'text' | 'image' | 'file';
  source: 'prompt' | 'response' | 'tool' | 'import';
  content?: string;
  uri?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export type TurnEvent =
  | {
      type: 'userMessage';
      text: string;
      timestamp?: string;
      artifacts?: Artifact[];
    }
  | {
      type: 'assistantMessage';
      text: string;
      timestamp?: string;
      artifacts?: Artifact[];
    }
  | {
      type: 'toolCall';
      id?: string;
      name: string;
      input?: string;
      timestamp?: string;
    }
  | {
      type: 'toolOutput';
      id?: string;
      output?: string;
      timestamp?: string;
      artifacts?: Artifact[];
    };

export interface ToolCall {
  id?: string;
  name: string;
  input?: string;
  output?: string;
}

export interface TurnContent {
  sessionId: string;
  agent: string;
  createdAt?: string;
  updatedAt?: string;
  title?: string;
  summary?: string;
  events: TurnEvent[];
  artifacts?: Artifact[];
  prompt: string;
  response: string;
}

export interface CaptureTurnRequest {
  database?: string;
  turn: TurnContent;
}

export interface AgentNode {
  agent: string;
  latestUpdatedAt: string;
}

export interface SessionAgentsResponse {
  agents: AgentNode[];
  requestId: string;
}

export interface SessionNode {
  sessionKey: string;
  displaySessionId: string;
  projectKey?: string;
  latestUpdatedAt: string;
}

export interface SessionGroupsResponse {
  sessions: SessionNode[];
  requestId: string;
}

export interface TurnPreview {
  memoryId: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  summary: string;
  prompt?: string;
  response?: string;
  events?: TurnEvent[];
  artifacts?: Artifact[];
  toolCalls?: ToolCall[];
}

export interface SessionSegmentPreview {
  memoryId: string;
  title: string;
  createdAt: string;
}

export interface SessionTurnsResponse {
  turns: TurnPreview[];
  segments: SessionSegmentPreview[];
  nextOffset: number | null;
  requestId: string;
}

export interface MemoryDocument {
  memoryId: string;
  kind: 'turn' | 'session' | 'extraction';
  title: string;
  markdown: string;
  agent?: string;
  observer?: string;
  sessionId?: string;
  prompt?: string;
  response?: string;
  events?: TurnEvent[];
  artifacts?: Artifact[];
  toolCalls?: ToolCall[];
  createdAt?: string;
  updatedAt?: string;
}

export interface MemoryDocumentResponse {
  document: MemoryDocument;
  requestId: string;
}

export interface MemoryReference {
  memoryId: string;
  timestamp: string;
  summary: string;
}

export interface ObservingCard {
  memoryId: string;
  title: string;
  summary: string;
  updatedAt: string;
  references: MemoryReference[];
}

export interface ObservingListResponse {
  extractions: ObservingCard[];
  requestId: string;
}

export type PipelineTaskStatus = 'running' | 'queued' | 'failed' | 'done';

export type PipelineTaskKind =
  | 'session-observing'
  | 'global-observing'
  | 'wiki-compiling';

export interface PipelineTask {
  id: string;
  kind: PipelineTaskKind;
  title: string;
  target: string;
  status: PipelineTaskStatus;
  statusText: string;
  updatedAt: string;
  inputSummary: string;
  outputSummary: string;
  inputDetails: string[];
  outputDetails: string[];
  trace: string[];
  errors: string[];
}

export interface PipelineTasksResponse {
  summary: {
    running: number;
    queued: number;
    failed: number;
    updatedAt: string | null;
  };
  tasks: PipelineTask[];
  requestId: string;
}

export interface SettingsConfigResponse {
  pathLabel: string;
  content: string;
  validationError?: string;
  requestId: string;
}

export interface CodexImportSessionPreview {
  sessionId: string;
  title: string;
  cwd: string;
  sourcePath: string;
  updatedAt: string;
  turnCount: number;
  artifactCount: number;
}

export interface CodexImportProjectPreview {
  projectKey: string;
  cwd: string;
  sessions: CodexImportSessionPreview[];
}

export interface CodexImportPreviewResponse {
  sourceRoot: string;
  projectLimit: number;
  projectCount: number;
  sessionCount: number;
  turnCount: number;
  artifactCount: number;
  projects: CodexImportProjectPreview[];
  requestId: string;
}

export interface CodexImportRunResponse extends CodexImportPreviewResponse {
  deletedTurns: number;
  importedSessions: number;
  importedTurns: number;
  skippedTurns: number;
  failedSessions: Array<{
    sessionId: string;
    sourcePath: string;
    errorMessage: string;
  }>;
}
