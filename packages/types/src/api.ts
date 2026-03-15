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

export interface Message {
  agent: string;
  summary?: string;
  details?: string;
  trace?: string[];
  artifacts?: Record<string, string>;
  prompt?: string;
  response?: string;
}

export interface AddMessageRequest {
  message: Message;
}

export interface AddMessageResponse {
  turnId: string;
  requestId: string;
}
