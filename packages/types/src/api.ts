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

export interface RecallRequest {
  query: string;
  limit?: number;
  thinkingRatio?: number;
}

export interface ListRequest {
  mode: 'recency';
  limit?: number;
  thinkingRatio?: number;
}

export interface GetTimelineRequest {
  memoryId: string;
  beforeLimit?: number;
  afterLimit?: number;
}

export interface GetDetailRequest {
  memoryId: string;
}

export interface SessionMessageInput {
  session_id?: string;
  agent: string;
  title?: string;
  summary?: string;
  tool_calling?: string[];
  // Tool outputs produced during this session memory row.
  artifacts?: Record<string, string>;
  prompt?: string;
  response?: string;
  // Free-form extra input accepted at the API layer.
  extra?: Record<string, string>;
}

export interface AddMessageToSessionRequest {
  session: SessionMessageInput;
}

export interface AddMessageToSessionResponse {
  turnId: string;
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
}

export interface SessionTurnsResponse {
  turns: TurnPreview[];
  nextOffset: number | null;
  requestId: string;
}

export interface MemoryDocument {
  memoryId: string;
  kind: 'session' | 'observing';
  title: string;
  markdown: string;
  agent?: string;
  observer?: string;
  sessionId?: string;
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
  observations: ObservingCard[];
  requestId: string;
}

export interface SettingsConfigResponse {
  pathLabel: string;
  content: string;
  requestId: string;
}
