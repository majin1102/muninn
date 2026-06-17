export interface MemoryHit {
  memoryId: string;
  title?: string;
  summary?: string;
  content: string;
  references?: string[];
  project?: string;
  sessionId?: string;
  agent?: string;
  cwd?: string;
  sessionKey?: string;
  displaySession?: string;
  createdAt?: string;
  updatedAt?: string;
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

export interface ProjectDreamDocument {
  memoryId: string;
  project: string;
  parentId?: string | null;
  createdAt: string;
  sessionSnapshotVersion: number;
  content: string;
}

export interface ProjectDreamResponse {
  dream: ProjectDreamDocument;
  created?: boolean;
  requestId: string;
}

export interface ProjectDreamSignals {
  memoryId: string;
  project: string;
  createdAt: string;
  guidance: string[];
  skills: string[];
  openQuestions: string[];
}

export interface ProjectDreamSignalsResponse extends ProjectDreamSignals {
  requestId: string;
}

export interface ProjectDreamRequest {
  database?: string;
  project: string;
}

export interface MemoryWatermark {
  pending: {
    turns: string[];
  };
  phases: {
    extractor: 'idle' | 'pending' | 'running' | 'draining' | 'error';
  };
  error?: {
    phase: 'extractor';
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
  project?: string;
  cwd?: string;
  agent: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
  turnSequence?: number;
  events: TurnEvent[];
  artifacts?: Artifact[];
  prompt: string;
  response: string;
}

export interface CaptureTurnRequest {
  database?: string;
  turn: TurnContent;
}

export interface CaptureTurnsRequest {
  database?: string;
  turns: TurnContent[];
}

export interface CaptureTurnsResponse {
  capturedTurns: number;
  skippedTurns: number;
  requestId: string;
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
  projectKey: string;
  cwd?: string;
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
  turnSequence?: number | null;
  preview: string;
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
  updatedAt?: string;
}

export interface SessionTimelineItem {
  memoryId: string;
  kind: 'summary' | 'signals' | 'extraction';
  title: string;
  createdAt: string;
  updatedAt?: string;
  markdown: string;
  refs: string[];
}

export interface SessionTurnsResponse {
  turns: TurnPreview[];
  segments: SessionSegmentPreview[];
  timeline: SessionTimelineItem[];
  nextOffset: number | null;
  requestId: string;
}

export interface MemoryDocument {
  memoryId: string;
  kind: 'turn' | 'session' | 'extraction';
  title: string;
  markdown: string;
  agent?: string;
  extractor?: string;
  sessionId?: string;
  project?: string;
  cwd?: string;
  metadata?: Record<string, unknown> | null;
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

export interface SessionSnapshotCard {
  memoryId: string;
  title: string;
  summary: string;
  updatedAt: string;
  references: MemoryReference[];
}

export interface SessionSnapshotListResponse {
  sessionSnapshots: SessionSnapshotCard[];
  requestId: string;
}

export type PipelineTaskStatus = 'running' | 'queued' | 'failed' | 'done';

export type PipelineTaskKind =
  | 'extraction'
  | 'wiki-compiling';

export interface PipelineDataMetric {
  bytes: number;
  tokens: number;
}

export interface PipelineToolCallSummary {
  name: string;
  count: number;
}

export interface PipelineTask {
  id: string;
  kind: PipelineTaskKind;
  title: string;
  target: string;
  status: PipelineTaskStatus;
  statusText: string;
  startedAt?: string;
  endedAt?: string;
  updatedAt: string;
  input: PipelineDataMetric;
  output?: PipelineDataMetric;
  toolCalls: PipelineToolCallSummary[];
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

export interface SearchResultItem {
  id: string;
  source: 'extraction' | 'conversation';
  title?: string;
  content: string;
  references?: string[];
  createdAt?: string;
  memoryId?: string;
}

export interface SearchSessionResult {
  sessionKey: string;
  sessionLabel: string;
  agent: string;
  projectKey: string;
  projectCwd?: string;
  latestUpdatedAt: string;
  items: SearchResultItem[];
}

export interface SearchResponse {
  results: SearchSessionResult[];
  requestId: string;
}

export interface RecallProviderOption {
  label: string;
  value: string;
}

export interface RecallProvidersResponse {
  providers: RecallProviderOption[];
  requestId: string;
}

export type AgentRecallStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; errorMessage: string };

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

// ---- Per-session import (Import & Capture settings) ----

export interface ImportAgentSession {
  sessionId: string;
  project: string;
  cwd: string;
  title: string;
  promptPreview?: string;
  sourcePath?: string;
  updatedAt: string;
  turnCount?: number;
  artifactCount?: number;
  imported: boolean;
}

export interface ImportAgentProject {
  project: string;
  sessionCount: number;
  importedCount: number;
  /** Whether the live hook auto-captures new sessions for this project. */
  captureEnabled?: boolean;
  sessions: ImportAgentSession[];
}

export interface ImportAgentLocalProject {
  project: string;
  latestUpdatedAt: string;
}

export interface ImportLocalProjectsResponse {
  sourceRoot: string;
  projectCount: number;
  projects: ImportAgentLocalProject[];
  requestId: string;
}

export interface ImportSessionsListResponse {
  sourceRoot: string;
  projectCount: number;
  sessionCount: number;
  importedCount: number;
  projects: ImportAgentProject[];
  requestId: string;
}

export interface ImportedProjectAgent {
  agent: string;
  sessionCount: number;
  importedCount: number;
  captureEnabled?: boolean;
}

export interface ImportedProjectSession {
  agent: string;
  session: ImportAgentSession;
}

export interface ImportedProjectGroup {
  project: string;
  sessionCount: number;
  importedCount: number;
  latestUpdatedAt: string;
  agents: ImportedProjectAgent[];
  sessions: ImportedProjectSession[];
}

export interface ImportedProjectsResponse {
  agents: Array<{
    agent: string;
    sourceRoot: string;
    captureEnabled?: boolean;
  }>;
  projectCount: number;
  sessionCount: number;
  importedCount: number;
  projects: ImportedProjectGroup[];
  requestId: string;
}

export interface ImportSelectedResponse {
  importedSessions: number;
  importedTurns: number;
  failedSessions: Array<{
    sourcePath: string;
    errorMessage: string;
  }>;
  requestId: string;
}

export interface ImportProjectsResponse {
  importedProjects: number;
  requestId: string;
}

export interface DeleteImportedProjectResponse {
  deletedSessions: number;
  deletedTurns: number;
  requestId: string;
}

export interface DeleteImportedSessionResponse {
  deletedSessions: number;
  deletedTurns: number;
  requestId: string;
}
